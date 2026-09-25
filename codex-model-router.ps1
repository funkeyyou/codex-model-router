# Codex 模型路由器 —— Windows 安裝器
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1
#   powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 status
#   powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 rollback
#
# 檔案末尾的註解區塊內嵌 installer / router / claude-bridge / imagegen 四段 JavaScript，
# 與 codex-model-router.sh 逐字一致，由 tools/sync-payloads.mjs 同步。

$ErrorActionPreference = 'Stop'

# router.mjs 用 node:zlib 的 zstd 解壓 Codex 送來的請求主體，需要 Node v22.15 起。
$MinimumNodeVersion = [Version] '22.15.0'
$commandArguments = @($args)

function Get-NodeVersion {
  param([string] $Path)
  try {
    $raw = & $Path --version
  } catch {
    return $null
  }
  if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
  $match = [regex]::Match(($raw | Select-Object -First 1), '^v(\d+)\.(\d+)\.(\d+)')
  if (-not $match.Success) { return $null }
  return [Version] ('{0}.{1}.{2}' -f $match.Groups[1].Value, $match.Groups[2].Value, $match.Groups[3].Value)
}

function Get-NodeCandidate {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($env:CODEX_MODEL_ROUTER_NODE_BIN) { [void] $candidates.Add($env:CODEX_MODEL_ROUTER_NODE_BIN) }

  # PATH 上的 Node 優先：Codex 自帶的那份放在帶版本雜湊的目錄裡，
  # 應用升級後路徑會失效，排程工作就會指向已不存在的執行檔。
  $onPath = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($onPath) { [void] $candidates.Add($onPath.Source) }

  if ($env:LOCALAPPDATA) {
    $codexRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex'
    [void] $candidates.Add((Join-Path $codexRoot 'bin\node.exe'))
    foreach ($relative in @('runtimes\cua_node', 'bin')) {
      $parent = Join-Path $codexRoot $relative
      if (-not (Test-Path -LiteralPath $parent -PathType Container)) { continue }
      Get-ChildItem -LiteralPath $parent -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        ForEach-Object {
          [void] $candidates.Add((Join-Path $_.FullName 'bin\node.exe'))
          [void] $candidates.Add((Join-Path $_.FullName 'node.exe'))
        }
    }
  }
  return $candidates
}

function Find-NodeBinary {
  $tooOld = @()
  foreach ($candidate in (Get-NodeCandidate)) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $version = Get-NodeVersion -Path $candidate
    if (-not $version) { continue }
    if ($version -lt $MinimumNodeVersion) {
      $tooOld += ('{0}（v{1}）' -f $candidate, $version)
      continue
    }
    return $candidate
  }
  if ($tooOld.Count -gt 0) {
    throw ("找到的 Node.js 版本過低，需要 v$MinimumNodeVersion 及以上：`n  " + ($tooOld -join "`n  "))
  }
  throw "未找到 Node.js。請先安裝 Codex 桌面版，或安裝 Node.js v$MinimumNodeVersion 及以上。"
}

function Get-EmbeddedSection {
  param([string] $Content, [string] $StartMarker, [string] $EndMarker)
  $start = $Content.IndexOf("`n$StartMarker`n", [StringComparison]::Ordinal)
  if ($start -lt 0) { throw "安裝器中缺少內嵌程式碼段：$StartMarker" }
  $from = $start + $StartMarker.Length + 2
  $end = $Content.IndexOf("`n$EndMarker`n", $from, [StringComparison]::Ordinal)
  if ($end -lt 0) { throw "安裝器中缺少結束標記：$EndMarker" }
  return $Content.Substring($from, $end - $from)
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  Write-Error '此安裝器僅支援 Windows。macOS 請改用 codex-model-router.sh。'
  exit 1
}

$scriptPath = $PSCommandPath
if (-not $scriptPath -or -not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
  Write-Error '無法定位安裝器檔案。請先把腳本儲存到本機，再以 -File 方式執行。'
  exit 1
}

$nodeBin = Find-NodeBinary
$content = [IO.File]::ReadAllText($scriptPath).Replace("`r`n", "`n")
$installerSource = Get-EmbeddedSection -Content $content `
  -StartMarker '__CODEX_MODEL_ROUTER_INSTALLER_JS__' `
  -EndMarker '__CODEX_MODEL_ROUTER_ROUTER_JS__'

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ('codex-model-router-' + [Guid]::NewGuid().ToString('N').Substring(0, 12))
$null = New-Item -ItemType Directory -Path $tempDir
$installerPath = Join-Path $tempDir 'installer.mjs'
[IO.File]::WriteAllText($installerPath, $installerSource, (New-Object Text.UTF8Encoding $false))

$previousOutputEncoding = [Console]::OutputEncoding
$previousInputEncoding = [Console]::InputEncoding
$exitCode = 0
try {
  # Node 一律以 UTF-8 輸出；主控台代碼頁不是 65001 時中文會變亂碼。
  try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch { }
  try { [Console]::InputEncoding = New-Object Text.UTF8Encoding $false } catch { }

  $env:CODEX_MODEL_ROUTER_SCRIPT_PATH = $scriptPath
  $env:CODEX_MODEL_ROUTER_NODE_BIN = $nodeBin

  & $nodeBin $installerPath @commandArguments
  $exitCode = $LASTEXITCODE
} finally {
  try { [Console]::OutputEncoding = $previousOutputEncoding } catch { }
  try { [Console]::InputEncoding = $previousInputEncoding } catch { }
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

if ($commandArguments.Count -eq 0 -and -not [Console]::IsInputRedirected) {
  Write-Host ''
  $null = Read-Host '按 Enter 鍵結束'
}

exit $exitCode

<#
__CODEX_MODEL_ROUTER_INSTALLER_JS__
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
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { Writable } from "node:stream";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const INSTALLER_VERSION = "1.23.0";
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
  const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
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

export function pickerSlug(model) {
  const readable = model
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 44) || "model";
  const digest = createHash("sha256").update(model).digest("hex").slice(0, 8);
  return `custom/${readable}-${digest}`;
}

