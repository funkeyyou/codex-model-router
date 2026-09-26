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
