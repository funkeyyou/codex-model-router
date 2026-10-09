// 供應商的顯示名稱與模型前綴：管理頁與終端共用的純函式。
//
// 名稱只影響顯示，id 不變；前綴只改自動產生的模型顯示名稱，手動取的名稱保留。
// 這裡也驗證之後新增的模型（添加模型、Claude 訂閱）會套用前綴，以及更新不會洗掉設定。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();

const providers = [
  { id: "default", baseUrl: "https://gw.example", apiRoot: "https://gw.example/v1", keychainService: "svc.gw", keychainAccount: "codex", credentialPath: null },
  { id: "owo", baseUrl: "https://owo.example/v1", apiRoot: "https://owo.example/v1", keychainService: "svc.owo", keychainAccount: "codex", credentialPath: null },
];
const routes = [
  { pickerSlug: "custom/a", upstreamModel: "ark/gpt-a", displayName: "ark/gpt-a", efforts: ["high"] },
  { pickerSlug: "custom/b", upstreamModel: "plain-b", displayName: "api/plain-b", efforts: [] },
  { pickerSlug: "custom/c", upstreamModel: "ark/gpt-c", displayName: "我的 C", efforts: [] },
  { pickerSlug: "custom/owo-d", upstreamModel: "claude-d", displayName: "owo/claude-d", providerId: "owo", efforts: [] },
  { pickerSlug: "custom/cli-e", upstreamModel: "claude-e", displayName: "claude-cli/claude-e", providerId: "claude-cli",
    transport: "claude-cli", translate: "anthropic", efforts: ["low"] },
];
const fixture = () => ({
  manifest: { version: "1.27.8", port: 48953, routes: structuredClone(routes), providers: structuredClone(providers), claudeCli: { binary: "/bin/claude" } },
  settings: { version: "1.27.8", port: 48953, routes: structuredClone(routes), providers: structuredClone(providers),
    claudeCli: { binary: "/bin/claude", timeoutMs: 180000 } },
  catalog: { keep: "catalog", models: [
    { slug: "gpt-official", display_name: "GPT", priority: 1 },
    ...routes.map((route, index) => ({ slug: route.pickerSlug, display_name: route.displayName, priority: 10 + index })),
  ] },
});
const names = (record) => Object.fromEntries(record.routes.map((route) => [route.pickerSlug, route.displayName]));
const catalogNames = (catalog) => Object.fromEntries(catalog.models.map((model) => [model.slug, model.display_name]));

test("名稱與前綴：讀設定時保留，無效值當作沒設定；輸入值正規化", () => {
  const list = installer.installedProviders({ providers: [
    { ...providers[0], name: "  公司   閘道 ", modelPrefix: "th" },
    { ...providers[1], name: "x".repeat(40), modelPrefix: "-bad" },
  ] });
  assert.equal(list[0].name, "公司 閘道");
  assert.equal(list[0].modelPrefix, "th");
  assert.equal("name" in list[1], false);
  assert.equal("modelPrefix" in list[1], false);
  assert.equal(installer.providerName(list[0]), "公司 閘道");
  assert.equal(installer.providerName(list[1]), "owo");

  assert.equal(installer.normalizeModelPrefix(" ark/ "), "ark");
  assert.equal(installer.normalizeModelPrefix("My.Relay_2"), "My.Relay_2");
  assert.equal(installer.normalizeModelPrefix(""), null);
  assert.equal(installer.normalizeModelPrefix(null), null);
  for (const value of ["a/b", "-a", "a-", "中文", "x".repeat(33)]) assert.throws(() => installer.normalizeModelPrefix(value), /前綴只能用/, value);
  assert.equal(installer.normalizeProviderName("  A   B "), "A B");
  assert.equal(installer.normalizeProviderName("   "), null);
  assert.throws(() => installer.normalizeProviderName("x".repeat(33)), /最多 32 個字/);
  assert.throws(() => installer.normalizeProviderName("a\u0007b"), /控制字元/);
});