export function withDefaultModelPrefix(route) {
  if (typeof route?.upstreamModel !== "string" || !route.upstreamModel) return route;
  const model = route.upstreamModel;
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
async function buildRouteForModel(discovery, apiKey, model, log = consoleProbeLog) {
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
        pickerSlug: pickerSlug(model),
        upstreamModel: model,
        displayName: withDefaultModelPrefix({ upstreamModel: model }).displayName || model,
        providerHost: new URL(discovery.apiRoot).host,
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
    pickerSlug: pickerSlug(model),
    upstreamModel: model,
    displayName: withDefaultModelPrefix({ upstreamModel: model }).displayName || model,
    providerHost: new URL(discovery.apiRoot).host,
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

  printHeading(existingManifest ? "重新配置 Codex 模型路由器" : "安裝 Codex 模型路由器");
  const defaultBaseUrl = existingManifest?.baseUrl || env.CODEX_MODEL_ROUTER_BASE_URL || null;
  const baseUrl = normalizeUrl(
    env.CODEX_MODEL_ROUTER_BASE_URL ||
      (await ask("兼容 OpenAI 的 Base URL", defaultBaseUrl)),
  );
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
  const previousRoutes = new Map(
    (existingManifest?.routes || [])
      .filter((route) => route && typeof route.upstreamModel === "string")
      .map((route) => [route.upstreamModel, route]),
  );

  const routes = [];
  const keptModels = [];
  const keptEfforts = [];
  const outcomes = await probeModelsInParallel(selectedModels,
    (model, log) => buildRouteForModel(discovery, apiKey, model, log));
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
  const customModels = orderCustomModelsByDiscovery(
    officialModels,
    routes.map((route, index) => customCatalogEntry(officialModels, route, index)),
    routes,
    discovery.models,
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
  writeJsonAtomic(settingsPath, {
    version: INSTALLER_VERSION,
    apiRoot: discovery.apiRoot,
    baseUrl,
    keychainService,
    keychainAccount: "codex",
    credentialPath: isWindows ? credentialFileFor(keychainService) : null,
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
    routes,
    // 使用者自己調過的旋鈕不能被重裝洗掉。
    ...preservedSettings(),
  });
  if (isWindows && !testMode) assertScriptHostAvailable();
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

    const manifest = {
      version: INSTALLER_VERSION,
      installedAt: new Date().toISOString(),
      baseUrl,
      apiRoot: discovery.apiRoot,
      keychainService,
      keychainAccount: "codex",
      credentialPath: isWindows ? credentialFileFor(keychainService) : null,
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
      routes,
      previousConfig,
      configBackup: backupPath,
      configVersionAfterInstall: writeResult.version || null,
      codexBin,
      nodeBin,
    };
    await waitForPickerModels(routes);
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
  console.log(`配置備份：${backupPath}`);
  if (
    existingManifest?.keychainService &&
    existingManifest.keychainService !== keychainService &&
    !testMode
  ) {
    const removeOldKey = await confirm(
      `是否從${secretStoreLabel}中刪除上一個 Base URL 對應的 API Key？`,
      true,
    );
    if (removeOldKey) {
      deleteApiKey(
        existingManifest.keychainService,
        existingManifest.keychainAccount || "codex",
      );
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
  const baseUrl = settings.baseUrl || manifest.baseUrl;
  const keychainService = settings.keychainService || manifest.keychainService;
  const port = Number(settings.port || manifest.port);
  console.log(`Base URL：${baseUrl}`);
  console.log(`端口：${port}`);
  console.log(`已配置 ${existingRoutes.length} 個自訂模型：`);
  for (const route of existingRoutes) {
    console.log(`  - ${route.displayName || route.upstreamModel}`);
  }

  const apiKey = readApiKey(keychainService);
  console.log("\n正在發現可用模型...");
  const discovery = await discoverApiRoot(baseUrl, apiKey);
  const configured = new Set(existingRoutes.map((route) => route.upstreamModel));
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
    (model, log) => buildRouteForModel(discovery, apiKey, model, log));
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
  const customModels = orderCustomModelsByDiscovery(
    officialModels,
    mergeAddedModels(officialModels, JSON.parse(readFileSync(catalogPath, "utf8")), routes, newRoutes),
    routes,
    discovery.models,
  );
  const combinedCatalog = { ...bundledCatalog, models: [...officialModels, ...customModels] };

  try {
    // 路由器與轉譯層一併刷新，否則 settings.version 會與實際執行的程式碼對不上。
    writeFileSync(routerPath, extractRouterSource(), { mode: 0o600 });
    chmodSync(routerPath, 0o600);
    writeFileSync(bridgePath, loadBridgeSource(), { mode: 0o600 });
    chmodSync(bridgePath, 0o600);
    writeJsonAtomic(catalogPath, combinedCatalog);
    writeJsonAtomic(settingsPath, { ...settings, version: INSTALLER_VERSION, routes });
    writeJsonAtomic(manifestPath, {
      ...manifest,
      version: INSTALLER_VERSION,
      updatedAt: new Date().toISOString(),
      routes,
    });
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

// 更新程式碼並遷移預設顯示名稱，其餘一律沿用。把「能不能更新、更新後的
// 設定長什麼樣」抽成純函式，才驗得到既有路由與使用者旋鈕不會在更新中被洗掉——
// 這正是以前只能走 install 重裝、每次都要重問 Base URL、API Key 與模型的原因。
export function planUpdate(manifest, settings, installerVersion = INSTALLER_VERSION) {
  if (!manifest) return { ok: false, reason: "not-installed" };
  if (!settings || typeof settings !== "object") return { ok: false, reason: "missing-settings" };

  if (!Array.isArray(settings.routes)) return { ok: false, reason: "no-routes" };
  const routes = settings.routes.map(withDefaultModelPrefix);

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
    // 只有預設顯示名稱會補 api/；所有上游 ID、憑證、模型能力與使用者旋鈕保留。
    settings: { ...settings, routes, version: installerVersion },
    manifest: {
      ...manifest, version: installerVersion,
      ...(Array.isArray(manifest.routes) ? { routes: manifest.routes.map(withDefaultModelPrefix) } : {}),
    },
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
  console.log(`Base URL：${settings.baseUrl || manifest.baseUrl}`);
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
export function installRelayImageSkill({ models, aliases = {}, apiMode, root = relaySkillRoot,
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
      routerSettingsPath: settingsFile, models, upstreamModels, apiMode, hashes };
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
async function discoverRelayImageModelNames(settings, apiKey) {
  let response;
  try {
    response = await fetch(`${String(settings.apiRoot).replace(/\/$/, "")}/models`, {
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
  printHeading("中轉 API 生圖");
  console.log("沿用現有中轉 Base URL 與憑證。偵測會實際生圖並依供應商計費；先測通用介面，全部未通過時自動改測 Ark 任務介面。");
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
  const apiKey = readApiKey(settings.keychainService);
  console.log("正在查詢模型名稱與前綴...");
  let names = [];
  try { names = await discoverRelayImageModelNames(settings, apiKey); }
  catch { /* 清單缺失時仍直接測試已選模型。 */ }
  const prefix = inferRelayImagePrefix(names, settings.routes || [], current?.upstreamModels);
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
    discovery = await discoverUsableRelayImages({ candidates, apiRoot: settings.apiRoot, apiKey,
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
  const result = installRelayImageSkill({ models, aliases, apiMode: discovery.apiMode });
  console.log(`已啟用 $router-imagegen：${result.root}`);
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
  const result = installRelayImageSkill({ models: existing.models, aliases: existing.upstreamModels, apiMode: existing.apiMode });
  console.log(`中轉生圖技能已更新${result.preserved.length ? `（保留手動檔案：${result.preserved.join(", ")}）` : ""}。`);
}

async function offerInstalledRelayImagegen() {
  try {
    await offerRelayImagegen({ existing: relayConfig(), refresh: configureRelayImagegen,
      consent: () => input.isTTY ? confirm("是否使用中轉 API 生圖？將新增獨立技能並沿用現有憑證，圖片按供應商計費", false) : false,
      configure: configureRelayImagegen });
  } catch (error) {
    console.error(`路由器已安裝，中轉生圖設定未完成：${error.message}。可稍後從選單第 7 項設定。`);
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
  console.log(`API 根地址：${manifest.apiRoot}`);
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
  if (manifest.routes.length === 0) console.log("  （目前沒有自訂模型，官方模型仍可使用）");
  for (const route of manifest.routes) {
    console.log(`  - ${route.displayName} -> ${route.upstreamModel}`);
  }
  try {
    const imagegen = relayConfig();
    console.log(`中轉 API 生圖：${imagegen ? imagegen.models.join(", ") : "未啟用（可從選單第 7 項添加）"}`);
  } catch (error) { console.log(`中轉 API 生圖：${error.message}`); }
}

async function rollback() {
  const manifest = readManifest();
  if (!manifest) {
    console.log("沒有可回退的安裝。" );
    return;
  }
  printHeading("回退 Codex 模型路由器");
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
    `是否從${secretStoreLabel}中刪除自訂供應商的 API Key？`,
    true,
  );
  if (removeKey) {
    deleteApiKey(manifest.keychainService, manifest.keychainAccount || "codex");
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
  ["hidden-models", "管理隱藏的官方模型"],
  ["context-1m", "設定全域上下文 100 萬"],
  ["imagegen", "中轉 API 生圖（添加／設定）"],
  ["status", "查看狀態"],
  ["rollback", "回退配置"],
  ["exit", "退出"],
];

function help() {
  console.log(`Codex 模型路由器 ${INSTALLER_VERSION}

用法：
  ${basename(scriptPath || "codex-model-router.command")} install
  ${basename(scriptPath || "codex-model-router.command")} update
  ${basename(scriptPath || "codex-model-router.command")} add
  ${basename(scriptPath || "codex-model-router.command")} remove
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
路由器安裝成功後可選擇啟用中轉 API 生圖；預設不啟用，之後可從選單第 7 項添加。

update 用於升級到這支安裝器的版本：只換掉路由器與轉譯層程式碼並重寫服務定義，
沿用已儲存的 Base URL、API Key、連接埠與全部自訂模型，不重問任何設定，
會備份並移除本工具舊版寫入的 model_catalog_json，改由啟動時同步官方清單；其他配置保留。
models.json 仍保留自訂模型與離線回退資料；無前綴的預設名稱會補上 api/。
這是日常升級該用的命令。

add 用於在已有安裝上追加模型：沿用已儲存的 Base URL、API Key 與連接埠，
只探測新選的模型，不會重問設定，也不改動 config.toml。

remove 用於勾選並刪除已配置的自訂模型；刪除前會備份，失敗時還原。
可以刪到零個自訂模型，官方模型、API Key 與中轉生圖設定保留。

hidden-models 用於單獨管理 Codex 內建目錄裡被標成隱藏的官方模型：
只更新 forceListedModels 與模型目錄，保留自訂模型，不需要 Base URL 或 API Key。

imagegen 用於添加／設定中轉生圖技能 $router-imagegen，沿用現有憑證，不需 OPENAI_API_KEY。
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

__CODEX_MODEL_ROUTER_ROUTER_JS__
import http from "node:http";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import tls from "node:tls";
import { readFileSync, mkdirSync, writeFileSync, appendFileSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { zstdDecompressSync } from "node:zlib";
import {
  toAnthropicRequest,
  bridgeAnthropicStream,
  decodeCompaction,
  codexErrorFromUpstream,
  COMPACTION_REPLAY_PREFIX,
} from "./claude-bridge.mjs";

const routerDirectory = dirname(fileURLToPath(import.meta.url));
const settingsPath = join(routerDirectory, "settings.json");
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
const listenHost = "127.0.0.1";
const listenPort = Number(settings.port);
const apiRoot = String(settings.apiRoot).replace(/\/$/, "");
const officialBase = String(settings.officialBaseUrl).replace(/\/$/, "");
const keychainService = settings.keychainService;
const keychainAccount = settings.keychainAccount || "codex";
const credentialPath = settings.credentialPath || null;
const routeMap = new Map(settings.routes.map((route) => [route.pickerSlug, route]));
const execFileAsync = promisify(execFile);
const tokenCacheTtlMs = 5 * 60 * 1000;
// Windows 以密文檔的修改時間判斷 Key 有沒有換，快取可以放久一點。
const credentialCacheTtlMs = 12 * 60 * 60 * 1000;
const authValidationTtlMs = 5 * 60 * 1000;
const maxRememberedThreads = 2048;
const maxValidatedAuthDigests = 64;
const maxPendingMessages = 8;
const maxHttpBodyBytes = Number.isSafeInteger(settings.maxHttpBodyBytes) && settings.maxHttpBodyBytes > 0
  ? Math.min(settings.maxHttpBodyBytes, 512 * 1024 * 1024) : 128 * 1024 * 1024;

// 在 Buffer.concat / 解壓 / JSON.parse 之前限制接收量；不可截掉內容後繼續送模型。
export async function readRequestBody(request, limit = maxHttpBodyBytes) {
  const chunks = [];
  let bytes = 0;
  const input = request.iterator ? request.iterator({ destroyOnReturn: false }) : request;
  for await (const chunk of input) {
    bytes += chunk.length;
    if (bytes > limit) throw new RouterRequestError(413, "router_request_too_large", "本機接收的請求過大，請縮小附件或分批處理。", "request");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function decodeRequestBody(raw, encoding, limit = maxHttpBodyBytes) {
  if (encoding && encoding !== "identity" && encoding !== "zstd") {
    throw new RouterRequestError(415, "unsupported_content_encoding", "不支援的請求內容編碼。", "request");
  }
  if (raw.length > limit) throw new RouterRequestError(413, "router_request_too_large", "本機接收的請求過大。", "request");
  if (encoding !== "zstd") return raw;
  try { return zstdDecompressSync(raw, { maxOutputLength: limit }); }
  catch (error) {
    if (error.code === "ERR_BUFFER_TOO_LARGE") throw new RouterRequestError(413, "router_request_too_large", "解壓後的請求過大，請縮小附件。", "request");
    throw new RouterRequestError(400, "invalid_compressed_body", "無法解壓請求內容。", "request");
  }
}
// --- 診斷用擷取（settings.captureDir 有值時才啟用，預設關閉）---
const captureDir = typeof settings.captureDir === "string" && settings.captureDir
  ? settings.captureDir
  : null;
let captureSeq = 0;
function captureNext(kind) {
  if (!captureDir) return null;
  const id = `${String(++captureSeq).padStart(3, "0")}-${kind}`;
  try { mkdirSync(captureDir, { recursive: true }); } catch {}
  return id;
}
function captureWrite(id, suffix, data) {
  if (!captureDir || !id) return;
  try { writeFileSync(join(captureDir, `${id}.${suffix}`), data); } catch {}
}
function captureAppend(id, suffix, data) {
  if (!captureDir || !id) return;
  try { appendFileSync(join(captureDir, `${id}.${suffix}`), data); } catch {}
}

const closeOnUpstreamError = settings.closeOnUpstreamError === true;

// 上游對單次請求有尺寸上限（Anthropic 的 Messages API 是 32 MB）。超過時閘道只會
// 回一個通用的 5xx，客戶端看不出原因，而且會一直重試——每次重試都把整份歷史再上傳
// 一遍。實測一條長對話：完整歷史 37.6 MB，其中 91% 是累積的工具輸出，重試 31 次等於
// 白傳 1.1 GB，而且不可能成功。這裡在送出前就擋下來，並且說清楚是什麼原因。
//
// 只擋自訂路由：官方後端的上限不同，不該拿 Anthropic 的數字去限制它。
const maxUpstreamRequestBytes =
  Number(settings.maxUpstreamRequestBytes) > 0
    ? Number(settings.maxUpstreamRequestBytes)
    : 32 * 1024 * 1024;

export function upstreamRequestTooLarge(bytes, limit = maxUpstreamRequestBytes) {
  return Number.isFinite(bytes) && bytes > limit;
}

export function oversizeMessage(bytes, limit) {
  const mb = (value) => (value / (1024 * 1024)).toFixed(1);
  return (
    `這一輪要送往上游的請求仍有 ${mb(bytes)} MB，超過路由器設定的 ${mb(limit)} MB 上限。` +
    "已嘗試縮減舊工具截圖；使用者圖片、近期截圖與文字內容會保留。" +
    "請縮小近期圖片或附件，或將工作摘要帶到新對話；重試相同內容不會解除限制。"
  );
}

// token 預算無法控制 Base64 圖片的傳輸大小。先以最終上游 JSON 的 75% 上限
// 作為目標，為後續工具往返留空間；只替換較舊的工具截圖，不碰使用者附件與文字。
const recentToolImagesToKeep = 4;
const historyImageDirectory = join(routerDirectory, "history-images");

function inlineToolImage(block) {
  if (block?.type === "image" && block.source?.type === "base64") {
    return { data: block.source.data, mediaType: block.source.media_type };
  }
  if (block?.type !== "input_image") return null;
  const url = block.image_url ?? block.url;
  if (typeof url !== "string") return null;
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
  return match ? { data: match[2], mediaType: match[1] } : null;
}

// 省略前保存原始圖片，檔名依內容定址，重試不會反覆寫出相同圖片。
// 不下載 URL、不修改 Codex 歷史；若無法保存就留下圖片，不能給出不存在的回讀路徑。
export function archiveHistoryImage(image, directory = historyImageDirectory) {
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[image?.mediaType];
  if (!extension || typeof image.data !== "string" || !image.data) return null;
  const buffer = Buffer.from(image.data, "base64");
  if (!buffer.length || buffer.toString("base64") !== image.data) return null;
  const digest = createHash("sha256").update(buffer).digest("hex");
  const target = join(directory, `${digest}.${extension}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(target, buffer, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST" || !readFileSync(target).equals(buffer)) throw error;
  }
  return target;
}

function toolImageSlots(payload, anthropic) {
  const slots = [];
  const walk = (blocks, group) => {
    if (!Array.isArray(blocks)) return;
    blocks.forEach((block, index) => {
      const image = inlineToolImage(block);
      if (image) slots.push({ blocks, index, image, group });
      else if (Array.isArray(block?.content)) walk(block.content, group);
    });
  };
  if (anthropic) {
    for (const message of payload.messages || []) {
      for (const block of message.content || []) {
        if (block.type === "tool_result") walk(block.content, block);
      }
    }
  } else if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      if (item?.call_id && ["function_call_output", "custom_tool_call_output"].includes(item.type)) {
        walk(item.output, item);
      }
    }
  }
  return slots;
}

export function budgetToolImages(payload, {
  anthropic = false,
  maxBytes = maxUpstreamRequestBytes,
  archive = archiveHistoryImage,
} = {}) {
  const originalBuffer = Buffer.from(JSON.stringify(payload));
  const result = {
    request: payload, buffer: originalBuffer, originalBytes: originalBuffer.length,
    imagesOmitted: 0, bytesSaved: 0, archiveFailures: 0,
  };
  const targetBytes = Math.floor(maxBytes * 0.75);
  if (!Number.isFinite(targetBytes) || targetBytes <= 0 || originalBuffer.length <= targetBytes) return result;

  // 只改送出的副本。Codex 與本機的增量重建仍保留完整歷史，之後可重新讀圖。
  const copy = structuredClone(payload);
  const slots = toolImageSlots(copy, anthropic);
  const latestGroup = slots.at(-1)?.group;
  let bytes = originalBuffer.length;
  for (const slot of slots.slice(0, -recentToolImagesToKeep)) {
    if (bytes <= targetBytes) break;
    // 最新一次工具結果中的圖片可能是一組比較圖，整組保留，即使超過四張。
    if (slot.group === latestGroup) continue;
    const originalSize = Buffer.byteLength(JSON.stringify(slot.blocks[slot.index]));
    if (originalSize < 1024) continue;
    let savedPath;
    try { savedPath = archive(slot.image); } catch { /* 保留無法封存的圖片。 */ }
    if (typeof savedPath !== "string" || !savedPath) {
      result.archiveFailures += 1;
      continue;
    }
    const replacement = {
      type: anthropic ? "text" : "input_text",
      text: `(較舊的工具截圖已移出本輪請求以控制大小；原圖：${savedPath}。需要細節時可重新讀取原圖。)`,
    };
    const saved = originalSize - Buffer.byteLength(JSON.stringify(replacement));
    if (saved <= 0) continue;
    slot.blocks[slot.index] = replacement;
    bytes -= saved;
    result.imagesOmitted += 1;
  }
  if (result.imagesOmitted) {
    result.request = copy;
    result.buffer = Buffer.from(JSON.stringify(copy));
    result.bytesSaved = originalBuffer.length - result.buffer.length;
  }
  return result;
}

function recordImageBudget(result) {
  stats.toolImagesOmitted += result.imagesOmitted;
  stats.toolImageBytesSaved += result.bytesSaved;
  stats.imageArchiveFailures += result.archiveFailures;
  stats.lastRequestBytesBeforeBudget = result.originalBytes;
  stats.lastRequestBytesAfterBudget = result.buffer.length;
  if (result.imagesOmitted || result.archiveFailures) {
    process.stderr.write(
      `model-router-image-budget:${result.originalBytes}->${result.buffer.length}` +
      ` omitted=${result.imagesOmitted} archiveFailures=${result.archiveFailures}\n`,
    );
  }
}

// --- 模型目錄的自動更新 -----------------------------------------------------
//
// Codex 啟動時透過 /models 取得清單。官方資料必須來自該請求的帳號，不能只用
// bundled 快照，也不能跨重啟用 TTL 略過查詢。models.json 保留作為離線回退及
// 自訂模型的來源，不再由 model_catalog_json 鎖住 Codex 的模型管理器。
const catalogRefreshEnabled = settings.catalogRefresh !== false;

// 官方項目整批換新，自訂項目沿用檔案裡既有的那份——那是安裝時探測出來的結果，
// 路由器沒有重新探測的條件，也不該重複實作 customCatalogEntry（複製一份必然漂移）。
export function mergeCatalog(freshCatalog, currentCatalog, forceListed = []) {
  const isCustom = (model) => String(model?.slug || "").startsWith("custom/");
  const forced = new Set(forceListed);
  const official = (freshCatalog?.models || [])
    .filter((model) => !isCustom(model))
    // bundled 目錄把尚未普及的模型標成 hide，實際能不能用是後端依帳號決定的。
    // model_catalog_json 會蓋掉那個決定，於是帳號明明有權限也看不到（手機看得到
    // 就是因為它直接問後端）。這裡讓使用者把特定模型強制列出來。
    .map((model) => (forced.has(model.slug) ? { ...model, visibility: "list" } : model));
  const custom = (currentCatalog?.models || []).filter(isCustom);
  if (official.length === 0) throw new Error("bundled 目錄沒有官方模型");
  // 自訂項目要排在新的官方模型之後，否則新模型會把它們擠掉。
  const maxPriority = Math.max(0, ...official.map((model) => Number(model.priority) || 0));
  const renumbered = custom.map((model, index) => ({
    ...model,
    priority: maxPriority + index + 1,
  }));
  return { ...freshCatalog, models: [...official, ...renumbered] };
}

export function mergeOfficialCatalog(fresh, current, forceListed = []) {
  // 拒絕截斷、空清單、重複或冒充自訂模型的資料，不讓壞回應覆寫離線備份。
  const seen = new Set();
  if (!Array.isArray(fresh?.models) || !fresh.models.length) throw new Error("invalid_catalog");
  for (const model of fresh.models) {
    if (typeof model?.slug !== "string" || !model.slug || model.slug.startsWith("custom/") ||
        seen.has(model.slug) || typeof model.display_name !== "string" ||
        !["list", "hide"].includes(model.visibility) || !Array.isArray(model.supported_reasoning_levels)) {
      throw new Error("invalid_catalog");
    }
    seen.add(model.slug);
  }
  // 只有使用者明確要求強制顯示的舊項目可補回；其他官方項目以帳號最新清單為準。
  const forced = new Set(forceListed);
  const retained = (current.models || []).filter(m => forced.has(m.slug) &&
    !m.slug.startsWith("custom/") && !seen.has(m.slug));
  return mergeCatalog({ ...fresh, models: [...fresh.models, ...retained] }, current, forceListed);
}

// 只合併同帳號、同 client_version 同時進行的查詢；完成後立刻移除，不會讓下一次
// Codex 啟動命中路由器的舊快取。憑證只存在本次 fetch，不寫檔也不寫日誌。
const catalogRequests = new Map();
export async function refreshOfficialCatalog(requestHeaders, searchParams, fetchImpl = fetch) {
  const current = () => JSON.parse(readFileSync(settings.catalogPath, "utf8"));
  if (!catalogRefreshEnabled) return current();
  const incoming = new Headers(requestHeaders);
  const authorization = incoming.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return current();
  const version = searchParams.get("client_version");
  if (!version || !/^[0-9A-Za-z.+_-]{1,80}$/.test(version)) return current();
  const headers = new Headers({ authorization, accept: "application/json" });
  for (const name of ["chatgpt-account-id", "openai-organization", "openai-project", "user-agent", "originator"]) {
    if (incoming.has(name)) headers.set(name, incoming.get(name));
  }
  const key = createHash("sha256").update(JSON.stringify([...headers])).update(version).digest("hex");
  if (catalogRequests.has(key)) return catalogRequests.get(key);
  // 本機異常客戶端也不能製造無上限的背景查詢。
  if (catalogRequests.size >= 8) return current();
  const pending = (async () => {
    let status = null;
    try {
      const url = new URL(`${officialBase}/models`);
      url.searchParams.set("client_version", version);
      const upstream = await fetchImpl(url, { headers, redirect: "manual", signal: AbortSignal.timeout(10000) });
      status = upstream.status;
      if (!upstream.ok) { await upstream.body?.cancel(); throw new Error("upstream_status"); }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of upstream.body) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) throw new Error("catalog_too_large");
        chunks.push(chunk);
      }
      // 網路等待期間安裝器可能添加了模型；合併前重讀，不覆蓋它剛完成的變更。
      const before = current();
      const merged = mergeOfficialCatalog(JSON.parse(Buffer.concat(chunks).toString("utf8")), before,
        Array.isArray(settings.forceListedModels) ? settings.forceListedModels : []);
      if (JSON.stringify(merged) !== JSON.stringify(before)) {
        const temporary = settings.catalogPath + ".tmp";
        writeFileSync(temporary, JSON.stringify(merged), { mode: 0o600 });
        renameSync(temporary, settings.catalogPath);
      }
      stats.catalogRefreshes += 1;
      stats.catalogModels = merged.models.length;
      stats.lastCatalogSync = { source: "official", status, at: new Date().toISOString() };
      return merged;
    } catch {
      stats.catalogRefreshFailures += 1;
      stats.lastCatalogSync = { source: "cache", status, at: new Date().toISOString() };
      process.stderr.write(`model-router-catalog-refresh-failed:status=${status ?? "unavailable"};using-cache\n`);
      return current();
    }
  })();
  catalogRequests.set(key, pending);
  try { return await pending; }
  finally { catalogRequests.delete(key); }
}

// --- 生圖結果的轉譯 ---------------------------------------------------------
//
// 部分閘道會自己啟用 image_generation，回應裡因此帶著 image_generation_call
// 與整張圖的 base64。Codex 收得到、也會原樣存進歷史再送回來，但它只在自己
// 主動要求生圖時才有顯示路徑，於是圖就這樣沉在歷史裡，使用者永遠看不到。
//
// 這裡把它翻成 Codex 本來就會顯示的東西：把圖落地成檔案，再合成一個
// view_image 工具呼叫（view_image 是 Codex 的內建用戶端工具）。
//
// 連鎖問題：Codex 執行完會把 function_call_output 送回來，但上游從沒宣告過
// 這個工具，原樣轉發會讓下一輪被拒。因此本機合成的呼叫用可辨識的 call_id
// 前綴，送往上游前連同它的輸出一起剝掉——與既有的 stripBridgeArtifacts 同一套路。
const viewImageBridgeEnabled = settings.viewImageBridge !== false;
const imageOutputDir =
  typeof settings.imageOutputDir === "string" && settings.imageOutputDir
    ? settings.imageOutputDir
    : join(homedir(), "Downloads");
const ROUTER_IMAGE_CALL_PREFIX = "call_rtrimg_";

// 只認副檔名，不做完整解析：認不出來就當 png，反正 Codex 是靠內容判讀。
function imageExtension(buffer) {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
  if (buffer.length >= 12 && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (buffer.length >= 6 && buffer.subarray(0, 3).toString("latin1") === "GIF") return "gif";
  return "png";
}

export function saveGeneratedImage(item, directory = imageOutputDir) {
  if (typeof item?.result !== "string" || item.result.length < 32) return null;
  let buffer;
  try {
    buffer = Buffer.from(item.result, "base64");
  } catch {
    return null;
  }
  if (buffer.length < 16) return null;
  try {
    mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const target = join(
      directory,
      `codex-image-${stamp}-${randomBytes(3).toString("hex")}.${imageExtension(buffer)}`,
    );
    writeFileSync(target, buffer);
    return target;
  } catch {
    return null;
  }
}

// 本機合成的 view_image 呼叫，供上游剝除時辨識。
export function isRouterImageCallId(value) {
  return typeof value === "string" && value.startsWith(ROUTER_IMAGE_CALL_PREFIX);
}

// 上游沒有這個工具，因此本機合成的呼叫與它的輸出都不能送出去。
export function stripRouterImageCalls(input) {
  if (!Array.isArray(input)) return { input, removed: 0 };
  const kept = input.filter(
    (item) => !(item && typeof item === "object" && isRouterImageCallId(item.call_id)),
  );
  const removed = input.length - kept.length;
  // 與其他剝除函式一致：沒有要動的東西就回傳原陣列，不做無謂配置。
  return { input: removed > 0 ? kept : input, removed };
}

// 官方後端支援 Responses 的 WebSocket 模式：同一條上游連線可以用
// previous_response_id 接續，每輪只送新項目，不必重送完整歷史。
// 設 settings.upstreamWebSocket = false 可退回全 HTTP 行為。
const upstreamWebSocketEnabled = settings.upstreamWebSocket !== false;

// 上游 WebSocket 不通時的全域冷卻。
//
// upstreamDisabled 只記在單一條 Codex 連線上，所以上游持續回 404 的期間，
// 每開一條新連線都會再賠一次 TLS 連線加握手才回退——成本落在每個新對話的
// 第一輪。這裡改記在模組層：連續失敗達門檻就整個路由器暫停嘗試一段時間，
// 期間直接走 HTTP，時間到再放行一次探測。
// 握手成功會立刻清除，所以上游恢復後最多只慢一個冷卻週期。
const upstreamWebSocketFailureThreshold =
  Number(settings.upstreamWebSocketFailureThreshold) > 0
    ? Number(settings.upstreamWebSocketFailureThreshold)
    : 2;
const upstreamWebSocketCooldownMs =
  Number(settings.upstreamWebSocketCooldownMs) > 0
    ? Number(settings.upstreamWebSocketCooldownMs)
    : 5 * 60 * 1000;
let upstreamWebSocketFailureStreak = 0;
let upstreamWebSocketCooldownUntil = 0;

export function upstreamWebSocketInCooldown() {
  if (upstreamWebSocketCooldownUntil === 0) return false;
  if (Date.now() < upstreamWebSocketCooldownUntil) return true;
  // 冷卻到期：放行一次探測。成功就清零，失敗會再進一次冷卻。
  upstreamWebSocketCooldownUntil = 0;
  upstreamWebSocketFailureStreak = 0;
  return false;
}

export function noteUpstreamWebSocketConnectFailure() {
  upstreamWebSocketFailureStreak += 1;
  if (upstreamWebSocketFailureStreak < upstreamWebSocketFailureThreshold) return;
  upstreamWebSocketCooldownUntil = Date.now() + upstreamWebSocketCooldownMs;
  stats.upstreamWebSocketCooldowns += 1;
  process.stderr.write(
    "model-router-upstream-ws-cooldown:" +
      `連續 ${upstreamWebSocketFailureStreak} 次握手失敗，暫停 ` +
      `${Math.round(upstreamWebSocketCooldownMs / 1000)} 秒內的上游 WebSocket 嘗試\n`,
  );
}

export function noteUpstreamWebSocketConnected() {
  upstreamWebSocketFailureStreak = 0;
  upstreamWebSocketCooldownUntil = 0;
}

// Codex 的 WebSocket response.create 訊息含有若干「協定層」欄位，它們在
// WebSocket 上合法，但不是 HTTP Responses API 的參數。本路由對上游一律使用
// HTTP，若原樣轉送，上游會回 "Unsupported parameter: ..." 並導致預熱與工具
// 接續回合失敗（官方後端與第三方閘道皆然）。
const websocketOnlyFields = [
  "generate",
  "ws_request_header_traceparent",
  "ws_request_header_trace",
];

// --- 有狀態接續的本機重建 ---------------------------------------------------
// Codex 在工具接續回合只送工具結果並倚賴伺服器保存狀態（previous_response_id），
// 但部分閘道不支援。由於 Codex 自己仍持有完整歷史（下一個完整請求會補齊），
// 這裡以「上次完整輸入 + 該輪產生的輸出 + 本次新項目」在本機重建等價請求。
const threadHistories = new Map();
const maxRememberedHistories = 32;
const maxResponsesPerHistory = 4;
const maxHistoryBytes = Number.isSafeInteger(settings.maxHistoryBytes) && settings.maxHistoryBytes > 0
  ? settings.maxHistoryBytes : 128 * 1024 * 1024;
const historyTtlMs = Number.isSafeInteger(settings.historyTtlMs) && settings.historyTtlMs > 0
  ? settings.historyTtlMs : 30 * 60 * 1000;

export function historyCacheInfo(now = Date.now()) {
  let bytes = 0;
  let count = 0;
  for (const [key, responses] of threadHistories) {
    for (const [id, history] of responses) {
      if (history.expiresAt <= now) responses.delete(id);
      else { bytes += history.bytes; count += 1; }
    }
    if (!responses.size) threadHistories.delete(key);
  }
  return { bytes, count, maxBytes: maxHistoryBytes, ttlMs: historyTtlMs };
}

// 轉譯層為了讓 Anthropic 的 thinking 簽章能往返，把 {thinking, signature}
// 編碼進 reasoning 的 encrypted_content。官方後端驗不過這種內容
// （The encrypted content for item ... could not be verified），
// 因此送往非 Anthropic 路由時必須先剝除，否則碰過 Claude 的對話就切不回官方。
function isBridgeReasoning(item) {
  if (item?.type !== "reasoning") return false;
  const enc = item.encrypted_content;
  if (typeof enc !== "string" || !enc) return false;
  try {
    const parsed = JSON.parse(Buffer.from(enc, "base64").toString("utf8"));
    return Boolean(parsed && (
      (typeof parsed.thinking === "string" && parsed.signature) ||
      typeof parsed.redacted_thinking === "string" ||
      (parsed.router_reasoning_ref === 1 && /^[a-f0-9]{64}$/.test(parsed.sha256))
    ));
  } catch {
    return false;
  }
}

export function stripBridgeReasoning(input) {
  if (!Array.isArray(input)) return { input, removed: 0 };
  const kept = input.filter((item) => !isBridgeReasoning(item));
  return { input: kept, removed: input.length - kept.length };
}

// 轉譯層必須替它合成的 message / function_call 補上 item id（串流協定要求），
// 但那是本機隨機鑄的混合大小寫字串。官方後端只認自己發過的 id 格式，會整輪回
// Invalid 'input[n].id'：碰過 Claude 的對話一切回官方模型就卡死。
// 上游發的 id 一律是小寫十六進位，因此「後綴帶大寫」足以辨識出自鑄的 id。
// 這裡只拿掉 id 欄位而不動整個項目：Responses API 的輸入項本來就可以沒有 id，
// 工具配對靠的是 call_id，內容因此完整保留。
export function isBridgeMintedId(value) {
  if (typeof value !== "string") return false;
  const match = /^(?:msg|fc|rs|resp|cmp)_([A-Za-z0-9]{20,})$/.exec(value);
  return match !== null && /[A-Z]/.test(match[1]);
}

export function stripBridgeItemIds(input) {
  if (!Array.isArray(input)) return { input, removed: 0 };
  let removed = 0;
  const mapped = input.map((item) => {
    if (!item || typeof item !== "object" || !isBridgeMintedId(item.id)) {
      return item;
    }
    removed += 1;
    const { id, ...rest } = item;
    return rest;
  });
  return { input: removed > 0 ? mapped : input, removed };
}

// 轉譯層自己合成的 compaction 項目，其 encrypted_content 只有本機解得開。
// 官方後端與其他供應商都認不得，必須在離開 Anthropic 路由前還原成一般訊息，
// 否則壓縮過的對話一切回官方模型就整輪被拒。
export function rewriteBridgeCompaction(input) {
  if (!Array.isArray(input)) return { input, removed: 0 };
  let removed = 0;
  const mapped = input.map((item) => {
    if (item?.type !== "compaction" && item?.type !== "context_compaction") return item;
    const summary = decodeCompaction(item.encrypted_content);
    if (summary === null) return item;
    removed += 1;
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${COMPACTION_REPLAY_PREFIX}${summary}` }],
    };
  });
  return { input: removed > 0 ? mapped : input, removed };
}

export function historyKeyFor(body, headers, connectionNamespace = null) {
  const sessionId = body?.client_metadata?.session_id;
  let logicalKey = typeof sessionId === "string" && sessionId ? sessionId : null;
  for (const name of ["thread-id", "session-id"]) {
    const value = headers?.[name];
    if (!logicalKey && typeof value === "string" && value) logicalKey = value;
  }
  // client_metadata.session_id 不是 WebSocket 連線識別；背景任務可能和目前 task
  // 重複使用它。歷史重建若只靠 session_id，兩條連線會互相覆蓋完整提示詞。
  // WebSocket 路徑因此以連線 namespace 隔離；HTTP 才沿用既有 logical key。
  if (connectionNamespace) {
    return logicalKey ? `${connectionNamespace}\0${logicalKey}` : connectionNamespace;
  }
  return logicalKey;
}

// 每次嘗試持有自己的暫存副本。只有成功終止才保存，失敗、取消或換傳輸重送
// 都不會改到 previous_response_id 指向的歷史，也不會把同一份工具結果再加一次。
function prepareHistory(key, input, previousId = null) {
  if (!key) return null;
  const items = typeof input === "string" ? [{ role: "user", content: input }] : input;
  return { key, input: Array.isArray(items) ? items.slice() : [], output: [], previousId };
}

function rememberHistoryEvent(history, event) {
  if (!history || history.completed || history.disabled) return;
  const replayable = (item) => item && typeof item === "object" &&
    (item.type !== "reasoning" || item.encrypted_content);
  if (event?.type === "response.output_item.done" && replayable(event.item)) {
    history.outputBytes = (history.outputBytes || 0) + Buffer.byteLength(JSON.stringify(event.item));
    if (history.outputBytes > maxHistoryBytes) {
      history.disabled = true;
      history.input = [];
      history.output = [];
      return;
    }
    history.output.push(event.item);
  }
  if (event?.type !== "response.completed" && event?.type !== "response.incomplete") return;
  const responseId = event.response?.id;
  if (typeof responseId !== "string" || !responseId) return;
  if (Array.isArray(event.response.output) && event.response.output.length) {
    history.output = event.response.output.filter(replayable);
  }
  history.completed = true;
  historyCacheInfo();
  const serialized = JSON.stringify({ input: history.input, output: history.output });
  // 用位元組計帳的不可變快照，避免共享物件被後續轉譯修改；超限不保存半份歷史。
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maxHistoryBytes) return;
  const snapshot = { serialized, bytes, expiresAt: Date.now() + historyTtlMs };
  const responses = history.previousId
    ? threadHistories.get(history.key) || new Map()
    : new Map();
  responses.delete(responseId);
  responses.set(responseId, snapshot);
  while (responses.size > maxResponsesPerHistory) responses.delete(responses.keys().next().value);
  threadHistories.delete(history.key);
  threadHistories.set(history.key, responses);
  while (threadHistories.size > maxRememberedHistories) {
    threadHistories.delete(threadHistories.keys().next().value);
  }
  let total = historyCacheInfo().bytes;
  while (total > maxHistoryBytes) {
    const [key, oldest] = threadHistories.entries().next().value;
    const [id, snapshot] = oldest.entries().next().value;
    total -= snapshot.bytes;
    oldest.delete(id);
    if (!oldest.size) threadHistories.delete(key);
  }
}

function rebuildStatefulInput(key, incomingInput, previousId) {
  historyCacheInfo();
  const snapshot = key ? threadHistories.get(key)?.get(previousId) : null;
  const history = snapshot ? JSON.parse(snapshot.serialized) : null;
  if (!history || history.input.length === 0) return null;
  const incoming = typeof incomingInput === "string" ? [{ role: "user", content: incomingInput }]
    : Array.isArray(incomingInput) ? incomingInput : [];
  return [...history.input, ...history.output, ...incoming];
}

// 從 Claude 轉譯路由切出去時，必須清掉轉譯層合成的內容，否則官方與其他供應商
// 會整輪拒收。官方路由不論走 HTTP 或 WebSocket 都要做這一步。
function stripBridgeArtifacts(body) {
  let result = body;
  const stripped = stripBridgeReasoning(result.input);
  if (stripped.removed > 0) {
    result = { ...result, input: stripped.input };
    stats.bridgeReasoningStripped += stripped.removed;
  }
  const reidentified = stripBridgeItemIds(result.input);
  if (reidentified.removed > 0) {
    result = { ...result, input: reidentified.input };
    stats.bridgeIdsStripped += reidentified.removed;
  }
  const recompacted = rewriteBridgeCompaction(result.input);
  if (recompacted.removed > 0) {
    result = { ...result, input: recompacted.input };
    stats.bridgeCompactionRewritten += recompacted.removed;
  }
  return result;
}

// 本機合成的 view_image 呼叫與它的輸出不能送去上游——那個工具是路由器自己
// 生出來的，上游不認得。所有離開本機的請求都要先過這一關。
function stripRouterImageArtifacts(body) {
  const stripped = stripRouterImageCalls(body?.input);
  if (stripped.removed === 0) return body;
  stats.viewImageCallsStripped += stripped.removed;
  return { ...body, input: stripped.input };
}
const heartbeatIntervalMs =
  Number(settings.heartbeatIntervalMs) > 0 ? Number(settings.heartbeatIntervalMs) : 15000;

const requestHopByHopHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const responseHeadersToStrip = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);
const customForwardHeaders = new Set([
  "accept",
  "content-type",
  "user-agent",
  "x-client-request-id",
]);

const stats = {
  startedAt: new Date().toISOString(),
  requests: 0,
  websockets: 0,
  websocketResponses: 0,
  websocketEvents: 0,
  heartbeats: 0,
  authProbeFailures: 0,
  authProbeGraceUsed: 0,
  upstreamErrorCloses: 0,
  statefulFallbacks: 0,
  responseFailedSent: 0,
  truncatedUpstreamStreams: 0,
  upstreamErrorsWithoutTerminal: 0,
  oversizeRejects: 0,
  toolImagesOmitted: 0,
  toolImageBytesSaved: 0,
  imageArchiveFailures: 0,
  lastRequestBytesBeforeBudget: null,
  lastRequestBytesAfterBudget: null,
  websocketOnlyFieldsStripped: 0,
  queuedResponses: 0,
  responseInProgressRejects: 0,
  bridgeReasoningStripped: 0,
  bridgeIdsStripped: 0,
  bridgeCompactionRewritten: 0,
  statefulRebuilds: 0,
  statefulRebuildMisses: 0,
  upstreamWebSocketConnects: 0,
  upstreamWebSocketTurns: 0,
  upstreamWebSocketIncremental: 0,
  upstreamWebSocketReplays: 0,
  upstreamWebSocketFallbacks: 0,
  upstreamWebSocketCooldowns: 0,
  imagesSaved: 0,
  imageRequests: 0,
  arkImageRequests: 0,
  catalogRefreshes: 0,
  catalogRefreshFailures: 0,
  catalogModels: 0,
  lastImageStatus: null,
  viewImageCallsInjected: 0,
  viewImageCallsStripped: 0,
  translatedRequests: 0,
  claudeToolDefinitionsDeferred: 0,
  claudeToolDescriptionCharsSaved: 0,
  lastClaudeToolContext: null,
  imagesOmitted: 0,
  officialPassthroughs: 0,
  trailingThinkingTrimmed: 0,
  claudeToolOutputsMerged: 0,
  claudeLateToolOutputs: 0,
  claudeToolResultsReordered: 0,
  lastAuthProbeStatus: null,
  credentialReads: 0,
  foreignHostRejects: 0,
  browserRequestsRejected: 0,
  models: 0,
  official: 0,
  custom: 0,
  reasoningRewrites: 0,
  failures: 0,
  lastOfficialStatus: null,
  lastCustomStatus: null,
  lastWebSocketStatus: null,
  lastRoute: null,
  lastModel: null,
  lastReasoningEffort: null,
  lastForwardedReasoningEffort: null,
  lastError: null,
};
const validatedAuthDigests = new Map();
// 驗證探測只是用來證明呼叫端是已登入的 Codex。chatgpt.com 暫時連不上（網路、代理、
// 官方故障）時，不該連帶讓中轉模型也不能用——那正是最需要中轉當備援的時候。
// 同一組憑證在寬限期內真的驗證成功過，探測遇到網路錯誤或 401/403 以外的失敗就放行；
// 401/403 代表憑證本身被拒，照樣拒絕並清掉寬限紀錄。
const authProbeGraceMs = Number.isSafeInteger(settings.authProbeGraceMs) && settings.authProbeGraceMs >= 0
  ? settings.authProbeGraceMs : 24 * 60 * 60 * 1000;
const lastAuthSuccess = new Map();
const threadRoutes = new Map();

class RouterRequestError extends Error {
  constructor(status, code, message, phase = "request", upstreamStatus = null) {
    super(message);
    Object.assign(this, { status, code, phase, upstreamStatus });
  }
}

export function describeRouterError(error) {
  if (error?.name === "BridgeRequestError") {
    return { status: 422, code: "unsupported_bridge_input", message: error.message, phase: "translation", upstreamStatus: null, causeCode: null };
  }
  if (error instanceof RouterRequestError) {
    const { status, code, message, phase, upstreamStatus } = error;
    return { status, code, message, phase, upstreamStatus, causeCode: null };
  }
  const chain = [];
  const visit = (value, depth = 0) => {
    if (!value || depth > 5 || chain.includes(value)) return;
    chain.push(value);
    visit(value.cause, depth + 1);
    for (const nested of Array.isArray(value.errors) ? value.errors.slice(0, 8) : []) {
      visit(nested, depth + 1);
    }
  };
  visit(error);
  const codes = chain.map((item) => item.code).filter(
    (code) => typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code),
  );
  let status = 502;
  let code = "upstream_network_error";
  let message = "無法完成上游請求，請檢查網路或稍後重試。";
  let causeCode = codes.find((value) => /TIMEOUT|ETIMEDOUT/.test(value));
  if (causeCode || chain.some((item) => item.name === "TimeoutError")) {
    status = 504;
    code = "upstream_timeout";
    message = "上游請求逾時，請檢查網路或稍後重試。";
  } else if ((causeCode = codes.find((value) => /^(ENOTFOUND|EAI_AGAIN)$/.test(value)))) {
    code = "upstream_dns_error";
    message = "無法解析上游主機名稱（DNS），請檢查網路、DNS 或 Base URL。";
  } else if ((causeCode = codes.find((value) => /CERT|TLS|SSL|VERIFY_LEAF|SELF_SIGNED/.test(value)))) {
    code = "upstream_tls_error";
    message = "上游 TLS／憑證驗證失敗，請檢查伺服器憑證、系統時間或代理設定。";
  } else if ((causeCode = codes.find((value) => /^(ECONNREFUSED|ECONNRESET|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET)$/.test(value)))) {
    code = "upstream_connection_error";
    message = "上游連線失敗或中斷，請檢查上游服務、網路或代理設定。";
  }
  return {
    status, code, message, phase: error?.phase || "request",
    causeCode: causeCode || codes[0] || null, upstreamStatus: null,
  };
}

function recordRouterError(error, context = {}, countFailure = true) {
  const details = describeRouterError(error);
  const requestId = randomBytes(8).toString("hex");
  const endpoint = details.phase === "auth_probe" || context.route !== "custom" ? officialBase : apiRoot;
  const record = {
    at: new Date().toISOString(), requestId,
    transport: context.transport || null, route: context.route || null,
    model: typeof context.model === "string" ? context.model.slice(0, 160) : null,
    upstreamHost: new URL(endpoint).host,
    ...details,
  };
  // 不記錄原始例外訊息、標頭、Key 或請求內文；cause.code 已足夠定位網路故障。
  stats.lastError = record;
  if (countFailure) stats.failures += 1;
  process.stderr.write(`model-router-error:${JSON.stringify(record)}\n`);
  return { ...details, requestId };
}

function recordUpstreamFailure(upstream, context) {
  if (upstream.status < 400) return;
  const status = upstream.status;
  const code = status === 401 || status === 403 ? "upstream_auth_rejected"
    : status === 429 ? "upstream_rate_limited" : "upstream_http_error";
  recordRouterError(new RouterRequestError(
    status, code, `上游服務返回 HTTP ${status}。`, "upstream", status,
  ), context);
}

function writeJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

// 憑證來源：macOS 讀鑰匙圈；Windows 解 DPAPI 密文檔（entropy 就是 keychainService）。
//
// 一定要非同步：Windows 起 powershell.exe 解 DPAPI 每次要 1 秒以上，同步呼叫期間
// 整個路由器（所有對話的串流、WebSocket 心跳）都會停住。
async function runSecretCommand(file, args, options = {}) {
  const pending = execFileAsync(file, args, { encoding: "utf8", maxBuffer: 1024 * 1024, ...options });
  // 不給子行程任何輸入；PowerShell 在 stdin 是未關閉的管線時可能一直等待。
  pending.child.stdin?.end();
  const { stdout } = await pending;
  return stdout.trim();
}

export async function readStoredSecret() {
  if (process.platform !== "win32") {
    return runSecretCommand("/usr/bin/security", [
      "find-generic-password",
      "-a",
      keychainAccount,
      "-s",
      keychainService,
      "-w",
    ]);
  }
  if (!credentialPath) throw new Error("設定中缺少憑證檔案路徑");
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Security",
    "[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false",
    `$blob = [Convert]::FromBase64String(([IO.File]::ReadAllText(${quote(credentialPath)})).Trim())`,
    `$entropy = [Text.Encoding]::UTF8.GetBytes(${quote(keychainService)})`,
    "$plain = [Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))",
  ].join("\n");
  return runSecretCommand("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ], { windowsHide: true });
}

// 金鑰快取。fingerprint 變了（Windows 的密文檔被重新寫入）就重讀，否則在 TTL 內沿用；
// 同時間的多個請求共用同一次讀取。reload 用在上游回 401/403 時強制重讀。
export function createSecretCache({ read, fingerprint = () => null, ttlMs, now = Date.now }) {
  let cached = null;
  let pending = null;
  return async function get({ reload = false } = {}) {
    const current = fingerprint();
    if (!reload && cached && cached.fingerprint === current && cached.expiresAt > now()) return cached.value;
    if (!pending) {
      pending = (async () => {
        try {
          const value = await read();
          if (!value) throw new Error("自訂供應商的憑證為空");
          cached = { value, fingerprint: current, expiresAt: now() + ttlMs };
          return value;
        } finally {
          pending = null;
        }
      })();
    }
    return pending;
  };
}

// Windows 的密文檔只在安裝器換 Key 時改寫；stat 幾乎不花時間，可以每次檢查。
// macOS 的鑰匙圈沒有等價的廉價檢查，沿用較短的 TTL（讀取本身只要數十毫秒）。
function credentialFingerprint() {
  if (process.platform !== "win32" || !credentialPath) return null;
  try {
    const info = statSync(credentialPath);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "missing";
  }
}

const cachedApiKey = createSecretCache({
  read: async () => {
    stats.credentialReads += 1;
    return readStoredSecret();
  },
  fingerprint: credentialFingerprint,
  ttlMs: process.platform === "win32" && credentialPath ? credentialCacheTtlMs : tokenCacheTtlMs,
});

async function getApiKey(reload = false) {
  if (process.env.CODEX_MODEL_ROUTER_TEST_API_KEY) {
    return process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  }
  return cachedApiKey({ reload });
}

function appendHeader(headers, name, value) {
  if (Array.isArray(value)) {
    for (const entry of value) headers.append(name, entry);
  } else {
    headers.set(name, value);
  }
}

function buildOfficialHeaders(requestHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(requestHeaders)) {
    const normalized = name.toLowerCase();
    if (
      requestHopByHopHeaders.has(normalized) ||
      normalized.startsWith("sec-websocket-") ||
      value == null
    ) {
      continue;
    }
    appendHeader(headers, name, value);
  }
  return headers;
}

function buildCustomHeaders(requestHeaders, apiKey) {
  const headers = new Headers({ authorization: `Bearer ${apiKey}` });
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (!customForwardHeaders.has(name.toLowerCase()) || value == null) continue;
    appendHeader(headers, name, value);
  }
  if (!headers.has("accept")) headers.set("accept", "text/event-stream");
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return headers;
}

function filteredResponseHeaders(upstreamHeaders) {
  const headers = {};
  for (const [name, value] of upstreamHeaders) {
    if (!responseHeadersToStrip.has(name.toLowerCase())) headers[name] = value;
  }
  return headers;
}

function authDigest(headers) {
  const authorization = headers.authorization;
  const accountId = headers["chatgpt-account-id"];
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ") ||
    typeof accountId !== "string" ||
    !accountId
  ) {
    return null;
  }
  return createHash("sha256")
    .update(authorization)
    .update("\0")
    .update(accountId)
    .digest("hex");
}

// verified=false 只延長短期快取（寬限期放行時用），不會把寬限期本身往後延。
export function markAuthValidated(headers, { verified = true } = {}) {
  const digest = authDigest(headers);
  if (!digest) return;
  if (verified) {
    lastAuthSuccess.delete(digest);
    lastAuthSuccess.set(digest, Date.now());
    while (lastAuthSuccess.size > maxValidatedAuthDigests) lastAuthSuccess.delete(lastAuthSuccess.keys().next().value);
  }
  // 過期項目只在「同一個摘要再被查一次」時才會被刪。憑證輪替後舊摘要再也不會
  // 被查到，就會一直留著。這裡在成長到上限時掃一次，掃完仍超出就汰換最舊的。
  if (validatedAuthDigests.size >= maxValidatedAuthDigests) {
    const now = Date.now();
    for (const [key, expiresAt] of validatedAuthDigests) {
      if (expiresAt <= now) validatedAuthDigests.delete(key);
    }
    while (validatedAuthDigests.size >= maxValidatedAuthDigests) {
      const oldest = validatedAuthDigests.keys().next().value;
      if (oldest === undefined) break;
      validatedAuthDigests.delete(oldest);
    }
  }
  validatedAuthDigests.delete(digest);
  validatedAuthDigests.set(digest, Date.now() + authValidationTtlMs);
}

export function hasValidatedAuth(headers) {
  const digest = authDigest(headers);
  if (!digest) return false;
  const expiresAt = validatedAuthDigests.get(digest);
  if (!expiresAt || expiresAt <= Date.now()) {
    validatedAuthDigests.delete(digest);
    return false;
  }
  return true;
}

function allowDuringAuthOutage(headers, reason) {
  const digest = authDigest(headers);
  const lastSuccess = digest ? lastAuthSuccess.get(digest) : undefined;
  if (lastSuccess === undefined || Date.now() - lastSuccess > authProbeGraceMs) return false;
  stats.authProbeGraceUsed += 1;
  process.stderr.write(`model-router-auth-probe-grace:${reason}\n`);
  // 探測持續失敗期間，不必每個請求都再等一次逾時。
  markAuthValidated(headers, { verified: false });
  return true;
}

async function validateOfficialAuth(requestHeaders, signal) {
  if (hasValidatedAuth(requestHeaders)) return true;
  if (!authDigest(requestHeaders)) {
    throw new RouterRequestError(401, "chatgpt_auth_required", "需要 ChatGPT 身份驗證。", "auth_probe");
  }
  let upstream;
  const timeout = AbortSignal.timeout(15000);
  const probeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  stats.lastAuthProbeStatus = null;
  try {
    upstream = await fetch(`${officialBase}/models`, {
      headers: buildOfficialHeaders(requestHeaders),
      redirect: "manual",
      signal: probeSignal,
    });
    await upstream.arrayBuffer();
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    stats.authProbeFailures += 1;
    if (allowDuringAuthOutage(requestHeaders, "network")) return true;
    throw Object.assign(new Error("ChatGPT 驗證探測失敗", { cause: error }), { phase: "auth_probe" });
  }
  stats.lastAuthProbeStatus = upstream.status;
  if (upstream.status === 401 || upstream.status === 403) {
    stats.authProbeFailures += 1;
    lastAuthSuccess.delete(authDigest(requestHeaders));
    throw new RouterRequestError(
      upstream.status, "chatgpt_auth_rejected",
      `ChatGPT 身份驗證遭拒（HTTP ${upstream.status}），請檢查登入狀態或帳號權限。`,
      "auth_probe", upstream.status,
    );
  }
  // 缺少 client_version 會回 400，沿用相容處理；服務故障或重新導向不能快取成驗證成功。
  if (!upstream.ok && upstream.status !== 400) {
    stats.authProbeFailures += 1;
    if (allowDuringAuthOutage(requestHeaders, `http-${upstream.status}`)) return true;
    throw new RouterRequestError(
      upstream.status === 429 ? 429 : 503, "auth_probe_unavailable",
      `ChatGPT 驗證服務暫時不可用（HTTP ${upstream.status}），請稍後重試。`,
      "auth_probe", upstream.status,
    );
  }
  markAuthValidated(requestHeaders);
  return true;
}

function rememberRoute(headers, route) {
  for (const headerName of ["thread-id", "session-id"]) {
    const id = headers[headerName];
    if (typeof id !== "string" || !id) continue;
    threadRoutes.delete(id);
    threadRoutes.set(id, route);
  }
  while (threadRoutes.size > maxRememberedThreads) {
    const first = threadRoutes.keys().next().value;
    if (!first) break;
    threadRoutes.delete(first);
  }
}

function rememberedRoute(headers) {
  for (const headerName of ["thread-id", "session-id"]) {
    const id = headers[headerName];
    if (typeof id === "string" && threadRoutes.has(id)) return threadRoutes.get(id);
  }
  return null;
}

function chooseRoute(headers, body) {
  if (typeof body?.model === "string" && routeMap.has(body.model)) {
    return routeMap.get(body.model);
  }
  if (typeof body?.model === "string" && body.model.startsWith("custom/")) {
    throw new RouterRequestError(
      404, "custom_model_not_configured",
      "此自訂模型未配置或路由已遺失，請重新添加模型，並在新任務中選擇已配置的模型。",
      "routing",
    );
  }
  if (typeof body?.model === "string") return null;
  return rememberedRoute(headers);
}

function fallbackEffort(efforts) {
  for (const effort of ["max", "xhigh", "high", "medium", "low"]) {
    if (efforts.includes(effort)) return effort;
  }
  return null;
}

function rewriteCustomBody(body, route) {
  const rewritten = { ...body, model: route.upstreamModel };
  const requestedEffort = body?.reasoning?.effort;
  if (route.stripReasoning || route.efforts.length === 0) {
    delete rewritten.reasoning;
    if (body?.reasoning) stats.reasoningRewrites += 1;
    return rewritten;
  }
  if (requestedEffort && !route.efforts.includes(requestedEffort)) {
    const effort = fallbackEffort(route.efforts);
    rewritten.reasoning = effort ? { ...body.reasoning, effort } : undefined;
    stats.reasoningRewrites += 1;
  }
  return rewritten;
}

// Codex 只設定一個 base URL，凡是送到這裡而路由器沒有特別處理的路徑，本來就都是
// 要給官方後端的：網路查詢走 POST /v1/alpha/search，筆記與歷史走
// /v1/alpha/notes/v2/* 與 /v1/alpha/history/v2/*。原本一律回 404，等於把這幾組
// 功能整組打掉，而且失敗得很安靜——只有呼叫端看得到那個 404。
//
// 這裡不自己驗證身分，原樣轉送即可：官方後端本來就會自己判斷。
async function proxyToOfficial(request, response, incomingUrl) {
  const body = decodeRequestBody(await readRequestBody(request), request.headers["content-encoding"]);
  const controller = new AbortController();
  response.on("close", () => { if (!response.writableFinished) controller.abort(); });
  const init = {
    method: request.method,
    headers: buildOfficialHeaders(request.headers),
    redirect: "manual",
    signal: controller.signal,
  };
  if (body.length > 0) init.body = body;
  const upstream = await fetch(targetUrl(false, incomingUrl), init);
  stats.officialPassthroughs += 1;
  stats.lastOfficialStatus = upstream.status;
  await streamUpstream(upstream, response);
}

export function targetUrl(custom, incomingUrl) {
  const path = incomingUrl.pathname.startsWith("/v1/")
    ? incomingUrl.pathname.slice(3)
    : incomingUrl.pathname;
  const base = custom ? apiRoot : officialBase;
  return new URL(`${base}${path}${incomingUrl.search}`);
}

export async function streamUpstream(upstream, response, history = null, responsesStream = false) {
  response.writeHead(upstream.status, filteredResponseHeaders(upstream.headers));
  if (!upstream.body) {
    response.end();
    return;
  }
  let sawTerminal = false;
  let upstreamError = null;
  const observe = (responsesStream || history) && upstream.ok && upstream.headers.get("content-type")?.includes("text/event-stream")
    ? observeResponsesSse((event) => {
      if (isTerminalEvent(event)) { sawTerminal = true; response.routerTerminalSent = true; }
      else if (event?.type === "error") upstreamError = event;
      rememberHistoryEvent(history, event);
    })
    : null;
  response.routerResponsesStream = Boolean(observe);
  let jsonChunks = history && upstream.ok && !observe ? [] : null;
  let jsonBytes = 0;
  for await (const chunk of upstream.body) {
    observe?.write(chunk);
    if (jsonChunks) {
      jsonBytes += chunk.length;
      if (jsonBytes > maxHistoryBytes) jsonChunks = null;
      else jsonChunks.push(Buffer.from(chunk));
    }
    if (!response.write(chunk)) await once(response, "drain");
  }
  observe?.finish();
  if (observe && !sawTerminal) {
    let event;
    if (upstreamError) event = responseFailedFromErrorEvent(upstreamError);
    else {
      noteTruncatedStream();
      event = responseFailedEvent("upstream_stream_truncated", truncatedStreamMessage);
    }
    response.write("\n\nevent: response.failed\ndata: " + JSON.stringify(event) + "\n\n");
    response.routerTerminalSent = true;
  }
  if (jsonChunks) {
    try {
      const result = JSON.parse(Buffer.concat(jsonChunks).toString("utf8"));
      if (result.status === "completed" || result.status === "incomplete") {
        rememberHistoryEvent(history, { type: `response.${result.status}`, response: result });
      }
    } catch { /* 非 Responses JSON 不作歷史保存，仍原樣回傳。 */ }
  }
  response.end();
}

async function fetchCustom(target, headers, body, signal) {
  let apiKey = await getApiKey(false);
  let upstream = await fetch(target, {
    method: "POST",
    headers: buildCustomHeaders(headers, apiKey),
    body,
    redirect: "manual",
    signal,
  });
  if (upstream.status !== 401 && upstream.status !== 403) return upstream;
  await upstream.arrayBuffer();
  apiKey = await getApiKey(true);
  return fetch(target, {
    method: "POST",
    headers: buildCustomHeaders(headers, apiKey),
    body,
    redirect: "manual",
    signal,
  });
}

export async function fetchModelUpstream(
  requestHeaders,
  incomingUrl,
  body,
  bodyBuffer,
  signal,
  meta = {},
) {
  const route = chooseRoute(requestHeaders, body);
  rememberRoute(requestHeaders, route);
  const isCustom = route != null;

  // HTTP 回退與第三方上游不保證支援 previous_response_id，從對應的成功回合重播。
  const historyKey = historyKeyFor(body, requestHeaders, meta.connectionNamespace);
  meta.historyKey = historyKey;
  let effectiveBody = body;
  if (body?.previous_response_id) {
    const rebuilt = rebuildStatefulInput(historyKey, body.input, body.previous_response_id);
    if (rebuilt) {
      effectiveBody = { ...body, input: rebuilt };
      delete effectiveBody.previous_response_id;
      stats.statefulRebuilds += 1;
    } else {
      stats.statefulRebuildMisses += 1;
      throw new RouterRequestError(
        409, "router_history_unavailable",
        "找不到 previous_response_id 對應的完整歷史，請重連並重送完整對話。",
        "history",
      );
    }
  }
  meta.history = prepareHistory(historyKey, effectiveBody.input, body?.previous_response_id);

  // 只有 Anthropic 轉譯路由能解讀自己產生的 reasoning，其餘路由一律剝除；
  // 自鑄的 item id 同理，留著會讓上游拒收整輪請求。
  if (route?.translate !== "anthropic") {
    effectiveBody = stripBridgeArtifacts(effectiveBody);
  }

  // 這一步對每一條路由都要做：view_image 是路由器自己合成的，沒有任何上游認得它。
  effectiveBody = stripRouterImageArtifacts(effectiveBody);

  let outboundBodyObject = isCustom
    ? rewriteCustomBody(effectiveBody, route)
    : effectiveBody;
  let outboundBody = Buffer.from(JSON.stringify(outboundBodyObject));

  stats.lastRoute = isCustom ? "custom" : "official";
  stats.lastModel = body?.model ?? null;
  stats.lastReasoningEffort = body?.reasoning?.effort ?? null;
  stats.lastForwardedReasoningEffort =
    outboundBodyObject?.reasoning?.effort ?? null;

  if (isCustom) {
    await validateOfficialAuth(requestHeaders, signal);
    stats.custom += 1;
    if (route.translate === "anthropic") {
      // 部分閘道的 Responses 相容層對 Claude 有缺陷，改走原生 /messages 並本機轉譯。
      const { request: anthropicRequest, freeform, toolTargets, compaction, imagesOmitted,
        thinkingTrimmed, toolContext, toolOutputsMerged, lateToolOutputs,
        toolResultsReordered } = toAnthropicRequest(effectiveBody, route);
      if (imagesOmitted > 0) stats.imagesOmitted += imagesOmitted;
      if (thinkingTrimmed > 0) stats.trailingThinkingTrimmed += thinkingTrimmed;
      // 同一個 call_id 的多筆輸出（例如 Code Mode 的 notify()）如何被收斂成
      // Anthropic 可接受的單一 tool_result；每次轉譯都會重算，同一段歷史重送會再累加。
      stats.claudeToolOutputsMerged += toolOutputsMerged;
      stats.claudeLateToolOutputs += lateToolOutputs;
      stats.claudeToolResultsReordered += toolResultsReordered;
      stats.claudeToolDefinitionsDeferred += toolContext.toolsDeferred;
      stats.claudeToolDescriptionCharsSaved += toolContext.charsSaved;
      stats.lastClaudeToolContext = toolContext;
      meta.translate = "anthropic";
      meta.freeform = freeform;
      meta.toolTargets = toolTargets;
      meta.compaction = compaction;
      meta.model = body.model;
      meta.requestBody = effectiveBody;
      const budget = budgetToolImages(anthropicRequest, { anthropic: true });
      recordImageBudget(budget);
      meta.anthropicRequest = budget.request;
      stats.translatedRequests += 1;
      const anthropicBody = budget.buffer;
      if (upstreamRequestTooLarge(anthropicBody.length)) {
        return oversizeResponse(anthropicBody.length);
      }
      const translated = await fetchCustom(
        new URL(`${apiRoot}/messages`),
        requestHeaders,
        anthropicBody,
        signal,
      );
      stats.lastCustomStatus = translated.status;
      recordUpstreamFailure(translated, { transport: meta.transport, route: "custom", model: body?.model });
      return translated;
    }
    const budget = budgetToolImages(outboundBodyObject);
    recordImageBudget(budget);
    outboundBody = budget.buffer;
    if (upstreamRequestTooLarge(outboundBody.length)) {
      return oversizeResponse(outboundBody.length);
    }
    const upstream = await fetchCustom(
      targetUrl(true, incomingUrl),
      requestHeaders,
      outboundBody,
      signal,
    );
    stats.lastCustomStatus = upstream.status;
    recordUpstreamFailure(upstream, { transport: meta.transport, route: "custom", model: body?.model });
    return upstream;
  }

  if (!authDigest(requestHeaders)) {
    return new Response(
      JSON.stringify({
        error: { message: "需要 ChatGPT 身份驗證", type: "auth_error" },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
  stats.official += 1;
  const upstream = await fetch(targetUrl(false, incomingUrl), {
    method: "POST",
    headers: buildOfficialHeaders(requestHeaders),
    body: outboundBody.length > 0 ? outboundBody : bodyBuffer, // outboundBody 已含重建結果
    redirect: "manual",
    signal,
  });
  stats.lastOfficialStatus = upstream.status;
  recordUpstreamFailure(upstream, { transport: meta.transport, route: "official", model: body?.model });
  if (upstream.status === 200) markAuthValidated(requestHeaders);
  return upstream;
}

// Codex 內建的 image_gen 工具打的是 /v1/images/generations。路由器原本只認
// /healthz、/models 與 /responses，其餘一律回自己的 404——所以使用者看到的
// 「內建圖片生成服務回傳 404」其實是路由器擋掉的，跟上游無關。
//
// 官方後端沒有這條路徑（officialBase 是 .../backend-api/codex），但自訂閘道有，
// 因此一律轉給自訂閘道。閘道若不支援，它自己的錯誤訊息也比路由器的 404 有用。
export const IMAGE_PATH_PATTERN = /^\/(?:v1\/)?images\/(?:generations|edits|variations)$/;
export const ARK_IMAGE_PATH_PATTERN = /^\/v2\/extend\/image\/ark_gpt_image\/(?:generations|edits|tasks\/[A-Za-z0-9_-]{1,160})$/;

// 路由器只聽 127.0.0.1，但瀏覽器裡的任何網頁都能對它發請求：跨站的「簡單請求」
// （text/plain、multipart/form-data 的 POST）不會觸發 CORS 預檢，照樣送達；
// DNS rebinding 更能讓惡意網頁以同源身分送出請求並讀到回應。兩層防護：
//
//   1. Host 只接受本機名稱。DNS rebinding 的請求帶的是攻擊者的網域。
//   2. 花費中轉額度、又不要求 ChatGPT 憑證的端點（生圖、Ark）拒絕瀏覽器請求。
//      瀏覽器的 POST 一定帶 Origin，現行瀏覽器的每個請求也都帶 Sec-Fetch-Site；
//      Codex 本身與 imagegen 命令（Node fetch）兩者都不帶。
//
// /responses 不必另外擋：自訂路由本來就要求 ChatGPT 憑證，瀏覽器頁面拿不到。
const loopbackHostnames = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackHost(value) {
  // HTTP/1.0 等不帶 Host 的用戶端不會是瀏覽器。
  if (typeof value !== "string" || !value) return true;
  const host = value.trim().toLowerCase();
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d+$/, "");
  return loopbackHostnames.has(name.replace(/\.$/, ""));
}

export function isBrowserRequest(headers) {
  if (headers?.origin != null) return true;
  const site = headers?.["sec-fetch-site"];
  // none 代表使用者自己在網址列開啟，不是網頁發起的請求。
  return typeof site === "string" && site !== "none";
}

function rejectBrowserRequest(request, response) {
  if (!isBrowserRequest(request.headers)) return false;
  stats.browserRequestsRejected += 1;
  writeJson(response, 403, {
    error: {
      message: "拒絕來自瀏覽器網頁的生圖請求：這個端點會使用中轉 API Key，只接受 Codex 與本機命令。",
      type: "router_error",
      code: "browser_request_rejected",
    },
  });
  return true;
}

async function handleArkImages(request, response, incomingUrl) {
  const taskQuery = incomingUrl.pathname.includes("/tasks/");
  if (!ARK_IMAGE_PATH_PATTERN.test(incomingUrl.pathname) || request.method !== (taskQuery ? "GET" : "POST")) {
    writeJson(response, 404, { error: { message: "未知的 Ark 圖片任務端點。" } });
    return;
  }
  if (rejectBrowserRequest(request, response)) return;
  request.routerContext.route = "custom";
  if (authDigest(request.headers)) await validateOfficialAuth(request.headers);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxUpstreamRequestBytes) { writeJson(response, 413, { error: { message: "Ark 圖片請求過大。" } }); return; }
    chunks.push(chunk);
  }
  const controller = new AbortController();
  request.on("aborted", () => controller.abort());
  response.on("close", () => { if (!response.writableFinished) controller.abort(); });
  // 此路徑相對於已配置的供應商 origin，不接在 /v1 後，也不轉送官方後端。
  // 任務提交只發一次，不以 401/403 為由重送付費提交。Key 由快取提供：Windows 的密文檔
  // 一改寫就會重讀，不必每次都起 PowerShell（任務輪詢每 2 秒一次，以前每次都卡住路由器）。
  const apiKey = await getApiKey();
  const upstream = await fetch(new URL(incomingUrl.pathname, new URL(apiRoot).origin), {
    method: request.method, headers: buildCustomHeaders(request.headers, apiKey),
    body: taskQuery ? undefined : Buffer.concat(chunks), redirect: "manual", signal: controller.signal,
  });
  stats.arkImageRequests += 1;
  stats.lastImageStatus = upstream.status;
  await streamUpstream(upstream, response);
}

async function handleImages(request, response, incomingUrl) {
  // 與自訂模型同一套驗證，但只在請求真的帶了 ChatGPT 憑證時才驗。
  // image_gen 是用戶端工具，未必會帶上 /responses 那組標頭；若因為缺標頭就擋下，
  // 使用者只會從一個 404 換成一個 401，問題沒解決。路由器只聽 127.0.0.1，
  // 因此放行沒有標頭的請求；但瀏覽器網頁發起的請求一律拒絕（見 isBrowserRequest）。
  if (rejectBrowserRequest(request, response)) return;
  request.routerContext.route = "custom";
  if (authDigest(request.headers)) await validateOfficialAuth(request.headers);
  const rawBody = await readRequestBody(request);

  const abortController = new AbortController();
  request.on("aborted", () => abortController.abort());
  response.on("close", () => { if (!response.writableFinished) abortController.abort(); });

  // 影像請求可能是 multipart（edits），因此原樣轉發位元組，不做解析。
  const path = incomingUrl.pathname.startsWith("/v1/")
    ? incomingUrl.pathname.slice(3)
    : incomingUrl.pathname;
  const upstream = await fetchCustom(
    new URL(`${apiRoot}${path}${incomingUrl.search}`),
    request.headers,
    rawBody,
    abortController.signal,
  );
  stats.imageRequests += 1;
  stats.lastImageStatus = upstream.status;
  await streamUpstream(upstream, response);
}

async function handleResponses(request, response, incomingUrl) {
  const encoding = request.headers["content-encoding"];
  if (encoding && encoding !== "identity" && encoding !== "zstd") {
    writeJson(response, 415, {
      error: { message: "不支援的請求內容編碼", type: "router_error" },
    });
    return;
  }
  const encodedBody = await readRequestBody(request);
  const decodedBody = decodeRequestBody(encodedBody, encoding);
  let body;
  try {
    body = JSON.parse(decodedBody.toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid request object");
  } catch {
    writeJson(response, 400, { error: { message: "JSON 格式無效", type: "router_error" } });
    return;
  }
  request.routerContext.model = body?.model;
  request.routerContext.route = typeof body?.model === "string" && body.model.startsWith("custom/")
    ? "custom" : "official";

  const abortController = new AbortController();
  let finished = false;
  request.on("aborted", () => abortController.abort());
  response.on("finish", () => {
    finished = true;
  });
  response.on("close", () => {
    if (!finished) abortController.abort();
  });

  const meta = { transport: "http" };
  // 擷取原本只蓋 WebSocket 路徑。但 Codex 反覆握手失敗後會退回 HTTPS，之後所有
  // 請求都走這裡——上游在這條路上出錯時，開了擷取也一個檔案都拿不到。
  const captureId = captureNext(
    typeof body.model === "string" && routeMap.has(body.model) ? "custom-http" : "official-http",
  );
  captureWrite(captureId, "request.json", JSON.stringify(body, null, 2));
  const upstream = await fetchModelUpstream(
    request.headers,
    incomingUrl,
    body,
    decodedBody,
    abortController.signal,
    meta,
  );
  if (meta.anthropicRequest) {
    captureWrite(
      captureId,
      "anthropic-request.json",
      JSON.stringify(meta.anthropicRequest, null, 2),
    );
  }
  captureWrite(captureId, "upstream-status.txt", `${upstream.status}\n`);
  if (meta.translate === "anthropic" && upstream.status >= 200 && upstream.status < 300) {
    await bridgeAnthropicToHttp(upstream, response, meta);
    return;
  }
  // Anthropic 的錯誤內文是 {type:"error", error:{type, message}}，Codex 看的是 OpenAI
  // 形狀的 error.code。改寫成它認得的值，例如 prompt is too long → context_length_exceeded。
  if (meta.translate === "anthropic") {
    const text = await upstream.text();
    captureWrite(captureId, "upstream-error.txt", text);
    const retryAfter = upstream.headers.get("retry-after");
    const details = upstreamErrorDetails(upstream.status, text, retryAfter);
    response.writeHead(upstream.status, {
      "content-type": "application/json",
      ...(retryAfter ? { "retry-after": retryAfter } : {}),
    });
    response.end(JSON.stringify({ error: { ...details.error, code: details.code, message: details.message } }));
    return;
  }
  // 只有開了擷取才走這條：把上游的錯誤內文留下來再原樣回覆。上游錯誤的正文
  // 常比客戶端顯示的那一行詳細，而它一旦串出去就沒了。
  if (captureId && (upstream.status < 200 || upstream.status >= 300)) {
    const text = await upstream.text();
    captureWrite(captureId, "upstream-error.txt", text);
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json",
    });
    response.end(text);
    return;
  }
  await streamUpstream(upstream, response, meta.history, true);
}

const websocketMagic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
// 本機必須先收得到含舊截圖的完整請求，才有機會縮減；與上游 32 MB 門檻分開。
// 仍設有限的接收上限，避免依不合理的訊框長度配置記憶體。
const maxWebSocketMessageBytes = 128 * 1024 * 1024;

export function encodeWebSocketFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length <= 125) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function sendWebSocketFrame(socket, opcode, payload) {
  if (!socket.destroyed && socket.writable) {
    socket.write(encodeWebSocketFrame(opcode, payload));
  }
}

// Codex 不處理 type:"error"（日誌: unhandled responses event），只送它會無聲卡死。
// 413 會被既有的錯誤路徑接住：HTTP 那條原樣轉發，WebSocket 那條轉成
// type:"error" 加 response.failed。因此這裡不必自己處理兩種傳輸。
function oversizeResponse(bytes) {
  stats.oversizeRejects += 1;
  process.stderr.write(`model-router-request-too-large:${bytes}\n`);
  return new Response(
    JSON.stringify({
      error: {
        message: oversizeMessage(bytes, maxUpstreamRequestBytes),
        type: "router_error",
        code: "request_too_large",
      },
    }),
    { status: 413, headers: { "content-type": "application/json" } },
  );
}

// response.failed 是 Responses API 標準的失敗終止事件，Codex 有對應處理。
// 所有錯誤路徑都必須經過這裡，否則就會留下卡死的缺口。
function responseFailedEvent(code, message) {
  return {
    type: "response.failed",
    sequence_number: 0,
    response: {
      id: `resp_router_${Date.now().toString(36)}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "failed",
      error: { code: String(code), message: String(message) },
      incomplete_details: null,
      output: [],
      usage: null,
    },
  };
}

function sendResponseFailed(socket, code, message) {
  sendWebSocketJson(socket, responseFailedEvent(code, message));
  stats.responseFailedSent += 1;
}

// 上游串流可以在沒送出任何終止事件的情況下「乾淨」結束——代理把串流丟掉時，
// 讀取端看到的是 EOF 而不是例外，所以 catch 接不到；非 2xx 的檢查也早就過了，
// 因為標頭當初是 200。此時若就這樣收工關閉連線，Codex 只會看到
// 「websocket closed by server before response.completed」，等同無聲卡死。
// 凡是逐塊讀上游串流的地方，讀完都要確認終止事件真的送出去了。
//
// 頂層的 error 不算終止事件：Codex 只認下面三種，單獨的 error 會被直接忽略，
// WebSocket 上要空等閒置逾時（預設 300 秒）才重試。上游送了 error 就結束串流時，
// 用 responseFailedFromErrorEvent 把它的內容轉成 response.failed 補上。
const terminalEventTypes = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
]);

export function isTerminalEvent(event) {
  return terminalEventTypes.has(event?.type);
}

// 上游 error 事件有兩種形狀：Responses 串流的 {type, code, message}，以及包一層的
// {type, error: {type, code, message}, status}。錯誤碼換成 Codex 認得的值。
export function responseFailedFromErrorEvent(event) {
  const source = event?.error && typeof event.error === "object" ? event.error : event;
  const { code, message } = codexErrorFromUpstream({
    code: source?.code,
    type: source?.type === "error" ? null : source?.type,
    message: source?.message,
  }, { status: Number.isInteger(event?.status) ? event.status : null });
  stats.upstreamErrorsWithoutTerminal += 1;
  return responseFailedEvent(code, message);
}

// 非 2xx 回應的內文：OpenAI 形狀 {error: {...}}、Anthropic 形狀 {type, error: {...}}、
// 少數閘道的 {error: "文字"}，或根本不是 JSON。error 保留上游原樣，code／message
// 換成 Codex 認得的形式。
export function upstreamErrorDetails(status, rawText, retryAfter = null) {
  let payload = null;
  try { payload = JSON.parse(rawText); } catch {}
  const error = typeof payload?.error === "string"
    ? { message: payload.error }
    : (payload?.error && typeof payload.error === "object" ? payload.error : null);
  const seconds = Number(retryAfter);
  const mapped = codexErrorFromUpstream(error || { message: rawText || "" }, {
    status,
    retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null,
  });
  return {
    error: error || { type: "router_upstream_error", code: String(status), message: mapped.message },
    ...mapped,
  };
}

const truncatedStreamMessage = "上游串流在送出終止事件前就結束";

function noteTruncatedStream() {
  stats.truncatedUpstreamStreams += 1;
  process.stderr.write("model-router-upstream-stream-truncated\n");
}

function sendWebSocketJson(socket, payload) {
  sendWebSocketFrame(socket, 0x1, JSON.stringify(payload));
}

function closeWebSocket(socket, code = 1000, reason = "") {
  if (socket.destroyed || !socket.writable) return;
  const reasonBytes = Buffer.from(reason).subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  sendWebSocketFrame(socket, 0x8, payload);
  socket.end();
}

// buffer 開頭那個訊框總共需要幾個位元組；標頭還不完整時，回傳至少還要讀到的長度。
export function webSocketFrameLength(buffer, limit = maxWebSocketMessageBytes) {
  if (buffer.length < 2) return 2;
  const second = buffer[1];
  let payloadLength = second & 0x7f;
  let header = 2;
  if (payloadLength === 126) {
    header = 4;
    if (buffer.length < header) return header;
    payloadLength = buffer.readUInt16BE(2);
  } else if (payloadLength === 127) {
    header = 10;
    if (buffer.length < header) return header;
    const longLength = buffer.readBigUInt64BE(2);
    if (longLength > BigInt(limit)) throw new Error("WebSocket 訊息超過路由器限制");
    payloadLength = Number(longLength);
  }
  if (payloadLength > limit) throw new Error("WebSocket 訊息超過路由器限制");
  if (second & 0x80) header += 4;
  return header + payloadLength;
}

// 逐塊累積 TCP 資料，湊滿一個完整訊框才合併並解析。
//
// 以前每收到一塊就把整個緩衝區 Buffer.concat 再從頭解析：Codex 送來的一則 30 MB
// response.create（長對話帶著 base64 截圖很常見）以 64 KiB 分塊到達，累計要複製
// 約 7 GiB，實測 1.3 秒；先讀標頭算出訊框長度、收齊再合併只要約 50 毫秒。
// 標頭一到就檢查長度上限，不必等整個超大訊框收完才拒絕。
export function createWebSocketFrameReader(initial = Buffer.alloc(0), limit = maxWebSocketMessageBytes) {
  let chunks = initial.length ? [initial] : [];
  let buffered = initial.length;
  let needed = webSocketFrameLength(initial, limit);
  const reader = {
    // 合併時複製的累計位元組數，供測試確認不再是平方成長。
    copiedBytes: 0,
    push(chunk) {
      if (chunk.length) {
        chunks.push(chunk);
        buffered += chunk.length;
      }
      if (buffered < needed) {
        // 標頭可能還沒到齊：湊到能算出長度為止（標頭最多 14 個位元組，複製成本可忽略）。
        if (chunks.length > 1 && buffered <= 14) {
          chunks = [Buffer.concat(chunks, buffered)];
          needed = webSocketFrameLength(chunks[0], limit);
        }
        if (buffered < needed) return [];
      }
      const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered);
      if (chunks.length > 1) reader.copiedBytes += buffered;
      const { frames, remainder } = parseWebSocketFrames(buffer, limit);
      // remainder 是大緩衝區的切片；複製一份，免得一小段殘餘資料留住整個緩衝區。
      const rest = remainder.length && remainder.length < buffer.length ? Buffer.from(remainder) : remainder;
      chunks = rest.length ? [rest] : [];
      buffered = rest.length;
      needed = webSocketFrameLength(rest, limit);
      return frames;
    },
  };
  return reader;
}

export function parseWebSocketFrames(buffer, limit = maxWebSocketMessageBytes) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let payloadLength = second & 0x7f;
    let cursor = offset + 2;
    if (payloadLength === 126) {
      if (cursor + 2 > buffer.length) break;
      payloadLength = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLength === 127) {
      if (cursor + 8 > buffer.length) break;
      const longLength = buffer.readBigUInt64BE(cursor);
      if (longLength > BigInt(limit)) {
        throw new Error("WebSocket 訊息超過路由器限制");
      }
      payloadLength = Number(longLength);
      cursor += 8;
    }
    if (payloadLength > limit) {
      throw new Error("WebSocket 訊息超過路由器限制");
    }
    const masked = (second & 0x80) !== 0;
    let mask = null;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (cursor + payloadLength > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + payloadLength));
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    frames.push({
      fin: (first & 0x80) !== 0,
      opcode: first & 0x0f,
      payload,
    });
    offset = cursor + payloadLength;
  }
  return { frames, remainder: buffer.subarray(offset) };
}

function sseData(block) {
  return block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

function observeResponsesSse(onEvent) {
  const decoder = new TextDecoder();
  let pending = "";
  const parse = (block) => {
    const data = sseData(block);
    if (data && data !== "[DONE]") onEvent(JSON.parse(data));
  };
  return {
    write(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      for (;;) {
        const match = /\r?\n\r?\n/.exec(pending);
        if (!match) break;
        parse(pending.slice(0, match.index));
        pending = pending.slice(match.index + match[0].length);
      }
    },
    finish() {
      pending += decoder.decode();
      if (pending.trim()) parse(pending);
    },
  };
}

function sendSseBlockToWebSocket(socket, block, onEvent = null, imageState = null) {
  const data = sseData(block);
  if (!data || data === "[DONE]") return;
  const parsed = JSON.parse(data);
  if (onEvent) onEvent(parsed);

  // response.completed 要補上合成的項目，Codex 的最終狀態才與串流一致。
  if (imageState && parsed?.type === "response.completed" && imageState.pending.length > 0) {
    for (const injection of imageState.pending) emitViewImageCall(socket, injection);
    const rewritten = structuredClone(parsed);
    if (Array.isArray(rewritten.response?.output)) {
      for (const injection of imageState.pending) rewritten.response.output.push(injection.item);
    }
    imageState.pending = [];
    sendWebSocketJson(socket, rewritten);
    stats.websocketEvents += 1;
    return;
  }

  // 原樣轉發：不重新序列化，避免動到上游的位元組。
  sendWebSocketFrame(socket, 0x1, data);
  stats.websocketEvents += 1;

  if (imageState) noteImageGenerationItem(parsed, imageState);
}

// 記下這一輪出現過的最大 output_index，合成項目才不會撞號。
function noteImageGenerationItem(event, imageState) {
  if (Number.isFinite(event?.output_index)) {
    imageState.maxIndex = Math.max(imageState.maxIndex, event.output_index);
  }
  if (event?.type !== "response.output_item.done") return;
  const item = event.item;
  if (item?.type !== "image_generation_call" || item.status !== "completed") return;
  const path = saveGeneratedImage(item);
  if (!path) return;
  stats.imagesSaved += 1;
  if (!viewImageBridgeEnabled) return;
  const callId = ROUTER_IMAGE_CALL_PREFIX + randomBytes(12).toString("hex");
  imageState.pending.push({
    path,
    item: {
      id: "fc_" + randomBytes(24).toString("hex"),
      type: "function_call",
      call_id: callId,
      name: "view_image",
      arguments: JSON.stringify({ path }),
      status: "completed",
    },
  });
}

// 合成一次 view_image 呼叫的完整事件序列，讓 Codex 當成正常工具呼叫執行。
function emitViewImageCall(socket, injection) {
  const index = injection.outputIndex;
  const { item } = injection;
  sendWebSocketJson(socket, {
    type: "response.output_item.added",
    output_index: index,
    item: { ...item, arguments: "", status: "in_progress" },
  });
  sendWebSocketJson(socket, {
    type: "response.function_call_arguments.delta",
    item_id: item.id,
    output_index: index,
    delta: item.arguments,
  });
  sendWebSocketJson(socket, {
    type: "response.function_call_arguments.done",
    item_id: item.id,
    output_index: index,
    arguments: item.arguments,
  });
  sendWebSocketJson(socket, { type: "response.output_item.done", output_index: index, item });
  stats.websocketEvents += 4;
  stats.viewImageCallsInjected += 1;
}

export async function bridgeSseToWebSocket(upstream, socket, captureId = null, history = null) {
  stats.lastWebSocketStatus = upstream.status;
  if (upstream.status < 200 || upstream.status >= 300) {
    const rawText = await upstream.text();
    // 狀態碼字串（"400"、"429"）Codex 不認得：上下文爆掉會被白白重試，限流也不會等。
    const details = upstreamErrorDetails(upstream.status, rawText, upstream.headers?.get?.("retry-after"));
    sendWebSocketJson(socket, { type: "error", error: details.error });
    sendResponseFailed(socket, details.code, details.message);
    // 關閉連線的策略需要區分兩種錯誤：
    //
    // 1) 預熱請求（websocket.warmup=true）在部分閘道上必定失敗，但 Codex 會忽略
    //    並在同一條連線上送出真正的請求。此時關閉連線只會讓每次工具往返多付
    //    一次斷線重試，所以不能關。
    //
    // 2) previous_response_id 不被支援：Codex 在工具接續回合只送工具結果並倚賴
    //    伺服器保存狀態，而它是以「連線」為單位判斷伺服器是否具備該能力。
    //    此時若不關閉，Codex 收到它不認得的 type:"error" 會無聲卡死；關閉後
    //    它會重連，並在新連線上重送完整歷史 —— 因此這種錯誤必須關。
    const isStatefulUnsupported =
      typeof rawText === "string" && rawText.includes("previous_response_id");
    if (isStatefulUnsupported || closeOnUpstreamError) {
      stats.upstreamErrorCloses += 1;
      if (isStatefulUnsupported) stats.statefulFallbacks += 1;
      closeWebSocket(socket, 1011, `upstream ${upstream.status}`);
    }
    return;
  }
  if (!upstream.body) throw new Error("WebSocket 上游響應沒有內文");

  let sawTerminal = false;
  let upstreamError = null;
  const onEvent = (event) => {
    if (isTerminalEvent(event)) sawTerminal = true;
    else if (event?.type === "error") upstreamError = event;
    rememberHistoryEvent(history, event);
  };
  const imageState = { pending: [], maxIndex: -1 };
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of upstream.body) {
    captureAppend(captureId, "response.sse", Buffer.from(chunk));
    pending += decoder.decode(chunk, { stream: true });
    for (;;) {
      const match = /\r?\n\r?\n/.exec(pending);
      if (!match) break;
      const block = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      assignInjectionIndices(imageState);
      sendSseBlockToWebSocket(socket, block, onEvent, imageState);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) {
    assignInjectionIndices(imageState);
    sendSseBlockToWebSocket(socket, pending, onEvent, imageState);
  }
  if (!sawTerminal) {
    if (upstreamError) {
      sendWebSocketJson(socket, responseFailedFromErrorEvent(upstreamError));
      stats.responseFailedSent += 1;
    } else {
      noteTruncatedStream();
      sendResponseFailed(socket, "upstream_stream_truncated", truncatedStreamMessage);
    }
  }
}

// 合成項目排在這一輪所有真實項目之後，避免與上游的 output_index 相撞。
function assignInjectionIndices(imageState) {
  for (const injection of imageState.pending) {
    if (injection.outputIndex === undefined) {
      imageState.maxIndex += 1;
      injection.outputIndex = imageState.maxIndex;
    }
  }
}

function startWebSocketHeartbeat(socket) {
  const timer = setInterval(() => {
    if (socket.destroyed || !socket.writable) return;
    sendWebSocketFrame(socket, 0x9, Buffer.alloc(0));
    stats.heartbeats += 1;
  }, heartbeatIntervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

// --- 上游 WebSocket（僅官方路由）-------------------------------------------
// 官方後端支援 Responses 的 WebSocket 模式，同一條連線可用 previous_response_id
// 接續，每輪只送新項目。實測（2026-09-02，官方 backend）：
//   - 同一條連線接續：成功
//   - 換一條連線沿用舊 id：Invalid previous_response_id
//   - generate:false 預熱：成功，且其 id 可被接續
// 因此接續狀態必須以「上游連線」為單位追蹤；跨連線、跨模型或找不到來源時，
// 一律改送本機重建的完整歷史，等價於原本的 HTTP 行為。
//
// 客戶端送出的訊框必須加遮罩（RFC 6455），與伺服器端的 encodeWebSocketFrame 不同。
export function encodeMaskedWebSocketFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length <= 125) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(body.length);
  for (let index = 0; index < body.length; index += 1) {
    masked[index] = body[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function officialWebSocketTarget() {
  const url = new URL(officialBase + "/responses");
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    path: url.pathname + url.search,
    secure: url.protocol === "https:",
  };
}

function connectUpstreamWebSocket(requestHeaders, timeoutMs = 15000) {
  const target = officialWebSocketTarget();
  if (!target.secure) throw new Error("上游 WebSocket 需要 HTTPS 端點");
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1").update(key + websocketMagic).digest("base64");
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: target.host,
      port: target.port,
      servername: target.host,
    });
    let settled = false;
    let buffer = Buffer.alloc(0);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(() => fail(Object.assign(
      new Error("上游 WebSocket 握手逾時"), { code: "ETIMEDOUT" },
    )), timeoutMs);
    const onHandshakeData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const headerText = buffer.subarray(0, boundary).toString("utf8");
      const remainder = buffer.subarray(boundary + 4);
      const status = Number(/^HTTP\/1\.[01]\s+(\d+)/.exec(headerText)?.[1]);
      if (status !== 101) {
        fail(new RouterRequestError(
          502, "upstream_websocket_rejected", `上游 WebSocket 握手失敗（HTTP ${status || "未知"}）。`,
          "websocket_handshake", status || null,
        ));
        return;
      }
      const acceptLine = /sec-websocket-accept:\s*(\S+)/i.exec(headerText)?.[1];
      if (acceptLine !== expectedAccept) {
        fail(new Error("上游 WebSocket 握手驗證失敗"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.off("data", onHandshakeData);
      socket.off("error", fail);
      resolve(createUpstreamSession(socket, remainder));
    };
    socket.on("data", onHandshakeData);
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      const headers = new Headers(buildOfficialHeaders(requestHeaders));
      const lines = ["GET " + target.path + " HTTP/1.1", "Host: " + target.host];
      for (const [name, value] of headers) {
        if (name.toLowerCase() === "host") continue;
        lines.push(name + ": " + value);
      }
      lines.push("Connection: Upgrade");
      lines.push("Upgrade: websocket");
      lines.push("Sec-WebSocket-Key: " + key);
      lines.push("Sec-WebSocket-Version: 13");
      socket.write(lines.join("\r\n") + "\r\n\r\n");
    });
  });
}

function createUpstreamSession(socket, leftover) {
  const session = {
    socket,
    closed: false,
    // 這條上游連線產生過的 response id；只有命中才可以安全地接續。
    responseIds: new Set(),
    onEvent: null,
    onClosed: null,
  };
  // 握手回應後面若已帶著訊框，先放進讀取器，與下一塊資料一起解析。
  const frameReader = createWebSocketFrameReader(leftover ?? Buffer.alloc(0));
  let fragments = [];
  const markClosed = (reason) => {
    if (session.closed) return;
    session.closed = true;
    const notify = session.onClosed;
    session.onClosed = null;
    if (notify) notify(reason);
  };
  socket.on("data", (chunk) => {
    let frames;
    try {
      frames = frameReader.push(chunk);
    } catch (error) {
      socket.destroy();
      markClosed(error instanceof Error ? error.message : String(error));
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === 0x9) {
        socket.write(encodeMaskedWebSocketFrame(0xa, frame.payload));
        continue;
      }
      if (frame.opcode === 0xa) continue;
      if (frame.opcode === 0x8) {
        socket.destroy();
        markClosed("上游 WebSocket 已關閉");
        return;
      }
      if (frame.opcode === 0x1) fragments = [frame.payload];
      else if (frame.opcode === 0x0) fragments.push(frame.payload);
      else continue;
      if (!frame.fin) continue;
      const text = Buffer.concat(fragments).toString("utf8");
      fragments = [];
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        continue;
      }
      if (session.onEvent) session.onEvent(event);
    }
  });
  socket.on("error", markClosed);
  socket.on("close", () => markClosed("上游 WebSocket 連線結束"));
  session.send = (payload) => {
    if (session.closed || socket.destroyed || !socket.writable) {
      throw new Error("上游 WebSocket 不可寫");
    }
    socket.write(encodeMaskedWebSocketFrame(0x1, JSON.stringify(payload)));
  };
  session.destroy = () => {
    if (!socket.destroyed) socket.destroy();
    markClosed("本機關閉");
  };
  return session;
}

// 送出一輪並轉發事件。回傳 { ok, retryWithReplay }。
// 在收到 response.in_progress 之前先緩衝：若此時上游拒絕接續，Codex 尚未看到
// 本輪任何事件，可以安全地改用完整歷史重送，不會產生半截輸出。
export function runUpstreamWebSocketTurn(session, payload, { onEvent, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let flushed = false;
    const buffered = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      session.onEvent = null;
      session.onClosed = null;
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const failHard = (error) => {
      if (settled) return;
      settled = true;
      session.onEvent = null;
      session.onClosed = null;
      signal?.removeEventListener("abort", onAbort);
      const failure = error instanceof Error ? error : new Error(String(error));
      failure.eventsForwarded = flushed;
      reject(failure);
    };
    const onAbort = () => {
      if (settled) return;
      try {
        session.send({ type: "response.cancel" });
      } catch {}
      failHard(new Error("已取消"));
      // 取消確認可能晚於下一輪，不能再共用這條連線的事件回呼。
      session.destroy();
    };
    const flush = () => {
      if (flushed) return;
      flushed = true;
      for (const event of buffered.splice(0)) onEvent(event);
    };
    const isInvalidChain = (event) => {
      const message = String(
        event?.error?.message || event?.response?.error?.message || "",
      );
      return message.includes("previous_response_id");
    };

    session.onClosed = (reason) => failHard(reason instanceof Error ? reason : Object.assign(
      new Error(reason || "上游 WebSocket 中斷"), { code: "ECONNRESET" },
    ));
    session.onEvent = (event) => {
      const type = String(event?.type || "");
      if (!flushed && (type === "error" || type === "response.failed") && isInvalidChain(event)) {
        finish({ ok: false, retryWithReplay: true });
        return;
      }
      if (flushed) onEvent(event);
      else buffered.push(event);
      if (type === "response.in_progress") flush();
      if (type === "response.completed" || type === "response.incomplete") {
        flush();
        const responseId = event?.response?.id;
        if (typeof responseId === "string" && responseId) {
          session.responseIds.add(responseId);
          session.responseModels ||= new Map();
          session.responseModels.set(responseId, payload.model);
          while (session.responseIds.size > 64) {
            const oldest = session.responseIds.values().next().value;
            session.responseIds.delete(oldest);
            session.responseModels.delete(oldest);
          }
        }
        finish({ ok: true, retryWithReplay: false });
        return;
      }
      if (type === "response.failed" || type === "error") {
        flush();
        finish({ ok: true, retryWithReplay: false });
      }
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      session.send(payload);
    } catch (error) {
      failHard(error);
    }
  });
}

