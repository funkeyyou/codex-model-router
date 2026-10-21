# 會話清理

管理頁 → 設定 → **會話清理**，用來處理已儲存在本機的 Codex 歷史會話。

## 使用流程

1. 選擇最近的歷史會話。管理頁會列出拒絕回覆、助手回覆與推理紀錄數量。
2. 兩級規則會預選疑似拒絕回覆；可以取消不想修改的項目。
3. 選擇是否移除這個會話的 Reasoning／Thinking 紀錄。
4. 可使用已連接的 OpenAI Responses 或 Chat Completions 相容模型依前文改寫。這會呼叫供應商，可能產生少量費用；失敗、空白或問號亂碼會改用安全兜底文字。
5. 檢查逐項修改前後對比，確認後才建立備份並套用。

清理會同步處理 JSONL 裡重複表示的 `response_item` 與 `event_msg/item_completed/AgentMessage`，以及 Codex 桌面端的 `thread_history` 投影，避免檔案與畫面顯示不同。

## 備份與還原

每次套用前，會在 `CODEX_HOME/backups/model-router/session-cleaner/` 建立一份備份，包含：

- 完整原始會話 JSONL
- 該會話在 `thread_items`、`thread_realtime_items` 的完整投影
- `thread_history_projection_state` 游標
- 修改前後雜湊、修改數量與時間

管理頁可以選擇任一受管理的歷史版本還原。如果清理後出現無法辨識的外部修改，還原會停止，不會直接覆寫。

## 邊界

- 進行中或剛寫入的會話不能修改；請先關閉該對話並稍候。
- 修改歷史文字不代表模型已經完成原本的工作，也不保證下一輪一定成功。
- AI 改寫只使用目前路由器保存的供應商設定與憑證，不另存 API Key。
- 目前處理 Codex JSONL 與桌面投影，不修改服務端狀態或執行中程序的記憶體。
