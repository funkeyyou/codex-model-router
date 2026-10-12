// Codex 的本機 MCP App 入口。只開啟已安裝的管理頁，不提供設定檔或憑證讀寫工具。
// 不依賴 npm 套件：安裝器把這段模組及啟動參數放到路由器目錄，Codex 以 stdio 載入。
import { createInterface } from "node:readline";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { createHash } from "node:crypto";

export const MANAGER_ENTRY_URI = "ui://model-router/manager";
export const MANAGER_ENTRY_NAME = "open_model_manager";

// 入口名稱跟隨 Codex 介面語言：只支援繁中、簡中與英文，其他語言一律用英文。
export const MANAGER_ENTRY_TEXT = {
  "zh-Hant": {
    title: "自訂模型管理", description: "開啟此電腦的 Codex 模型路由器管理頁。", reopen: "再次開啟管理頁。",
    opening: "正在開啟本機管理頁…", button: "開啟管理頁", hint: "在管理頁中新增模型、管理供應商、調整上下文及檢查更新。",
    connecting: "正在連接本機入口…", opened: "管理頁已在瀏覽器開啟。", noReply: "Codex 未回應，請重新開啟此入口。",
    openFailed: "無法開啟管理頁。", notOpened: "管理頁未能開啟，請重新嘗試。",
    launchFailed: "管理頁啟動失敗，請執行安裝器的 ui 命令查看診斷。", badArgs: "此入口不接受額外參數。",
  },
  "zh-Hans": {
    title: "自定义模型管理", description: "打开此电脑的 Codex 模型路由器管理页。", reopen: "再次打开管理页。",
    opening: "正在打开本机管理页…", button: "打开管理页", hint: "在管理页中添加模型、管理供应商、调整上下文及检查更新。",
    connecting: "正在连接本机入口…", opened: "管理页已在浏览器中打开。", noReply: "Codex 未响应，请重新打开此入口。",
    openFailed: "无法打开管理页。", notOpened: "管理页未能打开，请重试。",
    launchFailed: "管理页启动失败，请运行安装器的 ui 命令查看诊断。", badArgs: "此入口不接受额外参数。",
  },
  en: {
    title: "Custom Model Manager", description: "Open this computer's Codex Model Router manager.", reopen: "Open the manager again.",
    opening: "Opening the local manager…", button: "Open manager", hint: "Add models, manage providers, adjust context, and check for updates in the manager.",
    connecting: "Connecting to the local entry…", opened: "The manager is open in your browser.", noReply: "Codex didn't respond. Reopen this entry.",
    openFailed: "Couldn't open the manager.", notOpened: "The manager didn't open. Please try again.",
    launchFailed: "Couldn't start the manager. Run the installer's ui command for diagnostics.", badArgs: "This entry doesn't accept extra arguments.",
  },
};

// 語言標籤對應：zh-Hant/TW/HK/MO 用繁中，其他 zh 用簡中，en 用英文；無法對應回傳 null。
export function entryLocaleFrom(tag) {
  if (typeof tag !== "string") return null;
  const [language, ...rest] = tag.trim().split(/[.@]/)[0].replace(/_/g, "-").toLowerCase().split("-").filter(Boolean);
  if (language === "zh") return rest.some(part => ["hant", "tw", "hk", "mo"].includes(part)) ? "zh-Hant" : "zh-Hans";
  if (language === "en") return "en";
  return null;
}

// Codex 的明確語言設定存在 config.toml 的 [desktop] localeOverride；未設定時跟隨系統偏好語言。
export function codexLocaleOverride(configText) {
  if (typeof configText !== "string") return null;
  let table = "";
  for (const line of configText.split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
    if (header) { table = header[1].replace(/"/g, ""); continue; }
    if (table !== "desktop") continue;
    const value = /^\s*"?localeOverride"?\s*=\s*["']([^"']*)["']/.exec(line);
    if (value) return value[1].trim() || null;
  }
  return null;
}

function systemLanguages({ platform, env, run }) {
  try {
    if (platform === "darwin") {
      return [...String(run("/usr/bin/defaults", ["read", "-g", "AppleLanguages"])).matchAll(/"?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)"?\s*,?\s*$/gm)].map(match => match[1]);
    }
    if (platform === "win32") {
      const text = String(run(win32.join(env.SystemRoot || "C:\\Windows", "System32", "reg.exe"),
        ["query", "HKCU\\Control Panel\\International\\User Profile", "/v", "Languages"]));
      const match = /Languages\s+REG_MULTI_SZ\s+(\S+)/.exec(text);
      if (match) return match[1].split("\\0").filter(Boolean);
    }
  } catch {}
  return [];
}

export function detectEntryLocale({ codexHome, platform = process.platform, env = process.env,
  readText = path => readFileSync(path, "utf8"),
  run = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }),
  intlLocale = () => Intl.DateTimeFormat().resolvedOptions().locale } = {}) {
  try {
    const override = codexLocaleOverride(readText(join(codexHome || env.CODEX_HOME || join(homedir(), ".codex"), "config.toml")));
    if (override) return entryLocaleFrom(override) ?? "en";
  } catch {}
  const preferred = systemLanguages({ platform, env, run })[0]
    ?? [env.LC_ALL, env.LC_MESSAGES, env.LANG].find(value => value && !/^(C|POSIX)(\..*)?$/.test(value))
    ?? (platform === "win32" ? intlLocale() : null);
  return entryLocaleFrom(preferred) ?? "en";
}

