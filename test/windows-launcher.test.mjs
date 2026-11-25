// Windows 背景服務的守護迴圈。
//
// 1.22.5 以前用 VBScript。微軟預計約 2027 年起預設停用 VBScript（改為選用功能），
// 新裝的服務會直接起不來；改用同一個 wscript 執行的 JScript。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer, dir } = await loadPayloads();
const { jscriptLauncher } = installer;
const scriptPath = fileURLToPath(new URL("../codex-model-router.sh", import.meta.url));
const releases = JSON.parse(readFileSync(new URL("../releases.json", import.meta.url), "utf8"));

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

test("Windows 英文系統也能建立中文名稱的管理頁捷徑，並清理暫存捷徑", { skip: process.platform !== "win32" }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "router-shortcut-unicode-"));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const shortcut = join(directory, "模型路由器.lnk");
  const launcher = join(directory, "manager-open.js");
  writeFileSync(launcher, "WScript.Quit(0);\r\n");
  const script = installer.windowsShortcutScript({ shortcut, launcher, workingDirectory: directory });
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 20000 });
  assert.equal(existsSync(shortcut), true);
  const bytes = readFileSync(shortcut);
  assert.equal(bytes.readUInt32LE(0), 0x4c, "有效的 Shell Link 標頭");
  assert.deepEqual(readdirSync(directory).sort(), ["模型路由器.lnk", "manager-open.js"].sort(), "不能留下暫存捷徑");
});

test("Windows 管理頁啟動器：真實 WSH 傳遞中文路徑，PowerShell 視窗不可見且開啟後退出", {
  skip: process.platform !== "win32", timeout: 45000,
}, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "router manager O'Brien 中文 "));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const ps1 = join(directory, "codex-model-router.ps1");
  const launcher = join(directory, "manager-open.js");
  const marker = join(directory, "結果.json");
  const ps = `param([string]$Action)
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class RouterWindowTest { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); }'
$result = @{ action = $Action; home = $env:CODEX_HOME; visible = [RouterWindowTest]::IsWindowVisible([RouterWindowTest]::GetConsoleWindow()) }
[IO.File]::WriteAllText($env:ROUTER_TEST_RESULT, ($result | ConvertTo-Json))
exit 17
`;
  writeFileSync(ps1, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ps, "utf16le")]));
  const script = installer.windowsManagerLauncher({ installer: ps1, launchEnv: { CODEX_HOME: directory, ROUTER_TEST_RESULT: marker } });
  writeFileSync(launcher, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(script, "utf16le")]));
  const child = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe"),
    ["//nologo", "//B", "//E:jscript", launcher, "ignored.txt"], { stdio: "ignore", windowsHide: true });
  t.after(() => { if (child.exitCode == null) execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); });
  const [code] = await once(child, "exit");
  assert.equal(code, 17, existsSync(marker) ? readFileSync(marker, "utf8") : "WSH 未完成啟動");
  const result = JSON.parse(readFileSync(marker, "utf8"));
  assert.deepEqual(result, { action: "ui", home: directory, visible: false });
});

