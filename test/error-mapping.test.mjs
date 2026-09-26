// 上游錯誤要換成 Codex 認得的 error.code，Codex 才會做對的事：
//   context_length_exceeded 不重試、server_is_overloaded 重試、
//   rate_limit_exceeded 依訊息裡的「try again in Ns」等待。
// 只給狀態碼字串（"400"、"429"）或 Anthropic 的錯誤型別時，Codex 一律當一般錯誤處理。

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { bridge, router } = await loadPayloads();
const { codexErrorFromUpstream } = bridge;

test("Anthropic 錯誤型別對應到 Codex 的錯誤碼", () => {
  assert.equal(codexErrorFromUpstream({ type: "overloaded_error", message: "Overloaded" }).code, "server_is_overloaded");
  assert.equal(codexErrorFromUpstream({ type: "rate_limit_error", message: "slow" }).code, "rate_limit_exceeded");
  assert.equal(codexErrorFromUpstream({ type: "api_error", message: "boom" }).code, "api_error");
});

test("上下文爆掉一律是 context_length_exceeded，不論哪家的措辭", () => {
  for (const message of [
    "prompt is too long: 215000 tokens > 200000 maximum",
    "This model's maximum context length is 128000 tokens.",
    "Your input exceeds the context window of this model.",
  ]) {
    assert.equal(codexErrorFromUpstream({ type: "invalid_request_error", message }).code, "context_length_exceeded", message);
  }
});

test("額度用盡（含 new-api 的 insufficient_user_quota）不會被當成可重試的限流", () => {
  assert.equal(codexErrorFromUpstream({ code: "insufficient_user_quota", type: "new_api_error", message: "用戶額度不足" }, { status: 403 }).code, "insufficient_quota");
  assert.equal(codexErrorFromUpstream({ code: "insufficient_quota", message: "quota" }, { status: 429 }).code, "insufficient_quota");
});

test("已是 Codex 認得的錯誤碼就原樣保留", () => {
  assert.deepEqual(codexErrorFromUpstream({ code: "server_is_overloaded", message: "busy" }), { code: "server_is_overloaded", message: "busy" });
});

test("只有狀態碼時依狀態碼判斷，其餘保留原本的碼", () => {
  assert.equal(codexErrorFromUpstream({}, { status: 529 }).code, "server_is_overloaded");
  assert.equal(codexErrorFromUpstream({}, { status: 429 }).code, "rate_limit_exceeded");
  assert.equal(codexErrorFromUpstream({}, { status: 402 }).code, "insufficient_quota");
  assert.equal(codexErrorFromUpstream({}, { status: 500 }).code, "500");
  assert.match(codexErrorFromUpstream({}, { status: 500 }).message, /HTTP 500/);
});

test("限流時把 retry-after 寫進 Codex 會解析的「try again in Ns」", () => {
  const mapped = codexErrorFromUpstream({ type: "rate_limit_error", message: "Rate limited." }, { retryAfterSeconds: 7 });
  assert.equal(mapped.message, "Rate limited. Please try again in 7s.");
  const already = codexErrorFromUpstream({ code: "rate_limit_exceeded", message: "Please try again in 2s." }, { retryAfterSeconds: 7 });
  assert.equal(already.message, "Please try again in 2s.");
});

test("非 2xx 內文：Anthropic、OpenAI、字串與非 JSON 都解析得出來", () => {
  const anthropic = router.upstreamErrorDetails(400, JSON.stringify({
    type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 300000 tokens > 200000 maximum" },
  }));
  assert.equal(anthropic.code, "context_length_exceeded");
  assert.equal(anthropic.error.type, "invalid_request_error", "原始錯誤保留");

  const openai = router.upstreamErrorDetails(429, JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow" } }), "3");
  assert.deepEqual([openai.code, openai.message], ["rate_limit_exceeded", "slow Please try again in 3s."]);

  assert.equal(router.upstreamErrorDetails(403, JSON.stringify({ error: "禁止存取" })).message, "禁止存取");
  const html = router.upstreamErrorDetails(502, "<html>bad gateway</html>");
  assert.deepEqual([html.code, html.message], ["502", "<html>bad gateway</html>"]);
});

// --- WebSocket：非 2xx ------------------------------------------------------

function fakeSocket() {
  const written = [];
  return {
    destroyed: false, writable: true,
    write(buffer) { written.push(Buffer.from(buffer)); },
    end() {},
    get events() {
      return router.parseWebSocketFrames(Buffer.concat(written)).frames
        .filter((frame) => frame.opcode === 0x1)
        .map((frame) => JSON.parse(frame.payload.toString("utf8")));
    },
  };
}

test("WebSocket：Claude 的 prompt is too long 送出 context_length_exceeded，不再是 \"400\"", async () => {
  const socket = fakeSocket();
  const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum" } });
  await router.bridgeSseToWebSocket(new Response(body, { status: 400 }), socket);
  assert.deepEqual(socket.events.map((event) => event.type), ["error", "response.failed"]);
  assert.equal(socket.events[1].response.error.code, "context_length_exceeded");
});

test("WebSocket：429 帶 retry-after 時，Codex 會照上游要求的秒數等待", async () => {
  const socket = fakeSocket();
  const upstream = new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Too many requests." } }),
    { status: 429, headers: { "retry-after": "12" } });
  await router.bridgeSseToWebSocket(upstream, socket);
  const failure = socket.events.at(-1).response.error;
  assert.equal(failure.code, "rate_limit_exceeded");
  assert.match(failure.message, /try again in 12s/);
});

test("WebSocket：retry-after 是 HTTP 日期時同樣換算成秒數", async () => {
  const socket = fakeSocket();
  const upstream = new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Too many requests." } }),
    { status: 429, headers: { "retry-after": new Date(Date.now() + 45_000).toUTCString() } });
  await router.bridgeSseToWebSocket(upstream, socket);
  const failure = socket.events.at(-1).response.error;
  assert.equal(failure.code, "rate_limit_exceeded");
  const seconds = Number(/try again in (\d+)s/.exec(failure.message)?.[1]);
  assert.ok(seconds >= 44 && seconds <= 46, failure.message);
});

// --- HTTP：Claude 路由的非 2xx -----------------------------------------------

const headers = { authorization: "Bearer fixture", "chatgpt-account-id": "fixture-account", "session-id": "error-mapping" };
const originalFetch = globalThis.fetch;

test("HTTP：Claude 路由的錯誤改寫成 OpenAI 形狀，保留狀態碼與 retry-after", async (t) => {
  const routerInstance = await loadRouterWith({ upstreamWebSocket: false });
  routerInstance.routerServer.listen(0, "127.0.0.1");
  await once(routerInstance.routerServer, "listening");
  t.after(() => new Promise((resolve) => routerInstance.routerServer.close(resolve)));
  const oldKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = oldKey;
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    // ChatGPT 身份探測缺 client_version 時回 400，路由器視為通過。
    if (String(url).endsWith("/models")) return new Response("missing client_version", { status: 400 });
    return new Response(JSON.stringify({
      type: "error", error: { type: "overloaded_error", message: "Overloaded" },
    }), { status: 529, headers: { "content-type": "application/json", "retry-after": "5" } });
  });
  const port = routerInstance.routerServer.address().port;
  const response = await originalFetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ model: "custom/claude-test", input: "hi" }),
  });
  assert.equal(response.status, 529);
  assert.equal(response.headers.get("retry-after"), "5");
  const body = await response.json();
  assert.equal(body.error.code, "server_is_overloaded");
  assert.equal(body.error.type, "overloaded_error");
  assert.equal(body.error.message, "Overloaded");
});
