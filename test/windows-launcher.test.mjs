// Windows 背景服務的守護迴圈。
//
// 1.22.5 以前用 VBScript。微軟預計約 2027 年起預設停用 VBScript（改為選用功能），
// 新裝的服務會直接起不來；改用同一個 wscript 執行的 JScript。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
const { jscriptLauncher } = installer;

const commandOf = (script) => JSON.parse(/var command = (".*");/.exec(script)[1]);

test("命令列原樣嵌進 JScript 字串，引號、反斜線與中文都不走樣", () => {
  const command = 'cmd.exe /d /s /c ""C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\王小明\\.codex\\model-router\\router.mjs" >>"C:\\log.txt" 2>&1"';
  const script = jscriptLauncher(command);
  assert.equal(commandOf(script), command);
  assert.doesNotThrow(() => new Function(script), "產出的必須是合法的 JScript／JavaScript 語法");
  assert.doesNotMatch(script, /Dim |CreateObject|Option Explicit/, "不能再用 VBScript");
  assert.match(script, /WScript\.Sleep\(3000\)/, "保留 3 秒節流");
});

test("U+2028／U+2029 會被跳脫（在 ES3 字串裡它們是換行）", () => {
  const script = jscriptLauncher("a\u2028b\u2029c");
  assert.ok(!script.includes("\u2028") && !script.includes("\u2029"));
  assert.equal(commandOf(script), "a\u2028b\u2029c");
});

test("Windows：wscript 以 JScript 執行守護迴圈，命令結束後會重新啟動", { skip: process.platform !== "win32", timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "router-launcher-"));
  const marker = join(directory, "啟動紀錄.txt");
  const launcher = join(directory, "router-launcher.js");
  const script = jscriptLauncher(`cmd.exe /d /s /c "echo launched>>"${marker}""`);
  // 與安裝器相同：UTF-16LE 加 BOM，WSH 才不會用 ANSI 代碼頁讀檔。
  writeFileSync(launcher, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(script, "utf16le")]));
  const wscript = join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
  const child = spawn(wscript, ["//nologo", "//B", "//E:jscript", launcher], { windowsHide: true });
  try {
    const launches = () => existsSync(marker) ? readFileSync(marker, "utf8").trim().split(/\r?\n/).length : 0;
    for (let waited = 0; waited < 20000 && launches() < 2; waited += 200) await delay(200);
    assert.ok(launches() >= 2, `只啟動了 ${launches()} 次`);
  } finally {
    execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  }
});

test("Windows：安裝前的 Windows Script Host 檢查在正常系統上通過", { skip: process.platform !== "win32" }, () => {
  assert.doesNotThrow(() => installer.assertScriptHostAvailable());
});
