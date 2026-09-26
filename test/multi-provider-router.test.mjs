// 同時使用多家中轉供應商：路由器這一側。
//
// 每條路由送到自己那一家、用自己那一家的 Key；找不到供應商時寧可報錯，
// 也不改送別家——那會拿另一個帳號的 Key 去計費。舊版只有一家、欄位放在頂層的
// 設定照樣要能讀。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { router, imagegen } = await loadPayloads();

const providerA = {
  id: "default", apiRoot: "https://relay-a.example/v1", keychainService: "svc.a",
  keychainAccount: "codex", credentialPath: null,
};
const providerB = {
  id: "openrouter", apiRoot: "https://openrouter.example/api/v1", keychainService: "svc.b",
  keychainAccount: "codex", credentialPath: null,
};

test("路由器讀舊版設定得到一家 default；新版設定照 providers 的順序", () => {
  assert.deepEqual(router.normalizeProviders({ apiRoot: "https://a.example/v1/", keychainService: "s" }), [
    { id: "default", apiRoot: "https://a.example/v1", keychainService: "s", keychainAccount: "codex", credentialPath: null },
  ]);
  assert.deepEqual(
    router.normalizeProviders({ providers: [providerA, providerB], apiRoot: "https://stale.example" })
      .map((provider) => provider.id),
    ["default", "openrouter"],
  );
  assert.deepEqual(router.normalizeProviders({}), []);
});

test("路由找不到自己的供應商時報錯，不改送其他家", () => {
  const registry = new Map([[providerA.id, providerA]]);
  assert.equal(router.providerForRoute({ pickerSlug: "custom/x" }, registry), providerA);
  assert.throws(() => router.providerForRoute({ providerId: "gone" }, registry),
    (error) => error.code === "provider_not_configured" && error.status === 500);
});

test("生圖：沒指定供應商用主要供應商；指定不存在的供應商直接拒絕", () => {
  const registry = new Map([[providerA.id, providerA], [providerB.id, providerB]]);
  assert.equal(router.imageProviderFor({}, registry, providerA), providerA);
  assert.equal(router.imageProviderFor({ [router.PROVIDER_HEADER]: "openrouter" }, registry, providerA), providerB);
  assert.throws(() => router.imageProviderFor({ [router.PROVIDER_HEADER]: "gone" }, registry, providerA),
    (error) => error.status === 400 && error.code === "unknown_provider");
  assert.equal(router.PROVIDER_HEADER, imagegen.PROVIDER_HEADER, "生圖命令與路由器要用同一個標頭");
});

const routeA = {
  pickerSlug: "custom/model-a", upstreamModel: "model-a", displayName: "api/model-a",
  providerHost: "relay-a.example", efforts: [], stripReasoning: true, contextWindow: null,
};
const routeB = { ...routeA, pickerSlug: "custom/openrouter-model-b", upstreamModel: "model-b",
  displayName: "openrouter/model-b", providerHost: "openrouter.example", providerId: "openrouter" };
const authHeaders = { authorization: "Bearer fixture", "chatgpt-account-id": "fixture", "session-id": "multi-provider" };

async function startRouter(t, overrides) {
  const instance = await loadRouterWith({ providers: [providerA, providerB], routes: [routeA, routeB], ...overrides });
  instance.routerServer.listen(0, "127.0.0.1");
  await once(instance.routerServer, "listening");
  t.after(() => new Promise((resolve) => instance.routerServer.close(resolve)));
  return { instance, origin: `http://127.0.0.1:${instance.routerServer.address().port}` };
}

// 不碰鑰匙圈／DPAPI 的測試一律用固定的測試 Key（每家都一樣）；
// 各家各自的 Key 由最後的 Windows 測試用真的 DPAPI 密文驗證。
function useTestKey(t) {
  const previousKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previousKey;
  });
}

function recordUpstream(t) {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const href = String(url);
    seen.push({ href, authorization: new Headers(options.headers).get("authorization") });
    if (href.includes("/images/")) return Response.json({ data: [] });
    if (href.endsWith("/models")) return Response.json({ models: [] });
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp", output: [] } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } });
  });
  return seen;
}

