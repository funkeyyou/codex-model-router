# Claude 原生端点诊断 —— 找出安装器为何跳过 Claude 模型
# 用法： powershell -ExecutionPolicy Bypass -File .\claude-probe-diag.ps1 <API_ROOT> [模型名]
#   例： powershell -ExecutionPolicy Bypass -File .\claude-probe-diag.ps1 https://your-gateway.example.com/v1 ark/claude-opus-5
#
# 不传 -ApiKey 时会以隐藏输入的方式询问，避免 API Key 留在命令历史里。

param(
  [Parameter(Mandatory = $true, Position = 0)][string] $ApiRoot,
  [Parameter(Position = 1)][string] $Model = 'ark/claude-opus-5',
  [string] $ApiKey
)

$ErrorActionPreference = 'Stop'
$ApiRoot = $ApiRoot.TrimEnd('/')

if (-not $ApiKey) {
  $secure = Read-Host -Prompt 'API Key' -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secure)
  try { $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringUni($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($ptr) }
}
if (-not $ApiKey) { throw 'API Key 不能为空。' }

Add-Type -AssemblyName System.Net.Http
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Invoke-Probe {
  param([string] $Method, [string] $Url, [string] $Body, [int] $TimeoutSeconds = 60)

  $client = New-Object System.Net.Http.HttpClient
  try {
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
    $request = New-Object System.Net.Http.HttpRequestMessage ([System.Net.Http.HttpMethod]::$Method), $Url
    $null = $request.Headers.TryAddWithoutValidation('authorization', "Bearer $ApiKey")
    if ($Body) {
      $request.Content = New-Object System.Net.Http.StringContent($Body, [Text.Encoding]::UTF8, 'application/json')
    }
    $started = [Diagnostics.Stopwatch]::StartNew()
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return [pscustomobject]@{
      Status  = [int] $response.StatusCode
      Seconds = [math]::Round($started.Elapsed.TotalSeconds, 2)
      Body    = $text
    }
  } catch {
    return [pscustomobject]@{ Status = 0; Seconds = 0; Body = $_.Exception.Message }
  } finally {
    $client.Dispose()
  }
}

function Write-Excerpt {
  param([string] $Text, [int] $Length)
  if (-not $Text) { Write-Host '    （空响应）'; return }
  $excerpt = $Text.Substring(0, [Math]::Min($Length, $Text.Length))
  foreach ($line in ($excerpt -split "`r?`n")) { Write-Host "    $line" }
}

Write-Host "API Root : $ApiRoot"
Write-Host "模型     : $Model"
Write-Host ''

Write-Host '── 1. /models 是否列得出这个模型 ──'
$models = Invoke-Probe -Method Get -Url "$ApiRoot/models" -TimeoutSeconds 30
if ($models.Status -ne 200) {
  Write-Host "  HTTP $($models.Status)"
  Write-Excerpt -Text $models.Body -Length 300
} else {
  try {
    $ids = @(($models.Body | ConvertFrom-Json).data | ForEach-Object { $_.id })
    Write-Host "  共 $($ids.Count) 个模型"
    Write-Host "  $Model 在清单中: $($ids -contains $Model)"
    $claude = @($ids | Where-Object { $_ -and $_.ToLower().Contains('claude') })
    Write-Host "  可用的 Claude 模型: $(if ($claude.Count) { $claude -join ', ' } else { '（无）' })"
  } catch {
    Write-Host "  解析失败: $($_.Exception.Message)"
  }
}
Write-Host ''

Write-Host '── 2. /messages 原生端点（安装器实际探测的那支）──'
$messagesBody = @{
  model      = $Model
  max_tokens = 16
  stream     = $true
  messages   = @(@{ role = 'user'; content = 'Reply with exactly OK.' })
} | ConvertTo-Json -Depth 5 -Compress
$messages = Invoke-Probe -Method Post -Url "$ApiRoot/messages" -Body $messagesBody
Write-Host "  HTTP $($messages.Status)   耗时 $($messages.Seconds)s"
Write-Host '  响应前 400 字：'
Write-Excerpt -Text $messages.Body -Length 400
Write-Host ''

Write-Host '── 3. 对照组：/responses（若这支通、/messages 不通，代表网关没开原生端点）──'
$responsesBody = @{ model = $Model; input = 'Reply with exactly OK.'; stream = $false } |
  ConvertTo-Json -Depth 5 -Compress
$responses = Invoke-Probe -Method Post -Url "$ApiRoot/responses" -Body $responsesBody
Write-Host "  HTTP $($responses.Status)"
Write-Host '  响应前 300 字：'
Write-Excerpt -Text $responses.Body -Length 300
