import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";
const { installer: i, router } = await loadPayloads();
const route = name => ({ upstreamModel: `ark/${name}`, pickerSlug: `custom/${name}`, efforts: ["low"], providerHost: "example.test" });
test("已同步的官方同名模板優先於舊 bundled，ark 前綴不影響匹配", () => {
  const bundled = { models: [{ slug: "gpt-5.6-sol", visibility: "list", context_window: 272000 }] };
  const current = { models: ["gpt-6-sol", "gpt-6-luna"].map(slug => ({ slug, context_window: 1050000, max_context_window: 1050000 })) };
  const templates = i.catalogTemplates(bundled, current).models;
  for (const name of ["gpt-6-sol", "gpt-6-luna"]) {
    const entry = i.customCatalogEntry(templates, route(name), 0);
    assert.equal(entry.context_window, 1050000);
    assert.equal(entry.max_context_window, 1050000);
    const probed = i.customCatalogEntry(templates, { ...route(name), contextWindow: 200000 }, 0);
    assert.equal(probed.context_window, 200000);
  }
});
test("同名的新官方欄位覆蓋 bundled，custom 不混入模板", () => {
  assert.deepEqual(i.catalogTemplates({ models: [{ slug: "gpt", context_window: 1 }] },
    { models: [{ slug: "gpt", context_window: 2 }, { slug: "custom/x" }] }).models,
  [{ slug: "gpt", context_window: 2 }]);
});
test("添加 Claude Opus 5.5 不覆蓋既有自訂模型的手動設定", () => {
  const old = route("existing"), added = route("claude-opus-5-5");
  const previous = { slug: old.pickerSlug, display_name: "手動名稱", context_window: 999999, extra: true };
  const result = i.mergeAddedModels([{ slug: "gpt", context_window: 272000 }], { models: [previous] }, [old, added], [added]);
  assert.deepEqual(result[0], previous);
  assert.equal(result[1].slug, added.pickerSlug);
  assert.equal(i.hasExpectedModels({ data: [{ id: old.pickerSlug }] }, [old.pickerSlug, added.pickerSlug]), false);
  assert.equal(i.hasExpectedModels({ data: result.map(m => ({ id: m.slug })) }, [old.pickerSlug, added.pickerSlug]), true);
});

test("後加入的模型按探測清單插入既有模型之間，重啟同步後順序不變", () => {
  const names = ["claude-opus-5", "gpt-5.6-sol", "gpt-6-astra", "claude-opus-5-5", "gpt-6-sol"];
  const routes = names.map(route);
  const previous = routes.slice(0, 3).map((item, index) => ({
    slug: item.pickerSlug,
    display_name: `手動名稱 ${index}`,
    context_window: 1000000,
    extra_capability: { original: true },
    priority: 44 + index,
  }));
  const official = [{ slug: "gpt-official", priority: 43, context_window: 272000 }];
  const discovered = ["claude-opus-5", "claude-opus-5-5", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol"]
    .map(name => `ark/${name}`);
  const added = i.mergeAddedModels(official, { models: previous }, routes, routes.slice(3));
  const ordered = i.orderCustomModelsByDiscovery(official, added, routes, discovered);
  assert.deepEqual(ordered.map(model => model.slug), [routes[0], routes[3], routes[1], routes[2], routes[4]]
    .map(item => item.pickerSlug));
  assert.deepEqual(ordered.map(model => model.priority), [44, 45, 46, 47, 48]);
  assert.deepEqual(ordered.filter(model => previous.some(old => old.slug === model.slug))
    .map(({ priority, ...model }) => model), previous.map(({ priority, ...model }) => model));
  const refreshed = router.mergeCatalog({ models: official }, { models: [...official, ...ordered] });
  assert.deepEqual(refreshed.models.slice(1).map(model => model.slug), ordered.map(model => model.slug));
});

test("探測清單缺少的既有模型留在末尾，彼此維持原順序", () => {
  const routes = ["saved-first", "listed-second", "saved-third", "listed-first"].map(route);
  const current = routes.map((item, index) => ({ slug: item.pickerSlug, priority: index + 10 }));
  const ordered = i.orderCustomModelsByDiscovery([{ priority: 7 }], current, routes,
    ["ark/listed-first", "ark/listed-second"]);
  assert.deepEqual(ordered.map(model => model.slug), [routes[3], routes[1], routes[0], routes[2]]
    .map(item => item.pickerSlug));
  assert.deepEqual(ordered.map(model => model.priority), [8, 9, 10, 11]);
});
