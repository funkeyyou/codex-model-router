import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { loadPayloads } from "./helpers/payloads.mjs";

const { bridge, router } = await loadPayloads();

const sse = (events) => new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    ));
    controller.close();
  },
});

const meta = (compaction = false) => ({
  translate: "anthropic",
  model: "custom/claude-test",
  requestBody: {},
  freeform: new Set(),
  compaction,
});

const opening = { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } };
const ending = (reason) => [
  { type: "message_delta", delta: { stop_reason: reason } },
  { type: "message_stop" },
];
const refusal = [
  opening,
  {
    type: "message_delta",
    delta: { stop_reason: "refusal" },
    stop_details: { type: "refusal", category: "cyber", explanation: "This request was declined." },
  },
  { type: "message_stop" },
];

async function translate(events, compaction = false) {
  const output = [];
  const context = meta(compaction);
  await bridge.bridgeAnthropicStream(sse(events), (event) => output.push(event), context);
  return { output, context };
}

test("Claude 拒答轉成可見失敗，並保留上游類別與原因", async () => {
  const { output, context } = await translate(refusal);
  assert.deepEqual(output.slice(-1).map((event) => event.type), ["response.failed"]);
  assert.equal(output.filter((event) => event.type === "response.failed").length, 1);
  assert.equal(output.some((event) => event.type === "response.completed"), false);
  assert.equal(output.at(-1).response.error.code, "invalid_prompt");
  assert.match(output.at(-1).response.error.message, /cyber.*This request was declined/);
  assert.equal(context.claudeFailureKind, "refusal");
});

test("拒答發生在壓縮回合時，不生成假的 compaction 項目", async () => {
  const { output, context } = await translate(refusal, true);
  assert.equal(output.at(-1).type, "response.failed");
  assert.equal(output.some((event) => event.type === "response.output_item.done"), false);
  assert.equal(context.claudeCompactionFailed, true);
});

test("摘要為空或輸出截斷時，壓縮回合失敗且不替換歷史", async () => {
  for (const [content, reason] of [["", "end_turn"], ["部分摘要", "max_tokens"]]) {
    const events = [opening];
    if (content) events.push(
      { type: "content_block_start", content_block: { type: "text", text: "" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: content } },
      { type: "content_block_stop" },
    );
    events.push(...ending(reason));
    const { output, context } = await translate(events, true);
    assert.equal(output.at(-1).type, "response.failed", reason);
    assert.equal(output.at(-1).response.error.code, "invalid_prompt", reason);
    assert.equal(output.some((event) => event.type === "response.output_item.done"), false, reason);
    assert.equal(context.claudeCompactionFailed, true, reason);
  }
});

test("有內容的壓縮仍生成可還原的摘要", async () => {
  const { output } = await translate([
    opening,
    { type: "content_block_start", content_block: { type: "text", text: "" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "保留的摘要" } },
    { type: "content_block_stop" },
    ...ending("end_turn"),
  ], true);
  assert.equal(output.at(-1).type, "response.completed");
  assert.equal(bridge.decodeCompaction(output.at(-1).response.output[0].encrypted_content), "保留的摘要");
});

test("上游未標拒答卻回空內容時，也不再靜默完成", async () => {
  const { output, context } = await translate([opening, ...ending("end_turn")]);
  assert.equal(output.at(-1).type, "response.failed");
  assert.equal(output.at(-1).response.error.code, "invalid_prompt");
  assert.match(output.at(-1).response.error.message, /沒有產生可顯示的回答/);
  assert.equal(context.claudeFailureKind, "empty_response");
});

test("HTTP 和 WebSocket 轉譯都送出失敗，健康檢查計入拒答、空回覆及壓縮失敗", async (t) => {
  const server = router.routerServer;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const health = async () => (await fetch(`http://127.0.0.1:${server.address().port}/healthz`)).json();
  const before = (await health()).stats;

  const chunks = [];
  const response = {
    writeHead() {},
    write(value) { chunks.push(String(value)); return true; },
    end() {},
  };
  await router.bridgeTranslatedToHttp({ status: 200, body: sse(refusal) }, response, meta());
  assert.match(chunks.join(""), /"type":"response.failed"/);

  const frames = [];
  const socket = { destroyed: false, writable: true, write(value) { frames.push(Buffer.from(value)); } };
  await router.bridgeTranslatedToWebSocket({ status: 200, body: sse(refusal) }, socket, meta(true));
  const events = router.parseWebSocketFrames(Buffer.concat(frames)).frames
    .filter((frame) => frame.opcode === 1)
    .map((frame) => JSON.parse(frame.payload.toString("utf8")));
  assert.equal(events.at(-1).type, "response.failed");
  assert.equal(events.some((event) => event.type === "response.completed"), false);

  await router.bridgeTranslatedToHttp({ status: 200, body: sse([opening, ...ending("end_turn")]) }, response, meta());
  await router.bridgeTranslatedToWebSocket({ status: 200, body: sse([opening, ...ending("end_turn")]) }, socket, meta(true));

  const after = (await health()).stats;
  assert.equal(after.claudeRefusals - before.claudeRefusals, 2);
  assert.equal(after.claudeEmptyResponses - before.claudeEmptyResponses, 1);
  assert.equal(after.claudeCompactionFailures - before.claudeCompactionFailures, 2);
});
