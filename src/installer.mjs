import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, isIP } from "node:net";
import { homedir, tmpdir } from "node:os";
import { Writable } from "node:stream";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const INSTALLER_VERSION = "1.27.6";
export const CLAUDE_CLI_MIN_VERSION = "2.1.280";
const isWindows = process.platform === "win32";
// 憑證儲存：macOS 走鑰匙圈；Windows 走 DPAPI（CurrentUser 範圍）加密檔。
const secretStoreLabel = isWindows ? "Windows 憑證保護（DPAPI）" : "macOS 鑰匙圈";
// 常駐方式：macOS 走 LaunchAgent；Windows 走工作排程器（登入時觸發）。
const serviceKindLabel = isWindows ? "Windows 排程工作" : "LaunchAgent";
const desktopAppName = isWindows ? "Codex 桌面版" : "ChatGPT Desktop";
const PROVIDER_ID = "compat_router";
const OFFICIAL_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_RELEASES_URL =
  "https://github.com/funkeyyou/codex-model-router/raw/refs/heads/main/releases.json";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_DESCRIPTIONS = {
  low: "響應較快，使用較少推理",
  medium: "平衡響應速度與推理深度",
  high: "為複雜任務提供更深入的推理",
  xhigh: "為高難度任務提供超高推理深度",
  max: "最高推理深度",
};

const env = process.env;
const requestedAction = process.argv[2]?.toLowerCase() ?? null;
const scriptPath = env.CODEX_MODEL_ROUTER_SCRIPT_PATH;
const nodeBin = env.CODEX_MODEL_ROUTER_NODE_BIN;
const homeDir = env.HOME || homedir();
const codexHome = resolve(env.CODEX_HOME || join(homeDir, ".codex"));
const installRoot = resolve(
  env.CODEX_MODEL_ROUTER_HOME || join(codexHome, "model-router"),
);
const backupsRoot = resolve(join(codexHome, "backups", "model-router"));
const launchAgentsDir = resolve(
  env.CODEX_MODEL_ROUTER_LAUNCH_AGENTS_DIR ||
    join(homeDir, "Library", "LaunchAgents"),
);
const manifestPath = join(installRoot, "install.json");
const routerPath = join(installRoot, "router.mjs");
const bridgePath = join(installRoot, "claude-bridge.mjs");
const chatBridgePath = join(installRoot, "chat-bridge.mjs");
const claudeCliPath = join(installRoot, "claude-cli.mjs");
const settingsPath = join(installRoot, "settings.json");
const catalogPath = join(installRoot, "models.json");
const logPath = join(installRoot, "router.err.log");
const relaySkillRoot = join(codexHome, "skills", "router-imagegen");
const RELAY_IMAGEGEN_OWNER = "codex-model-router";
export const RELAY_IMAGE_MODELS = [
  { id: "gpt-image-2", label: "Image 2", description: "上一代圖片模型，適合既有流程與相容需求。" },
  { id: "gpt-image-2.5-sunburst", label: "Image 2.5 Sunburst", description: "偏重編輯精準度，適合精細改圖與需保留原圖細節的工作。" },
  { id: "gpt-image-2.5-flare", label: "Image 2.5 Flare", description: "偏重速度，適合一般生圖與快速迭代。" },
];
const installHash = createHash("sha256")
  .update(codexHome)
  .digest("hex")
  .slice(0, 10);
const launchLabel = `com.openai.codex.model-router.${installHash}`;
const plistPath = join(launchAgentsDir, `${launchLabel}.plist`);
// Windows：以工作排程器取代 LaunchAgent。wscript 屬 GUI 子系統不會開主控台，
// 由它跑一個「執行 → 等結束 → 重跑」的迴圈，等同 launchd 的 KeepAlive。
const taskName = `CodexModelRouter-${installHash}`;
const taskXmlPath = join(installRoot, "service-task.xml");
// 守護迴圈用 JScript 寫。1.22.5 以前是 VBScript，但微軟預計約 2027 年起預設停用
// VBScript（改為選用功能），屆時新裝的服務會起不來；JScript 引擎不在這次淘汰範圍內。
const launcherPath = join(installRoot, "router-launcher.js");
const legacyLauncherVbsPath = join(installRoot, "router-launcher.vbs");
// 憑證放在 installRoot 之外：安裝失敗時 installRoot 會整個被封存搬走，
// 但已存好的金鑰應該像鑰匙圈項目一樣留著。
const credentialsRoot = resolve(
  env.CODEX_MODEL_ROUTER_CREDENTIALS_DIR ||
    join(codexHome, "model-router-credentials"),
);
const serviceName = isWindows ? taskName : launchLabel;
const testMode = env.CODEX_MODEL_ROUTER_TEST_MODE === "1";
const assumeYes = env.CODEX_MODEL_ROUTER_YES === "1";
const releasesUrl = env.CODEX_MODEL_ROUTER_RELEASES_URL || DEFAULT_RELEASES_URL;
let releaseCatalogPromise = null;
let releaseCatalogLoadedAt = 0;
// 網頁管理介面執行期間沒有人在終端回答問題；任何流程若走到提問，直接當成程式錯誤，
// 不能讓背景工作卡在等待 stdin。
let managerMode = false;

function fail(message) {
  throw new Error(message);
}

function printHeading(message) {
  console.log(`\n${message}`);
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replace(".", "-");
}

function ensureDirectory(path, mode = 0o700) {
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
}

function writeJsonAtomic(path, value, mode = 0o600) {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode,
  });
  renameSync(temporaryPath, path);
  chmodSync(path, mode);
}

function shell(command, args, options = {}) {
  // 有 input 時 stdin 必須是管線：spawnSync 對 "ignore" 的 stdio[0] 會直接
  // 丟掉 input，子行程只會讀到空字串。
  const defaultStdio = options.input != null
    ? ["pipe", "pipe", "pipe"]
    : ["ignore", "pipe", "pipe"];
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? defaultStdio,
    env: options.env ?? env,
    cwd: options.cwd,
    // 有 input 時 spawnSync 會自動把 stdio[0] 換成管線。
    input: options.input,
    windowsHide: options.windowsHide ?? true,
  });
  if (options.allowFailure !== true && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(`${command} 執行失敗${detail ? `：${detail}` : ""}`);
  }
  return result;
}

function findExecutable(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function commandPath(name) {
  const result = isWindows
    ? shell("where.exe", [name], { allowFailure: true })
    : shell("/usr/bin/which", [name], { allowFailure: true });
  if (result.status !== 0) return null;
  // where.exe 可能一次回多行，取第一個命中。
  const first = (result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first || null;
}

// --- Windows 專用小工具 ----------------------------------------------------
// 一律用 -EncodedCommand 傳腳本，免去跨層引號逸出的問題。
// 這些子行程一律非互動：需要使用者輸入的部分留在本行程做，避免兩邊搶主控台。
// $ProgressPreference 要關，否則 Add-Type 的進度條會蓋掉畫面。
function powershell(script, options = {}) {
  const full = `$ProgressPreference = 'SilentlyContinue'\n${script}`;
  const encoded = Buffer.from(full, "utf16le").toString("base64");
  return shell(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ],
    options,
  );
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

// Windows 沒有 POSIX 權限位元；把檔案 ACL 收成只有本人可存取。
function restrictAcl(path) {
  if (!isWindows || !existsSync(path) || !env.USERNAME) return;
  shell(
    "icacls.exe",
    [path, "/inheritance:r", "/grant:r", `${env.USERNAME}:(F)`],
    { allowFailure: true, stdio: ["ignore", "ignore", "ignore"] },
  );
}

// Windows 的「下載」可以被搬到別的磁碟，而且相當常見；固定用
// %USERPROFILE%\Downloads 會把生成的圖寫到使用者根本不會去看的舊位置。
// 真正的來源是已知資料夾的登錄項，讀不到就退回預設。
//
// 必須用 String.raw：一般字串裡的 \S、\M 不是跳脫字元，反斜線會被 JS 靜默吃掉，
// 查的就變成不存在的 HKCU:SOFTWAREMicrosoft...——1.22.5 以前正是如此，偵測從未成功。
export const USER_SHELL_FOLDERS_KEY =
  String.raw`HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`;
const DOWNLOADS_FOLDER_GUID = "{374DE290-123F-4565-9164-39C4925E467B}";

function windowsDownloadsDir() {
  const result = powershell(
    [
      `$value = (Get-ItemProperty -LiteralPath ${psQuote(USER_SHELL_FOLDERS_KEY)} -Name ${psQuote(DOWNLOADS_FOLDER_GUID)}).${psQuote(DOWNLOADS_FOLDER_GUID)}`,
      "[Environment]::ExpandEnvironmentVariables($value)",
    ].join("\n"),
    { allowFailure: true },
  );
  if (result.status !== 0) return null;
  return (result.stdout || "").trim() || null;
}

// 舊版偵測必定失敗，於是把預設的 %USERPROFILE%\Downloads 寫進了 settings。
// 仍是那個預設值、而「下載」其實已搬到別處時，視為當年偵測失敗的結果，改用實際位置；
// 其他任何值都當成使用者自己設定的，一律保留。回傳 null 表示不需要改。
export function migratedImageOutputDir(previous, knownFolder, defaultDir) {
  // 只有 Windows 會用到：以 Windows 規則比較（不分大小寫、忽略結尾的分隔符號），
  // 在其他平台跑測試時結果也一樣。
  const same = (a, b) => win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();
  if (typeof previous !== "string" || !previous || !same(previous, defaultDir)) return null;
  if (typeof knownFolder !== "string" || !knownFolder || same(knownFolder, defaultDir)) return null;
  return knownFolder;
}

// 生成的圖預設落在使用者的「下載」。明確寫進 settings 讓它看得見也改得動；
// 使用者若已經改過就沿用，重新安裝不該把它蓋掉。
function resolveImageOutputDir() {
  const defaultDir = join(homeDir, "Downloads");
  const knownFolder = isWindows ? windowsDownloadsDir() : null;
  if (existsSync(settingsPath)) {
    try {
      const previous = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (typeof previous.imageOutputDir === "string" && previous.imageOutputDir) {
        return migratedImageOutputDir(previous.imageOutputDir, knownFolder, defaultDir) ||
          previous.imageOutputDir;
      }
    } catch {}
  }
  return knownFolder || defaultDir;
}

function listDirectories(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    );
  } catch {
    return [];
  }
}

// %LOCALAPPDATA%\OpenAI\Codex\bin 會同時留著多個版本的雜湊子目錄，取最新的。
function newestNested(directory, relativePath) {
  const matches = [];
  for (const entry of listDirectories(directory)) {
    const candidate = join(directory, entry.name, relativePath);
    try {
      matches.push({ path: candidate, mtime: statSync(candidate).mtimeMs });
    } catch {}
  }
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches.map((match) => match.path);
}

function localAppData() {
  return env.LOCALAPPDATA || join(homeDir, "AppData", "Local");
}

// Codex 執行檔：macOS 在 App bundle 裡；Windows 的 MSIX 主體因 WindowsApps 的
// ACL 不能直接執行，但應用程式會在 %LOCALAPPDATA%\OpenAI\Codex\bin 留可執行副本。
function codexCandidates() {
  if (!isWindows) {
    return [
      env.CODEX_MODEL_ROUTER_CODEX_BIN,
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandPath("codex"),
    ];
  }
  const codexBinDir = join(localAppData(), "OpenAI", "Codex", "bin");
  const npmVendor = join(
    env.APPDATA || join(homeDir, "AppData", "Roaming"),
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "vendor",
  );
  return [
    env.CODEX_MODEL_ROUTER_CODEX_BIN,
    ...newestNested(codexBinDir, "codex.exe"),
    join(codexBinDir, "codex.exe"),
    join(codexHome, "plugins", ".plugin-appserver", "codex.exe"),
    ...newestNested(npmVendor, join("codex", "codex.exe")),
    commandPath("codex.exe"),
  ];
}

const codexBin = findExecutable(codexCandidates());

function readManifest() {
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function extractRouterSource() {
  if (!scriptPath || !existsSync(scriptPath)) {
    fail("無法讀取安裝器原始檔。" );
  }
  // .ps1 版本同樣內嵌這段負載；正規化換行讓兩種容器共用同一組標記。
  const source = readFileSync(scriptPath, "utf8").replaceAll("\r\n", "\n");
  const marker = "__CODEX_MODEL_ROUTER_ROUTER_JS__\n";
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) fail("安裝器中缺少內嵌路由器程式碼。" );
  const routerSource = source.slice(markerIndex + marker.length);
  const endMarker = "\n__CODEX_MODEL_ROUTER_BRIDGE_JS__";
  const endIndex = routerSource.lastIndexOf(endMarker);
  return endIndex < 0 ? routerSource : routerSource.slice(0, endIndex);
}

function loadBridgeSource() {
  if (!scriptPath || !existsSync(scriptPath)) {
    fail("無法讀取安裝器原始檔。" );
  }
  const source = readFileSync(scriptPath, "utf8").replaceAll("\r\n", "\n");
  const marker = "__CODEX_MODEL_ROUTER_BRIDGE_JS__\n";
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) fail("安裝器中缺少內嵌 Claude 轉譯程式碼。" );
  const bridgeSource = source.slice(markerIndex + marker.length);
  const endMarker = "\n__CODEX_MODEL_ROUTER_CHAT_JS__";
  const endIndex = bridgeSource.lastIndexOf(endMarker);
  return endIndex < 0 ? bridgeSource : bridgeSource.slice(0, endIndex);
}

function loadChatBridgeSource() {
  if (!scriptPath || !existsSync(scriptPath)) {
    fail("無法讀取安裝器原始檔。" );
  }
  const source = readFileSync(scriptPath, "utf8").replaceAll("\r\n", "\n");
  const marker = "\n__CODEX_MODEL_ROUTER_CHAT_JS__\n";
  const start = source.indexOf(marker);
  const end = source.lastIndexOf("\n__CODEX_MODEL_ROUTER_IMAGEGEN_JS__");
  if (start < 0 || end <= start) fail("安裝器中缺少內嵌 Chat Completions 轉譯程式碼。");
  return source.slice(start + marker.length, end) + "\n";
}

// 較新的 Chat 與 Claude CLI 轉接檔在舊安裝裡不存在，備份時跳過；
// 還原時備份裡沒有它，就刪掉這次新寫的那份（舊版路由器用不到）。
function writeBridgeSources() {
  writeFileSync(bridgePath, loadBridgeSource(), { mode: 0o600 });
  chmodSync(bridgePath, 0o600);
  writeFileSync(chatBridgePath, loadChatBridgeSource(), { mode: 0o600 });
  chmodSync(chatBridgePath, 0o600);
  writeFileSync(claudeCliPath, loadClaudeCliSource(), { mode: 0o600 });
  chmodSync(claudeCliPath, 0o600);
}

function backupChatBridge(directory) {
  copyIfExists(chatBridgePath, join(directory, "chat-bridge.mjs"));
  copyIfExists(claudeCliPath, join(directory, "claude-cli.mjs"));
}

function restoreChatBridge(directory) {
  if (!copyIfExists(join(directory, "chat-bridge.mjs"), chatBridgePath)) rmSync(chatBridgePath, { force: true });
  if (!copyIfExists(join(directory, "claude-cli.mjs"), claudeCliPath)) rmSync(claudeCliPath, { force: true });
}

export function loadImagegenSource(sourcePath = scriptPath) {
  const source = readFileSync(sourcePath, "utf8").replaceAll("\r\n", "\n");
  const marker = "\n__CODEX_MODEL_ROUTER_IMAGEGEN_JS__\n";
  const start = source.indexOf(marker);
  const end = source.lastIndexOf("\n__CODEX_MODEL_ROUTER_CLAUDE_CLI_JS__");
  if (start < 0 || end <= start) fail("安裝器中缺少中轉生圖命令。");
  return source.slice(start + marker.length, end) + "\n";
}

export function loadClaudeCliSource(sourcePath = scriptPath) {
  const source = readFileSync(sourcePath, "utf8").replaceAll("\r\n", "\n");
  const marker = "\n__CODEX_MODEL_ROUTER_CLAUDE_CLI_JS__\n";
  const start = source.indexOf(marker);
  const end = source.lastIndexOf("\n__CODEX_MODEL_ROUTER_MANAGER_JS__");
  if (start < 0 || end <= start) fail("安裝器中缺少 Claude CLI 轉接程式碼。");
  return source.slice(start + marker.length, end) + "\n";
}

// 網頁管理介面只在執行 ui 命令時取出，不寫進路由器目錄。
export function loadManagerSource(sourcePath = scriptPath) {
  const source = readFileSync(sourcePath, "utf8").replaceAll("\r\n", "\n");
  const marker = "\n__CODEX_MODEL_ROUTER_MANAGER_JS__\n";
  const start = source.indexOf(marker);
  const end = source.lastIndexOf("\n__CODEX_MODEL_ROUTER_MANAGER_HTML__");
  if (start < 0 || end <= start) fail("安裝器中缺少網頁管理介面程式碼。");
  return source.slice(start + marker.length, end) + "\n";
}

export function loadManagerPage(sourcePath = scriptPath) {
  const source = readFileSync(sourcePath, "utf8").replaceAll("\r\n", "\n");
  const marker = "\n__CODEX_MODEL_ROUTER_MANAGER_HTML__\n";
  const start = source.indexOf(marker);
  const entryStart = source.indexOf("\n__CODEX_MODEL_ROUTER_MANAGER_ENTRY_JS__");
  const end = entryStart < 0 ? source.lastIndexOf("\n__CODEX_MODEL_ROUTER_EMBEDDED__") : entryStart;
  if (start < 0 || end <= start) fail("安裝器中缺少網頁管理介面頁面。");
  return source.slice(start + marker.length, end) + "\n";
}

export function loadManagerEntrySource(sourcePath = scriptPath) {
  const source = readFileSync(sourcePath, "utf8").replaceAll("\r\n", "\n");
  const marker = "\n__CODEX_MODEL_ROUTER_MANAGER_ENTRY_JS__\n";
  const start = source.indexOf(marker);
  const end = source.lastIndexOf("\n__CODEX_MODEL_ROUTER_EMBEDDED__");
  if (start < 0 || end <= start) fail("安裝器中缺少 Codex 管理頁入口程式。");
  return source.slice(start + marker.length, end) + "\n";
}

function assertTerminalPrompt(question) {
  if (managerMode) fail(`內部錯誤：網頁管理介面不能等待終端輸入（${question}）。`);
}

async function ask(question, defaultValue = null) {
  assertTerminalPrompt(question);
  if (defaultValue != null && env.CODEX_MODEL_ROUTER_BASE_URL) {
    return defaultValue;
  }
  const rl = createInterface({ input, output });
  try {
    const suffix = defaultValue == null ? "" : ` [${defaultValue}]`;
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue || "";
  } finally {
    rl.close();
  }
}

