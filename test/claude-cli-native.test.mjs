// Opt-in: real Claude CLI, entirely local fake Anthropic API. No subscription
// credentials and no paid requests. Run with TEST_CLAUDE_CLI_BIN=/absolute/path.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchClaudeCli, claudeCliEnvironment } from "../src/claude-cli.mjs";

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