// HTTP 傳輸同樣需要轉譯。Codex 預設走 WebSocket，但連線反覆失敗後會退回
// HTTPS；此時若把 Anthropic 的原生事件原樣送回，客戶端解不開，該對話就會
// 永遠停在「正在重新連線」，而且再也回不來——因為每次重試都是同一個結果。
export async function bridgeAnthropicToHttp(upstream, response, meta) {
  stats.lastCustomStatus = upstream.status;
  if (!upstream.body) throw new Error("上游響應沒有內文");
  response.routerResponsesStream = true;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let sawTerminal = false;
  await bridgeAnthropicStream(
    upstream.body,
    (event) => {
      if (isTerminalEvent(event)) { sawTerminal = true; response.routerTerminalSent = true; }
      rememberHistoryEvent(meta.history, event);
      response.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
    },
    meta,
  );
  if (!sawTerminal) {
    noteTruncatedStream();
    const event = responseFailedEvent("upstream_stream_truncated", truncatedStreamMessage);
    response.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
  }
  response.end();
}

export async function bridgeAnthropicToWebSocket(upstream, socket, meta, captureId = null) {
  stats.lastWebSocketStatus = upstream.status;
  if (!upstream.body) throw new Error("WebSocket 上游響應沒有內文");
  const tee = captureId
    ? async function* (src) {
        for await (const chunk of src) {
          captureAppend(captureId, "anthropic-response.sse", Buffer.from(chunk));
          yield chunk;
        }
      }
    : null;
  let sawTerminal = false;
  await bridgeAnthropicStream(
    tee ? tee(upstream.body) : upstream.body,
    (event) => {
      captureAppend(captureId, "response.sse", `data: ${JSON.stringify(event)}\n\n`);
      if (isTerminalEvent(event)) sawTerminal = true;
      rememberHistoryEvent(meta.history, event);
      sendWebSocketJson(socket, event);
      stats.websocketEvents += 1;
    },
    meta,
  );
  if (!sawTerminal) {
    noteTruncatedStream();
    sendResponseFailed(socket, "upstream_stream_truncated", truncatedStreamMessage);
  }
}