async function confirm(question, defaultYes = true) {
  assertTerminalPrompt(question);
  if (assumeYes) return true;
  const rl = createInterface({ input, output });
  try {
    const answer = (
      await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}: `)
    )
      .trim()
      .toLowerCase();
    if (!answer) return defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// 隱藏輸入的提問。這一段一定要留在本行程：spawnSync 期間本行程的 stdin
// 仍掛在同一個主控台上，交給子行程 Read-Host 會被吃掉第一次輸入。
async function askSecret(question) {
  assertTerminalPrompt(question);
  let muted = false;
  const maskedOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding);
      callback();
    },
  });
  const rl = createInterface({
    input,
    output: maskedOutput,
    terminal: Boolean(output.isTTY),
  });
  try {
    const answer = rl.question(`${question}: `);
    muted = true;
    return (await answer).trim();
  } finally {
    muted = false;
    rl.close();
    output.write("\n");
  }
}

function normalizeUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`Base URL 無效：${value}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    fail("Base URL 必須使用 http:// 或 https://。" );
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

function keychainServiceFor(baseUrl) {
  const digest = createHash("sha256").update(baseUrl).digest("hex").slice(0, 16);
  return `com.openai.codex.model-router.${digest}`;
}

// Windows 的憑證檔名由 service 名稱推導，讓不同 Base URL 各自獨立。
function credentialFileFor(service) {
  const digest = createHash("sha256").update(service).digest("hex").slice(0, 10);
  return join(credentialsRoot, `credential-${digest}.dat`);
}

function keychainHas(service) {
  if (env.CODEX_MODEL_ROUTER_TEST_API_KEY) return false;
  if (isWindows) return existsSync(credentialFileFor(service));
  return (
    shell(
      "/usr/bin/security",
      ["find-generic-password", "-a", "codex", "-s", service],
      { allowFailure: true },
    ).status === 0
  );
}

async function storeApiKey(service, baseUrl) {
  if (env.CODEX_MODEL_ROUTER_TEST_API_KEY) {
    return;
  }

  if (isWindows) {
    console.log("API Key 會用 Windows 憑證保護（DPAPI）以當前使用者身份加密儲存，" );
    console.log("不會寫入 config.toml 或安裝器檔案。" );
    let apiKey = "";
    for (let attempt = 0; attempt < 3 && !apiKey; attempt += 1) {
      if (attempt > 0) console.log("API Key 不能為空，請重新輸入。" );
      apiKey = await askSecret("API Key（輸入不會顯示）");
    }
    storeApiKeyValue(service, baseUrl, apiKey);
    return;
  }

  console.log("API Key 將儲存到 macOS 鑰匙圈，只需輸入一次。" );
  console.log("API Key 不會寫入 config.toml 或安裝器檔案。" );
  const apiKey = await askSecret("API Key（輸入不會顯示）");
  storeApiKeyValue(service, baseUrl, apiKey);
}

// 不經終端提問的版本：互動流程問完後呼叫它，網頁管理介面直接用表單送來的值。
function storeApiKeyValue(service, baseUrl, value) {
  const apiKey = String(value ?? "").trim();
  if (!apiKey) fail("API Key 不能為空。" );
  if (env.CODEX_MODEL_ROUTER_TEST_API_KEY) return;

  if (isWindows) {
    ensureDirectory(credentialsRoot);
    const target = credentialFileFor(service);
    // 明文以管線交給 PowerShell 做 DPAPI 加密：不會出現在命令列或行程清單。
    const result = powershell(
      [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName System.Security",
        "$buffer = New-Object IO.MemoryStream",
        "[Console]::OpenStandardInput().CopyTo($buffer)",
        "$plain = [Text.Encoding]::UTF8.GetString($buffer.ToArray()).Trim()",
        "if ([string]::IsNullOrEmpty($plain)) { exit 2 }",
        `$entropy = [Text.Encoding]::UTF8.GetBytes(${psQuote(service)})`,
        "$bytes = [Text.Encoding]::UTF8.GetBytes($plain)",
        "$blob = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
        `[IO.File]::WriteAllText(${psQuote(target)}, [Convert]::ToBase64String($blob))`,
      ].join("\n"),
      { input: apiKey, allowFailure: true },
    );
    if (result.status === 2) fail("API Key 不能為空。" );
    if (result.status !== 0 || !existsSync(target)) {
      const detail = (result.stderr || "").trim().split(/\r?\n/)[0] || "";
      fail(`API Key 未能保存。${detail ? `${detail}` : ""}`);
    }
    restrictAcl(target);
    return;
  }

  storeMacosApiKey(service, `Codex 模型路由器：${new URL(baseUrl).host}`, apiKey);
}

export function storeMacosApiKey(service, label, apiKey, run = spawnSync, keychain = null) {
  // security -i reads commands from stdin. Hex data avoids command-language
  // quoting of the secret; neither the key nor its hex form enters argv.
  const quote = (value) => {
    if (/["\\\r\n\0]/.test(value)) throw new Error("鑰匙圈項目名稱包含不支援的字元。");
    return `"${value}"`;
  };
  const suffix = keychain ? ` ${quote(keychain)}` : "";
  const command = `add-generic-password -U -a codex -s ${quote(service)} -l ${quote(label)} -X ${Buffer.from(apiKey, "utf8").toString("hex")}${suffix}\n`;
  const result = run("/usr/bin/security", ["-i"], { input: command, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  // Interactive security may exit successfully even when a command failed.
  // Verify the actual saved value, without exposing captured output on errors.
  const saved = result.status === 0 ? run("/usr/bin/security",
    ["find-generic-password", "-a", "codex", "-s", service, "-w", ...(keychain ? [keychain] : [])],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }) : null;
  if (!saved || saved.status !== 0 || saved.stdout?.replace(/\r?\n$/, "") !== apiKey) {
    throw new Error("API Key 未能儲存到鑰匙圈。");
  }
}

function readApiKey(service) {
  if (env.CODEX_MODEL_ROUTER_TEST_API_KEY) {
    return env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  }
  if (isWindows) {
    const target = credentialFileFor(service);
    if (!existsSync(target)) fail("找不到已保存的 API Key。" );
    const value = powershell(
      [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName System.Security",
        "[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false",
        `$blob = [Convert]::FromBase64String(([IO.File]::ReadAllText(${psQuote(target)})).Trim())`,
        `$entropy = [Text.Encoding]::UTF8.GetBytes(${psQuote(service)})`,
        "$plain = [Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))",
      ].join("\n"),
    ).stdout.trim();
    if (!value) fail("儲存的 API Key 解密後為空。" );
    return value;
  }
  return shell("/usr/bin/security", [
    "find-generic-password",
    "-a",
    "codex",
    "-s",
    service,
    "-w",
  ]).stdout.trim();
}

function deleteApiKey(service, account = "codex") {
  if (isWindows) {
    rmSync(credentialFileFor(service), { force: true });
    return;
  }
  shell(
    "/usr/bin/security",
    ["delete-generic-password", "-a", account, "-s", service],
    { allowFailure: true },
  );
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export function versionParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || "").trim());
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function assertInstallerNotOlder(installedVersion) {
  const comparison = compareVersions(INSTALLER_VERSION, installedVersion);
  if (comparison != null && comparison < 0) {
    fail(
      `已安裝版本 ${installedVersion} 比當前安裝器 ${INSTALLER_VERSION} 更新。` +
        "為避免降級，請重新下載最新版安裝器。",
    );
  }
}

export function terminalSafeText(value, maxLength = 320) {
  return String(value ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function normalizeReleaseCatalog(payload) {
  if (!payload || typeof payload !== "object") fail("版本清單格式無效。");
  const latest = terminalSafeText(payload.latest, 32);
  if (!versionParts(latest)) fail("版本清單缺少有效的 latest 版本。");
  if (!Array.isArray(payload.releases)) fail("版本清單缺少 releases 陣列。");

  const releases = [];
  const seen = new Set();
  for (const item of payload.releases.slice(0, 50)) {
    const version = terminalSafeText(item?.version, 32);
    if (!versionParts(version) || seen.has(version)) continue;
    const changes = Array.isArray(item?.changes)
      ? item.changes
          .map((change) => terminalSafeText(change))
          .filter(Boolean)
          .slice(0, 20)
      : [];
    if (changes.length === 0) continue;
    seen.add(version);
    releases.push({
      version,
      date: terminalSafeText(item?.date, 32),
      changes,
    });
  }
  if (!seen.has(latest)) fail(`版本清單中找不到最新版本 ${latest} 的說明。`);
  releases.sort((left, right) => compareVersions(right.version, left.version));
  return { latest, releases };
}

// force 時重新抓取；maxAgeMs 讓長時間開著的管理頁定期更新。失敗的結果不快取，下次再試。
async function loadReleaseCatalog({ force = false, maxAgeMs = Infinity } = {}) {
  if (releaseCatalogPromise && !force && Date.now() - releaseCatalogLoadedAt < maxAgeMs) {
    return releaseCatalogPromise;
  }
  releaseCatalogLoadedAt = Date.now();
  const promise = (async () => {
    let raw;
    if (env.CODEX_MODEL_ROUTER_RELEASES_JSON) {
      raw = env.CODEX_MODEL_ROUTER_RELEASES_JSON;
    } else {
      const response = await fetchWithTimeout(
        releasesUrl,
        {
          headers: {
            accept: "application/json",
            "user-agent": `codex-model-router/${INSTALLER_VERSION}`,
          },
        },
        4000,
      );
      if (!response.ok) fail(`版本清單回傳 HTTP ${response.status}。`);
      raw = await response.text();
    }
    if (Buffer.byteLength(raw, "utf8") > 128 * 1024) {
      fail("版本清單超過大小限制。");
    }
    return normalizeReleaseCatalog(JSON.parse(raw));
  })();
  releaseCatalogPromise = promise;
  promise.catch(() => {
    if (releaseCatalogPromise === promise) releaseCatalogPromise = null;
  });
  return promise;
}

export function releasesBetween(catalog, installedVersion) {
  const latestEntry = catalog.releases.find((entry) => entry.version === catalog.latest);
  if (!installedVersion || compareVersions(installedVersion, catalog.latest) === null) {
    return latestEntry ? [latestEntry] : [];
  }
  const installedVsLatest = compareVersions(installedVersion, catalog.latest);
  if (installedVsLatest === 0) return latestEntry ? [latestEntry] : [];
  if (installedVsLatest > 0) return [];
  return catalog.releases
    .filter((entry) => {
      const afterInstalled = compareVersions(entry.version, installedVersion);
      const notAfterLatest = compareVersions(entry.version, catalog.latest);
      return (
        afterInstalled != null &&
        afterInstalled > 0 &&
        notAfterLatest != null &&
        notAfterLatest <= 0
      );
    })
    .sort((left, right) => compareVersions(left.version, right.version));
}

async function printVersionSummary() {
  const manifest = readManifest();
  const installedVersion = terminalSafeText(manifest?.version, 32) || null;
  printHeading("版本信息");
  console.log(`已安裝版本：${installedVersion || "尚未安裝"}`);
  console.log(`當前安裝器：${INSTALLER_VERSION}`);

  let catalog;
  try {
    catalog = await loadReleaseCatalog();
  } catch {
    console.log("線上最新版本：無法檢查");
    console.log("版本狀態：網路不可用或 GitHub 版本清單暫時無法讀取（不影響安裝）");
    return;
  }

  console.log(`線上最新版本：${catalog.latest}`);
  const installerVsLatest = compareVersions(INSTALLER_VERSION, catalog.latest);
  const installedVsLatest = installedVersion
    ? compareVersions(installedVersion, catalog.latest)
    : null;

  if (installerVsLatest != null && installerVsLatest < 0) {
    console.log(`版本狀態：當前安裝器已過期，請重新下載 ${catalog.latest}`);
  } else if (!installedVersion) {
    console.log(`版本狀態：將安裝 ${INSTALLER_VERSION}`);
  } else if (installedVsLatest == null) {
    console.log("版本狀態：無法比較已安裝版本，請重新執行最新版安裝器");
  } else if (installedVsLatest < 0) {
    console.log(`版本狀態：可更新 ${installedVersion} → ${catalog.latest}`);
  } else if (installedVsLatest === 0) {
    console.log("版本狀態：已是最新版本");
  } else {
    console.log("版本狀態：已安裝版本比線上版本更新");
  }

  const releases = releasesBetween(catalog, installedVersion);
  if (releases.length === 0) return;
  const heading =
    !installedVersion || installedVsLatest == null
      ? "最新版本內容"
      : installedVsLatest === 0
        ? "當前版本內容"
        : "更新內容";
  console.log(`${heading}：`);
  for (const release of releases) {
    console.log(`  ${release.version}${release.date ? `（${release.date}）` : ""}`);
    for (const change of release.changes) console.log(`    - ${change}`);
  }
}

export function candidateApiRoots(baseUrl) {
  const normalized = normalizeUrl(baseUrl);
  const candidates = [];
  if (/\/v1$/i.test(new URL(normalized).pathname)) {
    candidates.push(normalized);
  } else {
    candidates.push(`${normalized}/v1`, normalized);
  }
  return [...new Set(candidates)];
}

// 模型 -> 供應商（取自 /models 的 owned_by），用來決定是否啟用 Anthropic 轉譯。
const modelOwners = new Map();

export function normalizeOwner(owner) {
  const value = String(owner || "").toLowerCase();
  if (value.includes("anthropic")) return "anthropic";
  if (value.includes("openai")) return "openai";
  if (value.includes("xai") || value.includes("grok")) return "xai";
  return value || "unknown";
}

// 供應商欄位沒有統一名稱，各家自架閘道用的鍵不一樣。
function ownerOf(item) {
  return normalizeOwner(item?.owned_by ?? item?.owner ?? item?.provider ?? item?.vendor);
}

// 有些閘道的 /models 完全不帶供應商欄位（例如直接回 Anthropic 格式的
// {id, type, display_name, created_at}），此時只能從模型名推斷。
// 猜錯是安全的：下面會先探測原生 /messages，不通就回退到通用 Responses 路由。
export function looksAnthropic(model) {
  return /(^|[/:_-])(claude|anthropic)([/:._-]|$)/i.test(String(model || ""));
}

function parseModelList(payload) {
  const values = [];
  if (Array.isArray(payload?.data)) {
    for (const item of payload.data) {
      if (typeof item?.id === "string" && item.id.trim()) {
        values.push(item.id.trim());
        modelOwners.set(item.id.trim(), ownerOf(item));
      }
    }
  }
  if (Array.isArray(payload?.models)) {
    for (const item of payload.models) {
      const value = item?.id ?? item?.slug ?? item?.model;
      if (typeof value === "string" && value.trim()) {
        values.push(value.trim());
        if (!modelOwners.has(value.trim())) modelOwners.set(value.trim(), ownerOf(item));
      }
    }
  }
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

async function discoverApiRoot(baseUrl, apiKey) {
  const failures = [];
  for (const apiRoot of candidateApiRoots(baseUrl)) {
    const modelsUrl = `${apiRoot.replace(/\/$/, "")}/models`;
    try {
      const response = await fetchWithTimeout(modelsUrl, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      const text = await response.text();
      if (!response.ok) {
        failures.push(`${modelsUrl}: HTTP ${response.status}`);
        continue;
      }
      const models = parseModelList(JSON.parse(text));
      if (models.length === 0) {
        failures.push(`${modelsUrl}：響應中沒有模型 ID`);
        continue;
      }
      return { apiRoot, models };
    } catch (error) {
      failures.push(`${modelsUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  fail(`無法發現可用模型。${failures.join("；")}`);
}

function parseSelection(value, modelCount) {
  if (/^(all|\*)$/i.test(value.trim())) {
    return Array.from({ length: modelCount }, (_, index) => index);
  }
  const selected = new Set();
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      for (let number = low; number <= high; number += 1) {
        if (number < 1 || number > modelCount) fail(`選擇項 ${number} 超出範圍。`);
        selected.add(number - 1);
      }
      continue;
    }
    if (!/^\d+$/.test(part)) fail(`選擇格式無效：${part}`);
    const number = Number(part);
    if (number < 1 || number > modelCount) fail(`選擇項 ${number} 超出範圍。`);
    selected.add(number - 1);
  }
  if (selected.size === 0) fail("沒有選擇任何模型。" );
  return [...selected].sort((a, b) => a - b);
}

// 選擇模型：編號、範圍、all，或直接輸入清單沒有列出的模型 ID——部分閘道的 /models
// 不完整，模型明明能用卻選不到。手動輸入的 ID 照樣要通過探測才會加入。
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

export function parseModelSelection(value, models) {
  const trimmed = String(value || "").trim();
  if (/^(all|\*)$/i.test(trimmed)) return [...models];
  const selected = [];
  const add = (model) => { if (!selected.includes(model)) selected.push(model); };
  for (const rawPart of trimmed.split(/[,，]/)) {
    const part = rawPart.trim();
    if (!part) continue;
    if (/^\d+(?:\s*-\s*\d+)?$/.test(part)) {
      for (const index of parseSelection(part, models.length)) add(models[index]);
      continue;
    }
    if (!MODEL_ID_PATTERN.test(part)) fail(`模型 ID 格式無效：${part}`);
    add(part);
  }
  if (selected.length === 0) fail("沒有選擇任何模型。");
  return selected;
}

async function selectModels(models) {
  printHeading("可用模型");
  if (models.length === 0) console.log("  （清單上沒有可選的模型）");
  models.forEach((model, index) => {
    console.log(`${String(index + 1).padStart(3)}. ${model}`);
  });
  const automaticSelection = env.CODEX_MODEL_ROUTER_TEST_MODELS;
  const answer =
    automaticSelection ||
    (await ask("請輸入模型編號（可用逗號、範圍或 all），清單沒列出的模型也可以直接輸入 ID"));
  return parseModelSelection(answer, models);
}

// 探測輸出。平行探測時每個模型先寫進自己的緩衝區，完成後依選擇順序整段印出。
const consoleProbeLog = {
  write: (text) => process.stdout.write(text),
  line: (text = "") => console.log(text),
};

function bufferedProbeLog() {
  const chunks = [];
  return {
    write: (text) => { chunks.push(String(text)); },
    line: (text = "") => { chunks.push(`${text}\n`); },
    text: () => chunks.join(""),
  };
}

// 同時最多探測幾個模型。每個模型內部的探測仍依序進行，同時送往閘道的請求不會超過這個數；
// 閘道限流較嚴時可用 CODEX_MODEL_ROUTER_PROBE_CONCURRENCY 調低（1 等於逐一探測）。
function probeConcurrency() {
  const value = Number(env.CODEX_MODEL_ROUTER_PROBE_CONCURRENCY);
  return Number.isInteger(value) && value >= 1 ? Math.min(value, 8) : 3;
}

// 平行執行、依序輸出：結果與輸出都照 models 的順序，不會交錯。
// 任何一個探測丟出例外時，等全部結束後拋出第一個，與逐一探測時一樣中止流程。
export async function probeModelsInParallel(models, probe, {
  concurrency = probeConcurrency(),
  print = (text) => process.stdout.write(text),
} = {}) {
  const results = new Array(models.length);
  const errors = new Array(models.length);
  const logs = models.map(() => bufferedProbeLog());
  const done = new Array(models.length).fill(false);
  let printed = 0;
  let next = 0;
  const flush = () => {
    while (printed < models.length && done[printed]) {
      print(logs[printed].text());
      printed += 1;
    }
  };
  const worker = async () => {
    while (next < models.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await probe(models[index], logs[index]);
      } catch (error) {
        errors[index] = error;
      }
      done[index] = true;
      flush();
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), models.length) }, worker));
  const failure = errors.find((error) => error !== undefined);
  if (failure) throw failure;
  return results;
}

async function testResponse(apiRoot, apiKey, model, effort) {
  const body = {
    model,
    input: "Reply with exactly OK.",
    max_output_tokens: 128,
    store: false,
  };
  if (effort) body.reasoning = { effort };
  const response = await fetchWithTimeout(
    `${apiRoot.replace(/\/$/, "")}/responses`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
    90000,
  );
  const responseText = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    detail: response.ok ? "" : responseText.slice(0, 240),
  };
}

// Anthropic 的驗證錯誤會直接回報上限，且驗證在推論前發生（不計費）。
// 送遠超任何現有模型的長度，確保必定被拒 —— 因此這個探測是免費的。
async function probeAnthropicContextWindow(apiRoot, apiKey, model) {
  const filler = "word ".repeat(1300000);
  try {
    const response = await fetchWithTimeout(
      `${apiRoot.replace(/\/$/, "")}/messages`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: filler }] }),
      },
      180000,
    );
    const text = await response.text();
    const match = /prompt is too long:\s*\d+\s*tokens?\s*>\s*(\d+)\s*maximum/i.exec(text);
    if (match) return Number(match[1]);
  } catch {}
  return null;
}

// max_tokens 超標同樣是免費的驗證錯誤，順便帶出正式模型 ID。
async function probeAnthropicMaxOutput(apiRoot, apiKey, model) {
  try {
    const response = await fetchWithTimeout(
      `${apiRoot.replace(/\/$/, "")}/messages`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 9999999, messages: [{ role: "user", content: "hi" }] }),
      },
      60000,
    );
    const text = await response.text();
    const limit = /max_tokens:\s*\d+\s*>\s*(\d+)/i.exec(text);
    const id = /output tokens for ([A-Za-z0-9._-]+)/i.exec(text);
    return { maxOutput: limit ? Number(limit[1]) : null, canonicalId: id ? id[1] : null };
  } catch {}
  return { maxOutput: null, canonicalId: null };
}

// 探測某個 Anthropic 請求參數能不能用。
// 回傳 true / false；無法判定（暫時性故障）時回傳 null，由呼叫端保守處理。
async function probeAnthropicParam(apiRoot, apiKey, model, extra) {
  try {
    const response = await fetchWithTimeout(
      `${apiRoot.replace(/\/$/, "")}/messages`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model, max_tokens: 16,
          messages: [{ role: "user", content: "Reply with exactly OK." }],
          ...extra,
        }),
      },
      60000,
    );
    if (response.ok) {
      await response.text();
      return true;
    }
    await response.text();
    // 5xx／限流只代表這次問不到，不能據此判定參數不支援。
    if (isTransientProbeStatus(response.status)) return null;
    return false;
  } catch {
    return null;
  }
}

// Anthropic 模型走原生 /messages（閘道的 Responses 相容層對 Claude 是壞的）。
async function probeAnthropicModel(apiRoot, apiKey, model) {
  try {
    const response = await fetchWithTimeout(
      `${apiRoot.replace(/\/$/, "")}/messages`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model, max_tokens: 16, stream: true,
          messages: [{ role: "user", content: "Reply with exactly OK." }],
        }),
      },
      90000,
    );
    const text = await response.text();
    let detail = "";
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.message || "";
    } catch {}
    return { ok: response.ok, status: response.status, detail: detail || text.slice(0, 160) };
  } catch (error) {
    return { ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) };
  }
}

// 「這次問不到」與「模型不支援」必須分開。額度用盡、上游容量不足、閘道逾時
// 都會讓探測失敗，但模型本身好好的——把這種結果當成不支援，就會在重新配置時
// 把原本正常的模型或推理強度從設定裡刪掉，而且刪得無聲無息。
export function isTransientProbeStatus(status) {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

async function probeModel(apiRoot, apiKey, model, log = consoleProbeLog) {
  const supportedEfforts = [];
  const transientEfforts = [];
  for (const effort of EFFORTS) {
    log.write(`  ${effort.padEnd(7)} `);
    try {
      const result = await testResponse(apiRoot, apiKey, model, effort);
      if (result.ok) {
        supportedEfforts.push(effort);
        log.line("支持");
      } else if (isTransientProbeStatus(result.status)) {
        transientEfforts.push(effort);
        log.line(`暫時不可用（HTTP ${result.status}）`);
      } else {
        log.line(`不支持（HTTP ${result.status}）`);
      }
    } catch (error) {
      // 逾時或連線層例外同樣只代表這次問不到。
      transientEfforts.push(effort);
      log.line(`暫時不可用（${error instanceof Error ? error.message : String(error)}）`);
    }
  }

  if (supportedEfforts.length > 0) {
    return {
      supported: true,
      efforts: supportedEfforts,
      stripReasoning: false,
      transientEfforts,
    };
  }

  log.write("  預設    ");
  try {
    const result = await testResponse(apiRoot, apiKey, model, null);
    if (result.ok) {
      log.line("支援，但不提供推理強度控制");
      return { supported: true, efforts: [], stripReasoning: true, transientEfforts };
    }
    log.line(`不支持（HTTP ${result.status}）`);
    return {
      supported: false,
      efforts: [],
      stripReasoning: false,
      transientEfforts,
      transient: isTransientProbeStatus(result.status),
    };
  } catch (error) {
    log.line(`暫時不可用（${error instanceof Error ? error.message : String(error)}）`);
    return { supported: false, efforts: [], stripReasoning: false, transientEfforts, transient: true };
  }
}

// Chat Completions 的小型探測：串流一小段回覆。extra 用來測上游收不收某個參數。
async function testChatCompletion(apiRoot, apiKey, model, extra = {}) {
  const response = await fetchWithTimeout(
    `${apiRoot.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly OK." }],
        max_tokens: 32,
        stream: true,
        ...extra,
      }),
    },
    90000,
  );
  const text = await response.text();
  return {
    // 串流回應裡一定有 choices；少數伺服器不理會 stream 直接回整個 JSON，一樣有 choices。
    ok: response.ok && text.includes("\"choices\""),
    status: response.ok && !text.includes("\"choices\"") ? 502 : response.status,
    detail: response.ok ? "" : text.slice(0, 240),
  };
}

const CHAT_PROBE_TOOL = {
  type: "function",
  function: {
    name: "report_status",
    description: "Report the current status.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

// 回傳 { supported, transient, tools, streamOptions, efforts }。
export async function probeChatModel(apiRoot, apiKey, model, log = consoleProbeLog) {
  const describe = (error) => (error instanceof Error ? error.message : String(error));
  let streamOptions = true;
  log.write("  Chat Completions ");
  let result;
  try {
    result = await testChatCompletion(apiRoot, apiKey, model, { stream_options: { include_usage: true } });
    // 少數閘道不認得 stream_options：拿掉再試一次，之後就不要求用量。
    if (!result.ok && result.status === 400) {
      const retry = await testChatCompletion(apiRoot, apiKey, model);
      if (retry.ok) {
        result = retry;
        streamOptions = false;
      }
    }
  } catch (error) {
    log.line(`暫時不可用（${describe(error)}）`);
    return { supported: false, transient: true };
  }
  if (!result.ok) {
    const transient = isTransientProbeStatus(result.status);
    log.line(`${transient ? "暫時不可用" : "不支持"}（HTTP ${result.status}）${result.detail ? "：" + result.detail : ""}`);
    return { supported: false, transient };
  }
  log.line(streamOptions ? "支持" : "支持（閘道不接受 stream_options，不回報用量）");
  const base = streamOptions ? { stream_options: { include_usage: true } } : {};

  // Codex 幾乎每一輪都帶工具。上游拒收 tools 參數的模型只能用文字回答。
  log.write("  工具呼叫         ");
  let tools = true;
  try {
    const probe = await testChatCompletion(apiRoot, apiKey, model, { ...base, tools: [CHAT_PROBE_TOOL] });
    if (probe.ok) log.line("支持");
    else if (isTransientProbeStatus(probe.status)) log.line(`暫時無法確認（HTTP ${probe.status}），先當作支援`);
    else {
      tools = false;
      log.line(`不支持（HTTP ${probe.status}），這個模型在 Codex 裡只能用文字回答`);
    }
  } catch (error) {
    log.line(`暫時無法確認（${describe(error)}），先當作支援`);
  }

  log.write("  推理強度控制     ");
  let efforts = [];
  try {
    const probe = await testChatCompletion(apiRoot, apiKey, model, { ...base, reasoning_effort: "low" });
    if (probe.ok) {
      efforts = ["low", "medium", "high"];
      log.line("reasoning_effort（low／medium／high）");
    } else {
      log.line(isTransientProbeStatus(probe.status)
        ? `暫時無法確認（HTTP ${probe.status}），使用模型預設`
        : "不支持，使用模型預設");
    }
  } catch (error) {
    log.line(`暫時無法確認（${describe(error)}），使用模型預設`);
  }
  return { supported: true, transient: false, tools, streamOptions, efforts };
}

// --- 中轉供應商 ---------------------------------------------------------------
//
// 1.24.0 起可以同時設定多家。settings.json 以 providers 陣列記錄；舊版只有一家，
// 欄位直接放在頂層。讀的時候兩種都認，寫的時候一律寫成新格式。
//
// 第一家是主要供應商：「安裝或重新配置」改的是它，Codex 內建 image_gen 也送它。
// 舊版的唯一一家 id 是 default，它的選擇器 ID 與顯示名稱規則與以前完全相同，
// 既有對話選的模型不會因為升級而失效。其他供應商的路由帶 providerId，
// 選擇器 ID 與顯示名稱都含供應商名稱，同一個模型在兩家都有時才不會撞在一起。
export const DEFAULT_PROVIDER_ID = "default";
const LEGACY_PROVIDER_FIELDS = ["apiRoot", "baseUrl", "keychainService", "keychainAccount", "credentialPath"];
const PROVIDER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
const RESERVED_PROVIDER_IDS = new Set([DEFAULT_PROVIDER_ID, "api", "custom", "official", "claude-cli"]);

function providerRecord(source, id) {
  return {
    id,
    baseUrl: source.baseUrl,
    apiRoot: source.apiRoot,
    keychainService: source.keychainService,
    keychainAccount: source.keychainAccount || "codex",
    credentialPath: source.credentialPath ?? null,
  };
}

export function installedProviders(settings, manifest = null) {
  for (const source of [settings, manifest]) {
    if (Array.isArray(source?.providers) && source.providers.length > 0) {
      return source.providers.map((provider) => providerRecord(provider, String(provider.id || DEFAULT_PROVIDER_ID)));
    }
  }
  // 舊版只有一家，欄位在頂層；settings 缺的欄位用 manifest 補。
  const legacy = {};
  for (const field of LEGACY_PROVIDER_FIELDS) legacy[field] = settings?.[field] ?? manifest?.[field];
  if (!legacy.baseUrl && !legacy.apiRoot && !legacy.keychainService) return [];
  return [providerRecord(legacy, DEFAULT_PROVIDER_ID)];
}

// 寫回 settings／manifest：記錄 providers，拿掉舊版放在頂層的單一供應商欄位。
export function withProviders(record, providers) {
  const next = { ...record, providers: providers.map((provider) => ({ ...provider })) };
  for (const field of LEGACY_PROVIDER_FIELDS) delete next[field];
  return next;
}

// install.json 另外留一份主要供應商的舊欄位：舊版安裝器的 status 與 rollback 不檢查版本，
// 仍會讀這些欄位（rollback 靠 keychainService 刪 Key，缺了會中途出錯）。讀取時以 providers 為準。
export function manifestWithProviders(manifest, providers) {
  const next = withProviders(manifest, providers);
  if (providers[0]) {
    for (const field of LEGACY_PROVIDER_FIELDS) next[field] = providers[0][field];
  }
  return next;
}

export function routeProviderId(route) {
  return route?.providerId || DEFAULT_PROVIDER_ID;
}

export function providerIdError(id, takenIds = []) {
  if (!PROVIDER_ID_PATTERN.test(id)) {
    return "名稱只能用小寫英文、數字與連字號，1 到 24 個字元，不能以連字號開頭或結尾。";
  }
  if (RESERVED_PROVIDER_IDS.has(id)) return `「${id}」是保留名稱，請換一個。`;
  if (takenIds.includes(id)) return `已經有叫「${id}」的供應商了。`;
  return null;
}

// 從網址猜一個好記的名稱：api.openrouter.ai → openrouter、relay.example.com.cn → example。
// 只是預設值，使用者可以改。
const GENERIC_HOST_LABELS = new Set(["api", "www", "gateway", "gw"]);
const SECOND_LEVEL_SUFFIXES = new Set(["com", "net", "org", "co", "ac", "gov", "edu"]);

export function suggestProviderId(baseUrl, takenIds = []) {
  let base = "relay";
  try {
    const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname === "localhost" || isIP(hostname)) base = "local";
    else {
      const labels = hostname.split(".").filter(Boolean);
      let end = labels.length - 1;
      if (end >= 2 && SECOND_LEVEL_SUFFIXES.has(labels[end - 1])) end -= 1;
      const meaningful = labels.slice(0, Math.max(end, 1)).filter((label) => !GENERIC_HOST_LABELS.has(label));
      base = meaningful.at(-1) || base;
    }
  } catch { /* 網址無效時用預設名稱，稍後的驗證會擋下網址本身。 */ }
  base = base.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "relay";
  let candidate = base;
  for (let suffix = 2; providerIdError(candidate, takenIds); suffix += 1) candidate = `${base}-${suffix}`;
  return candidate;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url || ""); }
}

function providerLine(provider, routes = []) {
  const count = routes.filter((route) => routeProviderId(route) === provider.id).length;
  return `${provider.id}（${hostOf(provider.baseUrl || provider.apiRoot)}）— ${count} 個模型`;
}

function printProviders(providers, routes = []) {
  if (providers.length === 1) {
    console.log(`Base URL：${providers[0].baseUrl}`);
    return;
  }
  console.log(`供應商：${providers.length} 家`);
  providers.forEach((provider, index) => {
    console.log(`  ${index + 1}. ${providerLine(provider, routes)}${index === 0 ? "，主要供應商" : ""}`);
  });
}

// 依編號或名稱選一家。allowCancel 時 Enter 或 cancel 回傳 null。
async function chooseProvider(providers, routes, question, { preferredId = null, allowCancel = false } = {}) {
  providers.forEach((provider, index) => console.log(`  ${index + 1}. ${providerLine(provider, routes)}`));
  const preferred = Math.max(0, providers.findIndex((provider) => provider.id === preferredId));
  const answer = (await ask(
    `${question}（編號或名稱${allowCancel ? "；Enter／cancel 返回" : ""}）`,
    allowCancel ? null : String(preferred + 1),
  )).trim().toLowerCase();
  if (allowCancel && (!answer || answer === "cancel")) return null;
  const provider = /^\d+$/.test(answer) ? providers[Number(answer) - 1] : providers.find((item) => item.id === answer);
  if (!provider) fail(`找不到供應商：${answer}`);
  return provider;
}

export function pickerSlug(model, providerId = DEFAULT_PROVIDER_ID) {
  const scope = providerId && providerId !== DEFAULT_PROVIDER_ID ? providerId : null;
  const readable = model
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 44) || "model";
  const digest = createHash("sha256").update(scope ? `${scope}\n${model}` : model).digest("hex").slice(0, 8);
  return scope ? `custom/${scope}-${readable}-${digest}` : `custom/${readable}-${digest}`;
}

export function withDefaultModelPrefix(route) {
  if (typeof route?.upstreamModel !== "string" || !route.upstreamModel) return route;
  const model = route.upstreamModel;
  const providerId = routeProviderId(route);
  // 已有上游前綴時保留原名；不同供應商仍由 pickerSlug 與 providerId 區分。
  if (model.includes("/")) return route.displayName ? route : { ...route, displayName: model };
  if (providerId !== DEFAULT_PROVIDER_ID) {
    if (route.displayName && route.displayName !== model) return route;
    return { ...route, displayName: `${providerId}/${model}` };
  }
  // 只補自動產生的顯示名稱；上游 ID、選擇器 ID 與使用者手動取的名稱都保留。
  if (route.displayName && route.displayName !== model) return route;
  return { ...route, displayName: `api/${model}` };
}

export function prefixCatalogDisplayNames(catalog, routes) {
  if (!Array.isArray(catalog?.models)) return catalog;
  const bySlug = new Map(routes.map((route) => [route.pickerSlug, withDefaultModelPrefix(route)]));
  let changed = false;
  const models = catalog.models.map((model) => {
    const route = bySlug.get(model.slug);
    if (!String(model.slug).startsWith("custom/") || !route ||
        route.upstreamModel.includes("/") ||
        (model.display_name && model.display_name !== route.upstreamModel) ||
        model.display_name === route.displayName) return model;
    changed = true;
    return { ...model, display_name: route.displayName };
  });
  return changed ? { ...catalog, models } : catalog;
}

function defaultEffort(efforts) {
  for (const effort of ["medium", "low", "high", "xhigh", "max"]) {
    if (efforts.includes(effort)) return effort;
  }
  return "none";
}

// Codex 在 Windows 上每次更新都裝進新的版本雜湊目錄，所以不能只記住當下那支
// 執行檔——路由器得知道去哪裡找最新的。
function codexBinSearchDir() {
  if (!isWindows) return null;
  return join(localAppData(), "OpenAI", "Codex", "bin");
}

// bundled 目錄把尚未普及的模型標成 hide，但實際能不能用是後端依帳號決定的；
// model_catalog_json 會蓋掉後端的判斷，於是帳號有權限也看不到。
export function applyForcedVisibility(models, forceListed) {
  if (!Array.isArray(forceListed) || forceListed.length === 0) return models;
  const forced = new Set(forceListed);
  return models.map((model) =>
    forced.has(model.slug) ? { ...model, visibility: "list" } : model,
  );
}

export function hiddenOfficialModels(catalog) {
  return (catalog?.models || []).filter(
    (model) =>
      !String(model?.slug || "").startsWith("custom/") &&
      model?.visibility === "hide",
  );
}


export function normalizeForceListedModels(officialModels, forceListed) {
  const known = new Set(
    (officialModels || [])
      .map((model) => model?.slug)
      .filter(
        (slug) =>
          typeof slug === "string" &&
          slug &&
          !slug.startsWith("custom/"),
      ),
  );
  const wanted = new Set(Array.isArray(forceListed) ? forceListed : []);
  return (officialModels || [])
    .map((model) => model?.slug)
    .filter(
      (slug) =>
        typeof slug === "string" &&
        known.has(slug) &&
        wanted.has(slug),
    );
}

// 只更新官方模型的 visibility，第三方 custom/* 項目原樣保留。
// 這是獨立 hidden-models 命令與路由器自動刷新共用的資料契約。
export function mergeCatalogForForcedModels(
  freshCatalog,
  currentCatalog,
  forceListed = [],
) {
  const officialModels = (freshCatalog?.models || []).filter(
    (model) => !String(model?.slug || "").startsWith("custom/"),
  );
  if (officialModels.length === 0) throw new Error("bundled 目錄沒有官方模型");
  const official = applyForcedVisibility(
    officialModels,
    normalizeForceListedModels(officialModels, forceListed),
  );
  const custom = (currentCatalog?.models || []).filter((model) =>
    String(model?.slug || "").startsWith("custom/"),
  );
  const maxPriority = Math.max(
    0,
    ...official.map((model) => Number(model.priority) || 0),
  );
  const renumbered = custom.map((model, index) => ({
    ...model,
    priority: maxPriority + index + 1,
  }));
  return { ...freshCatalog, models: [...official, ...renumbered] };
}

export function validateManagedCatalog(catalog, forceListed = [], customSlugs = []) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const bySlug = new Map(
    models
      .filter((model) => typeof model?.slug === "string")
      .map((model) => [model.slug, model]),
  );
  const hiddenForced = forceListed.filter(
    (slug) => bySlug.get(slug)?.visibility === "hide",
  );
  const missingForced = forceListed.filter((slug) => !bySlug.has(slug));
  const missingCustom = customSlugs.filter((slug) => !bySlug.has(slug));
  return {
    ok: hiddenForced.length === 0 && missingForced.length === 0 && missingCustom.length === 0,
    hiddenForced,
    missingForced,
    missingCustom,
  };
}

// 使用者可以在 settings.json 裡調的旋鈕。安裝器用固定欄位重寫整個檔案，因此
// 沒列在這裡的東西每次重裝都會靜默消失——README 明文寫給使用者調的
// maxLogBytes、viewImageBridge、upstreamWebSocket* 全都在內。
// imageOutputDir 與 forceListedModels 不列在這：前者由 resolveImageOutputDir
// 處理（沒設過時還要算預設值），後者由 install() 直接沿用既有值——安裝流程
// 不再詢問隱藏模型，改由 hidden-models 命令單獨管理。
// 路由器讀取的每一個可調設定都要列在這裡；test/settings-keys.test.mjs 會核對。
export const preservedSettingKeys = [
  "claudeCli",
  "authProbeGraceMs",
  "captureDir",
  "catalogRefresh",
  "closeOnUpstreamError",
  // 網頁管理介面拖曳排序後設為 "manual"：之後新增的模型接在最後，不再依探測清單重排。
  "customModelOrder",
  "heartbeatIntervalMs",
  "historyTtlMs",
  "maxHistoryBytes",
  "maxHttpBodyBytes",
  "maxLogBytes",
  "maxUpstreamRequestBytes",
  "upstreamWebSocket",
  "upstreamWebSocketCooldownMs",
  "upstreamWebSocketFailureThreshold",
  "viewImageBridge",
];

function readSettingsIfExists() {
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return {};
  }
}

function readCatalogIfExists() {
  try {
    return JSON.parse(readFileSync(catalogPath, "utf8"));
  } catch {
    return null;
  }
}

function preservedSettings() {
  const previous = readSettingsIfExists();
  const kept = {};
  for (const key of preservedSettingKeys) {
    if (previous[key] !== undefined) kept[key] = previous[key];
  }
  return kept;
}

// 隱藏模型只由 hidden-models 命令使用：安裝流程不該為了一個與 Base URL、
// API Key、模型探測都無關的選項多問一次。
async function chooseForcedModels(officialModels, previous) {
  const hidden = officialModels.filter((model) => model.visibility === "hide");
  const previousList = Array.isArray(previous) ? previous : [];
  if (hidden.length === 0) return previousList.filter((slug) => slug);

  printHeading("隱藏的官方模型");
  console.log("以下模型被 Codex 的內建目錄標成隱藏，預設不會出現在選擇器裡：\n");
  hidden.forEach((model, index) => {
    const mark = previousList.includes(model.slug) ? "（目前已強制顯示）" : "";
    console.log(`  ${index + 1}. ${model.display_name || model.slug}`);
    console.log(`     ${model.slug} ${mark}`);
  });
  console.log(
    "\n能不能用是後端依帳號決定的，跟這份目錄無關。強制顯示後若帳號其實沒有權限，",
  );
  console.log("選了會在請求時失敗——改回來就好，不影響其他模型。" );

  const answer = (
    await ask(
      "要強制顯示哪幾個？逗號分隔編號、all 全選、none 清空、留空保留目前設定",
      "",
    )
  ).trim();
  if (!answer) return previousList;
  if (/^(none|0)$/i.test(answer)) return [];
  if (answer.toLowerCase() === "all") return hidden.map((model) => model.slug);

  const chosen = [];
  for (const piece of answer.split(/[,，\s]+/).filter(Boolean)) {
    const index = Number(piece);
    if (!Number.isInteger(index) || index < 1 || index > hidden.length) {
      fail(`選擇超出範圍：${piece}`);
    }
    const slug = hidden[index - 1].slug;
    if (!chosen.includes(slug)) chosen.push(slug);
  }
  return chosen;
}

function loadBundledCatalog() {
  const result = shell(
    codexBin,
    [
      "debug",
      "models",
      "--bundled",
      "-c",
      "model_catalog_json=null",
      "-c",
      'model_provider="openai"',
    ],
    { env: { ...env, CODEX_HOME: codexHome } },
  );
  const catalog = JSON.parse(result.stdout);
  if (!Array.isArray(catalog?.models) || catalog.models.length === 0) {
    fail("Codex 回傳了空的內建模型目錄。" );
  }
  return catalog;
}

export function catalogTemplates(bundled, current) {
  const bySlug = new Map((bundled.models || []).filter(m => !m.slug.startsWith("custom/")).map(m => [m.slug, m]));
  for (const model of current?.models || []) {
    if (!model.slug.startsWith("custom/")) bySlug.set(model.slug, model);
  }
  return { ...bundled, models: [...bySlug.values()] };
}

function loadCatalogTemplates() {
  const bundled = loadBundledCatalog();
  try { return catalogTemplates(bundled, JSON.parse(readFileSync(catalogPath, "utf8"))); }
  catch { return bundled; }
}

export function mergeAddedModels(officialModels, current, routes, newRoutes) {
  const added = new Set(newRoutes.map(r => r.pickerSlug));
  const previous = new Map((current?.models || []).map(m => [m.slug, m]));
  return routes.map((route, index) => {
    if (!added.has(route.pickerSlug) && previous.has(route.pickerSlug)) return previous.get(route.pickerSlug);
    return customCatalogEntry(officialModels, route, index);
  });
}

export function orderCustomModelsByDiscovery(officialModels, customModels, routes, discoveredModels) {
  const upstreamBySlug = new Map(routes.map(route => [route.pickerSlug, route.upstreamModel]));
  const rank = new Map(discoveredModels.map((model, index) => [model, index]));
  const maxPriority = Math.max(0, ...officialModels.map(model => Number(model.priority) || 0));
  return customModels
    .map((model, index) => ({ model, index, rank: rank.get(upstreamBySlug.get(model.slug)) ?? Infinity }))
    .sort((left, right) => left.rank === right.rank
      ? left.index - right.index
      : left.rank - right.rank)
    .map(({ model }, index) => ({ ...model, priority: maxPriority + index + 1 }));
}

// 多家供應商時，選單裡的自訂模型依供應商分組，主要供應商在前。這次探測的那一家
// 照 orderCustomModelsByDiscovery 的規則排；其他家維持現有目錄裡的相對順序——
// settings 裡的順序是添加的先後，不是選單上的順序。只有一家時結果與
// orderCustomModelsByDiscovery 完全相同。
//
// manual：使用者在網頁管理介面拖曳排過順序。既有模型一律維持目前目錄裡的位置，
// 新模型接在最後（彼此之間依探測清單的順序），不再依供應商分組。
export function arrangeCustomModels(officialModels, customModels, routes, providerIds, probed, currentCatalog = null,
  { manual = false } = {}) {
  const maxPriority = Math.max(0, ...officialModels.map((model) => Number(model.priority) || 0));
  if (manual) {
    const catalogOrder = new Map((currentCatalog?.models || [])
      .filter((model) => String(model.slug).startsWith("custom/"))
      .map((model, index) => [model.slug, index]));
    const upstreamBySlug = new Map(routes.map((route) => [route.pickerSlug, route.upstreamModel]));
    const rank = new Map((probed?.models || []).map((model, index) => [model, index]));
    const position = (model) => catalogOrder.has(model.slug)
      ? [0, catalogOrder.get(model.slug)]
      : [1, rank.get(upstreamBySlug.get(model.slug)) ?? Number.MAX_SAFE_INTEGER];
    return customModels
      .map((model, index) => ({ model, index, position: position(model) }))
      .sort((left, right) => left.position[0] - right.position[0] ||
        left.position[1] - right.position[1] || left.index - right.index)
      .map(({ model }, index) => ({ ...model, priority: maxPriority + index + 1 }));
  }
  const providerOf = new Map(routes.map((route) => [route.pickerSlug, routeProviderId(route)]));
  const probedRoutes = routes.filter((route) => routeProviderId(route) === probed.providerId);
  const ranked = orderCustomModelsByDiscovery(officialModels, customModels, probedRoutes, probed.models);
  const catalogOrder = new Map((currentCatalog?.models || []).map((model, index) => [model.slug, index]));
  const groupOf = (model) => {
    const index = providerIds.indexOf(providerOf.get(model.slug));
    return index < 0 ? providerIds.length : index;
  };
  const orderKey = (model, index) => {
    if (providerOf.get(model.slug) === probed.providerId) return [0, index];
    return catalogOrder.has(model.slug) ? [0, catalogOrder.get(model.slug)] : [1, index];
  };
  return ranked
    .map((model, index) => ({ model, group: groupOf(model), key: orderKey(model, index) }))
    .sort((left, right) => left.group - right.group || left.key[0] - right.key[0] || left.key[1] - right.key[1])
    .map(({ model }, index) => ({ ...model, priority: maxPriority + index + 1 }));
}

// 在既有供應商追加模型。純函式：寫檔、重啟與驗證交給 commitRouterChange。
export function planAddModels(manifest, settings, catalog, templates, provider, newRoutes, discoveredModels,
  binary = codexBin) {
  const providers = installedProviders(settings, manifest);
  if (!providers.some((item) => item.id === provider?.id)) fail(`找不到供應商：${provider?.id}`);
  if (!Array.isArray(settings?.routes) || !Array.isArray(catalog?.models)) {
    fail("安裝設定或模型目錄不完整，無法添加模型。");
  }
  if (newRoutes.some((route) => routeProviderId(route) !== provider.id)) fail("新模型與供應商不一致，配置未改動。");
  const existing = new Set(settings.routes.map((route) => route.pickerSlug));
  const added = newRoutes.filter((route) => !existing.has(route.pickerSlug));
  if (added.length === 0) fail("所選模型都已配置，配置未改動。");
  const routes = [...settings.routes, ...added];
  const officialModels = applyForcedVisibility(
    templates.models.filter((model) => !String(model.slug).startsWith("custom/")),
    settings.forceListedModels,
  );
  const customModels = arrangeCustomModels(
    officialModels,
    mergeAddedModels(officialModels, catalog, routes, added),
    routes,
    providers.map((item) => item.id),
    { providerId: provider.id, models: discoveredModels },
    catalog,
    { manual: settings.customModelOrder === "manual" },
  );
  const binaryField = binary ? { codexBin: binary } : {};
  return {
    added,
    settings: withProviders({ ...settings, version: INSTALLER_VERSION, routes, ...binaryField }, providers),
    manifest: manifestWithProviders({ ...manifest, version: INSTALLER_VERSION, routes, ...binaryField }, providers),
    catalog: { ...templates, models: [...officialModels, ...customModels] },
  };
}

// 依使用者在網頁上排好的順序重排自訂模型。路由器每次回應 /models 都會重讀 models.json，
// 自訂項目的順序就是陣列順序（見 router.mjs 的 mergeCatalog），因此不必重啟路由器。
export function planReorderModels(manifest, settings, catalog, orderedSlugs) {
  if (!manifest || !Array.isArray(settings?.routes) || !Array.isArray(catalog?.models)) {
    fail("安裝設定或模型目錄不完整，無法調整順序。");
  }
  const isCustom = (model) => String(model?.slug || "").startsWith("custom/");
  const official = catalog.models.filter((model) => !isCustom(model));
  const custom = catalog.models.filter(isCustom);
  const bySlug = new Map(custom.map((model) => [model.slug, model]));
  if (!Array.isArray(orderedSlugs) || orderedSlugs.length !== custom.length ||
      new Set(orderedSlugs).size !== orderedSlugs.length || orderedSlugs.some((slug) => !bySlug.has(slug))) {
    fail("排序清單與目前的自訂模型不一致，請重新整理頁面後再試。");
  }
  const maxPriority = Math.max(0, ...official.map((model) => Number(model.priority) || 0));
  return {
    changed: orderedSlugs.some((slug, index) => custom[index].slug !== slug),
    settings: { ...settings, customModelOrder: "manual" },
    manifest,
    catalog: {
      ...catalog,
      models: [...official, ...orderedSlugs.map((slug, index) => ({ ...bySlug.get(slug), priority: maxPriority + index + 1 }))],
    },
  };
}

export const MIN_CONTEXT_WINDOW = 16000;
export const MAX_CONTEXT_WINDOW = 4000000;
// Claude 轉譯每次至少送出 4,096（claude-bridge 的 OUTPUT_HEADROOM，留給回答的餘裕），
// 設得更小也不會生效，因此最小值與它相同。
export const MIN_OUTPUT_TOKENS = 4096;
export const MAX_OUTPUT_TOKENS = 1000000;
// 網頁新增模型時預先填入的上下文與輸出，表單上可以改。
export const NEW_MODEL_DEFAULTS = Object.freeze({ contextWindow: 1000000, maxOutputTokens: 128000 });
// 與 claude-bridge.mjs 的 DEFAULT_MAX_TOKENS 相同：路由沒有設定預設輸出時，每次回覆送出的 max_tokens。
export const CLAUDE_DEFAULT_MAX_OUTPUT = 32000;

const positiveNumber = (value) => (Number.isFinite(value) && value > 0 ? value : null);
const positiveSafeInteger = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

// 只有 Claude 路由（API 轉譯與 Claude CLI）會把輸出上限送往上游；Responses 與 Chat 路由
// 不送 max_output_tokens，輸出長度由上游模型自己決定，設定了也沒有作用。
export function routeUsesOutputSetting(route) {
  return route?.translate === "anthropic";
}

// 每次回覆實際送出的輸出上限。算法與 claude-bridge 的 toAnthropicRequest 相同：
// 路由的預設輸出（沒設定時 32,000，至少 4,096），再以模型上限（maxOutputTokens）夾住。
// 舊式 thinking budget 在最高強度可能再往上加一點，這裡不計入。
export function routeOutputLimit(route) {
  if (!routeUsesOutputSetting(route)) return null;
  const configured = Math.max(positiveSafeInteger(route.defaultMaxOutputTokens) ?? CLAUDE_DEFAULT_MAX_OUTPUT, MIN_OUTPUT_TOKENS);
  const cap = positiveNumber(route.maxOutputTokens);
  return cap ? Math.min(configured, cap) : configured;
}

function parseTokenSetting(value, { label, min, max }) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    fail(`${label}必須是 ${min.toLocaleString("en-US")} 到 ${max.toLocaleString("en-US")} 之間的整數。`);
  }
  return number;
}

export function normalizeNewModelDefaults({ contextWindow, maxOutputTokens } = {}) {
  const pick = (value, fallback) => (value === undefined || value === null || value === "" ? fallback : value);
  const context = parseTokenSetting(pick(contextWindow, NEW_MODEL_DEFAULTS.contextWindow),
    { label: "上下文上限", min: MIN_CONTEXT_WINDOW, max: MAX_CONTEXT_WINDOW });
  const output = parseTokenSetting(pick(maxOutputTokens, NEW_MODEL_DEFAULTS.maxOutputTokens),
    { label: "最大輸出", min: MIN_OUTPUT_TOKENS, max: MAX_OUTPUT_TOKENS });
  if (output > context) fail("最大輸出不能超過上下文上限。");
  return { contextWindow: context, maxOutputTokens: output };
}

// 套用新增模型的上下文與輸出設定。探測到上游的實際上限時以較小者為準，不會設定超過
// 模型能接受的範圍；探測不到（GPT、Chat 模型的上下文，或閘道不回報上限）才直接用設定值。
export function applyNewModelDefaults(route, defaults) {
  const next = { ...route };
  const probedContext = positiveNumber(route.contextWindow);
  next.contextWindow = probedContext ? Math.min(probedContext, defaults.contextWindow) : defaults.contextWindow;
  if (routeUsesOutputSetting(route)) {
    const cap = positiveNumber(route.maxOutputTokens);
    next.defaultMaxOutputTokens = cap ? Math.min(cap, defaults.maxOutputTokens) : defaults.maxOutputTokens;
  }
  return next;
}

export function describeRouteLimits(route) {
  const context = positiveNumber(route.contextWindow);
  const output = routeOutputLimit(route);
  return `上下文 ${context ? context.toLocaleString("en-US") : "沿用模板"}，輸出 ${output ? output.toLocaleString("en-US") : "由上游決定"}`;
}

// 修改選擇器顯示名稱、上下文上限與輸出上限。名稱與上下文只影響模型目錄，路由器轉發時
// 用不到，不必重啟；輸出上限由路由器在轉送 Claude 請求時套用，改了要重啟路由器才會生效
// （restartRouter）。上游 ID、選擇器 ID、推理強度與憑證一律不變。
export function planEditModel(manifest, settings, catalog, slug, { displayName, contextWindow, maxOutputTokens } = {}) {
  if (!manifest || !Array.isArray(settings?.routes) || !Array.isArray(catalog?.models)) {
    fail("安裝設定或模型目錄不完整，無法修改模型。");
  }
  const route = settings.routes.find((item) => item.pickerSlug === slug);
  const entry = catalog.models.find((model) => model.slug === slug);
  if (!route || !entry || !String(slug).startsWith("custom/")) fail(`所選模型不是已配置的自訂模型：${slug}`);

  let name = entry.display_name || route.displayName || route.upstreamModel;
  if (displayName !== undefined && displayName !== null) {
    name = String(displayName).replace(/\s+/g, " ").trim();
    if (!name) fail("顯示名稱不能是空白。");
    if (name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) fail("顯示名稱最多 80 個字，且不能包含控制字元。");
  }

  let context = null;
  if (contextWindow !== undefined && contextWindow !== null && contextWindow !== "") {
    const ceiling = route.transport === "claude-cli" ? 1000000 : MAX_CONTEXT_WINDOW;
    context = parseTokenSetting(contextWindow, { label: "上下文上限", min: MIN_CONTEXT_WINDOW, max: ceiling });
  }

  let outputPatch = null;
  if (maxOutputTokens !== undefined && maxOutputTokens !== null && maxOutputTokens !== "") {
    if (!routeUsesOutputSetting(route)) {
      fail("這個模型的輸出上限由上游決定：路由器不會送出 max_output_tokens，因此無法在這裡設定。");
    }
    const value = parseTokenSetting(maxOutputTokens, { label: "最大輸出", min: MIN_OUTPUT_TOKENS, max: MAX_OUTPUT_TOKENS });
    const contextLimit = context ?? positiveNumber(entry.context_window) ?? positiveNumber(route.contextWindow);
    if (contextLimit && value > contextLimit) fail("最大輸出不能超過上下文上限。");
    if (route.transport === "claude-cli") {
      // CLI 路由的上限是連接時填的保守值，不是探測結果；兩者一起調整，
      // Claude CLI 才會收到新的 CLAUDE_CODE_MAX_OUTPUT_TOKENS。
      outputPatch = { maxOutputTokens: value, defaultMaxOutputTokens: value };
    } else {
      const cap = positiveNumber(route.maxOutputTokens);
      if (cap && value > cap) {
        fail(`最大輸出不能超過這個模型的輸出上限 ${cap.toLocaleString("en-US")}（新增時由上游回報）。`);
      }
      outputPatch = { defaultMaxOutputTokens: value };
    }
    // 與目前實際送出的值相同就不寫入，免得無謂地重啟路由器。
    if (value === routeOutputLimit(route) && (!outputPatch.maxOutputTokens || outputPatch.maxOutputTokens === route.maxOutputTokens)) {
      outputPatch = null;
    }
  }

  const contextChanged = context != null && context !== entry.context_window;
  const nameChanged = name !== entry.display_name || name !== route.displayName;
  const routeContextChanged = context != null && route.contextWindow !== context;
  const outputChanged = Boolean(outputPatch) && Object.entries(outputPatch).some(([key, value]) => route[key] !== value);
  const editRoute = (item) => item.pickerSlug !== slug ? item : {
    ...item, displayName: name, ...(context != null ? { contextWindow: context } : {}), ...(outputChanged ? outputPatch : {}),
  };
  const routes = settings.routes.map(editRoute);
  return {
    changed: nameChanged || contextChanged || routeContextChanged || outputChanged,
    restartRouter: outputChanged,
    restartDesktop: nameChanged || contextChanged || routeContextChanged,
    settings: { ...settings, routes },
    manifest: { ...manifest, routes: Array.isArray(manifest.routes) ? manifest.routes.map(editRoute) : routes },
    catalog: {
      ...catalog,
      models: catalog.models.map((model) => model.slug !== slug ? model : {
        ...model,
        display_name: name,
        ...(context != null ? {
          context_window: context,
          max_context_window: context,
          effective_context_window_percent: model.effective_context_window_percent ?? 95,
        } : {}),
        ...(outputChanged && outputPatch.maxOutputTokens ? { max_output_tokens: outputPatch.maxOutputTokens } : {}),
      }),
    },
  };
}

export function customCatalogEntry(officialModels, route, index) {
  const lastSegment = route.upstreamModel.split("/").at(-1);
  const exactTemplate = officialModels.find(
    (model) => model.slug === route.upstreamModel || model.slug === lastSegment,
  );
  const fallbackTemplate =
    officialModels.find((model) => model.slug === "gpt-5.6-sol") ||
    officialModels.find((model) => model.visibility === "list") ||
    officialModels[0];
  const entry = structuredClone(exactTemplate || fallbackTemplate);
  entry.slug = route.pickerSlug;
  entry.display_name = withDefaultModelPrefix(route).displayName;
  entry.description = `${route.upstreamModel}，由 ${route.providerHost} 提供`;
  entry.default_reasoning_level = defaultEffort(route.efforts);
  entry.supported_reasoning_levels = route.efforts.map((effort) => ({
    effort,
    description: EFFORT_DESCRIPTIONS[effort],
  }));
  entry.priority =
    Math.max(...officialModels.map((model) => Number(model.priority || 0))) +
    index +
    1;
  entry.visibility = "list";
  entry.supported_in_api = true;
  entry.additional_speed_tiers = [];
  entry.service_tiers = [];
  entry.availability_nux = null;
  entry.upgrade = null;
  entry.supports_search_tool = false;
  delete entry.web_search_tool_type;
  // 只有 Chat Completions 的模型改用一般函式工具，不用 Code Mode：Code Mode 要模型把整段
  // JavaScript 塞進單一工具參數，這些模型熟悉的是一般的函式呼叫。
  if (route.translate === "chat") delete entry.tool_mode;
  // 上下文視窗解析順序：探測值 > 官方同名模板 > 通用模板值（並警告）。
  if (Number.isFinite(route.contextWindow) && route.contextWindow > 0) {
    entry.context_window = route.contextWindow;
    entry.max_context_window = route.contextWindow;
    entry.effective_context_window_percent = 95;
  } else if (!exactTemplate) {
    console.log(
      `  ⚠️  ${route.upstreamModel}：未取得中轉上下文上限，也沒有官方同名模板，` +
        `沿用模板值 ${entry.context_window}。如與實際不符請手動修改 models.json。`,
    );
  } else {
    console.log(`  ${route.upstreamModel}：沿用官方同名模板的上下文 ${entry.context_window} tokens（非中轉實測上限）。`);
  }
  if (Number.isFinite(route.maxOutputTokens) && route.maxOutputTokens > 0) {
    entry.max_output_tokens = route.maxOutputTokens;
  }
  return entry;
}

function deepGet(object, path) {
  const parts = path.split(".");
  let current = object;
  for (const part of parts) {
    if (current == null || !Object.hasOwn(current, part)) {
      return { present: false, value: null };
    }
    current = current[part];
  }
  return { present: true, value: current };
}

// 同一時間只讓本行程跑一個 Codex 子行程（app-server、debug models、login status）。網頁管理介面的
// 背景刷新常和操作撞在一起；Windows 上同一個 CODEX_HOME 同時啟動兩個 Codex 行程，後啟動的那個
// 會失敗（CI 上設定全域上下文後立即查詢就重現）。只包最底層的呼叫：被包的工作不能再取得這把鎖。
let codexChain = Promise.resolve();
export function withCodexLock(task) {
  const run = codexChain.then(() => task());
  codexChain = run.then(() => {}, () => {});
  return run;
}

// 等子行程真的結束再放開鎖：Windows 上檔案要等行程結束才會釋放。最多等 5 秒。
function stopChildProcess(child, timeoutMs = 5000) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    child.kill("SIGTERM");
  });
}

