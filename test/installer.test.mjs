// 安裝器裡會影響「裝到哪一版」的判斷邏輯，以及來自網路的版本清單解析。
// 版本比較錯了會靜默降級；清單解析沒防守會讓遠端字串直接寫進終端機。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
const { versionParts, compareVersions, normalizeReleaseCatalog, releasesBetween,
        looksAnthropic, normalizeOwner, candidateApiRoots, terminalSafeText } = installer;

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

// --- 版本比較 ---------------------------------------------------------------

test("三段版本逐段以數值比較（不是字串比較）", () => {
  assert.equal(compareVersions("1.8.0", "1.8.0"), 0);
  assert.equal(compareVersions("1.7.0", "1.8.0"), -1);
  assert.equal(compareVersions("1.8.0", "1.7.0"), 1);
  // 字串比較會說 "1.10.0" < "1.9.0"。
  assert.equal(compareVersions("1.9.0", "1.10.0"), -1);
  assert.equal(compareVersions("1.8.10", "1.8.9"), 1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
});

test("無法解析的版本回 null，呼叫端才好分辨「比不出來」與「相等」", () => {
  for (const bad of ["", "1.8", "1.8.0.1", "v1.8.0", "1.8.x", null, undefined, {}]) {
    assert.equal(compareVersions(bad, "1.8.0"), null, String(bad));
    assert.equal(compareVersions("1.8.0", bad), null, String(bad));
  }
  assert.deepEqual(versionParts(" 1.8.0 "), [1, 8, 0]);
  assert.equal(versionParts("1.8"), null);
});

// --- 版本清單解析 -----------------------------------------------------------

const catalog = () => normalizeReleaseCatalog({
  latest: "1.3.0",
  releases: [
    { version: "1.1.0", date: "2026-01-01", changes: ["a"] },
    { version: "1.3.0", date: "2026-03-01", changes: ["c"] },
    { version: "1.2.0", date: "2026-02-01", changes: ["b"] },
  ],
});

test("清單一律由新到舊排序", () => {
  assert.deepEqual(catalog().releases.map((r) => r.version), ["1.3.0", "1.2.0", "1.1.0"]);
});

test("格式無效的清單一律拒收，不會半信半疑地往下走", () => {
  assert.throws(() => normalizeReleaseCatalog(null), /格式无效/);
  assert.throws(() => normalizeReleaseCatalog("字串"), /格式无效/);
  assert.throws(() => normalizeReleaseCatalog({ releases: [] }), /latest/);
  assert.throws(() => normalizeReleaseCatalog({ latest: "1.0.0" }), /releases/);
  // latest 指到一個清單裡沒有的版本 -> 使用者會看不到更新內容，直接視為壞掉。
  assert.throws(
    () => normalizeReleaseCatalog({ latest: "9.9.9", releases: [{ version: "1.0.0", changes: ["a"] }] }),
    /找不到最新版本/,
  );
});

test("壞掉的條目被跳過，不會拖垮整份清單", () => {
  const result = normalizeReleaseCatalog({
    latest: "1.1.0",
    releases: [
      { version: "壞版本", changes: ["x"] },
      { version: "1.0.0", changes: [] },          // 沒有內容
      { version: "1.1.0", changes: ["good"] },
      { version: "1.1.0", changes: ["重複"] },     // 重複版本
    ],
  });
  assert.deepEqual(result.releases.map((r) => r.version), ["1.1.0"]);
  assert.deepEqual(result.releases[0].changes, ["good"]);
});

test("遠端文字會被消毒後才可能被印到終端機", () => {
  assert.equal(terminalSafeText(`${ESC}[31m紅色${ESC}[0m`), "紅色");
  assert.equal(terminalSafeText(`有${BEL}控制字元`), "有 控制字元");
  assert.equal(terminalSafeText("  多   空白  "), "多 空白");
  assert.equal(terminalSafeText("x".repeat(500)).length, 320);
  assert.equal(terminalSafeText(null), "");
});

test("清單內容也走同一套消毒", () => {
  const result = normalizeReleaseCatalog({
    latest: "1.0.0",
    releases: [{ version: "1.0.0", changes: [`${ESC}[31m假的錯誤訊息${ESC}[0m`] }],
  });
  assert.equal(result.releases[0].changes[0], "假的錯誤訊息");
});

// --- 「該顯示哪些更新內容」---------------------------------------------------

test("列出已安裝版本之後、到最新版為止的所有版本，由舊到新", () => {
  assert.deepEqual(releasesBetween(catalog(), "1.1.0").map((r) => r.version), ["1.2.0", "1.3.0"]);
});

test("已是最新版時只顯示當前版本內容", () => {
  assert.deepEqual(releasesBetween(catalog(), "1.3.0").map((r) => r.version), ["1.3.0"]);
});

test("已安裝版本比線上新時不列任何更新（避免慫恿降級）", () => {
  assert.deepEqual(releasesBetween(catalog(), "1.9.0"), []);
});

test("尚未安裝或版本無法解析時，只顯示最新版內容", () => {
  assert.deepEqual(releasesBetween(catalog(), null).map((r) => r.version), ["1.3.0"]);
  assert.deepEqual(releasesBetween(catalog(), "亂七八糟").map((r) => r.version), ["1.3.0"]);
});

// --- repo 自身的一致性 -------------------------------------------------------

test("releases.json 通過安裝器自己的解析，且 latest 有對應說明", () => {
  const raw = JSON.parse(readFileSync(new URL("../releases.json", import.meta.url), "utf8"));
  const parsed = normalizeReleaseCatalog(raw);
  assert.equal(parsed.latest, raw.latest);
  assert.ok(parsed.releases.some((r) => r.version === parsed.latest));
});

test("releases.json 的 latest 與 INSTALLER_VERSION 一致", () => {
  const sh = readFileSync(new URL("../codex-model-router.sh", import.meta.url), "utf8");
  const version = /const INSTALLER_VERSION = "([^"]+)";/.exec(sh)?.[1];
  const raw = JSON.parse(readFileSync(new URL("../releases.json", import.meta.url), "utf8"));
  assert.equal(raw.latest, version);
});

