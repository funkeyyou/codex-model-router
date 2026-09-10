import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";
const { installer, router } = await loadPayloads();

test("100萬配置保留模型可見性與工具能力，且不改動輸入", () => {
  const catalog = { models: [{ slug: "official", visibility: "hide", tools: ["web"], context_window: 200000 }] };
  const result = installer.applyMillionTokenContext(catalog);
  assert.equal(result.models[0].context_window, 1000000);
  assert.equal(result.models[0].max_context_window, 1000000);
  assert.equal(result.models[0].max_output_tokens, 128000);
  assert.equal(result.models[0].visibility, "hide");
  assert.deepEqual(result.models[0].tools, ["web"]);
  assert.equal(catalog.models[0].context_window, 200000);
});

test("更新官方目錄後仍保留100萬配置與自訂模型", () => {
  const fresh = { models: [{ slug: "official", visibility: "hide", context_window: 200000 }] };
  const current = { models: [{ slug: "custom/test", visibility: "list" }] };
  const merged = router.mergeCatalog(fresh, current, [], true);
  assert.equal(merged.models.length, 2);
  for (const model of merged.models) {
    assert.equal(model.context_window, 1000000);
    assert.equal(model.max_output_tokens, 128000);
  }
  assert.equal(router.mergeCatalog(fresh, current, [], false).models[0].context_window, 200000);
});