export function codexRpc(method, params, acceptResult = () => true, binary = codexBin, home = codexHome) {
  return withCodexLock(() => codexRpcOnce(method, params, acceptResult, binary, home));
}

async function codexRpcOnce(method, params, acceptResult, binary, home) {
  const child = spawn(binary, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...env, CODEX_HOME: home },
  });
  child.stderr.on("data", () => {});
  let buffer = "";
  let settled = false;
  let retryTimer;
  let timeout;
  const responsePromise = new Promise((resolvePromise, rejectPromise) => {
    timeout = setTimeout(() => {
      if (!settled) rejectPromise(new Error(`Timed out waiting for ${method}`));
    }, 30000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (!message.error && !acceptResult(message.result)) {
            retryTimer = setTimeout(() => {
              if (!settled) child.stdin.write(`${JSON.stringify({ method, id: 1, params })}\n`);
            }, 250);
            continue;
          }
          settled = true;
          clearTimeout(timeout);
          if (message.error) rejectPromise(new Error(message.error.message));
          else resolvePromise(message.result);
        }
      }
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (!settled) rejectPromise(new Error(`Codex app-server exited with code ${code}`));
    });
  });
  child.stdin.write(
    `${JSON.stringify({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: {
          name: "codex_model_router_installer",
          title: "Codex 模型路由器安裝器",
          version: INSTALLER_VERSION,
        },
      },
    })}\n`,
  );
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ method, id: 1, params })}\n`);
  try {
    return await responsePromise;
  } finally {
    settled = true;
    clearTimeout(timeout);
    clearTimeout(retryTimer);
    await stopChildProcess(child);
  }
}

export function hasExpectedModels(result, expected, absent = []) {
  const models = new Set((result?.data || []).map(m => m.id));
  return expected.every(slug => models.has(slug)) && absent.every(slug => !models.has(slug));
}

async function waitForPickerModels(routes, absent = []) {
  const expected = routes.map(r => r.pickerSlug);
  try {
    return await codexRpc("model/list", { includeHidden: true },
      result => hasExpectedModels(result, expected, absent));
  } catch (error) {
    throw new Error(`等待 Codex 模型清單同步失敗：${error.message}`);
  }
}

async function readUserConfig() {
  const result = await codexRpc("config/read", {
    includeLayers: true,
    cwd: null,
  });
  const userLayer = result.layers?.find((layer) => layer.name?.type === "user");
  return {
    config: userLayer?.config || {},
    version: userLayer?.version || null,
    filePath: userLayer?.name?.file || join(codexHome, "config.toml"),
  };
}

// Codex 以「寫暫存檔再改名」更新 config.toml。Windows 上目標檔若正被其他程式短暫開著（例如防毒
// 掃描剛寫入的檔案），改名會失敗並回報 failed to persist（CI 的 Windows 環境實際遇到）。
// 寫入的是同一組鍵值，重寫是冪等的；稍等後重試，其他錯誤照常拋出。
export const CONFIG_WRITE_RETRY_DELAYS_MS = [300, 800, 1500];

export async function retryConfigWrite(write, { delays = CONFIG_WRITE_RETRY_DELAYS_MS,
  wait = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)) } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      if (!/failed to persist/i.test(error?.message || "") || attempt >= delays.length) throw error;
      await wait(delays[attempt]);
    }
  }
}

async function writeConfigEdits(edits) {
  return retryConfigWrite(() => codexRpc("config/batchWrite", {
    edits: edits.map(({ keyPath, value }) => ({
      keyPath,
      value,
      mergeStrategy: "replace",
    })),
    reloadUserConfig: false,
  }));
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function launchAgentPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(launchLabel)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xmlEscape(nodeBin)}</string>
      <string>${xmlEscape(routerPath)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(installRoot)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>Umask</key>
    <integer>63</integer>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(logPath)}</string>
  </dict>
</plist>
`;
}

function launchDomain() {
  return `gui/${process.getuid()}`;
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function stopLaunchAgent() {
  shell("/bin/launchctl", ["bootout", `${launchDomain()}/${launchLabel}`], {
    allowFailure: true,
  });
}

function startLaunchAgent() {
  stopLaunchAgent();
  sleepSync(300);
  let lastResult = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    lastResult = shell(
      "/bin/launchctl",
      ["bootstrap", launchDomain(), plistPath],
      { allowFailure: true },
    );
    if (lastResult.status === 0) return;
    sleepSync(500 * (attempt + 1));
  }
  const detail = (lastResult?.stderr || lastResult?.stdout || "").trim();
  fail(`無法啟動 LaunchAgent${detail ? `：${detail}` : ""}`);
}

// --- Windows：工作排程器 + 隱藏視窗守護迴圈 --------------------------------

// 走 cmd.exe 只為了把 stdout/stderr 附加到記錄檔，對應 launchd 的 StandardErrorPath。
// 不落地成 .cmd：批次檔是以主控台 OEM 代碼頁讀取的，使用者名稱含非 ASCII 時路徑會壞；
// 命令列則由 CreateProcessW 以 Unicode 傳遞，不受代碼頁影響。
function routerCommandLine() {
  const inner = `"${nodeBin}" "${routerPath}" >>"${logPath}" 2>&1`;
  return `cmd.exe /d /s /c "${inner}"`;
}

// wscript 屬 GUI 子系統，不會配置主控台；Run(..., 0, true) 隱藏執行並等待結束，
// 迴圈本身就是 launchd KeepAlive 的等價物（含 3 秒節流）。
//
// JSON 字串就是合法的 JScript（ES3）字串常值；U+2028/U+2029 在 ES3 字串裡是換行，
// 另外跳脫。檔案以 UTF-16LE 加 BOM 寫出，路徑含非 ASCII 字元也不受代碼頁影響。
export function jscriptLauncher(commandLine) {
  const literal = JSON.stringify(String(commandLine))
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return [
    'var shell = new ActiveXObject("WScript.Shell");',
    `var command = ${literal};`,
    "for (;;) {",
    "  shell.Run(command, 0, true);",
    "  WScript.Sleep(3000);",
    "}",
    "",
  ].join("\r\n");
}

function launcherScript() {
  return jscriptLauncher(routerCommandLine());
}