const entryText = locale => MANAGER_ENTRY_TEXT[locale] ?? MANAGER_ENTRY_TEXT.en;

export function managerEntryTool({ uri = managerEntryResourceUri(), locale = "zh-Hant" } = {}) {
  const text = entryText(locale);
  return {
    name: MANAGER_ENTRY_NAME, title: text.title,
    description: text.description,
    inputSchema: { type: "object", properties: { reopen: { type: "boolean", description: text.reopen } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      ui: { resourceUri: uri },
      "openai/ui": { entrypoints: [{ type: "global" }] },
      // 支援此項的桌面版會同時提供頂部入口；其他 MCP Apps 客戶端沿用全域側邊欄。
      "openai/globalHeader": true,
      "openai/widgetAccessible": true,
    },
  };
}

// MCP Apps 的 ui/initialize 與 tools/call 透過 parent.postMessage 傳送，管理頁本身仍在
// 原本的瀏覽器中開啟，不放寬 HTTP 管理頁的 CSP、Origin 或存取權杖檢查。
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function managerEntryHtml(locale = "zh-Hant") {
  const text = entryText(locale);
  const lang = MANAGER_ENTRY_TEXT[locale] ? locale : "en";
  const script = JSON.stringify({ noReply: text.noReply, openFailed: text.openFailed, notOpened: text.notOpened,
    opened: text.opened, opening: text.opening, connecting: text.connecting }).replace(/</g, "\\u003c");
  return MANAGER_ENTRY_TEMPLATE.replace("__LANG__", lang).replaceAll("__TITLE__", escapeHtml(text.title))
    .replace("__OPENING__", escapeHtml(text.opening)).replace("__BUTTON__", escapeHtml(text.button))
    .replace("__HINT__", escapeHtml(text.hint)).replace("__TEXT__", () => script);
}

const MANAGER_ENTRY_TEMPLATE = String.raw`<!doctype html>
<html lang="__LANG__"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title><style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,sans-serif;color:#edf2ff;background:#0c1222}
body{margin:0;min-height:100vh;display:grid;place-items:center}main{max-width:440px;padding:40px;text-align:center}
.icon{font-size:36px;color:#63b5fa}h1{font-size:24px;margin:18px 0 12px}p{line-height:1.7;color:#aab6cf}
button{font:inherit;padding:12px 24px;border:0;border-radius:10px;background:#4d8cef;color:white;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}.error{color:#f5a4a4}
</style></head><body><main><div class="icon" aria-hidden="true">⇄</div><h1>__TITLE__</h1>
<p id="status" role="status">__OPENING__</p><button id="open" type="button" disabled>__BUTTON__</button>
<p>__HINT__</p></main><script>
(() => {
  const T = __TEXT__;
  const status = document.getElementById("status");
  const button = document.getElementById("open");
  const pending = new Map();
  let nextId = 1, opened = false, ready = false, opening = false, visible = null, resumePending = false;
  const notify = (method, params) => parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(T.noReply)); }, 65000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
  const showOpened = () => { opened = true; status.textContent = T.opened; status.className = ""; };
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.jsonrpc !== "2.0") return;
    const message = event.data;
    if (message.method === "ui/notifications/tool-result" && message.params?.structuredContent?.opened === true) showOpened();
    if (message.method && message.id != null) {
      parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
      return;
    }
    const call = pending.get(message.id);
    if (!call) return;
    clearTimeout(call.timer); pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message || T.openFailed));
    else call.resolve(message.result);
  });
  async function open(reopen = false) {
    if (!ready || opening) return;
    opening = true;
    button.disabled = true; status.className = ""; status.textContent = T.opening;
    try {
      const result = await request("tools/call", { name: "open_model_manager", arguments: reopen ? { reopen: true } : {} });
      if (result?.isError) throw new Error(result.content?.find(item => item.type === "text")?.text || T.openFailed);
      if (result?.structuredContent?.opened !== true) throw new Error(T.notOpened);
      showOpened();
    } catch (error) { status.textContent = error.message; status.className = "error"; }
    finally {
      opening = false; button.disabled = false;
      if (resumePending && visible === true) { resumePending = false; void open(true); }
    }
  }
  // Codex 會保留全域 App 的 iframe；切到其他頁面再切回時不一定重新載入文件。
  // 只觀察入口自身重新顯示，不能監聽應用程式 focus，否則從瀏覽器回來會反覆跳走。
  if (typeof IntersectionObserver === "function") {
    const observer = new IntersectionObserver(entries => {
      const shown = entries.some(item => item.isIntersecting && item.intersectionRatio > 0);
      const resumed = visible === false && shown;
      visible = shown;
      if (resumed && ready) {
        if (opening) resumePending = true;
        else void open(true);
      }
    });
    observer.observe(document.documentElement);
  }
  window.addEventListener("pageshow", event => { if (event.persisted && ready) void open(true); });
  button.addEventListener("click", () => { if (ready) void open(true); else void connect(); });
  async function connect() {
    button.disabled = true; status.className = ""; status.textContent = T.connecting;
    try {
      await request("ui/initialize", { appInfo: { name: "codex-model-router", version: "1.0.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" });
      ready = true; notify("ui/notifications/initialized", {}); button.disabled = false;
      if (!opened && visible !== false) await open();
    } catch (error) { status.textContent = error.message; status.className = "error"; button.disabled = false; }
  }
  void connect();
})();
</script></body></html>
`;

export const MANAGER_ENTRY_HTML = managerEntryHtml("zh-Hant");

// HTML 內容改變即使用不同的資源 URI，避免 Codex 沿用驗證版或舊版入口的畫面快取。
export function managerEntryResourceUri(version = "current", locale = "zh-Hant") {
  const revision = createHash("sha256").update(managerEntryHtml(locale)).digest("hex").slice(0, 12);
  return `${MANAGER_ENTRY_URI}/${encodeURIComponent(version)}/${revision}`;
}

export function managerEntryLaunchPlan({ installer, launchEnv = {}, platform = process.platform, environment = process.env }) {
  if (typeof installer !== "string" || !installer) throw new Error("缺少已安裝的管理頁啟動程式。");
  const env = { ...environment, ...launchEnv, CODEX_MODEL_ROUTER_UI_NO_OPEN: "0" };
  for (const key of ["CODEX_MODEL_ROUTER_IMPORT_ONLY", "CODEX_MODEL_ROUTER_UI_TOKEN", "CODEX_MODEL_ROUTER_UI_BACKGROUND"]) delete env[key];
  return platform === "win32"
    ? { command: win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", installer, "ui"], env }
    : { command: "/bin/bash", args: [installer, "ui"], env };
}

function runLauncher(plan, text = MANAGER_ENTRY_TEXT.en) {
  return new Promise((resolve, reject) => {
    execFile(plan.command, plan.args, { env: plan.env, windowsHide: true, timeout: 60000, maxBuffer: 256 * 1024 }, (error) => {
      if (error) reject(new Error(text.launchFailed));
      else resolve();
    });
  });
}

export function createManagerEntryHandler({ version, installer, launchEnv, run = runLauncher, now = Date.now,
  locale = detectEntryLocale({ codexHome: launchEnv?.CODEX_HOME }) }) {
  let lastOpened = null;
  const text = entryText(locale);
  const html = managerEntryHtml(locale);
  const resourceUri = managerEntryResourceUri(version, locale);
  return async function handle(message) {
    const result = (value) => ({ jsonrpc: "2.0", id: message.id, result: value });
    const error = (code, text) => ({ jsonrpc: "2.0", id: message?.id ?? null, error: { code, message: text } });
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return error(-32600, "Invalid Request");
    if (message.id == null) return null;
    switch (message.method) {
      case "initialize":
        return result({ protocolVersion: message.params?.protocolVersion || "2025-06-18", capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "codex-model-router", title: text.title, version } });
      case "ping": return result({});
      case "tools/list": return result({ tools: [managerEntryTool({ uri: resourceUri, locale })] });
      case "resources/list": return result({ resources: [{ uri: resourceUri, name: text.title, mimeType: "text/html;profile=mcp-app" }] });
      case "resources/templates/list": return result({ resourceTemplates: [] });
      case "resources/read":
        if (![resourceUri, MANAGER_ENTRY_URI].includes(message.params?.uri)) return error(-32002, "Resource not found");
        return result({ contents: [{ uri: message.params.uri, mimeType: "text/html;profile=mcp-app", text: html,
          _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } },
            "openai/ui": { availableDisplayModes: ["inline", "fullscreen", "pip"], preferredDisplayMode: "fullscreen" } } }] });
      case "tools/call": {
        if (message.params?.name !== MANAGER_ENTRY_NAME) return error(-32602, "Unknown tool");
        const args = message.params.arguments ?? {};
        if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => key !== "reopen")
          || (Object.hasOwn(args, "reopen") && typeof args.reopen !== "boolean")) return error(-32602, text.badArgs);
        try {
          if (args.reopen === true || lastOpened == null || now() - lastOpened > 2000) {
            await run(managerEntryLaunchPlan({ installer, launchEnv }), text);
            lastOpened = now();
          }
          return result({ content: [{ type: "text", text: text.opened }], structuredContent: { opened: true } });
        } catch (cause) {
          return result({ isError: true, content: [{ type: "text", text: cause.message }], structuredContent: { opened: false } });
        }
      }
      default: return error(-32601, "Method not found");
    }
  };
}

export async function serveManagerEntry(options, { input = process.stdin, output = process.stdout } = {}) {
  const handle = createManagerEntryHandler(options);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let response;
    try {
      if (Buffer.byteLength(line) > 64 * 1024) throw new Error("Request too large");
      response = await handle(JSON.parse(line));
    } catch { response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }; }
    if (response) output.write(JSON.stringify(response) + "\n");
  }
}
