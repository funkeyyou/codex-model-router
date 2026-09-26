// 同時使用多家中轉供應商：安裝器這一側。
//
// 設定從單一供應商（欄位放在頂層）改成 providers 陣列。這裡盯兩件事：
//   1. 舊安裝升級後，原本的模型、選擇器 ID 與顯示名稱一個字都不變——既有對話選的
//      模型不能因為升級而失效；
//   2. 新增、移除供應商時，其他家的模型與選單順序不受影響。
// 路由器怎麼依供應商分流見 multi-provider-router.test.mjs。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer, router } = await loadPayloads();
const LEGACY_PROVIDER_FIELDS = ["apiRoot", "baseUrl", "keychainService", "keychainAccount", "credentialPath"];

// --- 安裝器：設定格式 ---------------------------------------------------------

const legacyRoute = {
  pickerSlug: installer.pickerSlug("claude-x"), upstreamModel: "claude-x", displayName: "api/claude-x",
  providerHost: "relay-a.example", efforts: ["high"], stripReasoning: false, contextWindow: 200000,
};
const legacySettings = () => ({
  version: "1.23.1", port: 48953,
  apiRoot: "https://relay-a.example/v1", baseUrl: "https://relay-a.example",
  keychainService: "com.example.a", keychainAccount: "codex", credentialPath: null,
  forceListedModels: [], routes: [structuredClone(legacyRoute)],
});
const legacyManifest = () => ({
  version: "1.23.1", port: 48953, baseUrl: "https://relay-a.example", apiRoot: "https://relay-a.example/v1",
  keychainService: "com.example.a", routes: [structuredClone(legacyRoute)],
});
const secondProvider = () => ({
  id: "openrouter", baseUrl: "https://openrouter.example/api", apiRoot: "https://openrouter.example/api/v1",
  keychainService: "com.example.b", keychainAccount: "codex", credentialPath: null,
});
const scopedRoute = (model, providerId = "openrouter") => ({
  pickerSlug: installer.pickerSlug(model, providerId), upstreamModel: model, displayName: `${providerId}/${model}`,
  providerHost: "openrouter.example", efforts: ["medium"], stripReasoning: false, contextWindow: 128000, providerId,
});
const templates = { schema: 1, models: [
  { slug: "gpt-official", display_name: "GPT", priority: 40, visibility: "list", context_window: 272000 },
] };
const catalogWith = (routes) => ({ ...templates, models: [
  ...templates.models,
  ...routes.map((route, index) => ({ slug: route.pickerSlug, display_name: route.displayName, priority: 41 + index })),
] });

test("舊版頂層欄位讀成 id 為 default 的主要供應商；settings 缺的欄位用 manifest 補", () => {
  const settings = legacySettings();
  delete settings.baseUrl;
  assert.deepEqual(installer.installedProviders(settings, legacyManifest()), [{
    id: "default", baseUrl: "https://relay-a.example", apiRoot: "https://relay-a.example/v1",
    keychainService: "com.example.a", keychainAccount: "codex", credentialPath: null,
  }]);
  assert.deepEqual(installer.installedProviders({}, null), []);
});

test("新格式照 providers 讀出；寫回時拿掉頂層欄位，也不改動傳入的物件", () => {
  const providers = [installer.installedProviders(legacySettings())[0], secondProvider()];
  assert.deepEqual(installer.installedProviders({ providers, apiRoot: "https://stale.example/v1" }), providers);
  const legacy = legacySettings();
  const written = installer.withProviders(legacy, providers);
  assert.deepEqual(written.providers, providers);
  for (const field of LEGACY_PROVIDER_FIELDS) assert.equal(field in written, false, field);
  assert.equal(legacy.apiRoot, "https://relay-a.example/v1");
});

test("供應商名稱：從網址猜一個好記的預設值，撞名時加編號", () => {
  const cases = [
    ["https://api.openrouter.ai/v1", "openrouter"],
    ["https://relay.example.com", "example"],
    ["https://api.deepseek.com", "deepseek"],
    ["https://open.bigmodel.cn/api/paas/v4", "bigmodel"],
    ["https://api.example.com.cn/v1", "example"],
    ["https://api.openai.com/v1", "openai"],
    ["http://localhost:11434/v1", "local"],
    ["http://127.0.0.1:8080", "local"],
    ["http://[::1]:8080", "local"],
    ["https://api.com", "relay"],
  ];
  for (const [url, expected] of cases) assert.equal(installer.suggestProviderId(url), expected, url);
  assert.equal(installer.suggestProviderId("https://relay.example.com", ["example", "example-2"]), "example-3");
  for (const [url] of cases) assert.equal(installer.providerIdError(installer.suggestProviderId(url)), null, url);
});