// 系統管理員可以用原則停用 Windows Script Host；先確認它能執行 JScript，
// 否則排程工作會靜默地起不來，只剩健康檢查逾時這個看不出原因的錯誤。
export function assertScriptHostAvailable() {
  const directory = mkdtempSync(join(tmpdir(), "codex-model-router-wsh-"));
  try {
    const probe = join(directory, "probe.js");
    writeFileSync(probe, utf16leWithBom("WScript.Quit(7);\r\n"));
    const cscript = join(env.SystemRoot || "C:\\Windows", "System32", "cscript.exe");
    const result = shell(cscript, ["//nologo", "//B", "//E:jscript", probe], { allowFailure: true });
    if (result.status !== 7) {
      fail("Windows Script Host 無法執行 JScript（可能被系統原則停用）；背景服務需要它以隱藏視窗啟動路由器。");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// 舊版的 VBScript 啟動器；新的排程定義註冊成功後就用不到了。
function removeLegacyLauncher() {
  if (isWindows) rmSync(legacyLauncherVbsPath, { force: true });
}

function currentAccount() {
  const result = shell("whoami.exe", [], { allowFailure: true });
  const value = (result.stdout || "").trim();
  if (value) return value;
  const domain = env.USERDOMAIN || env.COMPUTERNAME || "";
  return domain ? `${domain}\\${env.USERNAME || ""}` : env.USERNAME || "";
}

function taskXmlDocument() {
  const account = currentAccount();
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Codex 模型路由器（本機回送代理）</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(account)}</UserId>
      <Repetition>
        <Interval>PT10M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(account)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>10</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(join(env.SystemRoot || "C:\\Windows", "System32", "wscript.exe"))}</Command>
      <Arguments>//nologo //B //E:jscript ${xmlEscape(`"${launcherPath}"`)}</Arguments>
      <WorkingDirectory>${xmlEscape(installRoot)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// schtasks /End 只結束 wscript，它用 Run 起的 node 會留下來佔著埠，必須另外收掉。
// 只認我們自己會起的三種行程名：命令列裡剛好帶到安裝路徑的外殼（例如正在跑安裝器
// 的 powershell.exe）不能被波及。
function killRouterProcesses() {
  powershell(
    [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$root = ${psQuote(installRoot)}`,
      "$names = @('node.exe', 'wscript.exe', 'cmd.exe')",
      "Get-CimInstance Win32_Process |",
      `  Where-Object { $names -contains $_.Name -and $_.ProcessId -ne ${process.pid} -and $_.CommandLine -and $_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |`,
      "  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    ].join("\n"),
    { allowFailure: true },
  );
}

function stopScheduledTask() {
  shell("schtasks.exe", ["/End", "/TN", taskName], {
    allowFailure: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  killRouterProcesses();
  // 收掉行程後稍等，讓記錄檔等握把釋放，後續才 rename 得動整個安裝目錄。
  sleepSync(500);
}

function startScheduledTask() {
  stopScheduledTask();
  sleepSync(300);
  shell("schtasks.exe", ["/Create", "/TN", taskName, "/XML", taskXmlPath, "/F"]);
  let lastResult = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    lastResult = shell("schtasks.exe", ["/Run", "/TN", taskName], {
      allowFailure: true,
    });
    if (lastResult.status === 0) return;
    sleepSync(500 * (attempt + 1));
  }
  const detail = (lastResult?.stderr || lastResult?.stdout || "").trim();
  fail(`無法啟動排程工作${detail ? `：${detail}` : ""}`);
}

// --- 平台分派 --------------------------------------------------------------
// WSH 與 schtasks 對沒有 BOM 的檔案都會用 ANSI 代碼頁解讀，
// 安裝路徑含非 ASCII 字元時就會失效；一律輸出 UTF-16LE + BOM。
function utf16leWithBom(text) {
  return Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(text, "utf16le"),
  ]);
}

function writeServiceDefinition() {
  if (isWindows) {
    writeFileSync(launcherPath, utf16leWithBom(launcherScript()), {
      mode: 0o600,
    });
    writeFileSync(taskXmlPath, utf16leWithBom(taskXmlDocument()), {
      mode: 0o600,
    });
    for (const path of [launcherPath, taskXmlPath]) {
      restrictAcl(path);
    }
    return;
  }
  ensureDirectory(launchAgentsDir);
  writeFileSync(plistPath, launchAgentPlist(), { mode: 0o600 });
  chmodSync(plistPath, 0o600);
  shell("/usr/bin/plutil", ["-lint", plistPath]);
}

function startService() {
  if (isWindows) startScheduledTask();
  else startLaunchAgent();
}

// 只重啟，不重新註冊服務。
//
// Windows 的 schtasks /Create 需要工作物件的寫入權；工作若是以系統管理員身分建立的，
// 一般使用者對它只有讀取權，未提權執行就會 Access is denied——而 /End 與 /Run 可以。
// 埠與路徑都沒變的升級根本不需要重新註冊，硬要重建只會讓升級無謂地需要提權，
// 失敗時還會把服務停在停止狀態。macOS 的使用者網域 bootstrap 不需提權，維持原路徑。
function restartServiceInPlace() {
  if (!isWindows) {
    startLaunchAgent();
    return;
  }
  stopScheduledTask();
  sleepSync(300);
  let lastResult = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    lastResult = shell("schtasks.exe", ["/Run", "/TN", taskName], { allowFailure: true });
    if (lastResult.status === 0) return;
    sleepSync(500 * (attempt + 1));
  }
  const detail = (lastResult?.stderr || lastResult?.stdout || "").trim();
  fail(`無法啟動排程工作${detail ? `：${detail}` : ""}`);
}

function manualStartHint() {
  return isWindows
    ? `schtasks /Run /TN ${taskName}`
    : `launchctl kickstart -k ${launchDomain()}/${launchLabel}`;
}

// 服務定義逐位元組比對：一樣就完全不要碰註冊。
function serviceDefinitionUnchanged() {
  try {
    if (!isWindows) {
      return existsSync(plistPath) &&
        readFileSync(plistPath, "utf8") === launchAgentPlist();
    }
    if (!existsSync(taskXmlPath) || !existsSync(launcherPath)) return false;
    return (
      Buffer.compare(readFileSync(launcherPath), utf16leWithBom(launcherScript())) === 0 &&
      Buffer.compare(readFileSync(taskXmlPath), utf16leWithBom(taskXmlDocument())) === 0
    );
  } catch {
    return false;
  }
}

function stopService() {
  if (isWindows) stopScheduledTask();
  else stopLaunchAgent();
}

// LaunchAgent 的「註冊」就是那個 plist 檔，由呼叫端負責搬移封存；
// 工作排程器的註冊在排程器資料庫裡，得另外刪。
function removeServiceRegistration() {
  if (!isWindows) return;
  shell("schtasks.exe", ["/Delete", "/TN", taskName, "/F"], {
    allowFailure: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

// 重新設定 / 回退時要一併備份或還原的服務檔案。舊版的 .vbs 也列入：
// 重新註冊失敗而還原舊定義時，排程工作仍指向它。
function serviceArchivePaths() {
  return isWindows ? [taskXmlPath, launcherPath, legacyLauncherVbsPath] : [plistPath];
}

async function freePort(preferredPort = 48953) {
  for (let port = preferredPort; port < preferredPort + 200; port += 1) {
    const available = await new Promise((resolvePromise) => {
      const server = createServer();
      server.unref();
      server.once("error", () => resolvePromise(false));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolvePromise(true));
      });
    });
    if (available) return port;
  }
  fail("無法找到空閒的本機連接埠。" );
}

async function waitForHealth(port) {
  const url = `http://127.0.0.1:${port}/healthz`;
  let lastError = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {}, 1500);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  fail(`路由器健康檢查失敗：${lastError?.message || "未知錯誤"}`);
}

function verifyLogin() {
  if (testMode) return;
  const result = shell(codexBin, ["login", "status"], {
    allowFailure: true,
    env: { ...env, CODEX_HOME: codexHome },
  });
  if (result.status !== 0 || !/ChatGPT/i.test(`${result.stdout}\n${result.stderr}`)) {
    fail("安裝前必須先使用 ChatGPT 帳號登入 Codex。" );
  }
}

function configBackup(configFile) {
  ensureDirectory(backupsRoot);
  const backupPath = join(backupsRoot, `config-${timestamp()}.toml`);
  if (existsSync(configFile)) copyFileSync(configFile, backupPath);
  else writeFileSync(backupPath, "", { mode: 0o600 });
  chmodSync(backupPath, 0o600);
  return backupPath;
}

function copyIfExists(source, destination) {
  if (!existsSync(source)) return false;
  copyFileSync(source, destination);
  chmodSync(destination, statSync(source).mode & 0o777);
  return true;
}

function rollbackEdits(previousConfig) {
  const previousOpenaiBaseUrl = previousConfig.openaiBaseUrl || {
    present: false,
    value: null,
  };
  return [
    {
      keyPath: "model_provider",
      value: previousConfig.modelProvider.present
        ? previousConfig.modelProvider.value
        : null,
    },
    {
      keyPath: "openai_base_url",
      value: previousOpenaiBaseUrl.present
        ? previousOpenaiBaseUrl.value
        : null,
    },
    {
      keyPath: "model_catalog_json",
      value: previousConfig.modelCatalogJson.present
        ? previousConfig.modelCatalogJson.value
        : null,
    },
    {
      keyPath: `model_providers.${PROVIDER_ID}`,
      value: previousConfig.provider.present ? previousConfig.provider.value : null,
    },
  ];
}

// 探測單一模型並產生路由設定；不支援時回傳 null。
// install() 與 addModels() 共用，避免兩條路徑的判斷邏輯各寫一份而漂移。
// 決定這次探測結果要不要沿用既有設定。
//
// 純函式，install() 直接用它，測試也直接測它——判斷規則只有這一份，
// 不會出現「測試通過但實際行為不同」的情況。
//
// 回傳 { route, kept, restored }：
//   route     這個模型最終要寫進設定的路由，null 表示不納入
//   kept      "model"（整條沿用）、"efforts"（補回強度）或 null（用新結果）
//   restored  被補回來的推理強度
export function resolveRouteWithPrevious(outcome, previous) {
  const { route, transient, transientEfforts = [] } = outcome;

  if (!route) {
    // 確定不支援就照樣移除；只有「這次問不到」才沿用既有設定。
    if (previous && transient) return { route: previous, kept: "model", restored: [] };
    return { route: null, kept: null, restored: [] };
  }

  // 模型本身通過了，但個別強度可能因暫時性錯誤沒測到；上次驗過的才補回來。
  const restored = transientEfforts.filter(
    (effort) =>
      Array.isArray(previous?.efforts) &&
      previous.efforts.includes(effort) &&
      !route.efforts.includes(effort),
  );
  if (restored.length === 0) return { route, kept: null, restored: [] };

  // 依 EFFORTS 的順序排回去，避免設定檔裡的順序無謂跳動。
  const efforts = EFFORTS.filter(
    (effort) => route.efforts.includes(effort) || restored.includes(effort),
  );
  return { route: { ...route, efforts }, kept: "efforts", restored };
}

// 回傳 { route, transient, transientEfforts }：
//   route            探測成功的路由，失敗為 null
//   transient        失敗是否只是「這次問不到」（呼叫端可據此保留既有設定）
//   transientEfforts 這次暫時問不到的推理強度
export async function buildRouteForModel(discovery, apiKey, model, log = consoleProbeLog, providerId = DEFAULT_PROVIDER_ID) {
  log.line(`\n正在測試 ${model}`);
  const owner = modelOwners.get(model) || "unknown";
  const ownerIsAnthropic = owner === "anthropic";
  // /models 沒標供應商時按模型名推斷，否則 Claude 會靜默落到通用 Responses
  // 路由——Codex 的 Code Mode 用 namespace 包裝工具，那條路必然失敗。
  const guessedAnthropic = !ownerIsAnthropic && owner === "unknown" && looksAnthropic(model);

  if (ownerIsAnthropic || guessedAnthropic) {
    if (guessedAnthropic) {
      log.line("  供應商        /models 未標註，按模型名推斷為 Anthropic");
    }
    // Claude 走本機轉譯：直接驗證原生 /messages。
    log.write("  原生 /messages  ");
    const probeResult = await probeAnthropicModel(discovery.apiRoot, apiKey, model);
    if (probeResult.ok) {
      log.line("支持");
      log.write("  上下文上限    ");
      const contextWindow = await probeAnthropicContextWindow(discovery.apiRoot, apiKey, model);
      log.line(contextWindow ? `${contextWindow.toLocaleString()} tokens` : "無法探測（將回退）");
      log.write("  最大輸出      ");
      const { maxOutput, canonicalId } = await probeAnthropicMaxOutput(discovery.apiRoot, apiKey, model);
      log.line(
        maxOutput
          ? `${maxOutput.toLocaleString()} tokens${canonicalId ? `（${canonicalId}）` : ""}`
          : "無法探測",
      );

      // budget_tokens 在較新的模型上已被移除：官方直接 400，部分閘道靜默丟棄，
      // 結果是 Codex 裡選 low 或 max 毫無差別，而且一律跑在高強度。
      // 支援 output_config 的話就直接透傳五檔，低強度才真的會變快。
      log.write("  推理強度控制  ");
      const supportsOutputConfig = await probeAnthropicParam(
        discovery.apiRoot, apiKey, model, { output_config: { effort: "low" } },
      );
      log.line(
        supportsOutputConfig === true
          ? "output_config.effort（五檔直接透傳）"
          : supportsOutputConfig === false
            ? "thinking.budget_tokens（該模型不支援 output_config）"
            : "無法探測，保守使用 thinking.budget_tokens",
      );

      // 這些模型預設 display=omitted：thinking 區塊照送，但文字是空的。
      // 要 summarized 才能在 Codex 裡看到推理摘要。
      let supportsSummary = null;
      if (supportsOutputConfig === true) {
        log.write("  推理摘要      ");
        supportsSummary = await probeAnthropicParam(
          discovery.apiRoot, apiKey, model,
          { thinking: { type: "adaptive", display: "summarized" } },
        );
        log.line(
          supportsSummary === true
            ? "顯示摘要"
            : supportsSummary === false
              ? "該模型不支援 adaptive/summarized，不顯示"
              : "無法探測，不顯示",
        );
      }

      // 對話歷史每輪都會重送；沒有滾動斷點的話上游每輪都要重算整段歷史。
      log.write("  提示詞快取    ");
      const supportsCache = await probeAnthropicParam(
        discovery.apiRoot, apiKey, model, { cache_control: { type: "ephemeral" } },
      );
      log.line(
        supportsCache === true
          ? "支援滾動斷點"
          : supportsCache === false
            ? "閘道不接受頂層 cache_control，僅快取系統提示詞"
            : "無法探測，僅快取系統提示詞",
      );

      const route = {
        pickerSlug: pickerSlug(model, providerId),
        upstreamModel: model,
        displayName: withDefaultModelPrefix({ upstreamModel: model, providerId }).displayName || model,
        providerHost: new URL(discovery.apiRoot).host,
        // 主要供應商（default）的路由不寫 providerId，格式與舊版完全相同。
        ...(providerId !== DEFAULT_PROVIDER_ID ? { providerId } : {}),
        // 轉譯後 effort 直接對應 thinking budget，五檔皆可用。
        efforts: ["low", "medium", "high", "xhigh", "max"],
        stripReasoning: false,
        translate: "anthropic",
        contextWindow,
        maxOutputTokens: maxOutput,
        // 探測不出來時一律保守：沿用舊行為，不會因為猜錯而整條路由 400。
        effortControl: supportsOutputConfig === true ? "output_config" : "thinking_budget",
        promptCache: supportsCache === true,
        reasoningSummary: supportsSummary === true,
      };
      return { route, transient: false, transientEfforts: [] };
    }

    log.line(`失敗（HTTP ${probeResult.status}）${probeResult.detail ? "：" + probeResult.detail : ""}`);
    if (guessedAnthropic) {
      // 只是按名字猜的，探測不通不足以判定模型不可用，回退到通用路由。
      log.line("  該閘道沒有可用的 Anthropic 原生端點，改用通用 Responses 路由重試。");
      log.line("  注意：Codex 的 Code Mode 用 namespace 包裝工具，部分閘道會因此報錯或丟工具。");
    } else if (isTransientProbeStatus(probeResult.status)) {
      // 額度、上游容量或網路問題，而非模型真的不受支持。
      log.line(`跳過 ${model}：上游暫時不可用，並非模型不受支援。`);
      return { route: null, transient: true, transientEfforts: [] };
    } else if (probeResult.status === 401 || probeResult.status === 403) {
      log.line(`跳過 ${model}：當前 API Key 無權存取該模型。`);
      return { route: null, transient: false, transientEfforts: [] };
    } else if (probeResult.status === 404) {
      log.line(`跳過 ${model}：該閘道未提供 Anthropic 原生 /messages 端點，無法本機轉譯。`);
      return { route: null, transient: false, transientEfforts: [] };
    } else {
      log.line(`跳過 ${model}：Anthropic 原生端點探測未通過。`);
      return { route: null, transient: false, transientEfforts: [] };
    }
  }

  const probe = await probeModel(discovery.apiRoot, apiKey, model, log);
  if (!probe.supported && !probe.transient) {
    // 只有 /chat/completions 的模型（DeepSeek、通義千問、GLM、Kimi、Ollama、vLLM 等）
    // 改走本機轉譯。
    log.line("  改探 Chat Completions（本機轉譯成 Codex 的 Responses 格式）");
    const chat = await probeChatModel(discovery.apiRoot, apiKey, model, log);
    if (chat.supported) {
      const route = {
        pickerSlug: pickerSlug(model, providerId),
        upstreamModel: model,
        displayName: withDefaultModelPrefix({ upstreamModel: model, providerId }).displayName || model,
        providerHost: new URL(discovery.apiRoot).host,
        ...(providerId !== DEFAULT_PROVIDER_ID ? { providerId } : {}),
        efforts: chat.efforts,
        stripReasoning: chat.efforts.length === 0,
        contextWindow: null,
        translate: "chat",
        chatTools: chat.tools,
        chatStreamOptions: chat.streamOptions,
      };
      return { route, transient: false, transientEfforts: [] };
    }
    log.line(
      chat.transient
        ? `跳過 ${model}：上游暫時不可用，並非模型不受支援。`
        : `跳過 ${model}：Responses 與 Chat Completions 探測都未通過。`,
    );
    return { route: null, transient: chat.transient, transientEfforts: [] };
  }
  if (!probe.supported) {
    log.line(`跳過 ${model}：上游暫時不可用，並非模型不受支援。`);
    return {
      route: null,
      transient: true,
      transientEfforts: probe.transientEfforts || [],
    };
  }
  const route = {
    pickerSlug: pickerSlug(model, providerId),
    upstreamModel: model,
    displayName: withDefaultModelPrefix({ upstreamModel: model, providerId }).displayName || model,
    providerHost: new URL(discovery.apiRoot).host,
    ...(providerId !== DEFAULT_PROVIDER_ID ? { providerId } : {}),
    efforts: probe.efforts,
    stripReasoning: probe.stripReasoning,
    contextWindow: null,
  };
  return { route, transient: false, transientEfforts: probe.transientEfforts || [] };
}

async function install() {
  const existingManifest = readManifest();
  if (existingManifest?.version) assertInstallerNotOlder(existingManifest.version);
  if (!codexBin) fail(`未找到 Codex CLI，請先安裝 ${desktopAppName} 或 Codex CLI。`);
  verifyLogin();
  // 在問任何問題、寫任何檔案之前先確認背景服務起得來。
  if (isWindows && !testMode) assertScriptHostAvailable();

  printHeading(existingManifest ? "重新配置 Codex 模型路由器" : "安裝 Codex 模型路由器");
  // 重新配置只改主要供應商（第一家）；其他供應商與它們的模型原樣保留。
  const existingSettings = existingManifest ? readSettingsIfExists() : {};
  const existingProviders = installedProviders(existingSettings, existingManifest);
  const primary = existingProviders[0] || null;
  const otherProviders = existingProviders.slice(1);
  const primaryId = primary?.id || DEFAULT_PROVIDER_ID;
  if (otherProviders.length > 0) {
    console.log(`這裡設定的是主要供應商「${primaryId}」；其他 ${otherProviders.length} 家供應商與它們的模型保持不變。`);
  }
  const defaultBaseUrl = primary?.baseUrl || env.CODEX_MODEL_ROUTER_BASE_URL || null;
  const baseUrl = normalizeUrl(
    env.CODEX_MODEL_ROUTER_BASE_URL ||
      (await ask("兼容 OpenAI 的 Base URL", defaultBaseUrl)),
  );
  const clash = otherProviders.find((provider) => provider.baseUrl === baseUrl);
  if (clash) {
    fail(`這個 Base URL 已經是供應商「${clash.id}」；要調整它的模型請用「添加自訂模型」或「刪除自訂模型」。`);
  }
  const keychainService = keychainServiceFor(baseUrl);

  if (keychainHas(keychainService)) {
    const update = await confirm(
      `${secretStoreLabel}中已存在 API Key，是否替換？`,
      false,
    );
    if (update) await storeApiKey(keychainService, baseUrl);
  } else {
    await storeApiKey(keychainService, baseUrl);
  }
  const apiKey = readApiKey(keychainService);

  console.log("正在發現可用模型..." );
  const discovery = await discoverApiRoot(baseUrl, apiKey);
  console.log(`API 根地址：${discovery.apiRoot}`);
  const selectedModels = await selectModels(discovery.models);
  console.log(`\n每個選中的模型最多會執行五次小型 Responses API 探測；同時最多探測 ${probeConcurrency()} 個模型。`);
  if (!(await confirm("是否繼續進行能力探測？", true))) {
    fail("已在修改配置前取消安裝。" );
  }

  // 重新配置時，這次探測遇到的暫時性失敗不足以推翻上次已經驗過的結果。
  // 否則只要重裝當下額度用盡或閘道抽風，原本正常的模型與推理強度就會被靜默
  // 移除，使用者要等到下次想切模型才發現，而且會誤以為是模型不支援。
  const existingRoutes = Array.isArray(existingSettings.routes)
    ? existingSettings.routes
    : (existingManifest?.routes || []);
  const otherRoutes = existingRoutes.filter((route) => route && routeProviderId(route) !== primaryId);
  const previousRoutes = new Map(
    existingRoutes
      .filter((route) => route && routeProviderId(route) === primaryId && typeof route.upstreamModel === "string")
      .map((route) => [route.upstreamModel, route]),
  );

  const routes = [];
  const keptModels = [];
  const keptEfforts = [];
  const outcomes = await probeModelsInParallel(selectedModels,
    (model, log) => buildRouteForModel(discovery, apiKey, model, log, primaryId));
  for (const [index, model] of selectedModels.entries()) {
    const outcome = outcomes[index];
    const { route, kept, restored } = resolveRouteWithPrevious(
      outcome,
      previousRoutes.get(model),
    );
    if (!route) continue;
    if (kept === "model") {
      console.log(`  保留 ${model} 的既有設定：本次失敗屬於暫時性問題，不改動已驗證過的配置。`);
      keptModels.push(model);
    } else if (kept === "efforts") {
      console.log(`  保留 ${model} 既有的推理強度：${restored.join(", ")}（本次為暫時性失敗）。`);
      keptEfforts.push(`${model}: ${restored.join(", ")}`);
    }
    routes.push(withDefaultModelPrefix(route));
  }
  if (routes.length === 0) fail("選中的模型均未通過 Responses API 探測。" );
  if (keptModels.length > 0 || keptEfforts.length > 0) {
    console.log("\n本次探測遇到暫時性故障，以下項目沿用上次已驗證的設定：" );
    for (const model of keptModels) console.log(`  - ${model}（整個模型）`);
    for (const line of keptEfforts) console.log(`  - ${line}`);
    console.log("  上游恢復後重跑一次安裝器，即可用最新探測結果覆蓋。" );
  }

  const bundledCatalog = loadCatalogTemplates();
  const discoveredOfficial = bundledCatalog.models.filter(
    (model) => !String(model.slug).startsWith("custom/"),
  );
  // 安裝與重新配置都不問隱藏模型：那是獨立的 hidden-models 命令。
  // 既有選擇仍要沿用，否則重裝一次就把強制顯示的模型又藏回去。
  const forceListedModels = normalizeForceListedModels(
    discoveredOfficial,
    readSettingsIfExists().forceListedModels,
  );
  const officialModels = applyForcedVisibility(discoveredOfficial, forceListedModels);
  const providers = [{
    id: primaryId,
    baseUrl,
    apiRoot: discovery.apiRoot,
    keychainService,
    keychainAccount: "codex",
    credentialPath: isWindows ? credentialFileFor(keychainService) : null,
  }, ...otherProviders];
  // 主要供應商的項目依這次探測重建；其他供應商的沿用現有目錄裡那份。
  const allRoutes = [...routes, ...otherRoutes];
  // 網頁上手動排過順序時，重新配置也保留既有模型的位置。
  const manualOrder = readSettingsIfExists().customModelOrder === "manual";
  const currentCatalog = otherRoutes.length || manualOrder ? readCatalogIfExists() : null;
  const customModels = arrangeCustomModels(
    officialModels,
    mergeAddedModels(officialModels, currentCatalog, allRoutes, routes),
    allRoutes,
    providers.map((provider) => provider.id),
    { providerId: primaryId, models: discovery.models },
    currentCatalog,
    { manual: manualOrder },
  );
  const combinedCatalog = { ...bundledCatalog, models: [...officialModels, ...customModels] };

  const userConfig = await readUserConfig();
  const previousConfig =
    existingManifest?.previousConfig || {
      modelProvider: deepGet(userConfig.config, "model_provider"),
      openaiBaseUrl: deepGet(userConfig.config, "openai_base_url"),
      modelCatalogJson: deepGet(userConfig.config, "model_catalog_json"),
      provider: deepGet(userConfig.config, `model_providers.${PROVIDER_ID}`),
    };
  const backupPath = existingManifest?.configBackup || configBackup(userConfig.filePath);
  const port = existingManifest?.port || (await freePort());
  const routerSource = extractRouterSource();
  let reconfigureBackupDir = null;
  if (existingManifest) {
    reconfigureBackupDir = join(backupsRoot, `reconfigure-${timestamp()}`);
    ensureDirectory(reconfigureBackupDir);
    copyIfExists(routerPath, join(reconfigureBackupDir, "router.mjs"));
    copyIfExists(bridgePath, join(reconfigureBackupDir, "claude-bridge.mjs"));
    backupChatBridge(reconfigureBackupDir);
    copyIfExists(settingsPath, join(reconfigureBackupDir, "settings.json"));
    copyIfExists(catalogPath, join(reconfigureBackupDir, "models.json"));
    copyIfExists(manifestPath, join(reconfigureBackupDir, "install.json"));
    for (const path of serviceArchivePaths()) {
      copyIfExists(path, join(reconfigureBackupDir, basename(path)));
    }
  }

  ensureDirectory(installRoot);
  writeFileSync(routerPath, routerSource, { mode: 0o600 });
  chmodSync(routerPath, 0o600);
  writeBridgeSources();
  writeJsonAtomic(catalogPath, combinedCatalog);
  writeJsonAtomic(settingsPath, withProviders({
    version: INSTALLER_VERSION,
    officialBaseUrl: OFFICIAL_BASE_URL,
    catalogPath,
    logPath,
    imageOutputDir: resolveImageOutputDir(),
    // 路由器要靠它重新產生模型目錄；Codex 更新後 bundled 清單才跟得上。
    // codexBinDir 是搜尋目錄：Windows 的 codexBin 指向版本雜湊子目錄，更新後
    // 那支的 mtime 從此凍結，只認它等於偵測不到任何更新。
    codexBin,
    codexBinDir: codexBinSearchDir(),
    forceListedModels,
    port,
    routes: allRoutes,
    // 使用者自己調過的旋鈕不能被重裝洗掉。
    ...preservedSettings(),
  }, providers));
  writeServiceDefinition();

  let configChanged = false;
  try {
    startService();
    removeLegacyLauncher();
    await waitForHealth(port);
    const writeResult = await writeConfigEdits([
      { keyPath: "model_provider", value: "openai" },
      {
        keyPath: "openai_base_url",
        value: `http://127.0.0.1:${port}/v1`,
      },
      // 讓 Codex 每次啟動向 /models 拉取；固定檔案會停用遠端清單刷新。
      { keyPath: "model_catalog_json", value: null },
      { keyPath: `model_providers.${PROVIDER_ID}`, value: null },
    ]);
    configChanged = true;

    const manifest = manifestWithProviders({
      version: INSTALLER_VERSION,
      installedAt: new Date().toISOString(),
      providerId: "openai",
      legacyProviderId: PROVIDER_ID,
      platform: process.platform,
      serviceKind: isWindows ? "schtasks" : "launchd",
      serviceName,
      launchLabel,
      // Windows 沒有 LaunchAgent，記一條不存在的 .plist 路徑只會誤導。
      plistPath: isWindows ? null : plistPath,
      serviceDefinitionPath: isWindows ? taskXmlPath : plistPath,
      routerPath,
      bridgePath,
      chatBridgePath,
      settingsPath,
      catalogPath,
      logPath,
      port,
      routes: allRoutes,
      previousConfig,
      configBackup: backupPath,
      configVersionAfterInstall: writeResult.version || null,
      codexBin,
      nodeBin,
      ...(existingManifest?.managerFileHandler ? { managerFileHandler: existingManifest.managerFileHandler } : {}),
      ...(existingManifest?.managerMcpEntry ? { managerMcpEntry: existingManifest.managerMcpEntry } : {}),
    }, providers);
    await waitForPickerModels(allRoutes);
    writeJsonAtomic(manifestPath, manifest);
  } catch (error) {
    if (configChanged && !existingManifest) {
      try {
        await writeConfigEdits(rollbackEdits(previousConfig));
      } catch {}
    }
    stopService();
    if (existingManifest && reconfigureBackupDir) {
      copyIfExists(join(reconfigureBackupDir, "router.mjs"), routerPath);
      copyIfExists(join(reconfigureBackupDir, "claude-bridge.mjs"), bridgePath);
      restoreChatBridge(reconfigureBackupDir);
      copyIfExists(join(reconfigureBackupDir, "settings.json"), settingsPath);
      copyIfExists(join(reconfigureBackupDir, "models.json"), catalogPath);
      copyIfExists(join(reconfigureBackupDir, "install.json"), manifestPath);
      for (const path of serviceArchivePaths()) {
        copyIfExists(join(reconfigureBackupDir, basename(path)), path);
      }
      try {
        startService();
      } catch {}
    } else {
      const failedInstallDir = join(backupsRoot, `failed-install-${timestamp()}`);
      ensureDirectory(failedInstallDir);
      removeServiceRegistration();
      // installRoot 底下的服務檔會隨整個目錄一起搬走，只需處理目錄外的（plist）。
      for (const path of serviceArchivePaths()) {
        if (path.startsWith(installRoot)) continue;
        if (existsSync(path)) {
          renameSync(path, join(failedInstallDir, basename(path)));
        }
      }
      if (existsSync(installRoot)) {
        renameSync(installRoot, join(failedInstallDir, "model-router"));
      }
    }
    throw error;
  }

  printHeading("安裝完成");
  console.log(`路由器：http://127.0.0.1:${port}`);
  console.log("已添加模型：");
  for (const route of routes) {
    const effortText = route.efforts.length ? route.efforts.join(", ") : "使用供應商預設值";
    console.log(`  - ${route.displayName}`);
    console.log(`    選擇器 ID：${route.pickerSlug}`);
    console.log(`    推理強度：${effortText}`);
  }
  if (otherRoutes.length > 0) {
    console.log(`其他 ${otherProviders.length} 家供應商的 ${otherRoutes.length} 個模型保持不變。`);
  }
  console.log(`配置備份：${backupPath}`);
  if (
    primary?.keychainService &&
    primary.keychainService !== keychainService &&
    !otherProviders.some((provider) => provider.keychainService === primary.keychainService) &&
    !testMode
  ) {
    const removeOldKey = await confirm(
      `是否從${secretStoreLabel}中刪除上一個 Base URL 對應的 API Key？`,
      true,
    );
    if (removeOldKey) {
      deleteApiKey(primary.keychainService, primary.keychainAccount || "codex");
    }
  }
  console.log(`\n請完全退出並重新打開 ${desktopAppName}。`);
  console.log("安裝器繼續使用內建 openai 供應商，因此 Remote 中的既有聊天仍會顯示。" );
  console.log("安裝前由其他自訂供應商建立的任務，仍可能需要單獨遷移。" );
  console.log(`回退命令：${basename(scriptPath)} rollback`);
  printManagerLauncher(await installManagerLauncher());
  await offerInstalledRelayImagegen();
}

// 在既有安裝上追加模型：沿用已保存的 Base URL、API Key、端口與既有路由，
// 只探測這次新選的模型。不重問任何設定，也不改動 config.toml。
async function addModels() {
  const manifest = readManifest();
  if (manifest?.version) assertInstallerNotOlder(manifest.version);
  if (!codexBin) fail(`未找到 Codex CLI，請先安裝 ${desktopAppName} 或 Codex CLI。`);
  verifyLogin();

  if (!manifest) {
    fail("當前 CODEX_HOME 尚未安裝 Codex 模型路由器，請先選擇「安裝或重新配置」。");
  }
  if (!existsSync(settingsPath)) {
    fail("找不到 settings.json，安裝可能已損壞，請改用「安裝或重新配置」。");
  }

  printHeading("添加模型");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const existingRoutes = Array.isArray(settings.routes) ? settings.routes : [];
  const providers = installedProviders(settings, manifest);
  if (providers.length === 0) fail("找不到中轉供應商設定，請改用「安裝或重新配置」。");
  const provider = providers.length === 1
    ? providers[0]
    : await chooseProvider(providers, existingRoutes, "要替哪一家供應商添加模型");
  const { baseUrl, keychainService } = provider;
  const providerRoutes = existingRoutes.filter((route) => routeProviderId(route) === provider.id);
  const port = Number(settings.port || manifest.port);
  if (providers.length > 1) console.log(`\n供應商：${provider.id}`);
  console.log(`Base URL：${baseUrl}`);
  console.log(`端口：${port}`);
  console.log(`已配置 ${providerRoutes.length} 個自訂模型：`);
  for (const route of providerRoutes) {
    console.log(`  - ${route.displayName || route.upstreamModel}`);
  }

  const apiKey = readApiKey(keychainService);
  console.log("\n正在發現可用模型...");
  const discovery = await discoverApiRoot(baseUrl, apiKey);
  const configured = new Set(providerRoutes.map((route) => route.upstreamModel));
  const available = discovery.models.filter((model) => !configured.has(model));
  if (available.length === 0) {
    console.log("清單上的模型都已配置；仍可直接輸入清單沒有列出的模型 ID。");
  }

  const selectedModels = (await selectModels(available)).filter((model) => {
    if (!configured.has(model)) return true;
    console.log(`已配置，略過：${model}`);
    return false;
  });
  if (selectedModels.length === 0) fail("未選擇任何模型。");
  console.log(`\n每個選中的模型最多會執行五次小型 Responses API 探測；同時最多探測 ${probeConcurrency()} 個模型。`);
  if (!(await confirm("是否繼續進行能力探測？", true))) {
    fail("已在修改配置前取消。");
  }

  // 這裡的模型都是新選的，沒有既有設定可以沿用；暫時性失敗只能略過。
  const outcomes = await probeModelsInParallel(selectedModels,
    (model, log) => buildRouteForModel(discovery, apiKey, model, log, provider.id));
  const newRoutes = outcomes.map((outcome) => outcome.route).filter(Boolean);
  if (newRoutes.length === 0) fail("選中的模型均未通過探測，配置未改動。");

  const { plan, backupDir } = await commitAddedModels(provider, newRoutes, discovery.models);

  printHeading("添加完成");
  console.log("本次新增：");
  for (const route of plan.added) {
    const effortText = route.efforts.length ? route.efforts.join(", ") : "使用供應商預設值";
    console.log(`  - ${route.displayName}`);
    console.log(`    選擇器 ID：${route.pickerSlug}`);
    console.log(`    推理強度：${effortText}`);
  }
  console.log(`\n現共 ${plan.settings.routes.length} 個自訂模型。`);
  console.log(`備份：${backupDir}`);
  console.log(`\n請完全退出並重新打開 ${desktopAppName}。`);
}

// 探測完才寫入：探測可能花上一分鐘，期間設定或官方目錄可能被更新，因此以最新的檔案規劃。
// 這裡不重問隱藏模型，但既有的強制顯示設定由 planAddModels 沿用。路由器與轉譯層一併刷新，
// 否則 settings.version 會與實際執行的程式碼對不上；失敗時 commitRouterChange 會還原並確認服務回來。
async function commitAddedModels(provider, newRoutes, discoveredModels) {
  const templates = await withCodexLock(() => loadCatalogTemplates());
  const { manifest, settings, catalog } = requireInstallation();
  const plan = planAddModels(manifest, settings, catalog, templates, provider, newRoutes, discoveredModels);
  const backupDir = await commitRouterChange("add-model", plan);
  return { plan, backupDir };
}

export function planRemoveModels(manifest, settings, catalog, selectedSlugs) {
  if (!manifest || !Array.isArray(settings?.routes) || !Array.isArray(catalog?.models)) {
    fail("安裝設定或模型目錄不完整，無法刪除模型。");
  }
  if (!Array.isArray(selectedSlugs) || selectedSlugs.length === 0) {
    fail("沒有選擇要刪除的模型。");
  }
  const selected = new Set(selectedSlugs);
  const routesBySlug = new Map(settings.routes.map(route => [route.pickerSlug, route]));
  for (const slug of selected) {
    if (typeof slug !== "string" || !slug.startsWith("custom/") || !routesBySlug.has(slug)) {
      fail(`所選模型不是已配置的自訂模型：${slug}`);
    }
  }
  const routes = settings.routes.filter(route => !selected.has(route.pickerSlug));
  return {
    removed: settings.routes.filter(route => selected.has(route.pickerSlug)),
    settings: { ...settings, version: INSTALLER_VERSION, routes },
    manifest: { ...manifest, version: INSTALLER_VERSION, routes },
    catalog: { ...catalog, models: catalog.models.filter(model => !selected.has(model.slug)) },
  };
}

export function removedDefaultModel(config, selectedSlugs) {
  const configured = deepGet(config, "model");
  return configured.present && selectedSlugs.includes(configured.value) ? configured.value : null;
}

async function removeModels() {
  const manifest = readManifest();
  if (manifest?.version) assertInstallerNotOlder(manifest.version);
  if (!manifest || !existsSync(settingsPath) || !existsSync(catalogPath)) {
    fail("尚未安裝路由器，或設定檔不完整，請先檢查安裝狀態。");
  }
  if (!existsSync(routerPath) || !existsSync(bridgePath)) {
    fail("路由器程式檔案不完整，請先執行 update 修復安裝。");
  }
  if (!codexBin) fail(`未找到 Codex CLI，請先安裝 ${desktopAppName} 或 Codex CLI。`);

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  if (!Array.isArray(settings.routes) || !Array.isArray(catalog.models)) {
    fail("安裝設定或模型目錄不完整，無法刪除模型。");
  }
  const catalogOrder = new Map(catalog.models.map((model, index) => [model.slug, index]));
  const available = settings.routes
    .filter(route => String(route?.pickerSlug || "").startsWith("custom/"))
    .sort((left, right) => {
      const a = catalogOrder.get(left.pickerSlug) ?? Infinity;
      const b = catalogOrder.get(right.pickerSlug) ?? Infinity;
      return a === b ? 0 : a - b;
    });
  printHeading("刪除自訂模型");
  if (available.length === 0) {
    console.log("目前沒有可刪除的自訂模型。");
    return;
  }
  available.forEach((route, index) => {
    console.log(`${String(index + 1).padStart(3)}. ${route.displayName || route.upstreamModel}（${route.upstreamModel}）`);
  });
  const answer = await ask("輸入要刪除的編號（逗號、範圍或 all；Enter／cancel 返回）");
  if (!answer || answer.toLowerCase() === "cancel") {
    console.log("未進行任何修改。");
    return;
  }
  const selectedSlugs = parseSelection(answer, available.length)
    .map(index => available[index].pickerSlug);
  const preview = planRemoveModels(manifest, settings, catalog, selectedSlugs);
  const userConfig = await readUserConfig();
  const defaultModel = removedDefaultModel(userConfig.config, selectedSlugs);
  console.log("\n即將刪除：");
  for (const route of preview.removed) console.log(`  - ${route.displayName || route.upstreamModel}`);
  if (defaultModel) console.log("這些模型包含全域預設模型；確認後會清除該預設，讓 Codex 使用官方預設模型。");
  console.log("使用上述模型的既有任務需切換到其他模型後才能繼續。");
  if (!(await confirm("確認刪除所選自訂模型？", false))) {
    console.log("未進行任何修改。");
    return;
  }
  const { plan, backupDir } = await executeRemoveModels(selectedSlugs, { expectedDefault: defaultModel });

  printHeading("刪除完成");
  console.log(`已刪除 ${plan.removed.length} 個自訂模型，剩餘 ${plan.settings.routes.length} 個。`);
  if (defaultModel) console.log("已清除指向已刪模型的全域預設模型設定。");
  console.log(`備份：${backupDir}`);
  console.log(`請完全退出並重新打開 ${desktopAppName}。`);
}

// 刪除模型的寫入段，終端與網頁共用。以最新的檔案重新規劃，只按仍然存在的精確 slug 刪除；
// 全域預設模型指向被刪的模型時一併清除，失敗時連同 config.toml 一起還原。
// expectedDefault：互動流程確認前看到的預設模型；確認期間被改過就停下來，不憑舊資訊動手。
async function executeRemoveModels(selectedSlugs, { expectedDefault } = {}) {
  const userConfig = await readUserConfig();
  const defaultModel = removedDefaultModel(userConfig.config, selectedSlugs);
  if (expectedDefault !== undefined && defaultModel !== expectedDefault) {
    fail("全域預設模型在確認期間變更，請重新執行刪除。" );
  }
  const { manifest, settings, catalog } = requireInstallation();
  if (!existsSync(routerPath) || !existsSync(bridgePath)) {
    fail("路由器程式檔案不完整，請先執行 update 修復安裝。");
  }
  const plan = planRemoveModels(manifest, settings, catalog, selectedSlugs);
  const backupDir = await commitRouterChange("remove-model", {
    ...plan,
    absent: selectedSlugs,
    configFile: defaultModel ? userConfig.filePath : null,
    apply: defaultModel ? clearDefaultModel : null,
    restore: defaultModel ? () => writeConfigEdits([{ keyPath: "model", value: defaultModel }]) : null,
  });
  return { plan, defaultModel, backupDir };
}

async function clearDefaultModel() {
  await writeConfigEdits([{ keyPath: "model", value: null }]);
  if (deepGet((await readUserConfig()).config, "model").present) fail("全域預設模型設定未成功清除。");
}

// --- 管理供應商 ---------------------------------------------------------------

// 新增一家：providers 與路由各加在最後，模型目錄照供應商分組排好。純函式，
// 實際寫檔與重啟由 addProvider() 負責。
export function planAddProvider(manifest, settings, catalog, templates, provider, newRoutes, discoveredModels) {
  const providers = installedProviders(settings, manifest);
  const problem = providerIdError(provider.id, providers.map((item) => item.id));
  if (problem) fail(problem);
  const clash = providers.find((item) => item.baseUrl === provider.baseUrl);
  if (clash) fail(`這個 Base URL 已經是供應商「${clash.id}」。`);
  if (newRoutes.length === 0 || newRoutes.some((route) => routeProviderId(route) !== provider.id)) {
    fail("新模型與供應商不一致，配置未改動。");
  }
  const nextProviders = [...providers, provider];
  const routes = [...(settings.routes || []), ...newRoutes];
  const officialModels = applyForcedVisibility(
    templates.models.filter((model) => !String(model.slug).startsWith("custom/")),
    settings.forceListedModels,
  );
  const customModels = arrangeCustomModels(
    officialModels,
    mergeAddedModels(officialModels, catalog, routes, newRoutes),
    routes,
    nextProviders.map((item) => item.id),
    { providerId: provider.id, models: discoveredModels },
    catalog,
    { manual: settings.customModelOrder === "manual" },
  );
  return {
    providers: nextProviders,
    settings: withProviders({ ...settings, version: INSTALLER_VERSION, routes }, nextProviders),
    manifest: manifestWithProviders({ ...manifest, version: INSTALLER_VERSION, routes }, nextProviders),
    catalog: { ...templates, models: [...officialModels, ...customModels] },
  };
}

// 移除一家與它的全部模型。至少要留一家：路由器的生圖端點與「安裝或重新配置」都需要
// 主要供應商。移除的是主要供應商時，由下一家接手。
export function planRemoveProvider(manifest, settings, catalog, providerId) {
  if (!manifest || !Array.isArray(settings?.routes) || !Array.isArray(catalog?.models)) {
    fail("安裝設定或模型目錄不完整，無法移除供應商。");
  }
  const providers = installedProviders(settings, manifest);
  const provider = providers.find((item) => item.id === providerId);
  if (!provider) fail(`找不到供應商：${providerId}`);
  if (providers.length <= 1) fail("至少要保留一家供應商；要整個移除路由器請用「回退配置」。");
  const removedRoutes = settings.routes.filter((route) => routeProviderId(route) === providerId);
  const removed = new Set(removedRoutes.map((route) => route.pickerSlug));
  const remaining = providers.filter((item) => item.id !== providerId);
  const keep = (routes) => routes.filter((route) => !removed.has(route.pickerSlug));
  return {
    provider,
    removedRoutes,
    providers: remaining,
    settings: withProviders({ ...settings, version: INSTALLER_VERSION, routes: keep(settings.routes) }, remaining),
    manifest: manifestWithProviders({
      ...manifest, version: INSTALLER_VERSION,
      routes: keep(Array.isArray(manifest.routes) ? manifest.routes : settings.routes),
    }, remaining),
    catalog: { ...catalog, models: catalog.models.filter((model) => !removed.has(model.slug)) },
  };
}

function requireInstallation() {
  const manifest = readManifest();
  if (!manifest) fail("當前 CODEX_HOME 尚未安裝 Codex 模型路由器，請先選擇「安裝或重新配置」。");
  if (manifest.version) assertInstallerNotOlder(manifest.version);
  if (!existsSync(settingsPath) || !existsSync(catalogPath)) {
    fail("找不到 settings.json 或 models.json，安裝可能已損壞，請改用「安裝或重新配置」。");
  }
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  if (!Array.isArray(settings.routes) || !Array.isArray(catalog.models)) {
    fail("安裝設定或模型目錄不完整，請改用「安裝或重新配置」。");
  }
  const providers = installedProviders(settings, manifest);
  if (providers.length === 0) fail("找不到中轉供應商設定，請改用「安裝或重新配置」。");
  return { manifest, settings, catalog, providers };
}

// 寫入新的設定並原地重啟路由器；任何一步失敗都還原備份，並確認路由器回來了。
// apply／restore 用來一併處理 config.toml 之類的附帶修改。
async function commitRouterChange(label, { settings, manifest, catalog, absent = [], configFile = null,
  apply = null, restore = null }) {
  const port = Number(settings.port ?? manifest.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail("現有安裝沒有可用的連接埠設定。");
  const backupDir = join(backupsRoot, `${label}-${timestamp()}`);
  ensureDirectory(backupDir);
  const files = [
    [routerPath, "router.mjs"], [bridgePath, "claude-bridge.mjs"],
    [settingsPath, "settings.json"], [catalogPath, "models.json"], [manifestPath, "install.json"],
  ];
  for (const [source, name] of files) {
    if (!copyIfExists(source, join(backupDir, name))) fail(`無法備份 ${name}，已取消。`);
  }
  backupChatBridge(backupDir);
  if (configFile && !copyIfExists(configFile, join(backupDir, "config.toml"))) {
    fail("無法備份 config.toml，已取消。");
  }
  let applied = false;
  try {
    writeFileSync(routerPath, extractRouterSource(), { mode: 0o600 });
    chmodSync(routerPath, 0o600);
    writeBridgeSources();
    writeJsonAtomic(catalogPath, catalog);
    writeJsonAtomic(settingsPath, settings);
    writeJsonAtomic(manifestPath, { ...manifest, updatedAt: new Date().toISOString() });
    // 服務定義沒變，原地重啟就好；重新註冊需要提權，沒必要冒那個險。
    restartServiceInPlace();
    await waitForHealth(port);
    if (apply) {
      applied = true;
      await apply();
    }
    await waitForPickerModels(settings.routes, absent);
  } catch (error) {
    console.error("\n修改失敗，正在還原之前的配置...");
    const failures = [];
    for (const [target, name] of files) {
      try {
        if (!copyIfExists(join(backupDir, name), target)) failures.push(`找不到 ${name} 備份`);
      } catch (restoreError) { failures.push(`${name}：${restoreError.message}`); }
    }
    try { restoreChatBridge(backupDir); }
    catch (restoreError) { failures.push(`chat-bridge.mjs：${restoreError.message}`); }
    if (applied && restore) {
      try { await restore(); } catch (restoreError) { failures.push(restoreError.message); }
    }
    try {
      restartServiceInPlace();
      await waitForHealth(port);
      if (failures.length === 0) console.error("已還原到修改前的配置，路由器運作正常。");
    } catch (restartError) {
      failures.push(`路由器沒有起來（${restartError.message}），請手動啟動：${manualStartHint()}`);
    }
    if (failures.length) console.error(`\n還原未完成：${failures.join("；")}。備份：${backupDir}`);
    throw error;
  }
  return backupDir;
}

// 只改模型目錄與路由描述（排序、顯示名稱、上下文上限）時用：路由器轉發用不到這些欄位，
// 每次回應 /models 又會重讀 models.json，所以不重啟路由器，進行中的對話也不會斷線。
// 寫完以 Codex 的 model/list 確認目錄仍可讀、模型都在；失敗就還原三個檔案。
async function commitCatalogChange(label, { settings, manifest, catalog }) {
  const backupDir = join(backupsRoot, `${label}-${timestamp()}`);
  ensureDirectory(backupDir);
  const files = [[settingsPath, "settings.json"], [catalogPath, "models.json"], [manifestPath, "install.json"]];
  for (const [source, name] of files) {
    if (!copyIfExists(source, join(backupDir, name))) fail(`無法備份 ${name}，已取消。`);
  }
  try {
    writeJsonAtomic(catalogPath, catalog);
    writeJsonAtomic(settingsPath, settings);
    writeJsonAtomic(manifestPath, { ...manifest, updatedAt: new Date().toISOString() });
    await waitForPickerModels(settings.routes);
  } catch (error) {
    console.error("\n修改失敗，正在還原之前的配置...");
    const failures = [];
    for (const [target, name] of files) {
      try {
        if (!copyIfExists(join(backupDir, name), target)) failures.push(`找不到 ${name} 備份`);
      } catch (restoreError) { failures.push(`${name}：${restoreError.message}`); }
    }
    console.error(failures.length ? `還原未完成：${failures.join("；")}。備份：${backupDir}` : "已還原到修改前的配置。");
    throw error;
  }
  return backupDir;
}

export function claudeCliModelChoices(routes = [], discovered = []) {
  const choices = [];
  for (const model of discovered) {
    const id = model?.resolvedModel || model?.value;
    if (typeof id !== "string" || !/^(?:opus|sonnet|haiku|fable|claude-[a-zA-Z0-9._-]+)$/.test(id)) continue;
    if (choices.some((choice) => choice.id === id)) continue;
    choices.push({ id, label: terminalSafeText(model.description || model.displayName || id, 220), source: "cli" });
  }
  if (!choices.length) choices.push(...[
    { id: "claude-opus-5-5", label: "Opus 5.5" },
    { id: "claude-opus-5", label: "Opus 5" },
    { id: "sonnet", label: "Sonnet（CLI 別名，測試後確認完整版本）" },
    { id: "haiku", label: "Haiku（CLI 別名，測試後確認完整版本）" },
    { id: "fable", label: "Fable（CLI 別名，測試後確認完整版本）" },
  ].map((choice) => ({ ...choice, source: "fallback" })));
  for (const route of routes) {
    if (route.transport !== "claude-cli" || !/^claude-[a-zA-Z0-9._-]+$/.test(route.upstreamModel || "")) continue;
    if (!choices.some((choice) => choice.id === route.upstreamModel)) choices.push({ id: route.upstreamModel, label: route.upstreamModel, source: "configured" });
  }
  return choices.map((choice) => ({ ...choice, configured: routes.some((route) =>
    route.transport === "claude-cli" && route.upstreamModel === choice.id) }));
}

export function parseClaudeCliSelection(value, choices) {
  if (String(value).trim().toLowerCase() === "cancel") return null;
  const models = parseModelSelection(value, choices.map((choice) => choice.id));
  if (models.some((model) => !/^(?:opus|sonnet|haiku|fable|claude-[a-zA-Z0-9._-]+)$/.test(model))) {
    fail("請選擇模型編號，或輸入 opus、sonnet、haiku、fable／完整 claude-* 模型名稱。");
  }
  return models;
}

// maxOutputTokens：網頁新增時填的輸出上限，同時寫成模型上限與預設輸出（Claude CLI 會把
// 超過模型上限的值自動壓到上限）。終端流程不傳，維持原本的保守值 32,000。
export function planClaudeCliModels(state, binary, models, contextWindow = 200000, resolvedModels = {},
  { maxOutputTokens = null } = {}) {
  if (!models.length || models.some((model) => !/^(?:opus|sonnet|haiku|fable|claude-[a-zA-Z0-9._-]+)$/.test(model))) {
    fail("請填寫 opus、sonnet、haiku、fable 或完整 claude-* 模型名稱。");
  }
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 16000 || contextWindow > 1000000) {
    fail("上下文上限必須介於 16000 與 1000000。");
  }
  const output = maxOutputTokens === null || maxOutputTokens === undefined ? null
    : parseTokenSetting(maxOutputTokens, { label: "最大輸出", min: MIN_OUTPUT_TOKENS, max: MAX_OUTPUT_TOKENS });
  if (output && output > contextWindow) fail("最大輸出不能超過上下文上限。");
  if (state.providers.some((provider) => provider.id === "claude-cli")) fail("既有供應商名稱與 Claude CLI 保留名稱衝突，請先更名。");
  const unique = new Map(models.map((model) => [resolvedModels[model] || model, model]));
  const newRoutes = [...unique].map(([resolved, requested]) => {
    const previous = state.settings.routes.find((route) => route.transport === "claude-cli"
      && (route.upstreamModel === resolved || route.upstreamModel === requested));
    return {
      pickerSlug: previous?.pickerSlug || pickerSlug(resolved, "claude-cli"), upstreamModel: resolved,
      requestedModel: requested,
      displayName: `claude-cli/${resolved}`, providerId: "claude-cli", providerHost: "Claude Code（訂閱帳號）",
      transport: "claude-cli", translate: "anthropic", efforts: [...EFFORTS],
      contextWindow, maxOutputTokens: output ?? 32000, ...(output ? { defaultMaxOutputTokens: output } : {}),
    };
  });
  const replaced = new Set(newRoutes.map((route) => route.pickerSlug));
  const routes = [...state.settings.routes.filter((route) => !replaced.has(route.pickerSlug)), ...newRoutes];
  const official = state.catalog.models.filter((model) => !String(model.slug).startsWith("custom/"));
  if (!official.length) fail("找不到官方模型模板，請先更新路由工具。");
  const retained = state.catalog.models.filter((model) => !replaced.has(model.slug));
  const maxPriority = Math.max(0, ...retained.map((model) => Number(model.priority) || 0));
  const entries = newRoutes.map((route, index) => ({ ...customCatalogEntry(official, route, index),
    priority: maxPriority + index + 1, description: "實驗性 Claude CLI 訂閱路由；上下文為手動設定，非探測值。" }));
  const claudeCli = { ...state.settings.claudeCli, binary,
    timeoutMs: state.settings.claudeCli?.timeoutMs || 180000,
    totalTimeoutMs: state.settings.claudeCli?.totalTimeoutMs || 900000 };
  return { settings: { ...state.settings, version: INSTALLER_VERSION, codexBin, routes, claudeCli },
    manifest: { ...state.manifest, version: INSTALLER_VERSION, codexBin, routes, claudeCli },
    catalog: { ...state.catalog, models: [...retained, ...entries] } };
}

export async function ensureClaudeCliReady({ inspect, consent, install, update, readOnly = false,
  minimumVersion = CLAUDE_CLI_MIN_VERSION }) {
  let current = await inspect();
  if (readOnly) return current;
  if (!current) {
    if (!await consent("未安裝 Claude CLI，是否透過 Anthropic 官方安裝程式安裝？")) return null;
    await install();
    current = await inspect();
    if (!current) fail("安裝後仍找不到 Claude CLI，請檢查官方安裝程式輸出，或以 CODEX_MODEL_ROUTER_CLAUDE_BIN 指定執行檔。");
  }
  if (!current.version || compareVersions(current.version, minimumVersion) < 0) {
    if (!await consent(`Claude CLI ${current.version || "版本未知"} 低於最低要求 ${minimumVersion}，是否備份並更新？`)) return null;
    await update(current.binary);
    current = await inspect();
    if (!current?.version || compareVersions(current.version, minimumVersion) < 0) {
      fail(`更新後仍未達 ${minimumVersion}；請確認指定的 CLI 路徑與安裝來源。Homebrew／WinGet 安裝請透過原套件管理器更新。`);
    }
  }
  return current;
}

export async function ensureClaudeCliLogin(binary, { auth, login, notify, force = false }) {
  let status = await auth(binary);
  if (force || !status.loggedIn || status.authMethod !== "claude.ai") {
    notify("接下來使用 Claude 官方登入流程，請在瀏覽器中完成授權。路由器不保存登入 token。");
    await login(binary);
    status = await auth(binary);
  }
  if (!status.loggedIn || status.authMethod !== "claude.ai") fail("未登入 Claude 訂閱帳號；路由配置未修改。API Key 請使用原本的供應商流程。");
  return status;
}

// Never inherit the router installer's blanket YES flag for installing software.
async function confirmClaudeCliChange(question) {
  if (!input.isTTY) {
    console.log("安裝／更新 Claude CLI 需要在互動終端機明確確認；未執行任何安裝或更新。");
    return false;
  }
  const rl = createInterface({ input, output });
  try { return /^(y|yes)$/i.test((await rl.question(`${question} [y/N]: `)).trim()); }
  finally { rl.close(); }
}

export function claudeCliInstallCommand(platform, directory) {
  const windows = platform === "win32";
  const file = join(directory, windows ? "install.ps1" : "install.sh");
  return { url: windows ? "https://claude.ai/install.ps1" : "https://claude.ai/install.sh", file,
    binary: windows ? "powershell.exe" : "bash",
    args: windows ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, "latest"] : [file, "latest"] };
}

async function runClaudeCliSetup(command, args, directory, environment) {
  // 網頁管理介面沒有終端機可以直接顯示，改以管線收集輸出，顯示在操作記錄裡。
  const capture = managerMode;
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: directory, env: environment,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: capture });
    if (capture) {
      child.stdout.on("data", (chunk) => process.stdout.write(chunk));
      child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 300000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("無法啟動 Claude 安裝／更新程式，路由配置未修改。")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve();
      else reject(new Error(timedOut ? "Claude 安裝／更新逾時，路由配置未修改。" : "Claude 安裝／更新未完成，請查看上方輸出；路由配置未修改。"));
    });
  });
}

function claudeCliBinaryCandidates(settings) {
  return [env.CODEX_MODEL_ROUTER_CLAUDE_BIN, settings?.claudeCli?.binary,
    join(homeDir, ".local", "bin", isWindows ? "claude.exe" : "claude"), commandPath(isWindows ? "claude.exe" : "claude")];
}

const claudeCliVersionOf = (output) => /\b(\d+\.\d+\.\d+)\b/.exec(output || "")?.[1] || null;

function inspectClaudeCli(settings = readSettingsIfExists()) {
  const binary = findExecutable(claudeCliBinaryCandidates(settings));
  if (!binary) return null;
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15000, maxBuffer: 65536, windowsHide: true });
  return { binary, version: result.status === 0 ? claudeCliVersionOf(result.stdout) : null };
}

// 非同步版本：網頁查詢狀態時不阻塞管理頁回應其他請求。
async function inspectClaudeCliAsync(settings = readSettingsIfExists()) {
  const binary = findExecutable(claudeCliBinaryCandidates(settings));
  if (!binary) return null;
  const result = await commandOutput(binary, ["--version"], { timeoutMs: 15000 });
  return { binary, version: result.status === 0 ? claudeCliVersionOf(result.stdout) : null };
}

let claudeCliTransport = null;
function loadClaudeCliTransport() {
  claudeCliTransport ??= import(`data:text/javascript;base64,${Buffer.from(loadClaudeCliSource()).toString("base64")}`);
  return claudeCliTransport;
}

// 只使用 Anthropic 官方安裝程式與 claude update；呼叫端必須先取得使用者明確同意。
function claudeCliSetupActions(transport) {
  return {
    install: async () => {
      const directory = mkdtempSync(join(tmpdir(), "codex-claude-install-"));
      try {
        const command = claudeCliInstallCommand(process.platform, directory);
        console.log(`從 ${command.url} 下載官方安裝程式。`);
        const response = await fetch(command.url, { signal: AbortSignal.timeout(60000) });
        if (!response.ok) fail(`無法下載官方安裝程式（HTTP ${response.status}），路由配置未修改。`);
        const script = await response.text();
        if (!script.trim() || script.length > 2 * 1024 * 1024 || /^\s*<(?:!doctype|html)/i.test(script)) fail("官方安裝程式內容異常，已取消執行。");
        writeFileSync(command.file, script, { mode: 0o600 });
        await runClaudeCliSetup(command.binary, command.args, directory, transport.claudeCliEnvironment());
      } finally { rmSync(directory, { recursive: true, force: true }); }
    },
    update: async (binary) => {
      const backup = join(backupsRoot, `claude-cli-update-${timestamp()}`);
      ensureDirectory(backup);
      copyFileSync(binary, join(backup, isWindows ? "claude.exe" : "claude"));
      console.log(`Claude CLI 執行檔已備份：${backup}`);
      await runClaudeCliSetup(binary, ["update"], backup, transport.claudeCliEnvironment());
    },
  };
}