async function handleWebSocketResponse(
  request,
  socket,
  incomingUrl,
  message,
  abortController,
  connectionState = null,
) {
  // 走上游 WebSocket 的那一輪，決定要透傳接續還是重播完整歷史。
  // 回傳 true 表示本輪已完整處理；false 表示尚未送出任何事件，可安全回退。
  return await handleWebSocketResponseInner(
    request,
    socket,
    incomingUrl,
    message,
    abortController,
    connectionState,
  );
}

async function tryUpstreamWebSocketTurn(
  request,
  socket,
  message,
  abortController,
  connectionState,
) {
  const probe = { ...message };
  delete probe.type;
  const historyKey = historyKeyFor(
    probe,
    request.headers,
    connectionState.connectionNamespace,
  );
  const previousId =
    typeof message.previous_response_id === "string" && message.previous_response_id
      ? message.previous_response_id
      : null;

  let session = connectionState.session;
  if (!session || session.closed) {
    try {
      session = await connectUpstreamWebSocket(request.headers);
    } catch (error) {
      connectionState.upstreamDisabled = true;
      connectionState.session = null;
      stats.upstreamWebSocketFallbacks += 1;
      // 握手失敗代表這個端點現在不可用，是全域現象而非這條連線的問題。
      noteUpstreamWebSocketConnectFailure();
      recordRouterError(error, { transport: "upstream-websocket", route: "official", model: message?.model }, false);
      return false;
    }
    connectionState.session = session;
    noteUpstreamWebSocketConnected();
    stats.upstreamWebSocketConnects += 1;
  }

  // 只有這條上游連線自己產生過的 id 才能接續；其餘情況一律重播完整歷史。
  const canChain = Boolean(previousId && session.responseIds.has(previousId) && session.responseModels?.get(previousId) === message.model);
  const fullInput = previousId
    ? rebuildStatefulInput(historyKey, message.input, previousId)
    : message.input;
  let history = null;
  const buildPayload = (chain) => {
    let outgoing = { ...message };
    history = fullInput ? prepareHistory(historyKey, fullInput, previousId) : null;
    if (chain) {
      stats.upstreamWebSocketIncremental += 1;
    } else {
      outgoing = { ...outgoing, input: fullInput };
      delete outgoing.previous_response_id;
      if (previousId) stats.upstreamWebSocketReplays += 1;
    }
    const sanitized = stripRouterImageArtifacts(stripBridgeArtifacts({ input: outgoing.input }));
    outgoing.input = sanitized.input;
    outgoing.type = "response.create";
    return outgoing;
  };

  const forward = (event) => {
    rememberHistoryEvent(history, event);
    sendWebSocketJson(socket, event);
    stats.websocketEvents += 1;
  };

  for (const chain of canChain ? [true, false] : [false]) {
    // 沒有完整歷史時，交給 HTTP 回退的明確錯誤處理，不能把增量冒充完整輸入。
    if (!chain && previousId && !fullInput) return false;
    let outcome;
    try {
      outcome = await runUpstreamWebSocketTurn(session, buildPayload(chain), {
        onEvent: forward,
        signal: abortController.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "已取消") return true;
      connectionState.upstreamDisabled = true;
      connectionState.session = null;
      session.destroy();
      // 已把本輪內容送給 Codex 時不能再透明重播，否則會產生兩套輸出／工具呼叫。
      if (error.eventsForwarded) throw error;
      stats.upstreamWebSocketFallbacks += 1;
      recordRouterError(error, { transport: "upstream-websocket", route: "official", model: message?.model }, false);
      return false;
    }
    if (outcome.ok) {
      stats.upstreamWebSocketTurns += 1;
      stats.lastWebSocketStatus = 200;
      stats.official += 1;
      stats.lastRoute = "official-ws";
      stats.lastModel = message?.model ?? null;
      stats.lastReasoningEffort = message?.reasoning?.effort ?? null;
      stats.lastForwardedReasoningEffort = message?.reasoning?.effort ?? null;
      markAuthValidated(request.headers);
      return true;
    }
  }
  return false;
}

export async function handleWebSocketResponseInner(
  request,
  socket,
  incomingUrl,
  message,
  abortController,
  connectionState = null,
) {
  // 官方路由優先走上游 WebSocket；只有它支援連線內的 previous_response_id 接續。
  // 任何一步失敗都會回退到既有的 HTTP/SSE 路徑，且此時 Codex 尚未收到本輪事件。
  if (
    upstreamWebSocketEnabled &&
    connectionState &&
    !connectionState.upstreamDisabled &&
    !upstreamWebSocketInCooldown() &&
    message?.type === "response.create" &&
    chooseRoute(request.headers, message) == null &&
    authDigest(request.headers)
  ) {
    const handled = await tryUpstreamWebSocketTurn(
      request,
      socket,
      message,
      abortController,
      connectionState,
    );
    if (handled) return;
  }

  const body = { ...message, stream: true };
  delete body.type;
  for (const field of websocketOnlyFields) {
    if (field in body) {
      delete body[field];
      stats.websocketOnlyFieldsStripped += 1;
    }
  }
  const bodyBuffer = Buffer.from(JSON.stringify(body));
  const captureId = captureNext(
    typeof body.model === "string" && routeMap.has(body.model) ? "custom" : "official",
  );
  captureWrite(captureId, "request.json", JSON.stringify(body, null, 2));
  const stopHeartbeat = startWebSocketHeartbeat(socket);
  const meta = { connectionNamespace: connectionState?.connectionNamespace ?? null, transport: "websocket" };
  try {
    const upstream = await fetchModelUpstream(
      request.headers,
      incomingUrl,
      body,
      bodyBuffer,
      abortController.signal,
      meta,
    );
    stats.websocketResponses += 1;
    if (meta.anthropicRequest) {
      captureWrite(captureId, "anthropic-request.json", JSON.stringify(meta.anthropicRequest, null, 2));
    }
    if (meta.translate === "anthropic" && upstream.status >= 200 && upstream.status < 300) {
      await bridgeAnthropicToWebSocket(upstream, socket, meta, captureId);
    } else {
      await bridgeSseToWebSocket(upstream, socket, captureId, meta.history);
    }
  } finally {
    stopHeartbeat();
  }
}

// 升級前就拒絕的連線：回應要先送完再關。write 之後立刻 destroy 可能把還沒送出的
// 狀態列一起丟掉，用戶端只看到連線被切斷。
function rejectUpgrade(socket, statusLine) {
  socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`, () => socket.destroy());
}

function handleWebSocketUpgrade(request, socket, head) {
  if (!isLoopbackHost(request.headers.host)) {
    stats.foreignHostRejects += 1;
    rejectUpgrade(socket, "403 Forbidden");
    return;
  }
  let incomingUrl;
  try {
    incomingUrl = new URL(request.url || "/", `http://${listenHost}:${listenPort}`);
  } catch {
    socket.destroy();
    return;
  }
  if (
    incomingUrl.pathname !== "/responses" &&
    incomingUrl.pathname !== "/v1/responses"
  ) {
    rejectUpgrade(socket, "404 Not Found");
    return;
  }

  const websocketKey = request.headers["sec-websocket-key"];
  if (typeof websocketKey !== "string") {
    rejectUpgrade(socket, "400 Bad Request");
    return;
  }
  const accept = createHash("sha1")
    .update(websocketKey + websocketMagic)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  stats.websockets += 1;

  const frameReader = createWebSocketFrameReader();
  let fragmentOpcode = null;
  let fragmentChunks = [];
  let activeAbortController = null;
  const pendingMessages = [];
  let pendingMessageBytes = 0;
  // 每條 Codex 連線對應一條上游 WebSocket；接續狀態不能跨連線共用。
  const connectionState = {
    session: null,
    upstreamDisabled: false,
    connectionNamespace: randomBytes(16).toString("hex"),
  };

  const handleMessage = (payload) => {
    let message;
    try {
      message = JSON.parse(payload.toString("utf8"));
    } catch {
      closeWebSocket(socket, 1007, "JSON 無效");
      return;
    }
    if (message?.type === "response.cancel") {
      activeAbortController?.abort();
      return;
    }
    if (message?.type !== "response.create") {
      sendWebSocketJson(socket, {
        type: "error",
        error: {
          type: "unsupported_event",
          code: "unsupported_event",
          message: "僅支援 response.create 和 response.cancel",
        },
      });
      return;
    }
    // 上游送出 response.completed 之後，本路由仍在讀完串流尾端；Codex 一看到
    // completed 就會在同一條連線上送出下一個請求。若此時直接回 response_in_progress，
    // Codex 不處理該錯誤事件而會無聲卡死。因此改為排隊，仍維持逐一序列化執行。
    if (activeAbortController) {
      if (pendingMessages.length >= maxPendingMessages || pendingMessageBytes + payload.length > maxWebSocketMessageBytes) {
        sendWebSocketJson(socket, {
          type: "error",
          error: {
            type: "response_in_progress",
            code: "response_in_progress",
            message: "當前連線的待處理請求過多",
          },
        });
        stats.responseInProgressRejects += 1;
        return;
      }
      pendingMessages.push({ message, bytes: payload.length });
      pendingMessageBytes += payload.length;
      stats.queuedResponses += 1;
      return;
    }

    startResponse(message);
  };

  function startResponse(message) {
    activeAbortController = new AbortController();
    void handleWebSocketResponse(
      request,
      socket,
      incomingUrl,
      message,
      activeAbortController,
      connectionState,
    )
      .catch((error) => {
        const aborted = error instanceof Error && error.name === "AbortError";
        if (!aborted) {
          const detail = recordRouterError(error, {
            transport: "websocket", model: message?.model,
            route: typeof message?.model === "string" && message.model.startsWith("custom/") ? "custom" : "official",
          });
          const messageText = `${detail.message}（診斷 ID：${detail.requestId}）`;
          sendWebSocketJson(socket, {
            type: "error",
            error: {
              type: "router_error",
              code: detail.code,
              message: messageText,
            },
          });
          // 網路層例外（fetch failed / terminated）同樣要送終止事件，
          // 否則 Codex 會停在「思考中」直到 idle timeout 才重試。
          sendResponseFailed(socket, detail.code, messageText);
          if (detail.code === "router_history_unavailable") {
            stats.statefulFallbacks += 1;
            closeWebSocket(socket, 1011, "history unavailable");
          }
        }
      })
      .finally(() => {
        activeAbortController = null;
        const next = pendingMessages.shift();
        if (next) {
          pendingMessageBytes -= next.bytes;
          if (!socket.destroyed && socket.writable) startResponse(next.message);
        }
      });
  }

  const consume = (chunk) => {
    try {
      for (const frame of frameReader.push(chunk)) {
        if (frame.opcode === 0x8) {
          activeAbortController?.abort();
          closeWebSocket(socket);
          return;
        }
        if (frame.opcode === 0x9) {
          sendWebSocketFrame(socket, 0x0a, frame.payload);
          continue;
        }
        if (frame.opcode === 0x0a) continue;
        if (frame.opcode === 0x1 || frame.opcode === 0x2) {
          fragmentOpcode = frame.opcode;
          fragmentChunks = [frame.payload];
        } else if (frame.opcode === 0x0 && fragmentOpcode != null) {
          fragmentChunks.push(frame.payload);
        } else {
          closeWebSocket(socket, 1002, "幀類型不受支援");
          return;
        }
        const fragmentBytes = fragmentChunks.reduce(
          (total, item) => total + item.length,
          0,
        );
        if (fragmentBytes > maxWebSocketMessageBytes) {
          closeWebSocket(socket, 1009, "訊息過大");
          return;
        }
        if (frame.fin) {
          const messagePayload = Buffer.concat(fragmentChunks);
          fragmentOpcode = null;
          fragmentChunks = [];
          handleMessage(messagePayload);
        }
      }
    } catch {
      closeWebSocket(socket, 1002, "幀無效");
    }
  };

  socket.on("data", consume);
  const teardown = () => {
    activeAbortController?.abort();
    connectionState.session?.destroy();
    connectionState.session = null;
  };
  socket.on("close", teardown);
  socket.on("error", teardown);
  // http.Server 的連線允許半關閉：用戶端沒送 Close 訊框就結束（例如行程被終止）時，
  // 這一端只會收到 end，連線與上游 WebSocket 會一直留著。WebSocket 不使用半關閉，直接收掉。
  socket.on("end", () => socket.destroy());
  if (head.length > 0) consume(head);
}

