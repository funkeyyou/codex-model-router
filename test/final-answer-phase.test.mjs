// 轉譯路由的訊息階段（phase）與 Claude 的 Codex 說明。
//
// Codex 用 phase 區分進度更新（commentary）與最終答案（final_answer），桌面版靠後者
// 辨識回合是否已經答完。轉譯層以前把每段文字都標成 commentary；現在延後送出文字項目的
// output_item.done，確定後面沒有工具呼叫、且正常結束時才標成 final_answer。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { bridge, chat } = await loadPayloads();

const body = (text) => (async function* () { yield Buffer.from(text); })();
const anthropic = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const start = { type: "message_start", message: { usage: { input_tokens: 5 } } };
const text = (index, value) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text: value } },
  { type: "content_block_stop", index },
];
const thinking = (index, value) => [
  { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: value } },
  { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } },
  { type: "content_block_stop", index },
];
const toolUse = (index) => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${index}`, name: "lookup", input: {} } },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: '{"q":"x"}' } },
  { type: "content_block_stop", index },
];
const stop = (reason) => [{ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 3 } }, { type: "message_stop" }];

async function runClaude(events, extra = {}) {
  const out = [];
  await bridge.bridgeAnthropicStream(body(typeof events === "string" ? events : anthropic(events)), (event) => out.push(event),
    { model: "claude-test", requestBody: {}, freeform: new Set(), ...extra });
  return out;
}

const messageDones = (events) => events.filter((event) => event.type === "response.output_item.done" && event.item.type === "message")
  .map((event) => [event.item.content[0].text, event.item.phase]);
const terminal = (events) => events.find((event) => /^response\.(completed|incomplete|failed)$/.test(event.type));

// 每個項目依序開始與結束：前一項 done 之後才 added 下一項，done 恰好一次，並早於終止事件。
function assertOrdered(events) {
  const open = new Set();
  const finished = new Set();
  let terminated = false;
  for (const event of events) {
    if (/^response\.(completed|incomplete|failed)$/.test(event.type)) terminated = true;
    if (event.type === "response.output_item.added") {
      assert.equal(open.size, 0, `item ${event.output_index} started before the previous item finished`);
      open.add(event.output_index);
    }
    if (event.type === "response.output_item.done") {
      assert.equal(terminated, false, "item finished after the terminal event");
      assert.ok(open.delete(event.output_index), `item ${event.output_index} finished without starting`);
      assert.ok(!finished.has(event.output_index), `item ${event.output_index} finished twice`);
      finished.add(event.output_index);
    }
  }
}

test("Claude: only the last text of a turn without tool calls is the final answer", async () => {
  const cases = [
    [[start, ...text(0, "answer"), ...stop("end_turn")], [["answer", "final_answer"]], "response.completed"],
    [[start, ...thinking(0, "plan"), ...text(1, "answer"), ...stop("end_turn")], [["answer", "final_answer"]], "response.completed"],
    [[start, ...text(0, "checking"), ...toolUse(1), ...stop("tool_use")], [["checking", "commentary"]], "response.completed"],
    [[start, ...text(0, "first"), ...thinking(1, "more"), ...text(2, "second"), ...stop("end_turn")],
      [["first", "commentary"], ["second", "final_answer"]], "response.completed"],
    [[start, ...toolUse(0), ...text(1, "after tool"), ...stop("tool_use")], [["after tool", "commentary"]], "response.completed"],
    [[start, ...text(0, "cut off"), ...stop("max_tokens")], [["cut off", "commentary"]], "response.incomplete"],
    [[start, ...text(0, "stopped"), ...stop("stop_sequence")], [["stopped", "final_answer"]], "response.completed"],
  ];
  for (const [events, expected, type] of cases) {
    const out = await runClaude(events);
    assertOrdered(out);
    assert.deepEqual(messageDones(out), expected);
    const end = terminal(out);
    assert.equal(end.type, type);
    assert.deepEqual(end.response.output.filter((item) => item.type === "message").map((item) => [item.content[0].text, item.phase]), expected,
      "the terminal response matches the done events");
    const added = out.filter((event) => event.type === "response.output_item.added" && event.item.type === "message");
    assert.ok(added.every((event) => event.item.phase === "commentary"), "streaming starts as a progress update");
  }
});

test("Claude: failures, refusals, truncation and compaction never produce a final answer", async () => {
  const refused = await runClaude([start, ...text(0, "partial"),
    { type: "message_delta", delta: { stop_reason: "refusal" }, stop_details: { type: "refusal", category: "fixture" } }, { type: "message_stop" }]);
  assertOrdered(refused);
  assert.deepEqual(messageDones(refused), [["partial", "commentary"]]);
  assert.equal(terminal(refused).type, "response.failed");

  const errored = await runClaude([start, ...text(0, "partial"), { type: "error", error: { type: "overloaded_error", message: "busy" } }]);
  assert.deepEqual(messageDones(errored), [["partial", "commentary"]]);
  assert.equal(terminal(errored).type, "response.failed");

  const truncated = await runClaude([start, ...text(0, "partial")]);
  assert.deepEqual(messageDones(truncated), [["partial", "commentary"]]);
  assert.equal(terminal(truncated), undefined, "the router adds the truncation failure");

  const compaction = await runClaude([start, ...text(0, "summary text"), ...stop("end_turn")], { compaction: true });
  assert.deepEqual(messageDones(compaction), [], "compaction text is never sent as a message");
  assert.deepEqual(terminal(compaction).response.output.map((item) => item.type), ["compaction"]);
});

test("Claude: the non-streaming JSON fallback labels the final answer the same way", async () => {
  const json = (content, stopReason) => JSON.stringify({ type: "message", role: "assistant", content, stop_reason: stopReason,
    usage: { input_tokens: 1, output_tokens: 1 } });
  const final = await runClaude(json([{ type: "text", text: "answer" }], "end_turn"));
  assert.deepEqual(messageDones(final), [["answer", "final_answer"]]);
  const withTool = await runClaude(json([{ type: "text", text: "checking" },
    { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }], "tool_use"));
  assertOrdered(withTool);
  assert.deepEqual(messageDones(withTool), [["checking", "commentary"]]);
});

async function runChat(chunks) {
  const out = [];
  const sse = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join("");
  await chat.bridgeChatStream(body(sse), (event) => out.push(event),
    { model: "chat-test", requestBody: {}, freeform: new Set(), toolTargets: new Map() });
  return out;
}
const delta = (value) => ({ choices: [{ index: 0, delta: value }] });
const finish = (reason) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const toolCall = { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }] };

test("Chat Completions: final answers and progress updates are labelled like Responses", async () => {
  const cases = [
    [[delta({ content: "answer" }), finish("stop"), "[DONE]"], [["answer", "final_answer"]], "response.completed"],
    [[delta({ content: "answer" }), "[DONE]"], [["answer", "final_answer"]], "response.completed"],
    [[delta({ content: "checking" }), delta(toolCall), finish("tool_calls"), "[DONE]"], [["checking", "commentary"]], "response.completed"],
    [[delta({ content: "first" }), delta({ reasoning_content: "more" }), delta({ content: "second" }), finish("stop"), "[DONE]"],
      [["first", "commentary"], ["second", "final_answer"]], "response.completed"],
    [[delta({ content: "cut off" }), finish("length"), "[DONE]"], [["cut off", "commentary"]], "response.incomplete"],
  ];
  for (const [chunks, expected, type] of cases) {
    const out = await runChat(chunks);
    assertOrdered(out);
    assert.deepEqual(messageDones(out), expected);
    assert.equal(terminal(out).type, type);
    assert.deepEqual(terminal(out).response.output.filter((item) => item.type === "message").map((item) => [item.content[0].text, item.phase]), expected);
  }
  const failed = await runChat([delta({ content: "partial" }), { error: { message: "upstream failed" } }]);
  // 仍在串流中的文字不補 done（與修改前相同），更不會被當成最終答案。
  assert.deepEqual(messageDones(failed), []);
  assert.equal(terminal(failed).type, "response.failed");
});

test("Claude routes get one stable Codex note as the last, cached system block", () => {
  const user = (value) => ({ type: "message", role: "user", content: [{ type: "input_text", text: value }] });
  const route = { upstreamModel: "claude-test", promptCache: true };
  const first = bridge.toAnthropicRequest({ instructions: "base", input: [user("one")] }, route).request;
  const later = bridge.toAnthropicRequest({ instructions: "base", input: [user("one"),
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "reply" }] }, user("two")] }, route).request;
  const compacting = bridge.toAnthropicRequest({ instructions: "base", input: [user("one"), { type: "compaction_trigger" }] }, route).request;
  for (const request of [first, later, compacting]) {
    assert.equal(request.system.at(-1).text, bridge.CLAUDE_CODEX_GUIDANCE);
    assert.deepEqual(request.system.at(-1).cache_control, { type: "ephemeral" });
    assert.equal(request.system.filter((block) => block.text === bridge.CLAUDE_CODEX_GUIDANCE).length, 1);
    assert.equal(JSON.stringify(request.messages).includes("Notes for Claude models in Codex"), false);
  }
  assert.deepEqual(later.system, first.system);
  assert.deepEqual(compacting.system, first.system, "compaction turns keep the cached system prefix");
  assert.match(bridge.CLAUDE_CODEX_GUIDANCE, /commentary/);
  assert.match(bridge.CLAUDE_CODEX_GUIDANCE, /final/);
  assert.match(bridge.CLAUDE_CODEX_GUIDANCE, /Before your first tool call/);
  const bare = bridge.toAnthropicRequest({ input: "hello" }, "claude-test").request;
  assert.deepEqual(bare.system.map((block) => block.text), [bridge.CLAUDE_CODEX_GUIDANCE]);
  const chatRequest = chat.toChatRequest({ instructions: "base", input: "hello" }, { upstreamModel: "chat-test" }).request;
  assert.equal(JSON.stringify(chatRequest).includes("Notes for Claude models in Codex"), false, "Chat routes are unchanged");
});
