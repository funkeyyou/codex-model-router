// 安裝器裡會影響「裝到哪一版」的判斷邏輯，以及來自網路的版本清單解析。
// 版本比較錯了會靜默降級；清單解析沒防守會讓遠端字串直接寫進終端機。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
const { versionParts, compareVersions, normalizeReleaseCatalog, releasesBetween,
        looksAnthropic, normalizeOwner, candidateApiRoots, terminalSafeText } = installer;

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

test("解除安裝封存安裝目錄後，使用者指令仍有有效副本且不改寫原檔", (t) => {
  const home = mkdtempSync(join(tmpdir(), "router-instruction-archive-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "runtime");
  const archive = join(home, "backup");
  mkdirSync(root);
  const file = join(root, "user-instructions.md");
  writeFileSync(file, "User-owned instructions\n");
  const config = { model_instructions_file: file, model: "user-model" };
  const edit = installer.preserveInstructionFile(config, archive, { root, home });
  assert.equal(edit.keyPath, "model_instructions_file");
  assert.equal(readFileSync(file, "utf8"), "User-owned instructions\n");
  assert.equal(config.model_instructions_file, file);
  renameSync(root, join(archive, "runtime"));
  assert.equal(readFileSync(edit.value, "utf8"), "User-owned instructions\n");
  assert.equal(config.model, "user-model");
});

test("解除安裝不接管安裝目錄以外的指令，未設定或檔案遺失也不建立副本", (t) => {
  const home = mkdtempSync(join(tmpdir(), "router-external-instructions-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "runtime");
  const archive = join(home, "backup");
  mkdirSync(root);
  const outside = join(home, "user-instructions.md");
  writeFileSync(outside, "Keep this file\n");
  for (const config of [{}, { model_instructions_file: outside }, { model_instructions_file: join(root, "missing.md") }]) {
    assert.equal(installer.preserveInstructionFile(config, archive, { root, home }), null);
  }
  assert.equal(existsSync(archive), false);
  assert.equal(readFileSync(outside, "utf8"), "Keep this file\n");
});

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
  assert.throws(() => normalizeReleaseCatalog(null), /格式無效/);
  assert.throws(() => normalizeReleaseCatalog("字串"), /格式無效/);
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

test("Windows 原生工具輸出：合法 UTF-8 原樣採用，否則依系統代碼頁解碼", () => {
  const { decodeWindowsOutput } = installer;
  // 簡中系統 schtasks 的「错误: 拒绝访问。」（GBK）
  const gbk = Buffer.from("b4edcef33a20bedcbef8b7c3cecaa1a3", "hex");
  assert.equal(decodeWindowsOutput(gbk, [936, 936]), "错误: 拒绝访问。");
  // 繁中系統的「錯誤: 存取被拒。」（Big5）
  const big5 = Buffer.from("bff9bb7e3a20a673a8fab351a9daa143", "hex");
  assert.equal(decodeWindowsOutput(big5, [950, 950]), "錯誤: 存取被拒。");
  // 已是 UTF-8（PowerShell 子行程、chcp 65001）不得被改寫。
  assert.equal(decodeWindowsOutput(Buffer.from("錯誤：拒絕存取", "utf8"), [936]), "錯誤：拒絕存取");
  assert.equal(decodeWindowsOutput(Buffer.from("ERROR: Access is denied.\r\n"), [437]), "ERROR: Access is denied.\r\n");
  assert.equal(decodeWindowsOutput(Buffer.alloc(0), [936]), "");
  // 不認得的代碼頁退回 UTF-8 寬鬆解碼，不丟例外。
  assert.equal(typeof decodeWindowsOutput(gbk, [437]), "string");
});

test("註冊排程工作遇到權限不足時給出可操作的提示", () => {
  const { isAccessDeniedText, scheduledTaskCreateFailure } = installer;
  assert.ok(isAccessDeniedText("错误: 拒绝访问。"));
  assert.ok(isAccessDeniedText("錯誤: 存取被拒。"));
  assert.ok(isAccessDeniedText("ERROR: Access is denied."));
  assert.ok(!isAccessDeniedText("ERROR: The system cannot find the file specified."));

  const name = "CodexModelRouter-abc1234567";
  const existing = scheduledTaskCreateFailure({
    detail: "错误: 拒绝访问。", denied: true, taskExists: true, elevated: false, taskName: name,
  });
  assert.match(existing, /權限不足/);
  assert.match(existing, /以系統管理員身分執行/);
  assert.ok(existing.includes(`schtasks /Delete /TN ${name} /F`));

  // 訊息認不出來（其他語系），但工作已存在且未提權，仍判定為權限問題。
  const inferred = scheduledTaskCreateFailure({
    detail: "??", denied: false, taskExists: true, elevated: false, taskName: name,
  });
  assert.match(inferred, /權限不足/);

  // 與權限無關的失敗維持一般訊息，不誤導使用者去提權。
  const other = scheduledTaskCreateFailure({
    detail: "ERROR: The task XML is malformed.", denied: false, taskExists: false, elevated: false, taskName: name,
  });
  assert.doesNotMatch(other, /權限不足/);
  assert.match(other, /schtasks\.exe 執行失敗/);
});

test("Codex RPC 逾時訊息分辨沒回應、未回覆與結果不符", () => {
  const { codexRpcTimeoutMessage } = installer;
  assert.match(codexRpcTimeoutMessage({ method: "model/list" }), /完全沒有回應/);
  const silent = codexRpcTimeoutMessage({ method: "model/list", initialized: true, stderr: "line1\nERROR config failed\n" });
  assert.match(silent, /已啟動，但 30 秒內沒有回覆 model\/list/);
  assert.match(silent, /ERROR config failed/);
  const mismatch = codexRpcTimeoutMessage({ method: "model/list", initialized: true, replies: 12, stderr: "WARN noise\n" });
  assert.match(mismatch, /回覆了 12 次/);
  assert.doesNotMatch(mismatch, /WARN noise/);
});

test("模型清單不符時逐項說明差異", () => {
  const { describePickerMismatch } = installer;
  const expected = [
    { pickerSlug: "custom/a-1", displayName: "api/a" },
    { pickerSlug: "custom/b-2", displayName: "api/b" },
    { pickerSlug: "custom/c-3", displayName: "api/c" },
  ];
  const allowed = new Set(expected.map((item) => item.pickerSlug));
  const result = { data: [
    { id: "gpt-6-sol", hidden: false, displayName: "GPT" },
    { id: "custom/b-2", hidden: true, displayName: "api/b" },
    { id: "custom/c-3", hidden: false, displayName: "c" },
    { id: "custom/old-9", hidden: false, displayName: "old" },
    { id: "custom/stray-8", hidden: false, displayName: "stray" },
  ] };
  const lines = describePickerMismatch(result, expected, ["custom/old-9"], allowed).join("\n");
  assert.match(lines, /缺少 1 個模型：custom\/a-1/);
  assert.match(lines, /標為隱藏：custom\/b-2/);
  assert.match(lines, /custom\/c-3（Codex 顯示「c」，預期「api\/c」）/);
  assert.match(lines, /應移除的模型仍在清單中：custom\/old-9/);
  assert.match(lines, /多出設定以外的自訂模型：custom\/stray-8/);

  // 完全沒有自訂模型：指向 model_catalog_json 沒被讀到。
  const none = describePickerMismatch({ data: [{ id: "gpt-6-sol", hidden: false }] }, expected, [], allowed).join("\n");
  assert.match(none, /完全沒有自訂模型/);
  assert.match(describePickerMismatch(null, expected).join(""), /沒有回傳/);
});


