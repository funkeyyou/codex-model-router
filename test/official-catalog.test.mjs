import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { router, installer } = await loadPayloads();
const model = (slug, visibility = "list") => ({ slug, display_name: slug, visibility,
  supported_reasoning_levels: [{ effort: "medium", description: "Medium" }], priority: 1 });
const custom = { ...model("custom/claude"), display_name: "手動名稱", context_window: 1000000,
  extra_capability: { untouched: true }, priority: 5 };
const original = { models: [model("old"), model("hidden", "hide"), custom] };
const fresh = () => ({ models: [model("gpt-6-sol"), model("gpt-6-luna"), model("hidden", "hide")] });
const headers = { authorization: "Bearer fixture", "chatgpt-account-id": "account-a" };
const query = new URLSearchParams("client_version=0.155.0");
const ok = (catalog = fresh()) => new Response(JSON.stringify(catalog));
async function fixture(overrides = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "router-official-catalog-")), "models.json");
  writeFileSync(path, JSON.stringify(original));
  return { path, r: await loadRouterWith({ catalogPath: path, ...overrides }) };
}

test("最新官方模型與能力合併，自訂模型的手動名稱及探測欄位保留", () => {
  const merged = router.mergeOfficialCatalog(fresh(), original, ["hidden"]);
  assert.deepEqual(merged.models.map(m => m.slug), ["gpt-6-sol", "gpt-6-luna", "hidden", "custom/claude"]);
  assert.equal(merged.models[2].visibility, "list");
  const { priority, ...actual } = merged.models[3];
  const { priority: ignored, ...expected } = custom;
  assert.deepEqual(actual, expected);
  assert.equal(original.models[1].visibility, "hide");
});

test("只保留明確強制顯示但官方未列出的舊模型，不補回其他已撤下模型", () => {
  const merged = router.mergeOfficialCatalog({ models: [model("gpt-6-sol")] }, original, ["hidden"]);
  assert.deepEqual(merged.models.map(m => m.slug), ["gpt-6-sol", "hidden", "custom/claude"]);
  assert.equal(merged.models[1].visibility, "list");
});

for (const invalid of [null, {}, { models: [] }, { models: [model("x"), model("x")] },
  { models: [custom] }, { models: [{ slug: "incomplete" }] }]) {
  test(`拒絕無效官方清單 ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => router.mergeOfficialCatalog(invalid, original), /invalid_catalog/);
  });
}

test("每次完成後都重新查詢官方，保留版本與帳號，不帶本機 Cookie 或第三方 key", async () => {
  const { r, path } = await fixture();
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.equal(url.href, "https://chatgpt.example/backend-api/codex/models?client_version=0.155.0");
    assert.equal(options.headers.get("authorization"), headers.authorization);
    assert.equal(options.headers.get("chatgpt-account-id"), "account-a");
    assert.equal(options.headers.get("cookie"), null);
    assert.equal(options.headers.get("x-api-key"), null);
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal);
    return ok();
  };
  const input = { ...headers, cookie: "private-cookie", "x-api-key": "third-party-key" };
  await r.refreshOfficialCatalog(input, query, fetcher);
  const mtime = statSync(path).mtimeMs;
  const result = await r.refreshOfficialCatalog(input, query, fetcher);
  assert.equal(calls, 2);
  assert.equal(statSync(path).mtimeMs, mtime, "清單未變不重寫");
  assert.deepEqual(JSON.parse(readFileSync(path)), result);
});

test("同時啟動合併相同帳號查詢，不共用不同帳號結果", async () => {
  const { r } = await fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const fetcher = async (_url, options) => {
    calls++;
    await gate;
    return ok({ models: [model(options.headers.get("chatgpt-account-id"))] });
  };
  const a = r.refreshOfficialCatalog(headers, query, fetcher);
  const b = r.refreshOfficialCatalog(headers, query, fetcher);
  const c = r.refreshOfficialCatalog({ ...headers, "chatgpt-account-id": "account-b" }, query, fetcher);
  release();
  const [one, two, three] = await Promise.all([a, b, c]);
  assert.equal(calls, 2);
  assert.equal(one.models[0].slug, "account-a");
  assert.deepEqual(one, two);
  assert.equal(three.models[0].slug, "account-b");
});

test("等候官方時新增的自訂模型不會被舊快照覆蓋", async () => {
  const { r, path } = await fixture();
  const result = await r.refreshOfficialCatalog(headers, query, async () => {
    writeFileSync(path, JSON.stringify({ models: [...original.models, model("custom/new")] }));
    return ok();
  });
  assert.ok(result.models.some(m => m.slug === "custom/new"));
});

for (const [name, fetcher] of [
  ["HTTP 401", async () => new Response("secret body", { status: 401 })],
  ["HTTP 503", async () => new Response("secret body", { status: 503 })],
  ["redirect", async () => new Response(null, { status: 302, headers: { location: "https://other.example" } })],
  ["timeout", async () => { throw new DOMException("secret token", "TimeoutError"); }],
  ["JSON damaged", async () => new Response("{bad")],
  ["empty", async () => ok({ models: [] })],
  ["oversize", async () => new Response("x".repeat(8 * 1024 * 1024 + 1))],
]) {
  test(`${name} 沿用本地資料，失敗後下次啟動仍可同步`, async () => {
    const { r, path } = await fixture();
    const before = readFileSync(path, "utf8");
    assert.deepEqual(await r.refreshOfficialCatalog(headers, query, fetcher), original);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal((await r.refreshOfficialCatalog(headers, query, async () => ok())).models[0].slug, "gpt-6-sol");
  });
}

test("關閉同步、沒有登入或版本時只讀本地資料", async () => {
  const failFetch = () => assert.fail("不應查詢官方");
  const { r } = await fixture({ catalogRefresh: false });
  assert.deepEqual(await r.refreshOfficialCatalog(headers, query, failFetch), original);
  const { r: enabled } = await fixture();
  assert.deepEqual(await enabled.refreshOfficialCatalog({}, query, failFetch), original);
  assert.deepEqual(await enabled.refreshOfficialCatalog(headers, new URLSearchParams(), failFetch), original);
});

test("升級只移除路由器自己的固定目錄，保留使用者指定目錄", () => {
  const managed = join(tmpdir(), "model-router", "models.json");
  assert.equal(installer.isManagedCatalogPath(managed, managed), true);
  assert.equal(installer.isManagedCatalogPath(join(tmpdir(), "my-models.json"), managed), false);
  assert.equal(installer.isManagedCatalogPath(undefined, managed), false);
});
