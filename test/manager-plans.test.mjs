// 網頁管理介面背後的純函式：排序、修改、手動排序下新增模型、捷徑與一鍵更新的核對。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer, managerPage } = await loadPayloads();
const shellPath = fileURLToPath(new URL("../codex-model-router.sh", import.meta.url));
const powershellPath = fileURLToPath(new URL("../codex-model-router.ps1", import.meta.url));
const releases = JSON.parse(readFileSync(new URL("../releases.json", import.meta.url), "utf8"));

const routes = [
  { pickerSlug: "custom/a", upstreamModel: "ark/a", displayName: "ark/a", efforts: ["high"], contextWindow: 200000 },
  { pickerSlug: "custom/b", upstreamModel: "b", displayName: "api/b", efforts: [] },
  { pickerSlug: "custom/c", upstreamModel: "c", displayName: "claude-cli/c", providerId: "claude-cli", transport: "claude-cli", translate: "anthropic", efforts: ["low"], contextWindow: 1000000 },
];
const fixture = () => ({
  manifest: { version: "1.27.0", routes: structuredClone(routes), keep: "manifest" },
  settings: { version: "1.27.0", port: 48953, routes: structuredClone(routes), keep: "settings" },
  catalog: { keep: "catalog", models: [
    { slug: "gpt-official", priority: 30, visibility: "list" },
    { slug: "custom/a", display_name: "ark/a", priority: 31, context_window: 200000, max_context_window: 200000, effective_context_window_percent: 95 },
    { slug: "gpt-official-2", priority: 40, visibility: "list" },
    { slug: "custom/b", display_name: "api/b", priority: 32, context_window: 272000 },
    { slug: "custom/c", display_name: "claude-cli/c", priority: 33, context_window: 1000000 },
  ] },
});

test("排序：自訂模型依新順序排在官方模型之後，其他欄位與設定保留，並記為手動排序", () => {
  const before = fixture();
  const original = structuredClone(before);
  const plan = installer.planReorderModels(before.manifest, before.settings, before.catalog, ["custom/c", "custom/a", "custom/b"]);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.catalog.models.map((model) => model.slug), ["gpt-official", "gpt-official-2", "custom/c", "custom/a", "custom/b"]);
  assert.deepEqual(plan.catalog.models.slice(2).map((model) => model.priority), [41, 42, 43]);
  assert.equal(plan.catalog.models[3].context_window, 200000);
  assert.equal(plan.catalog.keep, "catalog");
  assert.equal(plan.settings.customModelOrder, "manual");
  assert.deepEqual(plan.settings.routes, routes, "路由本身不動");
  assert.equal(plan.manifest, before.manifest);
  assert.deepEqual(before, original, "不能改動傳入的物件");
  assert.equal(installer.planReorderModels(before.manifest, before.settings, before.catalog, ["custom/a", "custom/b", "custom/c"]).changed, false);
  for (const slugs of [["custom/a", "custom/b"], ["custom/a", "custom/a", "custom/b"], ["custom/a", "custom/b", "gpt-official"], "custom/a", null]) {
    assert.throws(() => installer.planReorderModels(before.manifest, before.settings, before.catalog, slugs), /排序清單與目前的自訂模型不一致/);
  }
  assert.throws(() => installer.planReorderModels(before.manifest, { routes: null }, before.catalog, []));
});

