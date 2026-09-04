// 把 codex-model-router.sh 內嵌的三段 JavaScript 取出成真的模組，供測試 import。
//
// 測試一律針對 .sh —— 它是負載的唯一真實來源。直接讀 repo 裡的獨立 .mjs 檔會
// 測到不存在的東西（那些檔案只在安裝後才存在於 CODEX_HOME）。

import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const shellPath = join(repoRoot, "codex-model-router.sh");

const MARKERS = {
  installer: ["__CODEX_MODEL_ROUTER_INSTALLER_JS__", "__CODEX_MODEL_ROUTER_ROUTER_JS__"],
  router: ["__CODEX_MODEL_ROUTER_ROUTER_JS__", "__CODEX_MODEL_ROUTER_BRIDGE_JS__"],
  bridge: ["__CODEX_MODEL_ROUTER_BRIDGE_JS__", "__CODEX_MODEL_ROUTER_EMBEDDED__"],
};

// 與安裝器的 awk 同樣的切法：起始標記的下一行起，到結束標記的前一行為止。
function slice(text, [begin, end]) {
  const from = text.indexOf(`\n${begin}\n`);
  if (from < 0) throw new Error(`codex-model-router.sh 缺少標記 ${begin}`);
  const to = text.indexOf(`\n${end}\n`, from);
  if (to < 0) throw new Error(`codex-model-router.sh 缺少標記 ${end}`);
  return text.slice(from + begin.length + 2, to + 1);
}

// router.mjs 在載入時就會讀 settings.json，因此測試得先擺一份最小可用的設定。
const FIXTURE_SETTINGS = {
  apiRoot: "https://gateway.example/v1",
  baseUrl: "https://gateway.example",
  keychainService: "test.service",
  keychainAccount: "codex",
  credentialPath: null,
  officialBaseUrl: "https://chatgpt.example/backend-api/codex",
  catalogPath: "/dev/null",
  port: 0,
  routes: [
    {
      pickerSlug: "custom/claude-test",
      upstreamModel: "claude-test",
      displayName: "claude-test",
      providerHost: "gateway.example",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      stripReasoning: false,
      translate: "anthropic",
      contextWindow: 200000,
      maxOutputTokens: 64000,
    },
  ],
};

// 每次呼叫都攤到一個新目錄，因此拿到的是全新的模組實例（模組以 URL 為鍵快取）。
// 需要驗證模組層狀態機（例如上游 WebSocket 的冷卻）時就得靠這個。
function extractTo(settings) {
  const text = readFileSync(shellPath, "utf8").replaceAll("\r\n", "\n");
  const dir = mkdtempSync(join(tmpdir(), "codex-model-router-test-"));

  for (const [name, markers] of Object.entries(MARKERS)) {
    writeFileSync(join(dir, `${name}.mjs`), slice(text, markers), "utf8");
  }
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings), "utf8");

  // router.mjs 只認同目錄下的 ./claude-bridge.mjs。
  writeFileSync(join(dir, "claude-bridge.mjs"), `export * from "./bridge.mjs";\n`, "utf8");

  // 安裝器與路由器的頂層都有副作用（安裝流程 / 監聽連接埠），import 前先擋掉。
  process.env.CODEX_MODEL_ROUTER_IMPORT_ONLY = "1";
  return dir;
}

let cached = null;

export async function loadPayloads() {
  if (cached) return cached;
  const dir = extractTo(FIXTURE_SETTINGS);
  const load = (name) => import(pathToFileURL(join(dir, `${name}.mjs`)).href);
  cached = {
    dir,
    installer: await load("installer"),
    router: await load("router"),
    bridge: await load("bridge"),
  };
  return cached;
}

// 以指定設定載入一份獨立的 router 模組實例。
export async function loadRouterWith(overrides) {
  const dir = extractTo({ ...FIXTURE_SETTINGS, ...overrides });
  return import(pathToFileURL(join(dir, "router.mjs")).href);
}
