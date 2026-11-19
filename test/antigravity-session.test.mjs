import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchAntigravityChat, closeAntigravitySessions, envelopeText } from "../src/antigravity-cli.mjs";

test("streaming envelope decodes split escapes and buffers tool arguments", () => {
  assert.equal(envelopeText('{"text":"hello\\nworld\\u4'), "hello\nworld");
  assert.equal(envelopeText('{"text":"hello\\nworld\\u4f60"'), "hello\nworld你");
  assert.equal(envelopeText('{"calls":[{"arguments":{"text":"hidden"}}]}'), "");
});

test("Antigravity sessions isolate chats, reuse matching history and report per-turn usage", {
  skip: process.platform === "win32", timeout: 15000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "agy-session-test-"));
  const log = join(directory, "prompts.jsonl");
  const binary = join(directory, "agy");
  t.after(async () => { closeAntigravitySessions(); await rm(directory, { recursive: true, force: true }); });
  await writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs');
const log=${JSON.stringify(log)};
const emit=x=>console.log(JSON.stringify(x));
if(process.argv.includes('/hooks')){
 const source=process.cwd()+'/.agents/hooks.json';
 const name=Object.keys(JSON.parse(fs.readFileSync(source)))[0];
 emit({command:{data:{hooks:[{name,enabled:true,source,actions:[{event:'PreToolUse',matcher:'.*',command:'node deny.cjs'}]}]}}});
}else{
 const model=process.argv[process.argv.indexOf('--model')+1];
 emit({event:'init',init:{model,agent:'coding-host',permission_mode:'strict'}});
 let n=0;
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const prompt=JSON.parse(line).message.content;n++;
  fs.appendFileSync(log,JSON.stringify({pid:process.pid,prompt,n,model})+'\\n');
  if(prompt.includes('LOCAL_TOOL')){emit({event:'step_update',step_update:{step_type:'tool'}});return}
  const response=JSON.stringify({text:'hello world',calls:[]});
  emit({event:'step_update',step_update:{step_type:'agent_response',text_delta:response.slice(0,12)}});
  setTimeout(()=>{
   emit({event:'step_update',step_update:{step_type:'agent_response',text_delta:response.slice(12)}});
   emit({event:'result',result:{status:'SUCCESS',response,usage:{input_tokens:100*n,cache_read_tokens:80*(n-1),output_tokens:10*n,thinking_tokens:2*n}}});
  },15);
 });
}
`, { mode: 0o700 });
  const route = { defaultCliModel: "flash-low", effortModels: { high: "flash-high" } };
  const original = { messages: [{ role: "system", content: "You are Codex" }, { role: "user", content: "first" }] };
  async function ask(request, key, effort = null) {
    const response = await fetchAntigravityChat(request, route, binary, effort, null, key);
    const wire = await response.text();
    return wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  }
  const a = await ask(original, "one");
  assert.equal(a.find(x => x.usage).usage.prompt_tokens_details.cached_tokens, 0);
  const continued = { messages: [...original.messages, { role: "assistant", content: "hello world" }, { role: "user", content: "second" }] };
  const b = await ask(continued, "one");
  const usage = b.find(x => x.usage).usage;
  assert.equal(usage.completion_tokens, 10);
  assert.equal(usage.prompt_tokens, 180);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 80);
  assert.equal(b.filter(x => x.choices?.[0]?.delta?.content).length, 2);
  await ask(original, "two");
  await ask(original, "one");
  await ask(original, "one", "high");
  const failed = await ask({ messages: [{ role: "user", content: "LOCAL_TOOL" }] }, "one");
  assert.ok(failed.some(x => x.error));
  await ask(original, "one");
  const after = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(after[0].pid, after[1].pid);
  assert.doesNotMatch(after[1].prompt, /You are|first/);
  assert.notEqual(after[1].pid, after[2].pid);
  assert.notEqual(after[0].pid, after[3].pid);
  assert.equal(after[4].model, "flash-high");
  assert.equal(after.at(-1).n, 1, "failed sessions must be rebuilt");
});
