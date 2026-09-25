// 安全系統遮蔽的推理（redacted_thinking）。
//
// Anthropic 偶爾回傳只有密文的 redacted_thinking 區塊。以前轉譯層直接丟掉它；
// 同一輪若接著呼叫工具，下一輪送回工具結果時，Anthropic 會因為最後一則 assistant
// 訊息沒有以 thinking／redacted_thinking 開頭而拒收。現在與一般 thinking 一樣往返。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";
import { assertAnthropicToolPairing } from "./helpers/anthropic-rules.mjs";

const { bridge, router } = await loadPayloads();
const DATA = "EmwKAhgBEgyredactedfixture" + "x".repeat(2000);

async function streamEvents(events) {
  const emitted = [];
  const body = (async function* () {
    for (const event of events) yield Buffer.from(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  })();
  await bridge.bridgeAnthropicStream(body, (event) => emitted.push(event),
    { model: "custom/claude", requestBody: {}, freeform: new Set(), toolTargets: new Map() });
  return emitted;
}

test("redacted_thinking 變成可往返的 reasoning 項目，下一輪原樣送回", async () => {
  const emitted = await streamEvents([
    { type: "message_start", message: { usage: { input_tokens: 3 } } },
    { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: DATA } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_r1", name: "shell", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"cmd\":\"ls\"}" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ]);
  const completed = emitted.find((event) => event.type === "response.completed");
  const [reasoning, call] = completed.response.output;
  assert.equal(reasoning.type, "reasoning");
  assert.ok(reasoning.encrypted_content.length < 400, "交給 Codex 的只是短索引，不會讓它重複估算長密文");
  assert.equal(call.type, "function_call");

  const { request } = bridge.toAnthropicRequest({
    tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "列出檔案" }] },
      reasoning,
      call,
      { type: "function_call_output", call_id: "toolu_r1", output: "a.txt" },
    ],
  }, { upstreamModel: "claude-x" });
  const assistant = request.messages.find((message) => message.role === "assistant");
  assert.deepEqual(assistant.content[0], { type: "redacted_thinking", data: DATA });
  assert.equal(assistant.content[1].type, "tool_use");
  assertAnthropicToolPairing(request.messages);
});

test("磁碟不可用時的原格式也能還原", () => {
  const encrypted = Buffer.from(JSON.stringify({ redacted_thinking: "opaque" })).toString("base64");
  const { request } = bridge.toAnthropicRequest({
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "reasoning", encrypted_content: encrypted, summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    ],
  }, { upstreamModel: "claude-x" });
  assert.deepEqual(request.messages[1].content[0], { type: "redacted_thinking", data: "opaque" });
});

test("切回官方或其他路由時，redacted 推理跟其他轉譯層推理一起剝除", () => {
  const raw = { type: "reasoning", encrypted_content: Buffer.from(JSON.stringify({ redacted_thinking: "opaque" })).toString("base64") };
  const stored = { type: "reasoning", encrypted_content: bridge.encodeRedactedReasoning("opaque-stored") };
  const official = { type: "reasoning", encrypted_content: "gAAAAB-official-ciphertext" };
  const { input, removed } = router.stripBridgeReasoning([raw, stored, official]);
  assert.equal(removed, 2);
  assert.deepEqual(input, [official]);
});
