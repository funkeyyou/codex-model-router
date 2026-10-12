// 同一家供應商的多把 API Key：目前這把回 401／402／403／429 才換下一把並重送，
// 失敗的那把冷卻；其他狀態碼照原樣回給 Codex，不會亂換 Key。沒有備用 Key 時行為不變。

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { router, installer } = await loadPayloads();

test("冷卻時間：429 依 Retry-After（5 秒～15 分），402 半小時，被拒 10 分鐘", () => {
  assert.equal(router.keyCooldownMs(429, 30), 30000);
  assert.equal(router.keyCooldownMs(429, null), 60000);
  assert.equal(router.keyCooldownMs(429, 1), 5000);
  assert.equal(router.keyCooldownMs(429, 99999), 15 * 60000);
  assert.equal(router.keyCooldownMs(402), 30 * 60000);
  assert.equal(router.keyCooldownMs(401), 10 * 60000);
  assert.equal(router.keyCooldownMs(403), 10 * 60000);
  assert.deepEqual([...router.KEY_ROTATION_STATUSES].sort(), [401, 402, 403, 429]);
});

test("輪替順序：從使用中的那把開始、跳過冷卻中的；全部冷卻時依解除先後仍全部試一次", () => {
  let time = 1000;
  const rotation = router.createKeyRotation({ now: () => time });
  const ids = ["primary", "k-a", "k-b"];
  assert.deepEqual(rotation.order("p", ids), ["primary", "k-a", "k-b"]);
  rotation.fail("p", "primary", 429, 30);
  assert.deepEqual(rotation.order("p", ids), ["k-a", "k-b", "primary"]);
  rotation.succeed("p", "k-a");
  assert.equal(rotation.active("p"), "k-a");
  assert.deepEqual(rotation.order("p", ids), ["k-a", "k-b", "primary"]);
  rotation.fail("p", "k-a", 402);
  rotation.fail("p", "k-b", 401);
  assert.deepEqual(rotation.order("p", ids), ["primary", "k-b", "k-a"], "冷卻中的依解除時間排序");
  time += 31000;
  assert.deepEqual(rotation.order("p", ids), ["primary", "k-b", "k-a"], "primary 已解除冷卻");
  const snapshot = rotation.snapshot("p", ids);
  assert.equal(snapshot.keys, 3);
  assert.equal(snapshot.active, "k-a");
  assert.deepEqual(snapshot.cooling.map((item) => [item.id, item.reason]), [["k-a", "quota_exhausted"], ["k-b", "rejected"]]);
  assert.deepEqual(rotation.order("solo", ["primary"]), ["primary"]);
});

test("key-pool.json：忽略格式不對的項目、重複與保留的 primary，每家最多 5 把", () => {
  const pool = router.normalizeKeyPool({ providers: {
    default: [
      { id: "k-1", keychainService: "svc.k-1" },
      { id: "k-1", keychainService: "dup" },
      { id: "primary", keychainService: "bad" },
      { id: "Bad Id", keychainService: "bad" },
      { id: "k-2" },
      ...["k-3", "k-4", "k-5", "k-6", "k-7"].map((id) => ({ id, keychainService: `svc.${id}`, credentialPath: "C:/x.dat" })),
    ],
    other: "nope",
  } });
  assert.deepEqual([...pool.keys()], ["default"]);
  assert.deepEqual(pool.get("default").map((slot) => slot.id), ["k-1", "k-3", "k-4", "k-5", "k-6"]);
  assert.equal(pool.get("default")[0].keychainAccount, "codex");
  assert.equal(pool.get("default")[1].credentialPath, "C:/x.dat");
  const provider = { id: "default", keychainService: "svc", keychainAccount: "codex", credentialPath: null };
  assert.deepEqual(router.keySlotsFor(provider, pool).map((slot) => slot.id), ["primary", "k-1", "k-3", "k-4", "k-5", "k-6"]);
  assert.deepEqual(router.keySlotsFor({ ...provider, id: "none" }, pool).map((slot) => slot.id), ["primary"]);
  assert.deepEqual(installer.normalizeKeyPoolFile({ providers: { default: [{ id: "k-1", keychainService: "s", tail: "abcdef" }] } }),
    { version: 1, providers: { default: [{ id: "k-1", keychainService: "s", keychainAccount: "codex", credentialPath: null, tail: "cdef", addedAt: null, models: null }] },
      primaryModels: {} });
  assert.equal(installer.maskKeyTail("wxyz"), "••••wxyz");
});