test("修改：名稱與上下文同步寫進路由、install.json 與模型目錄；不合理的值擋下", () => {
  const before = fixture();
  const original = structuredClone(before);
  const plan = installer.planEditModel(before.manifest, before.settings, before.catalog, "custom/b", { displayName: "  我的   模型 ", contextWindow: 400000 });
  assert.equal(plan.changed, true);
  const route = plan.settings.routes.find((item) => item.pickerSlug === "custom/b");
  assert.deepEqual([route.displayName, route.contextWindow, route.upstreamModel], ["我的 模型", 400000, "b"]);
  assert.deepEqual(plan.manifest.routes.find((item) => item.pickerSlug === "custom/b").contextWindow, 400000);
  const entry = plan.catalog.models.find((model) => model.slug === "custom/b");
  assert.deepEqual([entry.display_name, entry.context_window, entry.max_context_window, entry.effective_context_window_percent], ["我的 模型", 400000, 400000, 95]);
  assert.equal(plan.catalog.models.find((model) => model.slug === "custom/a").display_name, "ark/a", "其他模型不動");
  assert.deepEqual(before, original);

  const nameOnly = installer.planEditModel(before.manifest, before.settings, before.catalog, "custom/a", { displayName: "A", contextWindow: null });
  assert.equal(nameOnly.catalog.models.find((model) => model.slug === "custom/a").context_window, 200000);
  assert.equal(nameOnly.settings.routes[0].contextWindow, 200000);
  assert.equal(installer.planEditModel(before.manifest, before.settings, before.catalog, "custom/a", { displayName: "ark/a", contextWindow: 200000 }).changed, false);

  const fail = (slug, changes, pattern) => assert.throws(() => installer.planEditModel(before.manifest, before.settings, before.catalog, slug, changes), pattern);
  fail("custom/a", { displayName: "   " }, /不能是空白/);
  fail("custom/a", { displayName: "x".repeat(81) }, /最多 80 個字/);
  fail("custom/a", { displayName: "a\u0007b" }, /控制字元/);
  fail("custom/a", { contextWindow: 1000 }, /16,000 到 4,000,000/);
  fail("custom/a", { contextWindow: 272000.5 }, /整數/);
  fail("custom/c", { contextWindow: 2000000 }, /16,000 到 1,000,000/);
  fail("gpt-official", { displayName: "x" }, /不是已配置的自訂模型/);
  fail("custom/missing", { displayName: "x" }, /不是已配置的自訂模型/);
});

test("手動排序後再新增模型：既有模型位置不變，新模型依探測清單順序接在最後", () => {
  const official = [{ slug: "gpt-official", priority: 30 }];
  const custom = [{ slug: "custom/x" }, { slug: "custom/y" }, { slug: "custom/new2" }, { slug: "custom/new1" }];
  const allRoutes = [
    { pickerSlug: "custom/x", upstreamModel: "x" },
    { pickerSlug: "custom/y", upstreamModel: "y", providerId: "other" },
    { pickerSlug: "custom/new2", upstreamModel: "n2" },
    { pickerSlug: "custom/new1", upstreamModel: "n1" },
  ];
  const current = { models: [{ slug: "gpt-official" }, { slug: "custom/y" }, { slug: "custom/x" }] };
  const manual = installer.arrangeCustomModels(official, custom, allRoutes, ["default", "other"],
    { providerId: "default", models: ["n1", "x", "n2"] }, current, { manual: true });
  assert.deepEqual(manual.map((model) => model.slug), ["custom/y", "custom/x", "custom/new1", "custom/new2"]);
  assert.deepEqual(manual.map((model) => model.priority), [31, 32, 33, 34]);
  const automatic = installer.arrangeCustomModels(official, custom, allRoutes, ["default", "other"],
    { providerId: "default", models: ["n1", "x", "n2"] }, current);
  assert.deepEqual(automatic.map((model) => model.slug), ["custom/new1", "custom/x", "custom/new2", "custom/y"], "預設仍依供應商分組與探測順序");
});