// 每個模型送一次短測試（使用訂閱用量）。只有回傳完整文字、正常結束、且帶有明確模型版本
// 的才算通過，並記下實際的模型 ID。遇到「需要較新的 CLI」時交給 onUpgradeRequired（終端會
// 詢問是否更新）；沒有提供時記為未通過，不會自動安裝任何東西。
export async function testClaudeCliModels(transport, { binary, version, models, onUpgradeRequired = null }) {
  const passed = [];
  const resolvedModels = {};
  const failures = {};
  const probe = async (model) => {
    const response = await transport.fetchClaudeCli({ model, max_tokens: 1024, system: "Reply briefly.",
      messages: [{ role: "user", content: "Reply with OK only." }] },
      { binary, effort: "medium", timeoutMs: 45000, totalTimeoutMs: 45000 });
    if (!response.ok) return { events: [], failure: (await response.json()).error || { message: "Claude CLI 無法使用。" } };
    const text = await response.text();
    const events = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    return { events, failure: events.find((event) => event.type === "error")?.error };
  };
  for (const model of models) {
    console.log(`正在測試 Claude CLI：${model}...`);
    let { events, failure } = await probe(model);
    if (failure?.type === "claude_cli_upgrade_required" && /^\d+\.\d+\.\d+$/.test(failure.requiredVersion || "")
      && compareVersions(version, failure.requiredVersion) < 0) {
      console.log(`  ${failure.message}`);
      if (!onUpgradeRequired) {
        failures[model] = failure.message;
        continue;
      }
      const updated = await onUpgradeRequired(failure.requiredVersion);
      if (!updated) return { cancelled: true, passed, resolvedModels, failures, binary, version };
      ({ binary, version } = updated);
      console.log(`CLI 已更新至 ${version}，重新測試 ${model} 一次。`);
      ({ events, failure } = await probe(model));
    }
    const stop = events.find((event) => event.type === "message_delta")?.delta?.stop_reason;
    const hasText = events.some((event) => event.delta?.text?.trim() || event.content_block?.text?.trim());
    const resolved = events.find((event) => event.type === "message_start")?.message?.model;
    if (!failure && hasText && stop === "end_turn" && events.some((event) => event.type === "message_stop")) {
      if (typeof resolved !== "string" || !/^claude-[a-zA-Z0-9._-]+$/.test(resolved) || !/\d/.test(resolved)) {
        console.log("  未添加：回應沒有明確的模型版本編號，無法可靠標示實際模型。");
        failures[model] = "回應沒有明確的模型版本編號。";
        continue;
      }
      console.log(`  實際模型：${model} → ${resolved}`);
      resolvedModels[model] = resolved;
      passed.push(model);
    } else {
      const message = failure?.message || "沒有收到完整的文字回應。";
      console.log(`  未通過：${message}`);
      failures[model] = message;
    }
  }
  return { cancelled: false, passed, resolvedModels, failures, binary, version };
}

async function configureClaudeCli(subcommand = null) {
  if (subcommand && !["status", "login"].includes(subcommand)) fail("用法：claude-cli [status|login]");
  const state = requireInstallation();
  const transport = await loadClaudeCliTransport();
  const actions = claudeCliSetupActions(transport);
  const setup = { inspect: () => inspectClaudeCli(state.settings), consent: confirmClaudeCliChange,
    readOnly: subcommand === "status", install: actions.install, update: actions.update };
  const ready = await ensureClaudeCliReady(setup);
  if (!ready) { console.log(subcommand === "status" ? "Claude CLI：未安裝。" : "已取消，路由配置未修改。"); return; }
  let { binary, version } = ready;
  console.log(`\nClaude CLI：${binary}（${version || "未知"}）`);
  if (subcommand === "status") {
    if (!version || compareVersions(version, CLAUDE_CLI_MIN_VERSION) < 0) console.log(`版本過舊，需要 ${CLAUDE_CLI_MIN_VERSION} 或更新版本；執行 claude-cli 可開啟更新引導。`);
    const auth = await transport.claudeCliAuth(binary);
    console.log(`訂閱登入：${auth.loggedIn && auth.authMethod === "claude.ai" ? "已登入" : "尚未登入訂閱帳號"}`);
    return;
  }
  await ensureClaudeCliLogin(binary, { auth: transport.claudeCliAuth,
    login: (path) => transport.claudeCliAuth(path, { login: true }), notify: console.log, force: subcommand === "login" });
  console.log("訂閱登入：已登入。");
  if (subcommand === "login") return;
  if (!codexBin) fail("未找到 Codex CLI。");
  verifyLogin();
  printHeading("連接 Claude 訂閱帳號（實驗性）");
  console.log("正在讀取 Claude CLI 模型清單（不發送推理請求）...");
  let discovered = [];
  try { discovered = await transport.discoverClaudeCliModels(binary); }
  catch (error) { console.log(`模型清單讀取失敗：${error.message}`); }
  const choices = claudeCliModelChoices(state.settings.routes, discovered);
  console.log(choices.some((choice) => choice.source === "cli")
    ? "來源：Claude CLI 當前模型清單；另保留已添加模型。清單不保證各模型皆有可用額度，亦不一定包含桌面版的全部模型。"
    : "來源：內建候選列表（CLI 未提供可辨識清單）；尚未驗證帳號權限。");
  choices.forEach((choice, index) => console.log(`  ${index + 1}. ${choice.label} — ${choice.id}${choice.configured ? "（已添加，可重新設定）" : ""}${choice.source === "configured" ? "（既有設定，CLI 本次未列出）" : ""}`));
  console.log("用量與額外計費依 Claude 帳號方案；未列出的模型可直接輸入完整 ID。測試後固定使用回應中的完整版本。");
  console.log("每個選定模型會發送一次短測試並使用訂閱用量；只有通過的模型會添加。輸入 cancel 取消。");
  const answer = await ask("請輸入模型編號（逗號分隔、範圍或 all；也可直接輸入完整模型 ID）", "1");
  const models = parseClaudeCliSelection(answer, choices);
  if (!models) { console.log("未修改路由配置。"); return; }
  const contextWindow = Number(await ask("上下文上限（非自動探測；未知時先用保守值）", "200000"));
  planClaudeCliModels(state, binary, models, contextWindow); // validate before any inference
  const userConfig = await readUserConfig();
  if (Number(userConfig.config.model_context_window) > contextWindow) {
    console.log(`注意：全域 model_context_window=${userConfig.config.model_context_window} 可能覆蓋此模型的 ${contextWindow} 設定；本功能不修改全域值，請先用短對話測試。`);
  }
  const tested = await testClaudeCliModels(transport, { binary, version, models,
    onUpgradeRequired: (requiredVersion) => ensureClaudeCliReady({ ...setup, minimumVersion: requiredVersion }) });
  if (tested.cancelled) { console.log("已取消，路由配置未修改。"); return; }
  binary = tested.binary;
  const { passed, resolvedModels } = tested;
  if (!passed.length) { console.log("沒找到可用模型，路由配置未修改。"); return; }
  // Re-read after login/probing; never overwrite intervening catalog refreshes.
  const plan = planClaudeCliModels(requireInstallation(), binary, passed, contextWindow, resolvedModels);
  const backup = await commitRouterChange("claude-cli", plan);
  console.log(`已添加：${[...new Set(passed.map((model) => `claude-cli/${resolvedModels[model]}`))].join("、")}。請重開 Codex 後選擇模型。`);
  console.log(`可從「刪除自訂模型」移除；不會登出 Claude。備份：${backup}`);
}

async function manageProviders(subcommand = null) {
  const { settings, providers } = requireInstallation();
  let action = subcommand ? String(subcommand).toLowerCase() : null;
  if (!action) {
    printHeading("管理供應商");
    providers.forEach((provider, index) => {
      console.log(`  ${index + 1}. ${providerLine(provider, settings.routes)}${index === 0 ? "，主要供應商" : ""}`);
    });
    console.log("");
    console.log("  add     新增供應商，探測並添加它的模型");
    console.log("  remove  移除供應商與它的模型");
    console.log("  key     更換某一家的 API Key");
    action = (await ask("請選擇操作（Enter 返回）")).trim().toLowerCase();
  }
  if (!action || action === "cancel") {
    console.log("未進行任何修改。");
    return;
  }
  if (["add", "a", "new"].includes(action)) await addProvider();
  else if (["remove", "r", "rm", "delete"].includes(action)) await removeProvider();
  else if (["key", "k", "api-key"].includes(action)) await replaceProviderKey();
  else fail(`無法識別的操作：${action}`);
}

async function askProviderId(baseUrl, takenIds) {
  const suggested = suggestProviderId(baseUrl, takenIds);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = (await ask("供應商名稱（用於管理，僅為無前綴的模型補上名稱；Enter 使用預設）", suggested)).trim().toLowerCase();
    const problem = providerIdError(answer, takenIds);
    if (!problem) return answer;
    console.log(problem);
  }
  fail("供應商名稱無效，未進行任何修改。");
}

async function addProvider() {
  const { manifest, settings, catalog, providers } = requireInstallation();
  if (!codexBin) fail(`未找到 Codex CLI，請先安裝 ${desktopAppName} 或 Codex CLI。`);
  verifyLogin();
  printHeading("新增供應商");
  console.log("每家供應商各自保存 API Key；已有前綴的模型保留原名，無前綴的模型才加供應商名稱。");
  const baseUrl = normalizeUrl(await ask("兼容 OpenAI 的 Base URL"));
  const clash = providers.find((provider) => provider.baseUrl === baseUrl);
  if (clash) fail(`這個 Base URL 已經是供應商「${clash.id}」；要添加它的模型請用「添加自訂模型」。`);
  const keychainService = keychainServiceFor(baseUrl);
  const keyExisted = keychainHas(keychainService);
  if (!keyExisted) await storeApiKey(keychainService, baseUrl);
  else if (await confirm(`${secretStoreLabel}中已存在這個 Base URL 的 API Key，是否替換？`, false)) {
    await storeApiKey(keychainService, baseUrl);
  }
  // 之後任何一步失敗都刪掉這次新存的 Key，不留下沒有供應商在用的憑證。
  try {
    const apiKey = readApiKey(keychainService);
    console.log("正在發現可用模型...");
    const discovery = await discoverApiRoot(baseUrl, apiKey);
    console.log(`API 根地址：${discovery.apiRoot}`);
    const selectedModels = await selectModels(discovery.models);
    const takenIds = providers.map((provider) => provider.id);
    const prefixed = selectedModels.length > 0 && selectedModels.every((model) => model.includes("/"));
    const id = prefixed ? suggestProviderId(baseUrl, takenIds) : await askProviderId(baseUrl, takenIds);
    if (prefixed) console.log(`所選模型已有前綴，保留模型原名；供應商管理名稱自動設為「${id}」。`);
    console.log(`\n每個選中的模型最多會執行五次小型 Responses API 探測；同時最多探測 ${probeConcurrency()} 個模型。`);
    if (!(await confirm("是否繼續進行能力探測？", true))) fail("已在修改配置前取消。");
    const outcomes = await probeModelsInParallel(selectedModels,
      (model, log) => buildRouteForModel(discovery, apiKey, model, log, id));
    const newRoutes = outcomes.map((outcome) => outcome.route).filter(Boolean);
    if (newRoutes.length === 0) fail("選中的模型均未通過探測，配置未改動。");
    const provider = {
      id,
      baseUrl,
      apiRoot: discovery.apiRoot,
      keychainService,
      keychainAccount: "codex",
      credentialPath: isWindows ? credentialFileFor(keychainService) : null,
    };
    const plan = planAddProvider(manifest, settings, catalog, loadCatalogTemplates(), provider, newRoutes, discovery.models);
    const backupDir = await commitRouterChange("add-provider", plan);

    printHeading("新增完成");
    console.log(`供應商：${id}（${discovery.apiRoot}）`);
    console.log("已添加模型：");
    for (const route of newRoutes) {
      const effortText = route.efforts.length ? route.efforts.join(", ") : "使用供應商預設值";
      console.log(`  - ${route.displayName}`);
      console.log(`    選擇器 ID：${route.pickerSlug}`);
      console.log(`    推理強度：${effortText}`);
    }
    console.log(`現共 ${plan.providers.length} 家供應商、${plan.settings.routes.length} 個自訂模型。`);
    console.log(`備份：${backupDir}`);
    console.log(`\n請完全退出並重新打開 ${desktopAppName}。`);
  } catch (error) {
    if (!keyExisted) {
      try { deleteApiKey(keychainService); } catch { /* 刪不掉只會留下一筆沒人用的憑證。 */ }
    }
    throw error;
  }
}

async function removeProvider() {
  const { manifest, settings, catalog, providers } = requireInstallation();
  if (!codexBin) fail(`未找到 Codex CLI，請先安裝 ${desktopAppName} 或 Codex CLI。`);
  printHeading("移除供應商");
  if (providers.length <= 1) {
    console.log("目前只有一家供應商，無法移除；要整個移除路由器請用「回退配置」。");
    return;
  }
  const chosen = await chooseProvider(providers, settings.routes, "要移除哪一家供應商", { allowCancel: true });
  if (!chosen) {
    console.log("未進行任何修改。");
    return;
  }
  const preview = planRemoveProvider(manifest, settings, catalog, chosen.id);
  const userConfig = await readUserConfig();
  const defaultModel = removedDefaultModel(userConfig.config, preview.removedRoutes.map((route) => route.pickerSlug));
  const imagegen = relayConfig();
  const imagegenAffected = Boolean(imagegen) && (imagegen.providerId ?? DEFAULT_PROVIDER_ID) === chosen.id;
  console.log(`\n即將移除供應商「${chosen.id}」（${chosen.baseUrl}）與它的 ${preview.removedRoutes.length} 個模型：`);
  for (const route of preview.removedRoutes) console.log(`  - ${route.displayName || route.upstreamModel}`);
  if (providers[0].id === chosen.id) console.log(`移除後由「${preview.providers[0].id}」擔任主要供應商。`);
  if (defaultModel) console.log("這些模型包含全域預設模型；確認後會清除該預設，讓 Codex 使用官方預設模型。");
  if (imagegenAffected) console.log("中轉 API 生圖使用這家供應商，會一併停用；之後可從選單重新設定。");
  console.log("使用上述模型的既有任務需切換到其他模型後才能繼續。");
  if (!(await confirm(`確認移除供應商「${chosen.id}」？`, false))) {
    console.log("未進行任何修改。");
    return;
  }
  const { plan, backupDir } = await executeRemoveProvider(chosen.id, { expectedDefault: defaultModel });

  printHeading("移除完成");
  console.log(`已移除供應商「${chosen.id}」與 ${plan.removedRoutes.length} 個模型，剩餘 ${plan.providers.length} 家供應商。`);
  if (defaultModel) console.log("已清除指向已刪模型的全域預設模型設定。");
  console.log(`備份：${backupDir}`);
  if (await confirm(`是否從${secretStoreLabel}中刪除「${chosen.id}」的 API Key？`, true)) {
    deleteApiKey(chosen.keychainService, chosen.keychainAccount || "codex");
  }
  console.log(`\n請完全退出並重新打開 ${desktopAppName}。`);
}

// 移除供應商的寫入段，終端與網頁共用：以最新檔案重新規劃，必要時清除全域預設模型，
// 這家供應商負責中轉生圖時一併停用該技能。是否刪除 API Key 由呼叫端決定。
async function executeRemoveProvider(providerId, { expectedDefault } = {}) {
  const { manifest, settings, catalog } = requireInstallation();
  const plan = planRemoveProvider(manifest, settings, catalog, providerId);
  const removedSlugs = plan.removedRoutes.map((route) => route.pickerSlug);
  const userConfig = await readUserConfig();
  const defaultModel = removedDefaultModel(userConfig.config, removedSlugs);
  if (expectedDefault !== undefined && defaultModel !== expectedDefault) {
    fail("全域預設模型在確認期間變更，請重新執行。");
  }
  const imagegen = relayConfig();
  const imagegenAffected = Boolean(imagegen) && (imagegen.providerId ?? DEFAULT_PROVIDER_ID) === providerId;
  const backupDir = await commitRouterChange("remove-provider", {
    ...plan,
    absent: removedSlugs,
    configFile: defaultModel ? userConfig.filePath : null,
    apply: defaultModel ? clearDefaultModel : null,
    restore: defaultModel ? () => writeConfigEdits([{ keyPath: "model", value: defaultModel }]) : null,
  });
  if (imagegenAffected) {
    try {
      const archive = join(backupsRoot, `imagegen-disabled-${timestamp()}`);
      if (archiveRelayImageSkill(archive)) console.log(`中轉 API 生圖已停用，技能已封存至：${archive}`);
    } catch (error) {
      console.error(`中轉 API 生圖未能停用：${error.message}。請從選單重新設定或停用。`);
    }
  }
  return { plan, defaultModel, imagegenAffected, backupDir };
}