test("供應商名稱只接受小寫英數與連字號；保留名稱與重複名稱都擋下", () => {
  assert.equal(installer.providerIdError("openrouter"), null);
  assert.equal(installer.providerIdError("a"), null);
  for (const bad of ["", "-a", "a-", "Open", "a_b", "中轉", "a".repeat(25)]) {
    assert.match(installer.providerIdError(bad), /小寫/, bad);
  }
  for (const reserved of ["default", "api", "custom", "official"]) {
    assert.match(installer.providerIdError(reserved), /保留/, reserved);
  }
  assert.match(installer.providerIdError("b", ["b"]), /已經有/);
});

test("主要供應商（default）的選擇器 ID 與顯示名稱規則不變；其他家都帶供應商名稱", () => {
  const legacySlug = `custom/claude-x-${createHash("sha256").update("claude-x").digest("hex").slice(0, 8)}`;
  assert.equal(installer.pickerSlug("claude-x"), legacySlug);
  assert.equal(installer.pickerSlug("claude-x", "default"), legacySlug);
  const scoped = installer.pickerSlug("claude-x", "openrouter");
  assert.match(scoped, /^custom\/openrouter-claude-x-[0-9a-f]{8}$/);
  assert.notEqual(scoped, installer.pickerSlug("claude-x", "other"), "同一個模型在兩家要有不同的 ID");
  assert.equal(installer.pickerSlug("claude-x", "openrouter"), scoped, "同一家同一個模型每次都得到同一個 ID");

  const route = (upstreamModel, providerId) => ({ upstreamModel, displayName: upstreamModel, ...(providerId ? { providerId } : {}) });
  assert.equal(installer.withDefaultModelPrefix(route("claude-x")).displayName, "api/claude-x");
  assert.equal(installer.withDefaultModelPrefix(route("anthropic/claude-x")).displayName, "anthropic/claude-x");
  assert.equal(installer.withDefaultModelPrefix(route("claude-x", "openrouter")).displayName, "openrouter/claude-x");
  assert.equal(installer.withDefaultModelPrefix(route("anthropic/claude-x", "openrouter")).displayName,
    "openrouter/anthropic/claude-x");
  const named = { ...route("claude-x", "openrouter"), displayName: "工作用" };
  assert.equal(installer.withDefaultModelPrefix(named), named);
  const prefixed = installer.withDefaultModelPrefix(route("claude-x", "openrouter"));
  assert.equal(installer.withDefaultModelPrefix(prefixed), prefixed);
});

// --- 安裝器：新增與移除供應商 -------------------------------------------------

function twoProviderState() {
  const settings = legacySettings();
  return installer.planAddProvider(legacyManifest(), settings, catalogWith(settings.routes), templates,
    secondProvider(), [scopedRoute("gpt-y")], ["gpt-y"]);
}

test("新增供應商：舊格式一併遷移，既有模型與目錄項目原封不動，新模型依探測順序接在後面", () => {
  const settings = legacySettings();
  const manifest = legacyManifest();
  const existingEntry = { slug: legacyRoute.pickerSlug, display_name: "手動名稱", priority: 41, extra: true };
  const catalog = { ...templates, models: [...templates.models, existingEntry] };
  const before = structuredClone({ settings, manifest, catalog });
  const newRoutes = [scopedRoute("gpt-y"), scopedRoute("claude-x")];
  const plan = installer.planAddProvider(manifest, settings, catalog, templates, secondProvider(), newRoutes,
    ["claude-x", "gpt-y"]);

  assert.deepEqual(plan.settings.providers.map((provider) => provider.id), ["default", "openrouter"]);
  for (const field of LEGACY_PROVIDER_FIELDS) assert.equal(field in plan.settings, false, field);
  assert.deepEqual(plan.settings.routes, [legacyRoute, ...newRoutes]);
  assert.deepEqual(plan.manifest.providers, plan.settings.providers);
  const custom = plan.catalog.models.filter((model) => model.slug.startsWith("custom/"));
  assert.deepEqual(custom.map((model) => model.slug),
    [legacyRoute.pickerSlug, newRoutes[1].pickerSlug, newRoutes[0].pickerSlug]);
  assert.deepEqual(custom[0], existingEntry);
  assert.equal(custom[1].display_name, "openrouter/claude-x");
  assert.deepEqual(before, { settings, manifest, catalog }, "不能改動傳入的設定");
});

test("新增供應商時擋下保留名稱、重複網址，以及不屬於這家的模型", () => {
  const plan = (provider, routes = [scopedRoute("gpt-y", provider.id)]) => () => installer.planAddProvider(
    legacyManifest(), legacySettings(), catalogWith([]), templates, provider, routes, []);
  assert.throws(plan({ ...secondProvider(), id: "default" }), /保留/);
  assert.throws(plan({ ...secondProvider(), baseUrl: "https://relay-a.example" }), /已經是供應商/);
  assert.throws(plan(secondProvider(), [scopedRoute("gpt-y", "other")]), /不一致/);
  assert.throws(plan(secondProvider(), []), /不一致/);
});

