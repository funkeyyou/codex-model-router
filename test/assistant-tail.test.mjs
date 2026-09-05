// assistant 訊息的結尾不能是 thinking。
//
// Anthropic 會整輪拒絕：
//   messages.N: The final block in an assistant message cannot be `thinking`.
// 一輪被中斷、或那一輪只產出推理就換使用者說話時，歷史裡就會留下這種訊息。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { bridge } = await loadPayloads();
const { toAnthropicRequest, encodeReasoning } = bridge;

const build = (input) => toAnthropicRequest({ input }, { upstreamModel: "claude-x" });
const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistant = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const reasoning = (text) => ({ type: "reasoning", encrypted_content: encodeReasoning(text, "sig") });

const lastBlock = (message) => message.content[message.content.length - 1];

test("結尾的 thinking 會被剝掉", () => {
  const { request, thinkingTrimmed } = build([user("問"), assistant("答"), reasoning("想")]);
  assert.equal(thinkingTrimmed, 1);
  for (const message of request.messages) {
    if (message.role !== "assistant") continue;
    assert.notEqual(lastBlock(message).type, "thinking");
  }
});

test("thinking 後面還有文字時不動它", () => {
  const { request, thinkingTrimmed } = build([user("問"), reasoning("想"), assistant("答")]);
  assert.equal(thinkingTrimmed, 0);
  const message = request.messages.at(-1);
  assert.equal(message.content[0].type, "thinking");
  assert.equal(lastBlock(message).type, "text");
});

test("thinking 後面是工具呼叫時不動它", () => {
  const { request, thinkingTrimmed } = build([
    user("問"),
    reasoning("想"),
    { type: "custom_tool_call", call_id: "c1", name: "exec", input: "ls" },
    { type: "custom_tool_call_output", call_id: "c1", output: "ok" },
  ]);
  assert.equal(thinkingTrimmed, 0);
  const assistantMessage = request.messages.find((m) => m.role === "assistant");
  assert.equal(lastBlock(assistantMessage).type, "tool_use");
});

test("只有 thinking 的 assistant 訊息整則移除，且不會留下連續兩則 user", () => {
  const { request, thinkingTrimmed } = build([user("問一"), reasoning("想"), user("問二")]);
  assert.equal(thinkingTrimmed, 1);
  assert.equal(request.messages.length, 1, "兩則 user 應該合併成一則");
  assert.equal(request.messages[0].role, "user");
  assert.deepEqual(request.messages[0].content.map((b) => b.text), ["問一", "問二"]);
});

test("整串都被剝空時仍會補上開頭的 user 訊息", () => {
  const { request } = build([reasoning("想")]);
  assert.equal(request.messages[0].role, "user");
});