async function replaceProviderKey() {
  const { settings, providers } = requireInstallation();
  printHeading("更換 API Key");
  const provider = providers.length === 1
    ? providers[0]
    : await chooseProvider(providers, settings.routes, "要更換哪一家的 API Key", { allowCancel: true });
  if (!provider) {
    console.log("未進行任何修改。");
    return;
  }
  console.log(`供應商：${provider.id}（${provider.baseUrl}）`);
  await storeApiKey(provider.keychainService, provider.baseUrl);
  // 舊 Key 已被覆寫，驗證不通過也無從還原，只提醒使用者。
  try {
    const apiKey = readApiKey(provider.keychainService);
    const response = await fetchWithTimeout(`${provider.apiRoot}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }, 15000);
    await response.arrayBuffer();
    console.log(response.ok
      ? "已更換，新 Key 可以正常查詢模型清單。"
      : `已更換，但用新 Key 查詢模型清單得到 HTTP ${response.status}，請確認 Key 是否正確。`);
  } catch (error) {
    console.log(`已更換，但無法用新 Key 查詢模型清單（${error.message}）。`);
  }
  console.log(isWindows
    ? "路由器下一個請求就會改用新 Key，不必重啟。"
    : "路由器最晚 5 分鐘內改用新 Key；上游拒絕舊 Key 時會立即改用。");
}

// 更新程式碼並遷移預設顯示名稱，其餘一律沿用。把「能不能更新、更新後的
// 設定長什麼樣」抽成純函式，才驗得到既有路由與使用者旋鈕不會在更新中被洗掉——
// 這正是以前只能走 install 重裝、每次都要重問 Base URL、API Key 與模型的原因。
export function planUpdate(manifest, settings, installerVersion = INSTALLER_VERSION) {
  if (!manifest) return { ok: false, reason: "not-installed" };
  if (!settings || typeof settings !== "object") return { ok: false, reason: "missing-settings" };

  if (!Array.isArray(settings.routes)) return { ok: false, reason: "no-routes" };
  const routes = settings.routes.map(withDefaultModelPrefix);
  const providers = installedProviders(settings, manifest);
  if (providers.length === 0) return { ok: false, reason: "no-providers" };
  const providerIds = new Set(providers.map((provider) => provider.id));
  if (routes.some((route) => route.transport === "claude-cli"
    ? route.translate !== "anthropic" || !settings.claudeCli?.binary
    : !providerIds.has(routeProviderId(route)))) {
    return { ok: false, reason: "unknown-provider" };
  }

  const port = Number(settings.port ?? manifest.port);
  if (!Number.isFinite(port) || port <= 0) return { ok: false, reason: "bad-port" };

  const installed = terminalSafeText(manifest.version, 32) || null;
  const comparison = compareVersions(installerVersion, installed);
  if (comparison != null && comparison < 0) {
    return { ok: false, reason: "installer-older", installed };
  }

  return {
    ok: true,
    installed,
    target: installerVersion,
    // 版本相同仍然允許：用來修復被改壞或版本標記對不上的安裝。
    alreadyCurrent: comparison === 0,
    port,
    routes,
    providers,
    // 只有預設顯示名稱會補 api/；所有上游 ID、憑證、模型能力與使用者旋鈕保留。
    // 舊版放在頂層的單一供應商欄位搬進 providers（見 installedProviders）。
    settings: withProviders({ ...settings, routes, version: installerVersion }, providers),
    manifest: manifestWithProviders({
      ...manifest, version: installerVersion,
      ...(Array.isArray(manifest.routes) ? { routes: manifest.routes.map(withDefaultModelPrefix) } : {}),
    }, providers),
  };
}

const UPDATE_FAILURES = {
  "not-installed":
    "當前 CODEX_HOME 尚未安裝 Codex 模型路由器，請先選擇「安裝或重新配置」。",
  "missing-settings":
    "找不到 settings.json，安裝可能已損壞，請改用「安裝或重新配置」。",
  "no-routes":
    "現有安裝缺少模型路由清單，請改用「安裝或重新配置」。",
  "bad-port":
    "現有安裝沒有可用的連接埠設定，請改用「安裝或重新配置」。",
  "no-providers":
    "現有安裝缺少中轉供應商設定，請改用「安裝或重新配置」。",
  "unknown-provider":
    "有自訂模型指向不存在的供應商，請先刪除那些模型，或改用「安裝或重新配置」。",
};

export function isManagedCatalogPath(value, managedPath) {
  if (typeof value !== "string" || !value) return false;
  return resolve(value) === resolve(managedPath);
}

async function update() {
  const manifest = readManifest();
  const settings = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, "utf8"))
    : null;
  const plan = planUpdate(manifest, settings);
  if (!plan.ok) {
    if (plan.reason === "installer-older") {
      fail(
        `已安裝版本 ${plan.installed} 比當前安裝器 ${INSTALLER_VERSION} 更新。` +
          "為避免降級，請重新下載最新版安裝器。",
      );
    }
    fail(UPDATE_FAILURES[plan.reason] || "無法更新現有安裝。");
  }
  const currentCatalog = existsSync(catalogPath) ? JSON.parse(readFileSync(catalogPath, "utf8")) : null;
  const updatedCatalog = prefixCatalogDisplayNames(currentCatalog, plan.routes);
  const namesChanged = updatedCatalog !== currentCatalog;
  // 只遷移本工具管理的固定目錄，不移除使用者自行指定的其他目錄。
  if (!codexBin) fail("此次更新需要 Codex CLI 讀取及遷移舊版模型目錄設定，請先確認 Codex 已安裝。");
  const userConfig = await readUserConfig();
  const previousCatalogPath = userConfig.config.model_catalog_json;
  const migrateCatalog = isManagedCatalogPath(previousCatalogPath, catalogPath);
  // 舊版的已知資料夾偵測從未成功；只修正仍停在預設值的設定。
  const migratedOutputDir = isWindows
    ? migratedImageOutputDir(plan.settings.imageOutputDir, windowsDownloadsDir(), join(homeDir, "Downloads"))
    : null;
  if (migratedOutputDir) plan.settings = { ...plan.settings, imageOutputDir: migratedOutputDir };

  printHeading("更新路由器");
  console.log(`版本：${plan.installed || "未知"} → ${plan.target}`);
  if (plan.alreadyCurrent) {
    console.log("已是這個版本，將重新寫入一次程式碼與服務定義（可用於修復安裝）。");
  }
  printProviders(plan.providers, plan.routes);
  console.log(`端口：${plan.port}`);
  console.log(`保留 ${plan.routes.length} 個自訂模型：`);
  for (const route of plan.routes) {
    console.log(`  - ${route.displayName || route.upstreamModel}`);
  }
  if (migratedOutputDir) console.log(`閘道生成圖片的存放位置改為實際的「下載」資料夾：${migratedOutputDir}`);
  console.log(
    "\n只會換掉路由器與轉譯層程式碼然後重啟；服務定義只有真的變了才會重寫。" +
      "不重問 Base URL、API Key 與模型；舊版固定模型目錄將遷移為啟動時同步官方清單。",
  );

  const backupDir = join(backupsRoot, `update-${timestamp()}`);
  ensureDirectory(backupDir);
  copyIfExists(routerPath, join(backupDir, "router.mjs"));
  copyIfExists(bridgePath, join(backupDir, "claude-bridge.mjs"));
  backupChatBridge(backupDir);
  copyIfExists(settingsPath, join(backupDir, "settings.json"));
  copyIfExists(manifestPath, join(backupDir, "install.json"));
  if (migrateCatalog) copyIfExists(userConfig.filePath, join(backupDir, "config.toml"));
  if (namesChanged) copyIfExists(catalogPath, join(backupDir, "models.json"));
  for (const path of serviceArchivePaths()) {
    copyIfExists(path, join(backupDir, basename(path)));
  }

  let health;
  let serviceWarning = null;
  let catalogConfigAttempted = false;
  try {
    writeFileSync(routerPath, extractRouterSource(), { mode: 0o600 });
    chmodSync(routerPath, 0o600);
    writeBridgeSources();
    writeJsonAtomic(settingsPath, { ...plan.settings, codexBin });
    if (namesChanged) writeJsonAtomic(catalogPath, updatedCatalog);
    writeJsonAtomic(manifestPath, {
      ...plan.manifest,
      codexBin,
      updatedAt: new Date().toISOString(),
    });
    if (serviceDefinitionUnchanged()) {
      // 常見情況：埠與路徑都沒變，重新註冊沒有意義，原地重啟即可（不需提權）。
      restartServiceInPlace();
    } else {
      // 守護迴圈或啟動方式真的變了才重新註冊。這一步在 Windows 上可能因權限失敗，
      // 失敗就把舊定義放回去並原地重啟——升級不該因為註冊不了而讓服務停擺。
      try {
        if (isWindows && !testMode) assertScriptHostAvailable();
        writeServiceDefinition();
        stopService();
        startService();
        removeLegacyLauncher();
      } catch (registrationError) {
        for (const path of serviceArchivePaths()) {
          copyIfExists(join(backupDir, basename(path)), path);
        }
        restartServiceInPlace();
        serviceWarning =
          `服務定義有更新，但無法重新註冊（${registrationError.message}）。` +
          "已沿用舊定義並重啟，路由器功能不受影響；" +
          "要套用新的服務定義，請以系統管理員身分執行一次安裝或重新配置。";
      }
    }
    health = await waitForHealth(plan.port);
    if (migrateCatalog) {
      catalogConfigAttempted = true;
      await writeConfigEdits([{ keyPath: "model_catalog_json", value: null }]);
      const verified = await readUserConfig();
      if (verified.config.model_catalog_json != null) fail("固定模型目錄設定未成功移除。");
    }
  } catch (error) {
    console.error("\n更新失敗，正在還原更新前的檔案...");
    if (catalogConfigAttempted) {
      try { await writeConfigEdits([{ keyPath: "model_catalog_json", value: previousCatalogPath }]); }
      catch { console.error(`模型目錄設定還原失敗，原配置備份：${join(backupDir, "config.toml")}`); }
    }
    copyIfExists(join(backupDir, "router.mjs"), routerPath);
    copyIfExists(join(backupDir, "claude-bridge.mjs"), bridgePath);
    restoreChatBridge(backupDir);
    copyIfExists(join(backupDir, "settings.json"), settingsPath);
    copyIfExists(join(backupDir, "install.json"), manifestPath);
    if (namesChanged) copyIfExists(join(backupDir, "models.json"), catalogPath);
    for (const path of serviceArchivePaths()) {
      copyIfExists(join(backupDir, basename(path)), path);
    }
    // 還原之後一定要把服務拉回來，而且不能默默吞掉失敗：
    // 「更新失敗」還可以接受，「更新失敗而且路由器停著」會讓所有對話直接卡死。
    try {
      restartServiceInPlace();
      await waitForHealth(plan.port);
      console.error("已還原到更新前的版本，路由器運作正常。");
    } catch (restartError) {
      console.error(
        `\n嚴重：檔案已還原，但路由器沒有起來（${restartError.message}）。\n` +
          `請手動啟動：${manualStartHint()}\n` +
          `在它恢復之前，所有經過 127.0.0.1:${plan.port} 的請求都會失敗。`,
      );
    }
    throw error;
  }

  printHeading("更新完成");
  console.log(`版本：${health?.version || plan.target}`);
  console.log(`健康檢查：${health?.status || "未知"}`);
  console.log(`保留 ${plan.routes.length} 個自訂模型，上游 ID、模型能力與 API Key 未變動。`);
  if (namesChanged) console.log("沒有上游前綴的預設模型名稱已補上 api/。");
  if (migrateCatalog) console.log("已移除舊版固定模型目錄；重新開啟 Codex 時會同步官方清單並合併自訂模型。");
  else if (previousCatalogPath) console.log("注意：保留了您自行設定的 model_catalog_json；該設定會停用啟動時同步模型清單。");
  console.log(`備份：${backupDir}`);
  if (serviceWarning) console.log(`\n注意：${serviceWarning}`);
  try { refreshRelayImagegen(); } catch (error) {
    console.error(`路由器已更新，中轉生圖技能保持原狀：${error.message}`);
  }
  printManagerLauncher(await installManagerLauncher());
  console.log(`\n請完全退出並重新打開 ${desktopAppName}。`);
}

// 可強制顯示的隱藏官方模型：Codex 內建目錄標成 hide 的項目，並標出目前已強制顯示的。
export function hiddenModelChoices(bundledCatalog, forceListed = []) {
  const official = (bundledCatalog?.models || []).filter((model) => !String(model?.slug || "").startsWith("custom/"));
  const forced = new Set(normalizeForceListedModels(official, forceListed));
  return official.filter((model) => model?.visibility === "hide").map((model) => ({
    slug: model.slug,
    displayName: model.display_name || model.slug,
    description: typeof model.description === "string" ? model.description : "",
    forced: forced.has(model.slug),
  }));
}

function requireHiddenModelsInstallation() {
  const manifest = readManifest();
  if (manifest?.version) assertInstallerNotOlder(manifest.version);
  if (!manifest) {
    fail("當前 CODEX_HOME 尚未安裝 Codex 模型路由器，請先選擇「安裝或重新配置」。");
  }
  if (!existsSync(settingsPath)) {
    fail("找不到 settings.json，安裝可能已損壞，請改用「安裝或重新配置」。");
  }
  if (!existsSync(catalogPath)) {
    fail("找不到 models.json，安裝可能已損壞，請改用「安裝或重新配置」。");
  }
  if (!codexBin) fail(`未找到 Codex CLI，請先安裝 ${desktopAppName} 或 Codex CLI。`);

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const currentCatalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const port = Number(settings.port ?? manifest.port);
  if (!Number.isFinite(port) || port <= 0) fail("現有安裝沒有可用的連接埠設定。");
  return { settings, currentCatalog, port };
}

// 寫入強制顯示的清單並重啟路由器（路由器啟動時才讀這個設定），再以 Codex 實際讀到的
// 目錄驗證；任何一步失敗就還原檔案並確認路由器回來。終端選單與網頁共用。
async function executeHiddenModels(requested, { bundledCatalog = loadBundledCatalog() } = {}) {
  const { settings, currentCatalog, port } = requireHiddenModelsInstallation();
  const officialModels = bundledCatalog.models.filter(
    (model) => !String(model?.slug || "").startsWith("custom/"),
  );
  const previous = normalizeForceListedModels(
    officialModels,
    settings.forceListedModels,
  );
  const chosen = normalizeForceListedModels(officialModels, requested);
  const combinedCatalog = mergeCatalogForForcedModels(
    bundledCatalog,
    currentCatalog,
    chosen,
  );
  const customSlugs = (currentCatalog.models || [])
    .filter((model) => String(model?.slug || "").startsWith("custom/"))
    .map((model) => model.slug);
  const unchanged =
    JSON.stringify(previous) === JSON.stringify(chosen) &&
    JSON.stringify(currentCatalog) === JSON.stringify(combinedCatalog);

  if (unchanged) {
    return { changed: false, chosen, customCount: customSlugs.length };
  }

  const backupDir = join(backupsRoot, `hidden-models-${timestamp()}`);
  ensureDirectory(backupDir);
  copyIfExists(settingsPath, join(backupDir, "settings.json"));
  copyIfExists(catalogPath, join(backupDir, "models.json"));

  let health;
  try {
    writeJsonAtomic(catalogPath, combinedCatalog);
    writeJsonAtomic(settingsPath, { ...settings, forceListedModels: chosen });

    // 動態 /models 使用啟動時讀入的設定，驗證前先載入新選擇。
    restartServiceInPlace();
    health = await waitForHealth(port);

    const modelCheck = shell(codexBin, ["debug", "models"], {
      env: { ...env, CODEX_HOME: codexHome },
    });
    const effectiveCatalog = JSON.parse(modelCheck.stdout);
    const validation = validateManagedCatalog(
      effectiveCatalog,
      chosen,
      customSlugs,
    );
    if (!validation.ok) {
      const details = [
        validation.missingForced.length
          ? `目錄遺失：${validation.missingForced.join(", ")}`
          : "",
        validation.hiddenForced.length
          ? `仍被隱藏：${validation.hiddenForced.join(", ")}`
          : "",
        validation.missingCustom.length
          ? `自訂模型遺失：${validation.missingCustom.join(", ")}`
          : "",
      ].filter(Boolean).join("；");
      fail(`Codex 模型目錄驗證失敗${details ? `：${details}` : ""}`);
    }

  } catch (error) {
    console.error("\n隱藏模型設定失敗，正在還原之前的目錄...");
    copyIfExists(join(backupDir, "settings.json"), settingsPath);
    copyIfExists(join(backupDir, "models.json"), catalogPath);
    try {
      restartServiceInPlace();
      await waitForHealth(port);
      console.error("已還原原本的隱藏模型設定，路由器運作正常。");
    } catch (restartError) {
      console.error(
        `\n嚴重：檔案已還原，但路由器沒有起來（${restartError.message}）。\n` +
          `請手動啟動：${manualStartHint()}\n` +
          `在它恢復之前，所有經過 127.0.0.1:${port} 的請求都會失敗。`,
      );
    }
    throw error;
  }
  return { changed: true, chosen, health, customCount: customSlugs.length, backupDir };
}

async function manageHiddenModels() {
  const { settings } = requireHiddenModelsInstallation();
  printHeading("管理隱藏的官方模型");
  const bundledCatalog = loadBundledCatalog();
  const officialModels = bundledCatalog.models.filter(
    (model) => !String(model?.slug || "").startsWith("custom/"),
  );
  const previous = normalizeForceListedModels(officialModels, settings.forceListedModels);
  const result = await executeHiddenModels(await chooseForcedModels(officialModels, previous), { bundledCatalog });
  if (!result.changed) {
    console.log("\n設定沒有變更，未重寫模型目錄或重啟路由器。");
    console.log(`目前強制顯示 ${result.chosen.length} 個隱藏模型。`);
    return;
  }
  printHeading("隱藏模型設定完成");
  console.log(
    result.chosen.length
      ? `已強制顯示 ${result.chosen.length} 個模型：${result.chosen.join(", ")}`
      : "已恢復預設，不強制顯示任何隱藏模型。",
  );
  console.log(`健康檢查：${result.health?.status || "未知"}`);
  console.log(`保留 ${result.customCount} 個自訂模型。`);
  console.log(`備份：${result.backupDir}`);
  console.log(`\n請完全退出並重新打開 ${desktopAppName}，模型選擇器才會刷新。`);
}

export function selectRelayImageModels(answer, available = RELAY_IMAGE_MODELS) {
  return parseSelection(answer, available.length).map((index) => available[index].id);
}

function relayConfig(root = relaySkillRoot, expectedSettings = settingsPath) {
  if (!existsSync(root)) return null;
  if (lstatSync(root).isSymbolicLink()) fail(`中轉生圖技能目錄是符號連結，未修改：${root}`);
  let config;
  try { config = JSON.parse(readFileSync(join(root, "config.json"), "utf8")); } catch {}
  if (config?.managedBy !== RELAY_IMAGEGEN_OWNER || config.routerSettingsPath !== expectedSettings) {
    fail(`技能目錄已存在且不是此路由器管理，未覆寫：${root}`);
  }
  return config;
}

function imagegenShellCommand(nodePath, program, platform = process.platform) {
  const quote = (value) => platform === "win32"
    ? psQuote(value) : `'${String(value).replaceAll("'", "'\\''")}'`;
  return `${platform === "win32" ? "& " : ""}${quote(nodePath)} ${quote(program)}`;
}

export function renderRelayImageSkill({ root, nodePath, models, platform = process.platform }) {
  const command = imagegenShellCommand(nodePath, join(root, "scripts", "imagegen.mjs"), platform);
  const selected = RELAY_IMAGE_MODELS.filter((model) => models.includes(model.id));
  return [
    "---",
    "name: router-imagegen",
    "description: 透過使用者已啟用的中轉 API 生成或編輯圖片，適用於免費帳號或內建 image_gen 不可用的生圖需求，以及明確指定中轉生圖或 router-imagegen 的任務。",
    "---", "", "# 中轉 API 生圖", "",
    "此技能由使用者在路由器安裝器中選擇啟用，使用中轉供應商的圖片 API 並依其規則計費。",
    "API 請求連到本機路由器，由路由器讀取已保存的憑證；不需要 OPENAI_API_KEY，也不要讀出或複製金鑰。Ark 結果圖片由命令下載，下載不附帶中轉憑證。",
    "若使用者指定官方內建工具或其他供應商，遵從其選擇。本技能不修改官方 imagegen。", "",
    "## 模型選擇", "",
    ...selected.map((model) => `- ${model.label}（${model.id}）：${model.description}`), "",
    "只使用 config.json 中已勾選的模型。每次先執行下面的 list 命令確認最新清單。",
    "若只有一個模型就固定使用；有多個時由 AI 按需求選擇，並以 --model 明確指定。",
    "使用者明確指定的模型優先；若未啟用，說明並請使用者從安裝器設定，不擅自啟用。",
    "一般生圖／快速迭代優先 Flare；需要精確修改或保留原圖細節時優先 Sunburst。",
    "Image 2 用於使用者指定、既有流程或相容需求。只從已啟用模型中選擇，速度與費用以中轉商實際回應為準。", "",
    "若省略 --model，命令的生圖預設依 Flare → Sunburst → Image 2，改圖依 Sunburst → Flare → Image 2，選第一個已啟用模型。AI 應明確指定，不以這個順序代替需求判斷。", "",
    "## 執行", "",
    "把提示詞寫進 UTF-8 檔案，避免 shell 引號與特殊字元影響內容。使用絕對路徑。",
    "新圖片用 generate；改圖或帶參考圖用 edit，先查看本機參考圖，並寫清楚要保留及修改的部分。",
    "以下路徑與 MODEL 請換成實際值；只需 Node.js，不需要 Python 或額外套件。", "",
    "```" + (platform === "win32" ? "powershell" : "bash"),
    `${command} list`,
    `${command} generate --model MODEL --prompt-file 'prompt.txt' --out 'output.png'`,
    `${command} edit --model MODEL --prompt-file 'prompt.txt' --image 'reference.png' --out 'output-v2.png'`,
    "```", "",
    "--image 可重複提供；--quality 支援 auto、low、medium、high，兩個 2.5 模型另支援 xhigh、max。",
    "--size 可用 auto 或 WIDTHxHEIGHT；--background 可用 auto、opaque、transparent；--output-format 可用 png、jpeg、webp。",
    "list 回傳 apiMode=ark-task 時，使用已偵測到的 Ark 任務介面：size、quality 保持 auto，background 只能 auto 或 opaque。命令會省略不支援的欄位、以 JSON 傳送參考圖、查詢任務並下載結果；不要自行取得 API Key。",
    "--dry-run 只檢查參數，不送出圖片 API 請求。命令每次只生成一張圖，預設逾時 300 秒。",
    "已存在的輸出檔會被拒絕；換新檔名保留原圖。生成失敗或逾時時回報原因，不自動換模型重送，以免重複計費。",
    "成功後查看輸出圖片，確認符合需求，再以絕對路徑顯示圖片，並告知使用的模型及檔案位置。",
    "如果 Node 路徑已因桌面版更新失效，重新執行路由器 update 會刷新此技能。", "",
  ].join("\n");
}

// 此功能獨立提交／還原，不把技能寫檔失敗變成整個路由器安裝失敗。
export function installRelayImageSkill({ models, aliases = {}, apiMode, providerId = null, root = relaySkillRoot,
  settingsFile = settingsPath, backupRoot = backupsRoot, nodePath = nodeBin,
  sourcePath = scriptPath, platform = process.platform } = {}) {
  const allowed = new Set(RELAY_IMAGE_MODELS.map((model) => model.id));
  if (!Array.isArray(models) || !models.length || models.some((model) => !allowed.has(model))) {
    fail("中轉生圖只支援 Image 2、Sunburst、Flare，至少選擇一個。");
  }
  models = [...new Set(models)];
  const previous = relayConfig(root, settingsFile);
  apiMode = apiMode || previous?.apiMode || "images";
  if (!["images", "ark-task"].includes(apiMode)) fail("無效的生圖介面設定。");
  // 舊版技能沒有記錄供應商：那時只有一家，也就是 default。
  providerId = providerId || previous?.providerId || DEFAULT_PROVIDER_ID;
  if (!PROVIDER_ID_PATTERN.test(providerId)) fail("無效的生圖供應商設定。");
  for (const name of ["scripts", "agents", "config.json"]) {
    const path = join(root, name);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail(`技能路徑是符號連結，未修改：${path}`);
  }
  const files = {
    "SKILL.md": renderRelayImageSkill({ root, nodePath, models, platform }),
    "scripts/imagegen.mjs": loadImagegenSource(sourcePath),
    "agents/openai.yaml": [
      "interface:", '  display_name: "中轉 API 生圖"',
      '  short_description: "沿用路由器憑證生成或編輯圖片，從已啟用模型中依需求選擇"',
      '  default_prompt: "使用 $router-imagegen 依照我的需求生成圖片。"', "",
    ].join("\n"),
  };
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const hashes = {};
  const preserved = [];
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail(`技能檔案是符號連結，未修改：${path}`);
    if (previous && existsSync(path) && sha(readFileSync(path)) !== previous.hashes?.[name]) {
      preserved.push(name);
      hashes[name] = previous.hashes?.[name] || null;
    } else hashes[name] = sha(content);
  }
  const upstreamModels = Object.fromEntries(models.map((model) => {
    const upstream = aliases[model] || previous?.upstreamModels?.[model] || model;
    if (upstream !== model && !(typeof upstream === "string" && upstream.endsWith(`/${model}`) && !/[\s?#]/.test(upstream))) {
      fail(`無效的圖片模型對應：${model}`);
    }
    return [model, upstream];
  }));
  ensureDirectory(dirname(root));
  ensureDirectory(backupRoot);
  const backup = join(backupRoot, `imagegen-${timestamp()}`);
  const stage = mkdtempSync(join(dirname(root), ".router-imagegen-stage-"));
  let movedOld = false;
  try {
    if (previous) cpSync(root, stage, { recursive: true, dereference: false });
    for (const [name, content] of Object.entries(files)) {
      if (preserved.includes(name)) continue;
      ensureDirectory(dirname(join(stage, name)));
      writeFileSync(join(stage, name), content, { mode: 0o600 });
    }
    const config = { managedBy: RELAY_IMAGEGEN_OWNER, version: INSTALLER_VERSION,
      routerSettingsPath: settingsFile, models, upstreamModels, apiMode, providerId, hashes };
    writeJsonAtomic(join(stage, "config.json"), config);
    if (previous) {
      ensureDirectory(backup);
      renameSync(root, join(backup, "router-imagegen"));
      movedOld = true;
    }
    renameSync(stage, root);
    return { root, config, preserved, backup: movedOld ? backup : null };
  } catch (error) {
    if (movedOld && !existsSync(root)) renameSync(join(backup, "router-imagegen"), root);
    throw error;
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

export function archiveRelayImageSkill(destination, root = relaySkillRoot, settingsFile = settingsPath) {
  if (!relayConfig(root, settingsFile)) return false;
  ensureDirectory(destination);
  renameSync(root, join(destination, "router-imagegen"));
  return true;
}

export function resolveRelayImageAliases(models, availableModels) {
  return Object.fromEntries(models.map((model) => [model,
    availableModels.includes(model) ? model : availableModels.find((id) => id.endsWith(`/${model}`)) || model,
  ]));
}

export function detectRelayImageModels(availableModels) {
  const ids = Array.isArray(availableModels) ? availableModels.filter((id) => typeof id === "string" && !/[\s\x00-\x1f\x7f?#]/.test(id)) : [];
  const aliases = resolveRelayImageAliases(RELAY_IMAGE_MODELS.map((model) => model.id), ids);
  return RELAY_IMAGE_MODELS.filter((model) => ids.includes(aliases[model.id]))
    .map((model) => ({ ...model, upstreamModel: aliases[model.id] }));
}

export function normalizeRelayImagePrefix(value) {
  const prefix = String(value || "").trim();
  if (!prefix || /^none$/i.test(prefix)) return "";
  const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
  if (!/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)+$/.test(normalized)) {
    fail("模型前綴格式無效，請使用例如 ark/、api/，或 none 不加前綴。");
  }
  return normalized;
}

export function inferRelayImagePrefix(availableModels = [], routes = [], previousAliases = {}) {
  const prefixOf = (id) => typeof id === "string" && id.includes("/") ? id.slice(0, id.lastIndexOf("/") + 1) : "";
  const groups = [
    Object.values(previousAliases),
    detectRelayImageModels(availableModels).map((model) => model.upstreamModel),
    routes.map((route) => route.upstreamModel).filter((id) => typeof id === "string"),
    availableModels,
  ];
  for (const group of groups) {
    if (!group.length) continue;
    const prefixes = [...new Set(group.map(prefixOf))];
    if (prefixes.length !== 1) return "";
    try { return normalizeRelayImagePrefix(prefixes[0]); } catch { return ""; }
  }
  return "";
}

export function planRelayImageProbes(availableModels = [], prefix = "") {
  const normalized = normalizeRelayImagePrefix(prefix);
  const listed = new Map(detectRelayImageModels(availableModels).map((model) => [model.id, model.upstreamModel]));
  return RELAY_IMAGE_MODELS.map((model) => ({ ...model,
    upstreamModel: listed.get(model.id) || `${normalized}${model.id}`,
  }));
}

// /models 只輔助解析名稱。部分中轉不公開圖片模型，不能以清單判定不可用。
async function discoverRelayImageModelNames(apiRoot, apiKey) {
  let response;
  try {
    response = await fetch(`${String(apiRoot).replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      redirect: "manual", signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) fail(`模型清單查詢失敗（HTTP ${response.status}），可自行確認前綴後進行生圖測試。`);
    let payload;
    try { payload = await response.json(); } catch { fail("上游模型清單無法解析，將以實際生圖測試確認。"); }
    if (!Array.isArray(payload?.data) && !Array.isArray(payload?.models)) fail("上游未返回有效模型清單，將以實際生圖測試確認。");
    return parseModelList(payload);
  } catch (error) {
    if (response) throw error;
    fail("無法讀取中轉模型清單，可自行確認前綴後進行生圖測試。");
  }
}

async function configureRelayImagegen() {
  if (!readManifest() || !existsSync(settingsPath)) fail("請先安裝路由器，再添加中轉 API 生圖。");
  const current = relayConfig();
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const providers = installedProviders(settings, readManifest());
  if (providers.length === 0) fail("找不到中轉供應商設定，請先執行「安裝或重新配置」。");
  printHeading("中轉 API 生圖");
  console.log(`${providers.length > 1 ? "沿用已設定的中轉供應商與憑證" : "沿用現有中轉 Base URL 與憑證"}。偵測會實際生圖並依供應商計費；先測通用介面，全部未通過時自動改測 Ark 任務介面。`);
  console.log("先選擇要偵測的模型，只有勾選的項目會進行生圖測試；下列模型尚未驗證可用性。");
  RELAY_IMAGE_MODELS.forEach((model, index) => console.log(`  ${index + 1}. ${model.label} — ${model.description}`));
  const defaultTests = current?.models?.map((id) => RELAY_IMAGE_MODELS.findIndex((model) => model.id === id) + 1).filter(Boolean).join(",") || "3";
  const testAnswer = await ask("選擇要偵測的模型編號（逗號分隔或 all；none 停用；cancel 返回）", defaultTests);
  if (/^cancel$/i.test(testAnswer)) return;
  if (/^none$/i.test(testAnswer)) {
    const backup = disableRelayImagegen();
    if (!backup) { console.log("中轉 API 生圖尚未啟用。"); return; }
    console.log(`已停用，技能可從備份恢復：${backup}`);
    return;
  }
  const selected = selectRelayImageModels(testAnswer);
  // 舊版技能沒有記錄供應商：那時只有一家，也就是 default。
  const currentProviderId = current ? current.providerId ?? DEFAULT_PROVIDER_ID : null;
  const provider = providers.length === 1
    ? providers[0]
    : await chooseProvider(providers, settings.routes || [], "用哪一家供應商生圖", { preferredId: currentProviderId });
  await runRelayImagegenSetup({ provider, selected, current, settings, providers });
}

// 停用中轉生圖：把技能封存到備份目錄，可以原樣搬回來恢復。尚未啟用時回傳 null。
function disableRelayImagegen() {
  if (!relayConfig()) return null;
  const backup = join(backupsRoot, `imagegen-disabled-${timestamp()}`);
  archiveRelayImageSkill(backup);
  return backup;
}

// 偵測並啟用中轉生圖，終端選單與網頁共用：推斷名稱前綴、只對勾選的模型實際生圖
// （先通用介面，全部失敗才改 Ark 任務介面）、保存測試圖，再安裝技能。
// 沒有模型通過時不動既有技能，回傳 available 為空陣列。
async function runRelayImagegenSetup({ provider, selected, current, settings, providers }) {
  const currentProviderId = current ? current.providerId ?? DEFAULT_PROVIDER_ID : null;
  const apiKey = readApiKey(provider.keychainService);
  console.log("正在查詢模型名稱與前綴...");
  let names = [];
  try { names = await discoverRelayImageModelNames(provider.apiRoot, apiKey); }
  catch { /* 清單缺失時仍直接測試已選模型。 */ }
  const prefix = inferRelayImagePrefix(
    names,
    (settings.routes || []).filter((route) => routeProviderId(route) === provider.id),
    currentProviderId === provider.id ? current?.upstreamModels : undefined,
  );
  const candidates = planRelayImageProbes(names, prefix).filter((model) => selected.includes(model.id));
  console.log("將依序測試：");
  candidates.forEach((model) => console.log(`  ${model.label}：${model.upstreamModel}`));
  console.log(`每種介面最多測 ${candidates.length} 次，每個已選模型各一張；通用介面使用低品質，Ark 尺寸與品質由上游決定。`);
  // 用 data URL 載入同一份獨立命令，測試與正式生圖共用回應驗證。
  const { discoverUsableRelayImages } = await import(`data:text/javascript;base64,${Buffer.from(loadImagegenSource()).toString("base64")}`);
  const probeRoot = join(installRoot, "imagegen-probes", timestamp());
  const started = Date.now();
  const progress = setInterval(() => console.log(`  生圖偵測中，已等待 ${Math.floor((Date.now() - started) / 1000)} 秒...`), 25000);
  let discovery;
  try {
    discovery = await discoverUsableRelayImages({ candidates, apiRoot: provider.apiRoot, apiKey,
      onProbe: (mode, model, index) => console.log(`[${index + 1}/${candidates.length}] ${mode === "images" ? "通用" : "Ark"}：正在測試 ${model.upstreamModel}...`) });
  } finally { clearInterval(progress); }
  try {
    writeJsonAtomic(join(installRoot, "imagegen-last-check.json"), {
      version: INSTALLER_VERSION, checkedAt: new Date().toISOString(), checks: discovery.checks,
    });
  } catch { /* 診斷寫檔失敗不影響模型結果與技能安裝。 */ }
  const available = discovery.models;
  if (!available.length) { console.log("沒找到可用模型。"); return { available: [], discovery }; }
  for (const model of available) {
    ensureDirectory(probeRoot);
    const imagePath = join(probeRoot, `${model.id}.png`);
    writeFileSync(imagePath, model.bytes, { flag: "wx", mode: 0o600 });
    console.log(`  通過，已收到圖片：${imagePath}`);
  }
  console.log("以下已選模型通過生圖測試，將自動添加：");
  available.forEach((model, index) => console.log(`  ${index + 1}. ${model.label} — ${model.description}\n     ${model.upstreamModel}`));
  console.log("可複選：多個模型交由 AI 依需求選擇，使用者指定優先；只選一個就固定使用。");
  const models = available.map((model) => model.id);
  const aliases = Object.fromEntries(available.map((model) => [model.id, model.upstreamModel]));
  const result = installRelayImageSkill({ models, aliases, apiMode: discovery.apiMode, providerId: provider.id });
  console.log(`已啟用 $router-imagegen：${result.root}${providers.length > 1 ? `（供應商 ${provider.id}）` : ""}`);
  if (result.backup) console.log(`備份：${result.backup}`);
  if (result.preserved.length) console.log(`保留手動修改的檔案：${result.preserved.join(", ")}`);
  console.log("請建立新任務使用 $router-imagegen；若尚未出現，重新啟動 Codex。所選模型已通過本次生圖測試。");
  if (discovery.apiMode === "ark-task") console.log("Ark 生圖需要此版本的本機路由器；若只執行了 imagegen，請執行同一份安裝器的 update 更新路由器。");
  return { available, discovery, result, probeRoot };
}

export async function offerRelayImagegen({ existing = null, consent, configure, refresh } = {}) {
  if (existing) { await refresh(existing); return true; }
  if (!(await consent())) return false;
  await configure();
  return true;
}

function refreshRelayImagegen() {
  const existing = relayConfig();
  if (!existing) return;
  const result = installRelayImageSkill({ models: existing.models, aliases: existing.upstreamModels, apiMode: existing.apiMode,
    providerId: existing.providerId });
  console.log(`中轉生圖技能已更新${result.preserved.length ? `（保留手動檔案：${result.preserved.join(", ")}）` : ""}。`);
}

async function offerInstalledRelayImagegen() {
  try {
    await offerRelayImagegen({ existing: relayConfig(), refresh: configureRelayImagegen,
      consent: () => input.isTTY ? confirm("是否使用中轉 API 生圖？將新增獨立技能並沿用現有憑證，圖片按供應商計費", false) : false,
      configure: configureRelayImagegen });
  } catch (error) {
    console.error(`路由器已安裝，中轉生圖設定未完成：${error.message}。可稍後從選單第 ${menuNumber("imagegen")} 項設定。`);
  }
}

// 全域上下文（config.toml 的 model_context_window）會覆蓋所有模型自己的上下文。
// null 表示移除這個設定，讓各模型回到自己的上下文。
export function normalizeGlobalContextWindow(value) {
  if (value === undefined || value === null || value === "") return null;
  return parseTokenSetting(value, { label: "全域上下文", min: MIN_CONTEXT_WINDOW, max: MAX_CONTEXT_WINDOW });
}

// 經由 Codex 的設定 API 寫入，不直接改 config.toml；先備份，驗證不符就寫回原值。
async function setGlobalContextWindow(value, { label = "global-context" } = {}) {
  if (!codexBin) fail("未找到 Codex CLI。");
  const target = normalizeGlobalContextWindow(value);
  const userConfig = await readUserConfig();
  const previous = deepGet(userConfig.config, "model_context_window");
  const previousValue = previous.present ? previous.value : null;
  if (target === null ? !previous.present : previousValue === target) {
    return { changed: false, previous: previousValue, value: target, filePath: userConfig.filePath };
  }
  const backupDir = join(backupsRoot, `${label}-${timestamp()}`);
  ensureDirectory(backupDir);
  copyIfExists(userConfig.filePath, join(backupDir, "config.toml"));
  try {
    await writeConfigEdits([{ keyPath: "model_context_window", value: target }]);
    const verified = deepGet((await readUserConfig()).config, "model_context_window");
    if (target === null ? verified.present : verified.value !== target) fail("全域上下文配置驗證失敗。");
  } catch (error) {
    try {
      await writeConfigEdits([{ keyPath: "model_context_window", value: previousValue }]);
    } catch (restoreError) {
      console.error(`配置還原失敗：${restoreError.message}；備份：${backupDir}`);
    }
    throw error;
  }
  return { changed: true, previous: previousValue, value: target, filePath: userConfig.filePath, backupDir };
}

export async function configureMillionTokenContext() {
  const result = await setGlobalContextWindow(1000000, { label: "context-1m" });
  if (!result.changed) {
    console.log("全域上下文已是 1,000,000 tokens，無需修改。");
    return;
  }
  console.log(`全域 model_context_window 已設為 1000000。備份：${result.backupDir}`);
  console.log(`請完全退出並重新打開 ${desktopAppName}，再建立新任務。`);
}

async function status() {
  const manifest = readManifest();
  if (!manifest) {
    console.log("當前 CODEX_HOME 尚未安裝 Codex 模型路由器。" );
    process.exitCode = 1;
    return;
  }
  printHeading("Codex 模型路由器狀態");
  const settings = readSettingsIfExists();
  const providers = installedProviders(settings, manifest);
  const routes = Array.isArray(settings.routes) ? settings.routes : (manifest.routes || []);
  if (providers.length <= 1) {
    console.log(`API 根地址：${providers[0]?.apiRoot || "未知"}`);
  } else {
    console.log("供應商：");
    providers.forEach((provider, index) => {
      const count = routes.filter((route) => routeProviderId(route) === provider.id).length;
      console.log(`  ${index + 1}. ${provider.id}${index === 0 ? "（主要）" : ""}：${provider.apiRoot}，${count} 個模型`);
    });
  }
  console.log(`路由器：http://127.0.0.1:${manifest.port}`);
  const shortcut = managerShortcutPath();
  console.log(`網頁管理介面：${existsSync(shortcut) ? `雙擊「${shortcut}」，或` : ""}選單第 ${menuNumber("ui")} 項`);
  const cliRoutes = routes.filter((route) => route.transport === "claude-cli");
  if (cliRoutes.length) console.log(`Claude CLI（實驗性）：${cliRoutes.map((route) => route.displayName).join("、")}；登入狀態請執行 claude-cli status。`);
  console.log(
    `背景服務：${manifest.serviceName || manifest.launchLabel}（${serviceKindLabel}）`,
  );
  if (isWindows) {
    const query = shell(
      "schtasks.exe",
      ["/Query", "/TN", manifest.serviceName || taskName, "/FO", "LIST"],
      { allowFailure: true },
    );
    const state = /^[^\S\n]*(?:Status|狀態|狀態)[^\S\n]*[:：][^\S\n]*(.+)$/im.exec(
      query.stdout || "",
    );
    console.log(
      `排程工作：${query.status === 0 ? state?.[1]?.trim() || "已註冊" : "未註冊"}`,
    );
  }
  console.log(`Codex 供應商：${manifest.providerId || "openai"}`);
  // Codex 升級後自帶的 Node/CLI 可能換到新的版本目錄，舊路徑會靜默失效。
  for (const [label, path] of [
    ["Node", manifest.nodeBin],
    ["Codex", manifest.codexBin],
  ]) {
    if (!path) continue;
    const missing = existsSync(path) ? "" : "（檔案已不存在，請重新執行安裝器）";
    console.log(`${label}：${path}${missing}`);
  }
  try {
    const health = await waitForHealth(manifest.port);
    console.log(`健康狀態：${health.status === "ok" ? "正常" : health.status}`);
    console.log(`請求數：${health.stats?.requests ?? 0}`);
    console.log(`官方模型路由數：${health.stats?.official ?? 0}`);
    console.log(`自訂模型路由數：${health.stats?.custom ?? 0}`);
    console.log(`失敗數：${health.stats?.failures ?? 0}`);
  } catch (error) {
    console.log(`健康狀態：不可用（${error.message}）`);
  }
  console.log("模型：");
  if (routes.length === 0) console.log("  （目前沒有自訂模型，官方模型仍可使用）");
  for (const route of routes) {
    console.log(`  - ${route.displayName} -> ${route.upstreamModel}`);
  }
  try {
    const imagegen = relayConfig();
    const imagegenProvider = imagegen && providers.length > 1 ? `（供應商 ${imagegen.providerId ?? DEFAULT_PROVIDER_ID}）` : "";
    console.log(`中轉 API 生圖：${imagegen ? imagegen.models.join(", ") + imagegenProvider : `未啟用（可從選單第 ${menuNumber("imagegen")} 項添加）`}`);
  } catch (error) { console.log(`中轉 API 生圖：${error.message}`); }
}

async function rollback() {
  const manifest = readManifest();
  if (!manifest) {
    console.log("沒有可回退的安裝。" );
    return;
  }
  printHeading("回退 Codex 模型路由器");
  // 安裝目錄稍後會整個封存，要刪的 Key 得先讀出來。
  const providers = installedProviders(readSettingsIfExists(), manifest);
  console.log("只會還原由安裝器管理的 Codex 配置項。" );
  console.log(`完整配置備份：${manifest.configBackup}`);
  if (!(await confirm("是否繼續？", true))) return;

  const edits = rollbackEdits(manifest.previousConfig);
  if (manifest.managerFileHandler) {
    const user = await readUserConfig();
    const entryEdit = managerHandlerRollbackEdit(user.config, manifest.managerFileHandler);
    if (entryEdit) edits.push(entryEdit);
    else console.log("自訂模型管理的開啟方式已被修改，保留目前的設定。");
  }
  if (manifest.managerMcpEntry) {
    const user = await readUserConfig();
    const entryEdit = managerMcpRollbackEdit(user.config, manifest.managerMcpEntry);
    if (entryEdit) edits.push(entryEdit);
    else console.log("自訂模型管理的 MCP 入口已被修改，保留目前的設定。");
  }
  await writeConfigEdits(edits);
  stopService();
  removeServiceRegistration();

  const archiveDir = join(backupsRoot, `rollback-${timestamp()}`);
  ensureDirectory(archiveDir);
  try { archiveRelayImageSkill(archiveDir); } catch (error) {
    console.error(`中轉生圖技能未移動：${error.message}`);
  }
  archiveManagerShortcut(archiveDir);
  for (const path of serviceArchivePaths()) {
    if (path.startsWith(installRoot)) continue;
    if (existsSync(path)) renameSync(path, join(archiveDir, basename(path)));
  }
  if (existsSync(installRoot)) renameSync(installRoot, join(archiveDir, "model-router"));

  const removeKey = await confirm(
    `是否從${secretStoreLabel}中刪除${providers.length > 1 ? `全部 ${providers.length} 家` : ""}自訂供應商的 API Key？`,
    true,
  );
  if (removeKey) {
    for (const provider of providers) {
      deleteApiKey(provider.keychainService, provider.keychainAccount || "codex");
    }
  }

  printHeading("回退完成");
  console.log(`安裝檔案已封存至：${archiveDir}`);
  console.log(`請完全退出並重新打開 ${desktopAppName}，然後建立一個新任務。`);
}

// --- 網頁管理介面 -------------------------------------------------------------
//
// ui 命令在本機開一個臨時網頁，背後呼叫的是與終端選單相同的函式：備份、寫入、重啟、
// 健康檢查與 Codex 模型清單驗證，失敗一律還原。一般啟動會交給獨立背景程序，
// 從頁面結束或閒置太久就結束；--foreground 可保留終端診斷，路由器本身不提供任何網頁。

const MANAGER_REPO_URL = "https://github.com/funkeyyou/codex-model-router";
const MANAGER_RELEASES_PAGE = `${MANAGER_REPO_URL}/releases`;
const releaseDownloadBase = (env.CODEX_MODEL_ROUTER_RELEASE_DOWNLOAD_URL || `${MANAGER_RELEASES_PAGE}/download`)
  .replace(/\/+$/, "");
const MANAGER_IDLE_MS = 20 * 60 * 1000;
const MANAGER_DRAFT_TTL_MS = 30 * 60 * 1000;
const MANAGER_SHORTCUT_NAME = "Codex 模型路由器";
const managerInstallerName = isWindows ? "codex-model-router.ps1" : "codex-model-router.sh";
const managerInstallerPath = join(installRoot, managerInstallerName);
const managerLockPath = join(installRoot, "manager.json");
const managerHandoffPath = join(installRoot, "manager-handoff.json");
const MANAGER_HANDLER_KEY = "desktop.custom_file_handlers.model_router_manager";
const MANAGER_MCP_KEY = "mcp_servers.model_router_manager";
const managerMcpPath = join(installRoot, "manager-entry.mjs");
const managerLauncherPath = join(installRoot, isWindows ? "manager-open.js" : "manager-open.sh");
const managerIconPath = join(installRoot, "manager-icon.svg");
const MANAGER_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#111d35"/><path d="M14 22h14l10 20h12M14 42h14l10-20h12m-6-6 6 6-6 6m0 8 6 6-6 6" fill="none" stroke="#63b5fa" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>\n';
// 記錄檔裡跟故障有關的前綴；ready、log-truncated 之類的例行訊息不顯示。
const MANAGER_LOG_KINDS = new Set([
  "error", "websocket-error", "catalog-refresh-failed", "request-too-large", "upstream-ws-cooldown", "auth-probe-grace",
]);

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export function managerShortcutPath(platform = process.platform, {
  home = homeDir, appData = env.APPDATA, directory = env.CODEX_MODEL_ROUTER_SHORTCUT_DIR,
} = {}) {
  const windows = platform === "win32";
  const file = `${MANAGER_SHORTCUT_NAME}${windows ? ".lnk" : ".command"}`;
  if (directory) return (windows ? win32 : posix).join(directory, file);
  if (windows) {
    return win32.join(appData || win32.join(home, "AppData", "Roaming"),
      "Microsoft", "Windows", "Start Menu", "Programs", file);
  }
  return posix.join(home, "Applications", file);
}

// 不是預設位置的 CODEX_HOME／安裝目錄要寫進捷徑，否則雙擊時會找不到這份安裝。
function managerLaunchEnv() {
  const values = {};
  if (env.CODEX_HOME) values.CODEX_HOME = codexHome;
  if (env.CODEX_MODEL_ROUTER_HOME) values.CODEX_MODEL_ROUTER_HOME = installRoot;
  return values;
}

export function managerCommandFile({ installer, launchEnv = {} }) {
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  return [
    "#!/bin/bash",
    "# Codex 模型路由器：雙擊開啟網頁管理介面。由安裝器產生，刪除不影響路由器運作。",
    ...Object.entries(launchEnv).map(([name, value]) => `export ${name}=${quote(value)}`),
    `exec /bin/bash ${quote(installer)} ui`,
    "",
  ].join("\n");
}

// GUI 子系統的 wscript 啟動短期 PowerShell bootstrap，兩者都不顯示主控台。
// ui 完成背景交接後即返回；檔案輸入參數刻意忽略，開管理頁不會把來源檔案當成命令。
export function windowsManagerLauncher({ installer, launchEnv = {} }) {
  const literal = value => JSON.stringify(String(value)).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  return [
    'var shell = new ActiveXObject("WScript.Shell");',
    'var processEnv = shell.Environment("PROCESS");',
    ...Object.entries(launchEnv).map(([name, value]) => `processEnv.Item(${literal(name)}) = ${literal(value)};`),
    'var powershell = shell.ExpandEnvironmentStrings("%SystemRoot%\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe");',
    `var command = '"' + powershell + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + ${literal(`"${installer}" ui`)};`,
    "var result = shell.Run(command, 0, true);",
    "WScript.Quit(result);",
    "",
  ].join("\r\n");
}

export function windowsShortcutScript({ shortcut, launcher, workingDirectory }) {
  const argumentsText = `//nologo //B //E:jscript "${launcher}"`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `$path = ${psQuote(shortcut)}`,
    "$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path)",
    // WSH 的 Save 在部分英文 Windows 上無法處理中文檔名。先寫 ASCII 名稱，再以
    // PowerShell 的 Unicode 檔案操作移到真正的捷徑名稱，失敗不留下臨時捷徑。
    "$temporary = Join-Path (Split-Path -Parent $path) ('codex-model-router-' + [Guid]::NewGuid().ToString('N') + '.lnk')",
    "try {",
    "$shell = New-Object -ComObject WScript.Shell",
    "$link = $shell.CreateShortcut($temporary)",
    "$link.TargetPath = Join-Path $env:SystemRoot 'System32\\wscript.exe'",
    `$link.Arguments = ${psQuote(argumentsText)}`,
    `$link.WorkingDirectory = ${psQuote(workingDirectory)}`,
    `$link.Description = ${psQuote("開啟 Codex 模型路由器的網頁管理介面")}`,
    "$link.Save()",
    "Move-Item -LiteralPath $temporary -Destination $path -Force",
    "} finally {",
    "if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }",
    "}",
  ].join("\n");
}

// 安裝與更新成功後放一份安裝器到路由器目錄，並建立雙擊即可開啟管理頁的捷徑。
// 失敗只提醒，不影響路由器本身。測試模式沒指定捷徑目錄時不碰使用者的應用程式資料夾。
async function installManagerLauncher() {
  try {
    if (scriptPath && existsSync(scriptPath) && resolve(scriptPath) !== resolve(managerInstallerPath)) {
      // 先寫暫存檔再改名：正在執行舊副本的 bash 握著舊檔，不會讀到寫到一半的內容。
      const temporary = `${managerInstallerPath}.tmp-${process.pid}`;
      copyFileSync(scriptPath, temporary);
      chmodSync(temporary, 0o700);
      renameSync(temporary, managerInstallerPath);
    }
  } catch (error) {
    return { ok: false, message: `無法放置網頁管理介面用的安裝器副本（${error.message}）` };
  }
  const launchEnv = managerLaunchEnv();
  try {
    writeFileSync(managerLauncherPath, isWindows
      ? utf16leWithBom(windowsManagerLauncher({ installer: managerInstallerPath, launchEnv }))
      : managerCommandFile({ installer: managerInstallerPath, launchEnv }), { mode: isWindows ? 0o600 : 0o700 });
    chmodSync(managerLauncherPath, isWindows ? 0o600 : 0o700);
    writeFileSync(managerIconPath, MANAGER_ICON, { mode: 0o600 });
    writeFileSync(managerMcpPath, loadManagerEntrySource() + "\nawait serveManagerEntry(" + JSON.stringify({
      version: INSTALLER_VERSION, installer: managerInstallerPath,
      launchEnv: { CODEX_HOME: codexHome, CODEX_MODEL_ROUTER_HOME: installRoot },
    }) + ");\n", { mode: 0o600 });
  } catch (error) {
    return { ok: false, message: `無法建立管理頁啟動器（${error.message}）` };
  }
  const desktop = testMode && env.CODEX_MODEL_ROUTER_TEST_MANAGER_ENTRY !== "1" ? null : await installManagerMcpEntry();
  if (testMode && !env.CODEX_MODEL_ROUTER_SHORTCUT_DIR) return { ok: true, shortcut: null, desktop };
  const shortcut = managerShortcutPath();
  try {
    if (isWindows) {
      powershell(windowsShortcutScript({ shortcut, launcher: managerLauncherPath, workingDirectory: installRoot }));
    } else {
      mkdirSync(dirname(shortcut), { recursive: true });
      writeFileSync(shortcut, managerCommandFile({ installer: managerInstallerPath, launchEnv }), { mode: 0o755 });
      chmodSync(shortcut, 0o755);
    }
    return { ok: true, shortcut, desktop };
  } catch (error) {
    return { ok: false, desktop, message: `無法建立網頁管理介面的捷徑（${error.message}）` };
  }
}

function printManagerLauncher(result) {
  if (result.ok && result.shortcut) console.log(`網頁管理介面：雙擊「${result.shortcut}」開啟。`);
  else if (result.ok) console.log(`網頁管理介面：執行 ${managerInstallerName} ui 開啟。`);
  else console.log(`注意：${result.message}；仍可執行安裝器的 ui 命令開啟網頁管理介面。`);
  if (result.desktop?.ok) console.log("Codex 介面入口：重新開啟 Codex 後，點擊介面中的「自訂模型管理」（依版本顯示在頂部或側邊欄）。");
  else if (result.desktop) console.log(`Codex 介面入口未加入：${result.desktop.message}`);
}

export function managerMcpConfig({ node = nodeBin || process.execPath, entry = managerMcpPath, revision = null } = {}) {
  return { command: node, args: [entry, ...(revision ? ["--revision", revision] : [])], startup_timeout_sec: 10 };
}

const sameHandler = (left, right) => isDeepStrictEqual(left ?? null, right ?? null);

// 只撤回仍由本工具管理的這一個項目，不碰使用者後來修改的啟動器或偏好的編輯器。
export function managerHandlerRollbackEdit(config, record) {
  if (!record?.installed || !sameHandler(deepGet(config, MANAGER_HANDLER_KEY).value, record.installed)) return null;
  return { keyPath: MANAGER_HANDLER_KEY, value: record.previous ?? null };
}

export function managerMcpRollbackEdit(config, record) {
  if (!record?.installed || !sameHandler(deepGet(config, MANAGER_MCP_KEY).value, record.installed)) return null;
  return { keyPath: MANAGER_MCP_KEY, value: record.previous ?? null };
}

async function installManagerMcpEntry() {
  try {
    const user = await readUserConfig();
    const manifest = readManifest();
    if (!manifest) fail("請先安裝 Codex 模型路由器。");
    // 入口程式改變時，MCP 設定的識別也改變，客戶端不能繼續使用先前的連線快取。
    const revision = createHash("sha256").update(loadManagerEntrySource()).digest("hex").slice(0, 12);
    const installed = managerMcpConfig({ revision });
    const current = deepGet(user.config, MANAGER_MCP_KEY).value;
    const previous = manifest.managerMcpEntry;
    if (current != null && !sameHandler(current, previous?.installed)) {
      return { ok: false, message: "model_router_manager 名稱已有其他 MCP 設定，已保留原設定。" };
    }
    const legacyEdit = managerHandlerRollbackEdit(user.config, manifest.managerFileHandler);
    if (sameHandler(current, installed) && previous && !legacyEdit) return { ok: true };
    configBackup(user.filePath);
    // 先記錄恢復資料，途中中斷時仍能用 rollback 還原這一個設定項。
    const updatedManifest = { ...manifest, managerMcpEntry: { key: MANAGER_MCP_KEY, installed,
      previous: previous ? previous.previous : current } };
    writeJsonAtomic(manifestPath, updatedManifest);
    await writeConfigEdits([{ keyPath: MANAGER_MCP_KEY, value: installed }, ...(legacyEdit ? [legacyEdit] : [])]);
    const verified = await readUserConfig();
    if (!sameHandler(deepGet(verified.config, MANAGER_MCP_KEY).value, installed)) fail("Codex MCP 入口未成功寫入。");
    if (legacyEdit) {
      delete updatedManifest.managerFileHandler;
      writeJsonAtomic(manifestPath, updatedManifest);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

async function setupManagerEntry() {
  if (!readManifest()) fail("請先安裝 Codex 模型路由器。");
  const result = await installManagerLauncher();
  printManagerLauncher(result);
  if (!result.ok || result.desktop?.ok === false) fail("管理頁入口未完整安裝，請依上方訊息處理。");
}

function archiveManagerShortcut(archiveDir) {
  const shortcut = managerShortcutPath();
  if (!existsSync(shortcut)) return;
  const target = join(archiveDir, basename(shortcut));
  try {
    renameSync(shortcut, target);
  } catch {
    try {
      copyFileSync(shortcut, target);
      rmSync(shortcut, { force: true });
    } catch (error) {
      console.error(`網頁管理介面的捷徑未移除：${error.message}`);
    }
  }
}

function managerUrl(port, token) {
  return `http://127.0.0.1:${port}/#t=${encodeURIComponent(token)}`;
}

function readManagerLock() {
  try {
    return JSON.parse(readFileSync(managerLockPath, "utf8"));
  } catch {
    return null;
  }
}

function removeManagerLock(token) {
  if (readManagerLock()?.token === token) rmSync(managerLockPath, { force: true });
}

async function managerAlive(lock) {
  if (!Number.isInteger(lock?.port) || typeof lock?.token !== "string") return false;
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${lock.port}/api/ping`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-router-manager-token": lock.token },
      body: "{}",
    }, 1500);
    return response.ok;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  try {
    const child = isWindows
      ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true })
      : spawn("/usr/bin/open", [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// 非同步版的 shell()：等待外部程式期間管理頁仍要能回應網頁的輪詢。
function commandOutput(command, args, { timeoutMs = 30000, environment = env } = {}) {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(command, args, { env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolvePromise({ status: null, stdout, stderr: error.message });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ status: null, stdout, stderr: error.message });
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    });
  });
}

// --- 重新啟動桌面版（僅 macOS）-------------------------------------------------

// Codex 執行檔在桌面版的 App bundle 裡（可能還包了一層 CodexCLI.app），取最外層的那個。
export function desktopAppBundle(binaryPath) {
  if (typeof binaryPath !== "string") return null;
  const index = binaryPath.indexOf(".app/");
  return index < 0 ? null : binaryPath.slice(0, index + 4);
}

let cachedDesktopApp;
function desktopApp() {
  if (cachedDesktopApp !== undefined) return cachedDesktopApp;
  cachedDesktopApp = null;
  // Windows 的桌面版是 MSIX 應用程式，無法安全地從外部結束再開啟，改請使用者手動重開。
  if (process.platform !== "darwin") return cachedDesktopApp;
  // 測試時絕不能碰到真的桌面版，只認明確指定的測試用 App。
  const override = env.CODEX_MODEL_ROUTER_DESKTOP_APP;
  if (testMode && !override) return cachedDesktopApp;
  const candidates = override
    ? [override]
    : [desktopAppBundle(readManifest()?.codexBin), desktopAppBundle(codexBin), "/Applications/ChatGPT.app"];
  for (const app of new Set(candidates.filter(Boolean))) {
    const plist = join(app, "Contents", "Info.plist");
    if (!existsSync(plist)) continue;
    const result = shell("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", plist], { allowFailure: true });
    const bundleId = (result.stdout || "").trim();
    if (result.status === 0 && /^[A-Za-z0-9.-]{3,200}$/.test(bundleId)) {
      cachedDesktopApp = { path: app, bundleId, name: basename(app, ".app") };
      break;
    }
  }
  return cachedDesktopApp;
}

// 跨桌面版生命週期的工作由獨立程序執行。macOS 交給 launchd，避免退出 ChatGPT 時
// 一起殺掉由 Codex 啟動的工具程序；啟動資料只放在權限 600 的短期檔案，不放入命令列。
async function startManagerBackgroundTask(spec) {
  const id = randomUUID();
  const workerPath = join(installRoot, `manager-worker-${id}.mjs`);
  const specPath = join(installRoot, `manager-worker-${id}.json`);
  const statusPath = join(installRoot, `manager-worker-${id}.status.json`);
  const workerLogPath = join(installRoot, "manager-worker.log");
  const launchLabel = process.platform === "darwin" && !testMode
    ? `com.openai.codex.model-router.worker.${installHash}.${id}` : null;
  writeFileSync(workerPath, loadManagerSource() + "\nawait runBackgroundTask(process.argv[2]);\n", { mode: 0o600 });
  writeJsonAtomic(specPath, { ...spec, workerPath, statusPath, launchLabel });
  if (existsSync(workerLogPath) && statSync(workerLogPath).size > 5 * 1024 * 1024) writeFileSync(workerLogPath, "", { mode: 0o600 });
  const logFd = openSync(workerLogPath, "a", 0o600);
  try {
    if (launchLabel) {
      const started = await commandOutput("/bin/launchctl", ["submit", "-l", launchLabel,
        "-o", workerLogPath, "-e", workerLogPath, "--", process.execPath, workerPath, specPath]);
      if (started.status !== 0) fail(`無法啟動獨立管理程序（${terminalSafeText(started.stderr, 200) || "未知錯誤"}）。`);
    } else {
      const child = spawn(process.execPath, [workerPath, specPath], { detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true });
      await new Promise((resolvePromise, rejectPromise) => { child.once("spawn", resolvePromise); child.once("error", rejectPromise); });
      child.unref();
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const state = readManagerWorkerStatus(statusPath);
      if (state?.status === "failed") fail(state.error);
      if (state) return { statusPath, logPath: workerLogPath };
      await delay(100);
    }
    fail(`獨立管理程序沒有啟動，請查看 ${workerLogPath}。`);
  } catch (error) {
    if (launchLabel) await commandOutput("/bin/launchctl", ["remove", launchLabel], { timeoutMs: 5000 });
    for (const file of [workerPath, specPath, statusPath]) rmSync(file, { force: true });
    throw error;
  } finally {
    closeSync(logFd);
  }
}

function readManagerWorkerStatus(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

async function restartDesktopApp() {
  const app = desktopApp();
  if (!app) fail(`找不到可重新啟動的桌面版應用程式，請手動完全退出並重新打開 ${desktopAppName}。`);
  const worker = await startManagerBackgroundTask({ kind: "desktop", app });
  const deadline = Date.now() + 150000;
  let messageCount = 0;
  while (Date.now() < deadline) {
    const state = readManagerWorkerStatus(worker.statusPath);
    const messages = state?.messages || [];
    for (const message of messages.slice(messageCount)) console.log(message);
    messageCount = messages.length;
    if (state?.status === "failed") { rmSync(worker.statusPath, { force: true }); fail(state.error); }
    if (state?.status === "succeeded") { rmSync(worker.statusPath, { force: true }); return state.result; }
    await delay(200);
  }
  fail(`桌面版重啟仍未完成，請查看 ${worker.logPath}。`);
}

// 更新後重啟桌面版失敗不該讓整個更新被標成失敗：路由器已經是新版了。
async function restartDesktopAfter(result) {
  try {
    await restartDesktopApp();
    return { ...result, desktopRestarted: true, restartDesktop: false };
  } catch (error) {
    console.error(error.message);
    return { ...result, desktopError: error.message };
  }
}

// --- 一鍵更新 -------------------------------------------------------------------

export function parseSha256Sums(text) {
  const sums = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$/.exec(line);
    if (match) sums[match[2]] = match[1].toLowerCase();
  }
  return sums;
}

// 雜湊之外再看內容：格式、版本號與必要的內嵌段落。標記名稱拼接而成，
// 免得這段原始碼自己被當成標記行。
export function verifyInstallerScript(content, version, platform = process.platform) {
  const text = Buffer.from(content).toString("utf8");
  const windows = platform === "win32";
  if (windows ? !text.startsWith("\uFEFF") : !text.startsWith("#!/bin/bash\n")) {
    fail("下載的檔案不是預期的安裝器格式，已停止更新。");
  }
  const normalized = text.replaceAll("\r\n", "\n");
  if (!normalized.includes(`\nconst INSTALLER_VERSION = "${version}";\n`)) {
    fail(`下載的安裝器不是 ${version} 版，已停止更新。`);
  }
  for (const name of ["INSTALLER_JS", "ROUTER_JS", "EMBEDDED"]) {
    if (!normalized.includes(`\n__CODEX_MODEL_ROUTER_${name}__\n`)) fail("下載的安裝器不完整，已停止更新。");
  }
}

async function downloadReleaseAsset(version, name, limit) {
  const url = `${releaseDownloadBase}/v${version}/${name}`;
  const response = await fetchWithTimeout(url, {
    headers: { "user-agent": `codex-model-router/${INSTALLER_VERSION}` },
  }, 60000);
  if (!response.ok) {
    fail(response.status === 404
      ? `GitHub 上還沒有 v${version} 的發佈檔案（可能仍在建立中），請稍後再試。`
      : `下載 ${name} 失敗（HTTP ${response.status}）。`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) fail(`${name} 超過大小限制，已停止更新。`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// 由新版安裝器自己執行 update：換掉路由器程式碼、重啟服務、更新安裝器副本與捷徑。
function runDownloadedUpdate(path) {
  const childEnv = { ...env };
  for (const name of ["CODEX_MODEL_ROUTER_SCRIPT_PATH", "CODEX_MODEL_ROUTER_UI_TOKEN", "CODEX_MODEL_ROUTER_UI_NO_OPEN"]) {
    delete childEnv[name];
  }
  const [command, args] = isWindows
    ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path, "update"]]
    : ["/bin/bash", [path, "update"]];
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise(code));
  });
}

async function managerUpdate({ restartDesktop = false } = {}) {
  const catalog = await loadReleaseCatalog({ force: true });
  const latest = catalog.latest;
  const installed = readManifest()?.version || null;
  if (compareVersions(latest, installed) !== 1) fail(`已是最新版本（${installed || INSTALLER_VERSION}）。`);
  console.log(`正在從 GitHub 下載 v${latest} 的安裝器與 SHA256SUMS…`);
  const sums = parseSha256Sums((await downloadReleaseAsset(latest, "SHA256SUMS", 64 * 1024)).toString("utf8"));
  const expected = sums[managerInstallerName];
  if (!expected) fail("SHA256SUMS 裡沒有安裝器的雜湊，已停止更新。");
  const content = await downloadReleaseAsset(latest, managerInstallerName, 16 * 1024 * 1024);
  if (createHash("sha256").update(content).digest("hex") !== expected) {
    fail("下載的安裝器與 SHA256SUMS 不符，已停止更新。");
  }
  verifyInstallerScript(content, latest);
  console.log("雜湊與版本核對通過，開始更新。\n");
  const directory = mkdtempSync(join(tmpdir(), "codex-model-router-update-"));
  try {
    const target = join(directory, managerInstallerName);
    writeFileSync(target, content, { mode: 0o700 });
    // 新版安裝器在另一個行程裡也會呼叫 Codex；更新期間本行程不另外啟動 Codex。
    const code = await withCodexLock(() => runDownloadedUpdate(target));
    if (code !== 0) fail(`更新沒有完成（結束代碼 ${code}），已保留或還原原本的版本。`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const result = { version: latest, managerRestart: existsSync(managerInstallerPath), restartDesktop: true };
  // 先由新版管理程序接手，再重啟桌面版；不能在此關掉承載舊程序的 ChatGPT。
  if (restartDesktop) {
    if (!result.managerRestart) fail("路由器已更新，但找不到管理頁安裝器副本，請手動重新開啟桌面版。");
    result.desktopRestartRequested = true;
  }
  return result;
}

// 這個管理頁本身就是較新的安裝器（例如剛下載還沒執行 update）：直接在本行程執行 update。
async function managerApplyLocalUpdate({ restartDesktop = false } = {}) {
  const installed = readManifest()?.version || null;
  if (compareVersions(INSTALLER_VERSION, installed) !== 1) fail("這個管理頁沒有比已安裝的版本新，不需要套用。");
  await update();
  return { version: INSTALLER_VERSION, managerRestart: true, restartDesktop: true,
    ...(restartDesktop ? { desktopRestartRequested: true } : {}) };
}

// --- 網頁管理介面的讀取與操作 -----------------------------------------------------

let managerConfigHintsPromise = null;
let managerConfigHintsAt = 0;

// config.toml 裡會影響模型頁顯示的兩個值：全域預設模型與全域上下文。讀它要開一個
// Codex app-server，因此在背景讀、快取一分鐘。
function managerConfigHints(force = false) {
  if (!codexBin) return Promise.resolve(null);
  if (!managerConfigHintsPromise || force || Date.now() - managerConfigHintsAt > 60000) {
    managerConfigHintsAt = Date.now();
    managerConfigHintsPromise = readUserConfig().then(({ config }) => {
      const contextWindow = Number(config.model_context_window);
      return {
        model: typeof config.model === "string" ? config.model : null,
        modelContextWindow: config.model_context_window != null && Number.isFinite(contextWindow) ? contextWindow : null,
      };
    }).catch(() => null);
  }
  return managerConfigHintsPromise;
}

async function routerHealth(port) {
  if (!Number.isInteger(port) || port <= 0) return { ok: false, error: "沒有可用的連接埠設定" };
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/healthz`, {}, 1500);
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const health = await response.json();
    return {
      ok: health.status === "ok", status: health.status ?? null, version: health.version ?? null,
      uptimeSeconds: health.uptimeSeconds ?? null, stats: health.stats || {},
    };
  } catch (error) {
    return { ok: false, error: error?.name === "AbortError" ? "逾時" : (error?.cause?.code || error?.message || "無法連線") };
  }
}

function routeTransport(route) {
  if (route.transport === "claude-cli") return "claude-cli";
  if (route.translate === "anthropic") return "anthropic";
  if (route.translate === "chat") return "chat";
  return "responses";
}

function summarizeRoute(route) {
  return {
    slug: route.pickerSlug, displayName: route.displayName || route.upstreamModel,
    upstreamModel: route.upstreamModel, efforts: Array.isArray(route.efforts) ? route.efforts : [],
  };
}

function managerWriteGuard() {
  const manifest = readManifest();
  if (!manifest) return "尚未安裝路由器，請先在終端執行「安裝或重新配置」。";
  const comparison = compareVersions(INSTALLER_VERSION, manifest.version);
  if (comparison != null && comparison < 0) {
    return `路由器已是 ${manifest.version}，這個管理頁仍是 ${INSTALLER_VERSION}；請關閉管理頁後重新開啟。`;
  }
  if (comparison != null && comparison > 0) {
    return `這個管理頁是 ${INSTALLER_VERSION}，路由器仍是 ${manifest.version}；請先從左上角的版本選單套用新版本。`;
  }
  if (!codexBin) return `未找到 Codex CLI，請先安裝 ${desktopAppName} 或 Codex CLI。`;
  return null;
}

function assertManagerWritable() {
  const blocked = managerWriteGuard();
  if (blocked) fail(blocked);
}

async function managerState() {
  const manifest = readManifest();
  if (!manifest) return { installed: false, versions: { manager: INSTALLER_VERSION } };
  const settings = readSettingsIfExists();
  const catalog = readCatalogIfExists();
  const providers = installedProviders(settings, manifest);
  const routes = Array.isArray(settings.routes) ? settings.routes : (Array.isArray(manifest.routes) ? manifest.routes : []);
  const catalogModels = Array.isArray(catalog?.models) ? catalog.models : [];
  const position = new Map(catalogModels.map((model, index) => [model.slug, index]));
  const entries = new Map(catalogModels.map((model) => [model.slug, model]));
  const port = Number(settings.port ?? manifest.port);
  const [health, hints] = await Promise.all([
    routerHealth(port),
    Promise.race([managerConfigHints(), delay(2500).then(() => undefined)]),
  ]);
  const models = routes.map((route) => {
    const entry = entries.get(route.pickerSlug);
    const context = positiveNumber(Number(entry?.context_window ?? route.contextWindow));
    const outputConfigurable = routeUsesOutputSetting(route);
    const outputCap = outputConfigurable ? positiveNumber(route.maxOutputTokens) : null;
    return {
      slug: route.pickerSlug,
      displayName: entry?.display_name || route.displayName || route.upstreamModel,
      upstreamModel: route.upstreamModel,
      providerId: routeProviderId(route),
      transport: routeTransport(route),
      efforts: Array.isArray(route.efforts) ? route.efforts : [],
      defaultEffort: entry?.default_reasoning_level || null,
      contextWindow: context,
      // configured：探測、新增時的預設值或手動修改；template：沿用官方模型模板，未實測。
      contextSource: positiveNumber(route.contextWindow) ? "configured" : context ? "template" : null,
      // 只有 Claude 路由會送出輸出上限；其他介面為 null，由上游決定。
      outputConfigurable,
      outputTokens: routeOutputLimit(route),
      outputCap,
      // API 路由的上限是新增時上游回報的值，修改不能超過；CLI 路由的上限可以一起調整。
      outputCapFixed: outputConfigurable && route.transport !== "claude-cli" && Boolean(outputCap),
      inCatalog: Boolean(entry),
    };
  }).sort((left, right) => (position.get(left.slug) ?? Number.MAX_SAFE_INTEGER) -
    (position.get(right.slug) ?? Number.MAX_SAFE_INTEGER));
  let imagegen;
  try {
    const config = relayConfig();
    imagegen = config ? { models: config.models || [], providerId: config.providerId ?? DEFAULT_PROVIDER_ID } : null;
  } catch (error) {
    imagegen = { error: error.message };
  }
  const desktop = desktopApp();
  const shortcut = managerShortcutPath();
  return {
    installed: true,
    platform: process.platform,
    versions: {
      manager: INSTALLER_VERSION,
      installed: terminalSafeText(manifest.version, 32) || null,
      router: health.version || null,
    },
    writeBlocked: managerWriteGuard(),
    router: { port, ...health },
    providers: providers.map((provider, index) => ({
      id: provider.id, baseUrl: provider.baseUrl || null, apiRoot: provider.apiRoot || null, primary: index === 0,
      modelCount: routes.filter((route) => routeProviderId(route) === provider.id).length,
      keyStored: env.CODEX_MODEL_ROUTER_TEST_API_KEY ? true : keychainHas(provider.keychainService),
    })),
    models,
    officialModelCount: catalogModels.filter((model) => !String(model.slug).startsWith("custom/")).length,
    customModelOrder: settings.customModelOrder === "manual" ? "manual" : "auto",
    config: hints === undefined ? null : hints,
    imagegen,
    claudeCli: {
      binary: settings.claudeCli?.binary || null,
      routeCount: routes.filter((route) => route.transport === "claude-cli").length,
    },
    desktop: { name: desktop?.name || desktopAppName, canRestart: Boolean(desktop) },
    paths: {
      codexHome, installRoot, logPath,
      nodeBin: manifest.nodeBin || nodeBin || null,
      codexBin: manifest.codexBin || codexBin || null,
      shortcut: existsSync(shortcut) ? shortcut : null,
    },
    service: { name: manifest.serviceName || manifest.launchLabel || serviceName, kind: serviceKindLabel },
  };
}

async function managerVersionInfo({ refresh = false } = {}) {
  const manifest = readManifest();
  const installed = terminalSafeText(manifest?.version, 32) || null;
  const settings = readSettingsIfExists();
  const health = await routerHealth(Number(settings.port ?? manifest?.port));
  let catalog = null;
  let error = null;
  try {
    catalog = await loadReleaseCatalog({ force: refresh, maxAgeMs: 30 * 60 * 1000 });
  } catch {
    error = "無法連線到 GitHub 檢查更新，請稍後再試。";
  }
  const latest = catalog?.latest || null;
  const comparison = latest && installed ? compareVersions(installed, latest) : null;
  const status = comparison == null ? "unknown" : comparison < 0 ? "update-available" : comparison === 0 ? "latest" : "ahead";
  const desktop = desktopApp();
  return {
    manager: INSTALLER_VERSION,
    installed,
    router: health.version || null,
    latest,
    status,
    localNewer: installed ? compareVersions(INSTALLER_VERSION, installed) === 1 : false,
    releases: catalog ? releasesBetween(catalog, installed).slice(-10) : [],
    releaseUrl: latest ? `${MANAGER_RELEASES_PAGE}/tag/v${latest}` : MANAGER_RELEASES_PAGE,
    releasesUrl: MANAGER_RELEASES_PAGE,
    canRestartDesktop: Boolean(desktop),
    desktopName: desktop?.name || desktopAppName,
    checkedAt: catalog ? new Date(releaseCatalogLoadedAt).toISOString() : null,
    error,
  };
}

export function parseRouterLog(text, limit = 50) {
  const entries = [];
  const clip = (value, max = 300) => (value == null ? null : terminalSafeText(value, max) || null);
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = /^model-router-([a-z-]+):(.*)$/.exec(line);
    if (!match || !MANAGER_LOG_KINDS.has(match[1])) continue;
    const [, kind, rest] = match;
    let record = null;
    if (kind === "error" && rest.trim().startsWith("{")) {
      try { record = JSON.parse(rest); } catch {}
    }
    if (!record || typeof record !== "object") {
      entries.push({ kind, message: clip(rest) });
      continue;
    }
    entries.push({
      kind, at: clip(record.at, 40), requestId: clip(record.requestId, 40), code: clip(record.code, 80),
      status: Number.isInteger(record.status) ? record.status : null, message: clip(record.message),
      model: clip(record.model, 160), provider: clip(record.provider, 40), upstreamHost: clip(record.upstreamHost, 200),
      transport: clip(record.transport, 20), route: clip(record.route, 20), phase: clip(record.phase, 40),
      causeCode: clip(record.causeCode, 60),
      upstreamStatus: Number.isInteger(record.upstreamStatus) ? record.upstreamStatus : null,
    });
  }
  return entries.slice(-limit).reverse();
}

function readFileTail(path, maxBytes = 256 * 1024) {
  const descriptor = openSync(path, "r");
  try {
    const { size } = fstatSync(descriptor);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(descriptor);
  }
}

function managerRecentErrors() {
  if (!existsSync(logPath)) return { entries: [], logPath };
  try {
    return { entries: parseRouterLog(readFileTail(logPath)), logPath };
  } catch (error) {
    return { entries: [], logPath, error: `無法讀取記錄檔：${error.message}` };
  }
}

function managerProvider(providers, providerId) {
  const provider = providers.find((item) => item.id === providerId);
  if (!provider) fail(`找不到供應商：${providerId}`);
  return provider;
}

function describeDiscoveredModel(id, configured = new Set()) {
  const owner = modelOwners.get(id) || null;
  return {
    id,
    configured: configured.has(id),
    anthropic: owner === "anthropic" || ((!owner || owner === "unknown") && looksAnthropic(id)),
  };
}

function configuredUpstreams(settings, providerId) {
  return new Set(settings.routes
    .filter((route) => routeProviderId(route) === providerId)
    .map((route) => route.upstreamModel));
}

// 查詢模型清單只讀不寫，也不花額度。
async function managerDiscover({ providerId } = {}) {
  const { settings, providers } = requireInstallation();
  const provider = managerProvider(providers, String(providerId || ""));
  const discovery = await discoverApiRoot(provider.baseUrl, readApiKey(provider.keychainService));
  const configured = configuredUpstreams(settings, provider.id);
  return {
    providerId: provider.id,
    apiRoot: discovery.apiRoot,
    models: discovery.models.map((model) => describeDiscoveredModel(model, configured)),
  };
}

// 新增供應商分兩步：先以表單的 Key 查模型清單（不存 Key），選好模型才探測並寫入。
// Key 只留在這個行程的記憶體裡，30 分鐘後失效，從不回傳給網頁。
const managerDrafts = new Map();

async function managerProviderDraft({ baseUrl, apiKey } = {}) {
  const { providers } = requireInstallation();
  const normalized = normalizeUrl(String(baseUrl || "").trim());
  const key = String(apiKey ?? "").trim();
  if (!key) fail("請填寫 API Key。");
  const clash = providers.find((provider) => provider.baseUrl === normalized);
  if (clash) fail(`這個 Base URL 已經是供應商「${clash.id}」；要添加它的模型請到「模型」頁新增。`);
  const discovery = await discoverApiRoot(normalized, key);
  const now = Date.now();
  for (const [id, draft] of managerDrafts) {
    if (now - draft.createdAt > MANAGER_DRAFT_TTL_MS) managerDrafts.delete(id);
  }
  const draftId = randomUUID();
  managerDrafts.set(draftId, { baseUrl: normalized, apiKey: key, discovery, createdAt: now });
  return {
    draftId,
    baseUrl: normalized,
    apiRoot: discovery.apiRoot,
    suggestedId: suggestProviderId(normalized, providers.map((provider) => provider.id)),
    models: discovery.models.map((model) => describeDiscoveredModel(model)),
  };
}

function managerModelSelection(models, configured = new Set()) {
  if (!Array.isArray(models)) fail("請至少選擇一個模型。");
  const selected = [];
  for (const raw of models) {
    const model = String(raw ?? "").trim();
    if (!model || selected.includes(model) || configured.has(model)) continue;
    if (!MODEL_ID_PATTERN.test(model)) fail(`模型 ID 格式無效：${terminalSafeText(model, 80)}`);
    selected.push(model);
  }
  if (selected.length === 0) fail("沒有需要探測的新模型。");
  if (selected.length > 40) fail("一次最多探測 40 個模型。");
  return selected;
}

async function managerAddModels({ providerId, models, contextWindow, maxOutputTokens } = {}) {
  assertManagerWritable();
  await withCodexLock(() => verifyLogin());
  const defaults = normalizeNewModelDefaults({ contextWindow, maxOutputTokens });
  const { settings, providers } = requireInstallation();
  const provider = managerProvider(providers, String(providerId || ""));
  const selected = managerModelSelection(models, configuredUpstreams(settings, provider.id));
  const apiKey = readApiKey(provider.keychainService);
  console.log(`供應商：${provider.id}（${provider.baseUrl}）`);
  console.log("正在查詢模型清單…");
  const discovery = await discoverApiRoot(provider.baseUrl, apiKey);
  console.log(`將探測 ${selected.length} 個模型，同時最多 ${probeConcurrency()} 個。`);
  const outcomes = await probeModelsInParallel(selected,
    (model, log) => buildRouteForModel(discovery, apiKey, model, log, provider.id));
  const newRoutes = outcomes.map((outcome) => outcome.route).filter(Boolean)
    .map((route) => applyNewModelDefaults(route, defaults));
  if (newRoutes.length === 0) fail("選中的模型均未通過探測，配置未改動。");
  console.log("\n探測完成，正在寫入設定並重新啟動路由器…");
  const { plan, backupDir } = await commitAddedModels(provider, newRoutes, discovery.models);
  printAddedLimits(plan.added, defaults);
  console.log(`備份：${backupDir}`);
  return {
    added: plan.added.map(summarizeRoute),
    skipped: selected.filter((model) => !plan.added.some((route) => route.upstreamModel === model)),
    backupDir,
    restartDesktop: true,
  };
}

// 新增完成後列出每個模型實際寫入的上下文與輸出，並說明與表單設定不同的原因。
function printAddedLimits(routes, defaults) {
  console.log(`\n已添加 ${routes.length} 個模型：`);
  for (const route of routes) {
    console.log(`  - ${route.displayName || route.upstreamModel}：${describeRouteLimits(route)}`);
    const output = routeOutputLimit(route);
    if (positiveNumber(route.contextWindow) && route.contextWindow < defaults.contextWindow) {
      console.log("    上游回報的上下文上限較小，已改用上游的值。");
    }
    if (output != null && output < defaults.maxOutputTokens) {
      console.log("    上游回報的輸出上限較小，已改用上游的值。");
    }
    if (output != null && !positiveNumber(route.maxOutputTokens)) {
      console.log("    ⚠️  上游沒有回報輸出上限；若回覆出現 max_tokens 錯誤，請到模型頁調低輸出。");
    }
  }
}

async function managerRemoveModels({ slugs } = {}) {
  assertManagerWritable();
  if (!Array.isArray(slugs) || slugs.length === 0) fail("沒有選擇要刪除的模型。");
  console.log("正在刪除所選模型並重新啟動路由器…");
  const { plan, defaultModel, backupDir } = await executeRemoveModels(slugs.map(String));
  for (const route of plan.removed) console.log(`  - ${route.displayName || route.upstreamModel}`);
  if (defaultModel) console.log("已清除指向已刪模型的全域預設模型設定。");
  console.log(`已刪除 ${plan.removed.length} 個模型。備份：${backupDir}`);
  managerConfigHints(true);
  return { removed: plan.removed.map(summarizeRoute), defaultCleared: Boolean(defaultModel), backupDir, restartDesktop: true };
}

async function managerReorderModels({ slugs } = {}) {
  assertManagerWritable();
  const { manifest, settings, catalog } = requireInstallation();
  const plan = planReorderModels(manifest, settings, catalog, Array.isArray(slugs) ? slugs.map(String) : slugs);
  if (!plan.changed && settings.customModelOrder === "manual") {
    console.log("順序沒有變更。");
    return { changed: false };
  }
  console.log("正在寫入新的順序（不需要重新啟動路由器）…");
  const backupDir = await commitCatalogChange("reorder-models", plan);
  console.log(`已更新順序。備份：${backupDir}`);
  return { changed: true, backupDir, restartDesktop: true };
}

async function managerEditModel({ slug, displayName, contextWindow, maxOutputTokens } = {}) {
  assertManagerWritable();
  const { manifest, settings, catalog } = requireInstallation();
  const plan = planEditModel(manifest, settings, catalog, String(slug || ""), { displayName, contextWindow, maxOutputTokens });
  if (!plan.changed) {
    console.log("沒有任何變更。");
    return { changed: false };
  }
  if (plan.restartRouter) {
    // 輸出上限由路由器在轉送時套用，路由器沒有熱重載，必須重啟才會生效。
    console.log("正在寫入模型設定並重新啟動路由器（輸出上限要重啟後才會套用）…");
    const backupDir = await commitRouterChange("edit-model", plan);
    console.log(`已儲存。備份：${backupDir}`);
    return { changed: true, backupDir, restartDesktop: plan.restartDesktop };
  }
  console.log("正在寫入模型設定（不需要重新啟動路由器）…");
  const backupDir = await commitCatalogChange("edit-model", plan);
  console.log(`已儲存。備份：${backupDir}`);
  return { changed: true, backupDir, restartDesktop: plan.restartDesktop };
}

async function managerAddProvider({ draftId, models, providerId, contextWindow, maxOutputTokens } = {}) {
  assertManagerWritable();
  await withCodexLock(() => verifyLogin());
  const defaults = normalizeNewModelDefaults({ contextWindow, maxOutputTokens });
  const draftKey = String(draftId || "");
  const draft = managerDrafts.get(draftKey);
  if (!draft || Date.now() - draft.createdAt > MANAGER_DRAFT_TTL_MS) fail("新增供應商的資料已過期，請重新查詢模型。");
  const { providers } = requireInstallation();
  const clash = providers.find((provider) => provider.baseUrl === draft.baseUrl);
  if (clash) fail(`這個 Base URL 已經是供應商「${clash.id}」。`);
  const selected = managerModelSelection(models);
  const takenIds = providers.map((provider) => provider.id);
  const prefixed = selected.every((model) => model.includes("/"));
  const id = prefixed ? suggestProviderId(draft.baseUrl, takenIds) : String(providerId || "").trim().toLowerCase();
  const problem = providerIdError(id, takenIds);
  if (problem) fail(problem);
  if (prefixed) console.log(`所選模型已有前綴，保留模型原名；供應商管理名稱自動設為「${id}」。`);
  console.log(`將探測 ${selected.length} 個模型，同時最多 ${probeConcurrency()} 個。`);
  const outcomes = await probeModelsInParallel(selected,
    (model, log) => buildRouteForModel(draft.discovery, draft.apiKey, model, log, id));
  const newRoutes = outcomes.map((outcome) => outcome.route).filter(Boolean)
    .map((route) => applyNewModelDefaults(route, defaults));
  if (newRoutes.length === 0) fail("選中的模型均未通過探測，配置未改動。");

  const keychainService = keychainServiceFor(draft.baseUrl);
  let previousKey = null;
  if (keychainHas(keychainService)) {
    try { previousKey = readApiKey(keychainService); } catch {}
  }
  storeApiKeyValue(keychainService, draft.baseUrl, draft.apiKey);
  try {
    const templates = await withCodexLock(() => loadCatalogTemplates());
    const { manifest, settings, catalog } = requireInstallation();
    const provider = {
      id, baseUrl: draft.baseUrl, apiRoot: draft.discovery.apiRoot, keychainService, keychainAccount: "codex",
      credentialPath: isWindows ? credentialFileFor(keychainService) : null,
    };
    console.log("\n探測完成，正在寫入設定並重新啟動路由器…");
    const plan = planAddProvider(manifest, settings, catalog, templates, provider, newRoutes, draft.discovery.models);
    const backupDir = await commitRouterChange("add-provider", plan);
    managerDrafts.delete(draftKey);
    console.log(`已新增供應商「${id}」。`);
    printAddedLimits(newRoutes, defaults);
    console.log(`備份：${backupDir}`);
    return { providerId: id, added: newRoutes.map(summarizeRoute), backupDir, restartDesktop: true };
  } catch (error) {
    // 寫入失敗時把憑證放回原狀，不留下沒有供應商在用的 Key。
    if (!env.CODEX_MODEL_ROUTER_TEST_API_KEY) {
      try {
        if (previousKey) storeApiKeyValue(keychainService, draft.baseUrl, previousKey);
        else deleteApiKey(keychainService);
      } catch {}
    }
    throw error;
  }
}

async function managerRemoveProvider({ providerId, deleteKey = true } = {}) {
  assertManagerWritable();
  const { providers } = requireInstallation();
  const provider = managerProvider(providers, String(providerId || ""));
  if (providers.length <= 1) fail("至少要保留一家供應商；要整個移除路由器請在終端選單使用「回退配置」。");
  console.log(`正在移除供應商「${provider.id}」與它的模型，並重新啟動路由器…`);
  const { plan, defaultModel, imagegenAffected, backupDir } = await executeRemoveProvider(provider.id);
  let keyDeleted = false;
  const shared = providers.some((item) => item.id !== provider.id && item.keychainService === provider.keychainService);
  if (deleteKey !== false && !shared && !env.CODEX_MODEL_ROUTER_TEST_API_KEY) {
    try {
      deleteApiKey(provider.keychainService, provider.keychainAccount || "codex");
      keyDeleted = true;
    } catch (error) {
      console.error(`API Key 未能刪除：${error.message}`);
    }
  }
  if (defaultModel) console.log("已清除指向已刪模型的全域預設模型設定。");
  console.log(`已移除供應商「${provider.id}」與 ${plan.removedRoutes.length} 個模型。備份：${backupDir}`);
  managerConfigHints(true);
  return {
    removed: plan.removedRoutes.map(summarizeRoute), defaultCleared: Boolean(defaultModel),
    imagegenDisabled: imagegenAffected, keyDeleted, primary: plan.providers[0]?.id || null, backupDir, restartDesktop: true,
  };
}

// 先用新 Key 查模型清單：上游明確拒絕（401／403）就不換，免得把能用的舊 Key 蓋掉。
// 網路錯誤或其他狀態無法判斷 Key 本身的對錯，照樣更換並提醒。
async function managerReplaceKey({ providerId, apiKey } = {}) {
  const { providers } = requireInstallation();
  const provider = managerProvider(providers, String(providerId || ""));
  const key = String(apiKey ?? "").trim();
  if (!key) fail("請填寫新的 API Key。");
  console.log(`正在用新 Key 查詢「${provider.id}」的模型清單…`);
  let status = null;
  let problem = null;
  try {
    const response = await fetchWithTimeout(`${provider.apiRoot}/models`, {
      headers: { authorization: `Bearer ${key}` },
    }, 15000);
    await response.arrayBuffer();
    status = response.status;
  } catch (error) {
    problem = error?.name === "AbortError" ? "逾時" : error.message;
  }
  if (status === 401 || status === 403) fail(`上游拒絕這把 Key（HTTP ${status}），沒有更換。`);
  storeApiKeyValue(provider.keychainService, provider.baseUrl, key);
  const verified = status != null && status >= 200 && status < 300;
  console.log(verified
    ? "已更換，新 Key 可以正常查詢模型清單。"
    : `已更換，但無法確認新 Key 是否可用（${status != null ? `HTTP ${status}` : problem}）。`);
  console.log(isWindows
    ? "路由器下一個請求就會改用新 Key，不必重啟。"
    : "路由器最晚 5 分鐘內改用新 Key；上游拒絕舊 Key 時會立即改用。");
  return { verified, status };
}

async function managerRestartRouter() {
  const manifest = readManifest();
  if (!manifest) fail("尚未安裝路由器。");
  const settings = readSettingsIfExists();
  console.log("正在重新啟動路由器…");
  restartServiceInPlace();
  const health = await waitForHealth(Number(settings.port ?? manifest.port));
  console.log(`路由器已重新啟動（${health.version || "版本未知"}）。`);
  return { version: health.version || null };
}

// --- 第二階段：全域上下文、隱藏官方模型、中轉生圖、Claude CLI ------------------------

async function managerGlobalContext() {
  if (!codexBin) fail(`未找到 Codex CLI，請先安裝 ${desktopAppName} 或 Codex CLI。`);
  const { config, filePath } = await readUserConfig();
  const current = deepGet(config, "model_context_window");
  const value = current.present ? Number(current.value) : null;
  return { value: Number.isFinite(value) ? value : null, filePath };
}

async function managerSetGlobalContext({ value } = {}) {
  assertManagerWritable();
  const target = normalizeGlobalContextWindow(value);
  console.log(target === null
    ? "正在移除全域 model_context_window…"
    : `正在把全域 model_context_window 設為 ${target.toLocaleString("en-US")}…`);
  const result = await setGlobalContextWindow(target);
  managerConfigHints(true);
  if (!result.changed) {
    console.log("設定沒有變更。");
    return { changed: false, value: target };
  }
  console.log(target === null ? "已移除全域上下文，各模型改用自己的上下文。" : "已更新全域上下文。");
  console.log(`設定檔：${result.filePath}`);
  console.log(`備份：${result.backupDir}`);
  return { changed: true, value: target, backupDir: result.backupDir, restartDesktop: true };
}

// 與 loadBundledCatalog 相同，但不阻塞管理頁回應其他請求。
async function readBundledCatalogAsync() {
  if (!codexBin) fail(`未找到 Codex CLI，請先安裝 ${desktopAppName} 或 Codex CLI。`);
  const result = await withCodexLock(() => commandOutput(codexBin,
    ["debug", "models", "--bundled", "-c", "model_catalog_json=null", "-c", 'model_provider="openai"'],
    { timeoutMs: 60000, environment: { ...env, CODEX_HOME: codexHome } }));
  let catalog = null;
  try { catalog = JSON.parse(result.stdout); } catch {}
  if (result.status !== 0 || !Array.isArray(catalog?.models) || catalog.models.length === 0) {
    fail("無法讀取 Codex 內建模型目錄。");
  }
  return catalog;
}

async function managerHiddenModels() {
  const settings = readSettingsIfExists();
  return { models: hiddenModelChoices(await readBundledCatalogAsync(), settings.forceListedModels) };
}

async function managerSetHiddenModels({ slugs } = {}) {
  assertManagerWritable();
  if (!Array.isArray(slugs)) fail("請提供要強制顯示的模型清單。");
  const bundledCatalog = await withCodexLock(() => loadBundledCatalog());
  const hidden = new Set(hiddenModelChoices(bundledCatalog).map((model) => model.slug));
  const requested = [...new Set(slugs.map(String))];
  const unknown = requested.filter((slug) => !hidden.has(slug));
  if (unknown.length) fail(`不是可強制顯示的隱藏模型：${unknown.map((slug) => terminalSafeText(slug, 80)).join("、")}`);
  console.log(requested.length
    ? `正在設定強制顯示 ${requested.length} 個隱藏模型，並重新啟動路由器…`
    : "正在恢復預設（不強制顯示任何隱藏模型），並重新啟動路由器…");
  // executeHiddenModels 內部只用同步的 debug models 驗證，不會再取得這把鎖。
  const result = await withCodexLock(() => executeHiddenModels(requested, { bundledCatalog }));
  if (!result.changed) {
    console.log("設定沒有變更，未重寫模型目錄或重啟路由器。");
    return { changed: false, chosen: result.chosen };
  }
  console.log(result.chosen.length ? `已強制顯示：${result.chosen.join(", ")}` : "已恢復預設，不強制顯示任何隱藏模型。");
  console.log(`備份：${result.backupDir}`);
  return { changed: true, chosen: result.chosen, backupDir: result.backupDir, restartDesktop: true };
}

function relayImagegenStatus() {
  let config = null;
  let error = null;
  try { config = relayConfig(); } catch (caught) { error = caught.message; }
  let lastCheck = null;
  try {
    const saved = JSON.parse(readFileSync(join(installRoot, "imagegen-last-check.json"), "utf8"));
    lastCheck = {
      checkedAt: terminalSafeText(saved.checkedAt, 40) || null,
      checks: (Array.isArray(saved.checks) ? saved.checks : []).slice(0, 12).map((check) => ({
        apiMode: check?.apiMode === "ark-task" ? "ark-task" : "images",
        model: terminalSafeText(check?.model, 120),
        ok: check?.ok === true,
        error: check?.ok === true ? null : terminalSafeText(check?.error, 300) || null,
      })),
    };
  } catch {}
  return {
    enabled: Boolean(config),
    error,
    models: Array.isArray(config?.models) ? config.models : [],
    upstreamModels: config?.upstreamModels || {},
    apiMode: config?.apiMode || null,
    // 舊版技能沒有記錄供應商：那時只有一家，也就是 default。
    providerId: config ? config.providerId ?? DEFAULT_PROVIDER_ID : null,
    root: relaySkillRoot,
    choices: RELAY_IMAGE_MODELS,
    lastCheck,
  };
}

async function managerImagegenSetup({ providerId, models } = {}) {
  assertManagerWritable();
  const { settings, providers } = requireInstallation();
  const allowed = RELAY_IMAGE_MODELS.map((model) => model.id);
  const selected = Array.isArray(models) ? [...new Set(models.map(String))] : [];
  if (selected.length === 0 || selected.some((model) => !allowed.includes(model))) {
    fail("請從 Image 2、Image 2.5 Sunburst、Image 2.5 Flare 中至少選擇一個模型。");
  }
  const provider = providers.length === 1 && !providerId ? providers[0] : managerProvider(providers, String(providerId || ""));
  const current = relayConfig();
  console.log(`供應商：${provider.id}（${provider.baseUrl}）`);
  console.log("偵測會實際生圖並依供應商計費；先測通用介面，全部未通過時自動改測 Ark 任務介面。");
  const outcome = await runRelayImagegenSetup({ provider, selected, current, settings, providers });
  if (!outcome.available.length) fail("沒找到可用模型，生圖設定沒有變更。");
  return {
    models: outcome.available.map((model) => model.id),
    apiMode: outcome.discovery.apiMode,
    root: outcome.result.root,
    probeRoot: outcome.probeRoot,
  };
}

async function managerImagegenDisable() {
  assertManagerWritable();
  const backup = disableRelayImagegen();
  if (!backup) fail("中轉 API 生圖尚未啟用。");
  console.log(`已停用中轉 API 生圖，技能已封存至：${backup}`);
  console.log("要恢復時重新偵測並啟用即可，或把封存的 router-imagegen 資料夾搬回 skills 目錄。");
  return { backup };
}

const CLAUDE_CLI_MODEL_PATTERN = /^(?:opus|sonnet|haiku|fable|claude-[a-zA-Z0-9._-]+)$/;

async function managerClaudeCliStatus() {
  const settings = readSettingsIfExists();
  const routes = (Array.isArray(settings.routes) ? settings.routes : []).filter((route) => route.transport === "claude-cli");
  const found = await inspectClaudeCliAsync(settings);
  let auth = null;
  let authError = null;
  if (found) {
    try { auth = await (await loadClaudeCliTransport()).claudeCliAuth(found.binary); }
    catch (error) { authError = error.message; }
  }
  return {
    installed: Boolean(found),
    binary: found?.binary || null,
    version: found?.version || null,
    minimumVersion: CLAUDE_CLI_MIN_VERSION,
    upToDate: Boolean(found?.version && compareVersions(found.version, CLAUDE_CLI_MIN_VERSION) >= 0),
    loggedIn: Boolean(auth?.loggedIn),
    authMethod: auth?.authMethod || null,
    subscription: Boolean(auth?.loggedIn && auth.authMethod === "claude.ai"),
    authError,
    installerUrl: claudeCliInstallCommand(process.platform, tmpdir()).url,
    routes: routes.map((route) => ({ slug: route.pickerSlug, displayName: route.displayName, upstreamModel: route.upstreamModel })),
  };
}

async function managerClaudeCliModels() {
  const settings = readSettingsIfExists();
  const found = await inspectClaudeCliAsync(settings);
  if (!found) fail("尚未安裝 Claude CLI。");
  let discovered = [];
  let warning = null;
  try { discovered = await (await loadClaudeCliTransport()).discoverClaudeCliModels(found.binary); }
  catch (error) { warning = `模型清單讀取失敗：${error.message}`; }
  const choices = claudeCliModelChoices(Array.isArray(settings.routes) ? settings.routes : [], discovered);
  return { choices, fromCli: choices.some((choice) => choice.source === "cli"), warning };
}

async function managerClaudeCliInstall() {
  if (inspectClaudeCli()) fail("已經安裝 Claude CLI；需要新版本請按「更新 CLI」。");
  const transport = await loadClaudeCliTransport();
  await claudeCliSetupActions(transport).install();
  const found = inspectClaudeCli();
  if (!found) fail("安裝後仍找不到 Claude CLI，請檢查上方安裝程式輸出，或以 CODEX_MODEL_ROUTER_CLAUDE_BIN 指定執行檔。");
  console.log(`已安裝 Claude CLI：${found.binary}（${found.version || "版本未知"}）`);
  return { binary: found.binary, version: found.version };
}

async function managerClaudeCliUpdate() {
  const found = inspectClaudeCli();
  if (!found) fail("尚未安裝 Claude CLI。");
  await claudeCliSetupActions(await loadClaudeCliTransport()).update(found.binary);
  const after = inspectClaudeCli();
  console.log(`Claude CLI：${after?.binary || found.binary}（${after?.version || "版本未知"}）`);
  if (!after?.version || compareVersions(after.version, CLAUDE_CLI_MIN_VERSION) < 0) {
    fail(`更新後仍未達 ${CLAUDE_CLI_MIN_VERSION}；Homebrew／WinGet 安裝請透過原套件管理器更新。`);
  }
  return { version: after.version };
}

// 登入沿用終端流程：在執行管理頁的終端機視窗啟動 claude auth login（Claude 官方流程會開啟
// 瀏覽器授權；需要貼上代碼時也在那個視窗）。路由器不經手、不保存登入 token。
async function managerClaudeCliLogin({ force = false } = {}) {
  const found = inspectClaudeCli();
  if (!found) fail("尚未安裝 Claude CLI，請先安裝。");
  const transport = await loadClaudeCliTransport();
  await ensureClaudeCliLogin(found.binary, {
    auth: transport.claudeCliAuth,
    login: (path) => {
      console.log("已在執行管理頁的終端機視窗啟動 claude auth login，等待你在瀏覽器完成授權（最多 5 分鐘）。");
      console.log("若瀏覽器沒有自動開啟，或畫面要求貼上代碼，請切到那個終端機視窗操作。");
      return transport.claudeCliAuth(path, { login: true });
    },
    notify: console.log,
    force: force === true,
  });
  console.log("Claude 訂閱帳號：已登入。");
  return { loggedIn: true };
}

async function managerClaudeCliAdd({ models, contextWindow, maxOutputTokens } = {}) {
  assertManagerWritable();
  await withCodexLock(() => verifyLogin());
  const defaults = normalizeNewModelDefaults({ contextWindow, maxOutputTokens });
  if (defaults.contextWindow > 1000000) fail("Claude CLI 模型的上下文上限最多 1,000,000。");
  const requested = Array.isArray(models) ? [...new Set(models.map((model) => String(model).trim()))].filter(Boolean) : [];
  if (requested.length === 0) fail("請至少選擇一個模型。");
  if (requested.length > 10) fail("一次最多測試 10 個模型。");
  const invalid = requested.filter((model) => !CLAUDE_CLI_MODEL_PATTERN.test(model));
  if (invalid.length) fail(`模型名稱只能是 opus、sonnet、haiku、fable 或完整 claude-* 名稱：${invalid.map((model) => terminalSafeText(model, 80)).join("、")}`);
  const state = requireInstallation();
  const found = inspectClaudeCli(state.settings);
  if (!found) fail("尚未安裝 Claude CLI，請先在供應商頁安裝。");
  if (!found.version || compareVersions(found.version, CLAUDE_CLI_MIN_VERSION) < 0) {
    fail(`Claude CLI ${found.version || "版本未知"} 低於最低要求 ${CLAUDE_CLI_MIN_VERSION}，請先更新。`);
  }
  const transport = await loadClaudeCliTransport();
  const auth = await transport.claudeCliAuth(found.binary);
  if (!auth.loggedIn || auth.authMethod !== "claude.ai") fail("尚未登入 Claude 訂閱帳號，請先按「登入 Claude」。");
  // 送出任何測試前先驗證設定，避免花了用量才發現參數不對。
  planClaudeCliModels(state, found.binary, requested, defaults.contextWindow, {}, { maxOutputTokens: defaults.maxOutputTokens });
  console.log(`Claude CLI：${found.binary}（${found.version}）`);
  console.log(`將測試 ${requested.length} 個模型，每個發送一次短測試並使用訂閱用量；只有通過的會添加。`);
  const tested = await testClaudeCliModels(transport, { binary: found.binary, version: found.version, models: requested });
  if (!tested.passed.length) fail("沒有模型通過測試，路由配置未修改。");
  // 測試期間設定可能被更新，以最新檔案重新規劃。
  const plan = planClaudeCliModels(requireInstallation(), tested.binary, tested.passed, defaults.contextWindow,
    tested.resolvedModels, { maxOutputTokens: defaults.maxOutputTokens });
  console.log("\n測試完成，正在寫入設定並重新啟動路由器…");
  const backupDir = await commitRouterChange("claude-cli", plan);
  const added = [...new Set(tested.passed.map((model) => tested.resolvedModels[model]))];
  console.log(`已添加：${added.map((id) => `claude-cli/${id}`).join("、")}`);
  console.log(`上下文 ${defaults.contextWindow.toLocaleString("en-US")}，輸出 ${defaults.maxOutputTokens.toLocaleString("en-US")}（超過模型上限時 Claude CLI 會自動壓到上限）。`);
  console.log(`備份：${backupDir}`);
  return { added, failures: tested.failures, backupDir, restartDesktop: true };
}

function managerOperations() {
  const job = (title, run) => ({ title, run });
  return {
    state: () => managerState(),
    version: (options) => managerVersionInfo(options),
    errors: () => managerRecentErrors(),
    discover: (body) => managerDiscover(body),
    providerDraft: (body) => managerProviderDraft(body),
    // 唯讀查詢：不改任何設定、不花額度。
    queries: {
      "global-context": () => managerGlobalContext(),
      "hidden-models": () => managerHiddenModels(),
      imagegen: () => relayImagegenStatus(),
      "claude-cli": () => managerClaudeCliStatus(),
      "claude-cli-models": () => managerClaudeCliModels(),
    },
    jobs: {
      "add-models": job("添加模型", managerAddModels),
      "remove-models": job("刪除模型", managerRemoveModels),
      "reorder-models": job("調整模型順序", managerReorderModels),
      "edit-model": job("修改模型", managerEditModel),
      "add-provider": job("新增供應商", managerAddProvider),
      "remove-provider": job("移除供應商", managerRemoveProvider),
      "replace-key": job("更換 API Key", managerReplaceKey),
      "restart-router": job("重新啟動路由器", managerRestartRouter),
      "restart-desktop": job("重新啟動桌面版", () => {
        if (!desktopApp() || !existsSync(managerInstallerPath)) fail("找不到可重新啟動的桌面版或管理頁安裝器副本。");
        return { managerRestart: true, desktopRestartRequested: true, restartDesktop: true };
      }),
      update: job("更新路由器", managerUpdate),
      "apply-update": job("套用新版本", managerApplyLocalUpdate),
      "set-global-context": job("設定全域上下文", managerSetGlobalContext),
      "set-hidden-models": job("設定隱藏的官方模型", managerSetHiddenModels),
      "imagegen-setup": job("偵測並啟用中轉生圖", managerImagegenSetup),
      "imagegen-disable": job("停用中轉生圖", managerImagegenDisable),
      "claude-cli-install": job("安裝 Claude CLI", managerClaudeCliInstall),
      "claude-cli-update": job("更新 Claude CLI", managerClaudeCliUpdate),
      "claude-cli-login": job("登入 Claude 訂閱帳號", managerClaudeCliLogin),
      "claude-cli-add": job("添加 Claude 訂閱模型", managerClaudeCliAdd),
    },
  };
}

// --- ui 命令 --------------------------------------------------------------------

async function importManagerModule() {
  const directory = mkdtempSync(join(tmpdir(), "codex-model-router-ui-"));
  const file = join(directory, "manager.mjs");
  try {
    writeFileSync(file, loadManagerSource(), { mode: 0o600 });
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function argOption(name) {
  const args = process.argv.slice(3);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) return args[index + 1] ?? null;
    if (args[index].startsWith(`${name}=`)) return args[index].slice(name.length + 1);
  }
  return null;
}

function listenOnce(server, port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectPromise(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

// 更新後重新啟動時沿用原本的埠，瀏覽器分頁才能直接接上新版本。
async function listenManager(server, preferredPort, { strict = false } = {}) {
  if (preferredPort > 0) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        return await listenOnce(server, preferredPort);
      } catch (error) {
        if (error.code !== "EADDRINUSE") throw error;
        await delay(250);
      }
    }
    if (strict) fail(`無法接手原本的管理頁連接埠 ${preferredPort}，請查看 manager-worker.log。`);
    console.log(`連接埠 ${preferredPort} 仍被佔用，改用其他連接埠；請改開下面顯示的新網址。`);
  }
  return listenOnce(server, 0);
}

function closeManagerServer(server) {
  return new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
    server.closeAllConnections?.();
  });
}

// 一般開啟只負責啟動／重用背景程序，再打開網址，完成即退出。
// 管理程序直接用同一份 Node 負載啟動，不留下 PowerShell / cmd / 終端依附。
async function openManager() {
  if (!readManifest()) fail("當前 CODEX_HOME 尚未安裝 Codex 模型路由器，請先安裝。");
  // 兩次快速點擊也只能建立一個背景管理頁；啟動者意外退出後，下次會移除它的鎖。
  const path = join(installRoot, "manager-starting.json");
  const owner = { pid: process.pid, id: randomUUID() };
  const deadline = Date.now() + 45000;
  let acquired = false;
  while (Date.now() < deadline && !acquired) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(owner)); acquired = true; } finally { closeSync(fd); }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        let previous;
        try { previous = JSON.parse(readFileSync(path, "utf8")); } catch {}
        let stale = !previous?.pid && Date.now() - statSync(path).mtimeMs > 5000;
        if (Number.isInteger(previous?.pid) && previous.pid > 0) {
          try { process.kill(previous.pid, 0); } catch (error) { stale = error.code === "ESRCH"; }
        }
        if (stale) rmSync(path, { force: true });
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      await delay(100);
    }
  }
  if (!acquired) fail("另一個管理頁啟動程序尚未完成，請稍後再試。");
  try { return await openManagerOnce(); } finally {
    try { if (JSON.parse(readFileSync(path, "utf8")).id === owner.id) rmSync(path, { force: true }); } catch {}
  }
}

