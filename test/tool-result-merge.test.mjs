// 同一個工具呼叫的多筆輸出 -> Anthropic 的單一 tool_result。
//
// Code Mode 的 exec 每呼叫一次 notify()，Codex 就替同一個 call_id 追加一筆
// custom_tool_call_output。Responses 接受，Anthropic 則要求每個 tool_use 恰好
// 一個 tool_result，且 tool_result 必須排在 user 訊息最前面；違反任何一條都是
// 整輪 400，之後同一段歷史每次重送都會再失敗。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";
import { assertAnthropicToolPairing } from "./helpers/anthropic-rules.mjs";

const { bridge } = await loadPayloads();
const { toAnthropicRequest, orderToolResultsFirst } = bridge;

const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistant = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const execCall = (callId, code = "text('ok')") => ({ type: "custom_tool_call", call_id: callId, name: "exec", input: code });
const execOutput = (callId, output, extra = {}) => ({ type: "custom_tool_call_output", call_id: callId, output, ...extra });
const tools = [{ type: "custom", name: "exec", description: "run code", format: { type: "text" } }];
const translate = (input) => toAnthropicRequest({ input, tools }, { upstreamModel: "claude-x" });
const texts = (blocks) => blocks.map((block) => block.text);
const toolResultsOf = (request) =>
  request.messages.flatMap((message) => message.content).filter((block) => block.type === "tool_result");

test("notify() 的多筆輸出併成單一 tool_result（實際卡死的歷史形狀）", () => {
  const id = "toolu_notify";
  const notices = Array.from({ length: 6 }, (_, index) => `CI 仍在建置：第 ${index + 1} 次`);
  const { request, toolOutputsMerged, lateToolOutputs, toolResultsReordered } = translate([
    user("等 CI 跑完"),
    execCall(id, "for (;;) { notify('CI 仍在建置'); }"),
    execOutput(id, [
      { type: "input_text", text: "Script completed\nWall time 283.8 seconds\nOutput:\n" },
      { type: "input_text", text: "in_progress" },
    ]),
    ...notices.map((text) => execOutput(id, text, { name: "exec" })),
  ]);
  assertAnthropicToolPairing(request.messages);
  const results = toolResultsOf(request);
  assert.equal(results.length, 1);
  assert.equal(results[0].tool_use_id, id);
  assert.deepEqual(texts(results[0].content), [
    "Script completed\nWall time 283.8 seconds\nOutput:\n", "in_progress", ...notices,
  ]);
  assert.equal(toolOutputsMerged, 6);
  assert.equal(lateToolOutputs, 0);
  assert.equal(toolResultsReordered, 0);
});

test("通知比最終結果先到時同樣併在一起，順序不變", () => {
  const { request, toolOutputsMerged } = translate([
    user("x"),
    execCall("c"),
    execOutput("c", "進度 1", { name: "exec" }),
    execOutput("c", [{ type: "input_text", text: "Script completed" }]),
  ]);
  assertAnthropicToolPairing(request.messages);
  const results = toolResultsOf(request);
  assert.equal(results.length, 1);
  assert.deepEqual(texts(results[0].content), ["進度 1", "Script completed"]);
  assert.equal(toolOutputsMerged, 1);
});

test("第一筆是空輸出時，後續內容取代佔位文字", () => {
  const { request } = translate([user("x"), execCall("c"), execOutput("c", ""), execOutput("c", "進度")]);
  assertAnthropicToolPairing(request.messages);
  assert.deepEqual(toolResultsOf(request)[0].content, [{ type: "text", text: "進度" }]);
});

test("空的後續輸出不增加內容也不計數", () => {
  const { request, toolOutputsMerged } = translate([
    user("x"), execCall("c"), execOutput("c", "結果"), execOutput("c", ""),
  ]);
  assertAnthropicToolPairing(request.messages);
  assert.deepEqual(toolResultsOf(request)[0].content, [{ type: "text", text: "結果" }]);
  assert.equal(toolOutputsMerged, 0);
});