test("planAddModels 只加新的路由、沿用強制顯示，手動排序時新模型排在最後", () => {
  const templates = { schema: 1, models: [
    { slug: "gpt-5.6-sol", priority: 10, visibility: "hide", display_name: "Sol", context_window: 272000, supported_reasoning_levels: [] },
    { slug: "gpt-6-sol", priority: 11, visibility: "list", display_name: "6", context_window: 400000, supported_reasoning_levels: [] },
  ] };
  const providers = [{ id: "default", baseUrl: "https://gw.example", apiRoot: "https://gw.example/v1", keychainService: "svc", keychainAccount: "codex", credentialPath: null }];
  const existing = [{ pickerSlug: "custom/old", upstreamModel: "old", displayName: "api/old", providerHost: "gw.example", efforts: ["high"], contextWindow: 123456 }];
  const settings = { version: "1.26.0", port: 1, routes: existing, providers, forceListedModels: ["gpt-5.6-sol"], customModelOrder: "manual" };
  const manifest = { version: "1.26.0", routes: existing, providers };
  const catalog = { models: [...templates.models, { slug: "custom/old", display_name: "我改過的名字", priority: 12, context_window: 123456 }] };
  const fresh = { pickerSlug: "custom/new", upstreamModel: "new", displayName: "api/new", providerHost: "gw.example", efforts: ["low", "high"], contextWindow: null };
  const plan = installer.planAddModels(manifest, settings, catalog, templates, providers[0], [existing[0], fresh], ["new", "old"], "/bin/codex");
  assert.deepEqual(plan.added.map((route) => route.pickerSlug), ["custom/new"]);
  assert.deepEqual(plan.settings.routes.map((route) => route.pickerSlug), ["custom/old", "custom/new"]);
  assert.equal(plan.settings.version, releases.latest);
  assert.equal(plan.settings.codexBin, "/bin/codex");
  assert.equal(plan.settings.customModelOrder, "manual");
  assert.equal(plan.manifest.baseUrl, "https://gw.example", "install.json 保留主要供應商的舊欄位");
  const slugs = plan.catalog.models.map((model) => model.slug);
  assert.deepEqual(slugs, ["gpt-5.6-sol", "gpt-6-sol", "custom/old", "custom/new"], "手動排序：舊的在前，新的接最後");
  assert.equal(plan.catalog.models[0].visibility, "list", "強制顯示的官方模型維持顯示");
  assert.equal(plan.catalog.models[2].display_name, "我改過的名字", "既有自訂項目原樣保留");
  assert.throws(() => installer.planAddModels(manifest, settings, catalog, templates, providers[0], [existing[0]], [], null), /都已配置/);
  assert.throws(() => installer.planAddModels(manifest, settings, catalog, templates, { id: "nope" }, [fresh], [], null), /找不到供應商/);
  assert.throws(() => installer.planAddModels(manifest, settings, catalog, templates, providers[0], [{ ...fresh, providerId: "x" }], [], null), /不一致/);
});

test("捷徑位置：macOS 放在 ~/Applications，Windows 放在開始功能表，可由環境變數改到別處", () => {
  assert.equal(installer.managerShortcutPath("darwin", { home: "/Users/me", directory: "" }), "/Users/me/Applications/Codex 模型路由器.command");
  assert.equal(installer.managerShortcutPath("win32", { home: "C:\\Users\\me", appData: "C:\\Users\\me\\AppData\\Roaming", directory: "" }),
    "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Codex 模型路由器.lnk");
  assert.equal(installer.managerShortcutPath("win32", { home: "C:\\Users\\me", appData: "", directory: "" }),
    "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Codex 模型路由器.lnk");
  assert.equal(installer.managerShortcutPath("darwin", { home: "/Users/me", directory: "/tmp/x" }), "/tmp/x/Codex 模型路由器.command");
});

test("macOS 捷徑以 bash 執行安裝器副本的 ui，路徑含空白與引號也安全", { skip: process.platform === "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "router manager 'shortcut' "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installerCopy = join(root, "it's here", "codex-model-router.sh");
  mkdirSync(join(root, "it's here"));
  const output = join(root, "out.txt");
  writeFileSync(installerCopy, "printf '%s|' \"$@\" > \"$OUT\"\nprintf '%s|%s' \"$CODEX_HOME\" \"$CODEX_MODEL_ROUTER_HOME\" >> \"$OUT\"\n");
  const shortcut = join(root, "Codex 模型路由器.command");
  const tricky = join(root, "home $(x) \u0060y\u0060");
  const text = installer.managerCommandFile({ installer: installerCopy, launchEnv: { CODEX_HOME: tricky, CODEX_MODEL_ROUTER_HOME: join(root, "r'r") } });
  assert.match(text, /^#!\/bin\/bash\n/);
  writeFileSync(shortcut, text);
  chmodSync(shortcut, 0o755);
  const result = spawnSync(shortcut, ["ignored file $(bad).txt", "--help"], { env: { ...process.env, OUT: output }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), "ui|" + tricky + "|" + join(root, "r'r"));
  assert.doesNotMatch(installer.managerCommandFile({ installer: "/a.sh" }), /export/, "預設位置不寫環境變數");
});

test("Windows 捷徑以 GUI wscript 執行啟動器，路徑含空白、中文與單引號也安全", () => {
  const plain = installer.windowsShortcutScript({
    shortcut: "C:\\Users\\me\\Start\\Codex 模型路由器.lnk", launcher: "C:\\Users\\me\\.codex\\model-router\\manager-open.js",
    workingDirectory: "C:\\Users\\me\\.codex\\model-router",
  });
  assert.ok(plain.includes("$link.Arguments = '//nologo //B //E:jscript \"C:\\Users\\me\\.codex\\model-router\\manager-open.js\"'"), plain);
  assert.ok(plain.includes("System32\\wscript.exe"));
  assert.match(plain, /\$link\.Save\(\)$/);
  const custom = installer.windowsShortcutScript({
    shortcut: "C:\\x\\y.lnk", launcher: "D:\\王小明 O'Brien\\manager-open.js", workingDirectory: "D:\\O'Brien",
  });
  const expected = "$link.Arguments = '//nologo //B //E:jscript \"D:\\王小明 O''Brien\\manager-open.js\"'";
  assert.ok(custom.includes(expected), custom);
  assert.ok(custom.includes("$link.WorkingDirectory = 'D:\\O''Brien'"));
  const pwsh = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
    "$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$errors); if ($errors) { $errors | ForEach-Object { $_.ToString() }; exit 1 }"],
  { input: plain + "\n" + custom, encoding: "utf8" });
  if (pwsh.error) return; // 沒有 pwsh 時只做字串檢查
  assert.equal(pwsh.status, 0, pwsh.stdout + pwsh.stderr);
});