async function openManagerOnce() {
  const existing = readManagerLock();
  const openPage = env.CODEX_MODEL_ROUTER_UI_NO_OPEN !== "1";
  if (existing && await managerAlive(existing)) {
    const url = managerUrl(existing.port, existing.token);
    console.log(`網頁管理介面已經在執行（${existing.version || "版本未知"}）。`);
    console.log(`網址：${url}`);
    if (openPage && openBrowser(url)) console.log("已在瀏覽器開啟。");
    return;
  }
  const manager = await importManagerModule();
  const token = manager.createToken();
  const entry = join(installRoot, `manager-entry-${randomUUID()}.mjs`);
  const source = readFileSync(scriptPath, "utf8").replaceAll("\r\n", "\n");
  const start = source.indexOf("\n__CODEX_MODEL_ROUTER_INSTALLER_JS__\n");
  const end = source.indexOf("\n__CODEX_MODEL_ROUTER_ROUTER_JS__\n");
  if (start < 0 || end <= start) fail("安裝器缺少管理頁啟動程式。");
  writeFileSync(entry, source.slice(start + "\n__CODEX_MODEL_ROUTER_INSTALLER_JS__\n".length, end) + "\n", { mode: 0o600 });
  const childEnv = { ...managerBackgroundEnvironment(env), CODEX_HOME: codexHome, CODEX_MODEL_ROUTER_HOME: installRoot,
    CODEX_MODEL_ROUTER_SCRIPT_PATH: scriptPath, CODEX_MODEL_ROUTER_NODE_BIN: process.execPath,
    CODEX_MODEL_ROUTER_UI_TOKEN: token, CODEX_MODEL_ROUTER_UI_NO_OPEN: "1", CODEX_MODEL_ROUTER_UI_BACKGROUND: "1" };
  const args = [entry, "ui", "--foreground"];
  const preferredPort = argOption("--port");
  if (preferredPort) args.push("--port", preferredPort);
  let worker;
  try {
    worker = await startManagerBackgroundTask({ kind: "manager", command: process.execPath, args,
      environment: childEnv, cleanupPaths: [entry] });
  } catch (error) {
    rmSync(entry, { force: true });
    throw error;
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = readManagerWorkerStatus(worker.statusPath);
    if (state?.status === "failed") fail(state.error);
    const lock = readManagerLock();
    if (lock?.token === token && await managerAlive(lock)) {
      const url = managerUrl(lock.port, token);
      console.log(`網址：${url}`);
      console.log("管理頁已在背景啟動；可從頁面結束，閒置 20 分鐘自動結束。");
      if (openPage && openBrowser(url)) console.log("已在瀏覽器開啟。");
      rmSync(worker.statusPath, { force: true });
      return;
    }
    await delay(100);
  }
  fail(`管理頁未能啟動，請查看 ${worker.logPath}。`);
}

