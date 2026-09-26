import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, isIP } from "node:net";
import { homedir, tmpdir } from "node:os";
import { Writable } from "node:stream";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const INSTALLER_VERSION = "1.23.1";
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
  const endMarker = "\n__CODEX_MODEL_ROUTER_IMAGEGEN_JS__";
  const endIndex = bridgeSource.lastIndexOf(endMarker);
  return endIndex < 0 ? bridgeSource : bridgeSource.slice(0, endIndex);
}

export function loadImagegenSource(sourcePath = scriptPath) {
  const source = readFileSync(sourcePath, "utf8").replaceAll("\r\n", "\n");
  const marker = "\n__CODEX_MODEL_ROUTER_IMAGEGEN_JS__\n";
  const start = source.indexOf(marker);
  const end = source.lastIndexOf("\n__CODEX_MODEL_ROUTER_EMBEDDED__");
  if (start < 0 || end <= start) fail("安裝器中缺少中轉生圖命令。");
  return source.slice(start + marker.length, end) + "\n";
}

async function ask(question, defaultValue = null) {
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
    ensureDirectory(credentialsRoot);
    const target = credentialFileFor(service);
    console.log("API Key 會用 Windows 憑證保護（DPAPI）以當前使用者身份加密儲存，" );
    console.log("不會寫入 config.toml 或安裝器檔案。" );
    let apiKey = "";
    for (let attempt = 0; attempt < 3 && !apiKey; attempt += 1) {
      if (attempt > 0) console.log("API Key 不能為空，請重新輸入。" );
      apiKey = await askSecret("API Key（輸入不會顯示）");
    }
    if (!apiKey) fail("API Key 不能為空。" );
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

  const label = `Codex 模型路由器：${new URL(baseUrl).host}`;
  console.log("請在 macOS 鑰匙圈提示中輸入 API Key。" );
  console.log("API Key 不會寫入 config.toml 或安裝器檔案。" );
  const result = spawnSync(
    "/usr/bin/security",
    [
      "add-generic-password",
      "-U",
      "-a",
      "codex",
      "-s",
      service,
      "-l",
      label,
      "-j",
      "供 Codex 本機模型路由器使用",
      "-w",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) fail("API Key 未能儲存到鑰匙圈。" );
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

async function loadReleaseCatalog() {
  if (releaseCatalogPromise) return releaseCatalogPromise;
  releaseCatalogPromise = (async () => {
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
  return releaseCatalogPromise;
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
const RESERVED_PROVIDER_IDS = new Set([DEFAULT_PROVIDER_ID, "api", "custom", "official"]);

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
  // 其他供應商一律以供應商名稱開頭，同一個模型在兩家都有時選單上才分得出來。
  if (providerId !== DEFAULT_PROVIDER_ID) {
    if (route.displayName && route.displayName !== model) return route;
    return { ...route, displayName: `${providerId}/${model}` };
  }
  // 只補自動產生的顯示名稱；上游 ID、選擇器 ID 與使用者手動取的名稱都保留。
  if (model.includes("/")) return route.displayName ? route : { ...route, displayName: model };
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
  "authProbeGraceMs",
  "captureDir",
  "catalogRefresh",
  "closeOnUpstreamError",
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
export function arrangeCustomModels(officialModels, customModels, routes, providerIds, probed, currentCatalog = null) {
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
  const maxPriority = Math.max(0, ...officialModels.map((model) => Number(model.priority) || 0));
  return ranked
    .map((model, index) => ({ model, group: groupOf(model), key: orderKey(model, index) }))
    .sort((left, right) => left.group - right.group || left.key[0] - right.key[0] || left.key[1] - right.key[1])
    .map(({ model }, index) => ({ ...model, priority: maxPriority + index + 1 }));
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

export async function codexRpc(method, params, acceptResult = () => true, binary = codexBin, home = codexHome) {
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
    child.kill("SIGTERM");
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

async function writeConfigEdits(edits) {
  return codexRpc("config/batchWrite", {
    edits: edits.map(({ keyPath, value }) => ({
      keyPath,
      value,
      mergeStrategy: "replace",
    })),
    reloadUserConfig: false,
  });
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
async function buildRouteForModel(discovery, apiKey, model, log = consoleProbeLog, providerId = DEFAULT_PROVIDER_ID) {
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
  if (!probe.supported) {
    log.line(
      probe.transient
        ? `跳過 ${model}：上游暫時不可用，並非模型不受支援。`
        : `跳過 ${model}：Responses API 探測未通過。`,
    );
    return {
      route: null,
      transient: Boolean(probe.transient),
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
  const currentCatalog = otherRoutes.length ? readCatalogIfExists() : null;
  const customModels = arrangeCustomModels(
    officialModels,
    mergeAddedModels(officialModels, currentCatalog, allRoutes, routes),
    allRoutes,
    providers.map((provider) => provider.id),
    { providerId: primaryId, models: discovery.models },
    currentCatalog,
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
  writeFileSync(bridgePath, loadBridgeSource(), { mode: 0o600 });
  chmodSync(bridgePath, 0o600);
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

  const routes = [...existingRoutes, ...newRoutes];
  const backupDir = join(backupsRoot, `add-model-${timestamp()}`);
  ensureDirectory(backupDir);
  copyIfExists(routerPath, join(backupDir, "router.mjs"));
  copyIfExists(bridgePath, join(backupDir, "claude-bridge.mjs"));
  copyIfExists(settingsPath, join(backupDir, "settings.json"));
  copyIfExists(catalogPath, join(backupDir, "models.json"));
  copyIfExists(manifestPath, join(backupDir, "install.json"));

  const bundledCatalog = loadCatalogTemplates();
  // 這裡不重問隱藏模型（add 的用意就是不重問設定），但既有的選擇要沿用，
  // 否則加一個模型就會把強制顯示的那些又藏回去。
  const officialModels = applyForcedVisibility(
    bundledCatalog.models.filter((model) => !String(model.slug).startsWith("custom/")),
    settings.forceListedModels,
  );
  const currentCatalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const customModels = arrangeCustomModels(
    officialModels,
    mergeAddedModels(officialModels, currentCatalog, routes, newRoutes),
    routes,
    providers.map((item) => item.id),
    { providerId: provider.id, models: discovery.models },
    currentCatalog,
  );
  const combinedCatalog = { ...bundledCatalog, models: [...officialModels, ...customModels] };

  try {
    // 路由器與轉譯層一併刷新，否則 settings.version 會與實際執行的程式碼對不上。
    writeFileSync(routerPath, extractRouterSource(), { mode: 0o600 });
    chmodSync(routerPath, 0o600);
    writeFileSync(bridgePath, loadBridgeSource(), { mode: 0o600 });
    chmodSync(bridgePath, 0o600);
    writeJsonAtomic(catalogPath, combinedCatalog);
    writeJsonAtomic(settingsPath, withProviders({ ...settings, version: INSTALLER_VERSION, routes }, providers));
    writeJsonAtomic(manifestPath, manifestWithProviders({
      ...manifest,
      version: INSTALLER_VERSION,
      updatedAt: new Date().toISOString(),
      routes,
    }, providers));
    // 路由變了但服務定義沒變，原地重啟就好——重新註冊需要提權，沒必要冒那個險。
    restartServiceInPlace();
    await waitForHealth(port);

    await waitForPickerModels(routes);
  } catch (error) {
    console.error("\n添加失敗，正在還原之前的配置...");
    copyIfExists(join(backupDir, "router.mjs"), routerPath);
    copyIfExists(join(backupDir, "claude-bridge.mjs"), bridgePath);
    copyIfExists(join(backupDir, "settings.json"), settingsPath);
    copyIfExists(join(backupDir, "models.json"), catalogPath);
    copyIfExists(join(backupDir, "install.json"), manifestPath);
    // 還原完必須確認服務真的回來了。之前這裡吞掉例外，結果是
    // 「添加失敗」變成「添加失敗而且路由器停著」，所有對話都會卡住。
    try {
      restartServiceInPlace();
      await waitForHealth(port);
      console.error("已還原到添加前的配置，路由器運作正常。");
    } catch (restartError) {
      console.error(
        `\n嚴重：配置已還原，但路由器沒有起來（${restartError.message}）。\n` +
          `請手動啟動：${manualStartHint()}\n` +
          `在它恢復之前，所有經過 127.0.0.1:${port} 的請求都會失敗。`,
      );
    }
    throw error;
  }

  printHeading("添加完成");
  console.log("本次新增：");
  for (const route of newRoutes) {
    const effortText = route.efforts.length ? route.efforts.join(", ") : "使用供應商預設值";
    console.log(`  - ${route.displayName}`);
    console.log(`    選擇器 ID：${route.pickerSlug}`);
    console.log(`    推理強度：${effortText}`);
  }
  console.log(`\n現共 ${routes.length} 個自訂模型。`);
  console.log(`備份：${backupDir}`);
  console.log(`\n請完全退出並重新打開 ${desktopAppName}。`);
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
  let plan = planRemoveModels(manifest, settings, catalog, selectedSlugs);
  let userConfig = await readUserConfig();
  const defaultModel = removedDefaultModel(userConfig.config, selectedSlugs);
  console.log("\n即將刪除：");
  for (const route of plan.removed) console.log(`  - ${route.displayName || route.upstreamModel}`);
  if (defaultModel) console.log("這些模型包含全域預設模型；確認後會清除該預設，讓 Codex 使用官方預設模型。");
  console.log("使用上述模型的既有任務需切換到其他模型後才能繼續。");
  if (!(await confirm("確認刪除所選自訂模型？", false))) {
    console.log("未進行任何修改。");
    return;
  }
  // 確認期間官方清單或路由可能剛好更新；只按仍然存在的精確 slug 刪除。
  userConfig = await readUserConfig();
  if (removedDefaultModel(userConfig.config, selectedSlugs) !== defaultModel) {
    fail("全域預設模型在確認期間變更，請重新執行刪除。" );
  }
  const currentManifest = readManifest();
  const currentSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const currentCatalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  plan = planRemoveModels(currentManifest, currentSettings, currentCatalog, selectedSlugs);
  const port = Number(currentSettings.port ?? currentManifest.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail("現有安裝沒有可用的連接埠設定。");

  const backupDir = join(backupsRoot, `remove-model-${timestamp()}`);
  ensureDirectory(backupDir);
  for (const [source, name] of [
    [routerPath, "router.mjs"], [bridgePath, "claude-bridge.mjs"],
    [settingsPath, "settings.json"], [catalogPath, "models.json"],
    [manifestPath, "install.json"],
  ]) {
    if (!copyIfExists(source, join(backupDir, name))) fail(`無法備份 ${name}，已取消刪除。`);
  }
  if (defaultModel && !copyIfExists(userConfig.filePath, join(backupDir, "config.toml"))) {
    fail("無法備份全域預設模型設定，已取消刪除。");
  }

  let configChangeAttempted = false;
  try {
    writeFileSync(routerPath, extractRouterSource(), { mode: 0o600 });
    chmodSync(routerPath, 0o600);
    writeFileSync(bridgePath, loadBridgeSource(), { mode: 0o600 });
    chmodSync(bridgePath, 0o600);
    writeJsonAtomic(catalogPath, plan.catalog);
    writeJsonAtomic(settingsPath, plan.settings);
    writeJsonAtomic(manifestPath, { ...plan.manifest, updatedAt: new Date().toISOString() });
    restartServiceInPlace();
    await waitForHealth(port);
    if (defaultModel) {
      configChangeAttempted = true;
      await writeConfigEdits([{ keyPath: "model", value: null }]);
      if (deepGet((await readUserConfig()).config, "model").present) {
        fail("全域預設模型設定未成功清除。");
      }
    }
    await waitForPickerModels(plan.settings.routes, selectedSlugs);
  } catch (error) {
    console.error("\n刪除失敗，正在還原之前的配置...");
    const restoreFailures = [];
    for (const [name, target] of [
      ["router.mjs", routerPath], ["claude-bridge.mjs", bridgePath],
      ["settings.json", settingsPath], ["models.json", catalogPath],
      ["install.json", manifestPath],
    ]) {
      try {
        if (!copyIfExists(join(backupDir, name), target)) fail(`找不到 ${name} 備份。`);
      } catch (restoreError) { restoreFailures.push(`${name}：${restoreError.message}`); }
    }
    if (configChangeAttempted) {
      try { await writeConfigEdits([{ keyPath: "model", value: defaultModel }]); }
      catch (restoreError) { restoreFailures.push(`全域預設模型：${restoreError.message}`); }
    }
    try {
      restartServiceInPlace();
      await waitForHealth(port);
      if (restoreFailures.length === 0) console.error("已還原到刪除前的配置，路由器運作正常。");
    } catch (restartError) {
      restoreFailures.push(`路由器無法啟動：${restartError.message}；請手動啟動：${manualStartHint()}`);
    }
    if (restoreFailures.length) console.error(`\n還原未完成：${restoreFailures.join("；")}。備份：${backupDir}`);
    throw error;
  }

  printHeading("刪除完成");
  console.log(`已刪除 ${plan.removed.length} 個自訂模型，剩餘 ${plan.settings.routes.length} 個。`);
  if (defaultModel) console.log("已清除指向已刪模型的全域預設模型設定。");
  console.log(`備份：${backupDir}`);
  console.log(`請完全退出並重新打開 ${desktopAppName}。`);
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
  if (configFile && !copyIfExists(configFile, join(backupDir, "config.toml"))) {
    fail("無法備份 config.toml，已取消。");
  }
  let applied = false;
  try {
    writeFileSync(routerPath, extractRouterSource(), { mode: 0o600 });
    chmodSync(routerPath, 0o600);
    writeFileSync(bridgePath, loadBridgeSource(), { mode: 0o600 });
    chmodSync(bridgePath, 0o600);
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
    const answer = (await ask("供應商名稱（會顯示在它的模型名稱前面）", suggested)).trim().toLowerCase();
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
  console.log("每家供應商各自保存 API Key；它的模型會出現在選單上，名稱前面帶供應商名稱。");
  const baseUrl = normalizeUrl(await ask("兼容 OpenAI 的 Base URL"));
  const clash = providers.find((provider) => provider.baseUrl === baseUrl);
  if (clash) fail(`這個 Base URL 已經是供應商「${clash.id}」；要添加它的模型請用「添加自訂模型」。`);
  const id = await askProviderId(baseUrl, providers.map((provider) => provider.id));
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
  let { manifest, settings, catalog, providers } = requireInstallation();
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
  let plan = planRemoveProvider(manifest, settings, catalog, chosen.id);
  let userConfig = await readUserConfig();
  const defaultModel = removedDefaultModel(userConfig.config, plan.removedRoutes.map((route) => route.pickerSlug));
  const imagegen = relayConfig();
  const imagegenAffected = Boolean(imagegen) && (imagegen.providerId ?? DEFAULT_PROVIDER_ID) === chosen.id;
  console.log(`\n即將移除供應商「${chosen.id}」（${chosen.baseUrl}）與它的 ${plan.removedRoutes.length} 個模型：`);
  for (const route of plan.removedRoutes) console.log(`  - ${route.displayName || route.upstreamModel}`);
  if (providers[0].id === chosen.id) console.log(`移除後由「${plan.providers[0].id}」擔任主要供應商。`);
  if (defaultModel) console.log("這些模型包含全域預設模型；確認後會清除該預設，讓 Codex 使用官方預設模型。");
  if (imagegenAffected) console.log("中轉 API 生圖使用這家供應商，會一併停用；之後可從選單重新設定。");
  console.log("使用上述模型的既有任務需切換到其他模型後才能繼續。");
  if (!(await confirm(`確認移除供應商「${chosen.id}」？`, false))) {
    console.log("未進行任何修改。");
    return;
  }
  // 確認期間設定可能被其他命令改過，以最新的檔案重新規劃。
  ({ manifest, settings, catalog } = requireInstallation());
  plan = planRemoveProvider(manifest, settings, catalog, chosen.id);
  const removedSlugs = plan.removedRoutes.map((route) => route.pickerSlug);
  userConfig = await readUserConfig();
  if (removedDefaultModel(userConfig.config, removedSlugs) !== defaultModel) {
    fail("全域預設模型在確認期間變更，請重新執行。");
  }
  const backupDir = await commitRouterChange("remove-provider", {
    ...plan,
    absent: removedSlugs,
    configFile: defaultModel ? userConfig.filePath : null,
    apply: defaultModel ? async () => {
      await writeConfigEdits([{ keyPath: "model", value: null }]);
      if (deepGet((await readUserConfig()).config, "model").present) fail("全域預設模型設定未成功清除。");
    } : null,
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

  printHeading("移除完成");
  console.log(`已移除供應商「${chosen.id}」與 ${plan.removedRoutes.length} 個模型，剩餘 ${plan.providers.length} 家供應商。`);
  if (defaultModel) console.log("已清除指向已刪模型的全域預設模型設定。");
  console.log(`備份：${backupDir}`);
  if (await confirm(`是否從${secretStoreLabel}中刪除「${chosen.id}」的 API Key？`, true)) {
    deleteApiKey(chosen.keychainService, chosen.keychainAccount || "codex");
  }
  console.log(`\n請完全退出並重新打開 ${desktopAppName}。`);
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
  if (routes.some((route) => !providerIds.has(routeProviderId(route)))) {
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
    writeFileSync(bridgePath, loadBridgeSource(), { mode: 0o600 });
    chmodSync(bridgePath, 0o600);
    writeJsonAtomic(settingsPath, plan.settings);
    if (namesChanged) writeJsonAtomic(catalogPath, updatedCatalog);
    writeJsonAtomic(manifestPath, {
      ...plan.manifest,
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
  console.log(`\n請完全退出並重新打開 ${desktopAppName}。`);
}

async function manageHiddenModels() {
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

  printHeading("管理隱藏的官方模型");
  const bundledCatalog = loadBundledCatalog();
  const officialModels = bundledCatalog.models.filter(
    (model) => !String(model?.slug || "").startsWith("custom/"),
  );
  const previous = normalizeForceListedModels(
    officialModels,
    settings.forceListedModels,
  );
  const chosen = normalizeForceListedModels(
    officialModels,
    await chooseForcedModels(officialModels, previous),
  );
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
    console.log("\n設定沒有變更，未重寫模型目錄或重啟路由器。");
    console.log(`目前強制顯示 ${chosen.length} 個隱藏模型。`);
    return;
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

  printHeading("隱藏模型設定完成");
  console.log(
    chosen.length
      ? `已強制顯示 ${chosen.length} 個模型：${chosen.join(", ")}`
      : "已恢復預設，不強制顯示任何隱藏模型。",
  );
  console.log(`健康檢查：${health?.status || "未知"}`);
  console.log(`保留 ${customSlugs.length} 個自訂模型。`);
  console.log(`備份：${backupDir}`);
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
    if (!current) { console.log("中轉 API 生圖尚未啟用。"); return; }
    const backup = join(backupsRoot, `imagegen-disabled-${timestamp()}`);
    archiveRelayImageSkill(backup);
    console.log(`已停用，技能可從備份恢復：${backup}`);
    return;
  }
  const selected = selectRelayImageModels(testAnswer);
  // 舊版技能沒有記錄供應商：那時只有一家，也就是 default。
  const currentProviderId = current ? current.providerId ?? DEFAULT_PROVIDER_ID : null;
  const provider = providers.length === 1
    ? providers[0]
    : await chooseProvider(providers, settings.routes || [], "用哪一家供應商生圖", { preferredId: currentProviderId });
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
  if (!available.length) { console.log("沒找到可用模型。"); return; }
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

export async function configureMillionTokenContext() {
  if (!codexBin) fail("未找到 Codex CLI。");
  const userConfig = await readUserConfig();
  const previous = deepGet(userConfig.config, "model_context_window");
  if (previous.value === 1000000) {
    console.log("全域上下文已是 1,000,000 tokens，無需修改。");
    return;
  }
  const backupDir = join(backupsRoot, `context-1m-${timestamp()}`);
  ensureDirectory(backupDir);
  copyIfExists(userConfig.filePath, join(backupDir, "config.toml"));
  try {
    await writeConfigEdits([{ keyPath: "model_context_window", value: 1000000 }]);
    const verified = await readUserConfig();
    if (deepGet(verified.config, "model_context_window").value !== 1000000) {
      fail("全域上下文配置驗證失敗。");
    }
  } catch (error) {
    try {
      await writeConfigEdits([
        { keyPath: "model_context_window", value: previous.present ? previous.value : null },
      ]);
    } catch (restoreError) {
      console.error(`配置還原失敗：${restoreError.message}；備份：${backupDir}`);
    }
    throw error;
  }
  console.log(`全域 model_context_window 已設為 1000000。備份：${backupDir}`);
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

  await writeConfigEdits(rollbackEdits(manifest.previousConfig));
  stopService();
  removeServiceRegistration();

  const archiveDir = join(backupsRoot, `rollback-${timestamp()}`);
  ensureDirectory(archiveDir);
  try { archiveRelayImageSkill(archiveDir); } catch (error) {
    console.error(`中轉生圖技能未移動：${error.message}`);
  }
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

export const MENU_ITEMS = [
  ["install", "安裝或重新配置"],
  ["update", "更新到最新版本（保留現有配置）"],
  ["add", "添加自訂模型"],
  ["remove", "刪除自訂模型"],
  ["providers", "管理供應商（新增／移除／更換 API Key）"],
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
  ${basename(scriptPath || "codex-model-router.command")} update
  ${basename(scriptPath || "codex-model-router.command")} add
  ${basename(scriptPath || "codex-model-router.command")} remove
  ${basename(scriptPath || "codex-model-router.command")} providers [add|remove|key]
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
路由器安裝成功後可選擇啟用中轉 API 生圖；預設不啟用，之後可從選單第 ${menuNumber("imagegen")} 項添加。

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
它的模型，模型名稱前面帶供應商名稱）；remove 移除一家與它的模型；key 更換某一家的
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
    if (action === "context-1m") await configureMillionTokenContext();
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
