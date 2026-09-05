// 模型目錄的自動更新。
//
// config.toml 的 model_catalog_json 指著 models.json，而那是安裝當下的快照。
// ChatGPT Desktop 更新、內建新模型後這個檔不會動，選單裡就永遠看不到——實測：
// 執行檔 9/5 11:07（bundled 11 個含 gpt-6-astra），models.json 9/4 17:01（10 個，沒有）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { router } = await loadPayloads();
const { catalogNeedsRefresh, mergeCatalog } = router;

// --- 觸發條件 ---------------------------------------------------------------

test("執行檔比目錄新才重建", () => {
  assert.equal(catalogNeedsRefresh(2000, 1000), true, "更新過 -> 要重建");
  assert.equal(catalogNeedsRefresh(1000, 2000), false, "目錄較新 -> 不動");
  assert.equal(catalogNeedsRefresh(1000, 1000), false, "同時間 -> 不動");
});

test("拿不到時間就不動作（不猜）", () => {
  for (const [a, b] of [[NaN, 1], [1, NaN], [undefined, 1], [1, null]]) {
    assert.equal(catalogNeedsRefresh(a, b), false);
  }
});

// --- 合併 -------------------------------------------------------------------

const fresh = {
  schema: 1,
  models: [
    { slug: "gpt-6-astra", priority: 10 },
    { slug: "gpt-5.6-sol", priority: 9 },
  ],
};
const current = {
  schema: 1,
  models: [
    { slug: "gpt-5.6-sol", priority: 9 },
    { slug: "custom/ark-claude-opus-5-6be3fe22", priority: 11, translate: "anthropic", contextWindow: 1000000 },
    { slug: "custom/ark-gpt-5.6-sol-3be199a2", priority: 12 },
  ],
};

test("官方項目整批換成新的（新模型因此會出現）", () => {
  const merged = mergeCatalog(fresh, current);
  const official = merged.models.filter((m) => !m.slug.startsWith("custom/"));
  assert.deepEqual(official.map((m) => m.slug), ["gpt-6-astra", "gpt-5.6-sol"]);
});

test("自訂項目原樣保留，探測結果不會掉", () => {
  const merged = mergeCatalog(fresh, current);
  const claude = merged.models.find((m) => m.slug.startsWith("custom/ark-claude"));
  assert.equal(claude.translate, "anthropic");
  assert.equal(claude.contextWindow, 1000000);
});

test("自訂項目排在所有官方模型之後，不會被新模型擠掉", () => {
  const merged = mergeCatalog(fresh, current);
  const maxOfficial = Math.max(...merged.models.filter((m) => !m.slug.startsWith("custom/")).map((m) => m.priority));
  for (const m of merged.models.filter((m) => m.slug.startsWith("custom/"))) {
    assert.ok(m.priority > maxOfficial, `${m.slug} priority=${m.priority}`);
  }
});

test("目錄的其他頂層欄位保留", () => {
  assert.equal(mergeCatalog(fresh, current).schema, 1);
});

test("沒有自訂項目時也能正常合併", () => {
  const merged = mergeCatalog(fresh, { models: [{ slug: "gpt-5.6-sol" }] });
  assert.equal(merged.models.length, 2);
});

test("bundled 回空的官方清單時拒絕合併（寧可維持舊目錄）", () => {
  assert.throws(() => mergeCatalog({ models: [] }, current), /沒有官方模型/);
  assert.throws(() => mergeCatalog({}, current), /沒有官方模型/);
  // 只有自訂項目也算沒有官方模型
  assert.throws(() => mergeCatalog({ models: [{ slug: "custom/x" }] }, current), /沒有官方模型/);
});

// --- 強制列出 ---------------------------------------------------------------
// bundled 把尚未普及的模型標成 hide，但能不能用是後端依帳號決定的；
// model_catalog_json 會蓋掉那個決定，帳號有權限也看不到。

test("指定的模型會被強制改成 list", () => {
  const merged = mergeCatalog(
    { models: [{ slug: "gpt-6-astra", visibility: "hide", priority: 1 }] },
    { models: [] },
    ["gpt-6-astra"],
  );
  assert.equal(merged.models[0].visibility, "list");
});

test("沒指定的模型維持原本的 visibility", () => {
  const merged = mergeCatalog(
    {
      models: [
        { slug: "gpt-6-astra", visibility: "hide" },
        { slug: "gpt-daybreak-blue-latest", visibility: "hide" },
        { slug: "gpt-5.6-sol", visibility: "list" },
      ],
    },
    { models: [] },
    ["gpt-6-astra"],
  );
  assert.deepEqual(
    merged.models.map((m) => [m.slug, m.visibility]),
    [["gpt-6-astra", "list"], ["gpt-daybreak-blue-latest", "hide"], ["gpt-5.6-sol", "list"]],
  );
});

test("不影響原始物件，其餘欄位保留", () => {
  const fresh = { models: [{ slug: "gpt-6-astra", visibility: "hide", context_window: 272000 }] };
  const merged = mergeCatalog(fresh, { models: [] }, ["gpt-6-astra"]);
  assert.equal(fresh.models[0].visibility, "hide", "來源不該被改動");
  assert.equal(merged.models[0].context_window, 272000);
});

test("沒有這個設定時行為不變", () => {
  const fresh = { models: [{ slug: "gpt-6-astra", visibility: "hide" }] };
  assert.equal(mergeCatalog(fresh, { models: [] }).models[0].visibility, "hide");
  assert.equal(mergeCatalog(fresh, { models: [] }, []).models[0].visibility, "hide");
});
