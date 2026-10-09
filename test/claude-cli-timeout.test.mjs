import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { setImmediate as nextTick } from "node:timers/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPayloads } from "./helpers/payloads.mjs";

const { dir } = await loadPayloads();
const cli = await import(pathToFileURL(join(dir, "claude-cli.mjs")));
const start = { type: "message_start", message: { usage: {} } };
const delta = (type) => ({ type: "content_block_delta", index: 0,
  delta: type === "thinking_delta" ? { type, thinking: "thinking" }
    : type === "input_json_delta" ? { type, partial_json: "{}" } : { type, text: "text" } });

// A fake native process plus virtual time exercises the real stream parser,
// deadlines, fallback and cleanup on every platform without model requests.
async function fixture(t, configuration = {}, { history = false, consume = true } = {}) {
  const children = [];
  let resolveNextSpawn;
  t.mock.method(childProcess, "spawn", () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kills: 0,
      kill() {
        this.kills++;
        queueMicrotask(() => this.emit("close", 0));
        return true;
      },
    });
    children.push(child);
    resolveNextSpawn?.(child);
    resolveNextSpawn = null;
    return child;
  });
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  cli.resetCliCacheMarker();
  const controller = new AbortController();
  let output;
  t.after(async () => {
    controller.abort();
    if (output) await output;
    await nextTick();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    cli.resetCliCacheMarker();
  });
  const messages = history ? [{ role: "user", content: "before" },
    { role: "assistant", content: "answer" }, { role: "user", content: "continue" }]
    : [{ role: "user", content: "fixture" }];
  const response = await cli.fetchClaudeCli({ model: "fixture", messages }, {
    binary: process.execPath, timeoutMs: 1000, totalTimeoutMs: 5000, ...configuration,
  }, controller.signal, { env: {} });
  if (consume) output = response.text();
  const record = (value) => children.at(-1).stdout.write(JSON.stringify(value) + "\n");
  return { children, controller, response, output, record,
    nextSpawn: () => new Promise((resolve) => { resolveNextSpawn = resolve; }),
    event: (event) => record({ type: "stream_event", event }),
    tick: (ms) => t.mock.timers.tick(ms),
    complete() {
      record({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } });
      record({ type: "stream_event", event: { type: "message_stop" } });
    },
  };
}

test("thinking, text and tool argument streams may outlast the idle interval", async (t) => {
  const f = await fixture(t);
  f.event(start);
  for (const type of ["thinking_delta", "text_delta", "input_json_delta", "thinking_delta"]) {
    f.tick(900);
    f.event(delta(type));
  }
  f.complete();
  const output = await f.output;
  assert.match(output, /message_stop/);
  assert.doesNotMatch(output, /claude_cli_/);
  await nextTick();
  f.tick(10000);
  assert.equal(f.children[0].kills, 1, "completion clears both deadlines");
});

test("a process that never starts streaming reaches the idle deadline", async (t) => {
  const f = await fixture(t);
  f.tick(1000);
  assert.match(await f.output, /claude_cli_timeout/);
  assert.equal(f.children[0].kills, 1);
});

test("silence after progress is measured from the last event", async (t) => {
  const f = await fixture(t);
  f.tick(800);
  f.event(start);
  f.tick(800);
  f.event(delta("thinking_delta"));
  f.tick(999);
  assert.equal(f.children[0].kills, 0);
  f.tick(1);
  const output = await f.output;
  assert.equal(output.match(/claude_cli_timeout/g)?.length, 1);
  assert.doesNotMatch(output, /message_stop/);
  await nextTick();
  f.tick(10000);
  assert.equal(f.children[0].kills, 1, "idle failure clears the total deadline");
});

test("continuous output cannot extend the absolute total deadline", async (t) => {
  const f = await fixture(t, { totalTimeoutMs: 2500 });
  f.event(start);
  for (let i = 0; i < 3; i++) { f.tick(800); f.event(delta("thinking_delta")); }
  f.tick(100);
  const output = await f.output;
  assert.match(output, /claude_cli_total_timeout/);
  assert.doesNotMatch(output, /message_stop/);
  await nextTick();
  f.tick(10000);
  assert.equal(f.children[0].kills, 1, "total failure clears the idle deadline");
});

test("metadata, stderr, nested events and incomplete JSON do not reset idle time", async (t) => {
  const f = await fixture(t);
  f.event(start);
  f.tick(800);
  f.record({ type: "system", subtype: "status" });
  f.record({ type: "stream_event", parent_tool_use_id: "nested", event: delta("text_delta") });
  f.children[0].stderr.write("still running\n");
  f.children[0].stdout.write('{"type":"stream_event"');
  f.tick(200);
  assert.match(await f.output, /claude_cli_timeout/);
});

test("cache-marker fallback retains the original total deadline", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { totalTimeoutMs: 2000 }, { history: true });
  f.tick(800);
  const relaunched = f.nextSpawn();
  f.record({ type: "assistant", error: "invalid_request", message: {
    content: [{ type: "text", text: "cache_control ttl rejected" }],
  } });
  // The fallback writes its replay file before launching the second process.
  await relaunched;
  assert.equal(f.children.length, 2);
  f.event(start);
  f.tick(800);
  f.event(delta("text_delta"));
  f.tick(400);
  assert.match(await f.output, /claude_cli_total_timeout/);
  assert.deepEqual(f.children.map((child) => child.kills), [1, 1]);
});

test("abort clears both deadlines and terminates only once", async (t) => {
  const f = await fixture(t);
  f.event(start);
  f.controller.abort();
  const output = await f.output;
  assert.match(output, /claude_cli_protocol/);
  await nextTick();
  f.tick(10000);
  assert.equal(f.children[0].kills, 1);
  assert.doesNotMatch(output, /claude_cli_(?:total_)?timeout/);
});

test("consumer cancellation clears both deadlines", async (t) => {
  const f = await fixture(t, {}, { consume: false });
  f.event(start);
  await f.response.body.cancel();
  f.tick(10000);
  assert.equal(f.children[0].kills, 1);
});

test("invalid timeout values use safe defaults instead of immediate Node timers", async (t) => {
  const f = await fixture(t, { timeoutMs: -1, totalTimeoutMs: 2147483648 });
  for (let i = 0; i < 8; i++) { f.event(i ? delta("thinking_delta") : start); f.tick(100000); }
  assert.equal(f.children[0].kills, 0);
  f.event(delta("text_delta"));
  f.tick(100000);
  assert.match(await f.output, /claude_cli_total_timeout/);
});
