# Claude Desktop 接入（本機試用版）

讓 Claude Desktop 的第三方推理模式使用管理頁已添加的 Claude API 模型。
第一版只支援已驗證為 Anthropic Messages 介面的 Claude API 路由；GPT、其他模型和 Claude CLI 訂閱不會列入。

## 使用

1. 更新本機路由器後，開啟管理頁的「Claude → Claude 客戶端」。
2. 先結束 Claude 進行中的任務，按「一鍵接入 Claude Desktop」。工具正常關閉 Claude、備份設定、新增專用 Gateway 設定並重新開啟。
3. 在 Claude 的模型選單選一個 Claude API 模型，建立新對話試用。
4. 要恢復原模式，按「一鍵回退 Claude Desktop」。會還原原本的模式與設定檔選擇，保留聊天、MCP 與其他偏好，再重新開啟 Claude。

自動接入支援 macOS 與 Windows 的標準安裝。組織政策管理、自訂資料目錄或未知設定格式不會被覆寫。
Claude 拒絕正常退出時不修改檔案；重新啟動失敗會嘗試還原原設定。回退前核對我們改過的欄位，若被其他操作修改就回報衝突。
備份在 Codex 的 `backups/model-router/claude-desktop-active.json`，包括原設定，請勿公開。

「手動連線（備用）」仍可取得連線資料：在 Claude 的 Help → Troubleshooting → Enable Developer Mode，再進入 Developer → Configure Third-Party Inference，選 Gateway 並填入資料。

這裡的 API Key 是本機產生的接入金鑰，不是供應商的真實 API Key。
真實 Key 繼續由路由器從既有憑證儲存讀取，並沿用備用 Key 的模型分流與輪替。
新增或刪除模型後，路由器更新路由，Claude 的模型清單可在重開客戶端後重新探索。

Claude 3P 的聊天記錄存在本機，和一般 Claude 雲端聊天分開；本功能不搬移既有對話。
手動停用接入會撤銷本機 Key；手動重新啟用後要在 Claude 貼入新 Key。使用一鍵接入時請用一鍵回退，無須複製金鑰。
卸載路由器會先回退受管理的 Claude 設定，避免客戶端繼續指向已移除的 Gateway；手動設定則需自行切回。

## 協議與限制

- `GET /claude/v1/models`：原生 Anthropic 模型清單，只列出可轉發的 Claude API 路由。
- `POST /claude/v1/messages`：保留完整 Messages 內容，只替換路由模型 ID；支援 JSON 與 SSE。
- `POST /claude/v1/messages/count_tokens`：轉發上游計數端點，上游不支援時回報錯誤，不虛構計數。
- 保留工具、圖片、thinking/signature、`cache_control`、`anthropic-version` 與 `anthropic-beta`；不把 Codex 的歷史轉譯套在 Claude 請求上。
- 用量與錯誤記錄共用現有管理頁，傳輸類型為 `claude-desktop`。快取輸入、快取寫入和輸出依上游實際回報記錄；沒有數據時不推算。
- 只接受本機連線與專用金鑰；相容 Electron 的 Origin／Sec-Fetch 標頭，不提供 CORS 或瀏覽器預檢支援。專用 Key 不可用於其他路由端點。
- 未完成的串流會回報錯誤，不把 EOF 當成功。不自動重試已開始輸出的串流。
- 目前不宣告 1M 能力：管理頁的上下文設定可能是手動覆蓋值，不能當成供應商能力證明。
- 若同一上游模型在不同供應商重複，請使用清單中的完整模型 ID，不會猜測應該向哪一家計費。

官方參考：[第三方模式](https://claude.com/docs/third-party/claude-desktop/overview)、[Gateway](https://claude.com/docs/third-party/claude-desktop/gateway)、[客戶端設定](https://claude.com/docs/third-party/claude-desktop/in-app-configuration)。

## 設定格式依據

本機 Claude Desktop 3.1623.0 的封裝 JavaScript 讀取 `Claude-3p/claude_desktop_config.json` 的 `deploymentMode`，並從 `configLibrary/_meta.json` 的 `appliedId` 讀取 UUID 設定檔。選擇本機設定時清除 `hybridPointer`，其他設定保留。本工具只修改這些欄位，不修改安裝包或啟用開發者模式。

靜態檢查來源：REA Evidence `ev_a4b2218d2a976dc5e62554091fe352527bce2a2d147525e142ae9f6a70e48bb7`，ASAR SHA256 `760e7cbb6f861f0bc0e71e71fd9c6b721ba735f0f638b6ea623645daff4261a7`，以及其中 `index.chunk-BLvpT1n4.js` / `index.pre.js` 的設定讀寫函式。REA 語意分析有覆蓋限制，且解包的原生模組完整性不一致，因此只以實際讀到的 JavaScript 設定流程作依據，沒有把原生模組視為已驗證，也沒有把靜態檢查當成實際客戶端對話驗收。