test("移除供應商：它的模型與目錄項目一起拿掉，其他家原封不動，之後照常能更新", () => {
  const state = twoProviderState();
  const before = structuredClone(state);
  const plan = installer.planRemoveProvider(state.manifest, state.settings, state.catalog, "openrouter");
  assert.deepEqual(plan.removedRoutes.map((route) => route.upstreamModel), ["gpt-y"]);
  assert.deepEqual(plan.settings.providers.map((provider) => provider.id), ["default"]);
  assert.deepEqual(plan.settings.routes, [legacyRoute]);
  assert.deepEqual(plan.manifest.routes, [legacyRoute]);
  assert.deepEqual(plan.catalog.models.map((model) => model.slug), ["gpt-official", legacyRoute.pickerSlug]);
  assert.deepEqual(state, before, "不能改動傳入的設定");
  assert.equal(installer.planUpdate(plan.manifest, plan.settings).ok, true);
});

test("移除主要供應商時由下一家接手；最後一家與不存在的供應商都不能移除", () => {
  const state = twoProviderState();
  const plan = installer.planRemoveProvider(state.manifest, state.settings, state.catalog, "default");
  assert.deepEqual(plan.settings.providers.map((provider) => provider.id), ["openrouter"]);
  assert.deepEqual(plan.settings.routes.map((route) => route.providerId), ["openrouter"]);
  // install.json 的舊欄位跟著換成新的主要供應商，舊版安裝器的 rollback 才刪得到對的 Key。
  assert.equal(plan.manifest.keychainService, secondProvider().keychainService);
  assert.equal(plan.manifest.apiRoot, secondProvider().apiRoot);
  assert.throws(() => installer.planRemoveProvider(plan.manifest, plan.settings, plan.catalog, "openrouter"),
    /至少要保留一家/);
  assert.throws(() => installer.planRemoveProvider(state.manifest, state.settings, state.catalog, "missing"),
    /找不到供應商/);
});

test("多家供應商的安裝照常更新：其他家的模型、名稱與供應商設定逐欄位保留", () => {
  const state = twoProviderState();
  const plan = installer.planUpdate(state.manifest, state.settings, "9.9.9");
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.settings.routes, state.settings.routes);
  assert.deepEqual(plan.settings.providers, state.settings.providers);
  assert.deepEqual({ ...plan.settings, version: state.settings.version }, state.settings);
});

test("選單排序：只有一家時與 orderCustomModelsByDiscovery 完全相同", () => {
  const routes = ["b", "a", "c"].map((name) => ({ pickerSlug: `custom/${name}`, upstreamModel: name }));
  const official = [{ slug: "o", priority: 7 }];
  const entries = routes.map((route) => ({ slug: route.pickerSlug }));
  assert.deepEqual(
    installer.arrangeCustomModels(official, entries, routes, ["default"], { providerId: "default", models: ["a", "c"] }),
    installer.orderCustomModelsByDiscovery(official, entries, routes, ["a", "c"]),
  );
});

test("選單排序：依供應商分組，主要供應商在前；這次沒探測的那家維持目錄裡的順序", () => {
  const a1 = { pickerSlug: "custom/a1", upstreamModel: "m1" };
  const a2 = { pickerSlug: "custom/a2", upstreamModel: "m2" };
  const b1 = { pickerSlug: "custom/b1", upstreamModel: "m1", providerId: "b" };
  const b2 = { pickerSlug: "custom/b2", upstreamModel: "m3", providerId: "b" };
  const entries = [b2, a1, b1, a2].map((route) => ({ slug: route.pickerSlug }));
  // 目前目錄裡 a2 排在 a1 前面（例如上次探測的順序），不能被 settings 的添加順序蓋掉。
  const catalog = { models: [{ slug: "o" }, { slug: "custom/a2" }, { slug: "custom/a1" }] };
  const result = installer.arrangeCustomModels([{ slug: "o", priority: 10 }], entries, [a1, a2, b1, b2],
    ["default", "b"], { providerId: "b", models: ["m3", "m1"] }, catalog);
  assert.deepEqual(result.map((model) => model.slug), ["custom/a2", "custom/a1", "custom/b2", "custom/b1"]);
  assert.deepEqual(result.map((model) => model.priority), [11, 12, 13, 14]);
});

test("安裝器與路由器對同一份設定讀出相同的供應商", () => {
  const fields = ({ id, apiRoot, keychainService, keychainAccount, credentialPath }) =>
    ({ id, apiRoot, keychainService, keychainAccount, credentialPath });
  for (const settings of [legacySettings(), twoProviderState().settings]) {
    assert.deepEqual(router.normalizeProviders(settings), installer.installedProviders(settings).map(fields));
  }
});
