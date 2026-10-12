import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { runInNewContext } from "node:vm";
import { loadPayloads } from "./helpers/payloads.mjs";

const { managerEntry: entry } = await loadPayloads();
const message = (method, params = {}, id = 1) => ({ jsonrpc: "2.0", id, method, params });

test("MCP 全域入口只提供開啟管理頁，拒絕其他工具、任意資源與額外參數", async () => {
  let runs = 0, time = 1000;
  const handle = entry.createManagerEntryHandler({ version: "1.27.5", installer: "/installed.sh", locale: "zh-Hant", run: async () => { runs++; }, now: () => time });
  const tool = (await handle(message("tools/list"))).result.tools[0];
  assert.equal(tool.title, "自訂模型管理");
  assert.deepEqual(tool._meta["openai/ui"].entrypoints, [{ type: "global" }]);
  assert.equal(tool._meta["openai/globalHeader"], true);
  assert.notEqual(tool._meta.ui.resourceUri, entry.MANAGER_ENTRY_URI, "不沿用驗證版的快取 URI");
  assert.equal(tool._meta.ui.resourceUri, entry.managerEntryResourceUri("1.27.5", "zh-Hant"));
  assert.notEqual(entry.managerEntryResourceUri("1.27.5"), entry.managerEntryResourceUri("1.27.6"));
  assert.equal((await handle(message("resources/read", { uri: "file:///secret" }))).error.code, -32002);
  assert.equal((await handle(message("tools/call", { name: "set_api_key" }))).error.code, -32602);
  assert.equal((await handle(message("tools/call", { name: entry.MANAGER_ENTRY_NAME, arguments: { command: "other" } }))).error.code, -32602);
  assert.equal(runs, 0);
  const resource = (await handle(message("resources/read", { uri: entry.MANAGER_ENTRY_URI }))).result.contents[0];
  assert.equal(resource.mimeType, "text/html;profile=mcp-app");
  assert.match(resource.text, /開啟管理頁/);
  assert.equal(runs, 0, "列清單與讀 UI 不會開瀏覽器");
  const open = () => handle(message("tools/call", { name: entry.MANAGER_ENTRY_NAME, arguments: {} }));
  assert.equal((await open()).result.structuredContent.opened, true);
  assert.equal((await open()).result.structuredContent.opened, true);
  assert.equal(runs, 1, "初始化時兩次工具通知不重複開瀏覽器");
  const reopened = await handle(message("tools/call", { name: entry.MANAGER_ENTRY_NAME, arguments: { reopen: true } }));
  assert.equal(reopened.result.structuredContent.opened, true);
  assert.equal(runs, 2, "使用者重開時不會被兩秒內的初始化去重擋下");
  time += 3000;
  await open();
  assert.equal(runs, 3, "之後可再次開啟");
  assert.equal((await handle(null)).error.code, -32600);
});

test("MCP stdio 對 malformed JSON 回報錯誤，通知無回應，啟動失敗不標成成功", async () => {
  const lines = ["{bad", JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify(message("initialize", { protocolVersion: "2025-06-18" }, 1)),
    JSON.stringify(message("tools/call", { name: entry.MANAGER_ENTRY_NAME }, 2)),
    JSON.stringify(message("ping", {}, 3))].join("\n") + "\n";
  let output = "";
  await entry.serveManagerEntry({ version: "1.27.5", installer: "/installed.sh", locale: "zh-Hant", run: async () => { throw new Error("啟動失敗"); } }, {
    input: Readable.from([lines.slice(0, 12), lines.slice(12)]),
    output: new Writable({ write(chunk, encoding, done) { output += chunk; done(); } }),
  });
  const replies = output.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(replies.map(reply => reply.id), [null, 1, 2, 3]);
  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies[1].result.serverInfo.title, "自訂模型管理");
  assert.equal(replies[2].result.isError, true);
  assert.equal(replies[2].result.structuredContent.opened, false);
  assert.deepEqual(replies[3].result, {});
});

