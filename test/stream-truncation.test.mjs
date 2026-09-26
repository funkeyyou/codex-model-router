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
const { bridgeSseToWebSocket, bridgeTranslatedToHttp, parseWebSocketFrames } = router;

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
      return true; // 沒有背壓，streamUpstream 不必等 drain
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
  await bridgeTranslatedToHttp(upstreamOf(anthropicOpening), response, meta());

  assert.match(response.text, /"type":"response\.failed"/);
  assert.match(response.text, /upstream_stream_truncated/);
  assert.ok(response.ended, "仍然要正常收尾，不能把連線晾著");
  assert.doesNotMatch(response.text, /"type":"response\.completed"/);
});

test("HTTP：串流正常收尾時不會多送 response.failed", async () => {
  const response = fakeResponse();
  await bridgeTranslatedToHttp(
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

// Codex 會忽略頂層 error（只認 completed／incomplete／failed），只送 error 就收工的話，
// WebSocket 上要空等 300 秒閒置逾時才重試。錯誤內容要轉成 response.failed 補上。
test("WebSocket：上游只送 error 就結束時，改用它的內容補 response.failed", async () => {
  const socket = fakeSocket();
  await bridgeSseToWebSocket(
    upstreamOf([sse({ type: "error", code: "server_is_overloaded", message: "上游過載" })]),
    socket,
  );

  const types = socket.events.map((event) => event.type);
  assert.deepEqual(types, ["error", "response.failed"]);
  assert.deepEqual(socket.events.at(-1).response.error, { code: "server_is_overloaded", message: "上游過載" });
});

test("WebSocket：包一層的 error 事件也會換成 Codex 認得的錯誤碼", async () => {
  const socket = fakeSocket();
  await bridgeSseToWebSocket(
    upstreamOf([sse({ type: "error", status: 429, error: { type: "rate_limit_error", message: "slow down" } })]),
    socket,
  );
  assert.equal(socket.events.at(-1).response.error.code, "rate_limit_exceeded");
});

test("WebSocket：error 之後上游自己送了 response.failed 就不再補", async () => {
  const socket = fakeSocket();
  await bridgeSseToWebSocket(
    upstreamOf([
      sse({ type: "error", code: "server_is_overloaded", message: "上游過載" }),
      sse({ type: "response.failed", response: { id: "resp_1", error: { code: "server_is_overloaded" } } }),
    ]),
    socket,
  );
  const types = socket.events.map((event) => event.type);
  assert.deepEqual(types, ["error", "response.failed"]);
});

// --- 官方 WebSocket 直連 ------------------------------------------------------
//
// 這條路徑沒有 EOF 可等：上游連線要留給下一輪用，error 本身就是這一輪的終點。
// 官方上游的 error 帶 HTTP status，Codex 會自己處理（例如顯示用量上限與重置時間），
// 所以要原樣先送；沒帶 status 的會被 Codex 忽略，後面一定要有 response.failed。

async function officialTurn(events) {
  const received = [];
  const session = {
    responseIds: new Set(),
    send() { queueMicrotask(() => { for (const event of events) this.onEvent?.(event); }); },
  };
  const outcome = await router.runUpstreamWebSocketTurn(session, { model: "gpt-test" }, {
    onEvent: (event) => received.push(event),
  });
  return { outcome, received };
}

test("官方 WebSocket：上游只送不帶 status 的 error，也要補 response.failed", async () => {
  const { outcome, received } = await officialTurn([
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.in_progress", response: { id: "resp_1" } },
    { type: "error", error: { type: "server_error", code: "server_is_overloaded", message: "上游過載" } },
  ]);
  assert.equal(outcome.ok, true);
  assert.deepEqual(received.map((event) => event.type), ["response.created", "response.in_progress", "error", "response.failed"]);
  assert.deepEqual(received.at(-1).response.error, { code: "server_is_overloaded", message: "上游過載" });
});

test("官方 WebSocket：帶 status 的 error 原樣先送，Codex 才看得到用量上限的細節", async () => {
  const usageLimit = {
    type: "error", status: 429,
    error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_at: 1738888888 },
    headers: { "x-codex-primary-used-percent": "100.0" },
  };
  const { received } = await officialTurn([usageLimit]);
  assert.deepEqual(received[0], usageLimit);
  assert.deepEqual(received.map((event) => event.type), ["error", "response.failed"]);
});

test("HTTP：上游只送 error 就結束時同樣補 response.failed，而不是當成截斷", async () => {
  const response = fakeResponse();
  const upstream = { ...upstreamOf([sse({ type: "error", code: "server_is_overloaded", message: "上游過載" })]),
    ok: true, headers: new Headers({ "content-type": "text/event-stream" }) };
  await router.streamUpstream(upstream, response, null, true);
  assert.match(response.text, /"type":"response\.failed"/);
  assert.match(response.text, /"code":"server_is_overloaded"/);
  assert.doesNotMatch(response.text, /upstream_stream_truncated/);
});

// Anthropic 串流中途出錯（最常見是 overloaded_error）會送 event: error 後結束。
const anthropicMidStreamError = [
  ...anthropicOpening,
  sse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
];

test("Claude 轉譯（HTTP）：串流中途的 overloaded_error 變成可重試的 response.failed", async () => {
  const response = fakeResponse();
  await bridgeTranslatedToHttp(upstreamOf(anthropicMidStreamError), response, meta());
  const events = response.text.split("\n").filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(events.map((event) => event.type).slice(-1), ["response.failed"]);
  assert.equal(events.at(-1).response.error.code, "server_is_overloaded");
  assert.equal(events.filter((event) => event.type === "error").length, 0, "頂層 error 會被 Codex 忽略，不必送");
  assert.doesNotMatch(response.text, /upstream_stream_truncated/);
});

test("Claude 轉譯（WebSocket）：串流中途出錯也立刻送出 response.failed", async () => {
  const socket = fakeSocket();
  await router.bridgeTranslatedToWebSocket(upstreamOf(anthropicMidStreamError), socket, meta());
  const events = socket.events;
  assert.equal(events.at(-1).type, "response.failed");
  assert.equal(events.at(-1).response.error.code, "server_is_overloaded");
  assert.equal(events.filter((event) => event.type === "response.failed").length, 1);
});
