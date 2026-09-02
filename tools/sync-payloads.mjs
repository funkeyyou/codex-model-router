#!/usr/bin/env node
// 把 codex-model-router.sh 內嵌的三段 JavaScript 同步到 codex-model-router.ps1。
//
//   node tools/sync-payloads.mjs           # 寫入 .ps1
//   node tools/sync-payloads.mjs --check   # 只比對，有落差就以非零狀態結束
//
// .sh 是負載的唯一真實來源；.ps1 只是把同一段文字包進 PowerShell 註解區塊，
// 讓 Windows 使用者一樣拿到單一檔案的安裝器。

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shellPath = join(repoRoot, "codex-model-router.sh");
const powershellPath = join(repoRoot, "codex-model-router.ps1");
const releasesPath = join(repoRoot, "releases.json");

const BEGIN_MARKER = "__CODEX_MODEL_ROUTER_INSTALLER_JS__";
const END_MARKER = "__CODEX_MODEL_ROUTER_EMBEDDED__";
const BOM = "﻿";

function readText(path) {
  const raw = readFileSync(path, "utf8");
  const hasBom = raw.startsWith(BOM);
  return { text: (hasBom ? raw.slice(1) : raw).replaceAll("\r\n", "\n"), hasBom };
}

// 取 .sh 從 __CODEX_MODEL_ROUTER_INSTALLER_JS__ 那行到 __CODEX_MODEL_ROUTER_EMBEDDED__
// 那行（含）為止的整段負載。
function extractPayload(text) {
  const begin = text.indexOf(`\n${BEGIN_MARKER}\n`);
  if (begin < 0) throw new Error(`codex-model-router.sh 缺少起始標記 ${BEGIN_MARKER}`);
  const end = text.lastIndexOf(`\n${END_MARKER}\n`);
  if (end < 0) throw new Error(`codex-model-router.sh 缺少結束標記 ${END_MARKER}`);
  if (end <= begin) throw new Error("codex-model-router.sh 的標記順序不正確");
  return text.slice(begin + 1, end + 1 + END_MARKER.length + 1);
}

// .ps1 的負載區塊固定是檔尾的 "<#\n<負載>\n#>\n"。
function replacePayload(text, payload) {
  const anchor = `\n<#\n${BEGIN_MARKER}\n`;
  const index = text.indexOf(anchor);
  if (index < 0) throw new Error(`codex-model-router.ps1 缺少負載區塊錨點（<# 後接 ${BEGIN_MARKER}）`);
  const head = text.slice(0, index + "\n<#\n".length);
  return `${head}${payload}#>\n`;
}

const shell = readText(shellPath);
const powershell = readText(powershellPath);
const releases = JSON.parse(readFileSync(releasesPath, "utf8"));
const installerVersion = /const INSTALLER_VERSION = "([^"]+)";/.exec(shell.text)?.[1];
if (!installerVersion) throw new Error("codex-model-router.sh 缺少 INSTALLER_VERSION");
if (releases.latest !== installerVersion) {
  throw new Error(
    `releases.json latest=${releases.latest} 与 INSTALLER_VERSION=${installerVersion} 不一致`,
  );
}
const payload = extractPayload(shell.text);
const updated = replacePayload(powershell.text, payload);

// PowerShell 5.1 沒有 BOM 就會用 ANSI 代碼頁解讀檔案，中文訊息會變亂碼。
const output = BOM + updated;

if (process.argv.includes("--check")) {
  const current = (powershell.hasBom ? BOM : "") + powershell.text;
  if (current === output) {
    console.log("payloads in sync");
    process.exit(0);
  }
  console.error(
    "codex-model-router.ps1 的內嵌負載與 codex-model-router.sh 不一致；" +
      "請執行 node tools/sync-payloads.mjs",
  );
  process.exit(1);
}

writeFileSync(powershellPath, output, "utf8");
const lineCount = payload.split("\n").length - 1;
console.log(`synced ${lineCount} lines of payload into codex-model-router.ps1`);
