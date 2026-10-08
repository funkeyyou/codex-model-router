# Codex 模型路由器 —— Windows 安裝器
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1
#   powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 status
#   powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 rollback
#
# 檔案末尾的註解區塊內嵌 installer / router / claude-bridge / chat-bridge / imagegen 五段
# JavaScript，與 codex-model-router.sh 逐字一致，由 tools/build.mjs 產生。

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

const INSTALLER_VERSION = "1.27.3";
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
  const end = source.lastIndexOf("\n__CODEX_MODEL_ROUTER_EMBEDDED__");
  if (start < 0 || end <= start) fail("安裝器中缺少網頁管理介面頁面。");
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
  printManagerLauncher(installManagerLauncher());
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
  const claudeCli = { binary, timeoutMs: state.settings.claudeCli?.timeoutMs || 180000 };
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
      messages: [{ role: "user", content: "Reply with OK only." }] }, { binary, effort: "medium", timeoutMs: 45000 });
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
  printManagerLauncher(installManagerLauncher());
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

  await writeConfigEdits(rollbackEdits(manifest.previousConfig));
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
// 健康檢查與 Codex 模型清單驗證，失敗一律還原。網頁伺服器只在這個命令執行期間存在，
// 關閉終端視窗、按 Ctrl+C 或閒置太久就結束；常駐的路由器本身不提供任何網頁。

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

// 開始功能表捷徑：以 PowerShell 5.1 執行安裝器副本的 ui 命令，主控台視窗即管理頁的記錄。
export function windowsShortcutScript({ shortcut, installer, workingDirectory, launchEnv = {} }) {
  const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const assignments = Object.entries(launchEnv).map(([name, value]) => `$env:${name}=${literal(value)}`);
  const argumentsText = assignments.length
    ? `-NoProfile -ExecutionPolicy Bypass -Command "${[...assignments, `& ${literal(installer)} ui`].join("; ")}"`
    : `-NoProfile -ExecutionPolicy Bypass -File "${installer}" ui`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `$path = ${psQuote(shortcut)}`,
    "$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path)",
    "$shell = New-Object -ComObject WScript.Shell",
    "$link = $shell.CreateShortcut($path)",
    "$link.TargetPath = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    `$link.Arguments = ${psQuote(argumentsText)}`,
    `$link.WorkingDirectory = ${psQuote(workingDirectory)}`,
    `$link.Description = ${psQuote("開啟 Codex 模型路由器的網頁管理介面")}`,
    "$link.Save()",
  ].join("\n");
}

// 安裝與更新成功後放一份安裝器到路由器目錄，並建立雙擊即可開啟管理頁的捷徑。
// 失敗只提醒，不影響路由器本身。測試模式沒指定捷徑目錄時不碰使用者的應用程式資料夾。
function installManagerLauncher() {
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
  if (testMode && !env.CODEX_MODEL_ROUTER_SHORTCUT_DIR) return { ok: true, shortcut: null };
  const shortcut = managerShortcutPath();
  try {
    const launchEnv = managerLaunchEnv();
    if (isWindows) {
      powershell(windowsShortcutScript({ shortcut, installer: managerInstallerPath, workingDirectory: installRoot, launchEnv }));
    } else {
      mkdirSync(dirname(shortcut), { recursive: true });
      writeFileSync(shortcut, managerCommandFile({ installer: managerInstallerPath, launchEnv }), { mode: 0o755 });
      chmodSync(shortcut, 0o755);
    }
    return { ok: true, shortcut };
  } catch (error) {
    return { ok: false, message: `無法建立網頁管理介面的捷徑（${error.message}）` };
  }
}

