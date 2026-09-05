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
curl -fsSL https://github.com/funkeyyou/codex-model-router/raw/refs/heads/main/codex-model-router.sh -o codex-model-router.sh && bash codex-model-router.sh
```

> 用 `curl` 下載不會被加上隔離屬性，所以不會跳 Gatekeeper 警告。
> 若改用瀏覽器下載，請以 `bash codex-model-router.sh` 執行，不要在 Finder 雙擊。

### Windows

在 PowerShell 視窗裡執行（`.ps1` 直接雙擊只會用記事本開啟）：

```powershell
curl.exe -fsSL https://github.com/funkeyyou/codex-model-router/raw/refs/heads/main/codex-model-router.ps1 -o codex-model-router.ps1; powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1
```

> 同樣地，用 `curl.exe` 下載不會被標上「來自網際網路」，不會觸發 SmartScreen 警告。
> 若改用瀏覽器下載，先在檔案內容裡按「解除封鎖」再執行。

安裝時會詢問三件事：Base URL、API Key、以及要加入哪些模型。
輸入 API Key 時畫面不會顯示任何字元（跟 `sudo` 一樣），貼上後直接按 Enter。

## 版本資訊與更新內容

安裝器啟動時會顯示「已安裝版本」、「目前這支安裝器版本」與「GitHub 線上最新版本」。
若有更新，會按版本順序列出從已安裝版本到最新版之間的所有變更；若手上的安裝器本身
已落後，也會先提示重新下載最新版，避免用舊腳本覆蓋新安裝。

版本資料來自 repo 根目錄的 `releases.json`。檢查逾時或離線時只會顯示無法檢查，
不會阻塞安裝、添加模型、狀態檢查或回退流程，也不會上傳任何本機設定。

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

> 回退前請先看「[回退之後，用過 Claude 模型的舊對話會壞掉](#回退之後用過-claude-模型的舊對話會壞掉)」。

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
- **推理強度真的會生效**——`thinking.budget_tokens` 在較新的模型上已被移除（官方直接
  400，部分閘道靜默丟棄），結果是在 Codex 裡選 low 或 max 毫無差別、而且一律跑在高強度。
  安裝時會探測 `output_config.effort`，支援的話把五檔直接透傳。實測 low 檔耗時從
  約 17 秒降到約 9.5 秒。
- **閘道生的圖不再石沉大海**——部分閘道會自行啟用 `image_generation`，回應帶著整張圖，
  但 Codex 只在自己發起生圖時才會建立可渲染項目，收到了也只是塞進歷史。路由器因此把它
  翻成 Codex 的內建 `view_image` 呼叫：圖先落地（預設是使用者的「下載」，安裝時解析後
  寫進 `settings.json` 的 `imageOutputDir`，可自行改掉；Windows 會讀已知資料夾的實際
  位置，「下載」被搬到別的磁碟也不會寫錯地方），
  再合成一次工具呼叫，Codex 就會產生 `ImageView` 項目顯示出來（在工具活動區塊裡），
  模型自己也拿得到那張圖。合成的呼叫用可辨識的 `call_id` 前綴，送往上游前連同輸出一起剝除
  ——上游不認得這個工具，留著會讓下一輪被拒。`viewImageBridge = false` 可只保留存檔。
- **顯示推理摘要**——這些模型預設 `display` 是 `omitted`：thinking 區塊照樣送來，
  但文字是空的。安裝時探測 `adaptive`／`summarized`，支援就明確要求摘要，並把它串成
  `reasoning_summary` 事件、寫進 reasoning 項目的 `summary` 欄位——Codex 顯示的是
  這個欄位，`encrypted_content` 只負責往返，兩者都要處理才看得到。
- **對話歷史可被快取**——Anthropic 的快取前綴是 `tools → system → messages`，只在
  system 掛斷點的話，會長大的歷史每輪都要重算。安裝時探測頂層 `cache_control`，
  支援就加上滾動斷點。實測約 2 萬 token 的歷史，未快取輸入從 19650 降到 2。
  兩項探測失敗或不支援時都自動沿用原有行為。
- **有狀態接續的本機重建**——Codex 在工具接續回合只送工具結果並倚賴
  `previous_response_id`，但該參數需要真正的 WebSocket 上游。本路由改以
  「上次完整輸入 + 該輪輸出 + 本次新項目」在本機重建等價的完整請求；每條
  WebSocket 都有獨立的歷史 namespace，背景任務即使重複使用同一個 `session_id`
  也不會覆蓋目前對話。
- **上游不通時自動收斂重試**——官方的上游 WebSocket 連續握手失敗後，整個路由器
  暫停嘗試一段時間並直接走 HTTP，避免每個新對話的第一輪都先賠一次握手；
  上游恢復後立刻解除。門檻與冷卻時間可用 `settings.json` 的
  `upstreamWebSocketFailureThreshold` 與 `upstreamWebSocketCooldownMs` 調整。
- **模型目錄跟得上 Codex 更新**——`config.toml` 的 `model_catalog_json` 指著一份
  安裝當下的快照，Codex 之後更新、內建了新模型，這個檔不會跟著動，選擇器裡就永遠
  看不到，而且失敗是靜默的。路由器因此在 Codex 執行檔變更時自動重建目錄（平常只是
  一次 stat）。`settings.json` 的 `catalogRefresh = false` 可關閉。
- **被藏起來的官方模型可以叫出來**——內建目錄會把尚未普及的模型標成 `hide`，但實際
  能不能用是後端依帳號決定的；`model_catalog_json` 會蓋掉後端的判斷，於是帳號明明
  有權限也看不到（手機看得到就是因為它直接問後端）。安裝時會列出這些模型讓你選，
  選擇記在 `settings.json` 的 `forceListedModels`。
- **連線保活**——長請求期間送出 WebSocket ping，避免客戶端閒置逾時。
- **錯誤可見**——上游錯誤會轉為標準的 `response.failed` 事件，不會讓客戶端無聲卡住。
  這包含最難察覺的一種：閘道在回應中途把串流丟掉。此時讀取端收到的是乾淨的 EOF 而不是
  例外，狀態碼當初又是 200，兩種既有的錯誤處理都接不到——三條串流路徑因此都會在讀完後
  確認終止事件真的送出去了，沒有就補上。

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

`truncatedUpstreamStreams` 增加代表上游在送出終止事件前就把串流結束掉了（閘道中斷回應
最常見）。這種情況讀取端只看到乾淨的 EOF、不是例外，所以路由器會補一個 `response.failed`
讓客戶端明確收尾，而不是無聲斷線。

`upstreamWebSocketFallbacks` 增加代表官方的上游 WebSocket 當下不通，已自動回退 HTTP，
功能不受影響。連續握手失敗達門檻後 `upstreamWebSocketCooldowns` 會加一，路由器接著
一段時間內直接走 HTTP，不再每條新連線都重試；上游一旦恢復就立刻解除。

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

路由器的 stderr 記錄在 `<CODEX_HOME>/model-router/router.err.log`。服務啟動時若發現
該檔超過 5 MB 會就地清空（可用 `settings.json` 的 `maxLogBytes` 調整），因此長期
出錯也不會把磁碟寫滿。

這個檔是不帶 BOM 的 UTF-8。Windows PowerShell 5.1 的 `Get-Content` 預設用系統
ANSI 代碼頁讀檔（跟主控台的 `chcp 65001` 無關），中文會整片變亂碼，要明講編碼：

```powershell
Get-Content "$env:USERPROFILE\.codex\model-router\router.err.log" -Tail 50 -Encoding UTF8
```

### 選擇器裡看不到某個官方模型

Codex 的內建目錄會把尚未普及的模型標成 `hide`。沒裝路由器時 Codex 會直接問後端，
帳號有權限就看得到；裝了之後 `model_catalog_json` 會蓋掉後端的判斷，於是同一個帳號
在桌面版看不到、手機上卻看得到。

重跑安裝器即可——它會列出所有被標成隱藏的模型讓你勾選，選中的會強制顯示。也可以直接
編輯 `settings.json` 的 `forceListedModels`（一組 slug 字串），路由器發現目錄裡還有
該顯示卻沒顯示的模型時會自動重建目錄。

強制顯示只影響選擇器。能不能用仍然由後端決定，帳號沒權限的話選了會在請求時失敗。

### 需要看路由器實際送出去的內容

`settings.json` 設 `captureDir` 為一個目錄路徑，重啟路由器後每一輪都會落地成檔案：
送往上游的請求、轉譯後的 Anthropic 請求、上游回應與錯誤內文。WebSocket 與 HTTP 兩條
路徑都會擷取。

這些檔案含有完整的對話內容，查完請自行刪除，並把 `captureDir` 拿掉。

### 回退之後，用過 Claude 模型的舊對話會壞掉

症狀是切回官方模型後，該對話每次都被擋下來：

```
Invalid 'input[60].id': 'cmp_PTzs...'. Expected an ID that contains letters,
numbers, underscores, or dashes, but this value contained additional characters.
```

（`cmp_` 也可能是 `msg_`、`fc_`、`rs_`。官方那句「contained additional
characters」講得不準，那些 id 其實只有英數字和底線。）

原因是轉譯層會自鑄項目 id：Anthropic 的原生事件沒有 Codex 要的那些 id，本機轉譯時
只能自己生。這些項目留在 Codex 的對話歷史裡，而**路由器本來就會在把請求送往非
Anthropic 路由前，把它們改寫或剝除掉**——健康檢查的 `bridgeIdsStripped` 與
`bridgeCompactionRewritten` 數的就是這件事。

回退等於把這個清理層一起移掉，於是 Codex 會把原封不動的歷史直接送給官方後端，然後
被拒。這不是回退沒做乾淨——歷史存在 Codex 那邊，不在路由器管得到的範圍。

兩種解法：

- **重新安裝路由器**，清理層回來，那條對話就能接著用；
- 或**開一條新對話**。用過 Claude 模型的舊對話，只要不裝路由器就救不回來。

沒用過 Claude 模型的對話不受影響。

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

發布新版本時也要更新 `releases.json` 的 `latest` 與對應更新說明；同步工具會驗證
`latest` 是否和安裝器內的 `INSTALLER_VERSION` 一致。

### 測試

測試直接把 `.sh` 裡的三段負載取出來 import，所以測到的一定是會發佈出去的那份
（repo 裡沒有獨立的 `router.mjs`，那些檔案只在安裝後存在於 `CODEX_HOME`）。

```bash
npm test     # node --test，無需安裝任何相依套件
npm run check   # 等同 CI：先驗負載同步，再跑測試
```

安裝器與路由器的頂層本來就有副作用（跑安裝流程、佔用連接埠），測試靠
`CODEX_MODEL_ROUTER_IMPORT_ONLY=1` 擋掉，其餘模組載入行為完全一致。

### CI

`.github/workflows/ci.yml` 在 push 與 PR 上跑兩個 job：

- **ubuntu**——負載同步檢查、測試（Node 22 與 24）、`.sh` 與 `.ps1` 的語法檢查，
  以及 `.ps1` 的 UTF-8 BOM 檢查。
- **windows**——同一份同步檢查與測試在 Windows 簽出上再跑一次，語法檢查改用
  Windows 內建的 PowerShell 5.1，並確認 5.1 讀這支 `.ps1` 的編碼是對的。

之所以要有第二個 job：使用者實際跑的是 5.1，但 CI 上的 `pwsh` 是 7，`??`、`?.`、
三元運算子與 `&&` 在 7 上都合法、到了 5.1 才是語法錯誤。負載這邊也一樣——POSIX
專用的路徑（拿 `/dev/null/nope` 當「寫不進去的目錄」是實際發生過的例子）在
Windows 上會變成普通相對路徑，測試照樣綠燈，其實什麼都沒驗到。

下面那兩件事之所以要自動擋，是因為它們壞掉都不會立刻報錯。

**請不要手改 `.ps1`，也不要自己寫同步腳本。** 那個工具除了搬運文字，還負責兩件
容易被忽略、壞掉又不會立刻報錯的事：

- `.ps1` 開頭必須保留 UTF-8 BOM。PowerShell 5.1 少了 BOM 會改用 ANSI 代碼頁讀檔，
  安裝器的所有中文訊息都會變成亂碼。
- 三段負載要整批同步。只同步其中一段（例如只改了 installer 就只搬 installer）
  會讓 Windows 版靜默停留在舊的 router 或 claude-bridge。

換行由 `.gitattributes` 統一成 LF；混進 CRLF 會讓 `--check` 在不同平台的簽出上誤報。

## 授權

MIT
