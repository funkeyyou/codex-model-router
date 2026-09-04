// 推理摘要的顯示。
//
// 這些模型預設 display=omitted：thinking 區塊照樣送來，但文字是空的
// （實測 thinking 字元數 = 0）。要 summarized 才有內容。
//
// 但光是拿到文字還不夠：轉譯層把它塞進 encrypted_content（那是給往返用的），
// 而 Codex 顯示的是 reasoning 項目的 summary 欄位。兩邊都要處理才看得到。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { bridge } = await loadPayloads();
const { toAnthropicRequest, bridgeAnthropicStream, decodeCompaction } = bridge;

const summaryRoute = {
  upstreamModel: "claude-x",
  effortControl: "output_config",
  promptCache: true,
  reasoningSummary: true,
};

// --- 請求方向 ---------------------------------------------------------------

test("開啟時要求 adaptive + summarized", () => {
  const { request } = toAnthropicRequest(
    { input: "hi", reasoning: { effort: "high" } }, summaryRoute);
  assert.deepEqual(request.thinking, { type: "adaptive", display: "summarized" });
  // 強度仍然走 output_config，兩者並存
  assert.deepEqual(request.output_config, { effort: "high" });
});

test("沒探到支援就不送 thinking（維持現行行為）", () => {
  const { request } = toAnthropicRequest({ input: "hi" },
    { ...summaryRoute, reasoningSummary: false });
  assert.equal(request.thinking, undefined);
});

test("舊路由沒有這個欄位時不會突然開啟", () => {
  const { request } = toAnthropicRequest({ input: "hi" },
    { upstreamModel: "x", effortControl: "output_config" });
  assert.equal(request.thinking, undefined);
});

test("舊的 budget_tokens 路徑不受影響", () => {
  const { request } = toAnthropicRequest(
    { input: "hi", reasoning: { effort: "high" } },
    { upstreamModel: "x", effortControl: "thinking_budget", reasoningSummary: true },
  );
  assert.equal(request.thinking.type, "enabled");
  assert.ok(request.thinking.budget_tokens > 0);
  assert.equal(request.thinking.display, undefined);
});

// --- 回應方向 ---------------------------------------------------------------

const sse = (events) => {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); },
  });
};

async function runStream(thinkingDeltas) {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    ...thinkingDeltas.map((t) => ({
      type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: t },
    })),
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "答案" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  const out = [];
  await bridgeAnthropicStream(sse(events), (e) => out.push(e), {
    model: "custom/x", freeform: new Set(), compaction: false, requestBody: {},
  });
  return out;
}

test("有摘要文字時串出 reasoning_summary 事件", async () => {
  const out = await runStream(["先想一下：", "9.11 比 9.9 小。"]);
  const types = out.map((e) => e.type);
  assert.ok(types.includes("response.reasoning_summary_part.added"), "缺 part.added");
  assert.ok(types.includes("response.reasoning_summary_text.delta"), "缺 text.delta");
  assert.ok(types.includes("response.reasoning_summary_text.done"), "缺 text.done");
  assert.ok(types.includes("response.reasoning_summary_part.done"), "缺 part.done");

  const deltas = out.filter((e) => e.type === "response.reasoning_summary_text.delta");
  assert.deepEqual(deltas.map((d) => d.delta), ["先想一下：", "9.11 比 9.9 小。"]);
  const done = out.find((e) => e.type === "response.reasoning_summary_text.done");
  assert.equal(done.text, "先想一下：9.11 比 9.9 小。");
});

test("摘要放進 reasoning 項目的 summary 欄位（Codex 顯示的是這個）", async () => {
  const out = await runStream(["想了一下"]);
  const item = out.filter((e) => e.type === "response.output_item.done")
    .map((e) => e.item).find((i) => i.type === "reasoning");
  assert.deepEqual(item.summary, [{ type: "summary_text", text: "想了一下" }]);
});

test("encrypted_content 的往返完全不受影響", async () => {
  const out = await runStream(["想了一下"]);
  const item = out.filter((e) => e.type === "response.output_item.done")
    .map((e) => e.item).find((i) => i.type === "reasoning");
  const decoded = JSON.parse(Buffer.from(item.encrypted_content, "base64").toString("utf8"));
  assert.equal(decoded.thinking, "想了一下");
  assert.equal(decoded.signature, "sig-1");
});

test("display=omitted（thinking 文字為空）時完全不送摘要事件", async () => {
  // 這是關掉摘要時的現況：thinking 區塊有來，但沒有文字。
  const out = await runStream([]);
  assert.equal(out.some((e) => String(e.type).includes("reasoning_summary")), false);
  const item = out.filter((e) => e.type === "response.output_item.done")
    .map((e) => e.item).find((i) => i.type === "reasoning");
  assert.deepEqual(item.summary, []);
  // 簽章仍然要留著，否則後續回合的 reasoning 會被上游拒收
  const decoded = JSON.parse(Buffer.from(item.encrypted_content, "base64").toString("utf8"));
  assert.equal(decoded.signature, "sig-1");
});

test("摘要事件都掛在同一個 reasoning item 上", async () => {
  const out = await runStream(["a", "b"]);
  const added = out.find((e) => e.type === "response.output_item.added");
  const summaryEvents = out.filter((e) => String(e.type).includes("reasoning_summary"));
  for (const e of summaryEvents) {
    assert.equal(e.item_id, added.item.id, e.type);
    assert.equal(e.summary_index, 0, e.type);
  }
});

test("正文仍然照常串流，沒有被摘要干擾", async () => {
  const out = await runStream(["想"]);
  const text = out.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta);
  assert.deepEqual(text, ["答案"]);
});