async function runManager() {
  if (!readManifest()) fail("當前 CODEX_HOME 尚未安裝 Codex 模型路由器，請先選擇「安裝或重新配置」。");
  const inheritedToken = env.CODEX_MODEL_ROUTER_UI_TOKEN || null;
  const openPage = env.CODEX_MODEL_ROUTER_UI_NO_OPEN !== "1";
  if (!inheritedToken) {
    const existing = readManagerLock();
    if (existing && existing.pid !== process.pid && await managerAlive(existing)) {
      const url = managerUrl(existing.port, existing.token);
      console.log(`網頁管理介面已經在執行（${existing.version || "版本未知"}）。`);
      if (openPage && openBrowser(url)) console.log("已在瀏覽器重新開啟。");
      else console.log(`請在瀏覽器開啟：${url}`);
      return;
    }
  }

  const manager = await importManagerModule();
  const html = loadManagerPage();
  const token = inheritedToken || manager.createToken();
  const instanceId = manager.createToken();
  let finish = () => {};
  const finished = new Promise((resolvePromise) => { finish = resolvePromise; });
  const jobs = manager.createJobRunner({ onFinished: (job) => {
    if (job.status !== "succeeded" || !job.result?.managerRestart) return;
    try {
      writeJsonAtomic(managerHandoffPath, { token, job: jobs.view(job), createdAt: new Date().toISOString() });
      // 不等瀏覽器發 /api/restart：分頁可能已關掉、暫停，或正在跟桌面版一起退出。
      finish("restart");
    } catch (error) {
      job.result = { ...job.result, managerRestart: false, managerError: error.message };
      console.error(`更新已完成，但無法交接管理頁：${error.message}`);
    }
  } });
  let restoredJob = null;
  if (inheritedToken) {
    try {
      const handoff = JSON.parse(readFileSync(managerHandoffPath, "utf8"));
      if (handoff.token === token) restoredJob = jobs.restore({ ...handoff.job,
        result: { ...handoff.job.result, managerRestart: false } });
    } catch (error) {
      if (error.code !== "ENOENT") console.error(`無法恢復管理頁的操作記錄：${error.message}`);
    }
  }
  const restoreOutput = manager.installOutputCapture(jobs);
  managerMode = true;
  let lastActivity = Date.now();
  const server = manager.createManagerServer({
    html, token, version: INSTALLER_VERSION, instanceId, ops: managerOperations(), jobs,
    onActivity: () => { lastActivity = Date.now(); },
    onShutdown: () => finish("shutdown"),
    onRestart: () => finish("restart"),
    restartBlocked: () => (existsSync(managerInstallerPath)
      ? null
      : "找不到已安裝的安裝器副本，請關閉這個分頁後重新開啟管理頁。"),
  });
  let port;
  try {
    port = await listenManager(server, Number(argOption("--port")) || 0, { strict: Boolean(inheritedToken) });
  } catch (error) {
    restoreOutput();
    managerMode = false;
    throw error;
  }
  try {
    writeJsonAtomic(managerLockPath, {
      pid: process.pid, port, token, version: INSTALLER_VERSION, instanceId, startedAt: new Date().toISOString(),
    });
  } catch {}
  // 終端視窗被關掉後寫入會失敗；那時只剩背景工作要收尾，不能因此崩潰。
  const ignoreStreamError = () => {};
  process.stdout.on("error", ignoreStreamError);
  process.stderr.on("error", ignoreStreamError);

  const url = managerUrl(port, token);
  printHeading("網頁管理介面");
  console.log(`網址：${url}`);
  console.log("網址含這次的存取權杖，請勿分享；閒置 20 分鐘會自動結束。");
  if (env.CODEX_MODEL_ROUTER_UI_BACKGROUND === "1") console.log("管理頁已在背景啟動，可從頁面選擇結束管理頁。");
  else if (inheritedToken) console.log("管理頁已由獨立程序接手，瀏覽器分頁會自動重新整理；可從頁面選擇結束管理頁。");
  else console.log("關閉這個終端視窗或按 Ctrl+C 即結束管理頁。");
  if (restoredJob) {
    rmSync(managerHandoffPath, { force: true });
    if (restoredJob.result?.desktopRestartRequested) {
      jobs.resume(restoredJob, () => restartDesktopAfter(restoredJob.result));
    }
  }
  if (!inheritedToken && openPage && !openBrowser(url)) console.log("無法自動開啟瀏覽器，請手動複製上面的網址。");

  // 操作進行中收到結束訊號時先等它完成，免得設定寫到一半；再按一次 Ctrl+C 才強制結束。
  let exitRequested = false;
  let warned = false;
  const onSignal = (signal) => {
    if (!jobs.active()) {
      finish("signal");
      return;
    }
    if ((signal === "SIGINT" || signal === "SIGBREAK") && warned) process.exit(130);
    exitRequested = true;
    if (signal === "SIGINT" || signal === "SIGBREAK") {
      warned = true;
      console.log(`\n「${jobs.active().title}」還在進行，完成後會自動結束；再按一次 Ctrl+C 立即強制結束。`);
    }
  };
  const signals = isWindows ? ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, onSignal);
  const watchdog = setInterval(() => {
    if (jobs.active()) return;
    if (exitRequested) finish("signal");
    else if (Date.now() - lastActivity > MANAGER_IDLE_MS) finish("idle");
  }, 2000);

  const reason = await finished;
  clearInterval(watchdog);
  for (const signal of signals) process.off(signal, onSignal);
  await closeManagerServer(server);
  if (reason !== "restart") removeManagerLock(token);
  restoreOutput();
  managerMode = false;
  if (reason === "restart") {
    await restartIntoInstalledManager(port, token);
    return;
  }
  console.log(reason === "idle"
    ? "\n超過 20 分鐘沒有使用，網頁管理介面已自動結束。"
    : "\n網頁管理介面已結束。");
}

// 同一個埠與權杖交給獨立程序，確認能連線後舊程序即退出，不再掛在 Codex 的程序樹下。
async function restartIntoInstalledManager(port, token) {
  console.log("\n正在以新版本重新啟動網頁管理介面…");
  const childEnv = managerBackgroundEnvironment(env);
  childEnv.CODEX_MODEL_ROUTER_UI_TOKEN = token;
  childEnv.CODEX_MODEL_ROUTER_UI_NO_OPEN = "1";
  const [command, args] = isWindows
    ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", managerInstallerPath, "ui", "--foreground", "--port", String(port)]]
    : ["/bin/bash", [managerInstallerPath, "ui", "--foreground", "--port", String(port)]];
  const worker = await startManagerBackgroundTask({ kind: "manager", command, args, environment: childEnv });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = readManagerWorkerStatus(worker.statusPath);
    if (state?.status === "failed") fail(state.error);
    const lock = readManagerLock();
    if (lock?.pid !== process.pid && lock?.port === port && lock?.token === token && await managerAlive(lock)) {
      console.log("新版管理頁已接手，原本的瀏覽器網址仍可使用。");
      rmSync(worker.statusPath, { force: true });
      return;
    }
    await delay(100);
  }
  fail(`無法連線到新版管理頁，請查看 ${worker.logPath}。`);
}

export function managerBackgroundEnvironment(environment) {
  const names = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PATH", "Path",
    "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "USER", "USERNAME", "USERDOMAIN", "COMPUTERNAME",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS", "CODEX_HOME", "CODEX_MODEL_ROUTER_HOME", "CODEX_MODEL_ROUTER_NODE_BIN",
    "CODEX_MODEL_ROUTER_CODEX_BIN", "CODEX_MODEL_ROUTER_CLAUDE_BIN", "CODEX_MODEL_ROUTER_CREDENTIALS_DIR", "CODEX_MODEL_ROUTER_DESKTOP_APP",
    "CODEX_MODEL_ROUTER_LAUNCH_AGENTS_DIR", "CODEX_MODEL_ROUTER_SHORTCUT_DIR", "CODEX_MODEL_ROUTER_RELEASES_URL",
    "CODEX_MODEL_ROUTER_RELEASE_DOWNLOAD_URL"];
  if (environment.CODEX_MODEL_ROUTER_TEST_MODE === "1") names.push("CODEX_MODEL_ROUTER_TEST_MODE",
    "CODEX_MODEL_ROUTER_TEST_API_KEY", "CODEX_MODEL_ROUTER_TEST_MODELS", "CODEX_MODEL_ROUTER_RELEASES_JSON", "CODEX_MODEL_ROUTER_DESKTOP_APP");
  return Object.fromEntries(names.filter((name) => typeof environment[name] === "string").map((name) => [name, environment[name]]));
}

export const MENU_ITEMS = [
  ["install", "安裝或重新配置"],
  ["ui", "開啟網頁管理介面"],
  ["update", "更新到最新版本（保留現有配置）"],
  ["add", "添加自訂模型"],
  ["remove", "刪除自訂模型"],
  ["providers", "管理供應商（新增／移除／更換 API Key）"],
  ["claude-cli", "連接 Claude 訂閱帳號（實驗性）"],
  ["hidden-models", "管理隱藏的官方模型"],
  ["context-1m", "設定全域上下文 100 萬"],
  ["imagegen", "中轉 API 生圖（添加／設定）"],
  ["status", "查看狀態"],
  ["rollback", "回退配置"],
  ["exit", "退出"],
];

function menuNumber(action) {
  return MENU_ITEMS.findIndex(([key]) => key === action) + 1;
}

function help() {
  console.log(`Codex 模型路由器 ${INSTALLER_VERSION}

用法：
  ${basename(scriptPath || "codex-model-router.command")} install
  ${basename(scriptPath || "codex-model-router.command")} ui
  ${basename(scriptPath || "codex-model-router.command")} ui-setup
  ${basename(scriptPath || "codex-model-router.command")} update
  ${basename(scriptPath || "codex-model-router.command")} add
  ${basename(scriptPath || "codex-model-router.command")} remove
  ${basename(scriptPath || "codex-model-router.command")} providers [add|remove|key]
  ${basename(scriptPath || "codex-model-router.command")} claude-cli [status|login]
  ${basename(scriptPath || "codex-model-router.command")} hidden-models
  ${basename(scriptPath || "codex-model-router.command")} context-1m
  ${basename(scriptPath || "codex-model-router.command")} imagegen
  ${basename(scriptPath || "codex-model-router.command")} imagegen-disable
  ${basename(scriptPath || "codex-model-router.command")} status
  ${basename(scriptPath || "codex-model-router.command")} rollback

安裝時會詢問：
  1. 兼容 OpenAI 的 Base URL
  2. API Key（保存在${secretStoreLabel}）
  3. 要添加的模型
探測時 /responses 不通的模型會改探 /chat/completions（DeepSeek、通義千問、Ollama 等），
通過的由路由器在本機轉譯。
路由器安裝成功後可選擇啟用中轉 API 生圖；預設不啟用，之後可從選單第 ${menuNumber("imagegen")} 項添加。

ui 在瀏覽器開啟本機網頁管理介面：查看狀態與最近錯誤、添加／刪除／排序模型、修改顯示名稱、
上下文與輸出、管理供應商與 API Key、中轉 API 生圖、全域上下文、隱藏的官方模型與 Claude 訂閱（CLI），
並可檢查新版本、一鍵更新後重新啟動。背後用的是與選單相同的流程（先備份、失敗還原）。
網址含一次性存取權杖，只接受本機連線；背景執行，不需要保留終端視窗。
從頁面結束或閒置 20 分鐘會自動退出；ui --foreground 可在終端顯示診斷。
安裝與更新完成後會建立捷徑（macOS：~/Applications/Codex 模型路由器.command；
Windows：開始功能表），雙擊即可開啟。重新開啟支援 MCP Apps 的 Codex 後，也可點擊介面中的
「自訂模型管理」直接開啟（依版本顯示在頂部或側邊欄）。ui-setup 可單獨修復入口，不重啟路由器。

update 用於升級到這支安裝器的版本：只換掉路由器與轉譯層程式碼並重寫服務定義，
沿用已儲存的 Base URL、API Key、連接埠與全部自訂模型，不重問任何設定，
會備份並移除本工具舊版寫入的 model_catalog_json，改由啟動時同步官方清單；其他配置保留。
models.json 仍保留自訂模型與離線回退資料；無前綴的預設名稱會補上 api/。
這是日常升級該用的命令。

add 用於在已有安裝上追加模型：沿用已儲存的 Base URL、API Key 與連接埠，
只探測新選的模型，不會重問設定，也不改動 config.toml。

remove 用於勾選並刪除已配置的自訂模型；刪除前會備份，失敗時還原。
可以刪到零個自訂模型，官方模型、API Key 與中轉生圖設定保留。

providers 用於同時使用多家中轉供應商：add 新增一家（各自保存 API Key，探測並添加
它的模型，已有前綴的模型保留原名）；remove 移除一家與它的模型；key 更換某一家的
API Key。第一家是主要供應商，install 重新配置的是它，Codex 內建的 image_gen 也送它。
add 有多家時會先問要替哪一家添加模型。

hidden-models 用於單獨管理 Codex 內建目錄裡被標成隱藏的官方模型：
只更新 forceListedModels 與模型目錄，保留自訂模型，不需要 Base URL 或 API Key。

imagegen 用於添加／設定中轉生圖技能 $router-imagegen，沿用現有憑證，不需 OPENAI_API_KEY。
有多家供應商時會先問要用哪一家生圖。
可複選 Image 2、Image 2.5 Sunburst、Image 2.5 Flare；多選時由 AI 按需求指定模型。
選擇模型後自動偵測並添加成功項目：先測通用生圖，全部失敗時再測 Ark 任務介面。
偵測可能產生費用，每個已選模型每種介面最多一次；不詢問介面、前綴或測試確認。
都未通過會顯示「沒找到可用模型」。選擇模型時輸入 none 停用、cancel 返回，兩者不生圖。

安裝器會繼續將官方 ChatGPT Codex 模型發送到 OpenAI，只有選中的
自訂模型選擇器 ID 才會發送到配置的供應商。Codex 仍使用內建
openai 供應商 ID，以保持 Desktop 與手機 Remote 的既有聊天可見。
`);
}

async function chooseAction() {
  printHeading("Codex 模型路由器");
  MENU_ITEMS.forEach(([, label], index) => console.log(`  ${index + 1}. ${label}`));
  const answer = await ask("請選擇操作", "1");
  const choices = {
    install: "install",
    setup: "install",
    ui: "ui",
    web: "ui",
    manager: "ui",
    update: "update",
    upgrade: "update",
    add: "add",
    "add-model": "add",
    addmodel: "add",
    remove: "remove",
    "remove-model": "remove",
    "remove-models": "remove",
    "delete-model": "remove",
    "delete-models": "remove",
    providers: "providers",
    provider: "providers",
    "manage-providers": "providers",
    "claude-cli": "claude-cli",
    hidden: "hidden-models",
    "hidden-models": "hidden-models",
    "unhide-models": "hidden-models",
    status: "status",
    rollback: "rollback",
    uninstall: "rollback",
    imagegen: "imagegen",
    "relay-imagegen": "imagegen",
    "context-1m": "context-1m",
    exit: "exit",
    quit: "exit",
  };
  const value = answer.trim().toLowerCase();
  const action = /^\d+$/.test(value) ? MENU_ITEMS[Number(value) - 1]?.[0] : choices[value];
  if (!action) fail(`無法識別的選單選項：${answer}`);
  return action;
}

// 測試會 import 本檔以驗證版本比較等純函式，此時不能真的執行安裝流程。
if (!process.env.CODEX_MODEL_ROUTER_IMPORT_ONLY) {
  try {
    const versionAwareActions = new Set([
      "install",
      "setup",
      "update",
      "upgrade",
      "add",
      "add-model",
      "addmodel",
      "remove",
      "remove-model",
      "remove-models",
      "delete-model",
      "delete-models",
      "providers",
      "claude-cli",
      "provider",
      "hidden-models",
      "hidden",
      "unhide-models",
      "imagegen",
      "relay-imagegen",
      "status",
    ]);
    if (!requestedAction || versionAwareActions.has(requestedAction)) {
      await printVersionSummary();
    }
    const action = requestedAction || (await chooseAction());
    if (action === "ui" || action === "web" || action === "manager") {
      // 1.27.3／1.27.4 的更新交接只有傳權杖、沒有 --foreground，仍須沿用原網址與權杖。
      if (process.argv.includes("--foreground") || env.CODEX_MODEL_ROUTER_UI_TOKEN) await runManager();
      else await openManager();
    }
    else if (action === "ui-setup") await setupManagerEntry();
    else if (action === "claude-cli") await configureClaudeCli(requestedAction ? process.argv[3] : null);
    else if (action === "context-1m") await configureMillionTokenContext();
    else if (action === "imagegen" || action === "relay-imagegen") await configureRelayImagegen();
    else if (action === "imagegen-disable") {
      const backup = join(backupsRoot, `imagegen-disabled-${timestamp()}`);
      console.log(archiveRelayImageSkill(backup) ? `已停用中轉生圖，技能已封存至：${backup}` : "中轉生圖尚未啟用。");
    }
    else if (action === "install" || action === "setup") await install();
    else if (action === "update" || action === "upgrade") await update();
    else if (action === "add" || action === "add-model" || action === "addmodel") await addModels();
    else if (["remove", "remove-model", "remove-models", "delete-model", "delete-models"].includes(action)) await removeModels();
    else if (action === "providers" || action === "provider") await manageProviders(requestedAction ? process.argv[3] : null);
    else if (action === "hidden-models" || action === "hidden" || action === "unhide-models") {
      await manageHiddenModels();
    }
    else if (action === "status") await status();
    else if (action === "rollback" || action === "uninstall") await rollback();
    else if (action === "exit") console.log("未進行任何修改。" );
    else if (action === "help" || action === "--help" || action === "-h") help();
    else fail(`無法識別的命令：${action}`);
  } catch (error) {
    console.error(`\n錯誤：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