test("各 Key 的模型清單：只在有這個模型的 Key 之間切換；清單未知視為支援；都不支援時退回全部", () => {
  const file = installer.normalizeKeyPoolFile({ providers: { default: [
    { id: "k-a", keychainService: "s.a", models: ["model-a", "model-b", 3, "model-b"] },
    { id: "k-b", keychainService: "s.b", models: [] },
  ], gone: [] }, primaryModels: { default: ["model-a"], gone: ["x"] } });
  assert.deepEqual(file.providers.default.map((item) => item.models), [["model-a", "model-b"], null]);
  assert.deepEqual(file.primaryModels, { default: ["model-a"] }, "沒有備用 Key 的供應商不保留主 Key 清單");
  const pool = router.normalizeKeyPool(file);
  const provider = { id: "default", keychainService: "svc" };
  const slots = router.keySlotsFor(provider, pool);
  const ids = (model) => router.keySlotsForModel(slots, model).map((slot) => slot.id);
  assert.deepEqual(ids("model-a"), ["primary", "k-a", "k-b"]);
  assert.deepEqual(ids("model-b"), ["k-a", "k-b"], "主 Key 沒有的模型不送主 Key；k-b 清單未知仍保留");
  assert.deepEqual(router.keySlotsForModel(slots.slice(0, 2), "model-z").map((slot) => slot.id), ["primary", "k-a"], "都不支援時不擋請求");
  assert.deepEqual(ids(null), ["primary", "k-a", "k-b"]);
});

const provider = { id: "default", apiRoot: "https://relay.example/v1", keychainService: "svc", keychainAccount: "codex", credentialPath: null };
const route = { pickerSlug: "custom/model-a", upstreamModel: "model-a", displayName: "api/model-a",
  providerHost: "relay.example", efforts: [], stripReasoning: true, contextWindow: null };
const authHeaders = { authorization: "Bearer fixture", "chatgpt-account-id": "fixture", "session-id": "key-rotation" };
const completed = () => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp", output: [] } })}\n\n`,
  { headers: { "content-type": "text/event-stream" } });

async function startRouter(t, pool) {
  const previousKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "main";
  t.after(() => {
    if (previousKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previousKey;
  });
  const instance = await loadRouterWith({ providers: [provider], routes: [route] });
  if (pool) writeFileSync(instance.KEY_POOL_FILE, JSON.stringify(pool));
  instance.routerServer.listen(0, "127.0.0.1");
  await once(instance.routerServer, "listening");
  t.after(() => new Promise((resolve) => instance.routerServer.close(resolve)));
  return { instance, origin: `http://127.0.0.1:${instance.routerServer.address().port}` };
}

async function send(instance) {
  const body = { model: route.pickerSlug, input: "hi", stream: true };
  const upstream = await instance.fetchModelUpstream(authHeaders, new URL("http://127.0.0.1/v1/responses"),
    body, Buffer.from(JSON.stringify(body)), undefined, {});
  await upstream.text();
  return upstream.status;
}

const pool = { providers: { default: [
  { id: "k-a", keychainService: "svc.k-a" },
  { id: "k-b", keychainService: "svc.k-b" },
] } };

test("主 Key 限流時換備用 Key 重送，之後固定用能用的那把；健康檢查列出狀態", async (t) => {
  const originalFetch = globalThis.fetch;
  const { instance, origin } = await startRouter(t, pool);
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const key = new Headers(options.headers).get("authorization");
    if (String(url).endsWith("/responses")) seen.push(key);
    if (key === "Bearer main") return new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { "retry-after": "120" } });
    if (key === "Bearer main-k-a") return new Response('{"error":{"message":"no credit"}}', { status: 402 });
    return completed();
  });
  assert.equal(await send(instance), 200);
  assert.deepEqual(seen, ["Bearer main", "Bearer main-k-a", "Bearer main-k-b"]);
  seen.length = 0;
  assert.equal(await send(instance), 200);
  assert.deepEqual(seen, ["Bearer main-k-b"], "換到能用的那把後就固定用它");
  const health = await originalFetch(`${origin}/healthz`).then((response) => response.json());
  assert.equal(health.keyPools.default.keys, 3);
  assert.equal(health.keyPools.default.active, "k-b");
  assert.deepEqual(health.keyPools.default.cooling.map((item) => [item.id, item.status]), [["primary", 429], ["k-a", 402]]);
  assert.equal(health.stats.keyRotations, 2);
  assert.deepEqual({ ...health.stats.lastKeyRotation, at: undefined },
    { at: undefined, provider: "default", from: "k-a", to: "k-b", status: 402 });
  assert.equal(JSON.stringify(health).includes("main-k"), false, "健康檢查不能出現 Key 本身");
});

