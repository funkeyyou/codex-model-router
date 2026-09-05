// 上游串流被截斷時，必須留下終止事件。
//
// 背景：代理把串流丟掉時，讀取端看到的是乾淨的 EOF，不是例外——for await 正常
// 結束、catch 接不到，而標頭當初是 200，非 2xx 的檢查也早就過了。於是三條串流
// 路徑都會在沒送出 response.completed 的情況下收工，Codex 那邊看到的就是
// 「stream disconnected before completion: websocket closed by server before
// response.completed」，等同無聲卡死。
//
// 這組測試盯的就是那個缺口：串流沒收尾時，一定要補一個 response.failed。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { router } = await loadPayloads();
const { bridgeSseToWebSocket, bridgeAnthropicToHttp, parseWebSocketFrames } = router;

const meta = () => ({
  model: "claude-test",
  requestBody: {},
  freeform: new Set(),
  historyKey: null,
});

// 上游回應：body 是一串 chunk，讀完就結束（等同 EOF）。
const upstreamOf = (chunks) => ({
  status: 200,
  body: (async function* () {
    for (const chunk of chunks) yield Buffer.from(chunk, "utf8");
  })(),
});

const sse = (event) => `data: ${JSON.stringify(event)}\n\n`;

// --- 假造的 HTTP response ---------------------------------------------------

function fakeResponse() {
  const chunks = [];
  return {
    chunks,
    ended: false,
    writeHead() {},
    write(chunk) {
      chunks.push(String(chunk));
    },
    end() {
      this.ended = true;
    },
    get text() {
      return chunks.join("");
    },
  };
}

// --- 假造的 socket ----------------------------------------------------------

function fakeSocket() {
  const written = [];
  return {
    destroyed: false,
    writable: true,
    write(buffer) {
      written.push(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
    },
    get events() {
      const frames = parseWebSocketFrames(Buffer.concat(written)).frames || [];
      return frames
        .filter((frame) => frame.opcode === 0x1)
        .map((frame) => {
          try {
            return JSON.parse(frame.payload.toString("utf8"));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    },
  };
}

// --- Anthropic 轉譯 -> HTTP -------------------------------------------------

const anthropicOpening = [
  sse({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
  sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "半句" } }),
];

test("HTTP：串流沒送 message_stop 就結束，要補 response.failed", async () => {
  const response = fakeResponse();
  await bridgeAnthropicToHttp(upstreamOf(anthropicOpening), response, meta());

  assert.match(response.text, /"type":"response\.failed"/);
  assert.match(response.text, /upstream_stream_truncated/);
  assert.ok(response.ended, "仍然要正常收尾，不能把連線晾著");
  assert.doesNotMatch(response.text, /"type":"response\.completed"/);
});

test("HTTP：串流正常收尾時不會多送 response.failed", async () => {
  const response = fakeResponse();
  await bridgeAnthropicToHttp(
    upstreamOf([
      ...anthropicOpening,
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      sse({ type: "message_stop" }),
    ]),
    response,
    meta(),
  );

  assert.match(response.text, /"type":"response\.completed"/);
  assert.doesNotMatch(response.text, /"type":"response\.failed"/);
});

// --- 非轉譯路由 -> WebSocket ------------------------------------------------

test("WebSocket：串流沒送 response.completed 就結束，要補 response.failed", async () => {
  const socket = fakeSocket();
  await bridgeSseToWebSocket(
    upstreamOf([
      sse({ type: "response.created", response: { id: "resp_1" } }),
      sse({ type: "response.output_text.delta", delta: "半句" }),
    ]),
    socket,
  );

  const types = socket.events.map((event) => event.type);
  assert.deepEqual(types.at(-1), "response.failed", `實際收到：${types.join(", ")}`);
  assert.equal(socket.events.at(-1).response.error.code, "upstream_stream_truncated");
});

test("WebSocket：上游自己送了終止事件就不補", async () => {
  for (const terminal of ["response.completed", "response.failed", "response.incomplete"]) {
    const socket = fakeSocket();
    await bridgeSseToWebSocket(
      upstreamOf([
        sse({ type: "response.created", response: { id: "resp_1" } }),
        sse({ type: terminal, response: { id: "resp_1" } }),
      ]),
      socket,
    );

    const types = socket.events.map((event) => event.type);
    assert.equal(
      types.filter((type) => type === "response.failed").length,
      terminal === "response.failed" ? 1 : 0,
      `${terminal} 之後不該再補：${types.join(", ")}`,
    );
  }
});

test("WebSocket：上游送的 error 也算收過尾", async () => {
  const socket = fakeSocket();
  await bridgeSseToWebSocket(
    upstreamOf([sse({ type: "error", error: { message: "上游炸了" } })]),
    socket,
  );

  const types = socket.events.map((event) => event.type);
  assert.deepEqual(types, ["error"], "不該在 error 後面再疊一個 response.failed");
});
