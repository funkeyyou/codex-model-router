// API Key 模式：ChatGPT 帳號額度用完時，桌面版會鎖住本機任務的發送按鈕（不分模型）。
// 安裝器把 Codex 暫時切成本機 API Key 登入；路由器只認這把 Key 的 SHA-256，
// 第三方模型照常轉送、官方模型與官方直通端點在本機擋下，Key 絕不送往 chatgpt.com。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadPayloads, loadRouterInDir } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
const localKey = "sk-codex-router-quota-" + "ab".repeat(24);
const digest = createHash("sha256").update(localKey).digest("hex");
const customRoute = {
  pickerSlug: "custom/owo-gpt", upstreamModel: "gpt-6.1-sol", displayName: "owo/gpt-6.1-sol",
  providerHost: "gateway.example", efforts: ["low", "medium", "high"], stripReasoning: false, contextWindow: null,
};

function useTestKey(t) {
  const previous = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-provider-key";
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previous;
  });
}

async function startRouter(t) {
  const { dir, router } = await loadRouterInDir({ upstreamWebSocket: false, routes: [customRoute] });
  router.routerServer.listen(0, "127.0.0.1");
  await once(router.routerServer, "listening");
  t.after(() => new Promise((resolve) => router.routerServer.close(resolve)));
  const origin = `http://127.0.0.1:${router.routerServer.address().port}`;
  const quotaPath = join(dir, "quota-mode.json");
  return {
    origin, router,
    enable: () => writeFileSync(quotaPath, JSON.stringify({ enabled: true, keySha256: digest, enabledAt: new Date().toISOString() })),
    disable: () => rmSync(quotaPath, { force: true }),
  };
}

function mockFetch(t) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, authorization: new Headers(options.headers).get("authorization") });
    if (href.startsWith("https://chatgpt.example")) return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ id: "resp_1", object: "response", status: "completed", output: [], model: "gpt-6.1-sol" }),
      { headers: { "content-type": "application/json" } });
  });
  return calls;
}

test("API Key 模式：本機 Key 放行第三方模型，官方模型與官方直通在本機擋下，Key 不外送", async (t) => {
  useTestKey(t);
  const { origin, enable } = await startRouter(t);
  enable();
  const realFetch = globalThis.fetch;
  const calls = mockFetch(t);
  const send = (path, body) => realFetch(origin + path, {
    method: "POST", headers: { authorization: `Bearer ${localKey}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });

  const custom = await send("/v1/responses", { model: "custom/owo-gpt", input: "hi", stream: false });
  assert.equal(custom.status, 200, await custom.clone().text());
  const upstream = calls.filter((call) => call.href.startsWith("https://gateway.example"));
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0].authorization, "Bearer fixture-provider-key");

  const official = await send("/v1/responses", { model: "gpt-6.1-sol", input: "hi", stream: false });
  // 以 response.failed + invalid_prompt 回應：Codex 直接顯示訊息，不會重試五次。
  assert.equal(official.status, 200);
  const failed = JSON.parse(/^data: (.*)$/m.exec(await official.text())[1]);
  assert.equal(failed.type, "response.failed");
  assert.equal(failed.response.error.code, "invalid_prompt");
  assert.match(failed.response.error.message, /API Key 模式/);

  const passthrough = await send("/v1/alpha/search", { q: "x" });
  assert.equal(passthrough.status, 403);
  assert.equal((await passthrough.json()).error.code, "quota_mode_official_unavailable");

  // 本機 Key 從未送往官方後端（包括身份探測）。
  assert.ok(calls.every((call) => !call.href.startsWith("https://chatgpt.example")));
  assert.ok(calls.every((call) => call.authorization !== `Bearer ${localKey}`));
});

test("沒有開啟模式時，同一把 Key 不被當成已驗證的呼叫端", async (t) => {
  useTestKey(t);
  const { origin } = await startRouter(t);
  const realFetch = globalThis.fetch;
  const calls = mockFetch(t);
  const response = await realFetch(origin + "/v1/responses", {
    method: "POST", headers: { authorization: `Bearer ${localKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "custom/owo-gpt", input: "hi", stream: false }),
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "chatgpt_auth_required");
  assert.equal(calls.filter((call) => call.href.startsWith("https://gateway.example")).length, 0);
});

test("關閉模式（刪除 quota-mode.json）後立即生效，不必重新啟動路由器", async (t) => {
  useTestKey(t);
  const { origin, enable, disable } = await startRouter(t);
  const realFetch = globalThis.fetch;
  mockFetch(t);
  const send = () => realFetch(origin + "/v1/responses", {
    method: "POST", headers: { authorization: `Bearer ${localKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "custom/owo-gpt", input: "hi", stream: false }),
  });
  enable();
  assert.equal((await send()).status, 200);
  disable();
  assert.equal((await send()).status, 401);
});

test("其他 Key 即使開啟模式也不能冒用", async (t) => {
  useTestKey(t);
  const { router, enable } = await startRouter(t);
  enable();
  assert.equal(router.isQuotaModeRequest({ authorization: `Bearer ${localKey}` }), true);
  assert.equal(router.isQuotaModeRequest({ authorization: "Bearer sk-other" }), false);
  assert.equal(router.isQuotaModeRequest({}), false);
});

test("換成新的本機 Key 時大小與修改時間都沒變，也會讀到新狀態", async (t) => {
  useTestKey(t);
  const { dir, router } = await loadRouterInDir({ upstreamWebSocket: false, routes: [customRoute] });
  const quotaPath = join(dir, "quota-mode.json");
  t.after(() => rmSync(quotaPath, { force: true }));
  const nextKey = "sk-codex-router-quota-" + "cd".repeat(24);
  const nextDigest = createHash("sha256").update(nextKey).digest("hex");
  const before = JSON.stringify({ enabled: true, keySha256: digest });
  const after = JSON.stringify({ enabled: true, keySha256: nextDigest });
  assert.equal(before.length, after.length);
  writeFileSync(quotaPath, before);
  const { atime, mtime } = statSync(quotaPath);
  assert.equal(router.isQuotaModeRequest({ authorization: `Bearer ${localKey}` }), true);
  writeFileSync(quotaPath, after);
  utimesSync(quotaPath, atime, mtime);
  assert.equal(router.isQuotaModeRequest({ authorization: `Bearer ${localKey}` }), false);
  assert.equal(router.isQuotaModeRequest({ authorization: `Bearer ${nextKey}` }), true);
});

test("classifyCodexAuth 區分 ChatGPT 登入、本工具的本機 Key 與使用者自己的 API Key", () => {
  const chatgpt = { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { refresh_token: "r", access_token: "a" } };
  assert.equal(installer.classifyCodexAuth(chatgpt, digest), "chatgpt");
  assert.equal(installer.classifyCodexAuth(installer.quotaModeAuthFile(localKey), digest), "quota");
  assert.equal(installer.classifyCodexAuth(installer.quotaModeAuthFile(localKey), null), "apikey");
  assert.equal(installer.classifyCodexAuth({ auth_mode: "apikey", OPENAI_API_KEY: "sk-user" }, digest), "apikey");
  assert.equal(installer.classifyCodexAuth(null), "none");
  assert.equal(installer.quotaKeyDigest(localKey), digest);
  assert.deepEqual(installer.quotaModeAuthFile(localKey), { auth_mode: "apikey", OPENAI_API_KEY: localKey, tokens: null, last_refresh: null });
});
