import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogPicker } from "./helpers/catalog-picker.mjs";

function fixture(body, options = {}) {
  return catalogPicker({ bin: process.execPath, args: ["-e", body], expected: "wanted", timeout: 5000, stopTimeout: 1000, ...options });
}
const rpc = body => `require('node:readline').createInterface({input:process.stdin}).on('line', line => { const m = JSON.parse(line); ${body} });`;
const respond = "console.log(JSON.stringify({id:m.id,result:m.id===1?{}:{data:[{id:'wanted'}]}}))";

test("picker returns models and closes its child", async () => {
  assert.deepEqual(await fixture(rpc(`if(m.id) ${respond}`)), ["wanted"]);
});
test("picker reports early exit with stderr and exit code", async () => {
  await assert.rejects(fixture("console.error('fixture failed'); process.exit(7)"), /stage=initialize.*exit=.*7.*fixture failed/s);
});
test("picker rejects initialize RPC errors immediately", async () => {
  await assert.rejects(fixture(rpc("console.log(JSON.stringify({id:m.id,error:{message:'initialize rejected'}}))")), /initialize rejected; stage=initialize/);
});
test("picker catches malformed JSON instead of throwing outside the promise", async () => {
  await assert.rejects(fixture("console.log('not json'); setInterval(()=>{},1000)"), /stage=initialize/);
});
test("picker timeout includes stage, expected models, last models and bounded stderr", async () => {
  await assert.rejects(fixture(rpc("if(m.id) console.log(JSON.stringify({id:m.id,result:m.id===1?{}:{data:[{id:'stale'}]}}))") + ";process.stderr.write('x'.repeat(20000))", { timeout: 5000 }), error => {
    assert.match(error.message, /picker timeout; stage=model\/list/);
    assert.match(error.message, /expected=\[?"wanted"/);
    assert.match(error.message, /lastIds=\["stale"\]/);
    assert.ok(error.message.length < 5000);
    return true;
  });
});
test("picker handles spawn failure without an unhandled rejection", async () => {
  await assert.rejects(catalogPicker({ bin: 'nonexistent-catalog-picker-binary', timeout: 2000 }), /ENOENT/);
});
test("picker abort cancels pending polling and stops the child", async () => {
  const controller = new AbortController();
  const run = fixture(rpc("if(m.id) console.log(JSON.stringify({id:m.id,result:m.id===1?{}:{data:[]}}))"), { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 150);
  try { await assert.rejects(run, /test aborted/); } finally { clearTimeout(timer); }
});
test("picker catches failures in the cache invalidation callback", async () => {
  await assert.rejects(fixture(rpc(`if(m.id) ${respond}`), { afterFirst() { throw new Error("invalidation failed"); } }), /invalidation failed/);
});
test("picker escalates termination when the child ignores SIGTERM", { skip: process.platform === 'win32' }, async () => {
  assert.deepEqual(await fixture("process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);" + rpc(`if(m.id) ${respond}`)), ["wanted"]);
});
