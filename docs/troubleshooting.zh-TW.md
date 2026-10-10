# 疑難排解與健康檢查

[简体中文](troubleshooting.md) · [繁體中文](troubleshooting.zh-TW.md) · [回到 README](../README.zh-TW.md) · [完整使用說明](guide.zh-TW.md)

先執行 `status` 確認安裝與服務狀態，再找下面對應的症狀。回報問題時請附上作業系統、桌面版版本、路由器版本，以及去除 API Key 後的錯誤訊息。

**目錄**

- [模型選單顯示舊名稱或已刪除的模型](#模型選單顯示舊名稱或已刪除的模型)
- [Claude 回合突然沒有回覆](#claude-回合突然沒有回覆)
- [某條對話一直失敗，但新開的對話正常](#某條對話一直失敗但新開的對話正常)
- [Claude 對話出現 each tool_use must have a single result](#claude-對話出現-each-tool_use-must-have-a-single-result)
- [管理頁出現 404 custom_model_not_configured](#管理頁出現-404-custom_model_not_configured)
- [選擇器裡看不到某個官方模型](#選擇器裡看不到某個官方模型)
- [需要看路由器實際送出去的內容](#需要看路由器實際送出去的內容)
- [回退之後，用過 Claude 模型的舊對話會壞掉](#回退之後用過-claude-模型的舊對話會壞掉)
- [健康檢查](#健康檢查)

## 模型選單顯示舊名稱或已刪除的模型

從 1.27.8 起，可在網頁管理頁總覽點擊「同步與修復模型清單」，或執行 `bash codex-model-router.sh repair-models`（Windows：`powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 repair-models`）。這會備份並清除可重建的模型清單快取，校驗名稱、可見性及預設模型，不發送模型推理請求。只有舊路由能證明同一供應商、同一上游模型的唯一對應時才遷移預設 ID，否則清除失效預設。完成後重新展開模型選單；介面仍未刷新時，請完全退出桌面版再開啟（macOS 用 ⌘Q，關閉視窗不等於退出）。既有任務保存的模型選擇需要手動重選。

## Claude 回合突然沒有回覆

更新到 1.25.2 以上後，明確的上游拒答會顯示原因；沒有標示拒答的空回覆也會顯示錯誤。
拒答時，移除或改寫觸發的內容後再試；若同一對話仍帶著該內容，請改開新對話。單純按「繼續」
會再次送出相同歷史。舊版若已把 `(compaction produced no summary)` 寫進壓縮歷史，更新無法
自動還原那次已被取代的內容。

若安裝時 Claude 模型被跳過，用診斷腳本確認是哪一類問題：

```bash
bash claude-probe-diag.sh <API_ROOT> <模型名>
```

```powershell
powershell -ExecutionPolicy Bypass -File .\claude-probe-diag.ps1 <API_ROOT> <模型名>
```

兩個腳本都會以隱藏輸入的方式詢問 API Key，不會留在命令歷史；macOS 版也可改用環境變數
`CODEX_ROUTER_API_KEY` 提供。它會分別檢查模型是否在清單中、原生 `/v1/messages` 的實際
狀態碼與訊息、以及 `/v1/responses` 對照組。上游暫時不可用（5xx）時重跑安裝器即可加入。

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

## 某條對話一直失敗，但新開的對話正常

長對話會累積大量歷史圖片。Codex 的壓縮門檻按 token 計算，Base64 圖片的傳輸大小卻可能
先撞上 HTTP 請求上限。已觀察到一條對話成功壓縮後再累積 13 張工具截圖，加上 5 張使用者
圖片就超過 32 MB；總共不到 20 張，原本的圖片張數限制完全不會觸發。

**1.18.2 起會自動縮減舊工具截圖。** 自訂 GPT 與 Claude 路由在完成歷史重建、格式轉譯後，
依實際送出的 JSON 大小處理；超過請求上限的 75% 時，從最舊的工具截圖開始替換成原圖路徑。
預設上限仍是 32 MiB（訊息顯示為 MB），因此縮減目標為 24 MiB，保留後續工具往返的空間。
`settings.json` 的 `maxUpstreamRequestBytes` 可調整請求上限；數值須符合實際上游限制。

位元組預算會保留使用者附件、文字與工具呼叫配對，至少留下最新四張工具截圖，且最新一組
工具結果中的圖片全部保留。省略前會把原圖存到 `<CODEX_HOME>/model-router/history-images/`，
模型需要細節時可依路徑重新讀取。檔名依內容去重，重試不會重複保存同一張圖；路由器不會
自動刪除封存圖，也不改寫 Codex 的對話歷史。保存失敗時保留原圖。

一般回合、HTTP / WebSocket 與壓縮請求都套用同一個預算，因此舊截圖造成的 413 可以在
原對話重試。使用實際失敗歷史的離線重播，一般與壓縮請求都由 32.63 MiB 降到 21.78 MiB，
移出四張舊工具截圖；這是本機重建驗證，未將該歷史重新送往上游。

若使用者附件、近期截圖或文字本身就超限，仍會回 413 並說明原因，需要縮小圖片、減少附件，
或把工作摘要帶到新對話。壓縮能否成功取決於縮減後的請求大小；不是所有 413 都只能開新對話。

## Claude 對話出現 each tool_use must have a single result

錯誤全文類似
``messages.60.content.1: each tool_use must have a single result. Found multiple `tool_result` blocks with id: toolu_...``。
通常是模型在 Code Mode 的 `exec` 裡呼叫了 `notify()` 回報進度：
Codex 會把每則通知記成同一個工具呼叫的額外輸出，1.22.3 以前的 Claude 轉譯把每一筆都轉成獨立的
`tool_result`，上游因此拒收。之後每一輪都會重送同一段歷史，連用 Claude 壓縮也會失敗，整條對話看起來就像卡死。

升級到 1.22.4 以上即可。路由器每次都會重新轉譯完整歷史，原本卡住的對話不必壓縮或新開就能繼續；
`/healthz` 的 `claudeToolOutputsMerged` 大於 0 代表這類歷史已被合併處理。

## 管理頁出現 404 custom_model_not_configured

每個任務都會記住自己最後用的模型。模型從路由器刪除後，任務的設定不會跟著改；
Codex 每次打開這類任務，都會先用記住的模型送一個預熱請求。1.27.x 以前路由器會把它
記成 404，看起來像有人還在用已刪除的模型，其實只是任務被打開，沒有送往上游、不消耗用量。

1.28.0 起，這類預熱改為靜默完成，只在 `/healthz` 的 `stalePrewarms` 與
`lastStalePrewarmModel` 留下計數與最近一次的模型；在那個任務真的送出訊息時才回 404，
錯誤會寫出模型名稱，也不再誤記成主要供應商。在同一個任務的模型選單改選現有模型再重送
即可，不必開新任務；不再需要的任務直接封存也可以。

## 選擇器裡看不到某個官方模型

1.22.0 起，重新啟動 Codex 會向官方同步帳號最新模型清單。先更新路由器並重開 Codex；
如果同步失敗，會使用本地清單，可從 `/healthz` 的 `stats.lastCatalogSync` 查看狀態。
若自行配置了 `model_catalog_json`，它仍會阻止遠端同步；升級只移除本工具管理的固定目錄。

用 `hidden-models` 命令即可——它會列出所有被標成隱藏的模型讓你勾選，選中的會強制顯示。
安裝與重新配置不會詢問這一項，但既有選擇會原樣沿用。也可以直接編輯 `settings.json` 的
`forceListedModels`（一組 slug 字串），重啟路由器及 Codex 後合併時會套用。

強制顯示只影響選擇器。能不能用仍然由後端決定，帳號沒權限的話選了會在請求時失敗。

管理隱藏模型不需要重新探測或重設任何自訂模型，直接執行：

```bash
bash codex-model-router.sh hidden-models
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 hidden-models
```

這個命令只會重新讀取 Codex 的 bundled 模型目錄，更新 `forceListedModels` 與
`models.json`，保留既有的 `custom/*` 模型；寫入前會備份，完成後會驗證目錄並重啟路由器。
它不需要 Base URL 或 API Key。選擇時留空會保留目前設定，輸入 `none` 才會全部恢復為隱藏。
執行完請完全退出並重新打開 Codex Desktop，模型選擇器才會刷新。

## 需要看路由器實際送出去的內容

`settings.json` 設 `captureDir` 為一個目錄路徑，重啟路由器後每一輪都會落地成檔案：
送往上游的請求、轉譯後的 Anthropic 請求、上游回應與錯誤內文。WebSocket 與 HTTP 兩條
路徑都會擷取。

這些檔案含有完整的對話內容，查完請自行刪除，並把 `captureDir` 拿掉。

## 回退之後，用過 Claude 模型的舊對話會壞掉

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

`localPrewarms` 是本機完成的預熱次數，打開或新建自訂模型任務時增加屬正常；
`stalePrewarms` 與 `lastStalePrewarmModel` 記錄打開仍綁定已刪除模型的任務，見[疑難排解](#管理頁出現-404-custom_model_not_configured)。

`oversizeRejects` 增加代表有請求因為太大而被路由器擋下來，沒有送往上游。

`toolImagesOmitted` 與 `toolImageBytesSaved` 記錄圖片大小預算省下的舊工具截圖與位元組；
`lastRequestBytesBeforeBudget` / `lastRequestBytesAfterBudget` 是最近一次自訂請求縮減前後的大小。
`imageArchiveFailures` 增加代表原圖無法保存，這些圖片會留在請求中，不會被悄悄丟掉。

`/healthz` 的 `historyCache` 顯示快照筆數、序列化位元組總量、預算及過期時間，
不包含對話內容。此數字不是整個 Node.js 程序的實際記憶體占用量。

`imagesOmitted` 增加代表有圖片在送出前被換成佔位文字。單次請求超過 20 張圖時，上游會把
每張圖的尺寸上限從 8000 收緊到 2000 像素（iPhone 截圖 942 x 2048 就會超過），因此路由器
把數量壓在 20 張以內；啟用 Claude 提示快取時，每跨過上限就整批省略最舊的 8 張，
否則只省略超出的張數。
單張任一邊超過 8000 像素的也會被換掉。

`truncatedUpstreamStreams` 增加代表上游在送出終止事件前就把串流結束掉了（閘道中斷回應
最常見）。這種情況讀取端只看到乾淨的 EOF、不是例外，所以路由器會補一個 `response.failed`
讓客戶端明確收尾，而不是無聲斷線。

`upstreamErrorsWithoutTerminal` 是上游只送了頂層 `error` 就結束串流的次數。Codex 會忽略
單獨的 `error`，路由器因此用它的內容補上 `response.failed`。錯誤碼會換成 Codex 認得的值：
上下文爆掉是 `context_length_exceeded`（不重試）、過載是 `server_is_overloaded`、
限流是 `rate_limit_exceeded`（上游給了 `retry-after` 就照著等）、額度用盡是 `insufficient_quota`。

`claudeRefusals` 記錄 Claude 串流明確以 `stop_reason: refusal` 拒答的次數；Codex 會顯示上游
提供的類別與原因。`claudeEmptyResponses` 記錄上游宣告完成、卻沒有答案或工具呼叫的次數，
這只能確認回覆為空，不能單靠它判定為拒答。`claudeCompactionFailures` 記錄壓縮時遭拒、
摘要為空或未完整生成的次數；這些回合以失敗收尾，不會寫入佔位摘要取代原始歷史。

`credentialReads` 是實際讀取（Windows 為解密）API Key 的次數。Windows 以憑證檔的修改時間
判斷 Key 是否更換，檔案沒變就沿用快取，這個數字應該很少增加。每家供應商各自快取。

`providers` 列出每家供應商的名稱、上游主機與模型數；`stats.lastProvider` 是最近一次自訂模型
請求送到哪一家，`stats.lastImageProvider` 是最近一次生圖送到哪一家。

`chatTranslatedRequests` 是經 Chat Completions 轉譯送出的請求數。`chatPlaceholderToolResults` 是替
沒有結果的工具呼叫補上 `(no output)` 的次數，`chatToolOutputsMerged` 與 `chatLateToolOutputs` 分別是
併回原結果、改成文字的後續工具輸出數；同一段歷史每送一次就再累加，增加本身不代表出錯。

`foreignHostRejects` 是 Host 不是本機名稱而被拒絕的請求數（DNS rebinding 會是這種樣子）；
`browserRequestsRejected` 是瀏覽器網頁對生圖或 Ark 端點發起、被拒絕的請求數。
兩者在正常使用下都應為 0。

`authProbeGraceUsed` 是 ChatGPT 驗證探測失敗（網路錯誤或 401/403 以外的狀態），但同一組憑證
在寬限期內驗證成功過而放行的次數。寬限期預設 24 小時，可用 `settings.json` 的
`authProbeGraceMs` 調整（毫秒，0 代表關閉），重啟路由器後生效；401/403 一律拒絕。

`upstreamWebSocketFallbacks` 增加代表官方的上游 WebSocket 當下不通，已自動回退 HTTP，
功能不受影響。連續握手失敗達門檻後 `upstreamWebSocketCooldowns` 會加一，路由器接著
一段時間內直接走 HTTP，不再每條新連線都重試；上游一旦恢復就立刻解除。

`claudeToolOutputsMerged` 是 Claude 轉譯時併回原結果的後續工具輸出數，`claudeLateToolOutputs`
是改成文字的遲到輸出數，`claudeToolResultsReordered` 是為了讓工具結果排在最前面而調整的訊息數。
這些值每次轉譯都會重新計算，同一段歷史每送一次就再累加；增加本身不代表出錯。

實際埠號以 `status` 印出的為準：48953 被佔用時安裝器會自動往後找。