test("改名：只寫入名稱，id、路由與模型目錄都不變；改回 id 或留空就移除名稱", () => {
  const before = fixture();
  const original = structuredClone(before);
  const plan = installer.planEditProvider(before.manifest, before.settings, before.catalog, "default", { name: " Acme " });
  assert.equal(plan.changed, true);
  assert.equal(plan.restartDesktop, false, "沒有模型改名就不必重開桌面版");
  assert.deepEqual(plan.renames, []);
  assert.equal(plan.name, "Acme");
  assert.deepEqual(plan.settings.providers.map((item) => [item.id, item.name]), [["default", "Acme"], ["owo", undefined]]);
  assert.equal(plan.manifest.providers[0].name, "Acme");
  assert.equal(plan.manifest.baseUrl, "https://gw.example", "install.json 仍保留主要供應商的舊欄位");
  assert.equal(plan.catalog, before.catalog, "模型目錄不必改寫");
  assert.deepEqual(plan.settings.routes, before.settings.routes);
  assert.deepEqual(plan.settings.claudeCli, before.settings.claudeCli);
  assert.deepEqual(before, original, "不能改動傳入的物件");

  for (const reset of ["default", "", null]) {
    const next = installer.planEditProvider(plan.manifest, plan.settings, plan.catalog, "default", { name: reset });
    assert.equal(next.changed, true);
    assert.equal("name" in next.settings.providers[0], false, String(reset));
  }
  assert.equal(installer.planEditProvider(before.manifest, before.settings, before.catalog, "default", { name: "default" }).changed, false);
  assert.equal(installer.planEditProvider(before.manifest, before.settings, before.catalog, "default", {}).changed, false);

  const fail = (id, fields, pattern) => assert.throws(() => installer.planEditProvider(before.manifest, before.settings, before.catalog, id, fields), pattern);
  fail("default", { name: "OWO" }, /已經有叫「OWO」的供應商了/);
  fail("owo", { name: "claude-cli" }, /保留名稱/);
  fail("owo", { name: "API" }, /保留名稱/);
  fail("nope", { name: "x" }, /找不到供應商/);
  const named = installer.planEditProvider(before.manifest, before.settings, before.catalog, "default", { name: "Acme" });
  assert.throws(() => installer.planEditProvider(named.manifest, named.settings, named.catalog, "owo", { name: "acme" }), /已經有叫/);
  assert.throws(() => installer.planEditProvider({ routes: [] }, { routes: null }, before.catalog, "default", {}), /不完整/);
});

test("前綴：自動名稱跟著改、手動名稱保留，三處設定一致；恢復預設規則會改回原本的名稱", () => {
  const before = fixture();
  const plan = installer.planEditProvider(before.manifest, before.settings, before.catalog, "default", { modelPrefix: "th/" });
  assert.equal(plan.modelPrefix, "th");
  assert.equal(plan.restartDesktop, true);
  assert.deepEqual(plan.renames.map((item) => [item.slug, item.from, item.to]),
    [["custom/a", "ark/gpt-a", "th/gpt-a"], ["custom/b", "api/plain-b", "th/plain-b"]]);
  assert.deepEqual(plan.kept.map((item) => [item.slug, item.displayName]), [["custom/c", "我的 C"]]);
  for (const view of [names(plan.settings), names(plan.manifest), catalogNames(plan.catalog)]) {
    assert.equal(view["custom/a"], "th/gpt-a");
    assert.equal(view["custom/b"], "th/plain-b");
    assert.equal(view["custom/c"], "我的 C");
    assert.equal(view["custom/owo-d"], "owo/claude-d", "其他供應商不受影響");
    assert.equal(view["custom/cli-e"], "claude-cli/claude-e");
  }
  assert.equal(plan.settings.providers[0].modelPrefix, "th");
  assert.equal(plan.manifest.providers[0].modelPrefix, "th");
  assert.deepEqual(plan.settings.routes.map((route) => [route.pickerSlug, route.upstreamModel, route.efforts]),
    before.settings.routes.map((route) => [route.pickerSlug, route.upstreamModel, route.efforts]), "選擇器 ID、上游 ID 與能力不變");
  assert.equal(plan.catalog.keep, "catalog");
  assert.equal(installer.modelPrefixFor(plan.settings, "default"), "th");
  assert.equal(installer.modelPrefixFor(plan.settings, "owo"), null);

  const reset = installer.planEditProvider(plan.manifest, plan.settings, plan.catalog, "default", { modelPrefix: "" });
  assert.deepEqual(reset.renames.map((item) => [item.slug, item.to]), [["custom/a", "ark/gpt-a"], ["custom/b", "api/plain-b"]]);
  assert.equal("modelPrefix" in reset.settings.providers[0], false);
  assert.equal(names(reset.settings)["custom/c"], "我的 C");
  const unchanged = installer.planEditProvider(plan.manifest, plan.settings, plan.catalog, "default", { modelPrefix: "th" });
  assert.equal(unchanged.changed, false);

  const owo = installer.planEditProvider(before.manifest, before.settings, before.catalog, "owo", { name: "PingPing", modelPrefix: "pp" });
  assert.deepEqual(owo.renames.map((item) => [item.from, item.to]), [["owo/claude-d", "pp/claude-d"]]);
  assert.deepEqual([owo.settings.providers[1].name, owo.settings.providers[1].modelPrefix], ["PingPing", "pp"]);
  assert.throws(() => installer.planEditProvider(before.manifest, before.settings, before.catalog, "default", { modelPrefix: "a/b" }), /前綴只能用/);
});