test("每條路由送到自己那一家；健康檢查列出各家與模型數", async (t) => {
  useTestKey(t);
  const originalFetch = globalThis.fetch;
  const { instance, origin } = await startRouter(t);
  const seen = recordUpstream(t);
  for (const route of [routeA, routeB]) {
    const body = { model: route.pickerSlug, input: "hi", stream: true };
    const upstream = await instance.fetchModelUpstream(authHeaders, new URL("http://127.0.0.1/v1/responses"),
      body, Buffer.from(JSON.stringify(body)), undefined, {});
    await upstream.text();
  }
  const upstreamCalls = seen.filter((call) => call.href.endsWith("/responses")).map((call) => call.href);
  assert.deepEqual(upstreamCalls, [
    "https://relay-a.example/v1/responses",
    "https://openrouter.example/api/v1/responses",
  ]);
  const health = await originalFetch(`${origin}/healthz`).then((response) => response.json());
  assert.deepEqual(health.providers, [
    { id: "default", host: "relay-a.example", routes: 1 },
    { id: "openrouter", host: "openrouter.example", routes: 1 },
  ]);
  assert.equal(health.stats.lastProvider, "openrouter");
});

test("生圖端點依標頭選供應商；不存在的供應商回 400，不送到任何上游", async (t) => {
  useTestKey(t);
  const originalFetch = globalThis.fetch;
  const { origin } = await startRouter(t);
  const seen = recordUpstream(t);
  const post = (headers = {}) => originalFetch(`${origin}/v1/images/generations`, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "gpt-image-2", prompt: "cat" }),
  });
  assert.equal((await post()).status, 200);
  assert.equal((await post({ [router.PROVIDER_HEADER]: "openrouter" })).status, 200);
  const rejected = await post({ [router.PROVIDER_HEADER]: "gone" });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, "unknown_provider");
  const { stats } = await originalFetch(`${origin}/healthz`).then((response) => response.json());
  assert.equal(stats.lastError.code, "unknown_provider");
  assert.equal(stats.lastError.provider, undefined, "沒選到供應商，不能記成主要供應商");
  assert.equal(stats.lastError.upstreamHost, null);
  assert.deepEqual(seen.map((call) => call.href), [
    "https://relay-a.example/v1/images/generations",
    "https://openrouter.example/api/v1/images/generations",
  ]);
});

test("路由指向不存在的供應商時回錯誤，不改送主要供應商", async (t) => {
  useTestKey(t);
  const instance = await loadRouterWith({ providers: [providerA], routes: [routeA, routeB] });
  const seen = recordUpstream(t);
  const body = { model: routeB.pickerSlug, input: "hi", stream: true };
  await assert.rejects(
    instance.fetchModelUpstream(authHeaders, new URL("http://127.0.0.1/v1/responses"), body,
      Buffer.from(JSON.stringify(body)), undefined, {}),
    (error) => error.code === "provider_not_configured",
  );
  assert.deepEqual(seen, []);
});

// --- Windows：每家各自解自己的 DPAPI 密文 ------------------------------------

const onWindows = process.platform === "win32";

function writeDpapiCredential(service, secret) {
  const credentialPath = join(mkdtempSync(join(tmpdir(), "router-provider-credential-")), "credential.dat");
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const script = [
    "Add-Type -AssemblyName System.Security",
    `$bytes = [Text.Encoding]::UTF8.GetBytes(${quote(secret)})`,
    `$entropy = [Text.Encoding]::UTF8.GetBytes(${quote(service)})`,
    "$blob = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    `[IO.File]::WriteAllText(${quote(credentialPath)}, [Convert]::ToBase64String($blob))`,
  ].join("\n");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
  return credentialPath;
}

test("Windows：每家用自己的 Key，各自快取", { skip: !onWindows, timeout: 60000 }, async (t) => {
  const previousKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  t.after(() => { if (previousKey !== undefined) process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previousKey; });
  const originalFetch = globalThis.fetch;
  const { origin } = await startRouter(t, { providers: [
    { ...providerA, credentialPath: writeDpapiCredential(providerA.keychainService, "sk-provider-a") },
    { ...providerB, credentialPath: writeDpapiCredential(providerB.keychainService, "sk-provider-b") },
  ] });
  const seen = recordUpstream(t);
  const post = (headers = {}) => originalFetch(`${origin}/v1/images/generations`, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "gpt-image-2", prompt: "cat" }),
  }).then((response) => response.json());
  for (let round = 0; round < 2; round += 1) {
    await post();
    await post({ [router.PROVIDER_HEADER]: "openrouter" });
  }
  assert.deepEqual(seen.map((call) => call.authorization), [
    "Bearer sk-provider-a", "Bearer sk-provider-b", "Bearer sk-provider-a", "Bearer sk-provider-b",
  ]);
  const health = await originalFetch(`${origin}/healthz`).then((response) => response.json());
  assert.equal(health.stats.credentialReads, 2, "兩家各解密一次，之後都用快取");
});