test("Windows update：僅描述不同或只改啟動腳本不需重註冊；實質變更被拒時沿用舊定義並提示執行 update", {
  skip: process.platform !== "win32", timeout: 45000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "router-win-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  let source = readFileSync(join(dir, "installer.mjs"), "utf8");
  const replaceFunction = (name, body) => {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, name);
    const end = source.indexOf("\n}", start) + 2;
    source = source.slice(0, start) + `function ${name}(...args) {\n${body}\n}` + source.slice(end);
  };
  replaceFunction("startService", `
    serviceCalls.push({ fn: "startService", args });
    const action = args[0]?.action || "install";
    fail(scheduledTaskCreateFailure({
      detail: "ERROR: Access is denied.", denied: true, taskExists: true, elevated: false, taskName, action,
    }));
  `);
  replaceFunction("restartServiceInPlace", 'serviceCalls.push({ fn: "restartServiceInPlace" });');
  replaceFunction("stopService", 'serviceCalls.push({ fn: "stopService" });');
  replaceFunction("restrictAcl", "");
  replaceFunction("installManagerLauncher", "return { ok: false };");
  const harness = join(root, "win-update-fixture.mjs");
  writeFileSync(harness, `${source}
import http from "node:http";
const assert = (await import("node:assert/strict")).default;
const serviceCalls = [];
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "ok", version: INSTALLER_VERSION }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
try {
  ensureDirectory(installRoot);
  const provider = { id: "default", baseUrl: "https://example.invalid", apiRoot: "https://example.invalid/v1", keychainService: "fixture.win" };
  writeJsonAtomic(settingsPath, { version: "1.37.0", port, codexIntegration: false, catalogRefresh: false, providers: [provider], routes: [] });
  writeJsonAtomic(manifestPath, { version: "1.37.0", port, codexIntegration: false, providers: [provider], routes: [] });
  writeFileSync(catalogPath, JSON.stringify({ models: [] }));
  writeFileSync(routerPath, "// old\\n");
  // 1) 舊版 service-task.xml 只差在 <Description>：應直接原地重啟，不呼叫 startService。
  const oldDescXml = taskXmlDocument().replace(
    "<Description>模型路由器（本機回送代理）</Description>",
    "<Description>Codex 模型路由器（本機回送代理）</Description>",
  );
  writeFileSync(launcherPath, utf16leWithBom(launcherScript()));
  writeFileSync(taskXmlPath, utf16leWithBom(oldDescXml));
  await update();
  assert.deepEqual(serviceCalls, [{ fn: "restartServiceInPlace" }]);
  // 2) 只改了 router-launcher.js（例如 Node 路徑更新），排程 XML 實質一致：原地重寫啟動腳本並重啟，不呼叫 startService。
  serviceCalls.length = 0;
  writeFileSync(launcherPath, utf16leWithBom("// stale launcher\\r\\n"));
  await update();
  assert.deepEqual(serviceCalls, [{ fn: "restartServiceInPlace" }]);
  assert.equal(Buffer.compare(readFileSync(launcherPath), utf16leWithBom(launcherScript())), 0);
  // 3) 排程 XML 有實質變更（舊版 .vbs 啟動器），重註冊遇權限不足：還原舊 XML、原地重啟並輸出正確 update 提示。
  serviceCalls.length = 0;
  const vbsXml = taskXmlDocument().replace(
    "//nologo //B //E:jscript",
    "//nologo //B",
  ).replace("router-launcher.js", "router-launcher.vbs");
  writeFileSync(taskXmlPath, utf16leWithBom(vbsXml));
  await update();
  assert.ok(serviceCalls.some((call) => call.fn === "startService" && call.args[0]?.action === "update"));
  assert.ok(serviceCalls.some((call) => call.fn === "restartServiceInPlace"));
  assert.equal(Buffer.compare(readFileSync(taskXmlPath), utf16leWithBom(vbsXml)), 0);
  console.log("WIN_UPDATE_FIXTURE_OK");
} finally {
  server.close();
}
`);
  const child = spawn(process.execPath, [harness], {
    env: {
      ...process.env,
      CODEX_HOME: root,
      CODEX_MODEL_ROUTER_HOME: join(root, "model-router"),
      CODEX_MODEL_ROUTER_CREDENTIALS_DIR: join(root, "creds"),
      CODEX_MODEL_ROUTER_SHORTCUT_DIR: join(root, "shortcuts"),
      CODEX_MODEL_ROUTER_SCRIPT_PATH: scriptPath,
      CODEX_MODEL_ROUTER_NODE_BIN: process.execPath,
      CODEX_MODEL_ROUTER_IMPORT_ONLY: "1",
      CODEX_MODEL_ROUTER_TEST_MODE: "1",
      CODEX_MODEL_ROUTER_TEST_NO_CODEX: "1",
      CODEX_MODEL_ROUTER_RELEASES_JSON: JSON.stringify(releases),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 0, output);
  assert.match(output, /WIN_UPDATE_FIXTURE_OK/);
  const warnings = output.match(/注意：服務定義有更新/g) || [];
  assert.equal(warnings.length, 1, `前兩次更新不應警告，第三次實質變更才警告：\n${output}`);
  assert.match(output, /執行一次 update（保留現有設定）/, output);
  assert.doesNotMatch(output, /安裝或重新配置/, output);
});