test("Windows 啟動器隱藏 PowerShell，只傳 ui，並用子程序環境傳遞自訂安裝位置", () => {
  const calls = [];
  const values = {};
  const installed = "D:\\王小明 O'Brien $(bad)\\codex-model-router.ps1";
  const home = "D:\\home\u2028folder\u2029name";
  const shell = { Environment: () => ({ Item: (key) => values[key] }),
    ExpandEnvironmentStrings: value => value.replace("%SystemRoot%", "C:\\Windows"),
    Run: (...args) => { calls.push(args); return 17; } };
  // WSH 的 Environment.Item 是可寫 COM 屬性；以 Proxy 模擬，驗證實際傳出去的值。
  shell.Environment = () => new Proxy({}, { set(target, key, value) { values[key] = value; return true; } });
  let script = installer.windowsManagerLauncher({ installer: installed, launchEnv: { CODEX_HOME: home } });
  assert.ok(!script.includes("\u2028") && !script.includes("\u2029"));
  // COM 屬性賦值語法在 JScript 有效，Node 不支援；只轉換這個屬性存取，其他原樣執行。
  script = script.replace(/processEnv\.Item\(("[^"]+")\) = /g, "processEnv[$1] = ");
  let result;
  runInNewContext(script, { ActiveXObject: function () { return shell; }, WScript: { Quit: code => { result = code; } } });
  assert.deepEqual(calls[0], ['"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + installed + '" ui', 0, true]);
  assert.equal(values.CODEX_HOME, home);
  assert.equal(result, 17);
});

test("Codex MCP 入口沿用指定 Node 與安裝位置；回退保留使用者修改及其他伺服器", () => {
  const key = "mcp_servers.model_router_manager";
  const entry = installer.managerMcpConfig({ node: "/my node/node", entry: "/my home/manager-entry.mjs" });
  assert.deepEqual(entry, { command: "/my node/node", args: ["/my home/manager-entry.mjs"], startup_timeout_sec: 10 });
  const config = { mcp_servers: { model_router_manager: structuredClone(entry), other: { command: "keep" } } };
  assert.deepEqual(installer.managerMcpRollbackEdit(config, { installed: entry, previous: null }), { keyPath: key, value: null });
  assert.deepEqual(installer.managerMcpRollbackEdit(config, { installed: entry, previous: { command: "Previous" } }), { keyPath: key, value: { command: "Previous" } });
  config.mcp_servers.model_router_manager.args.push("manual");
  assert.equal(installer.managerMcpRollbackEdit(config, { installed: entry }), null, "使用者修改後不覆蓋");
  assert.deepEqual(config.mcp_servers.other, { command: "keep" });
  const legacy = { command: "/bin/bash", args: ["manager-open.sh"] };
  const legacyConfig = { desktop: { custom_file_handlers: { model_router_manager: legacy, keep: { label: "Keep" } } } };
  assert.deepEqual(installer.managerHandlerRollbackEdit(legacyConfig, { installed: legacy, previous: null }),
    { keyPath: "desktop.custom_file_handlers.model_router_manager", value: null });
  assert.equal(installer.managerHandlerRollbackEdit(legacyConfig, { installed: { command: "other" } }), null);
});

test("從 Codex 執行檔路徑找出桌面版的 App bundle", () => {
  assert.equal(installer.desktopAppBundle("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"), "/Applications/ChatGPT.app");
  assert.equal(installer.desktopAppBundle("/Users/me/Applications/Codex.app/Contents/Resources/codex"), "/Users/me/Applications/Codex.app");
  assert.equal(installer.desktopAppBundle("/opt/homebrew/bin/codex"), null);
  assert.equal(installer.desktopAppBundle(null), null);
});

test("一鍵更新的核對：SHA256SUMS 解析，以及下載內容的格式、版本與內嵌段落", () => {
  const sums = installer.parseSha256Sums("A".repeat(64) + "  codex-model-router.sh\n" + "b".repeat(64) + " *codex-model-router.ps1\r\nnot a line\n");
  assert.deepEqual(sums, { "codex-model-router.sh": "a".repeat(64), "codex-model-router.ps1": "b".repeat(64) });
  const shell = readFileSync(shellPath);
  const powershell = readFileSync(powershellPath);
  assert.doesNotThrow(() => installer.verifyInstallerScript(shell, releases.latest, "darwin"));
  assert.doesNotThrow(() => installer.verifyInstallerScript(powershell, releases.latest, "win32"));
  assert.throws(() => installer.verifyInstallerScript(shell, "9.9.9", "darwin"), /不是 9\.9\.9 版/);
  assert.throws(() => installer.verifyInstallerScript(powershell, releases.latest, "darwin"), /不是預期的安裝器格式/);
  assert.throws(() => installer.verifyInstallerScript(shell, releases.latest, "win32"), /不是預期的安裝器格式/);
  const truncated = shell.subarray(0, shell.length - 200);
  assert.throws(() => installer.verifyInstallerScript(truncated, releases.latest, "darwin"), /不完整/);
  assert.equal(createHash("sha256").update(shell).digest("hex").length, 64);
});

test("路由器記錄只挑出故障相關的行，新的在前，並清掉控制字元", () => {
  const log = [
    "model-router-ready:127.0.0.1:48953",
    'model-router-error:{"at":"2026-10-08T01:02:03.000Z","requestId":"abc123","code":"upstream_http_error","status":502,"message":"上游服務返回 HTTP 502。","model":"custom/x","provider":"owo","upstreamHost":"relay.example","upstreamStatus":502}',
    "model-router-error:fetch failed",
    "model-router-catalog-refresh-failed:status=503;using-cache",
    "model-router-image-budget:{}",
    "model-router-websocket-error:TypeError: fetch failed\u001b[31m",
    "其他雜訊",
    "model-router-error:{broken json",
  ].join("\n");
  const entries = installer.parseRouterLog(log);
  assert.deepEqual(entries.map((entry) => entry.kind), ["error", "websocket-error", "catalog-refresh-failed", "error", "error"]);
  assert.equal(entries[0].message, "{broken json");
  assert.equal(entries[1].message, "TypeError: fetch failed");
  const structured = entries[4];
  assert.deepEqual([structured.code, structured.status, structured.requestId, structured.provider, structured.upstreamStatus], ["upstream_http_error", 502, "abc123", "owo", 502]);
  assert.equal(installer.parseRouterLog(log, 2).length, 2);
});

test("內嵌的網頁管理介面在 .sh 與 .ps1 中一致，Claude CLI 段不會吃進後面的內容", () => {
  const page = installer.loadManagerPage(shellPath);
  assert.equal(page, managerPage);
  assert.equal(installer.loadManagerPage(powershellPath), page);
  assert.equal(installer.loadManagerSource(powershellPath), installer.loadManagerSource(shellPath));
  assert.equal(installer.loadManagerEntrySource(powershellPath), installer.loadManagerEntrySource(shellPath));
  assert.doesNotMatch(page, /export async function serveManagerEntry/);
  assert.match(installer.loadManagerSource(shellPath), /export function createManagerServer/);
  const claudeCli = installer.loadClaudeCliSource(shellPath);
  assert.doesNotMatch(claudeCli, /createManagerServer|<!doctype html>/i);
  assert.equal(claudeCli, installer.loadClaudeCliSource(powershellPath));
});
