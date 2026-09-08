// hidden-models 命令使用的模型目錄資料邏輯。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
const {
  applyForcedVisibility,
  hiddenOfficialModels,
  normalizeForceListedModels,
  mergeCatalogForForcedModels,
  validateManagedCatalog,
} = installer;

const freshCatalog = {
  schema: 7,
  models: [
    { slug: "gpt-visible", visibility: "list", priority: 1 },
    { slug: "gpt-hidden", visibility: "hide", priority: 2 },
    { slug: "gpt-hidden-2", visibility: "hide", priority: 3 },
    { slug: "custom/from-bundled", visibility: "list", priority: 4 },
  ],
};

test("隱藏模型只取官方且 visibility=hide 的項目", () => {
  assert.deepEqual(
    hiddenOfficialModels(freshCatalog).map((model) => model.slug),
    ["gpt-hidden", "gpt-hidden-2"],
  );
});

test("強制顯示清單會去重、排成目錄順序並丟掉未知 slug", () => {
  assert.deepEqual(
    normalizeForceListedModels(freshCatalog.models, [
      "missing",
      "gpt-hidden-2",
      "gpt-hidden",
      "gpt-hidden-2",
      "custom/from-bundled",
    ]),
    ["gpt-hidden", "gpt-hidden-2"],
  );
});

test("套用 visibility 不會就地修改原始模型", () => {
  const source = [{ slug: "gpt-hidden", visibility: "hide" }];
  const result = applyForcedVisibility(source, ["gpt-hidden"]);
  assert.equal(source[0].visibility, "hide");
  assert.equal(result[0].visibility, "list");
});

test("合併新官方目錄時保留 custom 模型並重新排在官方模型後面", () => {
  const current = {
    schema: 3,
    models: [
      { slug: "custom/claude", visibility: "list", priority: 999, marker: "keep" },
      { slug: "gpt-old", visibility: "list", priority: 1000 },
    ],
  };
  const merged = mergeCatalogForForcedModels(freshCatalog, current, ["gpt-hidden"]);
  assert.equal(merged.schema, 7);
  assert.equal(merged.models.find((model) => model.slug === "gpt-hidden").visibility, "list");
  assert.equal(merged.models.some((model) => model.slug === "gpt-old"), false);
  const custom = merged.models.find((model) => model.slug === "custom/claude");
  assert.equal(custom.marker, "keep");
  assert.ok(custom.priority > 3);
});

test("目錄驗證會同時檢查強制顯示項目與自訂模型是否遺失", () => {
  const bad = {
    models: [
      { slug: "gpt-hidden", visibility: "hide" },
      { slug: "custom/claude", visibility: "list" },
    ],
  };
  assert.deepEqual(validateManagedCatalog(bad, ["gpt-hidden"], ["custom/claude"]), {
    ok: false,
    hiddenForced: ["gpt-hidden"],
    missingForced: [],
    missingCustom: [],
  });
  assert.deepEqual(validateManagedCatalog({ models: [] }, [], ["custom/claude"]), {
    ok: false,
    hiddenForced: [],
    missingForced: [],
    missingCustom: ["custom/claude"],
  });
});