test("取代上游前綴後同一家撞名時保留完整上游 ID；與其他家同名只提醒不擋", () => {
  const base = fixture();
  base.settings.routes.push({ pickerSlug: "custom/z", upstreamModel: "azure/gpt-a", displayName: "azure/gpt-a", efforts: [] });
  base.catalog.models.push({ slug: "custom/z", display_name: "azure/gpt-a" });
  const plan = installer.planEditProvider(base.manifest, base.settings, base.catalog, "default", { modelPrefix: "x" });
  assert.deepEqual(Object.fromEntries(plan.renames.map((item) => [item.slug, item.to])),
    { "custom/a": "x/ark/gpt-a", "custom/b": "x/plain-b", "custom/z": "x/azure/gpt-a" });
  assert.deepEqual(plan.conflicts, []);

  const clash = fixture();
  clash.settings.routes.push({ pickerSlug: "custom/owo-b", upstreamModel: "plain-b", displayName: "owo/plain-b", providerId: "owo", efforts: [] });
  clash.catalog.models.push({ slug: "custom/owo-b", display_name: "owo/plain-b" });
  const warned = installer.planEditProvider(clash.manifest, clash.settings, clash.catalog, "owo", { modelPrefix: "api" });
  assert.equal(warned.changed, true);
  assert.deepEqual(warned.conflicts, [{ displayName: "api/plain-b", slugs: ["custom/b", "custom/owo-b"] }]);
});

test("Claude 訂閱只能改前綴：名稱固定，前綴存在 claudeCli，其餘設定保留", () => {
  const before = fixture();
  assert.throws(() => installer.planEditProvider(before.manifest, before.settings, before.catalog, "claude-cli", { name: "我的訂閱" }), /不支援修改/);
  const plan = installer.planEditProvider(before.manifest, before.settings, before.catalog, "claude-cli", { name: "", modelPrefix: "cc" });
  assert.deepEqual(plan.renames.map((item) => [item.slug, item.from, item.to]), [["custom/cli-e", "claude-cli/claude-e", "cc/claude-e"]]);
  assert.deepEqual(plan.settings.claudeCli, { binary: "/bin/claude", timeoutMs: 180000, modelPrefix: "cc" });
  assert.deepEqual(plan.manifest.claudeCli, { binary: "/bin/claude", modelPrefix: "cc" });
  assert.deepEqual(plan.settings.providers, before.settings.providers);
  assert.equal(catalogNames(plan.catalog)["custom/cli-e"], "cc/claude-e");
  assert.equal(installer.modelPrefixFor(plan.settings, "claude-cli"), "cc");
  const reset = installer.planEditProvider(plan.manifest, plan.settings, plan.catalog, "claude-cli", { modelPrefix: null });
  assert.equal(names(reset.settings)["custom/cli-e"], "claude-cli/claude-e");
  assert.equal("modelPrefix" in reset.settings.claudeCli, false);

  const noCli = fixture();
  noCli.settings.routes = noCli.settings.routes.filter((route) => route.transport !== "claude-cli");
  assert.throws(() => installer.planEditProvider(noCli.manifest, noCli.settings, noCli.catalog, "claude-cli", { modelPrefix: "cc" }), /尚未連接/);
});

