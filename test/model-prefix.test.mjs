import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
const { withDefaultModelPrefix, prefixCatalogDisplayNames, customCatalogEntry, pickerSlug, planUpdate } = installer;
const route = (name) => ({ upstreamModel: name, displayName: name, pickerSlug: pickerSlug(name), efforts: [], providerHost: "example.test" });

test("只為沒有上游前綴的預設名稱添加 api/；已有前綴及手動名稱保留", () => {
  for (const name of ["gpt-test", "claude-test", "fable5.1"]) {
    const original = route(name);
    const updated = withDefaultModelPrefix(original);
    assert.deepEqual(updated, { ...original, displayName: `api/${name}` });
    assert.equal(withDefaultModelPrefix(updated), updated);
    assert.equal(original.displayName, name);
  }
  for (const name of ["ark/gpt-test", "api/gpt-test", "vendor/group/model"]) {
    const original = route(name);
    assert.equal(withDefaultModelPrefix(original), original);
  }
  const named = { ...route("gpt-test"), displayName: "工作用模型" };
  assert.equal(withDefaultModelPrefix(named), named);
});

test("建立模型目錄時只改顯示名稱，上游模型與選擇器 ID 不變", () => {
  const original = route("gpt-test");
  const catalog = customCatalogEntry([{ slug: "gpt-test", priority: 1, context_window: 200000 }], original, 0);
  assert.equal(catalog.display_name, "api/gpt-test");
  assert.equal(catalog.slug, original.pickerSlug);
  assert.equal(original.upstreamModel, "gpt-test");
  assert.equal(catalog.context_window, 200000);
});

test("更新既有名稱只遷移預設顯示欄位，官方、手動名稱、模型能力逐欄位保留", () => {
  const routes = [route("gpt-test"), route("ark/claude-test"), route("manual")];
  const catalog = { models: [
    { slug: "gpt-test", display_name: "官方模型" },
    { slug: routes[0].pickerSlug, display_name: "gpt-test", context_window: 12345 },
    { slug: routes[1].pickerSlug, display_name: "ark/claude-test" },
    { slug: routes[2].pickerSlug, display_name: "手動名稱" },
  ] };
  const plan = planUpdate({ version: "1.19.0", routes }, { port: 48953, routes, keep: "unchanged" }, "1.19.1");
  assert.equal(plan.settings.routes[0].displayName, "api/gpt-test");
  assert.deepEqual(plan.manifest.routes, plan.settings.routes);
  assert.equal(plan.settings.keep, "unchanged");
  const updated = prefixCatalogDisplayNames(catalog, plan.routes);
  assert.deepEqual(updated.models[1], { ...catalog.models[1], display_name: "api/gpt-test" });
  for (const index of [0, 2, 3]) assert.equal(updated.models[index], catalog.models[index]);
  assert.equal(prefixCatalogDisplayNames(updated, plan.routes), updated);
  assert.equal(catalog.models[1].display_name, "gpt-test");
});