test("平行呼叫時，後續輸出併回各自的 tool_result", () => {
  const { request } = translate([
    user("x"),
    execCall("a"),
    execCall("b"),
    execOutput("a", "A"),
    execOutput("b", "B"),
    execOutput("a", "A 的通知", { name: "exec" }),
  ]);
  assertAnthropicToolPairing(request.messages);
  const results = toolResultsOf(request);
  assert.deepEqual(results.map((block) => block.tool_use_id), ["a", "b"]);
  assert.deepEqual(texts(results[0].content), ["A", "A 的通知"]);
  assert.deepEqual(texts(results[1].content), ["B"]);
});

test("模型往下走之後才到的輸出改成標明來源的文字，不改寫舊的 tool_result", () => {
  const { request, toolOutputsMerged, lateToolOutputs, toolResultsReordered } = translate([
    user("跑 CI 並繼續其他事"),
    execCall("bg", "// @exec: {\"yield_time_ms\": 1000}"),
    execOutput("bg", "Script running with cell ID 3"),
    assistant("先處理別的"),
    { type: "function_call", call_id: "w", name: "wait", arguments: '{"cell_id":"3"}' },
    execOutput("bg", "CI 完成", { name: "exec" }),
    { type: "function_call_output", call_id: "w", output: "cell 3 done" },
  ]);
  assertAnthropicToolPairing(request.messages);
  const results = toolResultsOf(request);
  assert.deepEqual(results.map((block) => block.tool_use_id), ["bg", "w"]);
  // 舊結果保持原樣，已快取的前綴不受影響。
  assert.deepEqual(texts(results[0].content), ["Script running with cell ID 3"]);
  const last = request.messages.at(-1);
  assert.equal(last.content[0].type, "tool_result");
  assert.equal(last.content[0].tool_use_id, "w");
  assert.match(last.content[1].text, /工具呼叫 bg（exec）的結果已先回傳/);
  assert.deepEqual(last.content[2], { type: "text", text: "CI 完成" });
  assert.equal(toolOutputsMerged, 0);
  assert.equal(lateToolOutputs, 1);
  assert.equal(toolResultsReordered, 1);
});

test("工具呼叫與結果之間夾了 user 內容時，tool_result 仍排在最前面", () => {
  const { request, toolResultsReordered } = translate([
    user("x"),
    execCall("c"),
    user("補充一句"),
    execOutput("c", "結果"),
  ]);
  assertAnthropicToolPairing(request.messages);
  const last = request.messages.at(-1);
  assert.deepEqual(last.content.map((block) => block.type), ["tool_result", "text"]);
  assert.equal(last.content[1].text, "補充一句");
  assert.equal(toolResultsReordered, 1);
});

test("一般單筆輸出維持原本的轉譯結果", () => {
  const { request, toolOutputsMerged, lateToolOutputs, toolResultsReordered } = translate([
    user("x"), execCall("c"), execOutput("c", "結果"), assistant("好了"), user("謝謝"),
  ]);
  assertAnthropicToolPairing(request.messages);
  assert.deepEqual(toolResultsOf(request), [
    { type: "tool_result", tool_use_id: "c", content: [{ type: "text", text: "結果" }] },
  ]);
  assert.deepEqual([toolOutputsMerged, lateToolOutputs, toolResultsReordered], [0, 0, 0]);
});

test("orderToolResultsFirst 只移動 tool_result，其餘區塊維持相對順序", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "1" }, { type: "tool_result", tool_use_id: "a", content: [] },
      { type: "image", source: { type: "url", url: "https://example.com/x.png" } },
      { type: "tool_result", tool_use_id: "b", content: [] }] },
    { role: "assistant", content: [{ type: "text", text: "不動" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: [] }, { type: "text", text: "已正確" }] },
  ];
  assert.equal(orderToolResultsFirst(messages), 1);
  assert.deepEqual(messages[0].content.map((block) => block.tool_use_id ?? block.type), ["a", "b", "text", "image"]);
  assert.deepEqual(messages[1].content, [{ type: "text", text: "不動" }]);
  assert.deepEqual(messages[2].content.map((block) => block.type), ["tool_result", "text"]);
});
