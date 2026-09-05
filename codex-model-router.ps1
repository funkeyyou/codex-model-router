# Codex 模型路由器 —— Windows 安裝器
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1
#   powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 status
#   powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 rollback
#
# 檔案末尾的註解區塊內嵌 installer / router / claude-bridge 三段 JavaScript，
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
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { Writable } from "node:stream";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const INSTALLER_VERSION = "1.16.0";
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
const launcherVbsPath = join(installRoot, "router-launcher.vbs");
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
function windowsDownloadsDir() {
  const guid = "{374DE290-123F-4565-9164-39C4925E467B}";
  const key =
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders";
  const result = powershell(
    [
      `$value = (Get-ItemProperty -LiteralPath ${psQuote(key)} -Name ${psQuote(guid)}).${psQuote(guid)}`,
      "[Environment]::ExpandEnvironmentVariables($value)",
    ].join("\n"),
    { allowFailure: true },
  );
  if (result.status !== 0) return null;
  return (result.stdout || "").trim() || null;
}

// 生成的圖預設落在使用者的「下載」。明確寫進 settings 讓它看得見也改得動；
// 使用者若已經改過就沿用，重新安裝不該把它蓋掉。
function resolveImageOutputDir() {
  if (existsSync(settingsPath)) {
    try {
      const previous = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (typeof previous.imageOutputDir === "string" && previous.imageOutputDir) {
        return previous.imageOutputDir;
      }
    } catch {}
  }
  if (isWindows) {
    const resolved = windowsDownloadsDir();
    if (resolved) return resolved;
  }
  return join(homeDir, "Downloads");
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
  const endMarker = "\n__CODEX_MODEL_ROUTER_EMBEDDED__";
  const endIndex = bridgeSource.lastIndexOf(endMarker);
  return endIndex < 0 ? bridgeSource : bridgeSource.slice(0, endIndex);
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

async function selectModels(models) {
  printHeading("可用模型");
  models.forEach((model, index) => {
    console.log(`${String(index + 1).padStart(3)}. ${model}`);
  });
  const automaticSelection = env.CODEX_MODEL_ROUTER_TEST_MODELS;
  const answer =
    automaticSelection ||
    (await ask("請輸入模型編號，可使用逗號、範圍，或輸入 all 全選"));
  return parseSelection(answer, models.length).map((index) => models[index]);
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
    const text = await response.text();
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

async function probeModel(apiRoot, apiKey, model) {
  const supportedEfforts = [];
  const transientEfforts = [];
  for (const effort of EFFORTS) {
    process.stdout.write(`  ${effort.padEnd(7)} `);
    try {
      const result = await testResponse(apiRoot, apiKey, model, effort);
      if (result.ok) {
        supportedEfforts.push(effort);
        console.log("支持");
      } else if (isTransientProbeStatus(result.status)) {
        transientEfforts.push(effort);
        console.log(`暫時不可用（HTTP ${result.status}）`);
      } else {
        console.log(`不支持（HTTP ${result.status}）`);
      }
    } catch (error) {
      // 逾時或連線層例外同樣只代表這次問不到。
      transientEfforts.push(effort);
      console.log(`暫時不可用（${error instanceof Error ? error.message : String(error)}）`);
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

  process.stdout.write("  預設    ");
  try {
    const result = await testResponse(apiRoot, apiKey, model, null);
    if (result.ok) {
      console.log("支援，但不提供推理強度控制");
      return { supported: true, efforts: [], stripReasoning: true, transientEfforts };
    }
    console.log(`不支持（HTTP ${result.status}）`);
    return {
      supported: false,
      efforts: [],
      stripReasoning: false,
      transientEfforts,
      transient: isTransientProbeStatus(result.status),
    };
  } catch (error) {
    console.log(`暫時不可用（${error instanceof Error ? error.message : String(error)}）`);
    return { supported: false, efforts: [], stripReasoning: false, transientEfforts, transient: true };
  }
}

function pickerSlug(model) {
  const readable = model
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 44) || "model";
  const digest = createHash("sha256").update(model).digest("hex").slice(0, 8);
  return `custom/${readable}-${digest}`;
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
function applyForcedVisibility(models, forceListed) {
  if (!Array.isArray(forceListed) || forceListed.length === 0) return models;
  const forced = new Set(forceListed);
  return models.map((model) =>
    forced.has(model.slug) ? { ...model, visibility: "list" } : model,
  );
}

// 使用者可以在 settings.json 裡調的旋鈕。安裝器用固定欄位重寫整個檔案，因此
// 沒列在這裡的東西每次重裝都會靜默消失——README 明文寫給使用者調的
// maxLogBytes、viewImageBridge、upstreamWebSocket* 全都在內。
// imageOutputDir 與 forceListedModels 不列在這：前者由 resolveImageOutputDir
// 處理（沒設過時還要算預設值），後者安裝時會重新詢問。
const preservedSettingKeys = [
  "captureDir",
  "catalogRefresh",
  "closeOnUpstreamError",
  "heartbeatIntervalMs",
  "maxLogBytes",
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

// 安裝器一直看得到 visibility，卻從沒告訴使用者有東西被藏起來——於是
// 「Codex 更新後新模型不見了」變成一個查不出原因的症狀。這裡直接列出來讓
// 使用者決定，比留一個藏在 settings.json 裡的旋鈕有用得多。
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
    await ask("要強制顯示哪幾個？逗號分隔編號、all 全選、留空都不顯示", "")
  ).trim();
  if (!answer) return [];
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

function customCatalogEntry(officialModels, route, index) {
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
  entry.display_name = route.displayName;
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
      `  ⚠️  ${route.upstreamModel}：無法自動探測上下文上限，` +
        `沿用模板值 ${entry.context_window}。如與實際不符請手動修改 models.json。`,
    );
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

async function codexRpc(method, params) {
  const child = spawn(codexBin, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...env, CODEX_HOME: codexHome },
  });
  child.stderr.on("data", () => {});
  let buffer = "";
  let settled = false;
  const responsePromise = new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
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
    child.kill("SIGTERM");
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

function launchAgentPlist(port) {
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
function vbsQuote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

// 走 cmd.exe 只為了把 stdout/stderr 附加到記錄檔，對應 launchd 的 StandardErrorPath。
// 不落地成 .cmd：批次檔是以主控台 OEM 代碼頁讀取的，使用者名稱含非 ASCII 時路徑會壞；
// 命令列則由 CreateProcessW 以 Unicode 傳遞，不受代碼頁影響。
function routerCommandLine() {
  const inner = `"${nodeBin}" "${routerPath}" >>"${logPath}" 2>&1`;
  return `cmd.exe /d /s /c "${inner}"`;
}

// wscript 屬 GUI 子系統，不會配置主控台；Run(..., 0, True) 隱藏執行並等待結束，
// 迴圈本身就是 launchd KeepAlive 的等價物（含 3 秒節流）。
function launcherVbsScript() {
  return [
    "Option Explicit",
    "Dim shell",
    'Set shell = CreateObject("WScript.Shell")',
    "Do",
    `  shell.Run ${vbsQuote(routerCommandLine())}, 0, True`,
    "  WScript.Sleep 3000",
    "Loop",
    "",
  ].join("\r\n");
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
      <Arguments>//nologo //B ${xmlEscape(`"${launcherVbsPath}"`)}</Arguments>
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

function writeServiceDefinition(port) {
  if (isWindows) {
    writeFileSync(launcherVbsPath, utf16leWithBom(launcherVbsScript()), {
      mode: 0o600,
    });
    writeFileSync(taskXmlPath, utf16leWithBom(taskXmlDocument()), {
      mode: 0o600,
    });
    for (const path of [launcherVbsPath, taskXmlPath]) {
      restrictAcl(path);
    }
    return;
  }
  ensureDirectory(launchAgentsDir);
  writeFileSync(plistPath, launchAgentPlist(port), { mode: 0o600 });
  chmodSync(plistPath, 0o600);
  shell("/usr/bin/plutil", ["-lint", plistPath]);
}

function startService() {
  if (isWindows) startScheduledTask();
  else startLaunchAgent();
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

// 重新設定 / 回退時要一併備份或還原的服務檔案。
function serviceArchivePaths() {
  return isWindows ? [taskXmlPath, launcherVbsPath] : [plistPath];
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
async function buildRouteForModel(discovery, apiKey, model) {
  printHeading(`正在測試 ${model}`);
  const owner = modelOwners.get(model) || "unknown";
  const ownerIsAnthropic = owner === "anthropic";
  // /models 沒標供應商時按模型名推斷，否則 Claude 會靜默落到通用 Responses
  // 路由——Codex 的 Code Mode 用 namespace 包裝工具，那條路必然失敗。
  const guessedAnthropic = !ownerIsAnthropic && owner === "unknown" && looksAnthropic(model);

  if (ownerIsAnthropic || guessedAnthropic) {
    if (guessedAnthropic) {
      console.log("  供應商        /models 未標註，按模型名推斷為 Anthropic");
    }
    // Claude 走本機轉譯：直接驗證原生 /messages。
    process.stdout.write("  原生 /messages  ");
    const probeResult = await probeAnthropicModel(discovery.apiRoot, apiKey, model);
    if (probeResult.ok) {
      console.log("支持");
      process.stdout.write("  上下文上限    ");
      const contextWindow = await probeAnthropicContextWindow(discovery.apiRoot, apiKey, model);
      console.log(contextWindow ? `${contextWindow.toLocaleString()} tokens` : "無法探測（將回退）");
      process.stdout.write("  最大輸出      ");
      const { maxOutput, canonicalId } = await probeAnthropicMaxOutput(discovery.apiRoot, apiKey, model);
      console.log(
        maxOutput
          ? `${maxOutput.toLocaleString()} tokens${canonicalId ? `（${canonicalId}）` : ""}`
          : "無法探測",
      );

      // budget_tokens 在較新的模型上已被移除：官方直接 400，部分閘道靜默丟棄，
      // 結果是 Codex 裡選 low 或 max 毫無差別，而且一律跑在高強度。
      // 支援 output_config 的話就直接透傳五檔，低強度才真的會變快。
      process.stdout.write("  推理強度控制  ");
      const supportsOutputConfig = await probeAnthropicParam(
        discovery.apiRoot, apiKey, model, { output_config: { effort: "low" } },
      );
      console.log(
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
        process.stdout.write("  推理摘要      ");
        supportsSummary = await probeAnthropicParam(
          discovery.apiRoot, apiKey, model,
          { thinking: { type: "adaptive", display: "summarized" } },
        );
        console.log(
          supportsSummary === true
            ? "顯示摘要"
            : supportsSummary === false
              ? "該模型不支援 adaptive/summarized，不顯示"
              : "無法探測，不顯示",
        );
      }

      // 對話歷史每輪都會重送；沒有滾動斷點的話上游每輪都要重算整段歷史。
      process.stdout.write("  提示詞快取    ");
      const supportsCache = await probeAnthropicParam(
        discovery.apiRoot, apiKey, model, { cache_control: { type: "ephemeral" } },
      );
      console.log(
        supportsCache === true
          ? "支援滾動斷點"
          : supportsCache === false
            ? "閘道不接受頂層 cache_control，僅快取系統提示詞"
            : "無法探測，僅快取系統提示詞",
      );

      const route = {
        pickerSlug: pickerSlug(model),
        upstreamModel: model,
        displayName: model,
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

    console.log(`失敗（HTTP ${probeResult.status}）${probeResult.detail ? "：" + probeResult.detail : ""}`);
    if (guessedAnthropic) {
      // 只是按名字猜的，探測不通不足以判定模型不可用，回退到通用路由。
      console.log("  該閘道沒有可用的 Anthropic 原生端點，改用通用 Responses 路由重試。");
      console.log("  注意：Codex 的 Code Mode 用 namespace 包裝工具，部分閘道會因此報錯或丟工具。");
    } else if (isTransientProbeStatus(probeResult.status)) {
      // 額度、上游容量或網路問題，而非模型真的不受支持。
      console.log(`跳過 ${model}：上游暫時不可用，並非模型不受支援。`);
      return { route: null, transient: true, transientEfforts: [] };
    } else if (probeResult.status === 401 || probeResult.status === 403) {
      console.log(`跳過 ${model}：當前 API Key 無權存取該模型。`);
      return { route: null, transient: false, transientEfforts: [] };
    } else if (probeResult.status === 404) {
      console.log(`跳過 ${model}：該閘道未提供 Anthropic 原生 /messages 端點，無法本機轉譯。`);
      return { route: null, transient: false, transientEfforts: [] };
    } else {
      console.log(`跳過 ${model}：Anthropic 原生端點探測未通過。`);
      return { route: null, transient: false, transientEfforts: [] };
    }
  }

  const probe = await probeModel(discovery.apiRoot, apiKey, model);
  if (!probe.supported) {
    console.log(
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
    displayName: model,
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
  console.log("\n每個選中的模型最多會執行五次小型 Responses API 探測。" );
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
  for (const model of selectedModels) {
    const outcome = await buildRouteForModel(discovery, apiKey, model);
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
    routes.push(route);
  }
  if (routes.length === 0) fail("選中的模型均未通過 Responses API 探測。" );
  if (keptModels.length > 0 || keptEfforts.length > 0) {
    console.log("\n本次探測遇到暫時性故障，以下項目沿用上次已驗證的設定：" );
    for (const model of keptModels) console.log(`  - ${model}（整個模型）`);
    for (const line of keptEfforts) console.log(`  - ${line}`);
    console.log("  上游恢復後重跑一次安裝器，即可用最新探測結果覆蓋。" );
  }

  const bundledCatalog = loadBundledCatalog();
  const discoveredOfficial = bundledCatalog.models.filter(
    (model) => !String(model.slug).startsWith("custom/"),
  );
  const forceListedModels = await chooseForcedModels(
    discoveredOfficial,
    readSettingsIfExists().forceListedModels,
  );
  const officialModels = applyForcedVisibility(discoveredOfficial, forceListedModels);
  const customModels = routes.map((route, index) =>
    customCatalogEntry(officialModels, route, index),
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
  writeServiceDefinition(port);

  let configChanged = false;
  try {
    startService();
    await waitForHealth(port);
    const writeResult = await writeConfigEdits([
      { keyPath: "model_provider", value: "openai" },
      {
        keyPath: "openai_base_url",
        value: `http://127.0.0.1:${port}/v1`,
      },
      { keyPath: "model_catalog_json", value: catalogPath },
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
    const modelCheck = shell(codexBin, ["debug", "models"], {
      env: { ...env, CODEX_HOME: codexHome },
    });
    const effectiveCatalog = JSON.parse(modelCheck.stdout);
    const visibleSlugs = new Set(effectiveCatalog.models?.map((model) => model.slug));
    for (const route of routes) {
      if (!visibleSlugs.has(route.pickerSlug)) {
        fail(`Codex model/list 中缺少已安裝模型：${route.pickerSlug}`);
      }
    }
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
    fail("該 Base URL 上的模型都已配置，沒有可添加的項。");
  }

  const selectedModels = await selectModels(available);
  if (selectedModels.length === 0) fail("未選擇任何模型。");
  console.log("\n每個選中的模型最多會執行五次小型 Responses API 探測。");
  if (!(await confirm("是否繼續進行能力探測？", true))) {
    fail("已在修改配置前取消。");
  }

  const newRoutes = [];
  for (const model of selectedModels) {
    // 這裡的模型都是新選的，沒有既有設定可以沿用；暫時性失敗只能略過。
    const { route } = await buildRouteForModel(discovery, apiKey, model);
    if (route) newRoutes.push(route);
  }
  if (newRoutes.length === 0) fail("選中的模型均未通過探測，配置未改動。");

  const routes = [...existingRoutes, ...newRoutes];
  const backupDir = join(backupsRoot, `add-model-${timestamp()}`);
  ensureDirectory(backupDir);
  copyIfExists(routerPath, join(backupDir, "router.mjs"));
  copyIfExists(bridgePath, join(backupDir, "claude-bridge.mjs"));
  copyIfExists(settingsPath, join(backupDir, "settings.json"));
  copyIfExists(catalogPath, join(backupDir, "models.json"));
  copyIfExists(manifestPath, join(backupDir, "install.json"));

  const bundledCatalog = loadBundledCatalog();
  // 這裡不重問隱藏模型（add 的用意就是不重問設定），但既有的選擇要沿用，
  // 否則加一個模型就會把強制顯示的那些又藏回去。
  const officialModels = applyForcedVisibility(
    bundledCatalog.models.filter((model) => !String(model.slug).startsWith("custom/")),
    settings.forceListedModels,
  );
  const customModels = routes.map((route, index) =>
    customCatalogEntry(officialModels, route, index),
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
    stopService();
    startService();
    await waitForHealth(port);

    const modelCheck = shell(codexBin, ["debug", "models"], {
      env: { ...env, CODEX_HOME: codexHome },
    });
    const visibleSlugs = new Set(
      JSON.parse(modelCheck.stdout).models?.map((model) => model.slug),
    );
    for (const route of newRoutes) {
      if (!visibleSlugs.has(route.pickerSlug)) {
        fail(`Codex model/list 中缺少新增模型：${route.pickerSlug}`);
      }
    }
  } catch (error) {
    console.error("\n添加失敗，正在還原之前的配置...");
    copyIfExists(join(backupDir, "router.mjs"), routerPath);
    copyIfExists(join(backupDir, "claude-bridge.mjs"), bridgePath);
    copyIfExists(join(backupDir, "settings.json"), settingsPath);
    copyIfExists(join(backupDir, "models.json"), catalogPath);
    copyIfExists(join(backupDir, "install.json"), manifestPath);
    try {
      stopService();
      startService();
    } catch {}
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
  for (const route of manifest.routes) {
    console.log(`  - ${route.displayName} -> ${route.upstreamModel}`);
  }
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

function help() {
  console.log(`Codex 模型路由器 ${INSTALLER_VERSION}

用法：
  ${basename(scriptPath || "codex-model-router.command")} install
  ${basename(scriptPath || "codex-model-router.command")} add
  ${basename(scriptPath || "codex-model-router.command")} status
  ${basename(scriptPath || "codex-model-router.command")} rollback

安裝時會詢問：
  1. 兼容 OpenAI 的 Base URL
  2. API Key（保存在${secretStoreLabel}）
  3. 要添加的模型

add 用於在已有安裝上追加模型：沿用已儲存的 Base URL、API Key 與連接埠，
只探測新選的模型，不會重問設定，也不改動 config.toml。

安裝器會繼續將官方 ChatGPT Codex 模型發送到 OpenAI，只有選中的
自訂模型選擇器 ID 才會發送到配置的供應商。Codex 仍使用內建
openai 供應商 ID，以保持 Desktop 與手機 Remote 的既有聊天可見。
`);
}

async function chooseAction() {
  printHeading("Codex 模型路由器");
  console.log("  1. 安裝或重新配置");
  console.log("  2. 添加模型（保留現有配置）");
  console.log("  3. 查看狀態");
  console.log("  4. 回退配置");
  console.log("  5. 退出");
  const answer = await ask("請選擇操作", "1");
  const choices = {
    "1": "install",
    install: "install",
    setup: "install",
    "2": "add",
    add: "add",
    "add-model": "add",
    addmodel: "add",
    "3": "status",
    status: "status",
    "4": "rollback",
    rollback: "rollback",
    uninstall: "rollback",
    "5": "exit",
    exit: "exit",
    quit: "exit",
  };
  const action = choices[answer.trim().toLowerCase()];
  if (!action) fail(`無法識別的選單選項：${answer}`);
  return action;
}

// 測試會 import 本檔以驗證版本比較等純函式，此時不能真的執行安裝流程。
if (!process.env.CODEX_MODEL_ROUTER_IMPORT_ONLY) {
  try {
    const versionAwareActions = new Set([
      "install",
      "setup",
      "add",
      "add-model",
      "addmodel",
      "status",
    ]);
    if (!requestedAction || versionAwareActions.has(requestedAction)) {
      await printVersionSummary();
    }
    const action = requestedAction || (await chooseAction());
    if (action === "install" || action === "setup") await install();
    else if (action === "add" || action === "add-model" || action === "addmodel") await addModels();
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
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import tls from "node:tls";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, appendFileSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import {
  toAnthropicRequest,
  bridgeAnthropicStream,
  decodeCompaction,
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
const tokenCacheTtlMs = 5 * 60 * 1000;
const authValidationTtlMs = 5 * 60 * 1000;
const maxRememberedThreads = 2048;
const maxValidatedAuthDigests = 64;
const maxPendingMessages = 8;
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
    `這一輪要送往上游的請求有 ${mb(bytes)} MB，超過 ${mb(limit)} MB 的上限。` +
    "這條對話累積的歷史已經大到送不出去（通常是工具輸出佔掉絕大部分），" +
    "重試不會有幫助，請改開一條新對話。"
  );
}

// --- 模型目錄的自動更新 -----------------------------------------------------
//
// config.toml 的 model_catalog_json 指著 models.json，而那份是安裝當下用
// `codex debug models --bundled` 產生的快照。ChatGPT Desktop 之後更新、內建了新
// 模型，這個檔不會跟著動，選單裡就永遠看不到——而且失敗是靜默的，使用者只會
// 以為官方還沒推給自己。
//
// bundled 清單只有在 Codex 執行檔本身變更時才會變，因此用「執行檔比目錄新」當
// 觸發條件：平常只是一次 stat，真的更新了才 spawn 一次。重建後目錄的 mtime 會
// 晚於執行檔，不會反覆觸發。
const pinnedCodexBin = typeof settings.codexBin === "string" ? settings.codexBin : null;
const codexBinSearchDir =
  typeof settings.codexBinDir === "string" ? settings.codexBinDir : null;
const codexBinaryName = process.platform === "win32" ? "codex.exe" : "codex";

// Windows 的 Codex 每次更新都裝進一個新的版本雜湊目錄，舊目錄原封不動留著。
// 把安裝當下記下的那支執行檔當成新鮮度來源，等於這個功能永遠不會觸發：它的
// mtime 從此凍結，而目錄是安裝時才寫的，必然比它新。所以每次檢查都重新解析
// 一次「目前最新的那支」，而不是相信安裝時釘死的路徑。
// macOS 不受影響（app bundle 內的路徑固定，更新時 mtime 會變），但同一套邏輯
// 對它也是安全的：搜尋目錄留空時就只剩釘死的那支。
export function newestCodexBinary(pinned, searchDir, entries = null, stat = statSync) {
  const candidates = [];
  if (pinned) candidates.push(pinned);
  if (searchDir) {
    let listing = entries;
    if (listing === null) {
      try {
        listing = readdirSync(searchDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        listing = [];
      }
    }
    for (const name of listing) candidates.push(join(searchDir, name, codexBinaryName));
    candidates.push(join(searchDir, codexBinaryName));
  }
  let best = null;
  let bestMtime = -1;
  for (const candidate of candidates) {
    let mtime;
    try {
      mtime = stat(candidate).mtimeMs;
    } catch {
      continue;
    }
    if (mtime > bestMtime) {
      bestMtime = mtime;
      best = candidate;
    }
  }
  return best;
}

const catalogRefreshEnabled = settings.catalogRefresh !== false;
const catalogRetryCooldownMs = 10 * 60 * 1000;
let catalogRetryAfter = 0;

export function catalogNeedsRefresh(binMtimeMs, catalogMtimeMs) {
  if (!Number.isFinite(binMtimeMs) || !Number.isFinite(catalogMtimeMs)) return false;
  return binMtimeMs > catalogMtimeMs;
}

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

// forceListedModels 原本只在重建時套用，而重建的條件是「執行檔比目錄新」——
// 安裝完必然不成立。於是設了這個選項不會有任何反應，得剛好等到下次 Codex 更新。
// 這裡補上第二個觸發條件：目錄裡只要還有「該強制列出、卻沒列出」的模型就重建。
// （反向不成立：某個 slug 從清單移除後，目錄裡那個 list 會留到下次真正重建為止，
// 因為判斷原始 visibility 需要 bundled 目錄，而那要 spawn 才拿得到。）
export function forcedModelsPending(catalog, forceListed) {
  if (!Array.isArray(forceListed) || forceListed.length === 0) return false;
  const wanted = new Set(forceListed);
  return (catalog?.models || []).some(
    (model) => wanted.has(model?.slug) && model?.visibility !== "list",
  );
}

function forcedModelsNeedApplying() {
  try {
    return forcedModelsPending(
      JSON.parse(readFileSync(settings.catalogPath, "utf8")),
      settings.forceListedModels,
    );
  } catch {
    return false;
  }
}

function refreshCatalogIfStale() {
  if (!catalogRefreshEnabled) return false;
  if (Date.now() < catalogRetryAfter) return false;
  const codexBinPath = newestCodexBinary(pinnedCodexBin, codexBinSearchDir);
  if (!codexBinPath) return false;
  let binMtime;
  let catalogMtime;
  try {
    binMtime = statSync(codexBinPath).mtimeMs;
    catalogMtime = statSync(settings.catalogPath).mtimeMs;
  } catch {
    return false;
  }
  if (!catalogNeedsRefresh(binMtime, catalogMtime) && !forcedModelsNeedApplying()) {
    return false;
  }

  try {
    const raw = execFileSync(
      codexBinPath,
      ["debug", "models", "--bundled", "-c", "model_catalog_json=null", "-c", 'model_provider="openai"'],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, CODEX_HOME: dirname(routerDirectory) },
        timeout: 30000,
      },
    );
    const merged = mergeCatalog(
      JSON.parse(raw),
      JSON.parse(readFileSync(settings.catalogPath, "utf8")),
      Array.isArray(settings.forceListedModels) ? settings.forceListedModels : [],
    );
    // 先寫暫存再改名：Codex 可能正在讀這個檔。
    const temporary = settings.catalogPath + ".tmp";
    writeFileSync(temporary, JSON.stringify(merged), { mode: 0o600 });
    renameSync(temporary, settings.catalogPath);
    stats.catalogRefreshes += 1;
    stats.catalogModels = merged.models.length;
    process.stderr.write(
      `model-router-catalog-refreshed:${merged.models.length} 個模型\n`,
    );
    return true;
  } catch (error) {
    // 失敗就先冷卻，避免每次檢查都 spawn 一次。
    catalogRetryAfter = Date.now() + catalogRetryCooldownMs;
    stats.catalogRefreshFailures += 1;
    process.stderr.write(
      "model-router-catalog-refresh-failed:" +
        (error instanceof Error ? error.message : String(error)) +
        "\n",
    );
    return false;
  }
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
    return Boolean(parsed && typeof parsed.thinking === "string" && parsed.signature);
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

function setHistory(key, input) {
  if (!key) return;
  threadHistories.delete(key);
  threadHistories.set(key, {
    input: Array.isArray(input) ? input.slice() : [],
    output: [],
  });
  while (threadHistories.size > maxRememberedHistories) {
    const oldest = threadHistories.keys().next().value;
    if (oldest === undefined) break;
    threadHistories.delete(oldest);
  }
}

function appendHistoryOutput(key, item) {
  const history = key ? threadHistories.get(key) : null;
  if (!history || !item || typeof item !== "object") return;
  // reasoning 項目要能在後續請求中被接受，必須帶 encrypted_content。
  if (item.type === "reasoning" && !item.encrypted_content) return;
  history.output.push(item);
}

function rebuildStatefulInput(key, incomingInput) {
  const history = key ? threadHistories.get(key) : null;
  if (!history || history.input.length === 0) return null;
  const incoming = Array.isArray(incomingInput) ? incomingInput : [];
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
  upstreamErrorCloses: 0,
  statefulFallbacks: 0,
  responseFailedSent: 0,
  truncatedUpstreamStreams: 0,
  oversizeRejects: 0,
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
  catalogRefreshes: 0,
  catalogRefreshFailures: 0,
  catalogModels: 0,
  lastImageStatus: null,
  viewImageCallsInjected: 0,
  viewImageCallsStripped: 0,
  translatedRequests: 0,
  imagesOmitted: 0,
  officialPassthroughs: 0,
  trailingThinkingTrimmed: 0,
  lastAuthProbeStatus: null,
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
};
const validatedAuthDigests = new Map();
const threadRoutes = new Map();
let apiKeyCache = null;

function writeJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

// 憑證來源：macOS 讀鑰匙圈；Windows 解 DPAPI 密文檔（entropy 就是 keychainService）。
function readStoredSecret() {
  if (process.platform !== "win32") {
    return execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-a",
        keychainAccount,
        "-s",
        keychainService,
        "-w",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
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
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  ).trim();
}

function getApiKey(forceRefresh = false) {
  if (process.env.CODEX_MODEL_ROUTER_TEST_API_KEY) {
    return process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  }
  const now = Date.now();
  if (!forceRefresh && apiKeyCache && apiKeyCache.expiresAt > now) {
    return apiKeyCache.value;
  }
  const value = readStoredSecret();
  if (!value) throw new Error("自訂供應商的憑證為空");
  apiKeyCache = { value, expiresAt: now + tokenCacheTtlMs };
  return value;
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

export function markAuthValidated(headers) {
  const digest = authDigest(headers);
  if (!digest) return;
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

async function validateOfficialAuth(requestHeaders) {
  if (hasValidatedAuth(requestHeaders)) return true;
  if (!authDigest(requestHeaders)) return false;
  let upstream;
  try {
    upstream = await fetch(`${officialBase}/models`, {
      headers: buildOfficialHeaders(requestHeaders),
      redirect: "manual",
    });
  } catch {
    stats.authProbeFailures += 1;
    return false;
  }
  await upstream.arrayBuffer();
  stats.lastAuthProbeStatus = upstream.status;
  // 這支端點缺少 client_version 參數時會回 400，但未授權一律是 401/403。
  // 因此只有明確的未授權才視為驗證失敗，否則參數問題會讓所有自訂模型被誤擋。
  if (upstream.status === 401 || upstream.status === 403) return false;
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
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  let body = raw;
  if (request.headers["content-encoding"] === "zstd") {
    try {
      body = zstdDecompressSync(raw);
    } catch {
      body = raw;
    }
  }
  const init = {
    method: request.method,
    headers: buildOfficialHeaders(request.headers),
    redirect: "manual",
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

async function streamUpstream(upstream, response) {
  response.writeHead(upstream.status, filteredResponseHeaders(upstream.headers));
  if (!upstream.body) {
    response.end();
    return;
  }
  for await (const chunk of upstream.body) {
    if (!response.write(chunk)) await once(response, "drain");
  }
  response.end();
}

async function fetchCustom(target, headers, body, signal) {
  let apiKey = getApiKey(false);
  let upstream = await fetch(target, {
    method: "POST",
    headers: buildCustomHeaders(headers, apiKey),
    body,
    redirect: "manual",
    signal,
  });
  if (upstream.status !== 401 && upstream.status !== 403) return upstream;
  await upstream.arrayBuffer();
  apiKey = getApiKey(true);
  return fetch(target, {
    method: "POST",
    headers: buildCustomHeaders(headers, apiKey),
    body,
    redirect: "manual",
    signal,
  });
}

async function fetchModelUpstream(
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

  // previous_response_id 需要真正的 WebSocket 上游；本路由對上游一律使用 HTTP，
  // 官方後端與第三方閘道都會拒絕。因此在此統一改寫成等價的完整請求，
  // 三條路徑（官方 / 自訂 / Anthropic 轉譯）共用同一份歷史。
  const historyKey = historyKeyFor(body, requestHeaders, meta.connectionNamespace);
  meta.historyKey = historyKey;
  let effectiveBody = body;
  if (body?.previous_response_id) {
    const rebuilt = rebuildStatefulInput(historyKey, body.input);
    if (rebuilt) {
      effectiveBody = { ...body, input: rebuilt };
      delete effectiveBody.previous_response_id;
      setHistory(historyKey, rebuilt);
      stats.statefulRebuilds += 1;
    } else {
      // 無可用歷史時維持原樣，交由上游報錯 + 關閉連線讓 Codex 重送完整歷史。
      stats.statefulRebuildMisses += 1;
    }
  } else {
    setHistory(historyKey, body.input);
  }

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
    if (!(await validateOfficialAuth(requestHeaders))) {
      return new Response(
        JSON.stringify({
          error: { message: "需要 ChatGPT 身份驗證", type: "auth_error" },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    stats.custom += 1;
    if (route.translate === "anthropic") {
      // 部分閘道的 Responses 相容層對 Claude 有缺陷，改走原生 /messages 並本機轉譯。
      const { request: anthropicRequest, freeform, compaction, imagesOmitted,
        thinkingTrimmed } = toAnthropicRequest(effectiveBody, route);
      if (imagesOmitted > 0) stats.imagesOmitted += imagesOmitted;
      if (thinkingTrimmed > 0) stats.trailingThinkingTrimmed += thinkingTrimmed;
      meta.translate = "anthropic";
      meta.freeform = freeform;
      meta.compaction = compaction;
      meta.model = body.model;
      meta.requestBody = effectiveBody;
      meta.anthropicRequest = anthropicRequest;
      stats.translatedRequests += 1;
      const anthropicBody = Buffer.from(JSON.stringify(anthropicRequest));
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
      return translated;
    }
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

async function handleImages(request, response, incomingUrl) {
  // 與自訂模型同一套驗證，但只在請求真的帶了 ChatGPT 憑證時才驗。
  // image_gen 是用戶端工具，未必會帶上 /responses 那組標頭；若因為缺標頭就擋下，
  // 使用者只會從一個 404 換成一個 401，問題沒解決。路由器只聽 127.0.0.1，
  // 且這條路徑花的是使用者自己的閘道金鑰，因此放行沒有標頭的請求。
  if (authDigest(request.headers) && !(await validateOfficialAuth(request.headers))) {
    writeJson(response, 401, {
      error: { message: "需要 ChatGPT 身份驗證", type: "auth_error" },
    });
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);

  const abortController = new AbortController();
  request.on("aborted", () => abortController.abort());

  // 影像請求可能是 multipart（edits），因此原樣轉發位元組，不做解析。
  const path = incomingUrl.pathname.startsWith("/v1/")
    ? incomingUrl.pathname.slice(3)
    : incomingUrl.pathname;
  const upstream = await fetchCustom(
    new URL(`${apiRoot}${path}${incomingUrl.search}`),
    request.headers,
    Buffer.concat(chunks),
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
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const encodedBody = Buffer.concat(chunks);
  const decodedBody = encoding === "zstd" ? zstdDecompressSync(encodedBody) : encodedBody;
  let body;
  try {
    body = JSON.parse(decodedBody.toString("utf8"));
  } catch {
    writeJson(response, 400, { error: { message: "JSON 格式無效", type: "router_error" } });
    return;
  }

  const abortController = new AbortController();
  let finished = false;
  request.on("aborted", () => abortController.abort());
  response.on("finish", () => {
    finished = true;
  });
  response.on("close", () => {
    if (!finished) abortController.abort();
  });

  const meta = {};
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
  await streamUpstream(upstream, response);
}

const websocketMagic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const maxWebSocketMessageBytes = 32 * 1024 * 1024;

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
const terminalEventTypes = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
]);

export function isTerminalEvent(event) {
  return terminalEventTypes.has(event?.type);
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

export function parseWebSocketFrames(buffer) {
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
      if (longLength > BigInt(maxWebSocketMessageBytes)) {
        throw new Error("WebSocket 訊息超過路由器限制");
      }
      payloadLength = Number(longLength);
      cursor += 8;
    }
    if (payloadLength > maxWebSocketMessageBytes) {
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

function sendSseBlockToWebSocket(socket, block, onEvent = null, imageState = null) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
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

export async function bridgeSseToWebSocket(upstream, socket, captureId = null, historyKey = null) {
  stats.lastWebSocketStatus = upstream.status;
  if (upstream.status < 200 || upstream.status >= 300) {
    const rawText = await upstream.text();
    let payload = null;
    try {
      payload = JSON.parse(rawText);
    } catch {}
    const errorObject = payload?.error || {
      type: "router_upstream_error",
      code: String(upstream.status),
      message: rawText || `上游返回 HTTP ${upstream.status}`,
    };
    sendWebSocketJson(socket, { type: "error", error: errorObject });
    sendResponseFailed(
      socket,
      errorObject.code || upstream.status,
      errorObject.message || `上游返回 HTTP ${upstream.status}`,
    );
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
  const onEvent = (event) => {
    if (isTerminalEvent(event)) sawTerminal = true;
    if (historyKey && event?.type === "response.output_item.done" && event.item) {
      appendHistoryOutput(historyKey, event.item);
    }
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
    noteTruncatedStream();
    sendResponseFailed(socket, "upstream_stream_truncated", truncatedStreamMessage);
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
    const timer = setTimeout(() => fail(new Error("上游 WebSocket 握手逾時")), timeoutMs);
    const onHandshakeData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const headerText = buffer.subarray(0, boundary).toString("utf8");
      const remainder = buffer.subarray(boundary + 4);
      const status = Number(/^HTTP\/1\.[01]\s+(\d+)/.exec(headerText)?.[1]);
      if (status !== 101) {
        fail(new Error("上游 WebSocket 握手失敗 HTTP " + (status || "?")));
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
  let buffer = leftover ?? Buffer.alloc(0);
  let fragments = [];
  const markClosed = (reason) => {
    if (session.closed) return;
    session.closed = true;
    const notify = session.onClosed;
    session.onClosed = null;
    if (notify) notify(reason);
  };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let parsed;
    try {
      parsed = parseWebSocketFrames(buffer);
    } catch (error) {
      socket.destroy();
      markClosed(error instanceof Error ? error.message : String(error));
      return;
    }
    buffer = parsed.remainder;
    for (const frame of parsed.frames) {
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
  socket.on("error", (error) => markClosed(error instanceof Error ? error.message : String(error)));
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
function runUpstreamWebSocketTurn(session, payload, { onEvent, signal }) {
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
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => {
      if (settled) return;
      try {
        session.send({ type: "response.cancel" });
      } catch {}
      failHard(new Error("已取消"));
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

    session.onClosed = (reason) => failHard(new Error(reason || "上游 WebSocket 中斷"));
    session.onEvent = (event) => {
      const type = String(event?.type || "");
      if (!flushed && (type === "error" || type === "response.failed") && isInvalidChain(event)) {
        finish({ ok: false, retryWithReplay: true });
        return;
      }
      if (flushed) onEvent(event);
      else buffered.push(event);
      if (type === "response.in_progress") flush();
      if (type === "response.completed") {
        flush();
        const responseId = event?.response?.id;
        if (typeof responseId === "string" && responseId) session.responseIds.add(responseId);
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
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let sawTerminal = false;
  await bridgeAnthropicStream(
    upstream.body,
    (event) => {
      if (isTerminalEvent(event)) sawTerminal = true;
      if (event?.type === "response.output_item.done" && event.item) {
        appendHistoryOutput(meta.historyKey, event.item);
      }
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
      // 轉譯路由同樣要把輸出記進本機歷史，否則之後切到其他模型時，
      // 重建的歷史會少掉 Claude 這一輪的回答與工具呼叫。
      if (event?.type === "response.output_item.done" && event.item) {
        appendHistoryOutput(meta.historyKey, event.item);
      }
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
      process.stderr.write(
        "model-router-upstream-ws-unavailable:" +
          (error instanceof Error ? error.message : String(error)) +
          "\n",
      );
      return false;
    }
    connectionState.session = session;
    noteUpstreamWebSocketConnected();
    stats.upstreamWebSocketConnects += 1;
  }

  // 只有這條上游連線自己產生過的 id 才能接續；其餘情況一律重播完整歷史。
  const canChain = Boolean(previousId && session.responseIds.has(previousId));
  const buildPayload = (chain) => {
    let outgoing = { ...message };
    if (chain) {
      // 接續：沿用 Codex 的增量 input 與 previous_response_id，
      // 但本機歷史仍要補齊，供之後回退或切換路由時使用。
      const rebuilt = rebuildStatefulInput(historyKey, message.input);
      if (rebuilt) setHistory(historyKey, rebuilt);
      stats.upstreamWebSocketIncremental += 1;
    } else {
      const rebuilt = previousId ? rebuildStatefulInput(historyKey, message.input) : null;
      const input = rebuilt || message.input;
      setHistory(historyKey, input);
      outgoing = { ...outgoing, input };
      delete outgoing.previous_response_id;
      if (previousId) stats.upstreamWebSocketReplays += 1;
    }
    const sanitized = stripBridgeArtifacts({ input: outgoing.input });
    outgoing.input = sanitized.input;
    outgoing.type = "response.create";
    return outgoing;
  };

  const forward = (event) => {
    if (event?.type === "response.output_item.done" && event.item) {
      appendHistoryOutput(historyKey, event.item);
    }
    sendWebSocketJson(socket, event);
    stats.websocketEvents += 1;
  };

  for (const chain of canChain ? [true, false] : [false]) {
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
      stats.upstreamWebSocketFallbacks += 1;
      process.stderr.write(
        "model-router-upstream-ws-error:" +
          (error instanceof Error ? error.message : String(error)) +
          "\n",
      );
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

async function handleWebSocketResponseInner(
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
  const meta = { connectionNamespace: connectionState?.connectionNamespace ?? null };
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
      await bridgeSseToWebSocket(upstream, socket, captureId, meta.historyKey);
    }
  } finally {
    stopHeartbeat();
  }
}

function handleWebSocketUpgrade(request, socket, head) {
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
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const websocketKey = request.headers["sec-websocket-key"];
  if (typeof websocketKey !== "string") {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
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

  let pending = head;
  let fragmentOpcode = null;
  let fragmentChunks = [];
  let activeAbortController = null;
  const pendingMessages = [];
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
      if (pendingMessages.length >= maxPendingMessages) {
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
      pendingMessages.push(message);
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
          stats.failures += 1;
          process.stderr.write(`model-router-websocket-error:${error}\n`);
          const detail = error instanceof Error ? error.message : String(error);
          sendWebSocketJson(socket, {
            type: "error",
            error: {
              type: "router_error",
              code: "router_error",
              message: `模型路由器的 WebSocket 橋接失敗：${detail}`,
            },
          });
          // 網路層例外（fetch failed / terminated）同樣要送終止事件，
          // 否則 Codex 會停在「思考中」直到 idle timeout 才重試。
          sendResponseFailed(socket, "router_error", detail);
        }
      })
      .finally(() => {
        activeAbortController = null;
        const next = pendingMessages.shift();
        if (next && !socket.destroyed && socket.writable) startResponse(next);
      });
  }

  const consume = (chunk) => {
    try {
      pending = Buffer.concat([pending, chunk]);
      const parsed = parseWebSocketFrames(pending);
      pending = parsed.remainder;
      for (const frame of parsed.frames) {
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
  if (head.length > 0) consume(Buffer.alloc(0));
}

const server = http.createServer(async (request, response) => {
  stats.requests += 1;
  try {
    const incomingUrl = new URL(request.url || "/", `http://${listenHost}:${listenPort}`);
    if (request.method === "GET" && incomingUrl.pathname === "/healthz") {
      writeJson(response, 200, {
        status: "ok",
        version: settings.version,
        uptimeSeconds: Math.floor(process.uptime()),
        stats,
      });
      return;
    }
    if (
      request.method === "GET" &&
      (incomingUrl.pathname === "/models" || incomingUrl.pathname === "/v1/models")
    ) {
      stats.models += 1;
      refreshCatalogIfStale();
      writeJson(response, 200, JSON.parse(readFileSync(settings.catalogPath, "utf8")));
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
    stats.failures += 1;
    process.stderr.write(`model-router-error:${message}\n`);
    if (!response.headersSent) {
      writeJson(response, 502, {
        error: { message: "模型路由器的上游請求失敗", type: "router_error" },
      });
    } else if (!response.writableEnded) {
      response.end();
    }
  }
});

server.on("upgrade", handleWebSocketUpgrade);

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

  // ChatGPT Desktop 更新完成的當下就重建目錄，等使用者重開 Codex 時已經是新的。
  refreshCatalogIfStale();
  const catalogTimer = setInterval(refreshCatalogIfStale, 5 * 60 * 1000);
  if (typeof catalogTimer.unref === "function") catalogTimer.unref();

  server.listen(listenPort, listenHost, () => {
    process.stderr.write(`model-router-ready:${listenHost}:${listenPort}\n`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
__CODEX_MODEL_ROUTER_BRIDGE_JS__
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
// 對應的東西，兩邊行為會不一致），因此改為控制張數：只保留最新的 20 張，更舊
// 的換成佔位文字。張數壓到上限以內之後尺寸限制自動回到 8000 像素，最近那幾張
// 截圖就能以原始解析度送出去。
const MAX_IMAGES_PER_REQUEST = 20;
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

function applyImageBudget(messages) {
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
  // 再把張數壓到上限以內，丟最舊的。
  const excess = kept.length - MAX_IMAGES_PER_REQUEST;
  for (let i = 0; i < excess; i += 1) omit(kept[i], IMAGE_OMITTED_COUNT);
  return omitted;
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
    if (typeof part?.text === "string" && part.text) {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    const image = toImageBlock(part?.image_url ?? part?.url);
    if (image) blocks.push(image);
  }
  return blocks;
}

// additional_tools 內含 namespace 巢狀，攤平成單層。
function flattenTools(items, out = []) {
  for (const tool of items || []) {
    if (tool?.type === "namespace") flattenTools(tool.tools, out);
    else if (tool?.name) out.push(tool);
  }
  return out;
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

function toAnthropicTools(codexTools) {
  const tools = [];
  const freeform = new Set();
  for (const tool of codexTools) {
    if (tool.type === "custom") {
      freeform.add(tool.name);
      tools.push({
        name: tool.name,
        description: tool.description || "",
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
  return { tools, freeform };
}

function decodeReasoning(encrypted) {
  if (typeof encrypted !== "string" || !encrypted) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encrypted, "base64").toString("utf8"));
    if (parsed && typeof parsed.thinking === "string" && parsed.signature) {
      return { type: "thinking", thinking: parsed.thinking, signature: parsed.signature };
    }
  } catch {}
  return null;
}

export function encodeReasoning(thinking, signature) {
  return Buffer.from(JSON.stringify({ thinking, signature }), "utf8").toString("base64");
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
  const systemParts = [];
  const messages = [];
  let codexTools = [];
  let compaction = false;

  // 同 role 的連續區塊必須合併，否則 Anthropic 會拒絕。
  const push = (role, block) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };

  // body.input 允許是純字串（簡易呼叫），統一成項目陣列。
  const inputItems = typeof body.input === "string"
    ? [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }]
    : (Array.isArray(body.input) ? body.input : []);

  for (const item of inputItems) {
    switch (item?.type) {
      case "additional_tools":
        codexTools = flattenTools(item.tools);
        break;

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
        push("assistant", {
          type: "tool_use",
          id: item.call_id,
          name: item.name,
          input: { [FREEFORM_KEY]: typeof item.input === "string" ? item.input : "" },
        });
        break;

      case "function_call": {
        let input = {};
        try { input = JSON.parse(item.arguments || "{}"); } catch {}
        push("assistant", { type: "tool_use", id: item.call_id, name: item.name, input });
        break;
      }

      case "custom_tool_call_output":
      case "function_call_output": {
        const blocks = toAnthropicBlocks(item.output);
        push("user", {
          type: "tool_result",
          tool_use_id: item.call_id,
          content: blocks.length ? blocks : [{ type: "text", text: "(no output)" }],
        });
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
        break;
    }
  }

  // compaction_trigger 本身沒有文字，模型不會知道要做什麼；補上與 Codex 本機
  // 壓縮同一份提示詞，產出的摘要格式才會跟官方一致。
  if (compaction) push("user", { type: "text", text: COMPACTION_PROMPT });

  const thinkingTrimmed = normalizeAssistantMessages(messages);

  // Anthropic 要求首個訊息必須是 user。
  if (!messages.length || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: [{ type: "text", text: "." }] });
  }

  const imagesOmitted = applyImageBudget(messages);

  const { tools, freeform } = toAnthropicTools(codexTools);

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
  // 壓縮回合只能回一個 compaction 項目，帶著工具反而會讓模型改去呼叫工具。
  if (tools.length && !compaction) {
    request.tools = tools;
    if (body.tool_choice === "auto" || !body.tool_choice) request.tool_choice = { type: "auto" };
    else if (body.tool_choice === "required") request.tool_choice = { type: "any" };
    else if (body.tool_choice === "none") delete request.tools;
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

  return { request, freeform, compaction, imagesOmitted, thinkingTrimmed };
}

// ---------------------------------------------------------------- 回應方向

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
 * @param {{model: string, requestBody: object, freeform: Set<string>, compaction?: boolean}} ctx
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

  const decoder = new TextDecoder();
  let pending = "";

  const handle = (event) => {
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
        } else if (block.type === "text") {
          cur = { kind: "text", itemId: randomId("msg_", 54), text: "", index: outputIndex };
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
          cur = {
            kind: isFreeform ? "custom_tool" : "function_tool",
            itemId: randomId("fc_", 54),
            callId: block.id,
            name: block.name,
            json: "",
            index: outputIndex,
          };
          send({
            type: "response.output_item.added",
            output_index: outputIndex,
            item: isFreeform
              ? { id: cur.itemId, type: "custom_tool_call", status: "in_progress", call_id: cur.callId, input: "", name: cur.name }
              : { id: cur.itemId, type: "function_call", status: "in_progress", call_id: cur.callId, arguments: "", name: cur.name },
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
        if (cur.kind === "thinking") {
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
          let parsed = {};
          try { parsed = JSON.parse(cur.json || "{}"); } catch {}
          if (cur.kind === "custom_tool") {
            const input = typeof parsed[FREEFORM_KEY] === "string" ? parsed[FREEFORM_KEY] : (cur.json || "");
            send({ type: "response.custom_tool_call_input.delta", delta: input, item_id: cur.itemId, output_index: cur.index });
            send({ type: "response.custom_tool_call_input.done", input, item_id: cur.itemId, output_index: cur.index });
            const item = { id: cur.itemId, type: "custom_tool_call", status: "completed", call_id: cur.callId, input, name: cur.name };
            output.push(item);
            send({ type: "response.output_item.done", output_index: cur.index, item });
          } else {
            const args = JSON.stringify(parsed);
            send({ type: "response.function_call_arguments.delta", delta: args, item_id: cur.itemId, output_index: cur.index });
            send({ type: "response.function_call_arguments.done", arguments: args, item_id: cur.itemId, output_index: cur.index });
            const item = { id: cur.itemId, type: "function_call", status: "completed", call_id: cur.callId, arguments: args, name: cur.name };
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
        send({ type: "response.completed", response });
        break;
      }

      case "error": {
        send({ type: "error", error: event.error || { message: "上游錯誤" } });
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
__CODEX_MODEL_ROUTER_EMBEDDED__
#>
