// Windows「下載」已知資料夾的偵測。
//
// 1.22.5 以前登錄路徑寫在一般字串裡，\S、\M 這些不是跳脫字元，反斜線被 JS 靜默吃掉，
// 實際查的是 HKCU:SOFTWAREMicrosoft...，於是偵測從未成功、一律退回預設的
// %USERPROFILE%\Downloads。這種錯誤執行時不會報錯，所以用測試與 ESLint 一起擋。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
const { USER_SHELL_FOLDERS_KEY, migratedImageOutputDir } = installer;

test("登錄路徑保留每一個反斜線", () => {
  assert.equal(
    USER_SHELL_FOLDERS_KEY,
    "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
  );
});

test("Windows 上這個登錄機碼真的存在", { skip: process.platform !== "win32" }, () => {
  const script = `Test-Path -LiteralPath '${USER_SHELL_FOLDERS_KEY.replaceAll("'", "''")}'`;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true,
  });
  assert.equal(output.trim(), "True");
});

const defaultDir = "C:\\Users\\me\\Downloads";

test("仍是舊版寫入的預設值、而「下載」已搬走時，改用實際位置", () => {
  assert.equal(migratedImageOutputDir(defaultDir, "D:\\Downloads", defaultDir), "D:\\Downloads");
  // 大小寫與結尾斜線不同仍算同一個預設值（Windows 路徑不分大小寫）。
  assert.equal(migratedImageOutputDir("c:\\users\\me\\downloads\\", "D:\\Downloads", defaultDir), "D:\\Downloads");
});

test("使用者自己改過的位置一律保留", () => {
  assert.equal(migratedImageOutputDir("E:\\Pictures\\codex", "D:\\Downloads", defaultDir), null);
});

test("「下載」沒搬走或偵測不到時不改", () => {
  assert.equal(migratedImageOutputDir(defaultDir, defaultDir, defaultDir), null);
  assert.equal(migratedImageOutputDir(defaultDir, null, defaultDir), null);
  assert.equal(migratedImageOutputDir(defaultDir, "", defaultDir), null);
  assert.equal(migratedImageOutputDir(undefined, "D:\\Downloads", defaultDir), null);
});