test("全部 Key 都失敗時回最後一把的上游錯誤；400／500 不換 Key", async (t) => {
  const { instance } = await startRouter(t, pool);
  const seen = [];
  let mode = "all-429";
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (!String(url).startsWith("https://relay.example/")) return Response.json({ models: [] });
    seen.push(new Headers(options.headers).get("authorization"));
    if (mode === "all-429") return new Response('{"error":{"message":"busy"}}', { status: 429 });
    return new Response('{"error":{"message":"bad request"}}', { status: mode === "400" ? 400 : 500 });
  });
  assert.equal(await send(instance), 429);
  assert.deepEqual(seen, ["Bearer main", "Bearer main-k-a", "Bearer main-k-b"]);
  for (const status of ["400", "500"]) {
    mode = status;
    seen.length = 0;
    assert.equal(await send(instance), Number(status));
    assert.equal(seen.length, 1, `HTTP ${status} 不應該換 Key`);
  }
});

test("主 Key 沒有的模型直接用有它的備用 Key；換到備用 Key 後，主 Key 才有的模型仍送主 Key", async (t) => {
  const { instance, origin } = await startRouter(t, { providers: { default: [
    { id: "k-a", keychainService: "svc.k-a", models: ["model-a", "model-b"] },
  ] }, primaryModels: { default: ["model-c"] } });
  const originalFetch = globalThis.fetch;
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (String(url).endsWith("/responses")) seen.push(new Headers(options.headers).get("authorization"));
    return completed();
  });
  assert.equal(await send(instance), 200);
  assert.deepEqual(seen, ["Bearer main-k-a"], "model-a 只在備用 Key 上，不先打主 Key");
  const health = await originalFetch(`${origin}/healthz`).then((response) => response.json());
  assert.equal(health.stats.keyModelRoutes, 1);
  assert.equal(health.stats.keyRotations, 0, "不是失敗換 Key");
});


test("沒有備用 Key 時與以前相同：只送一次，Key 沒變不重送", async (t) => {
  const { instance, origin } = await startRouter(t, null);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (!String(url).startsWith("https://relay.example/")) return Response.json({ models: [] });
    calls += 1;
    return new Response('{"error":{"message":"invalid key"}}', { status: 401 });
  });
  assert.equal(await send(instance), 401);
  assert.equal(calls, 1);
  t.mock.restoreAll();
  const health = await originalFetch(`${origin}/healthz`).then((response) => response.json());
  assert.deepEqual(health.keyPools, {});
});

test("一次貼多把備用 Key：換行、逗號、空白分隔，去掉空白與重複", () => {
  assert.deepEqual(installer.parseBackupKeys("sk-a\nsk-b, sk-c，sk-a ;sk-d\n\n"), ["sk-a", "sk-b", "sk-c", "sk-d"]);
  assert.deepEqual(installer.parseBackupKeys(["sk-a", " sk-b ", "", "sk-a"]), ["sk-a", "sk-b"]);
  assert.deepEqual(installer.parseBackupKeys(undefined), []);
});

test("診斷包遮蔽：Key、權杖、JWT、電子郵件與家目錄", () => {
  const text = [
    "Authorization: Bearer abcdefghijklmnop", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    '{"apiKey":"supersecretvalue","api_key": "another-secret-1"}',
    String.raw`{\"x-api-key\":\"escapedsecret123\"}`,
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl",
    "mail me at someone@example.com", "/Users/alice/.codex/model-router/router.mjs", "/home/bob/x",
    "C:\\Users\\carol\\AppData", "/opt/me/data/file", "custom/anthropic-claude-haiku-5-5-249e78f5",
    "a".repeat(45),
  ].join("\n");
  const result = installer.redactDiagnosticText(text, { home: "/opt/me" });
  for (const secret of ["abcdefghijklmnop", "abcdefghijklmnopqrstuvwxyz", "supersecretvalue", "another-secret-1", "escapedsecret123",
    "c2lnbmF0dXJl", "someone@example.com", "alice", "bob", "carol", "/opt/me", "a".repeat(45)]) {
    assert.equal(result.includes(secret), false, `沒有遮蔽：${secret}`);
  }
  assert.match(result, /~\/data\/file/);
  assert.match(result, /custom\/anthropic-claude-haiku-5-5-249e78f5/, "模型 ID 要保留");
  const json = JSON.stringify({ log: ['{"apiKey":"zzzzzzzzzz","path":"/Users/dave/x"}'] });
  const parsed = JSON.parse(installer.redactDiagnosticText(json, { home: "/nowhere" }));
  assert.equal(parsed.log[0].includes("zzzzzzzzzz"), false);
  assert.equal(parsed.log[0].includes("dave"), false);
  assert.match(installer.diagnosticFileName(new Date("2026-10-12T03:04:05.678Z")), /^codex-model-router-diagnostics-20261012-030405\.json$/);
});