test("之後新增的模型套用前綴：添加模型與 Claude 訂閱都一樣，手動名稱保留", () => {
  const existing = [{ pickerSlug: "custom/old", upstreamModel: "ark/x", displayName: "th/x" }];
  const fresh = [
    { pickerSlug: "custom/n1", upstreamModel: "azure/x", displayName: "azure/x" },
    { pickerSlug: "custom/n2", upstreamModel: "y", displayName: "api/y" },
    { pickerSlug: "custom/n3", upstreamModel: "z", displayName: "Manual Z" },
  ];
  assert.equal(installer.applyModelPrefix(fresh, null, existing), fresh);
  assert.deepEqual(installer.applyModelPrefix(fresh, "th", existing).map((route) => route.displayName), ["th/azure/x", "th/y", "Manual Z"]);

  const templates = { models: [{ slug: "gpt-6-sol", priority: 11, visibility: "list", display_name: "6", context_window: 400000, supported_reasoning_levels: [] }] };
  const prefixed = [{ ...providers[0], modelPrefix: "th" }];
  const settings = { version: "1.27.8", port: 1, routes: [], providers: prefixed };
  const added = installer.planAddModels({ version: "1.27.8", routes: [], providers: prefixed }, settings, { models: templates.models }, templates, prefixed[0],
    [{ pickerSlug: "custom/new", upstreamModel: "new", displayName: "api/new", providerHost: "gw.example", efforts: [], contextWindow: 100000 }], ["new"], null);
  assert.equal(added.added[0].displayName, "th/new");
  assert.equal(added.settings.routes[0].displayName, "th/new");
  assert.equal(catalogNames(added.catalog)["custom/new"], "th/new");
  assert.equal(added.settings.providers[0].modelPrefix, "th", "添加模型不會洗掉前綴");

  const cliState = (state) => ({ providers: [providers[0]], manifest: state.manifest, settings: state.settings, catalog: state.catalog });
  const start = { manifest: { port: 1, routes: [] }, settings: { port: 1, routes: [], claudeCli: { binary: "/bin/claude", modelPrefix: "cc" } },
    catalog: { models: [{ slug: "gpt-fixture", priority: 1, context_window: 200000, visibility: "list" }] } };
  const cli = installer.planClaudeCliModels(cliState(start), "/bin/claude", ["claude-test"], 200000);
  assert.equal(cli.settings.routes[0].displayName, "cc/claude-test");
  assert.equal(catalogNames(cli.catalog)[cli.settings.routes[0].pickerSlug], "cc/claude-test");
  assert.equal(cli.settings.claudeCli.modelPrefix, "cc");
  const renamed = installer.planEditModel(cli.manifest, cli.settings, cli.catalog, cli.settings.routes[0].pickerSlug, { displayName: "我的 Claude" });
  const again = installer.planClaudeCliModels(cliState(renamed), "/bin/claude", ["claude-test"], 200000);
  assert.equal(again.settings.routes[0].displayName, "我的 Claude", "重新設定保留手動名稱");
  const plain = installer.planClaudeCliModels(cliState({ ...start, settings: { ...start.settings, claudeCli: { binary: "/bin/claude" } } }),
    "/bin/claude", ["claude-test"], 200000);
  assert.equal(plain.settings.routes[0].displayName, "claude-cli/claude-test");
});

test("更新、新增與移除供應商都保留其他家的名稱與前綴", () => {
  const base = fixture();
  base.settings.providers[1] = { ...base.settings.providers[1], name: "PingPing", modelPrefix: "pp" };
  base.settings.claudeCli.modelPrefix = "cc";
  const update = installer.planUpdate(base.manifest, base.settings);
  assert.equal(update.ok, true);
  assert.deepEqual([update.settings.providers[1].name, update.settings.providers[1].modelPrefix], ["PingPing", "pp"]);
  assert.equal(update.settings.claudeCli.modelPrefix, "cc");
  const removed = installer.planRemoveProvider(base.manifest, base.settings, base.catalog, "default");
  assert.deepEqual([removed.settings.providers[0].id, removed.settings.providers[0].name], ["owo", "PingPing"]);
});