test("入口名稱跟隨 Codex 語言：localeOverride 優先，其次系統偏好語言，無法對應時用英文", async () => {
  const cases = { "zh-Hant-TW": "zh-Hant", "zh_TW.UTF-8": "zh-Hant", "zh-HK": "zh-Hant", "zh-Hans-CN": "zh-Hans", "zh-CN": "zh-Hans", zh: "zh-Hans", "en-GB": "en", "ja-JP": null, "": null };
  for (const [tag, expected] of Object.entries(cases)) assert.equal(entry.entryLocaleFrom(tag), expected, tag);
  const config = "[desktop.other]\nlocaleOverride = \"en\"\n[desktop]\nfoo = 1\nlocaleOverride = \"zh-CN\"\n[x]\nlocaleOverride = \"ja\"\n";
  assert.equal(entry.codexLocaleOverride(config), "zh-CN");
  assert.equal(entry.codexLocaleOverride("[desktop]\nlocaleOverride = \"\"\n"), null);
  const detect = (options) => entry.detectEntryLocale({ codexHome: "/codex", env: {}, intlLocale: () => "en-US", ...options });
  const mac = output => ({ platform: "darwin", run: () => output });
  assert.equal(detect({ ...mac('(\n    "zh-Hant-TW",\n    "ja-TW"\n)\n'), readText: () => "" }), "zh-Hant");
  assert.equal(detect({ ...mac('(\n    "ja-JP",\n    "zh-Hant-TW"\n)\n'), readText: () => "" }), "en", "Codex 顯示日文時用英文");
  assert.equal(detect({ ...mac('(\n    "zh-Hant-TW"\n)\n'), readText: () => config }), "zh-Hans", "localeOverride 優先於系統語言");
  assert.equal(detect({ ...mac('("zh-Hant-TW")'), readText: () => "[desktop]\nlocaleOverride = \"fr-FR\"\n" }), "en");
  assert.equal(detect({ platform: "linux", env: { LANG: "zh_CN.UTF-8" }, readText: () => { throw new Error("missing"); } }), "zh-Hans");
  assert.equal(detect({ platform: "linux", env: { LANG: "C.UTF-8" }, readText: () => "" }), "en");
  assert.equal(detect({ platform: "win32", env: {}, readText: () => "", run: () => "\r\nHKEY_CURRENT_USER\\Control Panel\\International\\User Profile\r\n    Languages    REG_MULTI_SZ    zh-Hant-TW\\0en-US\r\n" }), "zh-Hant");
  assert.equal(detect({ platform: "win32", env: {}, readText: () => "", run: () => { throw new Error("no reg"); }, intlLocale: () => "zh-CN" }), "zh-Hans");

  for (const [locale, title, opened] of [["zh-Hans", "自定义模型管理", "管理页已在浏览器中打开。"], ["en", "Custom Model Manager", "The manager is open in your browser."]]) {
    const handle = entry.createManagerEntryHandler({ version: "1.30.1", installer: "/installed.sh", locale, run: async () => {}, now: () => 0 });
    assert.equal((await handle(message("tools/list"))).result.tools[0].title, title);
    assert.equal((await handle(message("initialize"))).result.serverInfo.title, title);
    const html = (await handle(message("resources/read", { uri: entry.MANAGER_ENTRY_URI }))).result.contents[0].text;
    assert.match(html, new RegExp(`<html lang="${locale}">[\\s\\S]*<h1>${title}</h1>`));
    assert.doesNotMatch(html, /__[A-Z]+__/);
    assert.equal((await handle(message("tools/call", { name: entry.MANAGER_ENTRY_NAME, arguments: {} }))).result.content[0].text, opened);
  }
  assert.equal(entry.managerEntryTool({ locale: "ja" }).title, "Custom Model Manager");
  assert.notEqual(entry.managerEntryResourceUri("1.30.1", "en"), entry.managerEntryResourceUri("1.30.1", "zh-Hant"), "切換語言不沿用舊畫面快取");
});

