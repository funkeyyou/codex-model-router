// Claude CLI 路由的提示快取。
//
// CLI 自己把最後一個快取斷點放在它附加於歷史之後、每個行程都重建的環境區塊上，
// 下一輪無法重用；實測訂閱路由的快取命中率只有約 20%。路由器因此在重播歷史的
// 結尾加上一個與 CLI 同 TTL 的斷點，並讓 system 不再因中途的 developer 訊息而改變。

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPayloads } from "./helpers/payloads.mjs";

const { bridge, dir } = await loadPayloads();
const cli = await import(pathToFileURL(join(dir, "claude-cli.mjs")));

const system = [{ type: "text", text: "System" }];
const tools = [{ name: "exec", description: "Run", input_schema: { type: "object" } }];
const rowsOf = (prepared) => prepared.transcript.split("\n").map((line) => JSON.parse(line));
const markers = (rows) => rows.flatMap((row, r) => (Array.isArray(row.message.content) ? row.message.content : [])
  .flatMap((block, b) => block.cache_control ? [{ r, b, type: block.type, cache: block.cache_control }] : []));
const contents = (prepared) => (prepared.plainTranscript ? prepared.plainTranscript.split("\n") : [])
  .map((line) => JSON.parse(line).message.content);
const toolLoop = [
  { role: "user", content: [{ type: "text", text: "anchor" }] },
  { role: "assistant", content: [{ type: "thinking", thinking: "plan", signature: "sig" },
    { type: "tool_use", id: "t1", name: "exec", input: { cmd: "one" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result one" }] },
];

test("CLI environment pins one cache TTL, keeps full MCP tool descriptions and disables tool deferral", () => {
  const env = cli.claudeCliEnvironment({ PATH: "fixture", ENABLE_TOOL_SEARCH: "true", FORCE_PROMPT_CACHING_5M: "1",
    ENABLE_PROMPT_CACHING_1H: "1", DISABLE_PROMPT_CACHING: "1", CLAUDE_CODE_PROMPT_CACHE_TTL: "5m",
    CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "10" });
  assert.equal(env.CLAUDE_CODE_PROMPT_CACHE_TTL, cli.CLI_CACHE_TTL);
  assert.equal(cli.CLI_CACHE_TTL, "1h");
  assert.equal(env.ENABLE_TOOL_SEARCH, "false");
  assert.ok(Number(env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH) >= 1000000);
  for (const key of ["FORCE_PROMPT_CACHING_5M", "ENABLE_PROMPT_CACHING_1H", "DISABLE_PROMPT_CACHING"]) {
    assert.equal(env[key], undefined, key);
  }
  assert.equal(env.PATH, "fixture");
});

test("one history breakpoint marks the end of the replayed transcript, never thinking or the new input", () => {
  const source = { model: "m", system, tools, messages: toolLoop };
  const copy = structuredClone(source);
  const loop = cli.prepareCliConversation(source, dir);
  assert.deepEqual(source, copy);
  assert.equal(loop.cacheMarker, true);
  assert.deepEqual(markers(rowsOf(loop)), [{ r: 2, b: 0, type: "tool_result", cache: { type: "ephemeral", ttl: "1h" } }]);
  assert.doesNotMatch(loop.plainTranscript, /cache_control/);
  assert.doesNotMatch(loop.input, /cache_control/);

  // The next request replays the same history followed by new blocks; its first
  // rows are identical, so the previous breakpoint becomes a cache read.
  const nextTurn = cli.prepareCliConversation({ ...source, messages: [...toolLoop,
    { role: "assistant", content: [{ type: "text", text: "done" }, { type: "redacted_thinking", data: "opaque" }] },
    { role: "user", content: [{ type: "text", text: "next question" }] }] }, dir);
  assert.deepEqual(contents(nextTurn).slice(0, 3), contents(loop));
  assert.deepEqual(markers(rowsOf(nextTurn)).map(({ r, type }) => [r, type]), [[3, "text"]]);
  assert.equal(JSON.parse(nextTurn.input).message.content[0].text, "next question");

  const single = cli.prepareCliConversation({ model: "m", system, tools, messages: [{ role: "user", content: "hi" }] }, dir);
  assert.equal(single.transcript, "");
  assert.equal(single.cacheMarker, false);
  const disabled = cli.prepareCliConversation(source, dir, { cacheTtl: null });
  assert.equal(disabled.cacheMarker, false);
  assert.doesNotMatch(disabled.transcript, /cache_control/);
  const stringContent = cli.prepareCliConversation({ model: "m", system, tools, messages: [
    { role: "user", content: "plain history" }, { role: "assistant", content: "plain answer" }, { role: "user", content: "next" }] }, dir);
  assert.deepEqual(markers(rowsOf(stringContent)).map(({ r, type }) => [r, type]), [[1, "text"]]);
});

test("a per-turn tool constraint goes into the new input, leaving the cached system prompt unchanged", () => {
  const base = cli.prepareCliConversation({ model: "m", system, tools, messages: toolLoop }, dir);
  for (const [choice, pattern] of [[{ type: "none" }, /do not call any tools/], [{ type: "any" }, /at least one/],
    [{ type: "tool", name: "exec" }, /call only the tool mcp__codex__t0/]]) {
    const prepared = cli.prepareCliConversation({ model: "m", system, tools, messages: toolLoop, tool_choice: choice }, dir);
    assert.equal(prepared.system, base.system);
    assert.deepEqual(contents(prepared), contents(base));
    assert.match(JSON.parse(prepared.input).message.content.at(-1).text, pattern);
  }
  const stringInput = cli.prepareCliConversation({ model: "m", system, tools, tool_choice: { type: "none" },
    messages: [{ role: "user", content: "only turn" }] }, dir);
  assert.deepEqual(JSON.parse(stringInput.input).message.content.map((block) => block.type), ["text", "text"]);
});

test("Claude bridge keeps leading developer messages in system and later ones in place", () => {
  const route = { upstreamModel: "claude-test", promptCache: true };
  const dev = (text) => ({ type: "message", role: "developer", content: [{ type: "input_text", text }] });
  const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
  const answer = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  const first = [{ type: "additional_tools", role: "developer", tools: [] }, dev("permissions"), dev("apps"),
    user("<environment_context />"), user("first question"), answer("first answer")];
  const before = bridge.toAnthropicRequest({ instructions: "base", input: first }, route).request;
  const after = bridge.toAnthropicRequest({ instructions: "base",
    input: [...first, dev("<skills_instructions>new</skills_instructions>"), user("second question")] }, route).request;
  assert.deepEqual(before.system.map((block) => block.text), ["base", "permissions", "apps", bridge.CLAUDE_CODEX_GUIDANCE]);
  assert.deepEqual(after.system, before.system);
  assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages);
  assert.deepEqual(after.messages.at(-1).content.map((block) => block.text), [
    "<system-reminder>\nCodex developer message:\n<skills_instructions>new</skills_instructions>\n</system-reminder>",
    "second question",
  ]);

  const lookup = { type: "function", name: "lookup", parameters: { type: "object", properties: {} } };
  const between = bridge.toAnthropicRequest({ tools: [lookup], input: [user("question"),
    { type: "function_call", call_id: "c1", name: "lookup", arguments: "{}" }, dev("mode changed"),
    { type: "function_call_output", call_id: "c1", output: "ok" }] }, route).request;
  const content = between.messages.at(-1).content;
  assert.equal(content[0].type, "tool_result");
  assert.match(content[1].text, /Codex developer message:\nmode changed/);
  assert.deepEqual(between.system.map((block) => block.text), [bridge.CLAUDE_CODEX_GUIDANCE]);
});

// 假的 Claude CLI：記錄每次收到的重播歷史，並可在歷史帶斷點時模擬 API 拒收。
function fakeCli(directory) {
  const script = join(directory, "claude");
  writeFileSync(script, [
    `#!${process.execPath}`,
    'const fs = require("fs"); const path = require("path");',
    "const args = process.argv.slice(2);",
    'const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;',
    'const history = resume ? fs.readFileSync(resume, "utf8") : "";',
    'const marked = history.includes("cache_control");',
    'const display = args.includes("--thinking-display") ? args[args.indexOf("--thinking-display") + 1] : null;',
    'fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ resume: resume && path.basename(resume), marked, display }) + "\\n");',
    'const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");',
    'process.stdin.resume(); process.stdin.on("end", () => {',
    '  out({ type: "system", subtype: "init" });',
    '  const error = process.env.FAKE_CLI_ERROR || (marked ? process.env.FAKE_CLI_MARKER_ERROR : "");',
    '  if (error) {',
    '    out({ type: "assistant", error: "invalid_request", message: { content: [{ type: "text", text: "API Error: 400 " + error }] } });',
    '    out({ type: "result", subtype: "error_during_execution", is_error: true });',
    '    return;',
    '  }',
    '  for (const event of [',
    '    { type: "message_start", message: { usage: { input_tokens: 1 } } },',
    '    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },',
    '    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },',
    '    { type: "content_block_stop", index: 0 },',
    '    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },',
    '    { type: "message_stop" },',
    '  ]) out({ type: "stream_event", event });',
    '  out({ type: "result", subtype: "success" });',
    "});",
    "",
  ].join("\n"));
  chmodSync(script, 0o755);
  return script;
}

test("a rejected history breakpoint is resent once without it and paused for later turns", {
  skip: process.platform === "win32",
}, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "router-cli-cache-"));
  t.after(() => { rmSync(directory, { recursive: true, force: true }); cli.resetCliCacheMarker(); });
  cli.resetCliCacheMarker();
  const binary = fakeCli(directory);
  const log = join(directory, "calls.jsonl");
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const request = { model: "m", system: "S", tools: [], max_tokens: 100, messages: [
    { role: "user", content: [{ type: "text", text: "a" }] }, { role: "assistant", content: [{ type: "text", text: "b" }] },
    { role: "user", content: [{ type: "text", text: "c" }] }] };
  const env = { ...process.env, FAKE_CLI_LOG: log,
    FAKE_CLI_MARKER_ERROR: '{"type":"error","error":{"type":"invalid_request_error","message":"A maximum of 4 blocks with cache_control may be provided. Found 5."}}' };
  const diagnostics = [];
  const first = await (await cli.fetchClaudeCli(request, { binary, timeoutMs: 10000 }, null,
    { env, onDiagnostic: (event) => diagnostics.push(event) })).text();
  assert.equal(first.match(/"type":"message_start"/g)?.length, 1);
  assert.match(first, /"type":"message_stop"/);
  assert.doesNotMatch(first, /claude_cli_/);
  assert.deepEqual(calls(), [{ resume: "history.jsonl", marked: true, display: "summarized" },
    { resume: "history-plain.jsonl", marked: false, display: "summarized" }], "thinking summaries are requested on every launch");
  assert.equal(diagnostics.filter((event) => event.type === "cache_marker_fallback").length, 1);
  assert.equal(cli.cliCacheMarkerEnabled(), false);

  await (await cli.fetchClaudeCli(request, { binary, timeoutMs: 10000 }, null, { env })).text();
  assert.deepEqual(calls().slice(2), [{ resume: "history.jsonl", marked: false, display: "summarized" }], "the paused marker costs no extra process");

  cli.resetCliCacheMarker();
  const unrelated = await (await cli.fetchClaudeCli(request, { binary, timeoutMs: 10000 }, null,
    { env: { ...env, FAKE_CLI_ERROR: '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}' } })).text();
  assert.match(unrelated, /claude_cli_context_length_exceeded/);
  assert.deepEqual(calls().slice(3), [{ resume: "history.jsonl", marked: true, display: "summarized" }], "other errors are never retried");
  assert.equal(cli.cliCacheMarkerEnabled(), true);

  const alwaysRejected = await (await cli.fetchClaudeCli(request, { binary, timeoutMs: 10000 }, null,
    { env: { ...env, FAKE_CLI_ERROR: '{"type":"error","error":{"type":"invalid_request_error","message":"cache_control ttl ordering"}}' } })).text();
  assert.match(alwaysRejected, /claude_cli_protocol/);
  assert.deepEqual(calls().slice(4).map((call) => call.marked), [true, false], "only one retry");
});