const server = http.createServer(async (request, response) => {
  stats.requests += 1;
  request.routerContext = { transport: "http", route: "official" };
  if (!isLoopbackHost(request.headers.host)) {
    stats.foreignHostRejects += 1;
    writeJson(response, 403, {
      error: { message: "只接受以 127.0.0.1 或 localhost 連線的請求。", type: "router_error", code: "forbidden_host" },
    });
    return;
  }
  try {
    const incomingUrl = new URL(request.url || "/", `http://${listenHost}:${listenPort}`);
    if (request.method === "GET" && incomingUrl.pathname === "/healthz") {
      writeJson(response, 200, {
        status: "ok",
        version: settings.version,
        uptimeSeconds: Math.floor(process.uptime()),
        historyCache: historyCacheInfo(),
        stats,
      });
      return;
    }
    if (
      request.method === "GET" &&
      (incomingUrl.pathname === "/models" || incomingUrl.pathname === "/v1/models")
    ) {
      stats.models += 1;
      const catalog = await refreshOfficialCatalog(request.headers, incomingUrl.searchParams);
      response.setHeader("cache-control", "no-store");
      writeJson(response, 200, catalog);
      return;
    }
    if (
      request.method === "POST" &&
      (incomingUrl.pathname.startsWith("/responses") ||
        incomingUrl.pathname.startsWith("/v1/responses"))
    ) {
      await handleResponses(request, response, incomingUrl);
      return;
    }
    if (request.method === "POST" && IMAGE_PATH_PATTERN.test(incomingUrl.pathname)) {
      await handleImages(request, response, incomingUrl);
      return;
    }
    if (incomingUrl.pathname.startsWith("/v2/extend/image/ark_gpt_image/")) {
      await handleArkImages(request, response, incomingUrl);
      return;
    }
    await proxyToOfficial(request, response, incomingUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted =
      (error instanceof Error && error.name === "AbortError") ||
      message === "This operation was aborted";
    if (aborted) {
      if (!response.writableEnded) response.end();
      return;
    }
    const detail = recordRouterError(error, request.routerContext);
    if (!response.headersSent) {
      writeJson(response, detail.status, {
        error: {
          message: `${detail.message}（診斷 ID：${detail.requestId}）`,
          type: "router_error", code: detail.code, request_id: detail.requestId,
        },
      });
    } else if (!response.writableEnded) {
      if (response.routerResponsesStream && !response.routerTerminalSent) {
        const event = responseFailedEvent(detail.code, `${detail.message}（診斷 ID：${detail.requestId}）`);
        response.write("\n\nevent: response.failed\ndata: " + JSON.stringify(event) + "\n\n");
      }
      response.end();
    }
  }
});

server.on("upgrade", handleWebSocketUpgrade);
export { server as routerServer };

// launchd 與 schtasks 都只是把 stderr 以附加模式導進同一個檔案，沒有任何輪替。
// 上游長時間出錯時會持續寫入，因此啟動時把過大的日誌就地截斷——同一個 inode，
// 附加模式的後續寫入會從 0 重新開始，不會弄丟服務手上的檔案描述子。
// 只在啟動時檢查一次就夠：日誌長得最快的情境正好是服務反覆重啟。
const maxLogBytes =
  Number(settings.maxLogBytes) > 0 ? Number(settings.maxLogBytes) : 5 * 1024 * 1024;

export function truncateOversizedLog(logPath = settings.logPath) {
  if (typeof logPath !== "string" || !logPath) return false;
  try {
    if (statSync(logPath).size <= maxLogBytes) return false;
    writeFileSync(logPath, "");
    return true;
  } catch {
    // 日誌不存在或不可寫都不該擋住啟動。
    return false;
  }
}

// 測試會 import 本檔以驗證純函式，但不能讓它真的佔用連接埠。
// 這個旗標只跳過監聽與訊號處理，其餘模組載入行為完全一致。
if (!process.env.CODEX_MODEL_ROUTER_IMPORT_ONLY) {
  if (truncateOversizedLog()) {
    process.stderr.write(`model-router-log-truncated:${settings.logPath}\n`);
  }

  // /models 在 Codex 啟動時同步官方資料；不再以 bundled 背景覆蓋較新的官方目錄。
  const historyTimer = setInterval(historyCacheInfo, Math.min(historyTtlMs, 60000));
  historyTimer.unref();

  server.listen(listenPort, listenHost, () => {
    process.stderr.write(`model-router-ready:${listenHost}:${listenPort}\n`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
__CODEX_MODEL_ROUTER_BRIDGE_JS__
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
// Codex Responses API <-> Anthropic Messages API 雙向轉譯。
//
// 存在的理由：部分閘道的 /v1/responses 與 /v1/chat/completions 相容層對
// Claude 模型有缺陷（串流回 400 stream_options、非串流 content 恆為空），
// 但 /v1/messages 原生端點完全正常。因此改由本機轉譯。
//
// 兩側格式皆取自實際擷取的封包，見 capture/ 目錄。

const EFFORT_BUDGET = {
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32768,
  // Codex 的 ultra 帶「自動任務委派」語意，Claude 這側無對應概念。
  // 路由不對外宣告 ultra，但全域 model_reasoning_effort 可能飄進來，
  // 因此仍需對應一個預算，否則會靜默地完全不送 thinking。
  ultra: 49152,
};
const DEFAULT_MAX_TOKENS = 32000;
// 留給實際回答的餘裕：max_tokens 必須大於 thinking budget。
const OUTPUT_HEADROOM = 4096;

// Anthropic 的 output_config.effort 接受的檔位。Codex 的五檔剛好同名，
// 因此支援這個參數的模型可以直接透傳，不必再換算成 token 預算。
const ANTHROPIC_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

// ---------------------------------------------------------------- 請求方向

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

// Codex 會把截圖等圖片以 data URL 放進訊息或工具結果。若整包 JSON.stringify
// 成文字，base64 會以「約 1 個 token 對 1 個字元」的比率計費——一張 867 KB 的
// 截圖就要 82 萬 token，兩張就把 100 萬的上下文撐爆，且完全看不出原因。
// 轉成原生 image 區塊後，同一張圖只要約 (寬 x 高) / 750 個 token。
const DATA_URL_PATTERN = /^data:([^;,]+);base64,([\s\S]*)$/;

function toImageBlock(url) {
  if (typeof url !== "string" || !url) return null;
  const match = DATA_URL_PATTERN.exec(url);
  if (match) {
    return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
  }
  if (/^https?:\/\//.test(url)) return { type: "image", source: { type: "url", url } };
  return null;
}

// 單次請求的圖片數量一旦超過 20 張，Anthropic 會把每張圖的尺寸上限從 8000
// 收緊到 2000 像素。實測（同一張合成 PNG，只改高度與張數）：
//   20 張 / 2048px -> 通過
//   21 張 / 2048px -> exceed max allowed size for many-image requests: 2000 pixels
//   21 張 / 1800px -> 通過
// iPhone 截圖是 942 x 2048，只超出 48 個像素就整輪被打回來。
//
// 路由器是純 Node 行程，沒有影像解碼器可以縮圖（macOS 有 sips，Windows 沒有
// 對應的東西，兩邊行為會不一致），因此改為控制張數。提示快取啟用時，
// 超過 20 張就整批省略最舊的 8 張；接下來 7 張不會再改動歷史前綴，
// 避免每張新截圖都讓整段訊息快取失效。未啟用快取仍只省略超額張數。
// 張數壓到上限以內之後尺寸限制自動回到 8000 像素。
const MAX_IMAGES_PER_REQUEST = 20;
const IMAGE_PRUNE_BATCH = 8;
// 就算只有一張，超過 8000 像素一樣會被拒；整頁長截圖很容易超過。
const MAX_IMAGE_DIMENSION = 8000;
const IMAGE_OMITTED_COUNT = "(圖片已省略：超出單次請求的圖片數量上限)";
const IMAGE_OMITTED_SIZE = "(圖片已省略：尺寸超過單張上限)";

// 只讀檔頭就夠了，不需要解碼整張圖。認不出來的格式回 null，一律當作合規，
// 寧可讓上游去判斷，也不要在這裡誤刪使用者的圖。
function imageDimensions(base64) {
  if (typeof base64 !== "string" || !base64) return null;
  let head;
  try {
    head = Buffer.from(base64.slice(0, 4096), "base64");
  } catch {
    return null;
  }
  if (head.length >= 24 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e) {
    return [head.readUInt32BE(16), head.readUInt32BE(20)];
  }
  if (head.length >= 10 && head[0] === 0xff && head[1] === 0xd8) {
    let i = 2;
    while (i + 9 < head.length) {
      if (head[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = head[i + 1];
      // SOF0..SOF15，扣掉 DHT(c4) / JPG(c8) / DAC(cc) 這幾個不是框架標頭的。
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return [head.readUInt16BE(i + 7), head.readUInt16BE(i + 5)];
      }
      const length = head.readUInt16BE(i + 2);
      if (length < 2) return null;
      i += 2 + length;
    }
    return null;
  }
  if (head.length >= 10 && head.subarray(0, 3).toString("latin1") === "GIF") {
    return [head.readUInt16LE(6), head.readUInt16LE(8)];
  }
  return null;
}

// 圖片可能直接掛在訊息底下，也可能包在 tool_result 的 content 陣列裡，兩種都要
// 找得到。回傳的順序就是對話順序，因此「最舊的」永遠排在前面。
function collectImageSlots(messages) {
  const slots = [];
  const walk = (blocks) => {
    if (!Array.isArray(blocks)) return;
    blocks.forEach((block, index) => {
      if (block?.type === "image") slots.push({ blocks, index });
      else if (Array.isArray(block?.content)) walk(block.content);
    });
  };
  for (const message of messages) walk(message.content);
  return slots;
}

// Anthropic 不接受最後一個區塊是 thinking 的 assistant 訊息：
//   messages.N: The final block in an assistant message cannot be `thinking`.
// 一輪被中斷、或那一輪只產出推理就換使用者說話時，歷史裡就會留下這種訊息。
// 沒有後續內容的推理留著也沒有意義（簽章要配合同一輪的輸出才有用），直接剝掉。
// 剝完可能整則變空，空訊息同樣會被拒，因此順手移除並把相鄰的同角色訊息合併——
// Anthropic 要求 user 與 assistant 交替出現。
const THINKING_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);

export function normalizeAssistantMessages(messages) {
  let trimmed = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    while (
      message.content.length > 0 &&
      THINKING_BLOCK_TYPES.has(message.content[message.content.length - 1]?.type)
    ) {
      message.content.pop();
      trimmed += 1;
    }
  }
  const merged = [];
  for (const message of messages) {
    if (!Array.isArray(message.content) || message.content.length === 0) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) last.content.push(...message.content);
    else merged.push(message);
  }
  messages.splice(0, messages.length, ...merged);
  return trimmed;
}

// Anthropic 要求同一則 user 訊息裡的 tool_result 全部排在最前面，文字與圖片只能
// 接在後面，否則整輪 400（tool_use ids were found without tool_result blocks
// immediately after）。遲到的工具輸出改成文字後，後面可能還接著其他呼叫的結果；
// 工具呼叫與結果之間若夾了 user 內容也會如此。這裡把 tool_result 穩定地往前移，
// 其餘區塊維持原本的相對順序。回傳調整過的訊息數。
export function orderToolResultsFirst(messages) {
  let reordered = 0;
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const firstOther = message.content.findIndex((block) => block?.type !== "tool_result");
    if (firstOther < 0) continue;
    if (!message.content.slice(firstOther).some((block) => block?.type === "tool_result")) continue;
    const results = message.content.filter((block) => block?.type === "tool_result");
    const others = message.content.filter((block) => block?.type !== "tool_result");
    message.content.splice(0, message.content.length, ...results, ...others);
    reordered += 1;
  }
  return reordered;
}

// 平台內建工具項目的簡短文字描述。只摘要已知欄位並截斷長內容，
// 仍不認得的項目由呼叫端照舊拒絕，不默默刪除。
const HOSTED_TOOL_LABELS = {
  web_search_call: "網頁搜尋",
  file_search_call: "檔案搜尋",
  code_interpreter_call: "程式碼執行",
  image_generation_call: "生圖",
  local_shell_call: "本機命令",
  computer_call: "電腦操作",
  computer_call_output: "電腦操作結果",
  mcp_call: "MCP 工具",
  mcp_list_tools: "MCP 工具清單",
  mcp_approval_request: "MCP 授權請求",
  mcp_approval_response: "MCP 授權回覆",
  tool_search_call: "工具搜尋",
  tool_search_output: "工具搜尋結果",
};

function clipText(value, max = 300) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function hostedToolSummary(item) {
  const label = HOSTED_TOOL_LABELS[item?.type];
  if (!label) return null;
  const action = item.action && typeof item.action === "object" ? item.action : {};
  let detail = "";
  if (item.type === "web_search_call") {
    if (action.type === "search") detail = `：${clipText(action.query ?? action.queries ?? "")}`;
    else if (action.type === "open_page" && action.url) detail = `：開啟 ${clipText(action.url)}`;
    else if (action.url && action.pattern) detail = `：在 ${clipText(action.url)} 中尋找 ${clipText(action.pattern)}`;
  } else if (item.type === "image_generation_call" && typeof item.revised_prompt === "string" && item.revised_prompt) {
    detail = `，提示詞：${clipText(item.revised_prompt)}`;
  } else if (item.type === "local_shell_call" && action.command) {
    detail = `：${clipText(Array.isArray(action.command) ? action.command.join(" ") : action.command)}`;
  } else if (item.type === "mcp_call") {
    detail = `：${clipText(`${item.server_label ?? ""}/${item.name ?? ""}`, 120)}`;
    if (item.output) detail += `，結果：${clipText(item.output, 800)}`;
    if (item.error) detail += `，錯誤：${clipText(item.error)}`;
  } else if (item.type === "code_interpreter_call" && item.code) {
    detail = `：${clipText(item.code, 800)}`;
  } else if (item.type === "file_search_call" && Array.isArray(item.queries)) {
    detail = `：${clipText(item.queries.join("；"))}`;
  }
  return {
    role: /_(?:output|response)$/.test(item.type) ? "user" : "assistant",
    text: `(先前的回合使用了平台內建的${label}${detail})`,
  };
}

// 模型往下走之後才送達的工具輸出，標明它屬於哪一次呼叫，免得被當成使用者的話。
function lateToolOutputNotice(item) {
  const name = typeof item.name === "string" && item.name ? `（${item.name.slice(0, 64)}）` : " ";
  return `(工具呼叫 ${item.call_id}${name}的結果已先回傳；以下是之後才送達的後續輸出)`;
}

function applyImageBudget(messages, { batchCachePruning = false } = {}) {
  const slots = collectImageSlots(messages);
  if (slots.length === 0) return 0;
  let omitted = 0;
  const omit = (slot, text) => {
    slot.blocks[slot.index] = { type: "text", text };
    omitted += 1;
  };
  // 先處理單張就超標的，這種無論總數多少都會被拒。
  const kept = [];
  for (const slot of slots) {
    const image = slot.blocks[slot.index];
    const size = image?.source?.type === "base64" ? imageDimensions(image.source.data) : null;
    if (size && (size[0] > MAX_IMAGE_DIMENSION || size[1] > MAX_IMAGE_DIMENSION)) {
      omit(slot, IMAGE_OMITTED_SIZE);
    } else {
      kept.push(slot);
    }
  }
  // 到門檻時整批省略舊圖，讓後續幾輪的歷史前綴不再變動。頂層
  // cache_control 的滾動斷點便能命中上一輪，不需要新增上游相容性參數。
  const excess = kept.length - MAX_IMAGES_PER_REQUEST;
  if (excess > 0) {
    const count = batchCachePruning
      ? Math.min(kept.length, Math.ceil(excess / IMAGE_PRUNE_BATCH) * IMAGE_PRUNE_BATCH)
      : excess;
    for (let i = 0; i < count; i += 1) omit(kept[i], IMAGE_OMITTED_COUNT);
  }
  return omitted;
}

function bridgeInputError(message) {
  return Object.assign(new Error(message), { name: "BridgeRequestError" });
}

function parseToolArguments(value) {
  let parsed;
  try { parsed = typeof value === "string" ? JSON.parse(value || "{}") : value; }
  catch { throw bridgeInputError("工具參數不是完整 JSON；未產生替代參數，請重新產生該工具呼叫。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw bridgeInputError("工具參數必須是 JSON 物件；未執行該工具呼叫。");
  }
  return parsed;
}

function toAnthropicBlocks(content) {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    if (content === null || content === undefined) return [];
    const text = JSON.stringify(content);
    return text ? [{ type: "text", text }] : [];
  }
  const blocks = [];
  for (const part of content) {
    if (part?.type === "resource_link") {
      blocks.push({ type: "text", text: JSON.stringify({ name: part.name, title: part.title, uri: part.uri, description: part.description }) });
      continue;
    }
    if (part?.type === "resource" && typeof part.resource?.text === "string") {
      blocks.push({ type: "text", text: part.resource.text });
      continue;
    }
    if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
      const image = toImageBlock(`data:${part.mimeType};base64,${part.data}`);
      if (!image) throw bridgeInputError("Claude 無法解析這個工具圖片格式，請轉成 PNG、JPEG、GIF 或 WebP。");
      blocks.push(image);
      continue;
    }
    if (part?.type === "input_file") {
      const data = typeof part.file_data === "string" && /^data:application\/pdf;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(part.file_data);
      if (data) blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: data[1] } });
      else if (typeof part.file_url === "string" && /^https?:\/\//.test(part.file_url)) {
        blocks.push({ type: "document", source: { type: "url", url: part.file_url } });
      } else throw bridgeInputError("Claude 轉譯不支援這種檔案引用；請用本機檔案工具讀取內容，或提供 PDF data URL／公開文件 URL。");
      continue;
    }
    if (typeof part?.text === "string" && part.text) {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    const image = toImageBlock(part?.image_url ?? part?.url);
    if (image) { blocks.push(image); continue; }
    if (part?.type && !["text", "input_text", "output_text"].includes(part.type)) {
      throw bridgeInputError("Claude 轉譯收到不支援的內容類型；請先用對應工具讀取或轉換附件，再重送文字／圖片。");
    }
  }
  return blocks;
}