test("入口以隱藏子程序開啟 ui，清除舊交接環境，Windows 路徑含中文與空白仍是獨立參數", () => {
  const environment = { SystemRoot: "C:\\Windows", CODEX_MODEL_ROUTER_IMPORT_ONLY: "1", CODEX_MODEL_ROUTER_UI_TOKEN: "old", CODEX_MODEL_ROUTER_UI_BACKGROUND: "1", CODEX_MODEL_ROUTER_UI_NO_OPEN: "1" };
  const plan = entry.managerEntryLaunchPlan({ installer: "D:\\中文 目錄\\codex-model-router.ps1", platform: "win32", environment, launchEnv: { CODEX_HOME: "D:\\codex" } });
  assert.equal(plan.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(plan.args, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "D:\\中文 目錄\\codex-model-router.ps1", "ui"]);
  assert.equal(plan.env.CODEX_HOME, "D:\\codex");
  assert.equal(plan.env.CODEX_MODEL_ROUTER_UI_NO_OPEN, "0");
  assert.equal(plan.env.CODEX_MODEL_ROUTER_UI_TOKEN, undefined);
  assert.equal(plan.env.CODEX_MODEL_ROUTER_IMPORT_ONLY, undefined);
  const mac = entry.managerEntryLaunchPlan({ installer: "/my home/it's here.sh", platform: "darwin", environment: {} });
  assert.deepEqual(mac.args, ["/my home/it's here.sh", "ui"]);
});

test("入口頁完成握手後開管理頁；切走再切回重新開啟，應用程式 focus 不造成來回跳轉", async () => {
  const sent = [], handlers = {};
  const status = { textContent: "", className: "" };
  const button = { disabled: true, addEventListener: (name, callback) => { handlers[name] = callback; } };
  const parent = { postMessage: message => { sent.push(message); } };
  const windowHandlers = {};
  let intersection;
  const script = /<script>([\s\S]*?)<\/script>/.exec(entry.MANAGER_ENTRY_HTML)[1];
  runInNewContext(script, { parent,
    window: { addEventListener: (name, callback) => { windowHandlers[name] = callback; } },
    document: { documentElement: {}, getElementById: name => name === "status" ? status : button },
    IntersectionObserver: function (callback) { intersection = callback; this.observe = () => {}; },
    setTimeout: () => 1, clearTimeout: () => {},
  });
  const receive = windowHandlers.message;
  assert.equal(sent[0].method, "ui/initialize");
  assert.equal(sent[0].params.protocolVersion, "2026-01-26");
  receive({ source: {}, data: { jsonrpc: "2.0", id: 1, result: {} } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  receive({ source: parent, data: { jsonrpc: "2.0", id: 1, result: {} } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent[1].method, "ui/notifications/initialized");
  assert.equal(sent[2].method, "tools/call");
  assert.equal(sent[2].params.name, "open_model_manager");
  receive({ source: parent, data: { jsonrpc: "2.0", id: 2, result: { structuredContent: { opened: true } } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(status.textContent, "管理頁已在瀏覽器開啟。");
  assert.equal(button.disabled, false);
  assert.equal(typeof handlers.click, "function");
  assert.equal(windowHandlers.focus, undefined, "回到 Codex 應用程式不會自動跳回瀏覽器");
  intersection([{ isIntersecting: true, intersectionRatio: 1 }]);
  assert.equal(sent.length, 3, "初始顯示不重開第二次");
  intersection([{ isIntersecting: false, intersectionRatio: 0 }]);
  intersection([{ isIntersecting: true, intersectionRatio: 1 }]);
  assert.equal(sent[3].method, "tools/call");
  assert.equal(sent[3].params.arguments.reopen, true);
  receive({ source: parent, data: { jsonrpc: "2.0", id: sent[3].id, result: { structuredContent: { opened: true } } } });
  await new Promise(resolve => setImmediate(resolve));
  handlers.click();
  assert.equal(sent[4].params.arguments.reopen, true, "可隨時按頁面上的按鈕重開");
});
