// Codex 的本機 MCP App 入口。只開啟已安裝的管理頁，不提供設定檔或憑證讀寫工具。
// 不依賴 npm 套件：安裝器把這段模組及啟動參數放到路由器目錄，Codex 以 stdio 載入。
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { createHash } from "node:crypto";

export const MANAGER_ENTRY_URI = "ui://model-router/manager";
export const MANAGER_ENTRY_NAME = "open_model_manager";

export function managerEntryTool({ uri = managerEntryResourceUri() } = {}) {
  return {
    name: MANAGER_ENTRY_NAME, title: "自訂模型管理",
    description: "開啟此電腦的 Codex 模型路由器管理頁。",
    inputSchema: { type: "object", properties: { reopen: { type: "boolean", description: "再次開啟管理頁。" } }, additionalProperties: false },
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
export const MANAGER_ENTRY_HTML = String.raw`<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>自訂模型管理</title><style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,sans-serif;color:#edf2ff;background:#0c1222}
body{margin:0;min-height:100vh;display:grid;place-items:center}main{max-width:440px;padding:40px;text-align:center}
.icon{font-size:36px;color:#63b5fa}h1{font-size:24px;margin:18px 0 12px}p{line-height:1.7;color:#aab6cf}
button{font:inherit;padding:12px 24px;border:0;border-radius:10px;background:#4d8cef;color:white;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}.error{color:#f5a4a4}
</style></head><body><main><div class="icon" aria-hidden="true">⇄</div><h1>自訂模型管理</h1>
<p id="status" role="status">正在開啟本機管理頁…</p><button id="open" type="button" disabled>開啟管理頁</button>
<p>在管理頁中新增模型、管理供應商、調整上下文及檢查更新。</p></main><script>
(() => {
  const status = document.getElementById("status");
  const button = document.getElementById("open");
  const pending = new Map();
  let nextId = 1, opened = false, ready = false, opening = false, visible = null, resumePending = false;
  const notify = (method, params) => parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Codex 未回應，請重新開啟此入口。")); }, 65000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
  const showOpened = () => { opened = true; status.textContent = "管理頁已在瀏覽器開啟。"; status.className = ""; };
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
    if (message.error) call.reject(new Error(message.error.message || "無法開啟管理頁。"));
    else call.resolve(message.result);
  });
  async function open(reopen = false) {
    if (!ready || opening) return;
    opening = true;
    button.disabled = true; status.className = ""; status.textContent = "正在開啟本機管理頁…";
    try {
      const result = await request("tools/call", { name: "open_model_manager", arguments: reopen ? { reopen: true } : {} });
      if (result?.isError) throw new Error(result.content?.find(item => item.type === "text")?.text || "無法開啟管理頁。");
      if (result?.structuredContent?.opened !== true) throw new Error("管理頁未能開啟，請重新嘗試。");
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
    button.disabled = true; status.className = ""; status.textContent = "正在連接本機入口…";
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

// HTML 內容改變即使用不同的資源 URI，避免 Codex 沿用驗證版或舊版入口的畫面快取。
export function managerEntryResourceUri(version = "current") {
  const revision = createHash("sha256").update(MANAGER_ENTRY_HTML).digest("hex").slice(0, 12);
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

function runLauncher(plan) {
  return new Promise((resolve, reject) => {
    execFile(plan.command, plan.args, { env: plan.env, windowsHide: true, timeout: 60000, maxBuffer: 256 * 1024 }, (error) => {
      if (error) reject(new Error("管理頁啟動失敗，請執行安裝器的 ui 命令查看診斷。"));
      else resolve();
    });
  });
}

export function createManagerEntryHandler({ version, installer, launchEnv, run = runLauncher, now = Date.now }) {
  let lastOpened = null;
  const resourceUri = managerEntryResourceUri(version);
  return async function handle(message) {
    const result = (value) => ({ jsonrpc: "2.0", id: message.id, result: value });
    const error = (code, text) => ({ jsonrpc: "2.0", id: message?.id ?? null, error: { code, message: text } });
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return error(-32600, "Invalid Request");
    if (message.id == null) return null;
    switch (message.method) {
      case "initialize":
        return result({ protocolVersion: message.params?.protocolVersion || "2025-06-18", capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "codex-model-router", title: "自訂模型管理", version } });
      case "ping": return result({});
      case "tools/list": return result({ tools: [managerEntryTool({ uri: resourceUri })] });
      case "resources/list": return result({ resources: [{ uri: resourceUri, name: "自訂模型管理", mimeType: "text/html;profile=mcp-app" }] });
      case "resources/templates/list": return result({ resourceTemplates: [] });
      case "resources/read":
        if (![resourceUri, MANAGER_ENTRY_URI].includes(message.params?.uri)) return error(-32002, "Resource not found");
        return result({ contents: [{ uri: message.params.uri, mimeType: "text/html;profile=mcp-app", text: MANAGER_ENTRY_HTML,
          _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } },
            "openai/ui": { availableDisplayModes: ["inline", "fullscreen", "pip"], preferredDisplayMode: "fullscreen" } } }] });
      case "tools/call": {
        if (message.params?.name !== MANAGER_ENTRY_NAME) return error(-32602, "Unknown tool");
        const args = message.params.arguments ?? {};
        if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => key !== "reopen")
          || (Object.hasOwn(args, "reopen") && typeof args.reopen !== "boolean")) return error(-32602, "此入口不接受額外參數。");
        try {
          if (args.reopen === true || lastOpened == null || now() - lastOpened > 2000) {
            await run(managerEntryLaunchPlan({ installer, launchEnv }));
            lastOpened = now();
          }
          return result({ content: [{ type: "text", text: "管理頁已在瀏覽器開啟。" }], structuredContent: { opened: true } });
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
