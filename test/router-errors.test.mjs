import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { loadRouterWith } from "./helpers/payloads.mjs";

const headers = { authorization: "Bearer fixture", "chatgpt-account-id": "fixture-account", "session-id": "http-test" };
const originalFetch = globalThis.fetch;

async function serve(t, settings = {}) {
  const router = await loadRouterWith({ upstreamWebSocket: false, ...settings });
  const sockets = new Set();
  router.routerServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  router.routerServer.listen(0, "127.0.0.1");
  await once(router.routerServer, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => router.routerServer.close(resolve));
  });
  const origin = `http://127.0.0.1:${router.routerServer.address().port}`;
  return { router, origin, post: (body) => originalFetch(`${origin}/v1/responses`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
  }) };
}

test("HTTP 未配置的 custom 模型回 404，完全不接觸上游", async (t) => {
  const { post } = await serve(t);
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("未知自訂模型不能送往任何上游"));
  const response = await post({ model: "custom/missing", input: "hi" });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "custom_model_not_configured");
  assert.equal(fetch.mock.callCount(), 0);
});

test("WebSocket 未配置的 custom 模型也送出 response.failed，不嘗試官方握手", { timeout: 5000 }, async (t) => {
  const { origin } = await serve(t, { upstreamWebSocket: true });
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("不能發送上游 HTTP 請求"));
  const ws = new WebSocket(origin.replace("http:", "ws:") + "/v1/responses");
  const events = [];
  const failed = new Promise((resolve) => ws.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    events.push(event);
    if (event.type === "response.failed") resolve(event);
  }));
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "response.create", model: "custom/missing", input: [] }));
  const result = await failed;
  assert.equal(result.response.error.code, "custom_model_not_configured");
  assert.deepEqual(events.map((event) => event.type), ["error", "response.failed"]);
  assert.equal(fetch.mock.callCount(), 0);
  ws.close();
  await once(ws, "close");
});

for (const [causeCode, status, expected] of [
  ["ENOTFOUND", 502, "upstream_dns_error"],
  ["EAI_AGAIN", 502, "upstream_dns_error"],
  ["CERT_HAS_EXPIRED", 502, "upstream_tls_error"],
  ["ECONNREFUSED", 502, "upstream_connection_error"],
  ["UND_ERR_HEADERS_TIMEOUT", 504, "upstream_timeout"],
]) {
  test(`身份探測遇到 ${causeCode} 回 ${status}，不誤報 401 或洩漏例外內的敏感資料`, async (t) => {
    const { post, router } = await serve(t);
    t.mock.method(globalThis, "fetch", async () => {
      throw new TypeError("fetch failed with secret-fixture", {
        cause: Object.assign(new Error("private-prompt-fixture"), { code: causeCode }),
      });
    });
    const response = await post({ model: "custom/claude-test", input: "private-prompt-fixture" });
    const body = await response.json();
    assert.equal(response.status, status);
    assert.equal(body.error.code, expected);
    assert.match(body.error.request_id, /^[a-f0-9]{16}$/);
    assert.doesNotMatch(JSON.stringify(body), /secret-fixture|private-prompt-fixture/);
    assert.equal(router.hasValidatedAuth(headers), false);
    const health = await originalFetch(`http://127.0.0.1:${router.routerServer.address().port}/healthz`).then((r) => r.json());
    assert.equal(health.stats.lastError.causeCode, causeCode);
    assert.equal(health.stats.lastError.phase, "auth_probe");
    assert.equal(health.stats.lastError.requestId, body.error.request_id);
    assert.doesNotMatch(JSON.stringify(health), /secret-fixture|private-prompt-fixture|Bearer fixture/);
  });
}

for (const status of [401, 403, 429, 503]) {
  test(`身份探測 HTTP ${status} 分類正確，失敗結果不會被快取為通過`, async (t) => {
    const { post, router } = await serve(t);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("upstream failure", { status }); });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await post({ model: "custom/claude-test", input: [] });
      assert.equal(response.status, status);
      const body = await response.json();
      assert.equal(body.error.code, status === 401 || status === 403 ? "chatgpt_auth_rejected" : "auth_probe_unavailable");
    }
    assert.equal(calls, 2);
    assert.equal(router.hasValidatedAuth(headers), false);
  });
}

test("400 相容性驗證仍可使用，官方與自訂路由維持分流且使用上游原名", async (t) => {
  const { post } = await serve(t, { routes: [{ pickerSlug: "custom/gpt-test", upstreamModel: "gpt-test", displayName: "api/gpt-test", efforts: [] }] });
  const oldKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = oldKey;
  });
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    sent.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith("/models")) return new Response("missing client_version", { status: 400 });
    return Response.json({ id: "resp_ok", object: "response", status: "completed", output: [] });
  });
  assert.equal((await post({ model: "custom/gpt-test", input: [] })).status, 200);
  assert.equal((await post({ model: "official-test", input: [] })).status, 200);
  assert.deepEqual(sent.map((request) => [request.url, request.body?.model]), [
    ["https://chatgpt.example/backend-api/codex/models", undefined],
    ["https://gateway.example/v1/responses", "gpt-test"],
    ["https://chatgpt.example/backend-api/codex/responses", "official-test"],
  ]);
});

test("HTTP Responses 的 SSE 也保存成功快照，502 重試不丟工具呼叫或重複工具結果", async (t) => {
  const { post } = await serve(t);
  const sent = [];
  const tool = { type: "function_call", call_id: "call_http", name: "lookup", arguments: "{}" };
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    sent.push(JSON.parse(options.body));
    if (sent.length === 2) return new Response("temporary", { status: 502 });
    const event = { type: "response.completed", response: { id: "resp_http", status: "completed", output: [tool] } };
    return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  await (await post({ model: "official-test", input: [{ role: "user", content: "test" }] })).text();
  const next = { model: "official-test", previous_response_id: "resp_http", input: [{ type: "function_call_output", call_id: "call_http", output: "result" }] };
  assert.equal((await post(next)).status, 502);
  assert.equal((await post(next)).status, 200);
  assert.deepEqual(sent[2].input, sent[1].input);
  assert.deepEqual(sent[2].input[1], tool);
});

test("AggregateError 與 TimeoutError 會解析內層網路原因", async () => {
  const router = await loadRouterWith({});
  const error = new TypeError("fetch failed", { cause: new AggregateError([Object.assign(new Error(), { code: "ECONNREFUSED" })]) });
  assert.equal(router.describeRouterError(error).code, "upstream_connection_error");
  assert.equal(router.describeRouterError(new DOMException("timeout", "TimeoutError")).status, 504);
});
