# Claude 原生端點診斷 —— 找出安裝器為何跳過 Claude 模型
# 用法： powershell -ExecutionPolicy Bypass -File .\claude-probe-diag.ps1 <API_ROOT> [模型名]
#   例： powershell -ExecutionPolicy Bypass -File .\claude-probe-diag.ps1 https://your-gateway.example.com/v1 claude-opus-5
#
# 不傳 -ApiKey 時會以隱藏輸入的方式詢問，避免 API Key 留在命令歷史裡。

param(
  [Parameter(Mandatory = $true, Position = 0)][string] $ApiRoot,
  [Parameter(Position = 1)][string] $Model = 'claude-opus-5',
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
if (-not $ApiKey) { throw 'API Key 不能為空。' }

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
  if (-not $Text) { Write-Host '    （空響應）'; return }
  $excerpt = $Text.Substring(0, [Math]::Min($Length, $Text.Length))
  foreach ($line in ($excerpt -split "`r?`n")) { Write-Host "    $line" }
}

Write-Host "API Root : $ApiRoot"
Write-Host "模型     : $Model"
Write-Host ''

Write-Host '── 1. /models 是否列得出這個模型 ──'
$models = Invoke-Probe -Method Get -Url "$ApiRoot/models" -TimeoutSeconds 30
if ($models.Status -ne 200) {
  Write-Host "  HTTP $($models.Status)"
  Write-Excerpt -Text $models.Body -Length 300
} else {
  try {
    $ids = @(($models.Body | ConvertFrom-Json).data | ForEach-Object { $_.id })
    Write-Host "  共 $($ids.Count) 個模型"
    Write-Host "  $Model 在清單中: $($ids -contains $Model)"
    $claude = @($ids | Where-Object { $_ -and $_.ToLower().Contains('claude') })
    Write-Host "  可用的 Claude 模型: $(if ($claude.Count) { $claude -join ', ' } else { '（無）' })"
  } catch {
    Write-Host "  解析失敗: $($_.Exception.Message)"
  }
}
Write-Host ''

Write-Host '── 2. /messages 原生端點（安裝器實際探測的那支）──'
$messagesBody = @{
  model      = $Model
  max_tokens = 16
  stream     = $true
  messages   = @(@{ role = 'user'; content = 'Reply with exactly OK.' })
} | ConvertTo-Json -Depth 5 -Compress
$messages = Invoke-Probe -Method Post -Url "$ApiRoot/messages" -Body $messagesBody
Write-Host "  HTTP $($messages.Status)   耗時 $($messages.Seconds)s"
Write-Host '  響應前 400 字：'
Write-Excerpt -Text $messages.Body -Length 400
Write-Host ''

Write-Host '── 3. 對照組：/responses（若這支通、/messages 不通，代表閘道沒開原生端點）──'
$responsesBody = @{ model = $Model; input = 'Reply with exactly OK.'; stream = $false } |
  ConvertTo-Json -Depth 5 -Compress
$responses = Invoke-Probe -Method Post -Url "$ApiRoot/responses" -Body $responsesBody
Write-Host "  HTTP $($responses.Status)"
Write-Host '  響應前 300 字：'
Write-Excerpt -Text $responses.Body -Length 300
