// Opt-in: real Claude CLI, entirely local fake Anthropic API. No subscription
// credentials and no paid requests. Run with TEST_CLAUDE_CLI_BIN=/absolute/path.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchClaudeCli, claudeCliEnvironment, discoverClaudeCliModels } from "../src/claude-cli.mjs";

test("real Claude CLI preserves replay roles/tool results and exposes only Codex MCP tools", {
  skip: !process.env.TEST_CLAUDE_CLI_BIN, timeout: 45000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "router-cli-native-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (!req.url.startsWith("/v1/messages")) { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
    if (req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"input_tokens":30}'); return; }
    const parsed = JSON.parse(body);
    requests.push(parsed);
    if (parsed.messages.some((message) => JSON.stringify(message).includes("cancel-fixture"))) return;
    if (parsed.messages.some((message) => JSON.stringify(message).includes("auth-fixture"))) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "fixture-secret-not-for-display" } }));
      return;
    }
    if (parsed.messages.some((message) => JSON.stringify(message).includes("version-fixture"))) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error",
        message: "Claude Code 2.1.285 does not support this model; version 2.1.300 or newer is required." } }));
      return;
    }
    const tool = parsed.tools.find((tool) => tool.name === "mcp__codex__t0");
    const final = requests.length > 1;
    const refusal = parsed.messages.some((message) => JSON.stringify(message).includes("refusal-fixture"));
    const events = [
      { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", content: [],
        model: "claude-opus-4-6", stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: final ? { type: "text", text: "" }
        : { type: "tool_use", id: "toolu_next", name: tool?.name || "MISSING", input: {} } },
      { type: "content_block_delta", index: 0, delta: final ? { type: "text_delta", text: "已讀取結果" }
        : { type: "input_json_delta", partial_json: '{"text":"next"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: refusal ? "refusal" : final ? "end_turn" : "tool_use", stop_sequence: null,
        ...(refusal ? { stop_details: { type: "refusal", category: "fixture", explanation: "Fixture refusal" } } : {}) }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { ...claudeCliEnvironment(), CLAUDE_CONFIG_DIR: directory, ANTHROPIC_API_KEY: "fixture-key",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_MAX_RETRIES: "0" };
  const discovered = await discoverClaudeCliModels(process.env.TEST_CLAUDE_CLI_BIN, { env });
  assert.ok(discovered.length > 0);
  assert.equal(requests.length, 0, "model discovery never sends a model inference request");
  const response = await fetchClaudeCli({ model: "claude-opus-4-6", system: [{ type: "text", text: "Preserve the fixture." }],
    max_tokens: 100, tools: [{ name: "exec", description: "Fixture tool", input_schema: {
      type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Remember fixture-anchor-123" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_old", name: "exec", input: { text: "old" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_old", content: "fixture-result-456" }] },
    ] }, { binary: process.env.TEST_CLAUDE_CLI_BIN, effort: "max", timeoutMs: 30000 }, null, { env });
  const output = await response.text();
  assert.match(output, /message_stop/, output);
  assert.match(output, /"name":"exec"/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].output_config?.effort, "max", "CLI forwards the selected effort to its upstream");
  assert.equal(requests[0].thinking?.display, "summarized", "thinking summaries are requested so Codex can show them");
  assert.match(JSON.stringify(requests[0].messages), /fixture-anchor-123/);
  assert.match(JSON.stringify(requests[0].messages), /fixture-result-456/);
  assert.ok(requests[0].messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use" && b.id === "toolu_old")));
  assert.deepEqual(requests[0].tools.map((tool) => tool.name), ["mcp__codex__t0"]);

  const image = { type: "image", source: { type: "base64", media_type: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4l8AAAAASUVORK5CYII=" } };
  const second = await fetchClaudeCli({ model: "claude-opus-4-6", max_tokens: 100, tools: [],
    tool_choice: { type: "none" }, system: "Summarize the conversation without tools.", messages: [
      { role: "user", content: [{ type: "text", text: "image-anchor" }, image] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_old", name: "exec", input: { text: "old" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_old", content: "result-for-compaction" }] },
    ] }, { binary: process.env.TEST_CLAUDE_CLI_BIN }, null, { env });
  assert.match(await second.text(), /已讀取結果/);
  assert.deepEqual(requests[1].tools, []);
  assert.match(JSON.stringify(requests[1].messages), /result-for-compaction/);
  assert.match(JSON.stringify(requests[1].messages), new RegExp(image.source.data.slice(0, 20)));

  const abort = new AbortController();
  const third = await fetchClaudeCli({ model: "claude-opus-4-6", max_tokens: 100, tools: [],
    messages: [{ role: "user", content: "cancel-fixture" }] }, { binary: process.env.TEST_CLAUDE_CLI_BIN }, abort.signal, { env });
  const deadline = Date.now() + 5000;
  while (requests.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.length, 3);
  const before = Date.now();
  abort.abort();
  const cancelled = await third.text();
  assert.doesNotMatch(cancelled, /message_stop/);
  assert.ok(Date.now() - before < 2000, "cancellation does not wait for upstream timeout");
  const fourth = await fetchClaudeCli({ model: "claude-opus-4-6", max_tokens: 100, tools: [],
    messages: [{ role: "user", content: "auth-fixture" }] }, { binary: process.env.TEST_CLAUDE_CLI_BIN, timeoutMs: 5000 }, null, { env });
  const authError = await fourth.text();
  assert.match(authError, /claude_cli_authentication_failed/);
  assert.doesNotMatch(authError, /fixture-secret-not-for-display|message_stop/);
  const fifth = await fetchClaudeCli({ model: "claude-opus-4-6", max_tokens: 100, tools: [],
    messages: [{ role: "user", content: "refusal-fixture" }] }, { binary: process.env.TEST_CLAUDE_CLI_BIN, timeoutMs: 5000 }, null, { env });
  const refused = await fifth.text();
  assert.match(refused, /"stop_reason":"refusal"/);
  assert.doesNotMatch(refused, /claude_cli_protocol/);
  const sixth = await fetchClaudeCli({ model: "claude-opus-4-6", max_tokens: 100, tools: [],
    messages: [{ role: "user", content: "version-fixture" }] }, { binary: process.env.TEST_CLAUDE_CLI_BIN, timeoutMs: 5000 }, null, { env });
  const versionError = await sixth.text();
  assert.match(versionError, /claude_cli_upgrade_required/);
  assert.match(versionError, /"requiredVersion":"2.1.300"/);
});

// Anthropic 的快取規則：最多 4 個斷點，1 小時 TTL 不可排在 5 分鐘之後，每個斷點
// 只往前回看約 20 個區塊。假 API 依此拒收，並逐區塊比對相鄰兩個 CLI 行程的前綴。
function promptBlocks(body) {
  const blocks = [];
  for (const tool of body.tools || []) blocks.push({ kind: "tool", block: tool });
  for (const block of Array.isArray(body.system) ? body.system : []) blocks.push({ kind: "system", block });
  body.messages.forEach((message, index) => (Array.isArray(message.content) ? message.content
    : [{ type: "text", text: message.content }]).forEach((block, position) =>
    blocks.push({ kind: `${message.role}:${index}:${position}`, block })));
  return blocks;
}
const canonicalBlock = ({ kind, block }) => JSON.stringify({ kind, ...block, cache_control: undefined });

test("real Claude CLI keeps replayed history cacheable and Codex tool descriptions complete", {
  skip: !process.env.TEST_CLAUDE_CLI_BIN, timeout: 60000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "router-cli-cache-native-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" }); res.end('{"input_tokens":30}'); return;
    }
    const parsed = JSON.parse(body);
    requests.push(parsed);
    const ttls = promptBlocks(parsed).filter(({ block }) => block.cache_control).map(({ block }) => block.cache_control.ttl || "5m");
    const misordered = ttls.some((ttl, index) => ttl === "1h" && ttls.slice(0, index).includes("5m"));
    if (ttls.length > 4 || misordered) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: ttls.length > 4
        ? `A maximum of 4 blocks with cache_control may be provided. Found ${ttls.length}.`
        : "cache_control ttl 1h must not follow ttl 5m" } }));
      return;
    }
    const events = [
      { type: "message_start", message: { id: "msg_cache", type: "message", role: "assistant", content: [],
        model: parsed.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { ...claudeCliEnvironment(), CLAUDE_CONFIG_DIR: directory, ANTHROPIC_API_KEY: "fixture-key",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_MAX_RETRIES: "0" };
  const description = "Codex tool reference. " + "detail ".repeat(1200) + "END-OF-REFERENCE";
  const base = { system: [{ type: "text", text: "Stable system" }], max_tokens: 100,
    tools: [{ name: "exec", description, input_schema: { type: "object", properties: { text: { type: "string" } } } }] };
  const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
  const call = (id) => ({ role: "assistant", content: [{ type: "tool_use", id, name: "exec", input: { text: id } }] });
  const result = (id) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `result ${id}` }] });
  const first = [user("anchor"), call("toolu_1"), result("toolu_1")];
  const second = [...first, call("toolu_2"), result("toolu_2")];
  const third = [...second, { role: "assistant", content: [{ type: "text", text: "done" }] }, user("next question")];
  // Opus 4.6 receives the CLI's environment reminders inside the final user
  // message; Opus 5.5 receives them as a trailing mid-conversation system message.
  for (const model of ["claude-opus-4-6", "claude-opus-5-5"]) {
    requests.length = 0;
    for (const messages of [first, second, third]) {
      const output = await (await fetchClaudeCli({ ...base, model, messages },
        { binary: process.env.TEST_CLAUDE_CLI_BIN, timeoutMs: 30000 }, null, { env })).text();
      assert.match(output, /message_stop/, output);
      assert.doesNotMatch(output, /claude_cli_/, output);
    }
    assert.equal(requests.length, 3, `${model}: no turn needed the uncached fallback`);
    for (const body of requests) {
      const marked = promptBlocks(body).filter(({ block }) => block.cache_control);
      assert.ok(marked.length <= 4);
      assert.ok(marked.every(({ block }) => block.cache_control.ttl === "1h"), JSON.stringify(marked.map(({ block }) => block.cache_control)));
      assert.deepEqual(body.tools.map((tool) => tool.name), ["mcp__codex__t0"], "tools are not deferred behind a search tool");
      assert.ok(body.tools[0].description.endsWith("END-OF-REFERENCE"), "the complete Codex description reaches Claude");
    }
    for (let index = 0; index + 1 < requests.length; index++) {
      const current = promptBlocks(requests[index]);
      const next = promptBlocks(requests[index + 1]);
      // The router's breakpoint is the first one inside messages; the CLI's own
      // trailing breakpoint sits on content rebuilt for every process.
      const reused = current.findIndex((entry) => entry.block.cache_control && entry.kind.includes(":"));
      const newInput = requests[index].messages.findLastIndex((message) => message.role === "user");
      assert.ok(reused >= 0 && Number(current[reused].kind.split(":")[1]) < newInput,
        `${model}: a history breakpoint precedes the new input`);
      assert.deepEqual(next.slice(0, reused + 1).map(canonicalBlock), current.slice(0, reused + 1).map(canonicalBlock),
        `${model}: turn ${index + 2} replays turn ${index + 1}'s cached prefix`);
      assert.ok(next.some((entry, position) => entry.block.cache_control && position >= reused && position - reused <= 20),
        "the next breakpoint is within the 20-block lookback");
    }
  }
});