// --- 模型供應商判斷 ---------------------------------------------------------
// 猜錯只是回退到通用路由，但猜的規則本身要穩定。

test("模型名帶 claude / anthropic 才算 Anthropic", () => {
  for (const model of ["claude-opus-5", "ark/claude-opus-5", "anthropic/claude", "a_claude_b", "CLAUDE-3"]) {
    assert.equal(looksAnthropic(model), true, model);
  }
  for (const model of ["gpt-5", "claudia", "declaude", "", null, "openai/o3"]) {
    assert.equal(looksAnthropic(model), false, String(model));
  }
});

test("owned_by 正規化涵蓋各家自架閘道的寫法", () => {
  assert.equal(normalizeOwner("Anthropic"), "anthropic");
  assert.equal(normalizeOwner("anthropic-vertex"), "anthropic");
  assert.equal(normalizeOwner("OpenAI"), "openai");
  assert.equal(normalizeOwner("grok"), "xai");
  // 只有 anthropic 這一支會影響路由；其餘標籤原樣帶過即可（"x-ai" 不含 "xai"）。
  assert.equal(normalizeOwner("x-ai"), "x-ai");
  assert.equal(normalizeOwner(""), "unknown");
  assert.equal(normalizeOwner(null), "unknown");
});

// --- Base URL 推導 ----------------------------------------------------------

test("已帶 /v1 就不再疊一層，否則兩種都試", () => {
  assert.deepEqual(candidateApiRoots("https://h.example/v1"), ["https://h.example/v1"]);
  assert.deepEqual(candidateApiRoots("https://h.example"), ["https://h.example/v1", "https://h.example"]);
  assert.deepEqual(candidateApiRoots("https://h.example/"), ["https://h.example/v1", "https://h.example"]);
});
