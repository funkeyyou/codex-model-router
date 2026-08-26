# codex-model-router

讓 Codex Desktop 在保留官方模型的同時，額外使用相容 OpenAI 介面的自訂供應商。

官方 ChatGPT 模型仍直接送往 OpenAI，只有你選取的自訂模型會送往你設定的 Base URL。
Codex 仍使用內建的 `openai` 供應商 ID，所以桌面版與手機 Remote 既有的對話都不受影響。

## 安裝

```bash
curl -fsSL https://raw.githubusercontent.com/funkeyyou/codex-model-router/main/codex-model-router.sh -o codex-model-router.sh && bash codex-model-router.sh
```

安裝時會詢問三件事：Base URL、API Key（存入 macOS 鑰匙圈）、以及要加入哪些模型。

> 用 `curl` 下載不會被加上隔離屬性，所以不會跳 Gatekeeper 警告。
> 若改用瀏覽器下載，請以 `bash codex-model-router.sh` 執行，不要在 Finder 雙擊。

## 其他指令

```bash
bash codex-model-router.sh status     # 檢視安裝狀態與健康度
bash codex-model-router.sh rollback   # 回退（安裝檔會封存，不會刪除）
```

## 功能

- **自動偵測上下文上限**——Anthropic 模型透過供應商的驗證錯誤精確取得（該探測不計費），
  其餘沿用官方同名模板；找不到時明確警告，不會靜默填入錯誤的預設值。
- **自動判斷是否需要轉譯**——依 `/v1/models` 回報的 `owned_by` 決定。
- **Claude 模型本機轉譯**——部分閘道的 Responses 相容層對 Claude 有缺陷（串流回
  `stream_options` 錯誤、非串流內容為空）。此時改走 Anthropic 原生 `/v1/messages`
  並在本機做雙向轉譯，同時掛上 `cache_control` 以啟用提示快取。
- **有狀態接續的本機重建**——Codex 在工具接續回合只送工具結果並倚賴
  `previous_response_id`，但該參數需要真正的 WebSocket 上游。本路由改以
  「上次完整輸入 + 該輪輸出 + 本次新項目」在本機重建等價的完整請求。
- **連線保活**——長請求期間送出 WebSocket ping，避免客戶端閒置逾時。
- **錯誤可見**——上游錯誤會轉為標準的 `response.failed` 事件，不會讓客戶端無聲卡住。

## 健康檢查

```bash
curl -s http://127.0.0.1:48953/healthz | python3 -m json.tool
```

`failures` 應恆為 0。`statefulFallbacks` 或 `responseFailedSent` 持續增加代表上游有狀況；
`statefulRebuilds` 與 `queuedResponses` 增加屬正常。

## 疑難排解

若安裝時 Claude 模型被跳過，用診斷腳本確認是哪一類問題：

```bash
bash claude-probe-diag.sh <API_ROOT> <API_KEY> <模型名>
```

它會分別檢查模型是否在清單中、原生 `/v1/messages` 的實際狀態碼與訊息、
以及 `/v1/responses` 對照組。上游暫時不可用（5xx）時重跑安裝器即可加入。

## 需求

macOS · Codex Desktop · 相容 OpenAI 介面的供應商端點

## 授權

MIT