// Anthropic 沒有 Responses 的 namespace 工具型別，所以送往上游時要用唯一別名攤平；
// 回到 Codex 時再靠 targets 拆回 { namespace, name }。Codex 的 function_call /
// custom_tool_call 把 namespace 放在獨立欄位，不能把完整別名直接塞進 name。
export function toolAlias(namespace, name) {
  const ns = namespace && namespace !== "functions" ? namespace : null;
  const alias = ns ? `${ns}__${name}` : name;
  // 保留一般工具的既有名稱；有歧義、過長或含非法字元者改用固定長度別名。
  if (typeof name === "string" && !name.includes("__") &&
      typeof alias === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(alias) && !alias.startsWith("cmr_")) return alias;
  return "cmr_" + createHash("sha256").update(JSON.stringify([ns, name])).digest("hex").slice(0, 60);
}

function flattenTools(items, out = [], namespace = null, targets = new Map()) {
  for (const tool of items || []) {
    if (tool?.type === "namespace") {
      const nested = !tool.name || (tool.name === "functions" && !namespace)
        ? namespace
        : (namespace ? `${namespace}__${tool.name}` : tool.name);
      flattenTools(tool.tools, out, nested, targets);
    } else if (tool?.name) {
      const effectiveNamespace = namespace || tool.namespace || null;
      const alias = toolAlias(effectiveNamespace, tool.name);
      const previous = out.findIndex((item) => item.name === alias);
      if (previous >= 0) out.splice(previous, 1);
      out.push(alias === tool.name ? tool : { ...tool, name: alias });
      targets.set(alias, effectiveNamespace && effectiveNamespace !== "functions"
        ? { name: tool.name, namespace: effectiveNamespace }
        : { name: tool.name });
    }
  }
  return { tools: out, targets };
}

// Codex 的 type:"custom" 是自由格式工具（input 為原始字串），
// Anthropic 沒有對應概念，用單一 string 參數的 schema 模擬。
const FREEFORM_KEY = "input";

// Anthropic 的 input_schema 不接受「頂層」的 oneOf / allOf / anyOf
// （錯誤訊息：input_schema does not support oneOf, allOf, or anyOf at the top level）。
// 巢狀在 properties 裡的組合關鍵字是合法的，因此只攤平最外層。
//
// allOf → 合併所有分支（properties 聯集、required 聯集）
// oneOf / anyOf → properties 取聯集，required 取交集（只保留每個分支都必填的）
function flattenTopLevelSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  const combinators = ["allOf", "oneOf", "anyOf"].filter(
    (k) => Array.isArray(schema[k]) && schema[k].length > 0,
  );
  if (combinators.length === 0) {
    // 仍需確保是 object 型別，Anthropic 只接受物件 schema。
    if (schema.type && schema.type !== "object") {
      return { type: "object", properties: { value: schema }, required: ["value"] };
    }
    return { ...schema, type: "object", properties: schema.properties || {} };
  }

  const rest = { ...schema };
  const properties = { ...(schema.properties || {}) };
  let required = Array.isArray(schema.required) ? [...schema.required] : null;

  for (const key of combinators) {
    const branches = schema[key].map((b) => flattenTopLevelSchema(b));
    delete rest[key];
    for (const b of branches) Object.assign(properties, b.properties || {});
    const branchRequired = branches.map((b) =>
      Array.isArray(b.required) ? b.required : [],
    );
    if (key === "allOf") {
      const union = new Set(required || []);
      for (const r of branchRequired) for (const k of r) union.add(k);
      required = [...union];
    } else {
      // 分支互斥，只有每個分支都必填的欄位才能安全地標為必填。
      let inter = branchRequired[0] || [];
      for (const r of branchRequired.slice(1)) inter = inter.filter((k) => r.includes(k));
      required = required ? required.filter((k) => inter.includes(k)) : inter;
    }
  }

  const out = { ...rest, type: "object", properties };
  if (required && required.length) out.required = required;
  else delete out.required;
  return out;
}

const CODE_MODE_DISCOVERY_MARKER = "## On-demand nested tool definitions";
const CODE_MODE_DISCOVERY = `${CODE_MODE_DISCOVERY_MARKER}
Some nested tool definitions below are summaries only. All tools remain registered and callable.
Before first using a summarized tool, read its FULL description from ALL_TOOLS by exact name;
that description includes its parameter schema, usage rules, restrictions and approval requirements.
Follow those rules in full. A summary is NOT sufficient to call the tool.
For discovery, search names first, then descriptions if needed. Show at most 5 candidate names
and short summaries (at most 120 characters each), then retrieve only the selected full definition.
Do not print ALL_TOOLS or all matching full descriptions. Use additional targeted searches if needed.
Example: text(ALL_TOOLS.filter(t => /keyword/i.test(t.name)).slice(0, 5)
  .map(t => ({ name: t.name, summary: t.description.slice(0, 120) })));
Then: text(ALL_TOOLS.find(t => t.name === "exact_tool_name")?.description);
Only after reading it, call the unchanged tools.exact_tool_name with its documented arguments.
`;

// Only change the model-facing copy of Codex's documented Code Mode registry.
// The actual executor and ALL_TOOLS retain full descriptions, schemas and permissions.
// Unknown formats are left intact; headings inside code examples are never boundaries.
export function compactCodeModeDescription(description) {
  const unchanged = { description, toolsDeferred: 0, charsSaved: 0 };
  if (typeof description !== "string" ||
      !description.startsWith("Run JavaScript code to orchestrate/compose tool calls") ||
      !description.includes("All nested tools are available on the global `tools` object") ||
      !description.includes("`ALL_TOOLS`: metadata for the enabled nested tools") ||
      description.includes(CODE_MODE_DISCOVERY_MARKER)) return unchanged;

  const headings = [];
  let fence = null;
  for (const match of description.matchAll(/^.*(?:\n|$)/gm)) {
    const line = match[0].replace(/\r?\n$/, "");
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) { fence = open[1]; continue; }
    const heading = /^### `([a-zA-Z0-9_]+)`$/.exec(line);
    if (heading) headings.push({ name: heading[1], start: match.index, content: match.index + match[0].length });
  }
  if (fence || !headings.length) return unchanged;

  const edits = [];
  for (let i = 0; i < headings.length; i += 1) {
    const { name, start, content } = headings[i];
    // Keep core tools and the complete web/image instructions eagerly visible.
    if (!name.includes("__") || name.startsWith("web__") || name.startsWith("image_gen__")) continue;
    const end = headings[i + 1]?.start ?? description.length;
    const block = description.slice(content, end);
    const declarations = [...block.matchAll(/\nexec tool declaration:\n```ts\n([\s\S]*?)\n```(?=\n|$)/g)];
    if (declarations.length !== 1) continue;
    const declaration = declarations[0];
    if (!declaration[1].startsWith(`declare const tools: { ${name}(`) ||
        !declaration[1].trimEnd().endsWith("};")) continue;
    // Do not consume following namespace headings or instructions after the declaration.
    const stop = content + declaration.index + declaration[0].length;
    const summary = block.slice(0, declaration.index).trim().split(/\r?\n/, 1)[0].trim();
    if (!summary || summary.startsWith("#") || summary.startsWith("```")) continue;
    const short = summary.length > 180 ? summary.slice(0, 177) + "..." : summary;
    const replacement = `### \`${name}\`\nSummary only: ${short}\nRead the full ALL_TOOLS definition before use.`;
    if (stop - start <= replacement.length + 96) continue;
    edits.push({ start, stop, replacement });
  }
  if (!edits.length) return unchanged;
  let result = description;
  for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.stop);
  const insertion = headings[0].start;
  result = result.slice(0, insertion) + CODE_MODE_DISCOVERY + "\n" + result.slice(insertion);
  if (result.length >= description.length) return unchanged;
  return { description: result, toolsDeferred: edits.length, charsSaved: description.length - result.length };
}

function toAnthropicTools(codexTools) {
  const tools = [];
  const freeform = new Set();
  const toolContext = { toolsDeferred: 0, originalChars: 0, forwardedChars: 0, charsSaved: 0 };
  for (const tool of codexTools) {
    if (tool.type === "custom") {
      freeform.add(tool.name);
      let description = tool.description || "";
      if (tool.name === "exec") {
        const compacted = compactCodeModeDescription(description);
        toolContext.toolsDeferred += compacted.toolsDeferred;
        toolContext.originalChars += description.length;
        toolContext.forwardedChars += compacted.description.length;
        toolContext.charsSaved += compacted.charsSaved;
        description = compacted.description;
      }
      tools.push({
        name: tool.name,
        description,
        input_schema: {
          type: "object",
          properties: {
            [FREEFORM_KEY]: {
              type: "string",
              description:
                "The raw payload for this tool, passed through verbatim.",
            },
          },
          required: [FREEFORM_KEY],
        },
      });
    } else if (tool.type === "function") {
      tools.push({
        name: tool.name,
        description: tool.description || "",
        input_schema: flattenTopLevelSchema(tool.parameters),
      });
    }
  }
  return { tools, freeform, toolContext };
}

// Codex 會把舊 reasoning.encrypted_content 的字串長度當成額外的歷史推理 token。
// Claude 的 input_tokens 已包含這些推理；把整段 thinking/signature 放在欄位裡
// 會讓 Codex 重複計數，在實際用量約一半時提早精簡。只交給 Codex 短索引，
// 原文以內容雜湊持久保存，下一輪仍可完整送回 Anthropic。
// 檔案留在安裝目錄，update 原地換程式碼不會移走；不能按 TTL 淘汰，
// 否則舊任務恢復後會找不到簽章。
const reasoningStoreDir = join(dirname(fileURLToPath(import.meta.url)), "reasoning-store");
const REASONING_REF_VERSION = 1;
const reasoningRefPattern = /^[a-f0-9]{64}$/;
let warnedReasoningStore = false;

function parseReasoningPayload(raw) {
  const parsed = JSON.parse(raw);
  if (typeof parsed?.redacted_thinking === "string" && parsed.redacted_thinking) {
    return { type: "redacted_thinking", data: parsed.redacted_thinking };
  }
  if (!parsed || typeof parsed.thinking !== "string" || !parsed.signature) return null;
  return { type: "thinking", thinking: parsed.thinking, signature: parsed.signature };
}

function decodeReasoning(encrypted) {
  if (typeof encrypted !== "string" || !encrypted) return null;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(encrypted, "base64").toString("utf8")); }
  catch { return null; }
  if (parsed?.router_reasoning_ref != null) {
    if (parsed.router_reasoning_ref !== REASONING_REF_VERSION ||
        !reasoningRefPattern.test(parsed.sha256)) {
      throw bridgeInputError("Claude 歷史推理索引格式無效；請還原原任務歷史或提供工作摘要。");
    }
    try {
      const compressed = readFileSync(join(reasoningStoreDir, parsed.sha256 + ".json.gz"));
      const raw = gunzipSync(compressed);
      const digest = createHash("sha256").update(raw).digest("hex");
      if (digest !== parsed.sha256) throw new Error("digest mismatch");
      const block = parseReasoningPayload(raw.toString("utf8"));
      if (!block) throw new Error("invalid reasoning payload");
      return block;
    } catch {
      // 不能靜默丟棄 thinking：工具呼叫的簽章與歷史就不再一致。
      throw bridgeInputError(
        "Claude 歷史推理檔案遺失或損壞；請還原 model-router/reasoning-store，或在新任務中提供工作摘要。",
      );
    }
  }
  try { return parseReasoningPayload(JSON.stringify(parsed)); }
  catch { return null; }
}

export function encodeReasoning(thinking, signature) {
  const raw = Buffer.from(JSON.stringify({ thinking, signature }), "utf8");
  if (typeof thinking !== "string" || !signature) return raw.toString("base64");
  return storeReasoning(raw);
}

// 安全系統遮蔽的推理（redacted_thinking）只有一段不透明的密文，同樣必須原樣送回：
// 工具回合裡少了它，Anthropic 會以「最後一則 assistant 訊息必須以 thinking 開頭」拒收。
export function encodeRedactedReasoning(data) {
  const raw = Buffer.from(JSON.stringify({ redacted_thinking: String(data ?? "") }), "utf8");
  if (typeof data !== "string" || !data) return raw.toString("base64");
  return storeReasoning(raw);
}

function storeReasoning(raw) {
  const digest = createHash("sha256").update(raw).digest("hex");
  try {
    mkdirSync(reasoningStoreDir, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(join(reasoningStoreDir, digest + ".json.gz"), gzipSync(raw),
        { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // 同一段推理重試時可以複用；已有檔案若損壞，這一輪回退原格式。
      const saved = gunzipSync(readFileSync(join(reasoningStoreDir, digest + ".json.gz")));
      if (createHash("sha256").update(saved).digest("hex") !== digest) {
        throw new Error("digest mismatch");
      }
    }
    return Buffer.from(JSON.stringify({
      // 舊版路由至少能識別並剝除這個 reasoning，避免回退後切到官方模型時
      // 把不受信任的索引送給官方；新版會先識別 ref，從檔案還原真正簽章。
      thinking: "", signature: "r",
      router_reasoning_ref: REASONING_REF_VERSION, sha256: digest,
    }), "utf8").toString("base64");
  } catch (error) {
    if (!warnedReasoningStore) {
      warnedReasoningStore = true;
      process.stderr.write(`model-router-reasoning-store-fallback:${error.code || "invalid"}\n`);
    }
    // 磁碟不可寫時至少保住這一輪的簽章與回應；只是早期精簡問題仍可能出現。
    return raw.toString("base64");
  }
}

// --- remote compaction v2 -----------------------------------------------
// Codex 上下文滿了會發一輪壓縮請求：input 末端附一個 {"type":"compaction_trigger"}，
// 並要求輸出「恰好一個」{"type":"compaction"} 項目，否則整輪 Fatal
// （remote compaction v2 expected exactly one compaction output item, got 0 ...）。
// 那個項目在官方是後端合成的，模型本身不會吐，因此轉譯層必須自己補。
//
// encrypted_content 對客戶端是不透明字串，只會被原樣塞回後續請求的 input，
// 所以比照 reasoning 的做法把摘要編碼進去，下一輪再解出來還原成訊息。
const COMPACTION_PROMPT =
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\n" +
  "Include:\n" +
  "- Current progress and key decisions made\n" +
  "- Important context, constraints, or user preferences\n" +
  "- What remains to be done (clear next steps)\n" +
  "- Any critical data, examples, or references needed to continue\n\n" +
  "Be concise, structured, and focused on helping the next LLM seamlessly continue the work.\n";

export const COMPACTION_REPLAY_PREFIX =
  "Summary of the earlier conversation, compacted. Continue the task from here.\n\n";

export function encodeCompaction(summary) {
  return Buffer.from(JSON.stringify({ compaction: summary }), "utf8").toString("base64");
}

export function decodeCompaction(encrypted) {
  if (typeof encrypted !== "string" || !encrypted) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encrypted, "base64").toString("utf8"));
    if (parsed && typeof parsed.compaction === "string") return parsed.compaction;
  } catch {}
  return null;
}

