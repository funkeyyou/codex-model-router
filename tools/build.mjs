#!/usr/bin/env node
// 由 src/ 產生兩支單檔安裝器 codex-model-router.sh / codex-model-router.ps1。
//
//   node tools/build.mjs           # 寫入 .sh 與 .ps1
//   node tools/build.mjs --check   # 只比對，有落差就以非零狀態結束
//
// src/ 是唯一真實來源：四段 JavaScript 各自是一般的 .mjs 檔，可以直接用編輯器、
// ESLint 與 node --check 處理。兩支安裝器只是把同一份文字包進不同的外殼——
// .sh 放在 bash heredoc 裡，.ps1 放在 PowerShell 的 <# #> 註解區塊裡——
// 讓使用者一樣只要下載單一檔案。
//
// 這支工具除了搬運文字，還負責幾件壞掉也不會立刻報錯的事：
//   - .ps1 開頭必須有 UTF-8 BOM，否則 PowerShell 5.1 會用 ANSI 代碼頁讀檔，中文全變亂碼；
//   - 四段負載要整批寫入，只更新其中一段會讓某個平台靜默停在舊版；
//   - 負載裡不能出現標記行或 "#>"，否則 heredoc 或 PowerShell 註解會提早結束。

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repoRoot, "src");
const shellPath = join(repoRoot, "codex-model-router.sh");
const powershellPath = join(repoRoot, "codex-model-router.ps1");
const releasesPath = join(repoRoot, "releases.json");

const BOM = "﻿";
const END_MARKER = "__CODEX_MODEL_ROUTER_EMBEDDED__";
// 順序即安裝器內的排列順序；安裝器與測試都依這個順序切段。
export const SECTIONS = [
  { marker: "__CODEX_MODEL_ROUTER_INSTALLER_JS__", file: "installer.mjs" },
  { marker: "__CODEX_MODEL_ROUTER_ROUTER_JS__", file: "router.mjs" },
  { marker: "__CODEX_MODEL_ROUTER_BRIDGE_JS__", file: "claude-bridge.mjs" },
  { marker: "__CODEX_MODEL_ROUTER_IMAGEGEN_JS__", file: "imagegen.mjs" },
];
const ALL_MARKERS = [...SECTIONS.map((section) => section.marker), END_MARKER];

function readText(path) {
  const raw = readFileSync(path, "utf8");
  const hasBom = raw.startsWith(BOM);
  return { text: (hasBom ? raw.slice(1) : raw).replaceAll("\r\n", "\n"), hasBom };
}

function readSource(name) {
  const { text, hasBom } = readText(join(srcDir, name));
  if (hasBom) throw new Error(`src/${name} 不可帶 BOM；.ps1 的 BOM 由建置工具加上`);
  if (!text.endsWith("\n")) throw new Error(`src/${name} 必須以換行結尾`);
  if (text.endsWith("\n\n")) throw new Error(`src/${name} 結尾多了空行；git diff --check 會報錯`);
  return text;
}

export function buildPayload(sources) {
  let payload = "";
  for (const { marker, file } of SECTIONS) {
    const text = sources[file];
    for (const line of text.split("\n")) {
      if (ALL_MARKERS.includes(line)) throw new Error(`src/${file} 含有保留的標記行：${line}`);
    }
    // .ps1 把整段負載放在 <# #> 區塊註解裡，出現 "#>" 會讓註解提早結束。
    if (text.includes("#>")) throw new Error(`src/${file} 含有 "#>"，會提早結束 PowerShell 的區塊註解`);
    payload += `${marker}\n${text}`;
  }
  return `${payload}${END_MARKER}\n`;
}

export function buildInstallers(sources) {
  const payload = buildPayload(sources);
  return {
    shell: `${sources["wrapper.sh"]}: <<'${END_MARKER}'\n${payload}`,
    // PowerShell 5.1 沒有 BOM 就會用 ANSI 代碼頁解讀檔案，中文訊息會變亂碼。
    powershell: `${BOM}${sources["wrapper.ps1"]}<#\n${payload}#>\n`,
  };
}

function main() {
  const sources = Object.fromEntries(
    ["wrapper.sh", "wrapper.ps1", ...SECTIONS.map((section) => section.file)]
      .map((name) => [name, readSource(name)]),
  );
  const installerVersion = /const INSTALLER_VERSION = "([^"]+)";/.exec(sources["installer.mjs"])?.[1];
  if (!installerVersion) throw new Error("src/installer.mjs 缺少 INSTALLER_VERSION");
  const releases = JSON.parse(readFileSync(releasesPath, "utf8"));
  if (releases.latest !== installerVersion) {
    throw new Error(`releases.json latest=${releases.latest} 與 INSTALLER_VERSION=${installerVersion} 不一致`);
  }

  const built = buildInstallers(sources);
  if (process.argv.includes("--check")) {
    const stale = [];
    const shell = readText(shellPath);
    if (shell.hasBom || shell.text !== built.shell) stale.push("codex-model-router.sh");
    const powershell = readText(powershellPath);
    if ((powershell.hasBom ? BOM : "") + powershell.text !== built.powershell) stale.push("codex-model-router.ps1");
    if (stale.length) {
      console.error(`${stale.join("、")} 與 src/ 不一致；請執行 node tools/build.mjs`);
      process.exit(1);
    }
    console.log("installers in sync with src/");
    return;
  }

  writeFileSync(shellPath, built.shell, "utf8");
  writeFileSync(powershellPath, built.powershell, "utf8");
  console.log(`built codex-model-router.sh and codex-model-router.ps1 (${installerVersion})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
