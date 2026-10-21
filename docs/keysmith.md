# Keysmith 全域模式

管理頁 → 設定 → **啟用 Keysmith 全域模式**。新安裝預設關閉；既有原版全域安裝會被辨識並顯示為開啟。

使用 [codex-keysmith](https://github.com/Jia-Ethan/codex-keysmith) 原版的 `model_instructions_file` 機制，在 Codex 使用者的 `config.toml` 指向指令檔案，替換內建指令。路由器不再逐輪附加提示詞，不會疊加兩份。

**啟用後，其他模型可能無法正常使用，尤其是 Claude 模型（含 API 與 CLI 訂閱）。需要使用這些模型時，請先關閉此功能。** 設定頁和開啟前的確認視窗都會顯示此提醒。

切換後請完全退出並重新開啟 Codex，再建立新對話。既有對話與精簡摘要可能保留先前指令的影響。全域模式影響這份 Codex 設定下的所有模型，不能只限 GPT；獨立開啟的 Claude Code 不受此設定影響。

## 指令來源

一般啟用時，下載固定版本 `cfcd96eb727c324ee8649170c43aaa632ff53cb3` 的 `examples/gpt-overlay.md` 與 MIT 授權，核對 SHA256 後才寫入。不執行外部安裝器、不自動追蹤上游更新，不啟用 hooks 或變更工具權限。

如果已有原版全域安裝，只有當 `gpt-overlay.md` 的內容雜湊符合原版 manifest、設定確實指向它，且原版安裝前沒有其他 `model_instructions_file` 時，才接管既有版本。原始 Markdown 不刪除；原版 manifest 封存至本次備份，之後請用管理頁開關管理。若無法確認所有權，既有指令視為使用者設定，關閉時不會清除它。

依先前要求移除範本的固定稱呼 Ethan，不新增自訂稱呼欄位；其他範本內容與 `[P]` 輸出格式保留。使用全域載入不保證所有模型都接受請求。

## 備份與還原

修改前備份 `config.toml`、`keysmith.json` 與指令檔案到 Codex 的 `backups/model-router/keysmith-global-*`。只使用 Codex 設定 RPC 修改 `model_instructions_file`，不整份覆蓋設定；原有模型、供應商和憑證保留。

啟用前的其他指令路徑會記錄下來。關閉時只在該鍵仍指向本功能擁有的檔案時還原；若使用者之後手動改指向另一份檔案，保留手動修改。原版安裝的接管則在關閉時移除該鍵，恢復 Codex 內建指令。

關閉可離線執行。失敗會嘗試還原修改前狀態，並留下備份及 `recovery.json`。舊版路由注入設定在操作時停用，避免尚未重啟的舊路由器重複注入。解除安裝路由器前會先解除受管理的全域指令引用，避免留下指向被封存安裝目錄的失效路徑。
