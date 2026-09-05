// 目錄重建的兩個觸發條件——它們壞掉的樣子都是「什麼都沒發生」。
//
// 1. Windows 的 Codex 每次更新都裝進新的版本雜湊目錄，舊目錄原封不動留著。
//    安裝時記下的那支執行檔 mtime 從此凍結，而 models.json 是安裝時才寫的，
//    必然比它新——「執行檔比目錄新」因此永遠不成立，自動重建等於沒有。
//    實測：昨天記的是 bin\1e3e57cdf0634c02\，今天已經變成 bin\2d468d2a6f48dd72\。
//
// 2. forceListedModels 只在重建時套用。既然重建不會觸發，設了也不會有反應。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { router } = await loadPayloads();
const { newestCodexBinary, forcedModelsPending } = router;

// --- 找出目前最新的 Codex 執行檔 --------------------------------------------

const isWindows = process.platform === "win32";
const exe = isWindows ? "codex.exe" : "codex";
const sep = isWindows ? "\\" : "/";
const at = (...parts) => parts.join(sep);

// statSync 的替身：只有登記過的路徑存在，其餘一律拋錯。
const stats = (table) => (path) => {
  if (!(path in table)) throw new Error("ENOENT " + path);
  return { mtimeMs: table[path] };
};

const BIN = at("C:", "bin");

test("釘死的執行檔已被更新取代時，改用比較新的那支", () => {
  const pinned = at(BIN, "aaaa", exe);
  const fresher = at(BIN, "bbbb", exe);
  const found = newestCodexBinary(
    pinned,
    BIN,
    ["aaaa", "bbbb"],
    stats({ [pinned]: 1000, [fresher]: 2000 }),
  );
  assert.equal(found, fresher);
});

test("釘死的那支仍是最新時就用它", () => {
  const pinned = at(BIN, "aaaa", exe);
  const older = at(BIN, "bbbb", exe);
  const found = newestCodexBinary(
    pinned,
    BIN,
    ["aaaa", "bbbb"],
    stats({ [pinned]: 3000, [older]: 2000 }),
  );
  assert.equal(found, pinned);
});

test("釘死的路徑整個消失了也還找得到（更新會刪掉舊目錄）", () => {
  const gone = at(BIN, "aaaa", exe);
  const current = at(BIN, "cccc", exe);
  const found = newestCodexBinary(gone, BIN, ["cccc"], stats({ [current]: 500 }));
  assert.equal(found, current, "不能因為釘死的那支不見了就整個放棄");
});

test("沒有搜尋目錄時退回釘死的那支（macOS 的路徑本來就固定）", () => {
  const pinned = at("/Applications", "ChatGPT.app", "codex");
  assert.equal(newestCodexBinary(pinned, null, null, stats({ [pinned]: 1 })), pinned);
});

test("什麼都找不到時回傳 null，不是丟出例外", () => {
  assert.equal(newestCodexBinary(null, null, null, stats({})), null);
  assert.equal(newestCodexBinary(at(BIN, "x", exe), BIN, [], stats({})), null);
});

// --- forceListedModels 是否還沒套用 ------------------------------------------

const catalogOf = (...models) => ({ models });

test("該強制列出卻還是 hide 的模型 -> 需要重建", () => {
  const catalog = catalogOf(
    { slug: "gpt-6-astra", visibility: "hide" },
    { slug: "gpt-5.6-sol", visibility: "list" },
  );
  assert.equal(forcedModelsPending(catalog, ["gpt-6-astra"]), true);
});

test("已經套用過就不必重建", () => {
  const catalog = catalogOf(
    { slug: "gpt-6-astra", visibility: "list" },
    { slug: "gpt-5.6-sol", visibility: "list" },
  );
  assert.equal(forcedModelsPending(catalog, ["gpt-6-astra"]), false);
});

test("清單為空或沒設定時不觸發", () => {
  const catalog = catalogOf({ slug: "gpt-6-astra", visibility: "hide" });
  for (const value of [[], null, undefined, "gpt-6-astra"]) {
    assert.equal(forcedModelsPending(catalog, value), false, String(value));
  }
});

test("清單裡有目錄根本沒有的 slug 時不會誤觸發", () => {
  const catalog = catalogOf({ slug: "gpt-5.6-sol", visibility: "list" });
  assert.equal(forcedModelsPending(catalog, ["不存在的模型"]), false);
});

test("目錄壞掉或沒有 models 時不觸發", () => {
  for (const catalog of [null, undefined, {}, { models: null }]) {
    assert.equal(forcedModelsPending(catalog, ["gpt-6-astra"]), false);
  }
});