function printManagerLauncher(result) {
  if (result.ok && result.shortcut) console.log(`網頁管理介面：雙擊「${result.shortcut}」開啟。`);
  else if (result.ok) console.log(`網頁管理介面：執行 ${managerInstallerName} ui 開啟。`);
  else console.log(`注意：${result.message}；仍可執行安裝器的 ui 命令開啟網頁管理介面。`);
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
  if (inheritedToken) console.log("管理頁已由獨立程序接手，瀏覽器分頁會自動重新整理；可從頁面選擇結束管理頁。");
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
    ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", managerInstallerPath, "ui", "--port", String(port)]]
    : ["/bin/bash", [managerInstallerPath, "ui", "--port", String(port)]];
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
網址含一次性存取權杖，只接受本機連線；關閉終端視窗即結束。
安裝與更新完成後會建立捷徑（macOS：~/Applications/Codex 模型路由器.command；
Windows：開始功能表），雙擊即可開啟。

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
    if (action === "ui" || action === "web" || action === "manager") await runManager();
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
import { toChatRequest, bridgeChatStream, isChatReasoning } from "./chat-bridge.mjs";

const routerDirectory = dirname(fileURLToPath(import.meta.url));
const settingsPath = join(routerDirectory, "settings.json");
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
const listenHost = "127.0.0.1";
const listenPort = Number(settings.port);
const officialBase = String(settings.officialBaseUrl).replace(/\/$/, "");

// 中轉供應商。1.24.0 以前只能設一家，欄位直接放在設定頂層；之後放在 providers 陣列。
// 路由沒寫 providerId 就屬於 id 為 default 的那一家，也就是舊版的唯一一家。
export const DEFAULT_PROVIDER_ID = "default";

export function normalizeProviders(source) {
  const list = Array.isArray(source?.providers) && source.providers.length > 0
    ? source.providers
    : source?.apiRoot ? [{ ...source, id: DEFAULT_PROVIDER_ID }] : [];
  return list.map((provider) => ({
    id: String(provider.id || DEFAULT_PROVIDER_ID),
    apiRoot: String(provider.apiRoot || "").replace(/\/$/, ""),
    keychainService: provider.keychainService,
    keychainAccount: provider.keychainAccount || "codex",
    credentialPath: provider.credentialPath || null,
  }));
}

const providers = normalizeProviders(settings);
const providerById = new Map(providers.map((provider) => [provider.id, provider]));
// 第一家是主要供應商：Codex 內建 image_gen 與沒有指定供應商的生圖請求都送到這裡。
const primaryProvider = providers[0] || null;
const routeMap = new Map(settings.routes.map((route) => [route.pickerSlug, route]));

export function providerForRoute(route, registry = providerById) {
  const id = route?.providerId || DEFAULT_PROVIDER_ID;
  const provider = registry.get(id);
  // 不能退回其他家：那會拿別家的 Key 去打別家的上游，錯誤訊息還會誤導。
  if (!provider) {
    throw new RouterRequestError(
      500, "provider_not_configured",
      `找不到供應商「${id}」的設定，請執行安裝器的 update，或刪除後重新添加這個模型。`,
      "routing",
    );
  }
  return provider;
}

// 中轉生圖命令用這個標頭指定供應商；Codex 內建的 image_gen 不帶，一律送主要供應商。
export const PROVIDER_HEADER = "x-codex-router-provider";

export function imageProviderFor(headers, registry = providerById, primary = primaryProvider) {
  const requested = headers?.[PROVIDER_HEADER];
  if (requested == null || requested === "") {
    if (!primary) throw new RouterRequestError(503, "provider_not_configured", "尚未設定中轉供應商。", "routing");
    return primary;
  }
  const provider = typeof requested === "string" ? registry.get(requested) : null;
  // 指定的供應商不存在時拒絕，不改送主要供應商——那會用另一個帳號計費。
  if (!provider) {
    throw new RouterRequestError(
      400, "unknown_provider",
      "中轉生圖指定的供應商已不存在，請從安裝器重新設定中轉 API 生圖。",
      "routing",
    );
  }
  return provider;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

const providerSummary = providers.map((provider) => ({
  id: provider.id,
  host: hostOf(provider.apiRoot),
  routes: settings.routes.filter((route) => (route.providerId || DEFAULT_PROVIDER_ID) === provider.id).length,
}));

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
// Chat Completions 轉譯層的推理只帶一個標記，同樣只有它自己用得上。
function isBridgeReasoning(item) {
  if (item?.type !== "reasoning") return false;
  const enc = item.encrypted_content;
  if (typeof enc !== "string" || !enc) return false;
  try {
    const parsed = JSON.parse(Buffer.from(enc, "base64").toString("utf8"));
    return Boolean(parsed && (
      (typeof parsed.thinking === "string" && parsed.signature) ||
      typeof parsed.redacted_thinking === "string" ||
      (parsed.router_reasoning_ref === 1 && /^[a-f0-9]{64}$/.test(parsed.sha256)) ||
      parsed.router_chat_reasoning === 1
    ));
  } catch {
    return false;
  }
}

export function stripBridgeReasoning(input, { keepChatReasoning = false } = {}) {
  if (!Array.isArray(input)) return { input, removed: 0 };
  const kept = input.filter((item) => !isBridgeReasoning(item) || (keepChatReasoning && isChatReasoning(item)));
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
function stripBridgeArtifacts(body, { keepChatReasoning = false } = {}) {
  let result = body;
  const stripped = stripBridgeReasoning(result.input, { keepChatReasoning });
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
  lastImageProvider: null,
  viewImageCallsInjected: 0,
  viewImageCallsStripped: 0,
  translatedRequests: 0,
  claudeRefusals: 0,
  claudeEmptyResponses: 0,
  claudeCompactionFailures: 0,
  // Claude CLI 拒收路由器加的歷史快取斷點、改以無斷點重送的次數；應為 0。
  claudeCliCacheFallbacks: 0,
  chatTranslatedRequests: 0,
  chatToolOutputsMerged: 0,
  chatLateToolOutputs: 0,
  chatPlaceholderToolResults: 0,
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
  lastProvider: null,
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

// 錯誤記錄要寫出實際連的是哪一家；請求本身沒記下時，由模型對應的路由推回去。
// 生圖請求在選定供應商之前把 provider 設成 null：指定的供應商不存在時，
// 記錄不能寫成主要供應商。
function contextProvider(context) {
  if (context.route !== "custom") return null;
  if ("provider" in context) return context.provider;
  const route = typeof context.model === "string" ? routeMap.get(context.model) : null;
  if (route?.transport === "claude-cli") return null;
  return (route && providerById.get(route.providerId || DEFAULT_PROVIDER_ID)) || primaryProvider;
}

function recordRouterError(error, context = {}, countFailure = true) {
  const details = describeRouterError(error);
  const requestId = randomBytes(8).toString("hex");
  const official = details.phase === "auth_probe" || context.route !== "custom";
  const provider = official ? null : contextProvider(context);
  const upstreamRoot = official ? officialBase : provider?.apiRoot;
  const record = {
    at: new Date().toISOString(), requestId,
    transport: context.transport || null, route: context.route || null,
    model: typeof context.model === "string" ? context.model.slice(0, 160) : null,
    upstreamHost: upstreamRoot ? hostOf(upstreamRoot) : null,
    ...(provider ? { provider: provider.id } : {}),
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

export async function readStoredSecret(provider = primaryProvider) {
  if (!provider) throw new Error("尚未設定中轉供應商");
  const { keychainService, keychainAccount, credentialPath } = provider;
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
function credentialFingerprint(provider) {
  if (process.platform !== "win32" || !provider.credentialPath) return null;
  try {
    const info = statSync(provider.credentialPath);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "missing";
  }
}

// 每家供應商各自一份快取：換掉其中一家的 Key 不影響其他家。
const secretCaches = new Map();

function secretCacheFor(provider) {
  let cache = secretCaches.get(provider.id);
  if (!cache) {
    cache = createSecretCache({
      read: async () => {
        stats.credentialReads += 1;
        return readStoredSecret(provider);
      },
      fingerprint: () => credentialFingerprint(provider),
      ttlMs: process.platform === "win32" && provider.credentialPath ? credentialCacheTtlMs : tokenCacheTtlMs,
    });
    secretCaches.set(provider.id, cache);
  }
  return cache;
}

async function getApiKey(provider, reload = false) {
  if (process.env.CODEX_MODEL_ROUTER_TEST_API_KEY) {
    return process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  }
  return secretCacheFor(provider)({ reload });
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

export function targetUrl(custom, incomingUrl, provider = primaryProvider) {
  const path = incomingUrl.pathname.startsWith("/v1/")
    ? incomingUrl.pathname.slice(3)
    : incomingUrl.pathname;
  const base = custom ? provider.apiRoot : officialBase;
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

async function fetchCustom(provider, target, headers, body, signal) {
  let apiKey = await getApiKey(provider, false);
  let upstream = await fetch(target, {
    method: "POST",
    headers: buildCustomHeaders(headers, apiKey),
    body,
    redirect: "manual",
    signal,
  });
  if (upstream.status !== 401 && upstream.status !== 403) return upstream;
  await upstream.arrayBuffer();
  apiKey = await getApiKey(provider, true);
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
  const isCustom = route != null;
  const provider = isCustom && route.transport !== "claude-cli" ? providerForRoute(route) : null;
  rememberRoute(requestHeaders, route);

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
    // Chat Completions 路由在同一輪的工具往返裡要送回自己產生的推理。
    effectiveBody = stripBridgeArtifacts(effectiveBody, { keepChatReasoning: route?.translate === "chat" });
  }

  // 這一步對每一條路由都要做：view_image 是路由器自己合成的，沒有任何上游認得它。
  effectiveBody = stripRouterImageArtifacts(effectiveBody);

  let outboundBodyObject = isCustom
    ? rewriteCustomBody(effectiveBody, route)
    : effectiveBody;
  let outboundBody = Buffer.from(JSON.stringify(outboundBodyObject));

  stats.lastRoute = isCustom ? "custom" : "official";
  stats.lastProvider = provider?.id ?? null;
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
      if (route.transport === "claude-cli") {
        const { fetchClaudeCli } = await import("./claude-cli.mjs");
        const translated = await fetchClaudeCli(budget.request, {
          ...settings.claudeCli, effort: outboundBodyObject?.reasoning?.effort,
        }, signal, {
          onDiagnostic: (event) => { if (event?.type === "cache_marker_fallback") stats.claudeCliCacheFallbacks += 1; },
        });
        stats.lastCustomStatus = translated.status;
        stats.lastProvider = "claude-cli";
        return translated;
      }
      const translated = await fetchCustom(
        provider,
        new URL(`${provider.apiRoot}/messages`),
        requestHeaders,
        anthropicBody,
        signal,
      );
      stats.lastCustomStatus = translated.status;
      recordUpstreamFailure(translated, { transport: meta.transport, route: "custom", model: body?.model, provider });
      return translated;
    }
    const budget = budgetToolImages(outboundBodyObject);
    recordImageBudget(budget);
    if (route.translate === "chat") {
      // 只有 /chat/completions 的模型：本機轉譯成 Chat Completions，回應再轉回 Responses 事件。
      // 圖片預算先在 Responses 形狀上做，舊的工具截圖與其他路由用同一套規則縮減。
      const { request: chatRequest, freeform, toolTargets, compaction,
        toolOutputsMerged, lateToolOutputs, placeholderToolResults } = toChatRequest(budget.request, route);
      stats.chatToolOutputsMerged += toolOutputsMerged;
      stats.chatLateToolOutputs += lateToolOutputs;
      stats.chatPlaceholderToolResults += placeholderToolResults;
      meta.translate = "chat";
      meta.freeform = freeform;
      meta.toolTargets = toolTargets;
      meta.compaction = compaction;
      meta.model = body.model;
      meta.requestBody = effectiveBody;
      meta.chatRequest = chatRequest;
      stats.chatTranslatedRequests += 1;
      const chatBody = Buffer.from(JSON.stringify(chatRequest));
      if (upstreamRequestTooLarge(chatBody.length)) {
        return oversizeResponse(chatBody.length);
      }
      const translated = await fetchCustom(
        provider,
        new URL(`${provider.apiRoot}/chat/completions`),
        requestHeaders,
        chatBody,
        signal,
      );
      stats.lastCustomStatus = translated.status;
      recordUpstreamFailure(translated, { transport: meta.transport, route: "custom", model: body?.model, provider });
      return translated;
    }
    outboundBody = budget.buffer;
    if (upstreamRequestTooLarge(outboundBody.length)) {
      return oversizeResponse(outboundBody.length);
    }
    const upstream = await fetchCustom(
      provider,
      targetUrl(true, incomingUrl, provider),
      requestHeaders,
      outboundBody,
      signal,
    );
    stats.lastCustomStatus = upstream.status;
    recordUpstreamFailure(upstream, { transport: meta.transport, route: "custom", model: body?.model, provider });
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
  request.routerContext.provider = null;
  const provider = imageProviderFor(request.headers);
  request.routerContext.provider = provider;
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
  const apiKey = await getApiKey(provider);
  const upstream = await fetch(new URL(incomingUrl.pathname, new URL(provider.apiRoot).origin), {
    method: request.method, headers: buildCustomHeaders(request.headers, apiKey),
    body: taskQuery ? undefined : Buffer.concat(chunks), redirect: "manual", signal: controller.signal,
  });
  stats.arkImageRequests += 1;
  stats.lastImageProvider = provider.id;
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
  request.routerContext.provider = null;
  const provider = imageProviderFor(request.headers);
  request.routerContext.provider = provider;
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
    provider,
    new URL(`${provider.apiRoot}${path}${incomingUrl.search}`),
    request.headers,
    rawBody,
    abortController.signal,
  );
  stats.imageRequests += 1;
  stats.lastImageProvider = provider.id;
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
  if (meta.chatRequest) captureWrite(captureId, "chat-request.json", JSON.stringify(meta.chatRequest, null, 2));
  captureWrite(captureId, "upstream-status.txt", `${upstream.status}\n`);
  if (meta.translate && upstream.status >= 200 && upstream.status < 300) {
    await bridgeTranslatedToHttp(upstream, response, meta);
    return;
  }
  // Anthropic 的錯誤內文是 {type:"error", error:{type, message}}，Codex 看的是 OpenAI
  // 形狀的 error.code。改寫成它認得的值，例如 prompt is too long → context_length_exceeded。
  // Chat Completions 的錯誤雖然已是 OpenAI 形狀，錯誤碼各家寫法不一，一樣要改寫。
  if (meta.translate) {
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

// Retry-After 可以是秒數或 HTTP 日期（RFC 9110 §10.2.3），換算成還要等幾秒；
// 無法解析或時間已過就回 null。HTTP 日期一律是 GMT，但 asctime 格式不寫時區，
// Date.parse 會當成本機時間，所以沒寫時區時補上 GMT。
export function parseRetryAfter(value, now = Date.now()) {
  const text = value == null ? "" : String(value).trim();
  if (!text) return null;
  const seconds = /^\d+(?:\.\d+)?$/.test(text)
    ? Number(text)
    : (Date.parse(/\b(?:GMT|UTC)\b|[+-]\d{4}$/i.test(text) ? text : `${text} GMT`) - now) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
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
  const mapped = codexErrorFromUpstream(error || { message: rawText || "" }, {
    status,
    retryAfterSeconds: parseRetryAfter(retryAfter),
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
  // 不在這裡解析 initial：建構時丟出例外（例如超過上限的標頭）沒有人接得住，
  // 留到下一次 push，由呼叫端既有的錯誤處理關閉連線。
  let needed = 2;
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
    // 官方上游找不到接續對象時回 {code: "previous_response_not_found", param: "previous_response_id"}，
    // 訊息本身不一定提到 previous_response_id。
    const isInvalidChain = (event) => {
      const error = event?.error || event?.response?.error || {};
      return error.code === "previous_response_not_found"
        || error.param === "previous_response_id"
        || String(error.message || "").includes("previous_response_id");
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
        // 官方上游的 error 帶 HTTP status（例如用量上限的 429），Codex 會自己處理並丟掉
        // 這條連線，後面補的 response.failed 不會被讀到；沒帶 status 的 error 則會被 Codex
        // 忽略，不補終止事件就要空等閒置逾時。所以兩種情況都補，原本的 error 照樣先送。
        if (type === "error") {
          onEvent(responseFailedFromErrorEvent(event));
          stats.responseFailedSent += 1;
        }
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

function streamBridgeFor(meta) {
  return meta.translate === "chat" ? bridgeChatStream : bridgeAnthropicStream;
}

function recordClaudeBridgeFailure(event, meta) {
  if (meta.translate !== "anthropic" || event.type !== "response.failed") return;
  if (meta.claudeFailureKind === "refusal") stats.claudeRefusals += 1;
  if (meta.claudeFailureKind === "empty_response") stats.claudeEmptyResponses += 1;
  if (meta.claudeCompactionFailed) stats.claudeCompactionFailures += 1;
}

// HTTP 傳輸同樣需要轉譯。Codex 預設走 WebSocket，但連線反覆失敗後會退回
// HTTPS；此時若把上游的原生事件原樣送回，客戶端解不開，該對話就會
// 永遠停在「正在重新連線」，而且再也回不來——因為每次重試都是同一個結果。
export async function bridgeTranslatedToHttp(upstream, response, meta) {
  stats.lastCustomStatus = upstream.status;
  if (!upstream.body) throw new Error("上游響應沒有內文");
  response.routerResponsesStream = true;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let sawTerminal = false;
  await streamBridgeFor(meta)(
    upstream.body,
    (event) => {
      if (isTerminalEvent(event)) { sawTerminal = true; response.routerTerminalSent = true; }
      recordClaudeBridgeFailure(event, meta);
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

export async function bridgeTranslatedToWebSocket(upstream, socket, meta, captureId = null) {
  stats.lastWebSocketStatus = upstream.status;
  if (!upstream.body) throw new Error("WebSocket 上游響應沒有內文");
  const rawCaptureName = meta.translate === "chat" ? "chat-response.sse" : "anthropic-response.sse";
  const tee = captureId
    ? async function* (src) {
        for await (const chunk of src) {
          captureAppend(captureId, rawCaptureName, Buffer.from(chunk));
          yield chunk;
        }
      }
    : null;
  let sawTerminal = false;
  await streamBridgeFor(meta)(
    tee ? tee(upstream.body) : upstream.body,
    (event) => {
      captureAppend(captureId, "response.sse", `data: ${JSON.stringify(event)}\n\n`);
      if (isTerminalEvent(event)) sawTerminal = true;
      recordClaudeBridgeFailure(event, meta);
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
      stats.lastProvider = null;
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
    if (meta.chatRequest) captureWrite(captureId, "chat-request.json", JSON.stringify(meta.chatRequest, null, 2));
    if (meta.translate && upstream.status >= 200 && upstream.status < 300) {
      await bridgeTranslatedToWebSocket(upstream, socket, meta, captureId);
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
        providers: providerSummary,
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

export function textOf(content) {
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
export function lateToolOutputNotice(item) {
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

export function bridgeInputError(message) {
  return Object.assign(new Error(message), { name: "BridgeRequestError" });
}

// Codex 在對話中途補送的 developer 訊息（技能清單、協作模式、切換模型、時間等）
// 若併進 system，system 一變，tools → system → messages 之後的快取就全部失效。
// 開頭那組 developer 訊息仍進 system；之後出現的留在原位，以 system-reminder 標示來源。
export function midConversationInstruction(text) {
  return `<system-reminder>\nCodex developer message:\n${text}\n</system-reminder>`;
}

// Codex 送給自訂模型的是 GPT 版系統提示：要求把進度送到 commentary 頻道、答案送到 final
// 頻道。Claude 的輸出沒有頻道，這段要求對它不起作用，於是多半一路呼叫工具不說話。
// 這裡把兩個頻道對應到 Claude 實際的輸出方式，並比照 Claude Code 的進度更新規則。
// 內容固定，放在 system 最後，不影響提示快取。
export const CLAUDE_CODEX_GUIDANCE = [
  "# Notes for Claude models in Codex",
  "",
  "The instructions above were written for GPT models. You are a Claude model running in Codex, and your output has no channels. Map them this way:",
  "- `commentary` channel: any text you write before a tool call. Codex shows it to the user immediately as a progress update.",
  "- `final` channel: your last message, with no tool call after it. It ends the turn, so it must contain everything the user needs from this turn.",
  "",
  "Your text is the main way the user follows your work. Before your first tool call, say in one sentence what you're about to do. While working, give a short update when you find something important, change direction, or hit a blocker, and don't run through a long series of tool calls in silence. Keep each update to one or two complete sentences that make sense to someone catching up, and don't narrate your internal deliberation.",
].join("\n");

// Codex protocol AgentMessage: inter-agent input, not this assistant's reply
// or a tool result. Keep provenance and every plaintext block in order.
export function agentMessageText(item) {
  if (!Array.isArray(item.content) || typeof item.author !== "string" || typeof item.recipient !== "string") {
    throw bridgeInputError("agent_message 欄位不完整，無法安全轉譯；請提供明文工作摘要。");
  }
  const parts = item.content.map((part) => {
    if (part?.type === "encrypted_content") {
      throw bridgeInputError("agent_message 包含無法解密的跨 Agent 訊息；請由來源 Agent 提供明文摘要，或改用原模型繼續。");
    }
    if (part?.type !== "input_text" || typeof part.text !== "string") {
      throw bridgeInputError("agent_message 包含不支援的內容格式，無法安全省略；請提供明文工作摘要。");
    }
    return part.text;
  });
  return `Inter-agent message ${JSON.stringify({ author: item.author, recipient: item.recipient })}\n${parts.join("\n")}`;
}

export function parseToolArguments(value) {
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

export function flattenTools(items, out = [], namespace = null, targets = new Map()) {
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

// 只讀取協議指定的工具載體，不從訊息正文或任意巢狀 JSON 發掘工具。
// 搜尋載入的定義先加入；本輪明確宣告的工具可以覆蓋歷史中的舊定義。
export function collectToolDefinitions(body, inputItems) {
  const definitions = [];
  for (const item of inputItems) {
    if (item?.type === "tool_search_output" && item.execution !== "server" &&
        (!item.status || item.status === "completed") && Array.isArray(item.tools)) {
      definitions.push(...item.tools);
    }
  }
  if (Array.isArray(body.tools)) definitions.push(...body.tools);
  for (const item of inputItems) {
    if (item?.type === "additional_tools" && Array.isArray(item.tools)) definitions.push(...item.tools);
  }
  return definitions;
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
export function flattenTopLevelSchema(schema) {
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
      // Anthropic 沒有自由格式工具的 grammar 欄位；保留在說明中，避免模型
      // 知道工具存在卻不知道 apply_patch 等工具所需的精確輸入格式。
      const grammar = tool.format?.type === "grammar" && typeof tool.format.definition === "string"
        ? tool.format.definition.replaceAll("\r\n", "\n").trim() : "";
      if (grammar) {
        description += `\n\nPut the raw payload in the \`${FREEFORM_KEY}\` string. It must follow this ${tool.format.syntax || ""} grammar:\n${grammar}`;
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
export const COMPACTION_PROMPT =
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
  // 個別路由可提高預設輸出預算，仍由模型上限夾住；其他路由沿用原本預設。
  const defaultMaxOutput =
    typeof route === "object" && Number.isSafeInteger(route?.defaultMaxOutputTokens) && route.defaultMaxOutputTokens > 0
      ? route.defaultMaxOutputTokens
      : DEFAULT_MAX_TOKENS;
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
  const toolDefinitions = collectToolDefinitions(body, inputItems);
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
  // 只看項目本身與它之前的內容，重播同一段歷史時分類結果不會改變。
  let leadingInstructions = true;
  for (const item of inputItems) {
    const kind = item?.type || (item?.role ? "message" : null);
    const instruction = kind === "message" && (item.role === "developer" || item.role === "system");
    if (!instruction && kind !== "additional_tools") leadingInstructions = false;
    switch (kind) {
      case "additional_tools": {
        break;
      }

      case "agent_message":
        push("user", { type: "text", text: agentMessageText(item) });
        break;

      case "message": {
        if (item.role === "developer" || item.role === "system") {
          // system 只接受純文字。
          const text = textOf(item.content);
          if (!text) break;
          if (leadingInstructions) systemParts.push(text);
          else push("user", { type: "text", text: midConversationInstruction(text) });
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
    Number(body.max_output_tokens) || defaultMaxOutput,
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

  systemParts.push(CLAUDE_CODEX_GUIDANCE);
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
    // 手動 thinking 不能與 any/tool 並用；保留呼叫方的工具限制，只關閉本輪
    // 手動思考。新式 output_config / adaptive 路由不受這個限制。
    request.thinking = ["any", "tool"].includes(request.tool_choice?.type)
      ? { type: "disabled" }
      : { type: "enabled", budget_tokens: budget };
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

export function randomId(prefix, length) {
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
  let completed = false;
  // 文字項目的 output_item.done 延到確定後面接什麼才送出：後面還有其他內容或工具呼叫的是
  // 進度更新（commentary）；整則回應最後一段、且這一輪沒有工具呼叫的才是最終答案
  // （final_answer）。Codex 桌面版靠這個標記辨識最終答案。逐字串流照常，只延後 done。
  let pendingText = null;
  const flushText = (phase) => {
    if (!pendingText) return;
    const { index, item } = pendingText;
    pendingText = null;
    item.phase = phase;
    output.push(item);
    send({ type: "response.output_item.done", output_index: index, item });
  };

  const decoder = new TextDecoder();
  let pending = "";

  const failResponse = (error, kind = null) => {
    // 先在原本的抑制狀態下補完已串流的文字，壓縮回合的文字仍不外送。
    flushText("commentary");
    failed = true;
    suppress = false;
    if (kind) ctx.claudeFailureKind = kind;
    if (compactionMode) ctx.claudeCompactionFailed = true;
    const response = base();
    response.status = "failed";
    response.error = error;
    response.usage = mapUsage(usage);
    send({ type: "response.failed", response });
  };

  const refusalMessage = (details) => {
    const category = typeof details?.category === "string"
      ? details.category.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)
      : "";
    const explanation = typeof details?.explanation === "string"
      ? details.explanation.replace(/\s+/g, " ").trim().slice(0, 300)
      : "";
    return `Claude 拒絕處理這一輪${category ? `（${category}）` : ""}。` +
      `${explanation ? `原因：${explanation} ` : ""}` +
      "請移除或改寫觸發拒答的內容；若歷史仍包含該內容，請改開新對話。";
  };

  const handle = (event) => {
    if (failed || completed) return;
    switch (event.type) {
      case "content_block_start": {
        flushText("commentary");
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
          pendingText = { index: cur.index, item };
        } else if (cur.kind === "custom_tool" || cur.kind === "function_tool") {
          let parsed;
          try {
            parsed = parseToolArguments(cur.json || cur.initialInput);
            if (cur.kind === "custom_tool" && typeof parsed[FREEFORM_KEY] !== "string") throw bridgeInputError("自由格式工具缺少字串 input。");
          } catch {
            failResponse({ code: "invalid_tool_arguments", message: "上游工具參數不完整或格式錯誤；未產生替代參數，請重新產生該工具呼叫。" });
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
        if (stopReason === "refusal" || event.stop_details?.type === "refusal") {
          failResponse({ code: "invalid_prompt", message: refusalMessage(event.stop_details) }, "refusal");
        }
        break;

      case "message_stop": {
        const toolCalled = output.some((item) => item.type === "function_call" || item.type === "custom_tool_call");
        flushText(!toolCalled && (stopReason === "end_turn" || stopReason === "stop_sequence")
          ? "final_answer" : "commentary");
        if (compactionMode) {
          if (!compactionText.trim() || (stopReason && stopReason !== "end_turn")) {
            failResponse({
              code: "invalid_prompt",
              message: stopReason === "max_tokens"
                ? "Claude 的壓縮摘要超過輸出上限，原始對話歷史未替換。"
                : "Claude 沒有產生完整的壓縮摘要，原始對話歷史未替換。",
            }, "empty_compaction");
            break;
          }
          suppress = false;
          const summary = compactionText.trim();
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
        } else if (!output.some((item) =>
          item.type === "function_call" || item.type === "custom_tool_call" ||
          (item.type === "message" && item.content?.some((part) =>
            part.type === "output_text" && part.text?.trim())))) {
          failResponse({
            code: "invalid_prompt",
            message: "Claude 上游回報已完成，但沒有產生可顯示的回答或工具呼叫。請檢查上游回應，或改用新對話重試。",
          }, "empty_response");
          break;
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
        completed = true;
        break;
      }

      // Anthropic 在串流中途出錯（最常見的是 overloaded_error）時送這個事件，然後結束串流。
      // 只轉成頂層 error 的話 Codex 會忽略它：WebSocket 上要空等閒置逾時才重試。
      case "error": {
        failResponse(codexErrorFromUpstream(event.error || {}));
        break;
      }

      default:
        break; // ping 等忽略
    }
  };

  const consume = (block) => {
    const lines = block.split(/\r?\n/);
    const data = lines.filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return;
    let event;
    try { event = JSON.parse(data); } catch {
      failResponse({ code: "invalid_upstream_response", message: "Claude 上游串流含有無法解析的事件。" });
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      failResponse({ code: "invalid_upstream_response", message: "Claude 上游串流事件格式不正確。" });
      return;
    }
    // 相容只在 SSE event 欄位標示類型的閘道。
    const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    handle({ ...event, type: event.type || eventName });
  };
  let mode = null;
  const maxBufferedBytes = 16 * 1024 * 1024;
  const drain = () => {
    if (!mode && pending.trimStart()) mode = pending.trimStart().startsWith("{") ? "json" : "sse";
    if (mode !== "sse") return;
    for (;;) {
      const match = /\r?\n\r?\n/.exec(pending);
      if (!match || failed || completed) break;
      const block = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      consume(block);
    }
  };
  for await (const chunk of upstreamBody) {
    pending += decoder.decode(chunk, { stream: true });
    drain();
    if (failed || completed) break;
    if (Buffer.byteLength(pending, "utf8") > maxBufferedBytes) {
      failResponse({ code: "invalid_upstream_response", message: "Claude 上游回應超過轉譯緩衝上限。" });
      break;
    }
  }
  if (failed || completed) return;
  pending += decoder.decode();
  drain();
  if (failed || completed) return;
  if (mode === "json") {
    // 部分中轉忽略 stream:true。完整 JSON 也走同一組事件處理，保留工具、
    // 推理、拒答、用量與壓縮語意；沒有明確終止原因時不可假裝成功。
    let message;
    try { message = JSON.parse(pending); } catch {
      failResponse({ code: "invalid_upstream_response", message: "Claude 上游 JSON 回應不完整或格式錯誤。" });
      return;
    }
    if (message?.type === "error" || message?.error) {
      handle({ type: "error", error: message.error });
      return;
    }
    if (message?.type !== "message" || message.role !== "assistant" ||
        !Array.isArray(message.content) || typeof message.stop_reason !== "string" || !message.stop_reason) {
      failResponse({ code: "invalid_upstream_response", message: "Claude 上游 JSON 缺少完整訊息或終止原因。" });
      return;
    }
    if (message.content.some((block) => !["text", "thinking", "redacted_thinking", "tool_use"].includes(block?.type))) {
      failResponse({ code: "invalid_upstream_response", message: "Claude 上游 JSON 含有尚未支援的內容區塊。" });
      return;
    }
    handle({ type: "message_start", message });
    // 先處理拒答，避免把被拒絕回合的工具當成有效呼叫。
    handle({ type: "message_delta", delta: { stop_reason: message.stop_reason }, stop_details: message.stop_details });
    for (const [index, block] of message.content.entries()) {
      handle({ type: "content_block_start", index, content_block: block.type === "text" ? { ...block, text: "" } : block });
      if (block.type === "text") handle({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      if (block.type === "thinking") {
        handle({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
        handle({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
      }
      handle({ type: "content_block_stop", index });
    }
    handle({ type: "message_stop" });
  } else if (pending.trim()) {
    consume(pending);
  }
  // 串流在 message_stop 前中斷：已完成的文字以進度更新收尾，終止事件仍由 router 補。
  if (!failed && !completed) flushText("commentary");
  // 真正缺少 message_stop 的串流仍交由 router 補失敗，不因收到部分文字而
  // 自行合成成功；只有最後一筆事件少了結尾空行時才在上面正常讀取它。
}
__CODEX_MODEL_ROUTER_CHAT_JS__
// Codex Responses API <-> OpenAI Chat Completions 雙向轉譯。
//
// 存在的理由：DeepSeek、通義千問、GLM、Kimi、Gemini 的相容介面、Ollama、vLLM 這類
// 供應商只提供 /chat/completions，沒有 /responses。Codex 只會說 Responses，這些模型
// 以前在探測時一律被跳過。
//
// 結構比照 claude-bridge.mjs：請求方向把 Responses 的 input 項目轉成 messages，
// 回應方向讀 Chat Completions 的 SSE，逐一產生 Codex 認得的 Responses 事件。
// 兩邊共用的規則——工具名稱攤平、平台內建工具的文字摘要、壓縮回合、錯誤碼——
// 直接用 claude-bridge.mjs 的同一份實作。

import {
  COMPACTION_PROMPT,
  COMPACTION_REPLAY_PREFIX,
  bridgeInputError,
  collectToolDefinitions,
  agentMessageText,
  codexErrorFromUpstream,
  compactCodeModeDescription,
  decodeCompaction,
  encodeCompaction,
  flattenTools,
  flattenTopLevelSchema,
  hostedToolSummary,
  lateToolOutputNotice,
  parseToolArguments,
  randomId,
  textOf,
  toolAlias,
} from "./claude-bridge.mjs";

// 自由格式工具（type:"custom"）在 Chat Completions 沒有對應概念，
// 比照 Claude 轉譯用單一字串參數模擬。
const FREEFORM_KEY = "input";

// Codex 的推理強度對到 Chat Completions 的 reasoning_effort。OpenAI 定義的檔位只到
// high，更高的一律對到 high。
const CHAT_EFFORTS = {
  minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high", ultra: "high",
};

const NO_OUTPUT = "(no output)";

// ---------------------------------------------------------------- 推理
//
// Chat Completions 的推理是明文（delta.reasoning_content 或 delta.reasoning）。
// 轉成 Responses 的 reasoning 項目時，完整文字放進 summary——Codex 顯示的就是它；
// encrypted_content 只放一個固定標記，讓路由器認得這是本轉譯層的產物：
// 送往官方與其他路由前要剝掉，否則對方驗不過而整輪拒收。
//
// 推理只在同一輪的工具往返裡送回（最後一則使用者訊息之後）。DeepSeek、Kimi 這類
// 模型在工具往返中需要看到自己先前的推理；更早幾輪的推理它們會忽略，送了只是浪費。
export const CHAT_REASONING_MARKER = Buffer.from(
  JSON.stringify({ router_chat_reasoning: 1 }), "utf8",
).toString("base64");

export function isChatReasoning(item) {
  return item?.type === "reasoning" && item.encrypted_content === CHAT_REASONING_MARKER;
}

function reasoningText(item) {
  const parts = [
    ...(Array.isArray(item.summary) ? item.summary : []),
    ...(Array.isArray(item.content) ? item.content : []),
  ];
  return parts.map((part) => (typeof part?.text === "string" ? part.text : "")).filter(Boolean).join("\n");
}

// ---------------------------------------------------------------- 請求方向

const IMAGE_URL_PATTERN = /^(?:data:image\/[A-Za-z0-9.+-]+;base64,|https?:\/\/)/;

// Responses 的內容陣列轉成 Chat Completions 的 content parts。
function toChatParts(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) {
    if (content === null || content === undefined) return [];
    const text = JSON.stringify(content);
    return text ? [{ type: "text", text }] : [];
  }
  const parts = [];
  for (const part of content) {
    if (part?.type === "resource_link") {
      parts.push({ type: "text", text: JSON.stringify({ name: part.name, title: part.title, uri: part.uri, description: part.description }) });
      continue;
    }
    if (part?.type === "resource" && typeof part.resource?.text === "string") {
      parts.push({ type: "text", text: part.resource.text });
      continue;
    }
    if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
      parts.push({ type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } });
      continue;
    }
    if (part?.type === "input_file") {
      throw bridgeInputError("Chat Completions 轉譯不支援檔案附件；請用本機檔案工具讀取內容，或改用支援檔案的模型。");
    }
    if (typeof part?.text === "string") {
      if (part.text) parts.push({ type: "text", text: part.text });
      continue;
    }
    const url = typeof part?.image_url === "string" ? part.image_url
      : (typeof part?.image_url?.url === "string" ? part.image_url.url : part?.url);
    if (typeof url === "string" && IMAGE_URL_PATTERN.test(url)) {
      parts.push({ type: "image_url", image_url: { url } });
      continue;
    }
    if (part?.type && !["text", "input_text", "output_text"].includes(part.type)) {
      throw bridgeInputError("Chat Completions 轉譯收到不支援的內容類型；請先用對應工具讀取或轉換附件，再重送文字／圖片。");
    }
  }
  return parts;
}

// 只有文字時送字串：這是所有相容介面都接受的形式，有些只接受這種。
function toChatContent(parts) {
  if (parts.every((part) => part.type === "text")) return parts.map((part) => part.text).join("\n");
  return parts;
}

function toChatTools(codexTools) {
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
      // 自由格式工具的文法（例如 apply_patch 的 patch 格式）原本由 Responses 的 format
      // 帶給模型；函式工具沒有這個欄位，併進說明裡，否則模型不知道 input 該怎麼寫。
      const grammar = tool.format?.type === "grammar" && typeof tool.format.definition === "string"
        ? tool.format.definition.replaceAll("\r\n", "\n").trim() : "";
      if (grammar) {
        description += `\n\nPut the raw payload in the \`${FREEFORM_KEY}\` string. It must follow this ${tool.format.syntax || ""} grammar:\n${grammar}`;
      }
      tools.push({
        type: "function",
        function: {
          name: tool.name,
          description,
          parameters: {
            type: "object",
            properties: {
              [FREEFORM_KEY]: { type: "string", description: "The raw payload for this tool, passed through verbatim." },
            },
            required: [FREEFORM_KEY],
          },
        },
      });
    } else if (tool.type === "function") {
      tools.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: flattenTopLevelSchema(tool.parameters),
        },
      });
    }
  }
  return { tools, freeform, toolContext };
}

function clip(text, max = 2000) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isUserMessage(item) {
  return (item?.type === "message" || (!item?.type && item?.role)) && item.role === "user";
}

// route 可傳字串（僅模型名）或路由物件。回傳 Chat Completions 請求與回應轉譯需要的資訊。
export function toChatRequest(body, route) {
  const upstreamModel = typeof route === "string" ? route : route?.upstreamModel;
  // 探測時上游拒絕 tools 參數的模型：工具呼叫與結果都改成文字，只能以文字回答。
  const textOnlyTools = typeof route === "object" && route?.chatTools === false;
  const systemParts = typeof body.instructions === "string" && body.instructions ? [body.instructions] : [];
  const messages = [];
  let compaction = false;

  const inputItems = typeof body.input === "string"
    ? [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }]
    : (Array.isArray(body.input) ? body.input : []);

  // 同時接受標準 Responses 頂層 tools 與 Codex 的 additional_tools；後出現的同名定義優先。
  const toolDefinitions = collectToolDefinitions(body, inputItems);
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
    systemParts.push("此 Chat Completions 轉譯路由不提供以下平台內建工具：" +
      [...new Set(unavailable)].map((name) => String(name).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)).join(", ") +
      "。只能呼叫本次實際提供的 function/custom 工具。需要生圖且已安裝 router-imagegen 技能時，可使用該技能；沒有可用工具時請明確說明，勿宣稱已完成。");
  }
  if (textOnlyTools && codexTools.length) {
    systemParts.push("這個模型的介面不支援工具呼叫，本輪無法執行任何工具。請直接以文字回答；需要執行命令或修改檔案時，列出具體步驟讓使用者自行操作，勿宣稱已完成。");
  }
  const format = body.text?.format;
  if (format && !["text", "json_schema", "json_object"].includes(format.type)) {
    throw bridgeInputError("Chat Completions 轉譯尚未支援此結構化輸出格式，請改用文字或 JSON schema 輸出。");
  }

  // 推理只在這一輪（最後一則使用者訊息之後）的工具往返裡送回。
  let turnStart = 0;
  inputItems.forEach((item, index) => { if (isUserMessage(item)) turnStart = index + 1; });

  let assistant = null;
  // 最近一則 assistant 訊息裡還沒收到結果的 call_id。Chat Completions 要求帶 tool_calls 的
  // assistant 訊息後面緊接著每個呼叫各自的 tool 訊息，中間不能夾別的訊息。
  let awaiting = [];
  const answered = new Map();
  // 工具結果裡的圖片：tool 訊息只能放文字，等這一組 tool 訊息結束後再以 user 訊息附上。
  const deferredImages = [];
  let toolOutputsMerged = 0;
  let lateToolOutputs = 0;
  let placeholderToolResults = 0;

  const pushUser = (parts) => {
    if (!parts.length) return;
    const last = messages[messages.length - 1];
    if (last?.role === "user") {
      last.parts.push(...parts);
      return;
    }
    messages.push({ role: "user", parts: [...parts] });
  };
  const flushAssistant = () => {
    if (!assistant) return;
    const current = assistant;
    assistant = null;
    if (!current.text && !current.toolCalls.length) return;
    const message = { role: "assistant", content: current.text };
    if (current.toolCalls.length) message.tool_calls = current.toolCalls;
    if (current.reasoning && current.replayReasoning) message.reasoning_content = current.reasoning;
    messages.push(message);
    awaiting = current.toolCalls.map((call) => call.id);
  };
  const closeToolGroup = () => {
    flushAssistant();
    for (const id of awaiting) {
      const message = { role: "tool", tool_call_id: id, content: NO_OUTPUT };
      messages.push(message);
      answered.set(id, message);
      placeholderToolResults += 1;
    }
    awaiting = [];
    if (deferredImages.length) pushUser(deferredImages.splice(0));
  };
  const currentAssistant = (index) => {
    if (!assistant) {
      closeToolGroup();
      assistant = { text: "", toolCalls: [], reasoning: "", replayReasoning: index >= turnStart };
    }
    return assistant;
  };
  const appendAssistantText = (index, text) => {
    if (!text) return;
    const current = currentAssistant(index);
    current.text = current.text ? `${current.text}\n\n${text}` : text;
  };
  const pushToolCall = (index, callId, name, args) => {
    if (textOnlyTools || !callId) {
      appendAssistantText(index, `(呼叫工具 ${name}：${clip(args)})`);
      return;
    }
    currentAssistant(index).toolCalls.push({ id: callId, type: "function", function: { name, arguments: args } });
  };
  const handleToolOutput = (item) => {
    // local_shell_call_output 以 id 指向那次呼叫的 call_id。
    const callId = item.type === "local_shell_call_output" && !item.call_id ? item.id : item.call_id;
    const parts = toChatParts(item.output);
    const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const images = parts.filter((part) => part.type !== "text");
    flushAssistant();
    if (!callId || textOnlyTools) {
      // 沒有 call_id 的是從其他任務轉送來的訊息，不是某次工具呼叫的結果；
      // 這條路由不支援工具時，結果同樣只能當文字給模型看。
      closeToolGroup();
      const label = callId ? `(工具呼叫 ${callId} 的結果)` : null;
      pushUser([...(label ? [{ type: "text", text: label }] : []), ...parts]);
      return;
    }
    if (awaiting.includes(callId)) {
      const message = { role: "tool", tool_call_id: callId, content: text || (images.length ? "(結果是圖片，見下一則訊息)" : NO_OUTPUT) };
      messages.push(message);
      answered.set(callId, message);
      awaiting = awaiting.filter((id) => id !== callId);
      if (images.length) deferredImages.push({ type: "text", text: `(工具呼叫 ${callId} 回傳的圖片)` }, ...images);
      if (!awaiting.length && deferredImages.length) pushUser(deferredImages.splice(0));
      return;
    }
    // Code Mode 的 exec 每呼叫一次 notify()，Codex 就替同一個 call_id 追加一筆輸出。
    // 還在同一組 tool 訊息裡就併回原本的結果；模型已經往下走的話，改成使用者文字。
    const earlier = answered.get(callId);
    const position = earlier ? messages.indexOf(earlier) : -1;
    if (position >= 0 && messages.slice(position + 1).every((message) => message.role === "tool")) {
      if (text) earlier.content = earlier.content === NO_OUTPUT ? text : `${earlier.content}\n${text}`;
      if (images.length) deferredImages.push({ type: "text", text: `(工具呼叫 ${callId} 回傳的圖片)` }, ...images);
      toolOutputsMerged += 1;
      return;
    }
    closeToolGroup();
    pushUser([{ type: "text", text: lateToolOutputNotice(item) }, ...parts]);
    lateToolOutputs += 1;
  };

  inputItems.forEach((item, index) => {
    switch (item?.type || (item?.role ? "message" : null)) {
      case "additional_tools":
        break;

      case "agent_message": {
        const text = agentMessageText(item);
        closeToolGroup();
        pushUser([{ type: "text", text }]);
        break;
      }

      case "message": {
        if (item.role === "developer" || item.role === "system") {
          const text = textOf(item.content);
          if (text) systemParts.push(text);
          break;
        }
        if (item.role === "assistant") {
          appendAssistantText(index, textOf(item.content));
          break;
        }
        const parts = toChatParts(item.content);
        if (!parts.length) break;
        closeToolGroup();
        pushUser(parts);
        break;
      }

      case "reasoning": {
        // 官方加密推理與 Claude 的簽章在這裡都用不上；只送回本轉譯層自己產生的。
        if (!isChatReasoning(item)) break;
        const text = reasoningText(item);
        if (!text) break;
        const current = currentAssistant(index);
        current.reasoning = current.reasoning ? `${current.reasoning}\n${text}` : text;
        break;
      }

      case "function_call": {
        const args = JSON.stringify(parseToolArguments(item.arguments ?? "{}"));
        pushToolCall(index, item.call_id, toolAlias(item.namespace, item.name), args);
        break;
      }

      case "custom_tool_call":
        if (typeof item.input !== "string") throw bridgeInputError("歷史自由格式工具的 input 必須是字串，無法安全替換成空內容。");
        pushToolCall(index, item.call_id, toolAlias(item.namespace, item.name), JSON.stringify({ [FREEFORM_KEY]: item.input }));
        break;

      // 官方 GPT 回合的本機命令：轉成工具呼叫，後面那筆輸出才配得上 tool 訊息。
      case "local_shell_call": {
        const action = item.action && typeof item.action === "object" && !Array.isArray(item.action) ? item.action : {};
        if (item.call_id) pushToolCall(index, item.call_id, "local_shell", JSON.stringify(action));
        else appendAssistantText(index, hostedToolSummary(item).text);
        break;
      }

      case "local_shell_call_output":
      case "custom_tool_call_output":
      case "function_call_output":
        handleToolOutput(item);
        break;

      // 官方 GPT 回合留下的平台內建工具項目：都已完成，也沒有可轉送的執行器，轉成簡短文字。
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
        if (summary.role === "assistant") appendAssistantText(index, summary.text);
        else {
          closeToolGroup();
          pushUser([{ type: "text", text: summary.text }]);
        }
        break;
      }

      case "compaction_trigger":
        compaction = true;
        break;

      case "compaction":
      case "context_compaction": {
        const summary = decodeCompaction(item.encrypted_content);
        if (summary) {
          closeToolGroup();
          pushUser([{ type: "text", text: `${COMPACTION_REPLAY_PREFIX}${summary}` }]);
        }
        break;
      }

      default:
        if (item?.type) {
          const type = String(item.type).replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 64);
          throw bridgeInputError(`Chat Completions 轉譯收到不支援的對話項目（${type}），無法安全省略；請改用原模型繼續，或在新任務中提供工作摘要。`);
        }
        break;
    }
  });
  closeToolGroup();

  // compaction_trigger 本身沒有文字，補上與 Codex 本機壓縮同一份提示詞。
  if (compaction) pushUser([{ type: "text", text: COMPACTION_PROMPT }]);
  // 部分模型的對話範本要求第一則非 system 訊息是 user。
  if (!messages.length || messages[0].role !== "user") messages.unshift({ role: "user", parts: [{ type: "text", text: "." }] });

  const chatMessages = messages.map((message) => (message.role === "user"
    ? { role: "user", content: toChatContent(message.parts) }
    : message));
  if (systemParts.length) chatMessages.unshift({ role: "system", content: systemParts.join("\n\n") });

  const { tools, freeform, toolContext } = toChatTools(codexTools);
  const request = { model: upstreamModel, messages: chatMessages, stream: true };
  for (const key of ["temperature", "top_p"]) {
    if (body[key] !== undefined) request[key] = body[key];
  }
  // 串流預設不回用量；要明確要求。少數閘道不認得 stream_options，探測時會記下來。
  if (route?.chatStreamOptions !== false) request.stream_options = { include_usage: true };

  // 壓縮回合只能回摘要，不送 tools。歷史裡的工具呼叫與結果照樣保留，Chat Completions
  // 不要求本輪一定要定義 tools。
  if (tools.length && !compaction && !textOnlyTools) {
    request.tools = tools;
    if (typeof body.parallel_tool_calls === "boolean") request.parallel_tool_calls = body.parallel_tool_calls;
    const choice = body.tool_choice;
    if (choice === "none") request.tool_choice = "none";
    else if (choice === "required") request.tool_choice = "required";
    else if (choice && typeof choice === "object" && ["function", "custom"].includes(choice.type)) {
      const name = toolAlias(choice.namespace, choice.name);
      if (!tools.some((tool) => tool.function.name === name)) throw bridgeInputError("指定的工具不在這次可用工具清單內。");
      request.tool_choice = { type: "function", function: { name } };
    } else if (choice && choice !== "auto") {
      throw bridgeInputError("Chat Completions 轉譯不支援這個 tool_choice，請選用本次提供的函式工具。");
    }
  } else if (!tools.length && body.tool_choice && !["auto", "none"].includes(body.tool_choice)) {
    throw bridgeInputError("指定的工具在 Chat Completions 轉譯路由中不可用。");
  }

  const effort = body?.reasoning?.effort;
  if (effort && Array.isArray(route?.efforts) && route.efforts.length && CHAT_EFFORTS[effort]) {
    request.reasoning_effort = CHAT_EFFORTS[effort];
  }
  if (Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0) {
    request.max_tokens = body.max_output_tokens;
  }
  if (format?.type === "json_schema") {
    request.response_format = {
      type: "json_schema",
      json_schema: { name: format.name || "output", schema: format.schema || {}, ...(format.strict != null ? { strict: format.strict } : {}) },
    };
  } else if (format?.type === "json_object") {
    request.response_format = { type: "json_object" };
  }

  return {
    request, freeform, toolTargets, compaction, toolContext,
    toolOutputsMerged, lateToolOutputs, placeholderToolResults,
  };
}

// ---------------------------------------------------------------- 回應方向

function mapChatUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = Number(usage.prompt_tokens) || 0;
  // DeepSeek 以 prompt_cache_hit_tokens 回報快取命中。
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens) || 0;
  const output = Number(usage.completion_tokens) || 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: Number(usage.completion_tokens_details?.reasoning_tokens) || 0 },
    total_tokens: Number(usage.total_tokens) || input + output,
  };
}

// 有些模型（例如沒開推理解析器的 vLLM、Ollama 上的 R1 類模型）把推理包在內文開頭的
// <think>…</think> 裡。拆出來當推理顯示，不然整段思考會混進回答。
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

function createThinkSplitter() {
  let state = "start";
  let buffer = "";
  return {
    push(text) {
      const out = [];
      buffer += text;
      for (;;) {
        if (state === "start") {
          const trimmed = buffer.trimStart();
          if (!trimmed) return out;
          if (trimmed.startsWith(THINK_OPEN)) {
            state = "inside";
            buffer = trimmed.slice(THINK_OPEN.length);
            continue;
          }
          if (THINK_OPEN.startsWith(trimmed)) return out;
          state = "content";
          continue;
        }
        if (state === "inside") {
          const end = buffer.indexOf(THINK_CLOSE);
          if (end >= 0) {
            if (end > 0) out.push({ kind: "reasoning", text: buffer.slice(0, end) });
            buffer = buffer.slice(end + THINK_CLOSE.length).replace(/^\s+/, "");
            state = "content";
            continue;
          }
          // 結束標記可能被切在兩個片段之間：留下可能是標記開頭的尾巴。
          let keep = 0;
          for (let length = Math.min(THINK_CLOSE.length - 1, buffer.length); length > 0; length -= 1) {
            if (THINK_CLOSE.startsWith(buffer.slice(-length))) { keep = length; break; }
          }
          if (buffer.length > keep) out.push({ kind: "reasoning", text: buffer.slice(0, buffer.length - keep) });
          buffer = buffer.slice(buffer.length - keep);
          return out;
        }
        if (buffer) out.push({ kind: "content", text: buffer });
        buffer = "";
        return out;
      }
    },
    // 串流結束時剩下的內容：還沒判斷完的開頭是內文，推理裡的殘段仍算推理。
    flush() {
      const text = buffer;
      buffer = "";
      if (!text) return [];
      return [{ kind: state === "inside" ? "reasoning" : "content", text }];
    },
  };
}

function* sseData(block) {
  const lines = block.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  if (!lines.length) return;
  yield lines.map((line) => line.slice(5).replace(/^ /, "")).join("\n");
}

/**
 * 讀取 Chat Completions 的 SSE 串流，逐一產生 Codex Responses 事件。
 * @param {AsyncIterable<Uint8Array>} upstreamBody
 * @param {(event: object) => void} emit
 * @param {{model: string, requestBody: object, freeform: Set<string>, toolTargets?: Map<string, {name: string, namespace?: string}>, compaction?: boolean}} ctx
 */
export async function bridgeChatStream(upstreamBody, emit, ctx) {
  const responseId = randomId("resp_", 55);
  const createdAt = Math.floor(Date.now() / 1000);
  let seq = 0;
  let outputIndex = 0;
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

  // 壓縮回合：模型吐的內容一律不外送，收攏成一個 compaction 項目在最後補上。
  const compactionMode = Boolean(ctx.compaction);
  let compactionText = "";
  let suppress = compactionMode;
  const passthroughWhileSuppressed = new Set(["response.created", "response.in_progress"]);
  const send = (event) => {
    if (suppress && !passthroughWhileSuppressed.has(event.type)) return;
    emit({ ...event, sequence_number: seq++ });
  };

  send({ type: "response.created", response: base() });
  send({ type: "response.in_progress", response: base() });

  let reasoning = null;
  let message = null;
  const calls = new Map();
  let finishReason = null;
  let usage = null;
  let failed = false;
  let done = false;
  const splitter = createThinkSplitter();

  const fail = (error) => {
    if (failed || done) return;
    flushMessage("commentary");
    failed = true;
    suppress = false;
    const response = base();
    response.status = "failed";
    response.error = error;
    send({ type: "response.failed", response });
  };

  const closeReasoning = () => {
    if (!reasoning) return;
    const current = reasoning;
    reasoning = null;
    send({ type: "response.reasoning_summary_text.done", item_id: current.itemId, output_index: current.index, summary_index: 0, text: current.text });
    send({ type: "response.reasoning_summary_part.done", item_id: current.itemId, output_index: current.index, summary_index: 0, part: { type: "summary_text", text: current.text } });
    const item = {
      id: current.itemId,
      type: "reasoning",
      content: [],
      encrypted_content: CHAT_REASONING_MARKER,
      summary: [{ type: "summary_text", text: current.text }],
    };
    output.push(item);
    send({ type: "response.output_item.done", output_index: current.index, item });
  };

  // 與 Claude 轉譯相同：文字項目的 output_item.done 延到確定後面接什麼才送出，
  // 最後一段且這一輪沒有工具呼叫的才標成最終答案（final_answer）。
  let pendingMessage = null;
  const flushMessage = (phase) => {
    if (!pendingMessage) return;
    const { index, item } = pendingMessage;
    pendingMessage = null;
    item.phase = phase;
    output.push(item);
    send({ type: "response.output_item.done", output_index: index, item });
  };

  const closeMessage = () => {
    if (!message) return;
    const current = message;
    message = null;
    if (compactionMode) compactionText += current.text;
    send({ type: "response.output_text.done", content_index: 0, item_id: current.itemId, logprobs: [], output_index: current.index, text: current.text });
    send({ type: "response.content_part.done", content_index: 0, item_id: current.itemId, output_index: current.index, part: { type: "output_text", annotations: [], logprobs: [], text: current.text } });
    const item = {
      id: current.itemId,
      type: "message",
      status: "completed",
      content: [{ type: "output_text", annotations: [], logprobs: [], text: current.text }],
      phase: "commentary",
      role: "assistant",
    };
    pendingMessage = { index: current.index, item };
  };

  const appendReasoning = (text) => {
    if (!text) return;
    closeMessage();
    flushMessage("commentary");
    if (!reasoning) {
      reasoning = { itemId: randomId("rs_", 53), index: outputIndex++, text: "" };
      send({ type: "response.output_item.added", output_index: reasoning.index, item: { id: reasoning.itemId, type: "reasoning", content: [], encrypted_content: "", summary: [] } });
      send({ type: "response.reasoning_summary_part.added", item_id: reasoning.itemId, output_index: reasoning.index, summary_index: 0, part: { type: "summary_text", text: "" } });
    }
    reasoning.text += text;
    send({ type: "response.reasoning_summary_text.delta", item_id: reasoning.itemId, output_index: reasoning.index, summary_index: 0, delta: text });
  };

  const appendContent = (text) => {
    if (!text) return;
    closeReasoning();
    if (!message) {
      flushMessage("commentary");
      message = { itemId: randomId("msg_", 54), index: outputIndex++, text: "" };
      send({ type: "response.output_item.added", output_index: message.index, item: { id: message.itemId, type: "message", status: "in_progress", content: [], phase: "commentary", role: "assistant" } });
      send({ type: "response.content_part.added", content_index: 0, item_id: message.itemId, output_index: message.index, part: { type: "output_text", annotations: [], logprobs: [], text: "" } });
    }
    message.text += text;
    send({ type: "response.output_text.delta", content_index: 0, item_id: message.itemId, output_index: message.index, delta: text });
  };

  const routeSplit = (pieces) => {
    for (const piece of pieces) {
      if (piece.kind === "reasoning") appendReasoning(piece.text);
      else appendContent(piece.text);
    }
  };

  const announce = (entry) => {
    flushMessage("commentary");
    entry.announced = true;
    entry.callId ||= randomId("call_", 29);
    entry.index = outputIndex++;
    const target = ctx.toolTargets?.get(entry.alias);
    entry.name = target?.name || entry.alias;
    entry.namespace = target?.namespace || null;
    entry.freeform = ctx.freeform.has(entry.alias);
    const identity = entry.namespace ? { name: entry.name, namespace: entry.namespace } : { name: entry.name };
    send({
      type: "response.output_item.added",
      output_index: entry.index,
      item: entry.freeform
        ? { id: entry.itemId, type: "custom_tool_call", status: "in_progress", call_id: entry.callId, input: "", ...identity }
        : { id: entry.itemId, type: "function_call", status: "in_progress", call_id: entry.callId, arguments: "", ...identity },
    });
  };

  const addToolCallFragment = (fragment, position) => {
    const key = Number.isInteger(fragment?.index) ? `i${fragment.index}`
      : (typeof fragment?.id === "string" && fragment.id ? `d${fragment.id}` : `p${position}`);
    let entry = calls.get(key);
    if (!entry) {
      entry = { itemId: randomId("fc_", 54), callId: null, alias: "", args: "", announced: false, index: null };
      calls.set(key, entry);
    }
    if (typeof fragment?.id === "string" && fragment.id && !entry.callId) entry.callId = fragment.id;
    const name = fragment?.function?.name;
    if (typeof name === "string" && name && !entry.alias) entry.alias = name;
    const args = fragment?.function?.arguments;
    if (typeof args === "string") entry.args += args;
    else if (args && typeof args === "object") entry.args += JSON.stringify(args);
    if (!entry.announced && entry.alias) announce(entry);
  };

  const finishToolCall = (entry) => {
    let parsed = null;
    const raw = entry.args.trim();
    try {
      parsed = parseToolArguments(raw || "{}");
    } catch {
      // 部分模型呼叫自由格式工具時直接給原始內容（或一個 JSON 字串），不包成物件。
      // 以 { 開頭卻解析失敗的是被截斷的 JSON，不能拿來猜。
      if (entry.freeform && raw && !raw.startsWith("{")) {
        let value = entry.args;
        try {
          const decoded = JSON.parse(raw);
          if (typeof decoded === "string") value = decoded;
        } catch { /* 原始內容就是參數。 */ }
        parsed = { [FREEFORM_KEY]: value };
      }
    }
    if (!parsed || (entry.freeform && typeof parsed[FREEFORM_KEY] !== "string")) {
      fail({ code: "invalid_tool_arguments", message: "上游工具參數不完整或格式錯誤；未產生替代參數，請重新產生該工具呼叫。" });
      return false;
    }
    const identity = entry.namespace ? { name: entry.name, namespace: entry.namespace } : { name: entry.name };
    let item;
    if (entry.freeform) {
      const input = parsed[FREEFORM_KEY];
      send({ type: "response.custom_tool_call_input.delta", delta: input, item_id: entry.itemId, output_index: entry.index });
      send({ type: "response.custom_tool_call_input.done", input, item_id: entry.itemId, output_index: entry.index });
      item = { id: entry.itemId, type: "custom_tool_call", status: "completed", call_id: entry.callId, input, ...identity };
    } else {
      const args = JSON.stringify(parsed);
      send({ type: "response.function_call_arguments.delta", delta: args, item_id: entry.itemId, output_index: entry.index });
      send({ type: "response.function_call_arguments.done", arguments: args, item_id: entry.itemId, output_index: entry.index });
      item = { id: entry.itemId, type: "function_call", status: "completed", call_id: entry.callId, arguments: args, ...identity };
    }
    output.push(item);
    send({ type: "response.output_item.done", output_index: entry.index, item });
    return true;
  };

  const finish = () => {
    if (done || failed) return;
    routeSplit(splitter.flush());
    closeReasoning();
    closeMessage();
    flushMessage(calls.size === 0 && (!finishReason || finishReason === "stop") ? "final_answer" : "commentary");
    const pending = [...calls.values()];
    if (pending.some((entry) => !entry.announced)) {
      fail({ code: "invalid_tool_arguments", message: "上游工具呼叫缺少名稱；未執行，請重新產生該工具呼叫。" });
      return;
    }
    for (const entry of pending.sort((left, right) => left.index - right.index)) {
      if (!finishToolCall(entry)) return;
    }
    done = true;
    if (compactionMode) {
      suppress = false;
      // 摘要為空也必須送出項目，否則客戶端直接 Fatal。
      const summary = compactionText.trim() || "(compaction produced no summary)";
      const item = { id: randomId("cmp_", 54), type: "compaction", encrypted_content: encodeCompaction(summary) };
      send({ type: "response.output_item.added", output_index: 0, item: { id: item.id, type: "compaction", encrypted_content: "" } });
      send({ type: "response.output_item.done", output_index: 0, item });
      output.length = 0;
      output.push(item);
    }
    const response = base();
    response.status = "completed";
    response.completed_at = Math.floor(Date.now() / 1000);
    response.output = output;
    response.usage = mapChatUsage(usage);
    if (finishReason === "length") {
      response.status = "incomplete";
      response.incomplete_details = { reason: "max_output_tokens" };
    } else if (finishReason === "content_filter") {
      response.status = "incomplete";
      response.incomplete_details = { reason: "content_filter" };
    }
    send({ type: response.status === "incomplete" ? "response.incomplete" : "response.completed", response });
  };

  const handle = (chunk) => {
    if (failed || done) return;
    const error = chunk?.error ?? (chunk?.object === "error" ? chunk : null);
    if (error) {
      fail(codexErrorFromUpstream(typeof error === "object" ? error : { message: String(error) }));
      return;
    }
    if (chunk?.usage) usage = chunk.usage;
    const choices = Array.isArray(chunk?.choices) ? chunk.choices : [];
    for (const choice of choices) {
      if (Number.isInteger(choice?.index) && choice.index !== 0) continue;
      const delta = choice?.delta || choice?.message || {};
      const thinking = typeof delta.reasoning_content === "string" ? delta.reasoning_content
        : (typeof delta.reasoning === "string" ? delta.reasoning : "");
      if (thinking) appendReasoning(thinking);
      const content = typeof delta.content === "string" ? delta.content
        : (Array.isArray(delta.content) ? delta.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "");
      if (content) routeSplit(splitter.push(content));
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
        routeSplit(splitter.flush());
        closeReasoning();
        closeMessage();
        delta.tool_calls.forEach((fragment, position) => addToolCallFragment(fragment, position));
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  };

  const decoder = new TextDecoder();
  let pending = "";
  let sawDone = false;
  let sawData = false;
  // 少數伺服器即使要求串流仍回一整個 JSON；一個 data 行都沒看到時留著原文，最後整包解析。
  let whole = "";
  const maxWholeBytes = 16 * 1024 * 1024;
  const consume = (block) => {
    for (const data of sseData(block)) {
      sawData = true;
      if (data.trim() === "[DONE]") {
        sawDone = true;
        finish();
        continue;
      }
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      handle(chunk);
    }
  };
  for await (const chunk of upstreamBody) {
    const text = decoder.decode(chunk, { stream: true });
    if (!sawData && whole.length < maxWholeBytes) whole += text;
    pending += text;
    for (;;) {
      const match = /\r?\n\r?\n/.exec(pending);
      if (!match) break;
      const block = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      consume(block);
    }
  }
  const rest = decoder.decode();
  if (!sawData) whole += rest;
  pending += rest;
  if (pending.trim()) consume(pending);
  if (!sawData) {
    let body = null;
    try { body = JSON.parse(whole); } catch { /* 不是 JSON，交給路由器當成截斷處理。 */ }
    if (body && typeof body === "object") {
      handle(body);
      if (Array.isArray(body.choices) && body.choices.length) finish();
    }
    return;
  }
  // 有些伺服器不送 [DONE]；看過 finish_reason 就視為正常結束。兩者都沒有代表串流被截斷，
  // 由路由器補 response.failed。
  if (!sawDone && finishReason) finish();
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
// 路由器依這個標頭決定用哪一家供應商生圖；與 router.mjs 的 PROVIDER_HEADER 相同。
export const PROVIDER_HEADER = "x-codex-router-provider";
const PROVIDER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
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
  fetchImpl = globalThis.fetch, downloadImpl = downloadArkImage, pollIntervalMs = 2000, extraHeaders = {} } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const base = `${new URL(origin).origin}${ARK_IMAGE_PATH}`;
  const headers = { "content-type": "application/json", ...extraHeaders,
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
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
  // 舊版技能沒有記錄供應商：那時只有一家，路由器會用主要供應商。
  const providerId = config.providerId ?? null;
  if (providerId !== null && !(typeof providerId === "string" && PROVIDER_ID_PATTERN.test(providerId))) {
    throw new Error("生圖供應商設定無效，請從路由器選單重新設定中轉 API 生圖。");
  }
  const providerHeaders = providerId ? { [PROVIDER_HEADER]: providerId } : {};
  const apiMode = config.apiMode || "images";
  if (!["images", "ark-task"].includes(apiMode)) throw new Error("生圖介面設定無效，請重新設定中轉生圖。");
  const upstreamModel = config.upstreamModels?.[model] || model;
  if (upstreamModel !== model && !(typeof upstreamModel === "string" && upstreamModel.endsWith(`/${model}`) && !/[\s?#]/.test(upstreamModel))) {
    throw new Error("圖片模型對應無效，請重新設定中轉生圖。");
  }
  if (options.action === "list") return { models: config.models, upstreamModels: config.upstreamModels, apiMode, provider: providerId,
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
      timeoutMs: timeout * 1000, pollIntervalMs, extraHeaders: providerHeaders });
    writeFileSync(out, result.bytes, { mode: 0o600, flag: "wx" });
    return { model, upstreamModel, apiMode, taskId: result.taskId, path: out, bytes: result.bytes.length };
  }
  let body = JSON.stringify(payload);
  const headers = { "content-type": "application/json", ...providerHeaders };
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
__CODEX_MODEL_ROUTER_CLAUDE_CLI_JS__
// Experimental Claude Code transport. The CLI owns authentication; this module
// never reads OAuth credentials. Codex remains the only tool executor.
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

// One TTL for the CLI's own breakpoints and the history breakpoint added below.
// Anthropic rejects a longer TTL after a shorter one, so the two must match.
export const CLI_CACHE_TTL = "1h";
const CACHE_MARKER_COOLDOWN_MS = 30 * 60 * 1000;
let cacheMarkerDisabledUntil = 0;

export function cliCacheMarkerEnabled(now = Date.now()) {
  return now >= cacheMarkerDisabledUntil;
}

export function disableCliCacheMarker(now = Date.now()) {
  cacheMarkerDisabledUntil = now + CACHE_MARKER_COOLDOWN_MS;
}

export function resetCliCacheMarker() {
  cacheMarkerDisabledUntil = 0;
}

// A request rejected for its cache breakpoints is safe to resend without the
// router's marker: the API validates the request before any generation.
export function cacheControlRejected(text) {
  return /cache[_ ]control|prompt[_ ]cach|\bttl\b/i.test(String(text || ""));
}

export function claudeCliEnvironment(source = process.env) {
  const env = { ...source };
  // A subscription route must not silently use an inherited API key, proxy
  // provider, or a different model. HTTP(S)_PROXY is deliberately retained.
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_|CLAUDE_CONFIG_DIR$|CLAUDECODE$|ENABLE_TOOL_SEARCH$|FORCE_PROMPT_CACHING_|ENABLE_PROMPT_CACHING_|DISABLE_PROMPT_CACHING)/.test(key)) delete env[key];
  }
  return { ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
    DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_PROMPT_CACHE_TTL: CLI_CACHE_TTL,
    // Codex Code Mode documents its nested tools in the exec description; the
    // CLI otherwise truncates every MCP tool description at 2,048 characters.
    CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "1048576",
    // Keep every Codex tool directly callable. Deferred MCP tools would need the
    // CLI's own search tool, which this isolated route does not provide.
    ENABLE_TOOL_SEARCH: "false" };
}

const isolationArgs = ["--setting-sources", "", "--settings", '{"disableAllHooks":true}'];

// SDK initialize exposes ModelInfo[] without sending a user/model turn.
// Return only models, never the account metadata also present in this response.
export async function discoverClaudeCliModels(binary, { timeoutMs = 15000, env = claudeCliEnvironment() } = {}) {
  if (!isAbsolute(binary || "")) throw new Error("Claude CLI 路徑必須是絕對路徑。");
  const directory = await mkdtemp(join(tmpdir(), "codex-claude-models-"));
  let child, closedPromise;
  try {
    return await new Promise((resolve, reject) => {
      const id = randomUUID();
      let pending = "", settled = false, killTimer;
      const finish = (error, models) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        if (error) reject(error); else resolve(models);
      };
      child = spawn(binary, ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
        "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--disable-slash-commands", "--no-chrome", ...isolationArgs],
      { cwd: directory, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      closedPromise = new Promise((resolve) => child.once("close", resolve));
      const timer = setTimeout(() => finish(new Error("讀取 Claude CLI 模型清單逾時。")), timeoutMs);
      child.once("error", () => finish(new Error("無法啟動 Claude CLI 模型查詢。")));
      child.once("close", () => {
        if (!settled) finish(new Error("Claude CLI 未回傳模型清單。"));
        clearTimeout(killTimer);
      });
      child.stderr.resume();
      child.stdin.on("error", () => finish(new Error("Claude CLI 模型查詢中斷。")));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        pending += chunk;
        if (pending.length > 4 * 1024 * 1024) return finish(new Error("Claude CLI 模型清單過大。"));
        let newline;
        while (!settled && (newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { finish(new Error("Claude CLI 模型清單格式不相容。")); return; }
          if (message?.type !== "control_response" || message.response?.request_id !== id) continue;
          const models = message.response?.response?.models;
          if (message.response.subtype !== "success" || !Array.isArray(models) || !models.length) {
            finish(new Error("Claude CLI 未提供可用的模型清單。")); return;
          }
          finish(null, models);
        }
      });
      child.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "initialize" } }) + "\n");
    });
  } finally {
    if (closedPromise) await closedPromise;
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

export async function claudeCliAuth(binary, { login = false, signal } = {}) {
  if (!isAbsolute(binary || "")) throw new Error("Claude CLI 路徑必須是絕對路徑。");
  const directory = await mkdtemp(join(tmpdir(), "codex-claude-auth-"));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(binary, ["auth", login ? "login" : "status"], {
        cwd: directory, env: claudeCliEnvironment(), windowsHide: !login,
        ...(signal ? { signal } : {}),
        stdio: login ? "inherit" : ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (chunk) => { if (output.length < 65536) output += chunk; });
      child.stderr?.resume();
      const timer = setTimeout(() => child.kill(), login ? 300000 : 20000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (login) return code === 0 ? resolve({ loggedIn: true }) : reject(new Error("Claude 登入未完成。"));
        try {
          const status = JSON.parse(output);
          resolve({ loggedIn: code === 0 && status.loggedIn === true,
            authMethod: status.authMethod, apiProvider: status.apiProvider });
        } catch { reject(new Error("無法讀取 Claude 登入狀態，請確認 CLI 支援 claude auth status。")); }
      });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// Blocks that accept cache_control. Thinking blocks cannot carry a breakpoint.
const CACHEABLE_BLOCKS = new Set(["text", "image", "document", "tool_use", "tool_result"]);

function cacheMarkerBlock(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (typeof message.content === "string") {
      if (!message.content.trim()) continue;
      message.content = [{ type: "text", text: message.content }];
    }
    const content = Array.isArray(message.content) ? message.content : [];
    for (let position = content.length - 1; position >= 0; position--) {
      const block = content[position];
      if (!CACHEABLE_BLOCKS.has(block?.type)) continue;
      if (block.type === "text" && !(typeof block.text === "string" && block.text.trim())) continue;
      return block;
    }
  }
  return null;
}

export function prepareCliConversation(request, cwd, { cacheTtl = CLI_CACHE_TTL } = {}) {
  const sessionId = randomUUID();
  let parentUuid = null;
  const names = new Map();
  const reverseNames = new Map();
  const tools = (request.tools || []).map((tool, index) => {
    // Use short stable MCP names, independent of namespace/length restrictions.
    const name = `t${index}`;
    names.set(tool.name, `mcp__codex__${name}`);
    reverseNames.set(`mcp__codex__${name}`, tool.name);
    return { name, description: `${tool.name}\n${tool.description || ""}`, inputSchema: tool.input_schema };
  });
  const messages = structuredClone(request.messages || []);
  if (!messages.length || messages.at(-1).role !== "user") throw new Error("Claude CLI 需要以 user 或工具結果結尾的完整歷史。");
  for (const message of messages) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      delete block.cache_control;
      if (block.type === "tool_use") block.name = names.get(block.name) || block.name;
    }
  }
  // Resume sanitizes an unfinished tool_use before reading stdin. Keep paired
  // results IN the transcript, otherwise the CLI drops both the call and result.
  const endsInToolResult = messages.at(-1).content?.some?.((block) => block.type === "tool_result");
  const last = endsInToolResult ? { role: "user", content: [{ type: "text",
    text: "Continue from the tool results above and answer the pending user request." }] } : messages.pop();
  const rows = messages.map((message) => {
    const uuid = randomUUID();
    const row = { type: message.role, uuid, parentUuid, sessionId, cwd, isSidechain: false,
      timestamp: new Date().toISOString(), version: "2.1.231", userType: "external",
      message: { ...message, ...(message.role === "assistant" ? {
        id: `msg_${randomUUID()}`, type: "message", model: request.model,
        stop_reason: message.content?.some?.((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
        stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
      } : {}) } };
    parentUuid = uuid;
    return row;
  });
  // The CLI puts its last breakpoint on an environment block that it appends
  // after this history and rebuilds for every process, so the next turn cannot
  // reuse it. Mark the end of the replayed history instead; the next turn
  // replays the same prefix and reads it from cache.
  const markerBlock = cacheTtl ? cacheMarkerBlock(rows.map((row) => row.message)) : null;
  const plainTranscript = rows.map((row) => JSON.stringify(row)).join("\n");
  if (markerBlock) markerBlock.cache_control = { type: "ephemeral", ttl: cacheTtl };
  const transcript = markerBlock ? rows.map((row) => JSON.stringify(row)).join("\n") : plainTranscript;
  const system = typeof request.system === "string" ? request.system
    : (request.system || []).map((block) => block.text || "").join("\n\n");
  // The CLI has no native tool_choice option. Keep the same definitions during
  // replay, including when tools are forbidden, so previous calls remain known.
  // Enforce the choice on output before forwarding any disallowed tool to Codex.
  // The instruction belongs to this turn only; placing it in the system prompt
  // would invalidate the cached tools/system/history prefix.
  const choice = request.tool_choice?.type;
  const constraint = choice === "none" ? "For this response, do not call any tools. Respond using the conversation and tool results already provided."
    : choice === "tool" ? `For this response, call only the tool ${names.get(request.tool_choice.name)}.`
    : choice === "any" ? "For this response, call at least one of the provided tools." : "";
  if (constraint) {
    const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : (last.content || []);
    last.content = [...content, { type: "text", text: constraint }];
  }
  return { tools, reverseNames, transcript, plainTranscript, cacheMarker: Boolean(markerBlock), system,
    input: JSON.stringify({ type: "user", session_id: sessionId, parent_tool_use_id: null, message: last }) + "\n" };
}

// Only tool schemas are exposed. Even if Claude calls this endpoint before it
// is stopped, it cannot execute anything or manufacture a successful result.
export async function startCliToolServer(tools) {
  const token = randomBytes(32).toString("hex");
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` || req.url !== "/mcp") {
      res.writeHead(403); res.end(); return;
    }
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8 * 1024 * 1024) { res.writeHead(413); res.end(); return; }
      }
      const message = JSON.parse(body);
      if (message.id == null) { res.writeHead(202); res.end(); return; }
      let result;
      if (message.method === "initialize") result = { protocolVersion: "2024-11-05",
        capabilities: { tools: {} }, serverInfo: { name: "codex-router", version: "1" } };
      else if (message.method === "tools/list") result = { tools };
      else if (message.method === "ping") result = {};
      else if (message.method === "tools/call") result = { isError: true,
        content: [{ type: "text", text: "Tool execution belongs to Codex. No action was performed." }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(result ? { result }
        : { error: { code: -32601, message: "Method not found" } }) }));
    } catch { res.writeHead(400); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { config: { mcpServers: { codex: { type: "http", url: `http://127.0.0.1:${server.address().port}/mcp`,
    headers: { Authorization: `Bearer ${token}` } } } },
  close: () => { server.closeAllConnections(); server.close(); } };
}

export function requiredCliVersion(record) {
  const content = record?.message?.content;
  const text = Array.isArray(content) ? content.filter((block) => block?.type === "text").map((block) => block.text).join("\n")
    : typeof content === "string" ? content : "";
  return /Claude Code[\s\S]*?version (\d+\.\d+\.\d+) or newer is required/i.exec(text)?.[1] || null;
}

export function cliFailure(code, requiredVersion = null) {
  const messages = {
    authentication_failed: "Claude CLI 尚未登入或授權已過期，請從「連接 Claude 訂閱帳號」重新登入。",
    rate_limit: "Claude 訂閱用量已達上限，請等待重置或切換其他模型。",
    timeout: "Claude CLI 等待逾時，請重試或檢查 Claude 登入與網路。",
    invalid_tool: "Claude CLI 傳回未註冊的工具，已停止此回合。",
    protocol: "Claude CLI 回應格式不相容或回應中斷，請檢查 CLI 版本。",
    unavailable: "無法啟動 Claude CLI，請重新設定 CLI 路徑。",
    tool_choice: "Claude CLI 未遵守本次工具選擇限制，已停止此回合。",
    context_length_exceeded: "Claude CLI 上下文已超過模型限制，請壓縮對話或調低模型的上下文設定。",
    upgrade_required: `這個模型需要較新版本的 Claude CLI${requiredVersion ? `（至少 ${requiredVersion}）` : ""}，請執行 claude update 或重新執行添加流程。`,
  };
  return { type: "error", error: { type: `claude_cli_${code}`, message: messages[code] || messages.protocol,
    ...(requiredVersion ? { requiredVersion } : {}),
    ...(code === "rate_limit" ? { code: "rate_limit_exceeded" } : {}) } };
}

// One fresh CLI invocation per Responses request. Replaying a private transcript
// preserves roles, signed thinking, tool IDs/results and images, without sharing
// mutable CLI sessions between threads, retries, or model switches.
export async function fetchClaudeCli(request, configuration, signal, { env: testEnv, onDiagnostic } = {}) {
  if (!isAbsolute(configuration?.binary || "")) return Response.json(cliFailure("unavailable"), { status: 503 });
  signal?.throwIfAborted();
  if (!testEnv) {
    let auth;
    try { auth = await claudeCliAuth(configuration.binary, { signal }); }
    catch { signal?.throwIfAborted(); return Response.json(cliFailure("unavailable"), { status: 503 }); }
    if (!auth.loggedIn || auth.authMethod !== "claude.ai") {
      return Response.json(cliFailure("authentication_failed"), { status: 401 });
    }
    signal?.throwIfAborted();
  }
  const directory = await mkdtemp(join(tmpdir(), "codex-claude-turn-"));
  let mcp, child = null, timer, terminal = false, streamController;
  let cleanupPromise;
  const processes = new Set();
  // Resolves after the process exits; escalates if it ignores the first signal.
  const terminate = (proc) => proc.routerClosed ? Promise.resolve() : new Promise((resolve) => {
    const killTimer = setTimeout(() => proc.kill("SIGKILL"), 1500);
    proc.once("close", () => { clearTimeout(killTimer); resolve(); });
    proc.kill();
  });
  const cleanup = () => cleanupPromise ||= (async () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    mcp?.close();
    await Promise.all([...processes].map(terminate));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  })();
  const send = (event) => streamController.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
  const finish = (failure, requiredVersion = null) => {
    if (terminal) return;
    terminal = true;
    if (failure) send(cliFailure(failure, requiredVersion));
    streamController.close();
    void cleanup().catch(() => process.stderr.write("model-router-claude-cli-cleanup-failed\n"));
  };
  const abort = () => finish("protocol");
  try {
    const conversation = prepareCliConversation(request, directory,
      { cacheTtl: cliCacheMarkerEnabled() ? CLI_CACHE_TTL : null });
    await writeFile(join(directory, "system.txt"), conversation.system, { mode: 0o600 });
    const historyPath = join(directory, "history.jsonl");
    if (conversation.transcript) await writeFile(historyPath, conversation.transcript + "\n", { mode: 0o600 });
    mcp = await startCliToolServer(conversation.tools);
    await writeFile(join(directory, "mcp.json"), JSON.stringify(mcp.config), { mode: 0o600 });
    const baseArgs = ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
      "--include-partial-messages", "--no-session-persistence", "--tools", "", "--strict-mcp-config",
      "--mcp-config", join(directory, "mcp.json"), "--disable-slash-commands", "--no-chrome",
      "--permission-mode", "dontAsk", "--max-turns", "1", ...isolationArgs,
      // Claude 5 系列預設不回傳思考文字（display: omitted）。要求摘要後 Codex 才能顯示
      // 思考過程；計費不變。這個參數不在 --help 中，2.1.231 起可用，且只附加在
      // adaptive／enabled 思考設定上，不會與關閉思考同時送出。
      "--thinking-display", "summarized",
      "--system-prompt-file", join(directory, "system.txt"), "--model", request.model];
    const stream = new ReadableStream({ start(controller) { streamController = controller; },
      cancel() { terminal = true; return cleanup(); } });
    const env = testEnv || { ...claudeCliEnvironment(), CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.max_tokens || 32000) };
    let started = false, stopReason = null, toolCount = 0, cacheRetried = false;
    const launch = (history) => {
      const args = [...baseArgs];
      if (history) args.push("--resume", history, "--fork-session");
      if (configuration.effort) args.push("--effort", configuration.effort);
      const proc = spawn(configuration.binary, args, { cwd: directory, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env });
      processes.add(proc);
      child = proc;
      let pending = "";
      proc.stderr.resume(); // Never log CLI stderr: it can contain prompts or credentials.
      proc.stdin.on("error", () => { if (proc === child && !terminal) finish("protocol"); });
      proc.on("error", () => { if (proc === child) finish("unavailable"); });
      proc.on("close", () => { proc.routerClosed = true; if (proc === child && !terminal) finish("protocol"); });
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        if (terminal || proc !== child) return;
        pending += chunk.toString("utf8");
        if (pending.length > 16 * 1024 * 1024) { finish("protocol"); return; }
        let newline;
        while (!terminal && proc === child && (newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          let record;
          try { record = JSON.parse(line); } catch { finish("protocol"); return; }
          if (!record || typeof record.type !== "string") { finish("protocol"); return; }
          onDiagnostic?.({ type: record.type, event: record.event?.type, stop: record.event?.delta?.stop_reason,
            block: record.event?.content_block?.type, error: record.error, subtype: record.subtype,
            model: record.event?.message?.model, assistantStop: record.message?.stop_reason,
            ...(record.message?.stop_reason === "refusal" ? { refusal: record.message.content?.filter((block) => block.type === "text")
              .map((block) => block.text).join("\n").slice(0, 1000) } : {}) });
          if (record.type === "assistant" && record.error) {
            const requiredVersion = requiredCliVersion(record);
            if (requiredVersion) { finish("upgrade_required", requiredVersion); return; }
            if (record.message?.stop_reason === "refusal") {
              if (!started) send({ type: "message_start", message: { usage: {} } });
              send({ type: "message_delta", delta: { stop_reason: "refusal" }, stop_details: record.message.stop_details });
              send({ type: "message_stop" });
              finish(); return;
            }
            const detail = JSON.stringify(record.message?.content || "");
            if (conversation.cacheMarker && !cacheRetried && !started && cacheControlRejected(detail)) {
              // An older CLI may ignore the TTL setting, or a newer one may already
              // use every breakpoint. Nothing reached Codex yet: resend once without
              // the router's breakpoint and pause it for later turns.
              cacheRetried = true;
              disableCliCacheMarker();
              onDiagnostic?.({ type: "cache_marker_fallback" });
              child = null;
              void terminate(proc);
              void relaunchWithoutMarker();
              return;
            }
            finish(record.error === "authentication_failed" ? "authentication_failed"
              : record.error === "rate_limit" ? "rate_limit"
              : /context.*(?:length|window)|prompt is too long/i.test(detail) ? "context_length_exceeded" : "protocol"); return;
          }
          if (record.type === "result") { finish("protocol"); return; }
          if (record.type !== "stream_event" || record.parent_tool_use_id) continue;
          const event = record.event;
          if (!event || typeof event.type !== "string") { finish("protocol"); return; }
          if (event.type === "message_start") {
            if (started) { finish("protocol"); return; }
            started = true;
          }
          if (!started) { finish("protocol"); return; }
          if (event.type === "message_delta" && event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          if (event.type === "message_stop" && !stopReason) { finish("protocol"); return; }
          if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
            const name = conversation.reverseNames.get(event.content_block.name);
            if (!name) { finish("invalid_tool"); return; }
            toolCount++;
            if (request.tool_choice?.type === "none" || (request.tool_choice?.type === "tool" && name !== request.tool_choice.name)
              || (request.tool_choice?.disable_parallel_tool_use && toolCount > 1)) { finish("tool_choice"); return; }
            event.content_block.name = name;
          }
          if (event.type === "message_stop" && ["any", "tool"].includes(request.tool_choice?.type) && !toolCount) {
            finish("tool_choice"); return;
          }
          send(event);
          if (event.type === "message_stop") finish();
        }
      });
      if (!terminal) proc.stdin.end(conversation.input);
    };
    const relaunchWithoutMarker = async () => {
      try {
        const plainPath = join(directory, "history-plain.jsonl");
        await writeFile(plainPath, conversation.plainTranscript + "\n", { mode: 0o600 });
        if (!terminal) launch(plainPath);
      } catch { finish("protocol"); }
    };
    timer = setTimeout(() => finish("timeout"), configuration.timeoutMs || 180000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (!terminal) launch(conversation.transcript ? historyPath : null);
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  } catch (error) { await cleanup(); throw error; }
}
__CODEX_MODEL_ROUTER_MANAGER_JS__
// 網頁管理介面的伺服器端：本機 HTTP、存取權杖、背景工作與輸出擷取。
//
// 這裡只負責「網頁這一層」。讀設定、探測模型、寫檔與重啟都由安裝器以 ops 物件傳入，
// 終端選單與網頁走同一套實作，不會出現兩邊行為不一致。
//
// 路由器本身拒絕一切瀏覽器請求；管理頁必須服務瀏覽器，因此另外把關：
//   1. 只聽 127.0.0.1，Host 必須是本機名稱加上本頁的埠，擋 DNS rebinding。
//   2. /api/* 一律要求存取權杖標頭。其他網頁讀不到權杖，也帶不了自訂標頭
//      （會觸發 CORS 預檢，而這裡從不回 CORS 標頭）。
//   3. 帶 Origin 的請求必須來自本頁；POST 只收 application/json。
//   4. 頁面送 CSP（腳本與樣式只認本次回應的 nonce）、no-referrer 與禁止嵌入，
//      網址片段裡的權杖不會隨外部連結送出。

import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export const TOKEN_HEADER = "x-router-manager-token";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_JOB_OUTPUT = 512 * 1024;
const KEEP_FINISHED_JOBS = 20;
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function createToken() {
  return randomBytes(24).toString("base64url");
}

export function stripAnsi(text) {
  return String(text ?? "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function backgroundCommand(command, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("外部程式執行逾時。")); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-16384); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16384); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

// 必須在獨立的程序內執行：關閉桌面版時，由它啟動的工具程序也可能一起被結束。
// open 成功還不代表應用程式已啟動，最後再確認程序真的存在。
export async function restartDesktopProcess(app, {
  run = backgroundCommand, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(), timeoutMs = 30000, report = () => {},
} = {}) {
  if (!app || typeof app.path !== "string" || !/^[A-Za-z0-9.-]{3,200}$/.test(app.bundleId)) {
    throw new Error("桌面版應用程式資料無效。");
  }
  // App 關閉後，僅以 bundle ID 查詢有時會失去 LaunchServices 的解析；固定實際路徑。
  const application = `application ${JSON.stringify(app.path)}`;
  const running = async () => {
    const result = await run("/usr/bin/osascript", ["-e", `${application} is running`], 10000);
    if (result.status !== 0 || !["true", "false"].includes(result.stdout.trim())) {
      throw new Error(`無法確認 ${app.name} 是否正在執行（${stripAnsi(result.stderr).slice(0, 200) || "未知錯誤"}）。`);
    }
    return result.stdout.trim() === "true";
  };
  if (await running()) {
    report(`正在正常結束 ${app.name}；若 macOS 詢問控制權限，請選擇允許。`);
    const quit = await run("/usr/bin/osascript", ["-e", "with timeout of 30 seconds",
      "-e", `tell ${application} to quit`, "-e", "end timeout"], 45000);
    if (quit.status !== 0) throw new Error(`無法結束 ${app.name}（${stripAnsi(quit.stderr).slice(0, 200) || "未知錯誤"}）。請手動重新開啟。`);
    const deadline = now() + timeoutMs;
    while (await running()) {
      if (now() >= deadline) throw new Error(`${app.name} 沒有正常結束，可能正在等待確認。請手動重新開啟。`);
      await wait(250);
    }
    await wait(1000);
  }
  report(`正在重新開啟 ${app.name}…`);
  const opened = await run("/usr/bin/open", [app.path], 30000);
  if (opened.status !== 0) throw new Error(`無法重新開啟 ${app.name}（${stripAnsi(opened.stderr).slice(0, 200) || "未知錯誤"}）。請手動打開。`);
  const deadline = now() + timeoutMs;
  while (!await running()) {
    if (now() >= deadline) throw new Error(`${app.name} 未在預期時間內啟動，請手動打開。`);
    await wait(250);
  }
  report(`已確認 ${app.name} 重新啟動。`);
  return { restarted: app.name };
}

// 這段模組會由安裝器另存為短期 worker。macOS 由 launchd 啟動，Windows／測試用 detached
// 子程序；不依賴原本的桌面版、終端或瀏覽器。只記錄輸出和結果，不接受網路請求。
export async function runBackgroundTask(specPath) {
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const messages = [];
  const report = (status, extra = {}) => {
    if (extra.message) messages.push(extra.message);
    const temporary = `${spec.statusPath}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify({ status, pid: process.pid, ...extra, messages: messages.slice(-20) }), { mode: 0o600 });
    renameSync(temporary, spec.statusPath);
    chmodSync(spec.statusPath, 0o600);
  };
  try {
    report("ready");
    let result;
    if (spec.kind === "desktop") {
      result = await restartDesktopProcess(spec.app, { report: (message) => { console.log(message); report("running", { message }); } });
    } else if (spec.kind === "manager") {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(spec.command, spec.args, { env: spec.environment, stdio: "inherit", windowsHide: true });
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      if (code !== 0) throw new Error(`管理程序結束代碼：${code}`);
      result = { code };
    } else {
      throw new Error("未知的背景工作。");
    }
    report("succeeded", { result });
  } catch (error) {
    report("failed", { error: messageOf(error) });
    console.error(messageOf(error));
    process.exitCode = 1;
  } finally {
    // 結果留給管理頁讀取；程式與含存取權杖的啟動參數在工作結束後立即刪除。
    rmSync(specPath, { force: true });
    rmSync(spec.workerPath, { force: true });
    if (spec.kind === "manager" && process.exitCode !== 1) rmSync(spec.statusPath, { force: true });
    if (spec.launchLabel) spawnSync("/bin/launchctl", ["remove", spec.launchLabel], { stdio: "ignore", timeout: 5000 });
  }
}

// 瀏覽器對非 80 埠一定會在 Host 帶上埠號；不帶或埠號不符都拒絕。
export function isAllowedHost(value, port) {
  if (typeof value !== "string" || !Number.isInteger(port)) return false;
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(value.trim());
  if (!match) return false;
  return LOOPBACK_NAMES.has(match[1].toLowerCase().replace(/\.$/, "")) && Number(match[2]) === port;
}

// 同源的 GET 不帶 Origin；帶了就必須是本頁。"null"（沙箱、檔案頁）一律拒絕。
export function isAllowedOrigin(value, port) {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && LOOPBACK_NAMES.has(url.hostname.toLowerCase()) && Number(url.port) === port;
  } catch {
    return false;
  }
}

export function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !expected) return false;
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// 背景工作：同一時間只跑一項會改設定的操作。輸出由 installOutputCapture 依
// AsyncLocalStorage 歸到對應的工作，網頁以 offset 輪詢增量內容。
export function createJobRunner({ maxOutput = MAX_JOB_OUTPUT, keep = KEEP_FINISHED_JOBS, now = () => Date.now(), onFinished = () => {} } = {}) {
  const jobs = new Map();
  const storage = new AsyncLocalStorage();
  let active = null;
  let counter = 0;

  const prune = () => {
    const finished = [...jobs.values()].filter((job) => job.status !== "running");
    for (const job of finished.slice(0, Math.max(0, finished.length - keep))) jobs.delete(job.id);
  };

  const execute = (job, run) => {
    if (active) throw httpError(409, `「${active.title}」正在進行中，請等它完成。`);
    active = job;
    job.status = "running";
    job.finishedAt = null;
    storage.run(job, () => {
      Promise.resolve().then(() => run(job)).then(
        (result) => { job.result = result ?? null; job.status = "succeeded"; },
        (error) => {
          job.error = messageOf(error);
          job.status = "failed";
          console.error(`\n錯誤：${job.error}`);
        },
      ).finally(async () => {
        job.finishedAt = new Date(now()).toISOString();
        if (active === job) active = null;
        try { await onFinished(job); } catch (error) { console.error(messageOf(error)); }
      });
    });
    return job;
  };

  const runner = {
    storage,
    active: () => active,
    get: (id) => jobs.get(id) || null,
    append(job, text) {
      if (!job || text == null || text === "") return;
      job.output += stripAnsi(text).replace(/\r(?!\n)/g, "\n");
      if (job.output.length > maxOutput) {
        const drop = job.output.length - maxOutput;
        job.output = job.output.slice(drop);
        job.base += drop;
      }
    },
    start(type, title, run) {
      if (active) throw httpError(409, `「${active.title}」正在進行中，請等它完成。`);
      counter += 1;
      const job = {
        id: `${now().toString(36)}-${counter}-${randomBytes(3).toString("hex")}`,
        type, title, status: "running", output: "", base: 0,
        result: null, error: null, startedAt: new Date(now()).toISOString(), finishedAt: null,
      };
      jobs.set(job.id, job);
      prune();
      return execute(job, run);
    },
    // 更新交接只恢復已完成的工作；不保存請求參數或 API Key。
    restore(snapshot) {
      if (!snapshot || !/^[A-Za-z0-9-]{1,64}$/.test(snapshot.id) || !["succeeded", "failed"].includes(snapshot.status)
        || typeof snapshot.output !== "string" || typeof snapshot.type !== "string" || typeof snapshot.title !== "string") {
        throw new Error("管理頁的工作交接記錄無效。");
      }
      const job = { ...snapshot, output: snapshot.output.slice(-maxOutput) };
      job.base = Math.max(0, (Number(snapshot.offset) || 0) - job.output.length);
      jobs.set(job.id, job);
      prune();
      return job;
    },
    resume(job, run) {
      if (jobs.get(job.id) !== job) throw new Error("找不到要繼續的工作。");
      return execute(job, run);
    },
    view(job, offset = 0) {
      const start = Math.max(0, Math.min(job.output.length, Number(offset) - job.base));
      return {
        id: job.id, type: job.type, title: job.title, status: job.status,
        output: job.output.slice(start), offset: job.base + job.output.length,
        result: job.result, error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt,
      };
    },
  };
  return runner;
}

// 工作期間的終端輸出（console.log、探測進度、子行程輸出）同時寫進該工作的記錄。
// 終端照常顯示，網頁看到的是同一份內容。
export function installOutputCapture(runner, streams = [process.stdout, process.stderr]) {
  const originals = streams.map((stream) => {
    const write = stream.write;
    stream.write = function captureWrite(chunk, encoding, callback) {
      const job = runner.storage.getStore();
      if (job) {
        const text = typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString(typeof encoding === "string" ? encoding : "utf8");
        runner.append(job, text);
      }
      return write.call(this, chunk, encoding, callback);
    };
    return [stream, write];
  });
  return () => {
    for (const [stream, write] of originals) stream.write = write;
  };
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function sendJson(response, status, payload) {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(payload));
}

export function pageWithNonce(html, nonce) {
  return String(html).replace(/<(script|style)(?=[\s>])/g, `<$1 nonce="${nonce}"`);
}

function sendPage(response, html, headOnly = false) {
  const nonce = randomBytes(16).toString("base64");
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "img-src data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
  });
  response.end(headOnly ? undefined : pageWithNonce(html, nonce));
}

async function readJson(request) {
  const type = String(request.headers["content-type"] || "").toLowerCase();
  if (!type.startsWith("application/json")) throw httpError(415, "請求必須是 JSON。");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, "請求內容過大。");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "請求不是有效的 JSON。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, "請求格式無效。");
  return value;
}

// ops：state、version、errors、discover、providerDraft、queries（唯讀查詢，{ type: run }）
// 與 jobs（會改設定的背景工作，{ type: { title, run } }）。
// restartBlocked() 回傳字串時拒絕重新啟動管理頁，回傳 null 才呼叫 onRestart。
export function createManagerServer({
  html, token, version, ops, jobs, instanceId = createToken(),
  onActivity = () => {}, onShutdown = () => {}, onRestart = null, restartBlocked = () => null,
}) {
  if (!html || !token || !ops || !jobs) throw new Error("createManagerServer 缺少必要參數。");
  let port = null;
  const activeSummary = () => {
    const job = jobs.active();
    return job ? { id: job.id, type: job.type, title: job.title } : null;
  };

  async function handle(request, response) {
    if (!isAllowedHost(request.headers.host, port)) {
      sendJson(response, 403, { error: "只接受以 127.0.0.1 或 localhost 開啟的管理頁。" });
      return;
    }
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    const { pathname } = url;
    const method = request.method;
    if (pathname === "/" || pathname === "/index.html") {
      if (method !== "GET" && method !== "HEAD") {
        sendJson(response, 405, { error: "不支援的方法。" });
        return;
      }
      sendPage(response, html, method === "HEAD");
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (!pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "找不到這個頁面。" });
      return;
    }
    if (!isAllowedOrigin(request.headers.origin, port)) {
      sendJson(response, 403, { error: "拒絕來自其他網站的請求。" });
      return;
    }
    if (!tokenMatches(request.headers[TOKEN_HEADER], token)) {
      sendJson(response, 401, { error: "存取權杖無效：請從終端機顯示的網址重新開啟管理頁。" });
      return;
    }
    if (method !== "GET" && method !== "POST") {
      sendJson(response, 405, { error: "不支援的方法。" });
      return;
    }
    onActivity();
    response.setHeader("x-router-manager-instance", instanceId);
    const body = method === "POST" ? await readJson(request) : null;
    const route = `${method} ${pathname}`;

    if (route === "GET /api/state") {
      sendJson(response, 200, { ...(await ops.state()), manager: { version, instanceId, activeJob: activeSummary() } });
      return;
    }
    if (route === "GET /api/version") {
      sendJson(response, 200, await ops.version({ refresh: url.searchParams.get("refresh") === "1" }));
      return;
    }
    if (route === "GET /api/errors") {
      sendJson(response, 200, await ops.errors());
      return;
    }
    if (route === "POST /api/ping") {
      sendJson(response, 200, { ok: true, version, instanceId, activeJob: activeSummary() });
      return;
    }
    if (route === "POST /api/discover") {
      sendJson(response, 200, await ops.discover(body));
      return;
    }
    if (route === "POST /api/provider-draft") {
      sendJson(response, 200, await ops.providerDraft(body));
      return;
    }
    if (route === "POST /api/query") {
      const run = typeof body.type === "string" && ops.queries && Object.hasOwn(ops.queries, body.type) ? ops.queries[body.type] : null;
      if (!run) {
        sendJson(response, 400, { error: "不支援的查詢。" });
        return;
      }
      const params = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : {};
      sendJson(response, 200, await run(params));
      return;
    }
    if (route === "POST /api/jobs") {
      const spec = typeof body.type === "string" && Object.hasOwn(ops.jobs, body.type) ? ops.jobs[body.type] : null;
      if (!spec) {
        sendJson(response, 400, { error: "不支援的操作。" });
        return;
      }
      const params = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : {};
      const job = jobs.start(body.type, spec.title, () => spec.run(params));
      sendJson(response, 202, jobs.view(job, 0));
      return;
    }
    const jobMatch = /^\/api\/jobs\/([A-Za-z0-9-]{1,64})$/.exec(pathname);
    if (method === "GET" && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) {
        sendJson(response, 404, { error: "找不到這項操作，管理頁可能已重新啟動。" });
        return;
      }
      sendJson(response, 200, jobs.view(job, Number(url.searchParams.get("offset")) || 0));
      return;
    }
    if (route === "POST /api/restart" || route === "POST /api/shutdown") {
      if (jobs.active()) {
        sendJson(response, 409, { error: "還有操作正在進行，請等它完成。" });
        return;
      }
      const restart = route === "POST /api/restart";
      const blocked = restart ? (onRestart ? restartBlocked() : "目前無法重新啟動管理頁。") : null;
      if (blocked) {
        sendJson(response, 400, { error: blocked });
        return;
      }
      sendJson(response, 202, { ok: true });
      setImmediate(() => (restart ? onRestart() : onShutdown()));
      return;
    }
    sendJson(response, 404, { error: "找不到這個 API。" });
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      // 安裝器以 fail() 丟出的是給使用者看的錯誤（名稱無效、探測未通過）；程式錯誤才算 500。
      const programming = error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError;
      const status = Number.isInteger(error?.status) ? error.status : programming ? 500 : 400;
      if (!response.headersSent) sendJson(response, status, { error: messageOf(error) });
      else response.end();
    });
  });
  server.on("listening", () => {
    port = server.address().port;
  });
  return server;
}
__CODEX_MODEL_ROUTER_MANAGER_HTML__
<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Codex 模型路由器</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Crect width='48' height='48' rx='12' fill='%230f172a'/%3E%3Cpath d='M11 16h8c4 0 6 2 8 5l2 3c1.5 2.3 3 3.5 6 3.5h2' stroke='%2338bdf8' stroke-width='4.5' fill='none' stroke-linecap='round'/%3E%3Cpath d='M11 32h8c3 0 5-1.5 6.5-3.5' stroke='%233b82f6' stroke-width='4.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E">
<style>
:root {
  color-scheme: dark;
  --bg: #0b1120;
  --panel: #111a2e;
  --panel-2: #0f172a;
  --panel-3: #16203a;
  --border: #1e293b;
  --border-strong: #2a3a55;
  --text: #e2e8f0;
  --muted: #94a3b8;
  --faint: #64748b;
  --accent: #38bdf8;
  --accent-2: #3b82f6;
  --ok: #22c55e;
  --warn: #f59e0b;
  --danger: #f43f5e;
  --radius: 12px;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Microsoft JhengHei UI", "Microsoft JhengHei", "Noto Sans TC", system-ui, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--text); font: 14px/1.55 var(--sans); -webkit-font-smoothing: antialiased; }
a { color: var(--accent); }
button { font: inherit; color: inherit; }
.app { display: flex; min-height: 100vh; }

.sidebar { width: 252px; flex: none; background: var(--panel-2); border-right: 1px solid var(--border); display: flex; flex-direction: column; position: sticky; top: 0; height: 100vh; }
.brand { display: flex; gap: 12px; align-items: center; padding: 20px 18px 18px; border-bottom: 1px solid var(--border); }
.logo { width: 46px; height: 46px; flex: none; border-radius: 13px; display: grid; place-items: center; background: linear-gradient(150deg, #1c2a45, #0b1120); box-shadow: inset 0 0 0 1px #26365a, 0 6px 18px rgba(14, 165, 233, .12); }
.brand-name { font-weight: 700; font-size: 16px; letter-spacing: .2px; white-space: nowrap; }
.version-badge { margin-top: 5px; display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 8px; background: #1e293b; color: var(--muted); border: 1px solid transparent; font: 12.5px/1.7 var(--mono); cursor: pointer; }
.version-badge:hover { color: var(--text); border-color: var(--border-strong); }
.version-badge.has-update { background: rgba(245, 158, 11, .14); color: #fde68a; }
.version-badge .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); box-shadow: 0 0 0 3px rgba(245, 158, 11, .18); }
.nav { padding: 14px 12px; display: flex; flex-direction: column; gap: 4px; }
.nav-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; color: var(--muted); background: none; border: 0; cursor: pointer; text-align: left; font-size: 14.5px; }
.nav-item:hover { background: #142036; color: var(--text); }
.nav-item.active { background: #172544; color: var(--text); box-shadow: inset 2px 0 0 var(--accent); }
.nav-item svg { width: 19px; height: 19px; flex: none; }
.nav-count { margin-left: auto; font-size: 12px; color: var(--faint); }
.sidebar-footer { margin-top: auto; padding: 14px 16px 16px; border-top: 1px solid var(--border); display: grid; gap: 10px; font-size: 12.5px; color: var(--muted); }
.router-status { display: flex; align-items: center; gap: 8px; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--faint); }
.status-dot.ok { background: var(--ok); box-shadow: 0 0 0 3px rgba(34, 197, 94, .16); }
.status-dot.bad { background: var(--danger); box-shadow: 0 0 0 3px rgba(244, 63, 94, .16); }
.link-button { background: none; border: 0; padding: 0; color: var(--faint); cursor: pointer; text-align: left; font-size: 12.5px; }
.link-button:hover { color: var(--text); }

.main { flex: 1; min-width: 0; padding: 28px 34px 56px; max-width: 1280px; }
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
.page-head h1 { margin: 0; font-size: 22px; letter-spacing: .3px; }
.page-head p { margin: 4px 0 0; color: var(--muted); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

.button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 8px 14px; border-radius: 10px; border: 1px solid var(--border-strong); background: #152038; font-weight: 500; cursor: pointer; white-space: nowrap; }
.button svg { width: 16px; height: 16px; }
.button:hover:not(:disabled) { background: #1a2847; }
.button:disabled { opacity: .45; cursor: not-allowed; }
.button.primary { background: linear-gradient(135deg, #06b6d4, #3b82f6); border-color: transparent; color: #fff; }
.button.primary:hover:not(:disabled) { filter: brightness(1.08); background: linear-gradient(135deg, #06b6d4, #3b82f6); }
.button.danger { background: rgba(244, 63, 94, .12); border-color: rgba(244, 63, 94, .42); color: #fecdd3; }
.button.danger:hover:not(:disabled) { background: rgba(244, 63, 94, .2); }
.button.small { padding: 5px 10px; font-size: 12.5px; border-radius: 8px; }
.icon-button { width: 30px; height: 30px; display: inline-grid; place-items: center; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--muted); cursor: pointer; padding: 0; }
.icon-button svg { width: 17px; height: 17px; }
.icon-button:hover:not(:disabled) { background: #1a2847; color: var(--text); }
.icon-button:disabled { opacity: .28; cursor: default; }
.icon-button.spin svg { animation: spin .8s linear infinite; }

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; margin-bottom: 18px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; min-width: 0; }
.card-label { color: var(--muted); font-size: 12.5px; }
.card-value { font-size: 24px; font-weight: 700; margin-top: 4px; display: flex; align-items: center; gap: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-sub { color: var(--faint); font-size: 12.5px; margin-top: 3px; overflow-wrap: anywhere; }

.panel { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 18px; overflow: hidden; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 18px; border-bottom: 1px solid var(--border); }
.panel-head h2 { margin: 0; font-size: 15px; }
.panel-body { padding: 16px 18px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
th { color: var(--muted); font-weight: 500; font-size: 12.5px; background: #0f1830; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: #121d35; }
td.tight, th.tight { width: 1%; white-space: nowrap; }
.mono { font-family: var(--mono); font-size: 12.5px; }
.muted { color: var(--muted); }
.faint { color: var(--faint); }
.nowrap { white-space: nowrap; }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 999px; font-size: 12px; line-height: 1.7; background: #1b2742; color: #cbd5e1; border: 1px solid #24324d; white-space: nowrap; }
.chip.cyan { background: rgba(56, 189, 248, .12); border-color: rgba(56, 189, 248, .32); color: #bae6fd; }
.chip.violet { background: rgba(167, 139, 250, .12); border-color: rgba(167, 139, 250, .32); color: #ddd6fe; }
.chip.amber { background: rgba(245, 158, 11, .12); border-color: rgba(245, 158, 11, .32); color: #fde68a; }
.chip.green { background: rgba(34, 197, 94, .12); border-color: rgba(34, 197, 94, .32); color: #bbf7d0; }
.chip.rose { background: rgba(244, 63, 94, .12); border-color: rgba(244, 63, 94, .32); color: #fecdd3; }

.banner { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 10px; margin-bottom: 16px; border: 1px solid; font-size: 13.5px; }
.banner svg { width: 18px; height: 18px; flex: none; }
.banner .grow { flex: 1; min-width: 0; }
.banner.info { background: rgba(56, 189, 248, .08); border-color: rgba(56, 189, 248, .3); color: #bae6fd; }
.banner.warn { background: rgba(245, 158, 11, .08); border-color: rgba(245, 158, 11, .35); color: #fde68a; }
.banner.error { background: rgba(244, 63, 94, .08); border-color: rgba(244, 63, 94, .35); color: #fecdd3; }
.banner.success { background: rgba(34, 197, 94, .08); border-color: rgba(34, 197, 94, .32); color: #bbf7d0; }
.kv { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 9px 16px; margin: 0; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; word-break: break-all; }
.empty { padding: 30px 20px; text-align: center; color: var(--muted); }
.notes { display: grid; gap: 6px; margin: -4px 0 14px; }
.note { color: var(--muted); font-size: 12.5px; }
.note.warn { color: #fde68a; }

.model-name { font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.model-sub { color: var(--faint); font: 12px/1.5 var(--mono); margin-top: 2px; word-break: break-all; }
.drag-handle { cursor: grab; color: var(--faint); display: inline-grid; place-items: center; width: 26px; height: 30px; border-radius: 6px; touch-action: none; user-select: none; -webkit-user-select: none; }
.drag-handle:hover { color: var(--text); background: #1a2847; }
.drag-handle.disabled { cursor: default; opacity: .35; }
.drag-handle.disabled:hover { background: none; color: var(--faint); }
.drag-handle svg { width: 16px; height: 16px; }
body.dragging-row, body.dragging-row * { cursor: grabbing !important; user-select: none !important; -webkit-user-select: none !important; }
tr.dragging td { opacity: .35; }
tr.drop-before td { box-shadow: inset 0 2px 0 var(--accent); }
tr.drop-after td { box-shadow: inset 0 -2px 0 var(--accent); }
.row-actions { display: flex; gap: 2px; justify-content: flex-end; }
input[type=checkbox] { width: 16px; height: 16px; accent-color: #22d3ee; cursor: pointer; vertical-align: middle; }

.provider-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; }
.provider-card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); display: flex; flex-direction: column; }
.provider-card .head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.provider-card .head .title { font-weight: 700; font-size: 15px; }
.provider-card .body { padding: 14px 16px; display: grid; gap: 8px; flex: 1; }
.provider-card .row { display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: 10px; font-size: 13px; }
.provider-card .row > span:first-child { color: var(--muted); }
.provider-card .row > span:last-child { word-break: break-all; }
.provider-card .head .spacer { flex: 1; }
.provider-card .head .title { white-space: nowrap; }
.provider-card .foot { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); flex-wrap: wrap; }

.popover { position: fixed; z-index: 30; width: 344px; background: var(--panel-3); border: 1px solid var(--border-strong); border-radius: 16px; box-shadow: 0 22px 60px rgba(0, 0, 0, .5); }
.popover-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 12px 12px 18px; border-bottom: 1px solid var(--border-strong); font-weight: 600; font-size: 15px; }
.popover-body { padding: 20px 16px 12px; }
.big-version { display: flex; align-items: center; justify-content: center; gap: 12px; font-size: 32px; font-weight: 800; letter-spacing: .4px; }
.status-icon { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; }
.status-icon svg { width: 16px; height: 16px; }
.status-icon.ok { background: rgba(34, 197, 94, .15); color: var(--ok); }
.status-icon.update { background: rgba(245, 158, 11, .16); color: var(--warn); }
.status-icon.unknown { background: rgba(148, 163, 184, .14); color: var(--muted); }
.status-line { text-align: center; color: var(--muted); margin-top: 6px; }
.popover-section { margin-top: 14px; display: grid; gap: 10px; }
.changes { max-height: 230px; overflow: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; font-size: 12.5px; }
.changes h4 { margin: 0 0 4px; font-size: 12.5px; }
.changes ul { margin: 0 0 8px; padding-left: 18px; color: var(--muted); }
.changes ul:last-child { margin-bottom: 0; }
.check-line { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; color: var(--muted); cursor: pointer; }
.check-line input { margin-top: 2px; }
.popover-link { display: flex; justify-content: center; align-items: center; gap: 9px; color: var(--muted); text-decoration: none; padding: 10px; border-radius: 10px; margin-top: 12px; border-top: 1px solid var(--border-strong); }
.popover-link svg { width: 18px; height: 18px; }
.popover-link:hover { color: var(--text); background: #1a2847; }

.modal-backdrop { position: fixed; inset: 0; background: rgba(2, 6, 23, .68); display: grid; place-items: center; z-index: 40; padding: 20px; }
.modal { width: min(560px, 100%); max-height: calc(100vh - 40px); display: flex; flex-direction: column; background: #121b30; border: 1px solid var(--border-strong); border-radius: 16px; box-shadow: 0 30px 80px rgba(0, 0, 0, .55); }
.modal.wide { width: min(780px, 100%); }
.modal-head { padding: 14px 14px 14px 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.modal-head h3 { margin: 0; font-size: 16px; }
.modal-body { padding: 18px 20px; overflow: auto; display: grid; gap: 14px; }
.modal-body p { margin: 0; }
.modal-body .banner { margin-bottom: 0; }
.modal-foot { padding: 13px 20px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 8px; align-items: center; }
.modal-foot .grow { flex: 1; color: var(--muted); font-size: 12.5px; display: flex; align-items: center; gap: 8px; min-width: 0; }
.field { display: grid; gap: 6px; align-content: start; }
.field > span { color: var(--muted); font-size: 12.5px; }
.field .hint { color: var(--faint); font-size: 12px; }
input[type=text], input[type=password], input[type=number], input[type=search], input[type=url], select { width: 100%; padding: 9px 11px; border-radius: 10px; border: 1px solid var(--border-strong); background: #0d1528; color: var(--text); font: inherit; }
input::placeholder { color: #4b5b75; }
input:focus, select:focus { outline: none; border-color: rgba(56, 189, 248, .7); box-shadow: 0 0 0 3px rgba(56, 189, 248, .15); }
.button:focus-visible, .nav-item:focus-visible, .icon-button:focus-visible, .version-badge:focus-visible, .link-button:focus-visible, .type-option:focus-visible { outline: 2px solid rgba(56, 189, 248, .65); outline-offset: 2px; }
.check-list { border: 1px solid var(--border); border-radius: 10px; max-height: 330px; overflow: auto; background: #0e1629; }
.check-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--border); cursor: pointer; }
.check-row:last-child { border-bottom: 0; }
.check-row:hover { background: #121d35; }
.check-row.disabled { opacity: .5; cursor: default; }
.check-row .mono { flex: 1; min-width: 0; word-break: break-all; font-size: 13px; }
.pick-text { flex: 1; min-width: 0; display: grid; gap: 1px; }
.pick-text .faint { font-size: 12px; }
.option-row { align-items: flex-start; }
.option-row input { margin-top: 3px; }
.stack { display: grid; gap: 14px; }
.actions.end { justify-content: flex-end; }
.setting-value { font-size: 22px; font-weight: 700; }
.setting-body { display: grid; gap: 10px; }
.type-choices { display: grid; gap: 10px; }
.type-option { display: flex; align-items: center; gap: 14px; width: 100%; padding: 14px 16px; border-radius: 12px; border: 1px solid var(--border-strong); background: #0e1629; text-align: left; cursor: pointer; }
.type-option:hover { background: #142036; border-color: rgba(56, 189, 248, .55); }
.type-option > svg { width: 22px; height: 22px; flex: none; color: var(--accent); }
.type-option > svg:last-child { width: 18px; height: 18px; color: var(--faint); }
.type-option .grow { flex: 1; min-width: 0; display: grid; gap: 4px; }
.type-option .title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14.5px; }
.checklist { border: 1px solid var(--border); border-radius: 10px; background: #0e1629; }
.check-item { display: flex; align-items: center; gap: 12px; padding: 11px 14px; border-bottom: 1px solid var(--border); }
.check-item:last-child { border-bottom: 0; }
.check-item .mark { width: 22px; height: 22px; border-radius: 50%; flex: none; display: grid; place-items: center; font-size: 12px; font-weight: 600; }
.check-item .mark svg { width: 13px; height: 13px; }
.check-item .mark.ok { background: rgba(34, 197, 94, .15); color: var(--ok); }
.check-item .mark.bad { background: rgba(244, 63, 94, .15); color: var(--danger); }
.check-item .mark.pending { background: rgba(148, 163, 184, .12); color: var(--faint); }
.check-item .grow { flex: 1; min-width: 0; display: grid; gap: 2px; }
.check-item.pending .grow { color: var(--faint); }
.list-toolbar { display: flex; gap: 8px; align-items: center; }
.list-toolbar input { flex: 1; }
.plain-list { margin: 0; padding-left: 20px; display: grid; gap: 3px; }
.log { background: #0a1020; border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; font: 12.5px/1.6 var(--mono); white-space: pre-wrap; word-break: break-word; height: 50vh; min-height: 220px; overflow: auto; color: #cbd5e1; margin: 0; }
.presets { display: flex; gap: 6px; flex-wrap: wrap; }
.spinner { width: 15px; height: 15px; border-radius: 50%; border: 2px solid rgba(148, 163, 184, .28); border-top-color: var(--accent); animation: spin .8s linear infinite; display: inline-block; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }
.result-ok { color: #86efac; display: inline-flex; align-items: center; gap: 6px; }
.result-bad { color: #fda4af; display: inline-flex; align-items: center; gap: 6px; }
.result-ok svg, .result-bad svg { width: 16px; height: 16px; flex: none; }
.toast-root { position: fixed; right: 20px; bottom: 20px; display: grid; gap: 8px; z-index: 60; }
.toast { padding: 10px 14px; border-radius: 10px; background: #1b2742; border: 1px solid var(--border-strong); max-width: 440px; box-shadow: 0 12px 34px rgba(0, 0, 0, .45); }
.toast.error { border-color: rgba(244, 63, 94, .55); color: #fecdd3; }
.toast.success { border-color: rgba(34, 197, 94, .45); color: #bbf7d0; }
.overlay { position: fixed; inset: 0; background: rgba(2, 6, 23, .82); display: grid; place-items: center; z-index: 70; }
.overlay-box { display: grid; gap: 14px; justify-items: center; text-align: center; padding: 30px; max-width: 420px; }
.overlay-box .spinner { width: 28px; height: 28px; border-width: 3px; }
.fatal { max-width: 520px; margin: 18vh auto; text-align: center; display: grid; gap: 10px; padding: 0 20px; }
.fatal h1 { margin: 0; font-size: 20px; }
.fatal p { margin: 0; color: var(--muted); }
.limit-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; align-items: start; }
.model-meta { display: none; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 6px; }

@media (max-width: 880px) {
  .app { flex-direction: column; }
  .sidebar { width: auto; height: auto; position: static; border-right: 0; border-bottom: 1px solid var(--border); }
  .nav { flex-direction: row; overflow-x: auto; }
  .nav-count { display: none; }
  .sidebar-footer { display: none; }
  .main { padding: 20px 16px 40px; }
  .kv { grid-template-columns: 1fr; gap: 2px 0; }
  .kv dd { margin-bottom: 8px; }
}
@media (max-width: 760px) {
  .col-provider, .col-transport, .col-effort { display: none; }
  .model-meta { display: flex; }
  th, td { padding: 9px 8px; }
}
@media (max-width: 540px) {
  .row-actions .nudge { display: none; }
  .limit-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<div class="app" id="app">
  <aside class="sidebar">
    <div class="brand">
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 48 48" width="30" height="30" fill="none">
          <defs>
            <linearGradient id="logo-a" x1="6" y1="8" x2="42" y2="40" gradientUnits="userSpaceOnUse">
              <stop offset="0" stop-color="#22d3ee"/>
              <stop offset="1" stop-color="#3b82f6"/>
            </linearGradient>
          </defs>
          <path d="M8 15h9c4.2 0 6.4 2 8.6 5.6l1.9 3c1.6 2.6 3.4 3.9 6.6 3.9H40" stroke="url(#logo-a)" stroke-width="4.6" stroke-linecap="round"/>
          <path d="M8 33h9c3.4 0 5.4-1.3 7.2-4" stroke="url(#logo-a)" stroke-width="4.6" stroke-linecap="round" opacity=".6"/>
          <path d="m35 21.5 6 6-6 6" stroke="url(#logo-a)" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div>
        <div class="brand-name">Codex 模型路由器</div>
        <button type="button" class="version-badge" id="version-badge" aria-haspopup="dialog" aria-expanded="false">v—</button>
      </div>
    </div>
    <nav class="nav" id="nav"></nav>
    <div class="sidebar-footer">
      <div class="router-status" id="router-status"><span class="status-dot"></span><span>檢查中…</span></div>
      <button type="button" class="link-button" id="shutdown-button">結束管理頁</button>
    </div>
  </aside>
  <main class="main" id="main">
    <div id="banners"></div>
    <section id="view"></section>
  </main>
</div>
<div class="popover" id="version-popover" role="dialog" aria-label="版本資訊" hidden></div>
<div id="modal-root"></div>
<div class="toast-root" id="toast-root" aria-live="polite"></div>
<script>
"use strict";

// ---- 基本工具 ----------------------------------------------------------------

const TOKEN_KEY = "codexModelRouterManagerToken";
const VIEW_KEY = "codexModelRouterManagerView";
const JOB_KEY = "codexModelRouterManagerJob";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// 與安裝器的 NEW_MODEL_DEFAULTS 及上下限相同；伺服器端會再驗證一次。
const NEW_MODEL_DEFAULTS = { contextWindow: 1000000, maxOutputTokens: 128000 };
const TOKEN_LIMITS = { minContext: 16000, maxContext: 4000000, minOutput: 4096, maxOutput: 1000000 };
const PROVIDER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
const RESERVED_PROVIDER_IDS = new Set(["default", "api", "custom", "official", "claude-cli"]);
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

const token = readToken();

function readToken() {
  const match = /(?:^#|&)t=([^&]+)/.exec(location.hash);
  let value = match ? decodeURIComponent(match[1]) : "";
  if (match) {
    try { sessionStorage.setItem(TOKEN_KEY, value); } catch { /* 無痕視窗也只是重新整理後要重開 */ }
    history.replaceState(null, "", location.pathname + location.search);
  }
  try { value = value || sessionStorage.getItem(TOKEN_KEY) || ""; } catch { /* 同上 */ }
  return value;
}

const ICONS = {
  overview: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>',
  models: '<path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8 12 3.5Z"/><path d="m3.5 12 8.5 4.5 8.5-4.5"/><path d="m3.5 16 8.5 4.5 8.5-4.5"/>',
  providers: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01M11 7.5h2M11 16.5h2"/>',
  refresh: '<path d="M19.5 10.5A7.5 7.5 0 0 0 6 6.6L4.5 8"/><path d="M4.5 3.5V8H9"/><path d="M4.5 13.5A7.5 7.5 0 0 0 18 17.4l1.5-1.4"/><path d="M19.5 20.5V16H15"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  arrowUp: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
  question: '<path d="M9.5 9.2a2.7 2.7 0 1 1 3.6 2.6c-.7.3-1.1.9-1.1 1.7v.5"/><path d="M12 17h.01"/>',
  grip: '<circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5"/><path d="m17 6 2.5 2.5M14.5 8.5 16.5 10.5"/>',
  power: '<path d="M12 3.5v8"/><path d="M6.6 6.6a7.5 7.5 0 1 0 10.8 0"/>',
  restart: '<path d="M20 12a8 8 0 1 1-2.4-5.7L20 8.6"/><path d="M20 4v4.6h-4.6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 9.5v4"/><path d="M12 17h.01"/><path d="M10.3 4 2.7 17.2A2 2 0 0 0 4.4 20h15.2a2 2 0 0 0 1.7-2.8L13.7 4a2 2 0 0 0-3.4 0Z"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.6h.01"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 16-5-5-8.5 8.5"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  claude: '<path d="M12 3v5.5M12 15.5V21M3 12h5.5M15.5 12H21M5.6 5.6l3.9 3.9M14.5 14.5l3.9 3.9M18.4 5.6l-3.9 3.9M9.5 14.5l-3.9 3.9"/>',
};
const GITHUB_PATH = "M12 .7C5.7.7.6 5.8.6 12.1c0 5 3.3 9.3 7.8 10.8.6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.7.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6a11.4 11.4 0 0 0 7.8-10.8C23.4 5.8 18.3.7 12 .7Z";

function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (name === "github") {
    svg.setAttribute("fill", "currentColor");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", GITHUB_PATH);
    svg.append(path);
    return svg;
  }
  svg.setAttribute("fill", name === "grip" ? "currentColor" : "none");
  svg.setAttribute("stroke", name === "grip" ? "none" : "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const template = document.createElement("template");
  template.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg">' + (ICONS[name] || "") + "</svg>";
  for (const child of [...template.content.firstChild.childNodes]) svg.append(child);
  return svg;
}

// 一律以 textContent 寫入文字：模型名稱、錯誤訊息都可能來自上游，不能當成 HTML。
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "checked" || key === "disabled" || key === "value" || key === "selected") node[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function formatTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  const trim = (amount) => String(Math.round(amount * 100) / 100);
  if (number >= 1e6) return trim(number / 1e6) + "M";
  if (number >= 1e3) return trim(number / 1e3) + "K";
  return String(number);
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("en-US") : "—";
}

function formatUptime(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total)) return "—";
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return days + " 天 " + hours + " 小時";
  if (hours) return hours + " 小時 " + minutes + " 分";
  if (minutes) return minutes + " 分鐘";
  return "不到 1 分鐘";
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url || ""); }
}

function effortText(efforts) {
  if (!Array.isArray(efforts) || efforts.length === 0) return "供應商預設";
  if (EFFORTS.every((effort) => efforts.includes(effort))) return "全部 5 檔";
  return efforts.join("、");
}

function providerLabel(id) {
  return id === "claude-cli" ? "Claude 訂閱" : id;
}

const TRANSPORTS = {
  responses: ["Responses", "cyan", "直接轉發 OpenAI Responses API"],
  chat: ["Chat 轉譯", "amber", "上游只有 Chat Completions，由路由器在本機轉譯"],
  anthropic: ["Claude 轉譯", "violet", "以 Anthropic Messages API 轉譯"],
  "claude-cli": ["Claude CLI", "violet", "透過 Claude Code 登入的訂閱帳號（實驗性）"],
};

function transportChip(transport) {
  const [label, tone, description] = TRANSPORTS[transport] || [transport, "", ""];
  return h("span", { class: "chip " + tone, title: description }, label);
}

function toast(message, kind) {
  const node = h("div", { class: "toast" + (kind ? " " + kind : "") }, message);
  document.getElementById("toast-root").append(node);
  setTimeout(() => node.remove(), kind === "error" ? 8000 : 4500);
}

// ---- 與管理程式溝通 ----------------------------------------------------------

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let connectionLost = false;
let restartingManager = false;
let managerInstance = null;

async function api(path, options) {
  const method = (options && options.method) || "GET";
  const body = options && "body" in options ? options.body : (method === "POST" ? {} : undefined);
  let response;
  try {
    response = await fetch(path, {
      method,
      cache: "no-store",
      headers: Object.assign({ "x-router-manager-token": token }, body !== undefined ? { "content-type": "application/json" } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    setConnection(false);
    throw new ApiError("無法連線到管理程式。若終端視窗已關閉，請重新開啟管理頁。", 0);
  }
  setConnection(true);
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) throw new ApiError((data && data.error) || ("HTTP " + response.status), response.status);
  const instance = response.headers.get("x-router-manager-instance");
  if (instance && managerInstance && instance !== managerInstance) {
    restartingManager = true;
    location.reload();
    throw new ApiError("管理頁已換新，正在重新整理。", 0);
  }
  if (instance) managerInstance = instance;
  return data;
}

function setConnection(ok) {
  if (connectionLost === !ok) return;
  connectionLost = !ok;
  renderBanners();
}

// ---- 狀態 --------------------------------------------------------------------

let state = null;
let versionInfo = null;
let errorsData = null;
let currentView = (() => { try { return sessionStorage.getItem(VIEW_KEY) || "overview"; } catch { return "overview"; } })();
let orderDraft = null;
const selected = new Set();
let dragSlug = null;
let pendingDesktopRestart = false;
let modalCount = 0;

async function refreshState(quiet) {
  try {
    state = await api("/api/state");
    reconcileModelsState();
    render();
  } catch (error) {
    if (!quiet) toast(error.message, "error");
  }
}

async function refreshVersion(refresh) {
  try {
    versionInfo = await api("/api/version" + (refresh ? "?refresh=1" : ""));
  } catch (error) {
    if (refresh) toast(error.message, "error");
  }
  renderSidebar();
  renderPopover();
}

async function refreshErrors() {
  try {
    errorsData = await api("/api/errors");
  } catch (error) {
    errorsData = { entries: [], error: error.message };
  }
  if (currentView === "overview") renderView();
}

function reconcileModelsState() {
  const slugs = new Set((state.models || []).map((model) => model.slug));
  for (const slug of [...selected]) if (!slugs.has(slug)) selected.delete(slug);
  if (orderDraft && (orderDraft.length !== slugs.size || orderDraft.some((slug) => !slugs.has(slug)))) orderDraft = null;
}

function writeBlocked() {
  return Boolean(state && (state.writeBlocked || !state.installed));
}

// ---- 版面 --------------------------------------------------------------------

const VIEWS = [
  { id: "overview", label: "總覽", icon: "overview" },
  { id: "models", label: "模型", icon: "models" },
  { id: "providers", label: "供應商", icon: "providers" },
  { id: "imagegen", label: "生圖", icon: "image" },
  { id: "settings", label: "設定", icon: "settings" },
];

function render() {
  renderSidebar();
  renderBanners();
  renderView();
}

function renderSidebar() {
  const nav = document.getElementById("nav");
  nav.replaceChildren(...VIEWS.map((view) => {
    const count = !state ? null : view.id === "models" ? (state.models || []).length : view.id === "providers" ? (state.providers || []).length : null;
    return h("button", {
      type: "button", class: "nav-item" + (view.id === currentView ? " active" : ""),
      "aria-current": view.id === currentView ? "page" : null,
      onclick: () => switchView(view.id),
    }, icon(view.icon), view.label, count != null ? h("span", { class: "nav-count", text: String(count) }) : null);
  }));

  const badge = document.getElementById("version-badge");
  const version = (versionInfo && versionInfo.installed) || (state && state.versions && (state.versions.installed || state.versions.manager));
  const hasUpdate = Boolean(versionInfo && (versionInfo.status === "update-available" || versionInfo.localNewer));
  // replaceChildren 會把 null 印成文字 "null"，可有可無的節點要先濾掉。
  badge.replaceChildren(...["v" + (version || "—"), hasUpdate ? h("span", { class: "dot", title: "有新版本" }) : null].filter(Boolean));
  badge.classList.toggle("has-update", hasUpdate);
  badge.title = hasUpdate ? "有新版本，點擊查看" : "版本資訊";

  const status = document.getElementById("router-status");
  if (!state || !state.installed) {
    status.replaceChildren(h("span", { class: "status-dot" }), h("span", { text: state ? "尚未安裝" : "檢查中…" }));
  } else if (state.router && state.router.ok) {
    status.replaceChildren(h("span", { class: "status-dot ok" }), h("span", { text: "路由器運作中 · :" + state.router.port }));
  } else {
    status.replaceChildren(h("span", { class: "status-dot bad" }), h("span", { text: "路由器無法連線" }));
  }
}

function switchView(id) {
  currentView = id;
  try { sessionStorage.setItem(VIEW_KEY, id); } catch { /* 只影響重新整理後停在哪一頁 */ }
  renderSidebar();
  renderView();
  if (id === "overview") refreshErrors();
  document.getElementById("main").scrollTop = 0;
  window.scrollTo(0, 0);
}

function banner(kind, iconName, content, ...actions) {
  return h("div", { class: "banner " + kind }, icon(iconName), h("div", { class: "grow" }, content), ...actions);
}

function renderBanners() {
  const host = document.getElementById("banners");
  const items = [];
  if (connectionLost && !restartingManager) {
    items.push(banner("error", "alert", "與管理程式的連線中斷，正在重試。若終端視窗已關閉，請重新執行安裝器的 ui 命令。"));
  }
  if (state && state.writeBlocked) items.push(banner("warn", "alert", state.writeBlocked));
  if (pendingDesktopRestart && state && state.installed) {
    const canRestart = state.desktop && state.desktop.canRestart;
    items.push(banner("info", "info",
      canRestart
        ? "設定已寫入。重新啟動 " + state.desktop.name + " 後，模型選擇器才會顯示這次的變更。"
        : "設定已寫入。請完全退出並重新打開 " + ((state.desktop && state.desktop.name) || "桌面版") + "，模型選擇器才會顯示這次的變更。",
      canRestart ? h("button", { type: "button", class: "button small", onclick: confirmRestartDesktop }, icon("restart"), "立即重新啟動") : null,
      h("button", { type: "button", class: "icon-button", title: "稍後再說", "aria-label": "關閉提示", onclick: () => { pendingDesktopRestart = false; renderBanners(); } }, icon("close"))));
  }
  host.replaceChildren(...items);
}

function renderView() {
  const view = document.getElementById("view");
  if (!state) {
    view.replaceChildren(h("div", { class: "empty" }, h("span", { class: "spinner" }), " 讀取中…"));
    return;
  }
  if (!state.installed) {
    view.replaceChildren(pageHead("尚未安裝", "這個 CODEX_HOME 還沒有安裝 Codex 模型路由器。"),
      h("div", { class: "panel" }, h("div", { class: "empty", text: "請先在終端執行安裝器，選擇「安裝或重新配置」。" })));
    return;
  }
  if (currentView === "models") view.replaceChildren(...renderModels());
  else if (currentView === "providers") view.replaceChildren(...renderProviders());
  else if (currentView === "imagegen") view.replaceChildren(...renderImagegen());
  else if (currentView === "settings") view.replaceChildren(...renderSettings());
  else view.replaceChildren(...renderOverview());
}

function pageHead(title, subtitle, ...actions) {
  return h("header", { class: "page-head" },
    h("div", {}, h("h1", { text: title }), subtitle ? h("p", { text: subtitle }) : null),
    actions.length ? h("div", { class: "actions" }, ...actions) : null);
}

// ---- 總覽 --------------------------------------------------------------------

function card(label, value, sub, dot) {
  return h("div", { class: "card" },
    h("div", { class: "card-label", text: label }),
    h("div", { class: "card-value" }, dot ? h("span", { class: "status-dot " + dot }) : null, value),
    sub ? h("div", { class: "card-sub", text: sub, title: sub }) : null);
}

function renderOverview() {
  const router = state.router || {};
  const stats = router.stats || {};
  const primary = (state.providers || []).find((provider) => provider.primary);
  const canRestart = state.desktop && state.desktop.canRestart;
  const head = pageHead("總覽", "路由器狀態、最近的錯誤與執行環境。",
    h("button", { type: "button", class: "button", onclick: confirmRestartRouter }, icon("restart"), "重新啟動路由器"),
    canRestart ? h("button", { type: "button", class: "button", onclick: confirmRestartDesktop }, icon("power"), "重新啟動 " + state.desktop.name) : null);

  const cards = h("div", { class: "cards" },
    card("路由器", router.ok ? "運作中" : "無法連線",
      router.ok ? "v" + (router.version || "?") + " · 連接埠 " + router.port + " · 已運作 " + formatUptime(router.uptimeSeconds) : (router.error || "沒有回應"),
      router.ok ? "ok" : "bad"),
    card("請求", formatNumber(stats.requests ?? 0),
      "失敗 " + formatNumber(stats.failures ?? 0) + " · 官方 " + formatNumber(stats.official ?? 0) + " · 自訂 " + formatNumber(stats.custom ?? 0)),
    card("自訂模型", String((state.models || []).length), "官方模型 " + formatNumber(state.officialModelCount) + " 個"),
    card("供應商", String((state.providers || []).length), primary ? "主要：" + primary.id : ""));

  return [head, cards, renderErrorsPanel(), renderEnvironmentPanel()];
}

function renderErrorsPanel() {
  const refresh = h("button", { type: "button", class: "icon-button", title: "重新整理", "aria-label": "重新整理錯誤紀錄", onclick: () => refreshErrors() }, icon("refresh"));
  const panel = h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", { text: "最近的錯誤" }), refresh));
  if (!errorsData) {
    panel.append(h("div", { class: "empty" }, h("span", { class: "spinner" }), " 讀取中…"));
    return panel;
  }
  if (errorsData.error) {
    panel.append(h("div", { class: "empty", text: errorsData.error }));
    return panel;
  }
  const entries = (errorsData.entries || []).slice(0, 30);
  if (entries.length === 0) {
    panel.append(h("div", { class: "empty", text: "記錄檔裡沒有錯誤紀錄。" }));
    return panel;
  }
  const kindLabels = {
    "websocket-error": "WebSocket", "catalog-refresh-failed": "模型清單同步", "request-too-large": "請求過大",
    "upstream-ws-cooldown": "上游 WebSocket 冷卻", "auth-probe-grace": "官方驗證寬限",
  };
  const rows = entries.map((entry) => {
    const what = entry.kind === "error"
      ? [entry.code ? h("span", { class: "chip rose mono", text: entry.status ? entry.status + " " + entry.code : entry.code }) : h("span", { class: "chip rose", text: "錯誤" })]
      : [h("span", { class: "chip amber", text: kindLabels[entry.kind] || entry.kind })];
    const where = [entry.model, entry.provider ? "供應商 " + entry.provider : null, entry.upstreamHost].filter(Boolean).join(" · ");
    return h("tr", {},
      h("td", { class: "tight mono muted", text: formatTime(entry.at) }),
      h("td", { class: "tight" }, ...what),
      h("td", {}, h("div", { text: entry.message || "—" }), where ? h("div", { class: "model-sub", text: where }) : null),
      h("td", { class: "tight mono faint", text: entry.requestId || "" }));
  });
  panel.append(h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", { text: "時間" }), h("th", { text: "類型" }), h("th", { text: "內容" }), h("th", { text: "診斷 ID" }))),
    h("tbody", {}, rows))));
  return panel;
}

function renderEnvironmentPanel() {
  const versions = state.versions || {};
  const config = state.config;
  const items = [
    ["版本", "管理頁 v" + versions.manager + " · 已安裝 v" + (versions.installed || "?") + " · 路由器 " + (versions.router ? "v" + versions.router : "未回應")],
    ["CODEX_HOME", state.paths.codexHome],
    ["路由器目錄", state.paths.installRoot],
    ["記錄檔", state.paths.logPath],
    ["背景服務", state.service.name + "（" + state.service.kind + "）"],
    ["Node.js", state.paths.nodeBin || "—"],
    ["Codex CLI", state.paths.codexBin || "—"],
    ["全域預設模型", config ? (config.model || "未設定（使用官方預設）") : "讀取中…"],
    ["全域上下文", config ? (config.modelContextWindow ? formatNumber(config.modelContextWindow) + " tokens（覆蓋各模型的設定）" : "未設定（各模型自行決定）") : "讀取中…"],
    ["中轉 API 生圖", !state.imagegen ? "未啟用" : state.imagegen.error ? state.imagegen.error : state.imagegen.models.join("、") + "（供應商 " + state.imagegen.providerId + "）"],
    ["管理頁捷徑", state.paths.shortcut || "尚未建立（執行一次 update 會建立）"],
  ];
  return h("div", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", { text: "環境" })),
    h("div", { class: "panel-body" }, h("dl", { class: "kv" }, items.flatMap(([label, value]) => [h("dt", { text: label }), h("dd", { class: /[/\\]/.test(String(value)) && label !== "版本" ? "mono" : "", text: value })]))));
}

// ---- 模型 --------------------------------------------------------------------

function orderedModels() {
  const models = state.models || [];
  if (!orderDraft) return models;
  const bySlug = new Map(models.map((model) => [model.slug, model]));
  return orderDraft.map((slug) => bySlug.get(slug)).filter(Boolean);
}

function orderDirty() {
  if (!orderDraft) return false;
  return orderDraft.some((slug, index) => (state.models[index] || {}).slug !== slug);
}

function moveModel(slug, targetSlug, after) {
  const order = orderedModels().map((model) => model.slug);
  const from = order.indexOf(slug);
  if (from < 0) return;
  order.splice(from, 1);
  let to = order.indexOf(targetSlug);
  if (to < 0) return;
  if (after) to += 1;
  order.splice(to, 0, slug);
  orderDraft = order;
  renderView();
}

function nudgeModel(slug, delta) {
  const order = orderedModels().map((model) => model.slug);
  const index = order.indexOf(slug);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= order.length) return;
  [order[index], order[target]] = [order[target], order[index]];
  orderDraft = order;
  renderView();
}

function renderModels() {
  const blocked = writeBlocked();
  const models = orderedModels();
  const dirty = orderDirty();
  const head = pageHead("模型", "Codex 選擇器裡的自訂模型，選擇器依這裡的順序顯示。",
    h("button", {
      type: "button", class: "button danger", disabled: blocked || selected.size === 0 || dirty,
      onclick: () => confirmRemoveModels([...selected]),
    }, icon("trash"), selected.size ? "刪除所選（" + selected.size + "）" : "刪除所選"),
    h("button", { type: "button", class: "button primary", disabled: blocked, onclick: () => openAddModels() }, icon("plus"), "新增模型"));

  const parts = [head];
  if (dirty) {
    parts.push(banner("info", "info", "順序已調整，尚未儲存。",
      h("button", { type: "button", class: "button small", onclick: () => { orderDraft = null; renderView(); } }, "還原"),
      h("button", { type: "button", class: "button small primary", disabled: blocked, onclick: saveOrder }, "儲存順序")));
  }
  const notes = [
    h("div", { class: "note", text: "拖曳左側把手或用箭頭調整順序。排序、改名與上下文只寫入模型目錄，不會重新啟動路由器；修改輸出會重新啟動路由器。" }),
    h("div", { class: "note", text: "輸出只對 Claude 模型有效（送往 Claude 的 max_tokens，「/」後面是模型上限）；GPT 與 Chat 模型的輸出由上游決定。" }),
  ];
  if (state.customModelOrder === "manual") notes.push(h("div", { class: "note", text: "已手動排序：之後新增的模型會排在最後。" }));
  if (state.config && state.config.modelContextWindow) {
    notes.push(h("div", { class: "note warn", text: "全域 model_context_window = " + formatNumber(state.config.modelContextWindow) + "，會覆蓋下表各模型的上下文設定。" }));
  }
  parts.push(h("div", { class: "notes" }, notes));

  if (models.length === 0) {
    parts.push(h("div", { class: "panel" }, h("div", { class: "empty" },
      h("p", { text: "還沒有自訂模型。" }),
      h("button", { type: "button", class: "button primary", disabled: blocked, onclick: () => openAddModels() }, icon("plus"), "新增模型"))));
    return parts;
  }

  const allChecked = models.every((model) => selected.has(model.slug));
  const headerBox = h("input", {
    type: "checkbox", "aria-label": "全選", checked: allChecked && models.length > 0, disabled: blocked,
    onchange: (event) => { for (const model of models) event.target.checked ? selected.add(model.slug) : selected.delete(model.slug); renderView(); },
  });
  const rows = models.map((model, index) => modelRow(model, index, models.length, blocked));
  parts.push(h("div", { class: "panel" }, h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {},
      h("th", { class: "tight" }, headerBox), h("th", { class: "tight" }),
      h("th", { text: "名稱" }), h("th", { class: "col-provider", text: "供應商" }), h("th", { class: "col-transport", text: "介面" }),
      h("th", { class: "col-effort", text: "推理強度" }), h("th", { text: "上下文" }), h("th", { text: "輸出" }), h("th", { class: "tight" }))),
    h("tbody", {}, rows)))));
  return parts;
}

function contextCell(model) {
  const template = model.contextSource === "template";
  return h("td", { class: "nowrap", title: model.contextWindow ? formatNumber(model.contextWindow) + " tokens" + (template ? "（沿用官方模板，未實測）" : "") : "" },
    formatTokens(model.contextWindow),
    template ? h("span", { class: "faint", text: " 模板" }) : null);
}

function outputCell(model) {
  if (!model.outputConfigurable) {
    return h("td", { class: "nowrap faint", text: "上游預設", title: "這個介面不送出輸出上限，由上游模型決定" });
  }
  const showCap = model.outputCap && model.outputCap > model.outputTokens;
  return h("td", { class: "nowrap", title: "每次回覆最多 " + formatNumber(model.outputTokens) + " tokens" + (model.outputCap ? "；模型上限 " + formatNumber(model.outputCap) : "") },
    formatTokens(model.outputTokens),
    showCap ? h("span", { class: "faint", text: " / " + formatTokens(model.outputCap) }) : null);
}

function modelRow(model, index, count, blocked) {
  const isDefault = state.config && state.config.model === model.slug;
  const handle = h("span", {
    class: "drag-handle" + (blocked ? " disabled" : ""), title: blocked ? null : "按住拖曳調整順序", "aria-hidden": "true",
  }, icon("grip"));
  const row = h("tr", { "data-slug": model.slug },
    h("td", { class: "tight" }, h("input", {
      type: "checkbox", "aria-label": "選取 " + model.displayName, checked: selected.has(model.slug), disabled: blocked,
      onchange: (event) => { event.target.checked ? selected.add(model.slug) : selected.delete(model.slug); renderView(); },
    })),
    h("td", { class: "tight" }, handle),
    h("td", {},
      h("div", { class: "model-name" }, h("span", { text: model.displayName }),
        isDefault ? h("span", { class: "chip green", text: "全域預設" }) : null,
        model.inCatalog ? null : h("span", { class: "chip rose", text: "目錄缺少", title: "models.json 裡沒有這個模型，請執行 update 修復" })),
      h("div", { class: "model-sub", text: model.upstreamModel, title: "選擇器 ID：" + model.slug }),
      h("div", { class: "model-meta" }, h("span", { class: "chip", text: providerLabel(model.providerId) }), transportChip(model.transport),
        h("span", { class: "faint", text: effortText(model.efforts) }))),
    h("td", { class: "col-provider" }, h("span", { class: "chip", text: providerLabel(model.providerId) })),
    h("td", { class: "col-transport" }, transportChip(model.transport)),
    h("td", { class: "col-effort muted nowrap", text: effortText(model.efforts), title: (model.efforts || []).join(", ") }),
    contextCell(model),
    outputCell(model),
    h("td", { class: "tight" }, h("div", { class: "row-actions" },
      h("button", { type: "button", class: "icon-button nudge", title: "上移", "aria-label": "上移", disabled: blocked || index === 0, onclick: () => nudgeModel(model.slug, -1) }, icon("up")),
      h("button", { type: "button", class: "icon-button nudge", title: "下移", "aria-label": "下移", disabled: blocked || index === count - 1, onclick: () => nudgeModel(model.slug, 1) }, icon("down")),
      h("button", { type: "button", class: "icon-button", title: "修改名稱、上下文與輸出", "aria-label": "修改", disabled: blocked, onclick: () => openEditModel(model) }, icon("edit")))));
  if (!blocked) attachDrag(handle, row, model.slug);
  return row;
}

// 以指標事件實作拖曳：HTML5 原生拖放在表格列與觸控板上表現不一致（Safari 尤其），
// 這裡按住把手後追蹤指標位置，在目標列畫插入線，放開時才重排。
function attachDrag(handle, row, slug) {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragSlug = slug;
    let target = null;
    row.classList.add("dragging");
    document.body.classList.add("dragging-row");
    try { handle.setPointerCapture(event.pointerId); } catch { /* 部分瀏覽器不支援時照樣靠 document 事件 */ }
    const clearMarks = () => {
      for (const node of document.querySelectorAll(".drop-before, .drop-after")) node.classList.remove("drop-before", "drop-after");
    };
    const onMove = (moveEvent) => {
      clearMarks();
      target = null;
      for (const candidate of document.querySelectorAll("tbody tr[data-slug]")) {
        const rect = candidate.getBoundingClientRect();
        if (moveEvent.clientY < rect.top || moveEvent.clientY > rect.bottom) continue;
        if (candidate.dataset.slug === slug) break;
        const after = moveEvent.clientY > rect.top + rect.height / 2;
        candidate.classList.add(after ? "drop-after" : "drop-before");
        target = { slug: candidate.dataset.slug, after };
        break;
      }
    };
    const finish = (endEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      clearMarks();
      row.classList.remove("dragging");
      document.body.classList.remove("dragging-row");
      dragSlug = null;
      if (endEvent.type === "pointerup" && target) moveModel(slug, target.slug, target.after);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
  });
}

async function saveOrder() {
  const slugs = orderedModels().map((model) => model.slug);
  const view = await runJob("reorder-models", { slugs }, { title: "儲存模型順序" });
  if (view && view.status === "succeeded") orderDraft = null;
  renderView();
}

// ---- 供應商 ------------------------------------------------------------------

function renderProviders() {
  const blocked = writeBlocked();
  const providers = state.providers || [];
  const head = pageHead("供應商", "每家供應商各自保存 API Key；主要供應商另外負責 Codex 內建的生圖請求。",
    h("button", { type: "button", class: "button primary", disabled: blocked, onclick: openAddProvider }, icon("plus"), "新增供應商"));
  const cards = providers.map((provider) => h("div", { class: "provider-card" },
    h("div", { class: "head" },
      h("span", { class: "title", text: provider.id }),
      provider.primary ? h("span", { class: "chip cyan", text: "主要" }) : null,
      h("span", { class: "chip", text: provider.modelCount + " 個模型" })),
    h("div", { class: "body" },
      h("div", { class: "row" }, h("span", { text: "Base URL" }), h("span", { class: "mono", text: provider.baseUrl || "—" })),
      h("div", { class: "row" }, h("span", { text: "API 根地址" }), h("span", { class: "mono", text: provider.apiRoot || "—" })),
      h("div", { class: "row" }, h("span", { text: "API Key" }),
        h("span", {}, provider.keyStored
          ? h("span", { class: "chip green", text: state.platform === "win32" ? "已加密儲存" : "已存於鑰匙圈" })
          : h("span", { class: "chip rose", text: "找不到，請重新設定" })))),
    h("div", { class: "foot" },
      h("button", { type: "button", class: "button small", disabled: blocked, onclick: () => openAddModels(provider.id) }, icon("plus"), "添加模型"),
      h("button", { type: "button", class: "button small", onclick: () => openReplaceKey(provider) }, icon("key"), "更換 API Key"),
      h("button", {
        type: "button", class: "button small danger", disabled: blocked || providers.length <= 1,
        title: providers.length <= 1 ? "至少要保留一家供應商" : null, onclick: () => confirmRemoveProvider(provider),
      }, icon("trash"), "移除"))));
  // Claude 訂閱有模型時才顯示卡片；還沒連接時，從「新增供應商」或「新增模型」選擇它。
  const cliModels = (state.models || []).filter((model) => model.transport === "claude-cli").length;
  if (cliModels) cards.push(claudeCliCard(blocked, cliModels));
  return [head, h("div", { class: "provider-grid" }, cards)];
}

// ---- 唯讀查詢：各頁打開時才載入，背景工作完成後重新載入 -----------------------------

const queries = {};
let hiddenDraft = null;
let imagegenDraft = null;

function ensureQuery(type) {
  const entry = queries[type] || (queries[type] = { loading: false, data: null, error: null });
  if (!entry.loading && entry.data === null && entry.error === null) loadQuery(type);
  return entry;
}

async function loadQuery(type) {
  const entry = queries[type] || (queries[type] = { loading: false, data: null, error: null });
  entry.loading = true;
  entry.error = null;
  try {
    entry.data = await api("/api/query", { method: "POST", body: { type } });
  } catch (error) {
    entry.error = error.message;
  } finally {
    entry.loading = false;
  }
  // 重新載入後，未儲存的勾選以最新資料為準。
  if (type === "hidden-models") hiddenDraft = null;
  if (type === "imagegen") imagegenDraft = null;
  renderView();
}

function reloadQuery(type) {
  const entry = queries[type];
  if (entry && entry.loading) return;
  delete queries[type];
  renderView();
}

function invalidateQueries() {
  for (const type of Object.keys(queries)) if (!queries[type].loading) delete queries[type];
}

function queryPlaceholder(entry, type, text) {
  if (entry.error) {
    return h("div", { class: "empty" }, h("p", { text: entry.error }),
      h("button", { type: "button", class: "button small", onclick: () => reloadQuery(type) }, "重試"));
  }
  return h("div", { class: "empty" }, h("span", { class: "spinner" }), " " + (text || "讀取中…"));
}

function refreshButton(type, label) {
  return h("button", { type: "button", class: "icon-button", title: "重新整理", "aria-label": label, onclick: () => reloadQuery(type) }, icon("refresh"));
}

// ---- Claude 訂閱（CLI） --------------------------------------------------------

const CLAUDE_CLI_MODEL_PATTERN = /^(?:opus|sonnet|haiku|fable|claude-[a-zA-Z0-9._-]+)$/;
// Claude 訂閱在供應商選單裡的代號，與路由器記錄的 providerId 相同。
const CLAUDE_CLI_ID = "claude-cli";

function cardRow(label, ...content) {
  return h("div", { class: "row" }, h("span", { text: label }), h("span", {}, ...content));
}

function claudeCliCard(blocked, count) {
  const entry = ensureQuery("claude-cli");
  const info = entry.data;
  const head = h("div", { class: "head" },
    h("span", { class: "title", text: "Claude 訂閱", title: "透過 Claude CLI 使用 Claude 訂閱帳號" }), h("span", { class: "chip violet", text: "實驗性" }),
    h("span", { class: "chip", text: count + " 個模型" }), h("span", { class: "spacer" }), refreshButton("claude-cli", "重新檢查 Claude CLI"));
  const intro = h("div", { class: "note", text: "使用 Claude Code 登入的訂閱帳號（Pro／Max），不需要 API Key；用量依帳號方案計算。" });
  const button = (label, iconName, onclick, primary = false) =>
    h("button", { type: "button", class: "button small" + (primary ? " primary" : ""), onclick }, icon(iconName), label);
  const addButton = h("button", { type: "button", class: "button small primary", disabled: blocked,
    onclick: () => openAddModels(CLAUDE_CLI_ID) }, icon("plus"), "添加模型");
  const removeButton = h("button", { type: "button", class: "button small danger", disabled: blocked, onclick: confirmRemoveClaudeCli },
    icon("trash"), "移除");
  if (!info) {
    return h("div", { class: "provider-card" }, head, h("div", { class: "body" },
      entry.error ? h("div", { class: "note warn", text: entry.error }) : h("div", { class: "note" }, h("span", { class: "spinner" }), " 正在檢查 Claude CLI…"),
      intro), h("div", { class: "foot" }, addButton, removeButton));
  }
  const versionChip = info.upToDate
    ? h("span", { class: "chip green", text: "可用" })
    : h("span", { class: "chip amber", text: "需要 " + info.minimumVersion + " 以上" });
  const loginChip = !info.installed ? h("span", { class: "faint", text: "—" })
    : info.subscription ? h("span", { class: "chip green", text: "已登入訂閱帳號" })
    : info.loggedIn ? h("span", { class: "chip amber", text: "已登入，但不是訂閱帳號" + (info.authMethod ? "（" + info.authMethod + "）" : "") })
    : h("span", { class: "chip rose", text: "尚未登入" });
  const body = h("div", { class: "body" },
    cardRow("程式", info.installed ? h("span", { class: "mono", text: info.binary }) : h("span", { class: "chip rose", text: "未安裝" })),
    info.installed ? cardRow("版本", h("span", { class: "mono", text: (info.version || "未知") + " " }), versionChip) : null,
    cardRow("登入", loginChip),
    info.authError ? h("div", { class: "note warn", text: info.authError }) : null,
    intro);
  const ready = info.installed && info.upToDate && info.subscription;
  const actions = [];
  if (!info.installed) actions.push(button("安裝 Claude CLI", "plus", () => confirmClaudeCliInstall(info), true));
  else if (!info.upToDate) actions.push(button("更新 Claude CLI", "arrowUp", () => confirmClaudeCliUpdate(info), true));
  else if (!info.subscription) actions.push(button("登入 Claude", "key", () => confirmClaudeCliLogin(false), true));
  if (ready) actions.push(addButton);
  if (info.installed && info.upToDate) actions.push(button("更新 CLI", "arrowUp", () => confirmClaudeCliUpdate(info)));
  if (ready) actions.push(button("重新登入", "key", () => confirmClaudeCliLogin(true)));
  actions.push(removeButton);
  return h("div", { class: "provider-card" }, head, body, h("div", { class: "foot" }, actions));
}

// 移除 Claude 訂閱就是刪除它的全部模型；不登出 Claude，也不解除安裝 CLI。
function confirmRemoveClaudeCli() {
  const models = (state.models || []).filter((model) => model.transport === "claude-cli");
  if (models.length === 0) return;
  const includesDefault = state.config && models.some((model) => model.slug === state.config.model);
  confirmDialog({
    title: "移除 Claude 訂閱（CLI）",
    danger: true,
    confirmLabel: "移除",
    body: [
      paragraph("會刪除它的 " + models.length + " 個模型："),
      h("ul", { class: "plain-list" }, models.map((model) => h("li", { text: model.displayName }))),
      includesDefault ? banner("warn", "alert", "其中包含全域預設模型，移除後會一併清除這個預設，改用官方預設模型。") : null,
      paragraph("不會登出 Claude，也不會解除安裝 Claude CLI；之後可以從「新增供應商」重新連接。刪除前會自動備份，接著重新啟動路由器。", "note"),
    ],
  }).then((ok) => {
    if (ok) runJob("remove-models", { slugs: models.map((model) => model.slug) }, { title: "移除 Claude 訂閱" });
  });
}

// 以下三個確認框都回傳背景工作的結果（取消時為 null），呼叫端可以在完成後重新檢查狀態。
function confirmClaudeCliInstall(info) {
  return confirmDialog({
    title: "安裝 Claude CLI",
    confirmLabel: "下載並安裝",
    body: [
      paragraph("會從 " + info.installerUrl + " 下載 Anthropic 官方安裝程式並執行，Claude CLI 會安裝在你的使用者目錄。需要網路，可能要幾分鐘；安裝輸出會顯示在操作記錄裡。"),
      paragraph("安裝完成後，再按「登入 Claude」連接訂閱帳號。", "note"),
    ],
  }).then((ok) => (ok ? runJob("claude-cli-install", {}, { title: "安裝 Claude CLI" }) : null));
}

function confirmClaudeCliUpdate(info) {
  return confirmDialog({
    title: "更新 Claude CLI",
    confirmLabel: "更新",
    body: [
      paragraph("會先備份目前的執行檔，再執行 claude update。目前版本：" + (info.version || "未知") + "；最低需求：" + info.minimumVersion + "。"),
      paragraph("透過 Homebrew 或 WinGet 安裝的 CLI，請改用原本的套件管理器更新。", "note"),
    ],
  }).then((ok) => (ok ? runJob("claude-cli-update", {}, { title: "更新 Claude CLI" }) : null));
}

function confirmClaudeCliLogin(force) {
  return confirmDialog({
    title: force ? "重新登入 Claude" : "登入 Claude 訂閱帳號",
    confirmLabel: "開始登入",
    body: [
      paragraph("會在執行管理頁的終端機視窗啟動 Claude 官方登入流程（claude auth login），瀏覽器會開啟授權頁面；這項操作會等到授權完成，最多 5 分鐘。"),
      banner("info", "info", "若瀏覽器沒有自動開啟，或畫面要求貼上代碼，請切到開啟管理頁的那個終端機視窗操作。路由器不經手、也不保存登入 token。"),
    ],
  }).then((ok) => (ok ? runJob("claude-cli-login", { force }, { title: force ? "重新登入 Claude" : "登入 Claude 訂閱帳號" }) : null));
}

// Claude CLI 的準備狀態：安裝、版本、訂閱登入。第一個沒通過的步驟附上處理按鈕，之後的步驟先灰掉。
// act(run) 執行按鈕對應的確認框，完成後由呼叫端重新檢查。
function claudeCliChecklist(info, act) {
  const steps = [
    info.installed
      ? { ok: true, text: "已安裝 Claude CLI", detail: info.binary, mono: true }
      : { ok: false, text: "尚未安裝 Claude CLI", detail: "用 Anthropic 官方安裝程式安裝在你的使用者目錄，需要網路。",
        action: ["安裝 Claude CLI", () => confirmClaudeCliInstall(info)] },
    info.upToDate
      ? { ok: true, text: "版本 " + info.version, detail: "需要 " + info.minimumVersion + " 以上" }
      : { ok: false, text: !info.installed ? "版本需要 " + info.minimumVersion + " 以上"
          : info.version ? "版本 " + info.version + " 太舊" : "無法確認 Claude CLI 版本",
        detail: "需要 " + info.minimumVersion + " 以上；更新前會先備份目前的執行檔。",
        action: ["更新 Claude CLI", () => confirmClaudeCliUpdate(info)] },
    info.subscription
      ? { ok: true, text: "已登入 Claude 訂閱帳號" }
      : { ok: false, text: info.loggedIn ? "目前登入的不是訂閱帳號" + (info.authMethod ? "（" + info.authMethod + "）" : "") : "尚未登入 Claude 訂閱帳號",
        detail: info.authError || "使用 Claude 官方登入流程，在瀏覽器完成授權；路由器不保存登入 token。",
        action: ["登入 Claude", () => confirmClaudeCliLogin(false)] },
  ];
  let failed = false;
  return h("div", { class: "checklist" }, steps.map((step, index) => {
    const status = step.ok ? "ok" : failed ? "pending" : "bad";
    if (!step.ok) failed = true;
    return h("div", { class: "check-item " + status },
      h("span", { class: "mark " + status }, status === "ok" ? icon("check") : status === "bad" ? icon("close") : String(index + 1)),
      h("div", { class: "grow" }, h("span", { text: step.text }),
        step.detail ? h("span", { class: "note" + (step.mono ? " mono" : ""), text: step.detail }) : null),
      status === "bad" ? h("button", { type: "button", class: "button small primary", onclick: () => act(step.action[1]) }, step.action[0]) : null);
  }));
}

// Claude 訂閱的模型選擇，新增模型與新增供應商共用。先確認 Claude CLI 已安裝、版本夠新、
// 已登入訂閱帳號，缺少的步驟可以直接在這裡處理；三項都通過才讀模型清單（讀清單不會送出推理請求）。
function claudeCliChooser({ onChange }) {
  const picker = modelPicker({ onChange, allowConfigured: true, idPattern: CLAUDE_CLI_MODEL_PATTERN,
    manualPlaceholder: "例如 claude-opus-5-5，可用逗號分隔" });
  const limits = limitFields({
    context: 1000000, output: NEW_MODEL_DEFAULTS.maxOutputTokens, maxContext: 1000000,
    contextHint: "Claude CLI 無法探測上下文，直接使用這個值（最多 1,000,000）。",
    outputHint: "以 CLAUDE_CODE_MAX_OUTPUT_TOKENS 傳給 Claude CLI；超過模型上限時，CLI 會自動壓到上限。",
  });
  const host = h("div", { class: "stack" });
  const element = h("div", { class: "stack" },
    paragraph("透過 Claude Code 登入的 Pro／Max 訂閱帳號使用 Claude 模型，不需要 API Key；用量依帳號方案計算（實驗性）。", "muted"),
    host);
  let phase = "idle";
  let request = 0;

  async function load() {
    const current = ++request;
    phase = "loading";
    host.replaceChildren(h("div", { class: "empty" }, h("span", { class: "spinner" }), " 正在檢查 Claude CLI…"));
    onChange();
    let info;
    try {
      info = await api("/api/query", { method: "POST", body: { type: "claude-cli" } });
    } catch (error) {
      if (current !== request) return;
      phase = "error";
      host.replaceChildren(h("div", { class: "empty" }, h("p", { text: "無法檢查 Claude CLI：" + error.message }),
        h("button", { type: "button", class: "button small", onclick: () => load() }, "重試")));
      onChange();
      return;
    }
    if (current !== request) return;
    if (!(info.installed && info.upToDate && info.subscription)) {
      phase = "blocked";
      host.replaceChildren(paragraph("添加模型前需要先完成以下準備：", "note"),
        claudeCliChecklist(info, (run) => run().then((view) => { if (view) load(); })));
      onChange();
      return;
    }
    phase = "ready";
    const source = h("div", { class: "note" });
    host.replaceChildren(h("div", { class: "result-ok" }, icon("check"), "Claude CLI " + info.version + "，已登入 Claude 訂閱帳號"),
      source, picker.element);
    picker.setLoading("正在讀取 Claude CLI 的模型清單（不會送出推理請求）…");
    onChange();
    try {
      const data = await api("/api/query", { method: "POST", body: { type: "claude-cli-models" } });
      if (current !== request) return;
      source.textContent = (data.fromCli
        ? "清單來自 Claude CLI，未列出的模型可以直接輸入完整 ID；不保證每個模型都有可用額度。"
        : "CLI 沒有提供可辨識的清單，以下是內建候選，尚未驗證帳號權限。") + (data.warning ? " " + data.warning : "");
      picker.setModels(data.choices.map((choice) => ({
        id: choice.id, label: choice.label, configured: choice.configured,
        note: choice.source === "configured" ? "既有設定，CLI 這次沒有列出" : null,
      })));
    } catch (error) {
      if (current === request) picker.setError("讀取失敗：" + error.message);
    }
  }
  return {
    element,
    limits,
    // 已就緒或正在檢查時不重複讀取；未就緒或出錯時重新檢查（使用者可能已在別處處理好）。
    ensure() { if (phase !== "ready" && phase !== "loading") load(); },
    ready: () => phase === "ready",
    selection: () => (phase === "ready" ? picker.selection() : []),
    invalidManual: () => (phase === "ready" ? picker.invalidManual() : []),
  };
}

// Claude 訂閱的確認步驟：列出要測試的模型與上下文、輸出設定，提醒會使用訂閱用量。
function showClaudeCliConfirm(modal, chooser, back) {
  const invalid = chooser.invalidManual();
  if (invalid.length) {
    toast("模型名稱只能是 opus、sonnet、haiku、fable 或完整 claude-* 名稱：" + invalid.join("、"), "error");
    return;
  }
  const models = chooser.selection();
  if (models.length === 0) return;
  if (models.length > 10) {
    toast("一次最多測試 10 個模型。", "error");
    return;
  }
  modal.setBody(
    paragraph("將用 Claude 訂閱帳號測試以下 " + models.length + " 個模型："),
    h("ul", { class: "plain-list" }, models.map((model) => h("li", { class: "mono", text: model }))),
    chooser.limits.nodes,
    globalContextBanner(),
    banner("warn", "alert", "每個模型會發送一次短測試並使用訂閱用量；只有通過的會添加，並固定使用回應中的完整模型版本。完成後會重新啟動路由器，進行中的對話會短暫重新連線。"));
  modal.setFoot(h("span", { class: "grow" }),
    h("button", { type: "button", class: "button", text: "上一步", onclick: back }),
    h("button", { type: "button", class: "button primary", text: "開始測試並添加", onclick: () => {
      const result = chooser.limits.read();
      if (result.error) { toast(result.error, "error"); return; }
      modal.close();
      runJob("claude-cli-add", { models, contextWindow: result.contextWindow, maxOutputTokens: result.maxOutputTokens },
        { title: "添加 Claude 訂閱模型" });
    } }));
}

// ---- 生圖 ----------------------------------------------------------------------

const API_MODE_LABELS = { images: "通用 Images API", "ark-task": "Ark 任務介面" };

function renderImagegen() {
  const blocked = writeBlocked();
  const entry = ensureQuery("imagegen");
  const head = pageHead("中轉 API 生圖", "用中轉供應商的圖片 API 生成或編輯圖片，適合免費帳號或內建生圖不可用的時候。Codex 裡以 $router-imagegen 技能使用，沿用路由器保存的憑證。",
    refreshButton("imagegen", "重新整理生圖狀態"));
  if (!entry.data) return [head, h("div", { class: "panel" }, queryPlaceholder(entry, "imagegen"))];
  const info = entry.data;
  const providers = state.providers || [];
  if (!imagegenDraft) {
    const fallbackProvider = providers.find((provider) => provider.id === info.providerId) || providers[0];
    imagegenDraft = {
      models: new Set(info.enabled ? info.models : ["gpt-image-2.5-flare"]),
      providerId: fallbackProvider ? fallbackProvider.id : null,
    };
  }
  const labels = new Map(info.choices.map((choice) => [choice.id, choice.label]));
  const parts = [head];
  if (info.error) parts.push(banner("error", "alert", info.error));

  const statusPanel = h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", { text: "目前狀態" }),
    info.enabled ? h("button", { type: "button", class: "button small danger", disabled: blocked, onclick: confirmDisableImagegen }, "停用") : null));
  if (info.enabled) {
    statusPanel.append(h("div", { class: "panel-body" }, h("dl", { class: "kv" },
      h("dt", { text: "狀態" }), h("dd", {}, h("span", { class: "chip green", text: "已啟用" })),
      h("dt", { text: "模型" }), h("dd", {}, info.models.map((model) => {
        const upstream = info.upstreamModels[model];
        return h("div", {}, h("span", { text: labels.get(model) || model }), h("span", { class: "faint mono", text: "  " + (upstream || model) }));
      })),
      h("dt", { text: "供應商" }), h("dd", { text: info.providerId || "—" }),
      h("dt", { text: "介面" }), h("dd", { text: API_MODE_LABELS[info.apiMode] || info.apiMode || "—" }),
      h("dt", { text: "技能位置" }), h("dd", { class: "mono", text: info.root }),
      h("dt", { text: "使用方式" }), h("dd", { text: "在 Codex 新任務輸入 $router-imagegen，或直接請它生圖；啟用多個模型時由 AI 依需求選擇。" }))));
  } else {
    statusPanel.append(h("div", { class: "panel-body" }, paragraph("尚未啟用。勾選下方的模型並偵測，通過的模型會加入 $router-imagegen 技能。", "muted")));
  }
  parts.push(statusPanel);

  const options = info.choices.map((choice) => {
    const box = h("input", { type: "checkbox", checked: imagegenDraft.models.has(choice.id), disabled: blocked });
    box.addEventListener("change", () => {
      if (box.checked) imagegenDraft.models.add(choice.id);
      else imagegenDraft.models.delete(choice.id);
      renderView();
    });
    return h("label", { class: "check-row option-row" }, box, h("div", { class: "pick-text" },
      h("div", { class: "model-name" }, h("span", { text: choice.label }), h("span", { class: "faint mono", text: choice.id }),
        info.enabled && info.models.includes(choice.id) ? h("span", { class: "chip green", text: "已啟用" }) : null),
      h("div", { class: "note", text: choice.description })));
  });
  const providerField = providers.length > 1 ? h("label", { class: "field" }, h("span", { text: "用哪一家供應商生圖" }),
    h("select", { disabled: blocked, onchange: (event) => { imagegenDraft.providerId = event.target.value; } },
      providers.map((provider) => h("option", { value: provider.id, selected: provider.id === imagegenDraft.providerId, text: provider.id + "（" + hostOf(provider.baseUrl) + "）" })))) : null;
  parts.push(h("div", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", { text: info.enabled ? "重新偵測" : "偵測並啟用" })),
    h("div", { class: "panel-body stack" },
      paragraph("多選時由 AI 依需求挑選：一般生圖與快速迭代偏好 Flare，精細改圖與保留原圖細節偏好 Sunburst；Image 2 給指定或相容需求使用。", "muted"),
      h("div", { class: "check-list" }, options),
      providerField,
      banner("warn", "alert", "偵測會實際生圖並依供應商計費：每個勾選的模型先用通用介面各生成一張低品質圖；全部失敗時，再用 Ark 任務介面各試一次。只有通過的模型會啟用，沒有通過時既有設定保持不變。"),
      h("div", { class: "actions end" },
        h("button", { type: "button", class: "button primary", disabled: blocked || imagegenDraft.models.size === 0, onclick: () => confirmImagegenSetup(info) },
          icon("image"), info.enabled ? "重新偵測並套用" : "偵測並啟用")))));

  if (info.lastCheck && info.lastCheck.checks.length) {
    parts.push(h("div", { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", { text: "最近一次偵測" }), h("span", { class: "note", text: formatTime(info.lastCheck.checkedAt) })),
      h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", { text: "介面" }), h("th", { text: "模型" }), h("th", { text: "結果" }))),
        h("tbody", {}, info.lastCheck.checks.map((check) => h("tr", {},
          h("td", { class: "nowrap", text: API_MODE_LABELS[check.apiMode] || check.apiMode }),
          h("td", { class: "mono", text: check.model }),
          h("td", {}, check.ok
            ? h("span", { class: "result-ok" }, icon("check"), "通過")
            : h("span", { class: "result-bad" }, icon("alert"), check.error || "未通過")))))))));
  }
  return parts;
}

function confirmImagegenSetup(info) {
  const chosen = info.choices.filter((choice) => imagegenDraft.models.has(choice.id));
  const providerId = imagegenDraft.providerId;
  confirmDialog({
    title: "偵測並啟用中轉生圖",
    confirmLabel: "開始偵測",
    body: [
      paragraph("將用「" + (providerId || "主要供應商") + "」實際生圖測試以下 " + chosen.length + " 個模型："),
      h("ul", { class: "plain-list" }, chosen.map((choice) => h("li", {}, choice.label, h("span", { class: "faint mono", text: "  " + choice.id })))),
      banner("warn", "alert", "會依供應商計費：通用介面每個模型一張低品質圖，全部失敗時 Ark 介面再各一張。生成失敗不會自動重送。"),
    ],
  }).then((ok) => {
    if (ok) runJob("imagegen-setup", { providerId, models: chosen.map((choice) => choice.id) }, { title: "偵測並啟用中轉生圖" });
  });
}

function confirmDisableImagegen() {
  confirmDialog({
    title: "停用中轉 API 生圖",
    danger: true,
    confirmLabel: "停用",
    body: paragraph("會把 $router-imagegen 技能封存到備份目錄，Codex 之後就不會再使用它；之後可以隨時重新偵測並啟用。"),
  }).then((ok) => { if (ok) runJob("imagegen-disable", {}, { title: "停用中轉生圖" }); });
}

// ---- 設定：全域上下文、隱藏的官方模型 --------------------------------------------

function renderSettings() {
  const blocked = writeBlocked();
  return [
    pageHead("設定", "影響所有模型的 Codex 設定。"),
    renderGlobalContextPanel(blocked),
    renderHiddenModelsPanel(blocked),
  ];
}

function renderGlobalContextPanel(blocked) {
  const entry = ensureQuery("global-context");
  const panel = h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", { text: "全域上下文" }),
    refreshButton("global-context", "重新整理全域上下文")));
  if (!entry.data) {
    panel.append(queryPlaceholder(entry, "global-context"));
    return panel;
  }
  const value = entry.data.value;
  panel.append(h("div", { class: "panel-body setting-body" },
    h("div", { class: "setting-value", text: value ? formatNumber(value) + " tokens" : "未設定" }),
    paragraph(value
      ? "Codex 的 model_context_window 已設定，會覆蓋所有模型（官方與自訂）自己的上下文；Codex 用到約 95% 時會自動壓縮。"
      : "目前沒有全域設定，每個模型使用自己的上下文（模型頁可以個別修改）。", "muted"),
    h("div", { class: "note mono", text: entry.data.filePath || "" }),
    h("div", { class: "actions" },
      h("button", { type: "button", class: "button primary", disabled: blocked, onclick: () => openGlobalContext(value) }, icon("edit"), value ? "修改" : "設定"),
      value ? h("button", { type: "button", class: "button danger", disabled: blocked, onclick: confirmClearGlobalContext }, "移除全域設定") : null)));
  return panel;
}

function openGlobalContext(current) {
  const input = h("input", { type: "number", min: String(TOKEN_LIMITS.minContext), max: String(TOKEN_LIMITS.maxContext), step: "1000",
    value: String(current || NEW_MODEL_DEFAULTS.contextWindow) });
  const presets = h("div", { class: "presets" }, [200000, 272000, 400000, 1000000].map((value) =>
    h("button", { type: "button", class: "button small", text: formatTokens(value), onclick: () => { input.value = String(value); } })));
  const desktopName = (state.desktop && state.desktop.name) || "桌面版";
  const modal = openModal({ title: "全域上下文", body: [
    h("label", { class: "field" }, h("span", { text: "model_context_window（tokens）" }), input, presets,
      h("span", { class: "hint", text: "範圍 16,000～4,000,000，對所有模型生效。上游實際支援的上下文較小時，對話可能在自動壓縮前就被上游拒絕。" })),
    paragraph("修改前會自動備份；不需要重新啟動路由器，重新啟動 " + desktopName + " 後生效。", "note"),
  ] });
  modal.setFoot(h("span", { class: "grow" }),
    h("button", { type: "button", class: "button", text: "取消", onclick: () => modal.close() }),
    h("button", { type: "button", class: "button primary", text: "儲存", onclick: () => {
      const value = Number(input.value.trim());
      if (!Number.isInteger(value) || value < TOKEN_LIMITS.minContext || value > TOKEN_LIMITS.maxContext) {
        toast("全域上下文必須是 16,000～4,000,000 之間的整數。", "error");
        return;
      }
      modal.close();
      if (value === current) { toast("沒有任何變更。"); return; }
      runJob("set-global-context", { value }, { title: "設定全域上下文" });
    } }));
}

function confirmClearGlobalContext() {
  confirmDialog({
    title: "移除全域上下文",
    danger: true,
    confirmLabel: "移除",
    body: paragraph("移除後每個模型改用自己的上下文：官方模型使用 Codex 內建值，自訂模型使用模型頁的設定。修改前會自動備份。"),
  }).then((ok) => { if (ok) runJob("set-global-context", { value: null }, { title: "移除全域上下文" }); });
}

function renderHiddenModelsPanel(blocked) {
  const entry = ensureQuery("hidden-models");
  const panel = h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", { text: "隱藏的官方模型" }),
    refreshButton("hidden-models", "重新整理隱藏的官方模型")));
  if (!entry.data) {
    panel.append(queryPlaceholder(entry, "hidden-models", "正在讀取 Codex 內建模型目錄…"));
    return panel;
  }
  const models = entry.data.models || [];
  const saved = new Set(models.filter((model) => model.forced).map((model) => model.slug));
  if (!hiddenDraft) hiddenDraft = new Set(saved);
  const dirty = models.some((model) => hiddenDraft.has(model.slug) !== saved.has(model.slug));
  const body = h("div", { class: "panel-body stack" },
    paragraph("Codex 內建目錄把下列模型標成隱藏，預設不會出現在選擇器。能不能用由帳號權限決定：強制顯示後若帳號沒有權限，選用時會失敗，取消勾選即可恢復。", "muted"));
  if (models.length === 0) {
    body.append(h("div", { class: "empty", text: "Codex 內建目錄目前沒有隱藏的官方模型。" }));
  } else {
    body.append(h("div", { class: "check-list" }, models.map((model) => {
      const box = h("input", { type: "checkbox", checked: hiddenDraft.has(model.slug), disabled: blocked });
      box.addEventListener("change", () => {
        if (box.checked) hiddenDraft.add(model.slug);
        else hiddenDraft.delete(model.slug);
        renderView();
      });
      return h("label", { class: "check-row option-row" }, box, h("div", { class: "pick-text" },
        h("div", { class: "model-name" }, h("span", { text: model.displayName }), h("span", { class: "faint mono", text: model.slug }),
          saved.has(model.slug) ? h("span", { class: "chip green", text: "目前強制顯示" }) : null),
        model.description ? h("div", { class: "note", text: model.description }) : null));
    })));
    body.append(h("div", { class: "actions end" },
      h("span", { class: "note", text: "儲存會重新啟動路由器，並以 Codex 實際讀到的目錄驗證；失敗會自動還原。" }),
      dirty ? h("button", { type: "button", class: "button", onclick: () => { hiddenDraft = null; renderView(); } }, "還原") : null,
      h("button", { type: "button", class: "button primary", disabled: blocked || !dirty, onclick: () => {
        runJob("set-hidden-models", { slugs: models.filter((model) => hiddenDraft.has(model.slug)).map((model) => model.slug) },
          { title: "設定隱藏的官方模型" });
      } }, "儲存")));
  }
  panel.append(body);
  return panel;
}

// ---- 對話框 ------------------------------------------------------------------

// 對話框可以疊開（例如在新增模型裡處理 Claude CLI，會再開確認框與操作記錄）；Esc 只關最上層那個。
const modalStack = [];
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && modalStack.length) modalStack[modalStack.length - 1].dismiss();
});

function openModal(options) {
  const { title, wide, dismissable = true, onClose } = options;
  const body = h("div", { class: "modal-body" });
  const foot = h("div", { class: "modal-foot" });
  const closeButton = h("button", { type: "button", class: "icon-button", "aria-label": "關閉", onclick: () => close() }, icon("close"));
  const titleNode = h("h3", { text: title });
  const modal = h("div", { class: "modal" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true" },
    h("div", { class: "modal-head" }, titleNode, closeButton), body, foot);
  const backdrop = h("div", { class: "modal-backdrop" }, modal);
  let canDismiss = dismissable;
  let closed = false;
  closeButton.hidden = !canDismiss;
  backdrop.addEventListener("mousedown", (event) => { if (event.target === backdrop && canDismiss) close(); });
  const entry = { dismiss: () => { if (canDismiss) close(); } };
  modalStack.push(entry);
  document.getElementById("modal-root").append(backdrop);
  modalCount += 1;
  const handle = {
    close,
    setTitle(text) { titleNode.textContent = text; },
    setBody(...nodes) { body.replaceChildren(...nodes.flat(Infinity).filter(Boolean)); },
    setFoot(...nodes) { foot.replaceChildren(...nodes.flat().filter(Boolean)); foot.hidden = foot.childNodes.length === 0; },
    setDismissable(value) { canDismiss = value; closeButton.hidden = !value; },
  };
  handle.setBody(options.body || []);
  handle.setFoot(options.foot || []);
  const focusTarget = modal.querySelector("input:not([type=checkbox]), select");
  if (focusTarget) setTimeout(() => focusTarget.focus(), 30);
  function close() {
    if (closed) return;
    closed = true;
    const index = modalStack.indexOf(entry);
    if (index >= 0) modalStack.splice(index, 1);
    backdrop.remove();
    modalCount -= 1;
    if (onClose) onClose();
  }
  return handle;
}

function confirmDialog({ title, body, confirmLabel = "確定", danger = false, extra }) {
  return new Promise((resolve) => {
    let answered = false;
    const modal = openModal({
      title,
      body: [body, extra || null].flat().filter(Boolean),
      onClose: () => { if (!answered) resolve(false); },
    });
    modal.setFoot(
      h("button", { type: "button", class: "button", text: "取消", onclick: () => modal.close() }),
      h("button", { type: "button", class: "button " + (danger ? "danger" : "primary"), text: confirmLabel, onclick: () => { answered = true; modal.close(); resolve(true); } }));
  });
}

function paragraph(text, className) {
  return h("p", { class: className || null, text });
}

// 背景工作：開一個記錄視窗輪詢輸出，結束後依結果提示重新啟動或重新整理。
async function runJob(type, params, { title } = {}) {
  let job;
  try {
    job = await api("/api/jobs", { method: "POST", body: { type, params } });
  } catch (error) {
    toast(error.message, "error");
    return null;
  }
  return watchJob(job, title);
}

function watchJob(job, title) {
  try { sessionStorage.setItem(JOB_KEY, JSON.stringify({ id: job.id, title: title || job.title })); } catch { /* 僅影響重新整理後的記錄視窗 */ }
  return new Promise((resolve) => {
    const log = h("pre", { class: "log", "aria-live": "polite" });
    const status = h("div", { class: "grow" }, h("span", { class: "spinner" }), "進行中，請勿關閉終端視窗…");
    const closeButton = h("button", { type: "button", class: "button", text: "請稍候", disabled: true });
    const modal = openModal({ title: title || job.title, wide: true, dismissable: false, body: [log], foot: [status, closeButton] });
    let offset = 0;
    const append = (text) => {
      if (!text) return;
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
      log.append(document.createTextNode(text));
      if (atBottom) log.scrollTop = log.scrollHeight;
    };
    append(job.output);
    offset = job.offset || 0;
    let failures = 0;
    const poll = async () => {
      let view;
      try {
        view = await api("/api/jobs/" + encodeURIComponent(job.id) + "?offset=" + offset);
        failures = 0;
      } catch (error) {
        if (error.status === 404 || failures > 40) {
          finish({ status: "failed", error: error.message, result: null });
          return;
        }
        failures += 1;
        setTimeout(poll, 1500);
        return;
      }
      append(view.output);
      offset = view.offset;
      if (view.status === "running") setTimeout(poll, 600);
      else finish(view);
    };
    const finish = (view) => {
      const ok = view.status === "succeeded";
      status.replaceChildren(ok
        ? h("span", { class: "result-ok" }, icon("check"), "完成")
        : h("span", { class: "result-bad" }, icon("alert"), view.error || "失敗"));
      const result = view.result || {};
      if (ok && result.restartDesktop) pendingDesktopRestart = true;
      if (ok && result.desktopRestarted) pendingDesktopRestart = false;
      if (result.desktopError || result.managerError) append("\n注意：" + (result.desktopError || result.managerError) + "\n");
      closeButton.disabled = false;
      closeButton.textContent = "關閉";
      closeButton.className = "button" + (ok ? " primary" : "");
      modal.setDismissable(true);
      closeButton.onclick = () => modal.close();
      resolve(view);
      if (ok && result.managerRestart) {
        restartManager({ alreadyRequested: true });
        return;
      }
      try { sessionStorage.removeItem(JOB_KEY); } catch { /* 忽略 */ }
      invalidateQueries();
      refreshState(true);
      refreshVersion();
      if (currentView === "overview") refreshErrors();
    };
    setTimeout(poll, 250);
  });
}

function showOverlay(text) {
  const message = h("div", { text });
  const overlay = h("div", { class: "overlay" }, h("div", { class: "overlay-box" }, h("span", { class: "spinner" }), message));
  document.body.append(overlay);
  return { overlay, message };
}

// 以程序識別碼確認交接，不需要先看到斷線（新程序可能在下一次輪詢前就已啟動）。
async function restartManager({ alreadyRequested = false } = {}) {
  if (restartingManager) return;
  restartingManager = true;
  const previousInstance = managerInstance;
  const { message } = showOverlay("更新完成，正在以新版本重新啟動管理頁…");
  try {
    if (!alreadyRequested) await api("/api/restart", { method: "POST" });
  } catch (error) {
    message.textContent = "無法自動重新啟動管理頁：" + error.message + "。請回到終端視窗，重新執行安裝器的 ui 命令。";
    return;
  }
  const started = Date.now();
  const tick = async () => {
    try {
      const response = await fetch("/api/ping", { method: "POST", cache: "no-store", headers: { "x-router-manager-token": token, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) });
      const data = response.ok ? await response.json() : null;
      if (data && data.instanceId && data.instanceId !== previousInstance) {
        location.reload();
        return;
      }
    } catch { /* 交接期間短暫無法連線，下次再試 */ }
    if (Date.now() - started > 120000) {
      message.textContent = "管理頁尚未恢復。請重新整理，或重新開啟「Codex 模型路由器」捷徑查看診斷。";
      message.parentNode.append(h("button", { type: "button", class: "button", text: "重新整理", onclick: () => location.reload() }));
      return;
    }
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 800);
}

// ---- 模型：新增、刪除、修改 -----------------------------------------------------

// allowConfigured：已添加的模型也能再選（Claude CLI 可重新設定）；idPattern：手動輸入的格式。
function modelPicker({ onChange, allowConfigured = false, idPattern = MODEL_ID_PATTERN,
  manualPlaceholder = "清單沒有列出的模型 ID，可用逗號分隔" } = {}) {
  let models = [];
  let filter = "";
  const chosen = new Set();
  const locked = (model) => model.configured && !allowConfigured;
  const list = h("div", { class: "check-list" });
  const search = h("input", { type: "search", placeholder: "搜尋模型 ID", "aria-label": "搜尋模型", oninput: (event) => { filter = event.target.value.trim().toLowerCase(); draw(); } });
  const matches = (model) => (model.id + " " + (model.label || "")).toLowerCase().includes(filter);
  const toggleAll = h("button", { type: "button", class: "button small", text: "全選可用", onclick: () => {
    const visible = models.filter((model) => !locked(model) && matches(model));
    const all = visible.every((model) => chosen.has(model.id));
    for (const model of visible) all ? chosen.delete(model.id) : chosen.add(model.id);
    draw();
    onChange();
  } });
  const manual = h("input", { type: "text", placeholder: manualPlaceholder, oninput: () => onChange() });
  const element = h("div", { class: "field" },
    h("div", { class: "list-toolbar" }, search, toggleAll),
    list,
    h("label", { class: "field" }, h("span", { text: "手動輸入模型 ID（選填）" }), manual));
  function draw(statusNode) {
    if (statusNode) {
      list.replaceChildren(statusNode);
      return;
    }
    const visible = models.filter(matches);
    if (visible.length === 0) {
      list.replaceChildren(h("div", { class: "empty", text: models.length ? "沒有符合搜尋的模型。" : "清單是空的；仍可在下方手動輸入模型 ID。" }));
      return;
    }
    list.replaceChildren(...visible.map((model) => {
      const box = h("input", { type: "checkbox", checked: chosen.has(model.id) || locked(model), disabled: locked(model) });
      box.addEventListener("change", () => { box.checked ? chosen.add(model.id) : chosen.delete(model.id); onChange(); });
      return h("label", { class: "check-row" + (locked(model) ? " disabled" : "") }, box,
        h("span", { class: "pick-text" }, h("span", { class: "mono", text: model.id }),
          model.label && model.label !== model.id ? h("span", { class: "faint", text: model.label }) : null),
        model.configured ? h("span", { class: "chip", text: allowConfigured ? "已添加，可重新設定" : "已添加" }) : null,
        model.note ? h("span", { class: "chip amber", text: model.note }) : null,
        !model.configured && model.anthropic ? h("span", { class: "chip violet", text: "Claude 轉譯" }) : null);
    }));
  }
  return {
    element,
    setLoading(text) { draw(h("div", { class: "empty" }, h("span", { class: "spinner" }), " " + (text || "正在查詢模型清單…"))); },
    setError(text) { draw(h("div", { class: "empty", text })); },
    setModels(next) { models = next || []; chosen.clear(); draw(); onChange(); },
    selection() {
      const extra = manual.value.split(/[,，\s]+/).map((value) => value.trim()).filter(Boolean);
      const excluded = new Set(models.filter(locked).map((model) => model.id));
      return [...new Set([...chosen, ...extra])].filter((id) => !excluded.has(id));
    },
    invalidManual() {
      return manual.value.split(/[,，\s]+/).map((value) => value.trim()).filter(Boolean).filter((id) => !idPattern.test(id));
    },
  };
}

function probeWarning(count, restartNote) {
  return banner("warn", "alert",
    "每個模型最多送出五次小型請求來確認可用的推理強度（Claude 模型另有幾次能力探測），可能依供應商計費。共 " + count + " 個模型；只有通過探測的才會加入。" + (restartNote ? "完成後會重新啟動路由器，進行中的對話會短暫重新連線。" : ""));
}

function globalContextBanner() {
  return state.config && state.config.modelContextWindow
    ? banner("warn", "alert", "目前設有全域 model_context_window = " + formatNumber(state.config.modelContextWindow) + "，它會覆蓋各模型的上下文設定。")
    : null;
}

// 上下文與最大輸出的輸入欄，修改與新增共用。read() 驗證後回傳數字；欄位留空回傳 null。
function limitFields({ context, output, maxContext = TOKEN_LIMITS.maxContext, outputCap = null, showOutput = true, contextHint, outputHint }) {
  const outputMax = outputCap || TOKEN_LIMITS.maxOutput;
  const contextInput = h("input", { type: "number", min: String(TOKEN_LIMITS.minContext), max: String(maxContext), step: "1000", value: context ? String(context) : "", placeholder: "例如 1000000" });
  const outputInput = h("input", { type: "number", min: String(TOKEN_LIMITS.minOutput), max: String(outputMax), step: "1000", value: output ? String(output) : "", placeholder: "例如 128000" });
  const presets = (input, values) => h("div", { class: "presets" }, values.map((value) =>
    h("button", { type: "button", class: "button small", text: formatTokens(value), onclick: () => { input.value = String(value); } })));
  const contextField = h("label", { class: "field" }, h("span", { text: "上下文上限（tokens）" }), contextInput,
    presets(contextInput, [128000, 200000, 272000, 400000, 1000000].filter((value) => value <= maxContext)),
    contextHint ? h("span", { class: "hint", text: contextHint }) : null);
  const outputField = showOutput ? h("label", { class: "field" }, h("span", { text: "最大輸出（tokens）" }), outputInput,
    presets(outputInput, [32000, 64000, 128000].filter((value) => value <= outputMax)),
    outputHint ? h("span", { class: "hint", text: outputHint }) : null) : null;
  const parse = (input, label, min, max) => {
    const raw = input.value.trim();
    if (!raw) return { value: null };
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      return { error: label + "必須是 " + formatNumber(min) + "～" + formatNumber(max) + " 之間的整數。" };
    }
    return { value };
  };
  return {
    nodes: [h("div", { class: "limit-grid" }, contextField, outputField)],
    read() {
      const contextResult = parse(contextInput, "上下文上限", TOKEN_LIMITS.minContext, maxContext);
      if (contextResult.error) return contextResult;
      if (!showOutput) return { contextWindow: contextResult.value, maxOutputTokens: null };
      if (outputCap && Number(outputInput.value) > outputCap) {
        return { error: "最大輸出不能超過這個模型的輸出上限 " + formatNumber(outputCap) + "。" };
      }
      const outputResult = parse(outputInput, "最大輸出", TOKEN_LIMITS.minOutput, outputMax);
      if (outputResult.error) return outputResult;
      const contextLimit = contextResult.value ?? context;
      if (outputResult.value != null && contextLimit && outputResult.value > contextLimit) {
        return { error: "最大輸出不能超過上下文上限。" };
      }
      return { contextWindow: contextResult.value, maxOutputTokens: outputResult.value };
    },
  };
}

// 新增模型與新增供應商的確認步驟共用：預先填入 1M／128000。
function newModelLimitFields() {
  return limitFields({
    context: NEW_MODEL_DEFAULTS.contextWindow,
    output: NEW_MODEL_DEFAULTS.maxOutputTokens,
    contextHint: "GPT、Chat 模型探測不到上下文，直接使用這個值；Claude 模型探測到的上限較小時以上游為準。",
    outputHint: "只用於 Claude 模型（送往 Claude 的 max_tokens），上游回報的上限較小時以上游為準；GPT 與 Chat 模型的輸出由上游決定。",
  });
}

function openAddModels(initialProviderId) {
  const providers = state.providers || [];
  let providerId = initialProviderId || (providers[0] ? providers[0].id : CLAUDE_CLI_ID);
  let requestId = 0;
  const isCli = () => providerId === CLAUDE_CLI_ID;
  const count = h("span", { class: "grow" });
  const nextButton = h("button", { type: "button", class: "button primary", text: "下一步", disabled: true });
  const cancelButton = h("button", { type: "button", class: "button", text: "取消" });
  const picker = modelPicker({ onChange: updateCount });
  const cli = claudeCliChooser({ onChange: updateCount });
  const providerSelect = h("label", { class: "field" }, h("span", { text: "供應商" }),
    h("select", { onchange: (event) => { providerId = event.target.value; showStepOne(); load(); } },
      providers.map((provider) => h("option", { value: provider.id, selected: provider.id === providerId, text: provider.id + "（" + hostOf(provider.baseUrl) + "）" })),
      h("option", { value: CLAUDE_CLI_ID, selected: isCli(), text: "Claude 訂閱（Claude CLI，實驗性）" })));
  const intro = paragraph("選擇供應商與要添加的模型。", "muted");
  const limits = newModelLimitFields();
  const modal = openModal({ title: "新增模型", wide: true, body: stepOneBody() });
  cancelButton.onclick = () => modal.close();
  showStepOne();
  load();

  function stepOneBody() {
    return [intro, providerSelect, isCli() ? cli.element : picker.element];
  }
  function showStepOne() {
    modal.setBody(stepOneBody());
    modal.setFoot(count, cancelButton, nextButton);
    nextButton.onclick = () => (isCli() ? showClaudeCliConfirm(modal, cli, showStepOne) : confirmStep());
    updateCount();
  }
  function updateCount() {
    if (isCli() && !cli.ready()) {
      count.textContent = "完成 Claude CLI 的準備後才能選擇模型";
      nextButton.disabled = true;
      return;
    }
    const total = (isCli() ? cli : picker).selection().length;
    count.textContent = total ? "已選 " + total + " 個模型" : "尚未選擇模型";
    nextButton.disabled = total === 0;
  }
  async function load() {
    if (isCli()) {
      cli.ensure();
      return;
    }
    const current = ++requestId;
    picker.setLoading();
    try {
      const data = await api("/api/discover", { method: "POST", body: { providerId } });
      if (current === requestId) picker.setModels(data.models);
    } catch (error) {
      if (current === requestId) picker.setError("查詢失敗：" + error.message);
    }
  }
  function confirmStep() {
    const invalid = picker.invalidManual();
    if (invalid.length) {
      toast("模型 ID 格式無效：" + invalid.join("、"), "error");
      return;
    }
    const models = picker.selection();
    modal.setBody(
      paragraph("將向「" + providerId + "」探測以下 " + models.length + " 個模型："),
      h("ul", { class: "plain-list" }, models.map((model) => h("li", { class: "mono", text: model }))),
      limits.nodes,
      globalContextBanner(),
      probeWarning(models.length, true));
    modal.setFoot(h("span", { class: "grow" }),
      h("button", { type: "button", class: "button", text: "上一步", onclick: showStepOne }),
      h("button", { type: "button", class: "button primary", text: "開始探測並添加", onclick: () => {
        const result = limits.read();
        if (result.error) { toast(result.error, "error"); return; }
        modal.close();
        runJob("add-models", { providerId, models, contextWindow: result.contextWindow, maxOutputTokens: result.maxOutputTokens },
          { title: "添加模型：" + providerId });
      } }));
  }
}

function confirmRemoveModels(slugs) {
  const models = (state.models || []).filter((model) => slugs.includes(model.slug));
  if (models.length === 0) return;
  const includesDefault = state.config && models.some((model) => model.slug === state.config.model);
  confirmDialog({
    title: "刪除 " + models.length + " 個模型",
    danger: true,
    confirmLabel: "刪除",
    body: [
      paragraph("以下模型會從 Codex 選擇器移除："),
      h("ul", { class: "plain-list" }, models.map((model) => h("li", {}, model.displayName, h("span", { class: "faint mono", text: "  " + model.upstreamModel })))),
      includesDefault ? banner("warn", "alert", "其中包含全域預設模型，刪除後會一併清除這個預設，改用官方預設模型。") : null,
      paragraph("使用這些模型的既有任務需切換到其他模型才能繼續。刪除前會自動備份，接著重新啟動路由器。", "note"),
    ],
  }).then(async (ok) => {
    if (!ok) return;
    const view = await runJob("remove-models", { slugs: models.map((model) => model.slug) }, { title: "刪除模型" });
    if (view && view.status === "succeeded") selected.clear();
    renderView();
  });
}

function openEditModel(model) {
  const maxContext = model.transport === "claude-cli" ? 1000000 : TOKEN_LIMITS.maxContext;
  const name = h("input", { type: "text", value: model.displayName, maxlength: "80" });
  const limits = limitFields({
    context: model.contextWindow,
    output: model.outputTokens,
    maxContext,
    outputCap: model.outputCapFixed ? model.outputCap : null,
    showOutput: model.outputConfigurable,
    contextHint: "範圍 16,000～" + formatNumber(maxContext) + "。Codex 用到約 95% 時會自動壓縮。",
    outputHint: model.transport === "claude-cli"
      ? "每次回覆最多可輸出的 tokens，以 CLAUDE_CODE_MAX_OUTPUT_TOKENS 傳給 Claude CLI；超過模型上限時，CLI 會自動壓到上限。"
      : "每次回覆最多可輸出的 tokens（送往 Claude 的 max_tokens）。" +
        (model.outputCap ? "模型上限 " + formatNumber(model.outputCap) + "。" : "上游沒有回報上限，設得比模型上限大時上游會拒絕。"),
  });
  const contextSource = model.contextSource === "template" ? "沿用官方模板（未實測）" : "已設定（探測、新增時的預設值或手動修改）";
  const info = h("dl", { class: "kv" },
    h("dt", { text: "上游模型" }), h("dd", { class: "mono", text: model.upstreamModel }),
    h("dt", { text: "選擇器 ID" }), h("dd", { class: "mono", text: model.slug }),
    h("dt", { text: "供應商" }), h("dd", { text: providerLabel(model.providerId) }),
    h("dt", { text: "介面" }), h("dd", {}, transportChip(model.transport)),
    h("dt", { text: "上下文來源" }), h("dd", { text: contextSource }),
    model.outputConfigurable ? null : h("dt", { text: "輸出" }),
    model.outputConfigurable ? null : h("dd", { text: "由上游決定：這個介面不送出輸出上限，因此不需要設定。" }));
  const desktopName = (state.desktop && state.desktop.name) || "桌面版";
  const body = [
    h("label", { class: "field" }, h("span", { text: "顯示名稱" }), name, h("span", { class: "hint", text: "只影響選擇器裡顯示的名稱；上游模型 ID 與選擇器 ID 不變。" })),
    limits.nodes,
    globalContextBanner(),
    info,
    paragraph(model.outputConfigurable
      ? "名稱與上下文不需要重新啟動路由器，重新啟動 " + desktopName + " 後生效；修改輸出會重新啟動路由器，進行中的回應會短暫重新連線。"
      : "不重新探測、不重新啟動路由器；重新啟動 " + desktopName + " 後生效。", "note"),
  ];
  const modal = openModal({ title: "修改模型", body });
  modal.setFoot(h("span", { class: "grow" }),
    h("button", { type: "button", class: "button", text: "取消", onclick: () => modal.close() }),
    h("button", { type: "button", class: "button primary", text: "儲存", onclick: () => {
      const displayName = name.value.trim();
      if (!displayName) { toast("顯示名稱不能是空白。", "error"); return; }
      const result = limits.read();
      if (result.error) { toast(result.error, "error"); return; }
      // 只送出有變動的值：沒動過的上下文維持原本的來源，沒動過的輸出也不會重啟路由器。
      const params = { slug: model.slug, displayName };
      if (result.contextWindow != null && result.contextWindow !== model.contextWindow) params.contextWindow = result.contextWindow;
      if (result.maxOutputTokens != null && result.maxOutputTokens !== model.outputTokens) params.maxOutputTokens = result.maxOutputTokens;
      if (displayName === model.displayName && !("contextWindow" in params) && !("maxOutputTokens" in params)) {
        modal.close();
        toast("沒有任何變更。");
        return;
      }
      modal.close();
      runJob("edit-model", params, { title: "修改模型：" + displayName });
    } }));
}

// ---- 供應商：新增、更換 Key、移除 ------------------------------------------------

// 新增供應商的類型選項。
function typeOption(iconName, title, chip, description, onclick) {
  return h("button", { type: "button", class: "type-option", onclick },
    icon(iconName),
    h("span", { class: "grow" },
      h("span", { class: "title" }, h("span", { text: title }), chip ? h("span", { class: "chip violet", text: chip }) : null),
      h("span", { class: "note", text: description })),
    icon("chevronRight"));
}

function openAddProvider() {
  const baseUrl = h("input", { type: "url", placeholder: "https://api.example.com/v1", autocomplete: "off", spellcheck: "false" });
  const apiKey = h("input", { type: "password", placeholder: "sk-…", autocomplete: "new-password", spellcheck: "false" });
  const status = h("span", { class: "grow" });
  const nextButton = h("button", { type: "button", class: "button primary", text: "查詢模型" });
  const cancelButton = h("button", { type: "button", class: "button", text: "取消" });
  const stepOne = [
    paragraph("填入兼容 OpenAI 的 Base URL 與 API Key，先查詢它提供的模型清單（不會花費額度）。", "muted"),
    h("label", { class: "field" }, h("span", { text: "Base URL" }), baseUrl),
    h("label", { class: "field" }, h("span", { text: "API Key" }), apiKey,
      h("span", { class: "hint", text: state.platform === "win32"
        ? "Key 只會以 Windows 憑證保護（DPAPI）加密儲存，不會寫進設定檔，也不會再顯示在頁面上。"
        : "Key 只會存進 macOS 鑰匙圈，不會寫進設定檔，也不會再顯示在頁面上。" })),
  ];
  const backButton = h("button", { type: "button", class: "button", text: "上一步" });
  const modal = openModal({ title: "新增供應商", wide: true });
  cancelButton.onclick = () => modal.close();
  backButton.onclick = () => showTypeChoice();
  let draft = null;
  const picker = modelPicker({ onChange: updateStepTwo });
  const providerName = h("input", { type: "text", maxlength: "24", spellcheck: "false", oninput: updateStepTwo });
  const nameField = h("label", { class: "field" }, h("span", { text: "供應商名稱" }), providerName,
    h("span", { class: "hint", text: "小寫英文、數字與連字號。只用於管理，並替沒有前綴的模型補上名稱（例如 名稱/模型）。" }));
  const count = h("span", { class: "grow" });
  const addButton = h("button", { type: "button", class: "button primary", text: "下一步", disabled: true });
  const limits = newModelLimitFields();
  const cli = claudeCliChooser({ onChange: updateCli });
  const cliCount = h("span", { class: "grow" });
  const cliNext = h("button", { type: "button", class: "button primary", text: "下一步", disabled: true });
  cliNext.onclick = () => showClaudeCliConfirm(modal, cli, showClaudeCli);

  nextButton.onclick = async () => {
    if (!baseUrl.value.trim() || !apiKey.value.trim()) {
      toast("請填寫 Base URL 與 API Key。", "error");
      return;
    }
    nextButton.disabled = true;
    status.replaceChildren(h("span", { class: "spinner" }), "正在查詢模型清單…");
    try {
      draft = await api("/api/provider-draft", { method: "POST", body: { baseUrl: baseUrl.value.trim(), apiKey: apiKey.value } });
      apiKey.value = "";
      showStepTwo();
    } catch (error) {
      status.replaceChildren(h("span", { class: "result-bad" }, icon("alert"), error.message));
      nextButton.disabled = false;
    }
  };

  showTypeChoice();

  function showTypeChoice() {
    const connected = (state.models || []).filter((model) => model.transport === "claude-cli").length;
    modal.setTitle("新增供應商");
    modal.setBody(
      paragraph("選擇要新增的供應商類型。", "muted"),
      h("div", { class: "type-choices" },
        typeOption("providers", "OpenAI 相容 API", null,
          "中轉站、閘道或其他兼容 OpenAI 的服務，用 Base URL 與 API Key 連接；可添加 GPT、Claude 與只支援 Chat Completions 的模型。",
          showRelayForm),
        typeOption("claude", "Claude 訂閱帳號（Claude CLI）", "實驗性",
          "透過 Claude Code 登入的 Pro／Max 訂閱帳號使用 Claude 模型，不需要 API Key；用量依帳號方案計算。" +
            (connected ? "已連接 " + connected + " 個模型，可以再添加。" : ""),
          showClaudeCli)));
    modal.setFoot(h("span", { class: "grow" }), cancelButton);
  }
  function showRelayForm() {
    modal.setTitle("新增供應商：OpenAI 相容 API");
    modal.setBody(stepOne);
    modal.setFoot(status, backButton, nextButton);
    setTimeout(() => baseUrl.focus(), 30);
  }
  function showClaudeCli() {
    modal.setTitle("新增供應商：Claude 訂閱帳號");
    modal.setBody(cli.element);
    modal.setFoot(cliCount, backButton, cliNext);
    cli.ensure();
    updateCli();
  }
  function updateCli() {
    if (!cli.ready()) {
      cliCount.textContent = "完成上面的準備後才能選擇模型";
      cliNext.disabled = true;
      return;
    }
    const total = cli.selection().length;
    cliCount.textContent = total ? "已選 " + total + " 個模型" : "尚未選擇模型";
    cliNext.disabled = total === 0;
  }
  function showStepTwo() {
    providerName.value = draft.suggestedId || "";
    modal.setTitle("新增供應商：" + hostOf(draft.baseUrl));
    modal.setBody(paragraph("API 根地址：" + draft.apiRoot, "muted mono"), picker.element, nameField);
    modal.setFoot(count, h("button", { type: "button", class: "button", text: "取消", onclick: () => modal.close() }), addButton);
    picker.setModels(draft.models);
    addButton.onclick = confirmStep;
    updateStepTwo();
  }
  function needsName() {
    const models = picker.selection();
    return models.length === 0 || models.some((model) => !model.includes("/"));
  }
  function nameProblem() {
    if (!needsName()) return null;
    const value = providerName.value.trim().toLowerCase();
    if (!PROVIDER_ID_PATTERN.test(value)) return "名稱只能用小寫英文、數字與連字號，1～24 個字元，不能以連字號開頭或結尾。";
    if (RESERVED_PROVIDER_IDS.has(value)) return "「" + value + "」是保留名稱，請換一個。";
    if ((state.providers || []).some((provider) => provider.id === value)) return "已經有叫「" + value + "」的供應商了。";
    return null;
  }
  function updateStepTwo() {
    if (!draft) return;
    const total = picker.selection().length;
    nameField.hidden = !needsName();
    const problem = total ? nameProblem() : null;
    count.textContent = problem || (total ? "已選 " + total + " 個模型" : "尚未選擇模型");
    count.className = "grow" + (problem ? " note warn" : "");
    addButton.disabled = total === 0 || Boolean(problem);
  }
  function confirmStep() {
    const invalid = picker.invalidManual();
    if (invalid.length) {
      toast("模型 ID 格式無效：" + invalid.join("、"), "error");
      return;
    }
    const models = picker.selection();
    const providerId = needsName() ? providerName.value.trim().toLowerCase() : null;
    modal.setBody(
      paragraph("將新增供應商" + (providerId ? "「" + providerId + "」" : "（所選模型已有前綴，管理名稱自動產生）") + "，並探測以下 " + models.length + " 個模型："),
      h("ul", { class: "plain-list" }, models.map((model) => h("li", { class: "mono", text: model }))),
      limits.nodes,
      globalContextBanner(),
      probeWarning(models.length, true));
    modal.setFoot(h("span", { class: "grow" }),
      h("button", { type: "button", class: "button", text: "上一步", onclick: showStepTwo }),
      h("button", { type: "button", class: "button primary", text: "開始探測並新增", onclick: () => {
        const result = limits.read();
        if (result.error) { toast(result.error, "error"); return; }
        modal.close();
        runJob("add-provider", {
          draftId: draft.draftId, models, providerId, contextWindow: result.contextWindow, maxOutputTokens: result.maxOutputTokens,
        }, { title: "新增供應商" });
      } }));
  }
}

function openReplaceKey(provider) {
  const apiKey = h("input", { type: "password", placeholder: "新的 API Key", autocomplete: "new-password", spellcheck: "false" });
  const modal = openModal({
    title: "更換 API Key：" + provider.id,
    body: [
      h("dl", { class: "kv" }, h("dt", { text: "Base URL" }), h("dd", { class: "mono", text: provider.baseUrl || "—" })),
      h("label", { class: "field" }, h("span", { text: "新的 API Key" }), apiKey),
      paragraph("會先用新 Key 查詢模型清單：上游明確拒絕（401／403）時不會更換。路由器會自動改用新 Key，不需要重新啟動。", "note"),
    ],
  });
  modal.setFoot(h("span", { class: "grow" }),
    h("button", { type: "button", class: "button", text: "取消", onclick: () => modal.close() }),
    h("button", { type: "button", class: "button primary", text: "驗證並儲存", onclick: () => {
      const value = apiKey.value.trim();
      if (!value) { toast("請填寫新的 API Key。", "error"); return; }
      apiKey.value = "";
      modal.close();
      runJob("replace-key", { providerId: provider.id, apiKey: value }, { title: "更換 API Key：" + provider.id });
    } }));
}

function confirmRemoveProvider(provider) {
  const models = (state.models || []).filter((model) => model.providerId === provider.id);
  const includesDefault = state.config && models.some((model) => model.slug === state.config.model);
  const others = (state.providers || []).filter((item) => item.id !== provider.id);
  const imagegen = state.imagegen && !state.imagegen.error && state.imagegen.providerId === provider.id;
  const deleteKey = h("input", { type: "checkbox", checked: true });
  confirmDialog({
    title: "移除供應商「" + provider.id + "」",
    danger: true,
    confirmLabel: "移除",
    body: [
      paragraph(models.length ? "會一併移除它的 " + models.length + " 個模型：" : "這家供應商目前沒有模型。"),
      models.length ? h("ul", { class: "plain-list" }, models.map((model) => h("li", { text: model.displayName }))) : null,
      provider.primary && others[0] ? banner("info", "info", "移除後由「" + others[0].id + "」擔任主要供應商。") : null,
      includesDefault ? banner("warn", "alert", "其中包含全域預設模型，移除後會一併清除這個預設。") : null,
      imagegen ? banner("warn", "alert", "中轉 API 生圖使用這家供應商，會一併停用；之後可在終端選單重新設定。") : null,
      h("label", { class: "check-line" }, deleteKey, h("span", { text: "同時刪除這家的 API Key" })),
      paragraph("移除前會自動備份，接著重新啟動路由器。", "note"),
    ],
  }).then((ok) => {
    if (!ok) return;
    runJob("remove-provider", { providerId: provider.id, deleteKey: deleteKey.checked }, { title: "移除供應商：" + provider.id });
  });
}

// ---- 重新啟動 ----------------------------------------------------------------

function confirmRestartRouter() {
  confirmDialog({
    title: "重新啟動路由器",
    confirmLabel: "重新啟動",
    body: paragraph("進行中的回應會中斷，Codex 會自動重新連線並重試。通常不需要這麼做；路由器無回應或更新後版本沒換時再用。"),
  }).then((ok) => { if (ok) runJob("restart-router", {}, { title: "重新啟動路由器" }); });
}

function confirmRestartDesktop() {
  const name = (state.desktop && state.desktop.name) || "桌面版";
  confirmDialog({
    title: "重新啟動 " + name,
    confirmLabel: "重新啟動",
    danger: true,
    body: [
      paragraph("會正常結束 " + name + " 再重新打開，讓模型選擇器載入最新設定。"),
      banner("warn", "alert", "進行中的任務會被中斷；若 macOS 詢問是否允許控制「" + name + "」，請選擇允許。"),
    ],
  }).then(async (ok) => {
    if (!ok) return;
    const view = await runJob("restart-desktop", {}, { title: "重新啟動 " + name });
    if (view && view.status === "succeeded" && view.result && view.result.desktopRestarted) {
      pendingDesktopRestart = false;
      renderBanners();
    }
  });
}

// ---- 版本選單 ----------------------------------------------------------------

let popoverOpen = false;

function togglePopover(force) {
  popoverOpen = force == null ? !popoverOpen : force;
  const popover = document.getElementById("version-popover");
  const badge = document.getElementById("version-badge");
  badge.setAttribute("aria-expanded", String(popoverOpen));
  popover.hidden = !popoverOpen;
  if (popoverOpen) {
    renderPopover();
    positionPopover();
    if (!versionInfo) refreshVersion();
  }
}

function positionPopover() {
  const popover = document.getElementById("version-popover");
  const rect = document.getElementById("version-badge").getBoundingClientRect();
  const width = popover.offsetWidth || 344;
  popover.style.left = Math.max(12, Math.min(rect.left - 8, window.innerWidth - width - 12)) + "px";
  popover.style.top = (rect.bottom + 10) + "px";
}

function renderPopover() {
  const popover = document.getElementById("version-popover");
  if (!popoverOpen) return;
  const info = versionInfo;
  const refreshButton = h("button", { type: "button", class: "icon-button", title: "重新檢查", "aria-label": "重新檢查更新" }, icon("refresh"));
  refreshButton.onclick = async () => {
    refreshButton.classList.add("spin");
    refreshButton.disabled = true;
    await refreshVersion(true);
  };
  const head = h("div", { class: "popover-head" }, h("span", { text: "目前版本" }), refreshButton);
  const body = h("div", { class: "popover-body" });
  if (!info) {
    body.append(h("div", { class: "status-line" }, h("span", { class: "spinner" }), " 正在檢查…"));
    popover.replaceChildren(head, body);
    return;
  }
  const version = info.installed || info.manager;
  const update = info.status === "update-available";
  const iconClass = update ? "update" : info.status === "unknown" ? "unknown" : "ok";
  const iconName = update ? "arrowUp" : info.status === "unknown" ? "question" : "check";
  body.append(h("div", { class: "big-version" }, "v" + version, h("span", { class: "status-icon " + iconClass }, icon(iconName))));
  const statusText = update ? "有新版本 v" + info.latest
    : info.status === "latest" ? "已是最新版本"
    : info.status === "ahead" ? "比 GitHub 上的 v" + info.latest + " 更新"
    : (info.error || "無法確認最新版本");
  body.append(h("div", { class: "status-line", text: statusText }));
  if (info.checkedAt) body.append(h("div", { class: "status-line faint", text: "檢查於 " + formatTime(info.checkedAt) }));

  const section = h("div", { class: "popover-section" });
  if (info.router && info.installed && info.router !== info.installed) {
    section.append(banner("warn", "alert", "路由器仍在執行 v" + info.router + "，請重新啟動路由器套用 v" + info.installed + "。",
      h("button", { type: "button", class: "button small", onclick: () => { togglePopover(false); confirmRestartRouter(); } }, "重新啟動")));
  }
  const releases = (info.releases || []).slice().reverse();
  if (releases.length) {
    section.append(h("div", { class: "changes" }, releases.map((release) => [
      h("h4", { text: "v" + release.version + (release.date ? "（" + release.date + "）" : "") + (update ? "" : " 更新內容") }),
      h("ul", {}, release.changes.map((change) => h("li", { text: change }))),
    ])));
  }
  if (update) {
    const restart = h("input", { type: "checkbox", checked: Boolean(info.canRestartDesktop), disabled: !info.canRestartDesktop });
    section.append(
      info.canRestartDesktop
        ? h("label", { class: "check-line" }, restart, h("span", { text: "完成後重新啟動 " + info.desktopName + "（會中斷進行中的任務）" }))
        : paragraph("更新完成後請完全退出並重新打開 " + info.desktopName + "。", "note"),
      h("button", { type: "button", class: "button primary", onclick: () => { togglePopover(false); confirmUpdate("update", info, restart.checked && info.canRestartDesktop); } },
        icon("arrowUp"), info.canRestartDesktop ? "更新並重新啟動" : "立即更新"));
  } else if (info.localNewer) {
    section.append(
      paragraph("這個管理頁是 v" + info.manager + "，比已安裝的 v" + info.installed + " 新。", "note"),
      h("button", { type: "button", class: "button primary", onclick: () => { togglePopover(false); confirmUpdate("apply-update", info, false); } }, icon("arrowUp"), "套用 v" + info.manager));
  }
  if (section.childNodes.length) body.append(section);
  const link = h("a", { class: "popover-link", href: update || info.status === "latest" ? info.releaseUrl : info.releasesUrl, target: "_blank", rel: "noopener noreferrer" }, icon("github"), "查看發佈");
  body.append(link);
  popover.replaceChildren(head, body);
}

function confirmUpdate(type, info, restartDesktop) {
  const target = type === "update" ? info.latest : info.manager;
  confirmDialog({
    title: "更新到 v" + target,
    confirmLabel: restartDesktop ? "更新並重新啟動" : "開始更新",
    body: [
      paragraph(type === "update"
        ? "會從 GitHub 下載 v" + target + " 的安裝器並核對 SHA256，再執行 update："
        : "會以這個管理頁的安裝器執行 update："),
      h("ul", { class: "plain-list" },
        h("li", { text: "換掉路由器與轉譯層程式碼，保留所有模型、供應商與 API Key" }),
        h("li", { text: "重新啟動路由器（進行中的回應會短暫重新連線）" }),
        type === "update" ? h("li", { text: "管理頁以新版本重新載入" }) : null,
        restartDesktop ? h("li", { text: "最後重新啟動 " + info.desktopName + "（會中斷進行中的任務）" }) : null),
      paragraph("更新前會自動備份，失敗時還原到原本的版本。", "note"),
    ],
  }).then((ok) => {
    if (ok) runJob(type, { restartDesktop }, { title: "更新到 v" + target });
  });
}

// ---- 結束管理頁 --------------------------------------------------------------

function confirmShutdown() {
  confirmDialog({
    title: "結束管理頁",
    confirmLabel: "結束",
    body: paragraph("結束後這個分頁會失效；之後雙擊捷徑或執行安裝器的 ui 命令即可重新開啟。路由器本身不受影響。"),
  }).then(async (ok) => {
    if (!ok) return;
    try {
      await api("/api/shutdown", { method: "POST" });
    } catch (error) {
      toast(error.message, "error");
      return;
    }
    restartingManager = true;
    document.body.replaceChildren(h("div", { class: "fatal" }, h("h1", { text: "管理頁已結束" }), h("p", { text: "可以關閉這個分頁了。" })));
  });
}

// ---- 啟動 --------------------------------------------------------------------

function showFatal(title, text) {
  document.body.replaceChildren(h("div", { class: "fatal" }, h("h1", { text: title }), h("p", { text })));
}

async function start() {
  if (!token) {
    showFatal("缺少存取權杖", "請從終端機顯示的網址開啟管理頁，或重新執行安裝器的 ui 命令。");
    return;
  }
  document.getElementById("version-badge").addEventListener("click", (event) => { event.stopPropagation(); togglePopover(); });
  document.getElementById("shutdown-button").addEventListener("click", confirmShutdown);
  document.addEventListener("mousedown", (event) => {
    if (!popoverOpen) return;
    const popover = document.getElementById("version-popover");
    if (!popover.contains(event.target) && event.target !== document.getElementById("version-badge")) togglePopover(false);
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && popoverOpen && modalCount === 0) togglePopover(false); });
  window.addEventListener("resize", () => { if (popoverOpen) positionPopover(); });
  render();
  try {
    state = await api("/api/state");
  } catch (error) {
    if (error.status === 401) {
      try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* 忽略 */ }
      showFatal("存取權杖已失效", "管理頁可能已重新啟動。請從終端機顯示的網址重新開啟，或重新執行安裝器的 ui 命令。");
      return;
    }
    toast(error.message, "error");
  }
  render();
  refreshVersion();
  refreshErrors();
  if (state && state.manager && state.manager.activeJob) {
    watchJob({ id: state.manager.activeJob.id, title: state.manager.activeJob.title, output: "", offset: 0 }, state.manager.activeJob.title);
  } else if (state) {
    try {
      const pending = JSON.parse(sessionStorage.getItem(JOB_KEY) || "null");
      if (pending && pending.id) {
        const view = await api("/api/jobs/" + encodeURIComponent(pending.id));
        watchJob(view, pending.title);
      }
    } catch { try { sessionStorage.removeItem(JOB_KEY); } catch { /* 忽略 */ } }
  }
  // 定期刷新也當作心跳：分頁開著，管理程式就不會因為閒置而結束。
  setInterval(() => {
    if (restartingManager) return;
    if (document.hidden || modalCount > 0 || dragSlug) api("/api/ping", { method: "POST" }).catch(() => {});
    else refreshState(true);
  }, 15000);
  setInterval(() => { if (!document.hidden && currentView === "overview" && modalCount === 0) refreshErrors(); }, 60000);
  setInterval(() => { if (!document.hidden) refreshVersion(); }, 30 * 60 * 1000);
}

start();
</script>
</body>
</html>
__CODEX_MODEL_ROUTER_EMBEDDED__
#>
