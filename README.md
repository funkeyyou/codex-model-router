# codex-model-router

讓 Codex Desktop 在保留官方模型的同時，額外使用相容 OpenAI 介面的自訂供應商。

官方 ChatGPT 模型仍直接送往 OpenAI，只有你選取的自訂模型會送往你設定的 Base URL。
Codex 仍使用內建的 `openai` 供應商 ID，所以桌面版與手機 Remote 既有的對話都不受影響。

支援 macOS 與 Windows：兩邊跑的是同一份路由器與轉譯程式碼，只有「憑證存放」與
「背景常駐」兩件事按平台走各自的原生機制。

## 安裝

兩個平台各有一支進入點——macOS 是 bash 腳本，Windows 是 PowerShell 腳本。兩邊的
shell 與下載工具不同，沒辦法共用同一行指令；但裝出來的東西完全一樣：同一份路由器
與轉譯程式碼、同一套設定流程。

### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/funkeyyou/codex-model-router/main/codex-model-router.sh -o codex-model-router.sh && bash codex-model-router.sh
```

> 用 `curl` 下載不會被加上隔離屬性，所以不會跳 Gatekeeper 警告。
> 若改用瀏覽器下載，請以 `bash codex-model-router.sh` 執行，不要在 Finder 雙擊。

### Windows

在 PowerShell 視窗裡執行（`.ps1` 直接雙擊只會用記事本開啟）：

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/funkeyyou/codex-model-router/main/codex-model-router.ps1 -o codex-model-router.ps1; powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1
```

> 同樣地，用 `curl.exe` 下載不會被標上「來自網際網路」，不會觸發 SmartScreen 警告。
> 若改用瀏覽器下載，先在檔案內容裡按「解除封鎖」再執行。

安裝時會詢問三件事：Base URL、API Key、以及要加入哪些模型。
輸入 API Key 時畫面不會顯示任何字元（跟 `sudo` 一樣），貼上後直接按 Enter。

## 其他指令

不帶參數執行會出現選單，也可以直接指定動作。

macOS：

```bash
bash codex-model-router.sh status     # 檢視安裝狀態與健康度
bash codex-model-router.sh rollback   # 回退（安裝檔會封存，不會刪除）
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 status
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 rollback
```

## 平台差異

安裝流程、模型探測、路由與 Claude 轉譯在兩個平台完全相同，差別只有這兩項：

| | macOS | Windows |
| --- | --- | --- |
| API Key 存放 | 鑰匙圈（`security`） | 憑證保護 DPAPI，以目前使用者身分加密後存成檔案 |
| 背景常駐 | LaunchAgent（`launchctl`） | 工作排程器，登入時啟動 |

Windows 的常駐做法是：工作排程器以 `wscript.exe` 執行一支守護迴圈，迴圈再用隱藏視窗
啟動 `router.mjs`，路由器結束就重跑——等同 LaunchAgent 的 `KeepAlive`，而且全程不會
有主控台視窗跳出來。排程另外每 10 分鐘檢查一次，守護行程本身若被殺掉也能自動補回。

API Key 只有目前的 Windows 使用者帳號解得開，換帳號或搬到別台機器都無法解密；
兩個平台都不會把金鑰寫進 `config.toml` 或安裝器檔案。

## 功能

- **自動偵測上下文上限**——Anthropic 模型透過供應商的驗證錯誤精確取得（該探測不計費），
  其餘沿用官方同名模板；找不到時明確警告，不會靜默填入錯誤的預設值。
- **自動判斷是否需要轉譯**——優先依 `/v1/models` 的 `owned_by`；部分自架閘道完全不回
  這個欄位（例如直接回 Anthropic 格式的 `{id, type, display_name}`），此時改用模型名推斷，
  再以原生 `/messages` 驗證。推斷錯誤是安全的：探測不通會回退到通用 Responses 路由並提示。
- **Claude 模型本機轉譯**——部分閘道的 Responses 相容層對 Claude 有缺陷：有的串流回
  `stream_options` 錯誤、非串流內容為空；有的會把 Codex Code Mode 的 `namespace`
  工具包裝原樣轉給 Anthropic 而被拒（`Input tag 'namespace' does not match...`），
  導致模型調不到任何工具。此時改走 Anthropic 原生 `/v1/messages` 並在本機做雙向轉譯
  （含把 namespace 攤平），同時掛上 `cache_control` 以啟用提示快取。
- **有狀態接續的本機重建**——Codex 在工具接續回合只送工具結果並倚賴
  `previous_response_id`，但該參數需要真正的 WebSocket 上游。本路由改以
  「上次完整輸入 + 該輪輸出 + 本次新項目」在本機重建等價的完整請求。
- **連線保活**——長請求期間送出 WebSocket ping，避免客戶端閒置逾時。
- **錯誤可見**——上游錯誤會轉為標準的 `response.failed` 事件，不會讓客戶端無聲卡住。

## 健康檢查

macOS：

```bash
curl -s http://127.0.0.1:48953/healthz | python3 -m json.tool
```

Windows：

```powershell
Invoke-RestMethod http://127.0.0.1:48953/healthz | ConvertTo-Json -Depth 5
```

`failures` 應恆為 0。`statefulFallbacks` 或 `responseFailedSent` 持續增加代表上游有狀況；
`statefulRebuilds` 與 `queuedResponses` 增加屬正常。

實際埠號以 `status` 印出的為準：48953 被佔用時安裝器會自動往後找。

## 疑難排解

若安裝時 Claude 模型被跳過，用診斷腳本確認是哪一類問題：

```bash
bash claude-probe-diag.sh <API_ROOT> <API_KEY> <模型名>
```

```powershell
powershell -ExecutionPolicy Bypass -File .\claude-probe-diag.ps1 <API_ROOT> <模型名>
```

它會分別檢查模型是否在清單中、原生 `/v1/messages` 的實際狀態碼與訊息、
以及 `/v1/responses` 對照組。上游暫時不可用（5xx）時重跑安裝器即可加入。

`status` 會印出實際使用的 Node 與 Codex 執行檔路徑。Windows 上如果 Codex 桌面版升級後
換掉了自帶執行檔的版本目錄，這兩行會標示「檔案已不存在」——重跑一次安裝器即可修正。

路由器的 stderr 記錄在 `<CODEX_HOME>/model-router/router.err.log`。

## 需求

- 相容 OpenAI 介面的供應商端點
- **macOS**：Codex Desktop
- **Windows**：Windows 10 1809 以上或 Windows 11、Codex 桌面版、Node.js v22.15 以上
  （路由器需要 `node:zlib` 的 zstd 支援；Codex 自帶的 Node 也算數）

## 開發

`codex-model-router.sh` 是三段內嵌 JavaScript（installer / router / claude-bridge）的
唯一真實來源，`codex-model-router.ps1` 只是把同一段文字包進 PowerShell 註解區塊。
改完 `.sh` 之後要同步過去：

```bash
node tools/sync-payloads.mjs           # 寫入 .ps1
node tools/sync-payloads.mjs --check   # 只比對，有落差就以非零狀態結束
```

## 授權

MIT