// route 可傳字串（僅模型名）或路由物件（含探測到的 maxOutputTokens）。
export function toAnthropicRequest(body, route) {
  const upstreamModel = typeof route === "string" ? route : route?.upstreamModel;
  const modelMaxOutput =
    typeof route === "object" && Number.isFinite(route?.maxOutputTokens) && route.maxOutputTokens > 0
      ? route.maxOutputTokens
      : null;
  const systemParts = typeof body.instructions === "string" && body.instructions ? [body.instructions] : [];
  const messages = [];
  let compaction = false;

  // 同 role 的連續區塊必須合併，否則 Anthropic 會拒絕。
  const push = (role, block) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };

  // Anthropic 規定每個 tool_use 只能有一個 tool_result。記住已產生的區塊，
  // 同一個 call_id 的後續輸出才能併回去，而不是再生出一個重複的結果。
  const toolResults = new Map();
  const placeholderResults = new WeakSet();
  let toolOutputsMerged = 0;
  let lateToolOutputs = 0;

  // body.input 允許是純字串（簡易呼叫），統一成項目陣列。
  const inputItems = typeof body.input === "string"
    ? [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }]
    : (Array.isArray(body.input) ? body.input : []);

  // 同時接受標準 Responses 頂層 tools 與 Codex 的 additional_tools；後出現的同名定義優先。
  const toolDefinitions = [...(Array.isArray(body.tools) ? body.tools : [])];
  for (const item of inputItems) if (item?.type === "additional_tools") toolDefinitions.push(...(item.tools || []));
  const { tools: codexTools, targets: toolTargets } = flattenTools(toolDefinitions);
  const unavailable = [];
  const inspectTools = (tools) => {
    for (const tool of tools) {
      if (tool?.type === "namespace") inspectTools(tool.tools || []);
      else if (!["function", "custom"].includes(tool?.type)) unavailable.push(tool?.type || "unknown");
    }
  };
  inspectTools(toolDefinitions);
  if (unavailable.length) {
    // 平台內建工具沒有可轉送的本機執行器。不可假裝已啟用，也不可改投另一個付費供應商。
    systemParts.push("此 Claude 轉譯路由不提供以下平台內建工具：" +
      [...new Set(unavailable)].map((name) => String(name).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)).join(", ") +
      "。只能呼叫本次實際提供的 function/custom 工具。需要生圖且已安裝 router-imagegen 技能時，可使用該技能；沒有可用工具時請明確說明，勿宣稱已完成。");
  }
  if (body.text?.format && body.text.format.type !== "text") {
    throw bridgeInputError("Claude 轉譯尚未支援此結構化輸出格式，請改用文字或函式工具輸出。");
  }
  for (const item of inputItems) {
    switch (item?.type || (item?.role ? "message" : null)) {
      case "additional_tools": {
        break;
      }

      case "message": {
        if (item.role === "developer" || item.role === "system") {
          // system 只接受純文字。
          const text = textOf(item.content);
          if (text) systemParts.push(text);
          break;
        }
        const blocks = toAnthropicBlocks(item.content);
        if (!blocks.length) break;
        if (item.role === "assistant") {
          // Anthropic 的 assistant 訊息不接受圖片區塊。
          for (const block of blocks) if (block.type === "text") push("assistant", block);
        } else {
          for (const block of blocks) push("user", block);
        }
        break;
      }

      case "reasoning": {
        const block = decodeReasoning(item.encrypted_content);
        if (block) push("assistant", block);
        break;
      }

      case "custom_tool_call":
        if (typeof item.input !== "string") throw bridgeInputError("歷史自由格式工具的 input 必須是字串，無法安全替換成空內容。");
        push("assistant", {
          type: "tool_use",
          id: item.call_id,
          name: toolAlias(item.namespace, item.name),
          input: { [FREEFORM_KEY]: item.input },
        });
        break;

      case "function_call": {
        const input = parseToolArguments(item.arguments ?? "{}");
        push("assistant", {
          type: "tool_use",
          id: item.call_id,
          name: toolAlias(item.namespace, item.name),
          input,
        });
        break;
      }

      // 官方 GPT 回合的本機命令：轉成 tool_use，後面那筆輸出才配得上 tool_result。
      case "local_shell_call": {
        const action = item.action && typeof item.action === "object" && !Array.isArray(item.action) ? item.action : {};
        if (item.call_id) push("assistant", { type: "tool_use", id: item.call_id, name: "local_shell", input: action });
        else push("assistant", { type: "text", text: hostedToolSummary(item).text });
        break;
      }

      case "local_shell_call_output":
      case "custom_tool_call_output":
      case "function_call_output": {
        // local_shell_call_output 以 id 指向那次呼叫的 call_id。
        const output = item.type === "local_shell_call_output" && !item.call_id ? { ...item, call_id: item.id } : item;
        const blocks = toAnthropicBlocks(output.output);
        // 從另一個 Codex 任務轉送進來的訊息會以 function_call_output 表示，
        // 但沒有 call_id；它不是某次工具呼叫的結果，不能產生缺 tool_use_id 的
        // Anthropic tool_result。保留成普通 user 內容，模型才能收到轉送的指示。
        if (!output.call_id) {
          for (const block of blocks) push("user", block);
          break;
        }
        // Code Mode 的 exec 每呼叫一次 notify()，Codex 就替同一個 call_id 追加一筆
        // 輸出（實際案例：最終結果後面接 6 則「CI 仍在建置」）。Responses 接受這種
        // 歷史，Anthropic 卻會整輪 400：each tool_use must have a single result。
        // 之後每一輪都重送同一段歷史，連壓縮請求也一樣，對話等於卡死。
        const earlier = toolResults.get(output.call_id);
        if (earlier) {
          if (!blocks.length) break;
          const last = messages[messages.length - 1];
          if (last?.role === "user" && last.content.includes(earlier)) {
            // 還在同一則 user 訊息裡：依序併入原本的結果。
            if (placeholderResults.has(earlier)) {
              earlier.content = [];
              placeholderResults.delete(earlier);
            }
            earlier.content.push(...blocks);
            toolOutputsMerged += 1;
          } else {
            // 模型已經往下走了（例如背景執行中的 exec 之後才送來通知）。改寫舊的
            // tool_result 會讓那之後的提示快取全部失效，因此照時間順序改成 user 文字。
            push("user", { type: "text", text: lateToolOutputNotice(output) });
            for (const block of blocks) push("user", block);
            lateToolOutputs += 1;
          }
          break;
        }
        const result = {
          type: "tool_result",
          tool_use_id: output.call_id,
          content: blocks.length ? blocks : [{ type: "text", text: "(no output)" }],
        };
        if (!blocks.length) placeholderResults.add(result);
        toolResults.set(output.call_id, result);
        push("user", result);
        break;
      }

      // 官方 GPT 回合留下的平台內建工具項目（網頁搜尋、生圖等）。切到 Claude 繼續同一條
      // 對話時它們都已完成，也沒有可轉送的執行器；轉成簡短文字，否則每一輪都會 422。
      case "web_search_call":
      case "file_search_call":
      case "code_interpreter_call":
      case "image_generation_call":
      case "computer_call":
      case "computer_call_output":
      case "mcp_call":
      case "mcp_list_tools":
      case "mcp_approval_request":
      case "mcp_approval_response":
      case "tool_search_call":
      case "tool_search_output": {
        const summary = hostedToolSummary(item);
        push(summary.role, { type: "text", text: summary.text });
        break;
      }

      // 這一輪是壓縮回合（項目本身不帶內容，純粹是請求控制）。
      case "compaction_trigger":
        compaction = true;
        break;

      // 前一次壓縮的產物，會一直跟著後續每一輪回來；還原成文字才不會遺失上下文。
      case "compaction":
      case "context_compaction": {
        const summary = decodeCompaction(item.encrypted_content);
        if (summary) push("user", { type: "text", text: `${COMPACTION_REPLAY_PREFIX}${summary}` });
        break;
      }

      default:
        if (item?.type) {
          const type = String(item.type).replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 64);
          throw bridgeInputError(`Claude 轉譯收到不支援的對話項目（${type}），無法安全省略；請改用原模型繼續，或在新任務中提供工作摘要。`);
        }
        break;
    }
  }

  // compaction_trigger 本身沒有文字，模型不會知道要做什麼；補上與 Codex 本機
  // 壓縮同一份提示詞，產出的摘要格式才會跟官方一致。
  if (compaction) push("user", { type: "text", text: COMPACTION_PROMPT });

  const thinkingTrimmed = normalizeAssistantMessages(messages);
  const toolResultsReordered = orderToolResultsFirst(messages);

  // Anthropic 要求首個訊息必須是 user。
  if (!messages.length || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: [{ type: "text", text: "." }] });
  }

  const imagesOmitted = applyImageBudget(messages, { batchCachePruning: route?.promptCache === true });

  const { tools, freeform, toolContext } = toAnthropicTools(codexTools);

  const effort = body?.reasoning?.effort;
  // 推理強度有兩種控制方式，安裝時探測出哪一種可用：
  //
  //   output_config  新式。Codex 的五檔與 Anthropic 的 effort 同名，直接透傳。
  //                  thinking 交給模型自己決定（現行模型預設就是開著的）。
  //   thinking_budget 舊式。budget_tokens 只在較舊的模型上有效；在 Opus 5 這類
  //                  模型上官方直接 400，部分閘道則是靜默丟掉——結果就是使用者
  //                  在 Codex 裡選 low 或 max 完全沒有差別，且一律跑在高強度。
  const useOutputConfig = route?.effortControl === "output_config";

  let budget = useOutputConfig ? 0 : EFFORT_BUDGET[effort] || 0;
  let maxTokens = Math.max(
    Number(body.max_output_tokens) || DEFAULT_MAX_TOKENS,
    budget + OUTPUT_HEADROOM,
  );
  // 不可超過該模型實際允許的輸出上限，否則上游直接 400。
  if (modelMaxOutput) maxTokens = Math.min(maxTokens, modelMaxOutput);
  // 夾過之後 budget 可能反超 max_tokens，需同步縮小以維持 budget < max_tokens。
  // 這裡不能設下限：閘道回報的輸出上限若小到連 headroom 都放不下，硬撐一個
  // 1024 的 budget 會等於甚至超過 max_tokens，Anthropic 直接回 400。
  // 縮到 1024 以下就讓下面的門檻自己關掉 thinking，換取這一輪仍能正常回答。
  if (budget && budget + OUTPUT_HEADROOM > maxTokens) {
    budget = maxTokens - OUTPUT_HEADROOM;
  }

  const request = {
    model: upstreamModel,
    max_tokens: maxTokens,
    messages,
    stream: true,
  };

  // 滾動快取斷點：Anthropic 的快取前綴是 tools -> system -> messages，只在
  // system 掛斷點的話，會長大的對話歷史每輪都要重算。頂層 cache_control 會把
  // 斷點自動推到最新一輪，後續請求整段歷史都能命中快取。
  // 必須是明確探測過的 true：升級前裝的路由沒有這個欄位，若預設開啟，遇到不吃
  // 頂層 cache_control 的閘道會讓每一條 Claude 請求都 400。
  if (route?.promptCache === true) request.cache_control = { type: "ephemeral" };

  if (systemParts.length) {
    // 最後一段掛 cache_control，讓穩定的前綴可被快取。
    const blocks = systemParts.map((text) => ({ type: "text", text }));
    blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
    request.system = blocks;
  }
  // 壓縮回合只能回一個 compaction 項目，模型不能改去呼叫工具；tool_choice:"none" 亦然。
  // 但 tools 不能拿掉：歷史裡有 tool_use／tool_result 時，Anthropic 要求請求必須定義
  // tools，否則整輪 400（Requests which include tool_use or tool_result blocks must
  // define tools）；拿掉 tools 也會讓 tools → system 這段快取前綴失效。
  // 改用 tool_choice:{type:"none"} 禁止呼叫，tools 與一般回合完全相同。
  if (tools.length) {
    request.tools = tools;
    if (compaction || body.tool_choice === "none") request.tool_choice = { type: "none" };
    else if (body.tool_choice === "auto" || !body.tool_choice) request.tool_choice = { type: "auto" };
    else if (body.tool_choice === "required") request.tool_choice = { type: "any" };
    else if (typeof body.tool_choice === "object" && ["function", "custom"].includes(body.tool_choice?.type)) {
      const name = toolAlias(body.tool_choice.namespace, body.tool_choice.name);
      if (!tools.some((tool) => tool.name === name)) throw bridgeInputError("指定的工具不在這次可用工具清單內。");
      request.tool_choice = { type: "tool", name };
    } else throw bridgeInputError("Claude 轉譯不支援這個 tool_choice，請選用本次提供的函式工具。");
    if (body.parallel_tool_calls === false && request.tool_choice.type !== "none") {
      request.tool_choice.disable_parallel_tool_use = true;
    }
  } else {
    // 這一輪沒有提供任何工具，歷史裡卻有工具呼叫：補上只供對應歷史的佔位定義，
    // 並禁止呼叫，否則同樣會被 Anthropic 以「必須定義 tools」拒收。
    const historical = [...new Set(messages.flatMap((message) => message.content)
      .filter((block) => block?.type === "tool_use" && typeof block.name === "string")
      .map((block) => block.name))];
    if (historical.length) {
      request.tools = historical.map((name) => ({
        name,
        description: "此工具在本輪不可用，只用來對應歷史中的工具呼叫。",
        input_schema: { type: "object", properties: {} },
      }));
      request.tool_choice = { type: "none" };
    }
  }
  if (!tools.length && body.tool_choice && !["auto", "none"].includes(body.tool_choice)) {
    throw bridgeInputError("指定的工具在 Claude 轉譯路由中不可用。");
  }
  if (useOutputConfig) {
    // Codex 的 ultra 帶「自動任務委派」語意，Anthropic 沒有對應檔位，對到 max。
    const mapped = effort === "ultra" ? "max" : effort;
    if (ANTHROPIC_EFFORTS.has(mapped)) request.output_config = { effort: mapped };
    // 這些模型預設 display 是 omitted：thinking 區塊照樣送來，但文字是空的。
    // 要在 Codex 裡看到推理摘要就得明確要 summarized。
    if (route?.reasoningSummary === true) {
      request.thinking = { type: "adaptive", display: "summarized" };
    }
  } else if (budget >= 1024) {
    request.thinking = { type: "enabled", budget_tokens: budget };
  }

  return {
    request, freeform, toolTargets, compaction, imagesOmitted, thinkingTrimmed, toolContext,
    toolOutputsMerged, lateToolOutputs, toolResultsReordered,
  };
}

// ---------------------------------------------------------------- 回應方向

// Codex 只看 response.failed 的 error.code 決定怎麼處理：
//   context_length_exceeded       上下文已滿，不重試
//   insufficient_quota 等         額度用盡，不重試
//   server_is_overloaded          伺服器過載，重試
//   rate_limit_exceeded           限流，依訊息裡的「try again in Ns」等待後重試
// 其餘 code 一律當一般串流錯誤。上游若只給 HTTP 狀態碼或 Anthropic 的錯誤型別
// （overloaded_error、rate_limit_error），不換成上面這些 code 的話，上下文爆掉
// 也會被白白重試，限流也不會照上游要求的時間等待。
const CODEX_ERROR_CODES = new Set([
  "context_length_exceeded", "insufficient_quota", "credit_balance_exhausted",
  "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "usage_not_included",
  "invalid_prompt", "server_is_overloaded", "rate_limit_exceeded", "slow_down",
]);
const CONTEXT_OVERFLOW_PATTERN =
  /prompt is too long|maximum context length|context (?:window|length)|input is too long|exceeds? the context/i;

// 輸入可以是 Anthropic 的 {type, message}、OpenAI 的 {type, code, message}，
// 或只有 HTTP 狀態碼；回傳 Codex 認得的 { code, message }。
export function codexErrorFromUpstream(error = {}, { status = null, retryAfterSeconds = null } = {}) {
  const source = error && typeof error === "object" ? error : { message: error };
  const message = typeof source.message === "string" && source.message
    ? source.message
    : (status ? `上游返回 HTTP ${status}` : "上游錯誤");
  const kinds = [source.code, source.type]
    .filter((value) => typeof value === "string" && value)
    .map((value) => value.toLowerCase());
  let code = kinds.find((kind) => CODEX_ERROR_CODES.has(kind)) || null;
  if (!code) {
    if (kinds.some((kind) => /context_length|context_window/.test(kind)) || CONTEXT_OVERFLOW_PATTERN.test(message)) {
      code = "context_length_exceeded";
    } else if (kinds.some((kind) => /insufficient_(?:user_)?quota|billing|credit_balance/.test(kind)) || status === 402) {
      code = "insufficient_quota";
    } else if (kinds.includes("overloaded_error") || status === 529) {
      code = "server_is_overloaded";
    } else if (kinds.includes("rate_limit_error") || status === 429) {
      code = "rate_limit_exceeded";
    }
  }
  let text = message;
  if (code === "rate_limit_exceeded" && retryAfterSeconds > 0 && !/try again in/i.test(text)) {
    text += ` Please try again in ${retryAfterSeconds}s.`;
  }
  return {
    code: code || kinds[0] || (status ? String(status) : "upstream_error"),
    message: text,
  };
}

function randomId(prefix, length) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = prefix;
  while (out.length < length) out += chars[Math.floor(Math.random() * chars.length)];
  return out.slice(0, length);
}

function mapUsage(anthropicUsage) {
  const u = anthropicUsage || {};
  const input = Number(u.input_tokens) || 0;
  const cached = Number(u.cache_read_input_tokens) || 0;
  const cacheWrite = Number(u.cache_creation_input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  return {
    input_tokens: input + cached + cacheWrite,
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: cacheWrite },
    output_tokens: output,
    output_tokens_details: {
      reasoning_tokens: Number(u.output_tokens_details?.thinking_tokens) || 0,
    },
    total_tokens: input + cached + cacheWrite + output,
  };
}

/**
 * 讀取 Anthropic 的 SSE 串流，逐一產生 Codex Responses 事件。
 * @param {AsyncIterable<Uint8Array>} upstreamBody
 * @param {(event: object) => void} emit
 * @param {{model: string, requestBody: object, freeform: Set<string>, toolTargets?: Map<string, {name: string, namespace?: string}>, compaction?: boolean}} ctx
 */
export async function bridgeAnthropicStream(upstreamBody, emit, ctx) {
  const responseId = randomId("resp_", 55);
  const createdAt = Math.floor(Date.now() / 1000);
  let seq = 0;
  let outputIndex = 0;
  let usage = null;
  let stopReason = null;
  const output = [];

  const base = () => ({
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    background: false,
    completed_at: null,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: ctx.model,
    output: [],
    parallel_tool_calls: false,
    previous_response_id: null,
    prompt_cache_key: ctx.requestBody?.prompt_cache_key ?? null,
    reasoning: ctx.requestBody?.reasoning ?? null,
    store: false,
    temperature: 1.0,
    text: ctx.requestBody?.text ?? { format: { type: "text" }, verbosity: "low" },
    tool_choice: ctx.requestBody?.tool_choice ?? "auto",
    tools: [],
    truncation: "disabled",
    usage: null,
    user: null,
    metadata: {},
  });

  // 壓縮回合：模型吐的 reasoning / message / tool_use 一律不外送，
  // 全部收攏成一個 compaction 項目，於 message_stop 一次補上。
  const compactionMode = Boolean(ctx.compaction);
  let compactionText = "";
  let suppress = compactionMode;
  const passthroughWhileSuppressed = new Set([
    "response.created",
    "response.in_progress",
    "error",
  ]);

  const send = (event) => {
    if (suppress && !passthroughWhileSuppressed.has(event.type)) return;
    emit({ ...event, sequence_number: seq++ });
  };

  send({ type: "response.created", response: base() });
  send({ type: "response.in_progress", response: base() });

  // 目前正在組裝的 content block
  let cur = null;
  let failed = false;

  const decoder = new TextDecoder();
  let pending = "";

  const handle = (event) => {
    if (failed) return;
    switch (event.type) {
      case "content_block_start": {
        const block = event.content_block || {};
        if (block.type === "thinking") {
          cur = { kind: "thinking", itemId: randomId("rs_", 53), thinking: "", signature: "", index: outputIndex };
          send({
            type: "response.output_item.added",
            output_index: outputIndex,
            item: { id: cur.itemId, type: "reasoning", content: [], encrypted_content: "", summary: [] },
          });
        } else if (block.type === "redacted_thinking") {
          cur = { kind: "redacted", itemId: randomId("rs_", 53), data: typeof block.data === "string" ? block.data : "", index: outputIndex };
          send({
            type: "response.output_item.added",
            output_index: outputIndex,
            item: { id: cur.itemId, type: "reasoning", content: [], encrypted_content: "", summary: [] },
          });
        } else if (block.type === "text") {
          cur = { kind: "text", itemId: randomId("msg_", 54), text: block.text || "", index: outputIndex };
          send({
            type: "response.output_item.added",
            output_index: outputIndex,
            item: { id: cur.itemId, type: "message", status: "in_progress", content: [], phase: "commentary", role: "assistant" },
          });
          send({
            type: "response.content_part.added",
            content_index: 0,
            item_id: cur.itemId,
            output_index: outputIndex,
            part: { type: "output_text", annotations: [], logprobs: [], text: "" },
          });
        } else if (block.type === "tool_use") {
          const isFreeform = ctx.freeform.has(block.name);
          const target = ctx.toolTargets?.get(block.name);
          cur = {
            kind: isFreeform ? "custom_tool" : "function_tool",
            itemId: randomId("fc_", 54),
            callId: block.id,
            name: target?.name || block.name,
            namespace: target?.namespace || null,
            json: "",
            initialInput: block.input ?? {},
            index: outputIndex,
          };
          const identity = cur.namespace
            ? { name: cur.name, namespace: cur.namespace }
            : { name: cur.name };
          send({
            type: "response.output_item.added",
            output_index: outputIndex,
            item: isFreeform
              ? { id: cur.itemId, type: "custom_tool_call", status: "in_progress", call_id: cur.callId, input: "", ...identity }
              : { id: cur.itemId, type: "function_call", status: "in_progress", call_id: cur.callId, arguments: "", ...identity },
          });
        }
        break;
      }

      case "content_block_delta": {
        if (!cur) break;
        const d = event.delta || {};
        if (d.type === "thinking_delta" && cur.kind === "thinking") {
          cur.thinking += d.thinking || "";
          // display=summarized 時 thinking 才有文字。Codex 顯示的是 reasoning 的
          // summary，不是 encrypted_content，所以要另外把摘要串出去。
          if (d.thinking) {
            if (!cur.summaryStarted) {
              cur.summaryStarted = true;
              send({
                type: "response.reasoning_summary_part.added",
                item_id: cur.itemId,
                output_index: cur.index,
                summary_index: 0,
                part: { type: "summary_text", text: "" },
              });
            }
            send({
              type: "response.reasoning_summary_text.delta",
              item_id: cur.itemId,
              output_index: cur.index,
              summary_index: 0,
              delta: d.thinking,
            });
          }
        } else if (d.type === "signature_delta" && cur.kind === "thinking") {
          cur.signature += d.signature || "";
        } else if (d.type === "text_delta" && cur.kind === "text") {
          cur.text += d.text || "";
          send({
            type: "response.output_text.delta",
            content_index: 0,
            item_id: cur.itemId,
            output_index: cur.index,
            delta: d.text || "",
          });
        } else if (d.type === "input_json_delta") {
          // 自由格式工具的參數包在 JSON 字串裡，無法逐段安全解碼，
          // 因此先累積，於 content_block_stop 一次送出。
          cur.json += d.partial_json || "";
        }
        break;
      }

      case "content_block_stop": {
        if (!cur) break;
        if (cur.kind === "redacted") {
          const item = {
            id: cur.itemId,
            type: "reasoning",
            content: [],
            encrypted_content: encodeRedactedReasoning(cur.data),
            summary: [],
          };
          output.push(item);
          send({ type: "response.output_item.done", output_index: cur.index, item });
        } else if (cur.kind === "thinking") {
          if (cur.summaryStarted) {
            send({
              type: "response.reasoning_summary_text.done",
              item_id: cur.itemId,
              output_index: cur.index,
              summary_index: 0,
              text: cur.thinking,
            });
            send({
              type: "response.reasoning_summary_part.done",
              item_id: cur.itemId,
              output_index: cur.index,
              summary_index: 0,
              part: { type: "summary_text", text: cur.thinking },
            });
          }
          const item = {
            id: cur.itemId,
            type: "reasoning",
            content: [],
            encrypted_content: encodeReasoning(cur.thinking, cur.signature),
            // 摘要放進 summary 才會被顯示；encrypted_content 只負責往返。
            summary: cur.summaryStarted
              ? [{ type: "summary_text", text: cur.thinking }]
              : [],
          };
          output.push(item);
          send({ type: "response.output_item.done", output_index: cur.index, item });
        } else if (cur.kind === "text") {
          if (compactionMode) compactionText += cur.text;
          send({
            type: "response.output_text.done",
            content_index: 0,
            item_id: cur.itemId,
            logprobs: [],
            output_index: cur.index,
            text: cur.text,
          });
          send({
            type: "response.content_part.done",
            content_index: 0,
            item_id: cur.itemId,
            output_index: cur.index,
            part: { type: "output_text", annotations: [], logprobs: [], text: cur.text },
          });
          const item = {
            id: cur.itemId,
            type: "message",
            status: "completed",
            content: [{ type: "output_text", annotations: [], logprobs: [], text: cur.text }],
            phase: "commentary",
            role: "assistant",
          };
          output.push(item);
          send({ type: "response.output_item.done", output_index: cur.index, item });
        } else if (cur.kind === "custom_tool" || cur.kind === "function_tool") {
          let parsed;
          try {
            parsed = parseToolArguments(cur.json || cur.initialInput);
            if (cur.kind === "custom_tool" && typeof parsed[FREEFORM_KEY] !== "string") throw bridgeInputError("自由格式工具缺少字串 input。");
          } catch {
            failed = true;
            suppress = false;
            const response = base();
            response.status = "failed";
            response.error = { code: "invalid_tool_arguments", message: "上游工具參數不完整或格式錯誤；未產生替代參數，請重新產生該工具呼叫。" };
            send({ type: "response.failed", response });
            break;
          }
          if (cur.kind === "custom_tool") {
            const input = typeof parsed[FREEFORM_KEY] === "string" ? parsed[FREEFORM_KEY] : (cur.json || "");
            send({ type: "response.custom_tool_call_input.delta", delta: input, item_id: cur.itemId, output_index: cur.index });
            send({ type: "response.custom_tool_call_input.done", input, item_id: cur.itemId, output_index: cur.index });
            const item = {
              id: cur.itemId,
              type: "custom_tool_call",
              status: "completed",
              call_id: cur.callId,
              input,
              name: cur.name,
              ...(cur.namespace ? { namespace: cur.namespace } : {}),
            };
            output.push(item);
            send({ type: "response.output_item.done", output_index: cur.index, item });
          } else {
            const args = JSON.stringify(parsed);
            send({ type: "response.function_call_arguments.delta", delta: args, item_id: cur.itemId, output_index: cur.index });
            send({ type: "response.function_call_arguments.done", arguments: args, item_id: cur.itemId, output_index: cur.index });
            const item = {
              id: cur.itemId,
              type: "function_call",
              status: "completed",
              call_id: cur.callId,
              arguments: args,
              name: cur.name,
              ...(cur.namespace ? { namespace: cur.namespace } : {}),
            };
            output.push(item);
            send({ type: "response.output_item.done", output_index: cur.index, item });
          }
        }
        outputIndex += 1;
        cur = null;
        break;
      }

      case "message_start":
        usage = event.message?.usage || null;
        break;

      case "message_delta":
        stopReason = event.delta?.stop_reason ?? stopReason;
        if (event.usage) usage = { ...(usage || {}), ...event.usage };
        break;

      case "message_stop": {
        if (compactionMode) {
          suppress = false;
          // 摘要為空也必須送出項目，否則客戶端直接 Fatal。
          const summary = compactionText.trim() || "(compaction produced no summary)";
          const item = {
            id: randomId("cmp_", 54),
            type: "compaction",
            encrypted_content: encodeCompaction(summary),
          };
          send({
            type: "response.output_item.added",
            output_index: 0,
            item: { id: item.id, type: "compaction", encrypted_content: "" },
          });
          send({ type: "response.output_item.done", output_index: 0, item });
          output.length = 0;
          output.push(item);
        }
        const response = base();
        response.status = "completed";
        response.completed_at = Math.floor(Date.now() / 1000);
        response.output = output;
        response.usage = mapUsage(usage);
        if (stopReason === "max_tokens") {
          response.status = "incomplete";
          response.incomplete_details = { reason: "max_output_tokens" };
        }
        send({ type: response.status === "incomplete" ? "response.incomplete" : "response.completed", response });
        break;
      }

      // Anthropic 在串流中途出錯（最常見的是 overloaded_error）時送這個事件，然後結束串流。
      // 只轉成頂層 error 的話 Codex 會忽略它：WebSocket 上要空等閒置逾時才重試。
      case "error": {
        failed = true;
        suppress = false;
        const response = base();
        response.status = "failed";
        response.error = codexErrorFromUpstream(event.error || {});
        send({ type: "response.failed", response });
        break;
      }

      default:
        break; // ping 等忽略
    }
  };

  for await (const chunk of upstreamBody) {
    pending += decoder.decode(chunk, { stream: true });
    for (;;) {
      const match = /\r?\n\r?\n/.exec(pending);
      if (!match) break;
      const block = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      const line = /^data:\s*(.*)$/m.exec(block);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line[1]); } catch { continue; }
      handle(event);
    }
  }
}
__CODEX_MODEL_ROUTER_IMAGEGEN_JS__
// 獨立圖片命令：API 走本機路由器，結果圖片另行下載；命令不讀取或儲存 API Key。
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { get as httpsGet } from "node:https";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

export const IMAGE_MODELS = ["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"];
export const ARK_IMAGE_PATH = "/v2/extend/image/ark_gpt_image";
const MODEL_ALIASES = {
  image2: IMAGE_MODELS[0], "image-2": IMAGE_MODELS[0],
  sunburst: IMAGE_MODELS[1], "image2.5-sunburst": IMAGE_MODELS[1],
  flare: IMAGE_MODELS[2], "image2.5-flare": IMAGE_MODELS[2],
};
const HELP = `中轉 API 生圖（不需要 OPENAI_API_KEY）
  imagegen.mjs list
  imagegen.mjs generate --model flare --prompt-file prompt.txt --out output.png
  imagegen.mjs edit --model sunburst --prompt-file prompt.txt --image input.png --out output-v2.png

模型只可從安裝時勾選的 Image 2、Sunburst、Flare 選擇。
--model 可用完整模型 ID 或 image2 / sunburst / flare。
--image 可重複提供（最多 16 張 PNG、JPEG 或 WebP），edit 必須提供至少一張。
--prompt 與 --prompt-file 二擇一；提示詞上限 32000 字元。
--size auto 或 WIDTHxHEIGHT；--quality auto / low / medium / high / xhigh / max。
--background auto / opaque / transparent；--output-format png / jpeg / webp。
Image 2 不支援 xhigh / max。透明背景需使用 PNG 或 WebP。
Ark 任務介面：size、quality 只能 auto，background 不支援 transparent；程式會自動省略不支援的欄位。
--timeout 秒數（預設 300，最多 1800）；--dry-run 只檢查、不生成圖片。
每次生成一張圖片，不覆寫已有檔案，不自動重試或切換模型。
`;

export function parseImagegenArgs(args) {
  if (!args.length || args.includes("--help") || args[0] === "help") return { action: "help" };
  const options = { action: args[0], images: [], quality: "auto", size: "auto", background: "auto", timeout: 300 };
  if (!["list", "generate", "edit"].includes(options.action)) throw new Error("未知命令；請使用 list、generate 或 edit。");
  const names = { "--model": "model", "--prompt": "prompt", "--prompt-file": "promptFile", "--out": "out",
    "--size": "size", "--quality": "quality", "--background": "background", "--output-format": "format", "--timeout": "timeout" };
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--dry-run") { options.dryRun = true; continue; }
    if (flag !== "--image" && !names[flag]) throw new Error(`未知參數：${flag}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少值。`);
    if (flag === "--image") options.images.push(resolve(value));
    else options[names[flag]] = value;
  }
  return options;
}

export function chooseImageModel(config, requested, action) {
  const enabled = config?.models;
  if (!Array.isArray(enabled) || !enabled.length || enabled.some((id) => !IMAGE_MODELS.includes(id))) {
    throw new Error("圖片模型設定無效，請從路由器選單重新設定中轉 API 生圖。");
  }
  if (requested) {
    const name = requested.toLowerCase();
    const id = MODEL_ALIASES[name] || name;
    if (!enabled.includes(id)) throw new Error("此圖片模型未啟用；請從已勾選的模型中選擇，或在路由器選單重新設定。");
    return id;
  }
  const priority = action === "edit" ? [IMAGE_MODELS[1], IMAGE_MODELS[2], IMAGE_MODELS[0]] : [IMAGE_MODELS[2], IMAGE_MODELS[1], IMAGE_MODELS[0]];
  return priority.find((id) => enabled.includes(id));
}

function fileImageFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "webp";
  return null;
}

async function responseJson(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body || []) {
    bytes += chunk.length;
    if (bytes > 128 * 1024 * 1024) throw new Error("圖片 API 回應超過 128 MiB，未保存輸出。");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error(`圖片 API 返回非 JSON 內容（HTTP ${response.status}），請檢查供應商是否支援 Images API。`); }
}

function apiError(payload, status, apiKey = "") {
  // 供應商可能把敏感參數放進錯誤字串；只回傳短訊息並遮蔽常見憑證格式。
  let message = String(payload?.error?.message || (typeof payload?.error === "string" ? payload.error : "") || payload?.message || "請檢查模型支援、供應商配額與路由器狀態。");
  if (apiKey) message = message.replaceAll(apiKey, "[redacted]");
  message = message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 600);
  return new Error(`中轉圖片 API HTTP ${status}：${message}`);
}

function decodeImageResult(result, format) {
  const data = result?.data?.[0]?.b64_json;
  if (typeof data !== "string" || !data || !/^[A-Za-z0-9+/\s]+={0,2}$/.test(data)) {
    throw new Error("上游未返回有效的 b64_json 圖片，請確認供應商支援 GPT Image 的 Images API 回應格式。");
  }
  const bytes = Buffer.from(data, "base64");
  if (fileImageFormat(bytes) !== format) throw new Error("上游回傳的圖片格式與要求不符，未寫入輸出檔。");
  return bytes;
}

function publicImageAddress(address) {
  const value = String(address).toLowerCase();
  if (isIP(value) === 4) {
    const [a, b, c] = value.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  return isIP(value) === 6 && /^[23][0-9a-f]{3}:/.test(value) &&
    !/^2001:(?:0+:|db8:)/.test(value) && !value.startsWith("2002:");
}

// 圖片 URL 不帶中轉憑證。固定使用已檢查的 DNS 結果，避免重導或 DNS 重綁導向內網。
function fetchImageDownload(url, { signal, addresses }) {
  return new Promise((resolve, reject) => {
    const request = httpsGet(url, { signal, headers: { accept: "image/*" },
      lookup: (_host, options, done) => options.all
        ? done(null, addresses) : done(null, addresses[0].address, addresses[0].family),
    }, (response) => {
      try { resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers: response.headers })); }
      catch (error) { response.destroy(); reject(error); }
    });
    request.on("error", reject);
  });
}

export async function downloadArkImage(source, { signal, lookupImpl = lookup, dnsFetchImpl = globalThis.fetch, requestImpl = fetchImageDownload } = {}) {
  let current;
  try { current = new URL(source); } catch { throw new Error("Ark 返回無效圖片 URL。"); }
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal?.throwIfAborted();
    const host = current.hostname.replace(/^\[|\]$/g, "");
    if (current.protocol !== "https:" || current.username || current.password || current.hash ||
        host === "localhost" || /\.(?:localhost|local|internal)$/.test(host)) throw new Error("Ark 圖片 URL 必須是公開 HTTPS 位址。");
    const resolveHost = () => lookupImpl(host, { all: true });
    let addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await (signal ? new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(resolveHost).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    }) : resolveHost());
    signal?.throwIfAborted();
    // Clash 等代理會將公開網域解析為 198.18.0.0/15 假 IP。
    // 不放寬內網限制：只對這種網域解析改用 HTTPS DNS 取得真實位址，再檢查並固定連線 IP。
    if (!isIP(host) && addresses.length && addresses.every(({ address }) => /^198\.(?:18|19)\./.test(address))) {
      const dnsUrl = new URL("https://cloudflare-dns.com/dns-query");
      dnsUrl.searchParams.set("name", host);
      dnsUrl.searchParams.set("type", "A");
      const dnsSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
      const response = await dnsFetchImpl(dnsUrl, { headers: { accept: "application/dns-json" }, redirect: "error", signal: dnsSignal });
      if (!response.ok) { await response.body?.cancel(); throw new Error("無法解析 Ark 圖片的真實公開位址。"); }
      const answer = await responseJson(response);
      addresses = answer.Status === 0 && Array.isArray(answer.Answer)
        ? answer.Answer.filter((entry) => entry.type === 1 && isIP(entry.data) === 4).map((entry) => ({ address: entry.data, family: 4 })) : [];
    }
    signal?.throwIfAborted();
    if (!addresses.length || addresses.some((entry) => !publicImageAddress(entry.address))) {
      throw new Error("Ark 圖片 URL 不可指向本機或內網。");
    }
    const response = await requestImpl(current, { signal, addresses });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Ark 圖片重導缺少目的地。");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Ark 圖片下載失敗（HTTP ${response.status}）。`); }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) throw new Error("Ark 圖片超過 64 MiB。");
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (!fileImageFormat(bytes)) throw new Error("Ark URL 未返回有效圖片。");
    return bytes;
  }
  throw new Error("Ark 圖片重導次數過多。");
}

export async function runArkImageTask({ origin, payload, action = "generate", apiKey = "", timeoutMs = 300000,
  fetchImpl = globalThis.fetch, downloadImpl = downloadArkImage, pollIntervalMs = 2000 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const base = `${new URL(origin).origin}${ARK_IMAGE_PATH}`;
  const headers = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  let taskId;
  const read = async (response) => {
    const result = await responseJson(response);
    if (!response.ok) throw apiError(result, response.status, apiKey);
    return result;
  };
  try {
    const submitted = await read(await fetchImpl(`${base}/${action === "edit" ? "edits" : "generations"}`, {
      method: "POST", headers, body: JSON.stringify(payload), redirect: "error", signal,
    }));
    taskId = submitted?.task_id;
    if (typeof taskId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(taskId)) throw new Error("Ark 未返回有效 task_id。");
    while (true) {
      const task = await read(await fetchImpl(`${base}/tasks/${taskId}`, { method: "GET", headers, redirect: "error", signal }));
      if (task.task_id != null && task.task_id !== taskId) throw new Error("Ark 任務編號不符。");
      if (task.status === "succeeded") {
        const url = task.result?.images?.[0]?.url;
        if (typeof url !== "string" || !url) throw new Error("Ark 任務沒有圖片 URL。");
        const bytes = await downloadImpl(url, { signal });
        if (fileImageFormat(bytes) !== payload.output_format) throw new Error("Ark 回傳圖片格式與要求不符。");
        return { bytes, taskId };
      }
      if (!["pending", "queued", "running", "processing", "in_progress"].includes(task.status)) {
        throw new Error("Ark 圖片任務未成功。");
      }
      await delay(pollIntervalMs, undefined, { signal });
    }
  } catch (error) {
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    let message = timedOut ? "Ark 生圖逾時，上游可能仍在處理或計費。" : String(error.message || "Ark 圖片請求失敗。");
    if (apiKey) message = message.replaceAll(apiKey, "[redacted]");
    message = message.replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/gi, "[redacted]").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 600);
    throw new Error(`${message}${taskId && /^[A-Za-z0-9_-]{1,160}$/.test(taskId) ? `（task_id=${taskId}）` : ""} 未重新提交任務。`);
  }
}

// 安裝器只測已選模型；每種介面每個模型最多提交一次。
export async function probeRelayImageModel({ model, upstreamModel = model, apiRoot, apiKey,
  fetchImpl = globalThis.fetch, timeoutMs = 300000, apiMode = "images", downloadImpl, pollIntervalMs } = {}) {
  if (!IMAGE_MODELS.includes(model) || typeof upstreamModel !== "string" ||
      (upstreamModel !== model && !upstreamModel.endsWith(`/${model}`)) || /[\s\x00-\x1f\x7f?#]/.test(upstreamModel)) {
    throw new Error("無效的圖片測試模型。");
  }
  if (apiMode === "ark-task") {
    try {
      return { ok: true, ...await runArkImageTask({ origin: apiRoot, apiKey, timeoutMs, fetchImpl, downloadImpl, pollIntervalMs,
        payload: { model: upstreamModel, prompt: "A small black circle centered on a plain white background.", output_format: "png" } }) };
    } catch (error) { return { ok: false, error: error.message }; }
  }
  if (apiMode !== "images") throw new Error("未知生圖介面。");
  let response;
  try {
    response = await fetchImpl(`${String(apiRoot).replace(/\/$/, "")}/images/generations`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: upstreamModel, prompt: "A small black circle centered on a plain white background.",
        n: 1, size: "1024x1024", quality: "low", output_format: "png" }),
    });
  } catch (error) {
    return { ok: false, error: error.name === "TimeoutError" || error.name === "AbortError"
      ? "生圖測試逾時；上游可能仍在處理或計費，未自動重試。"
      : "生圖測試連線失敗，請檢查網路及供應商狀態；未自動重試。" };
  }
  let result;
  try { result = await responseJson(response); }
  catch (error) {
    return { ok: false, error: error.name === "TimeoutError" || error.name === "AbortError"
      ? "生圖測試逾時；上游可能仍在處理或計費，未自動重試。"
      : `圖片回應讀取失敗（HTTP ${response.status}），可能不是有效 JSON、過大或連線中斷；未自動重試。` };
  }
  if (!response.ok) return { ok: false, error: apiError(result, response.status, apiKey).message };
  try { return { ok: true, bytes: decodeImageResult(result, "png") }; }
  catch (error) { return { ok: false, error: error.message }; }
}

export async function discoverUsableRelayImages({ candidates, onProbe = () => {}, ...options } = {}) {
  const selected = [...new Map(candidates.map((model) => [model.id, model])).values()];
  const checks = [];
  for (const apiMode of ["images", "ark-task"]) {
    const models = [];
    for (const [index, candidate] of selected.entries()) {
      const model = { ...candidate, upstreamModel: apiMode === "ark-task" ? candidate.id : candidate.upstreamModel };
      onProbe(apiMode, model, index);
      const result = await probeRelayImageModel({ ...options, model: model.id, upstreamModel: model.upstreamModel, apiMode });
      checks.push({ apiMode, model: model.upstreamModel, ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
      if (result.ok) models.push({ ...model, bytes: result.bytes });
    }
    // 有任何通用模型成功就使用該流程；不為剩餘失敗模型額外發送 Ark 提交。
    if (models.length) return { apiMode, models, checks };
  }
  return { apiMode: null, models: [], checks };
}

export async function runRelayImagegen(args, {
  configPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "config.json"),
  fetchImpl = globalThis.fetch,
  downloadImpl = downloadArkImage,
  pollIntervalMs = 2000,
} = {}) {
  const options = parseImagegenArgs(args);
  if (options.action === "help") return { help: HELP };
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (config.managedBy !== "codex-model-router" || typeof config.routerSettingsPath !== "string") {
    throw new Error("此命令尚未由路由器安裝器配置。");
  }
  const model = chooseImageModel(config, options.model, options.action);
  const apiMode = config.apiMode || "images";
  if (!["images", "ark-task"].includes(apiMode)) throw new Error("生圖介面設定無效，請重新設定中轉生圖。");
  const upstreamModel = config.upstreamModels?.[model] || model;
  if (upstreamModel !== model && !(typeof upstreamModel === "string" && upstreamModel.endsWith(`/${model}`) && !/[\s?#]/.test(upstreamModel))) {
    throw new Error("圖片模型對應無效，請重新設定中轉生圖。");
  }
  if (options.action === "list") return { models: config.models, upstreamModels: config.upstreamModels, apiMode,
    defaultGenerate: chooseImageModel(config, null, "generate"), defaultEdit: chooseImageModel(config, null, "edit") };

  const settings = JSON.parse(readFileSync(config.routerSettingsPath, "utf8"));
  const port = Number(settings.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("路由器端口無效，請重新配置路由器。");
  if (Boolean(options.prompt) === Boolean(options.promptFile)) throw new Error("請擇一提供 --prompt 或 --prompt-file。");
  const prompt = options.promptFile ? readFileSync(resolve(options.promptFile), "utf8") : options.prompt;
  if (!prompt.trim() || [...prompt].length > 32000) throw new Error("提示詞不可為空且最多 32000 字元。");
  if (!options.out) throw new Error("請以 --out 指定新的輸出檔案。");
  const ext = extname(options.out).slice(1).toLowerCase();
  const format = options.format || (ext === "jpg" ? "jpeg" : ext) || "png";
  if (!["png", "jpeg", "webp"].includes(format)) throw new Error("輸出格式只支援 png、jpeg、webp。");
  if (ext && (ext === "jpg" ? "jpeg" : ext) !== format) throw new Error("--out 副檔名與 --output-format 不一致。");
  const out = resolve(ext ? options.out : `${options.out}.${format}`);
  if (existsSync(out)) throw new Error(`輸出檔已存在，請換一個檔名：${out}`);
  if (apiMode === "ark-task" && (options.size !== "auto" || options.quality !== "auto" || options.background === "transparent")) {
    throw new Error("Ark 任務介面由上游決定尺寸與品質：size、quality 請使用 auto，background 只可用 auto 或 opaque。");
  }
  const qualities = model === IMAGE_MODELS[0] ? ["auto", "low", "medium", "high"] : ["auto", "low", "medium", "high", "xhigh", "max"];
  if (!qualities.includes(options.quality)) throw new Error(`此模型不支援 quality=${options.quality}。`);
  if (!["auto", "opaque", "transparent"].includes(options.background)) throw new Error("background 只支援 auto、opaque、transparent。");
  if (options.background === "transparent" && format === "jpeg") throw new Error("透明背景需使用 PNG 或 WebP。");
  if (options.size !== "auto") {
    const match = /^(\d+)x(\d+)$/.exec(options.size);
    const [width, height] = match ? match.slice(1).map(Number) : [0, 0];
    if (!width || !height || width % 16 || height % 16 || Math.max(width, height) > 3840 ||
        Math.max(width, height) > Math.min(width, height) * 3 || width * height < 655360 || width * height > 8294400) {
      throw new Error("尺寸需為 auto 或有效的 WIDTHxHEIGHT：邊長為 16 倍數、最長 3840、比例不超過 3:1、總像素 655360–8294400。");
    }
  }
  const timeout = Number(options.timeout);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 1800) throw new Error("timeout 必須介於 1 至 1800 秒。");
  if (options.action === "edit" && !options.images.length) throw new Error("edit 至少需要一個 --image。");
  if (options.action === "generate" && options.images.length) throw new Error("帶參考圖請使用 edit 命令。");
  if (options.images.length > 16) throw new Error("最多提供 16 張圖片。");
  const inputs = options.images.map((path) => {
    if (!statSync(path).isFile() || statSync(path).size >= 50 * 1024 * 1024) throw new Error("每張參考圖必須是小於 50 MiB 的檔案。");
    const bytes = readFileSync(path);
    const type = fileImageFormat(bytes);
    if (!type) throw new Error("參考圖只支援 PNG、JPEG 或 WebP。");
    return { path, bytes, type };
  });
  const origin = `http://127.0.0.1:${port}`;
  const endpoint = `${origin}${apiMode === "ark-task" ? ARK_IMAGE_PATH : "/v1/images"}/${options.action === "edit" ? "edits" : "generations"}`;
  const payload = { model: upstreamModel, prompt, n: 1, size: options.size,
    quality: options.quality, background: options.background, output_format: format };
  if (options.dryRun) return { dryRun: true, model, upstreamModel, apiMode, endpoint, out, inputImages: inputs.length };
  mkdirSync(dirname(out), { recursive: true });
  let health;
  try {
    const response = await fetchImpl(`${origin}/healthz`, { signal: AbortSignal.timeout(5000), redirect: "error" });
    health = await response.json();
    if (!response.ok || health?.status !== "ok" || typeof health.stats?.imageRequests !== "number" ||
        (apiMode === "ark-task" && typeof health.stats?.arkImageRequests !== "number")) throw new Error("health");
  } catch { throw new Error("本機圖片路由不可用；請從路由器選單檢查狀態或執行 update，沒有送出生圖請求。"); }
  if (apiMode === "ark-task") {
    const arkPayload = { model: upstreamModel, prompt, output_format: format, background: options.background };
    if (options.action === "edit") arkPayload.image_base64s = inputs.map((image) => `data:image/${image.type};base64,${image.bytes.toString("base64")}`);
    const result = await runArkImageTask({ origin, action: options.action, payload: arkPayload, fetchImpl, downloadImpl,
      timeoutMs: timeout * 1000, pollIntervalMs });
    writeFileSync(out, result.bytes, { mode: 0o600, flag: "wx" });
    return { model, upstreamModel, apiMode, taskId: result.taskId, path: out, bytes: result.bytes.length };
  }
  let body = JSON.stringify(payload);
  const headers = { "content-type": "application/json" };
  if (options.action === "edit") {
    body = new FormData();
    for (const [name, value] of Object.entries(payload)) body.set(name, String(value));
    for (const image of inputs) body.append("image[]", new Blob([image.bytes], { type: `image/${image.type}` }), basename(image.path));
    delete headers["content-type"];
  }
  let response;
  let result;
  try {
    response = await fetchImpl(endpoint, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(timeout * 1000) });
    result = await responseJson(response);
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") throw new Error("圖片請求逾時；上游可能仍在處理，未自動重試以避免重複計費。");
    throw error;
  }
  if (!response.ok) throw apiError(result, response.status);
  const bytes = decodeImageResult(result, format);
  writeFileSync(out, bytes, { mode: 0o600, flag: "wx" });
  return { model, upstreamModel, path: out, bytes: bytes.length };
}

if (!process.env.CODEX_MODEL_ROUTER_IMPORT_ONLY && import.meta.url.startsWith("file:")) {
  try {
    const result = await runRelayImagegen(process.argv.slice(2));
    console.log(result.help || JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`中轉生圖失敗：${error.message}`);
    process.exitCode = 1;
  }
}
__CODEX_MODEL_ROUTER_EMBEDDED__
#>
