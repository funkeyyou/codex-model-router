# Keysmith 提示詞適配

管理頁 → 設定 → **Keysmith**，開關只對 GPT 模型生效，預設關閉。Claude 模型（含 API、Chat 轉譯與 CLI 訂閱路由）不附加任何 Keysmith 指令。

| 實際上游模型 | 附加的指令 |
| --- | --- |
| GPT / ChatGPT / o1、o3、o4 系列 | [codex-keysmith](https://github.com/Jia-Ethan/codex-keysmith) 的 `examples/gpt-overlay.md` |
| Claude、Grok、Gemini 等其他模型 | 不附加 |

依上游模型名稱判斷，不依可修改的顯示名稱。官方 GPT 的 HTTP 與 WebSocket、第三方 GPT 的 Responses 與 Chat Completions 都支援。只有經過這個路由器的 GPT 請求會套用；直接連到官方或其他服務的請求不受影響。

## 與原專案的差別

這是 codex-keysmith 的**提示詞適配**，不是執行它的安裝器。保留 Codex 原本的系統指令、工具定義和歷史，在轉送 GPT 當輪請求時附加範本；不安裝 hooks、shell wrapper 或子 Agent 定義，也不修改全域 `config.toml`、`AGENTS.md`、`CLAUDE.md` 或 Claude 設定。

依使用者要求，附加前會移除原始範本中固定稱呼 Ethan 的指令，不提供自訂稱呼欄位。原始的 `[P]` 回覆格式與任務處理規則仍保留。開啟前管理頁會顯示說明。提示詞不保證模型接受所有請求。

## 開關與回復

開啟時下載固定 Git commit 的 Markdown 和 MIT 授權檔案，逐檔核對 SHA256，全部成功後才原子寫入安裝目錄的 `keysmith.json`。下載或雜湊核對失敗會保留原狀。原檔存在時，修改前先在 Codex 的 `backups/keysmith-*` 備份；上游不會在背景自動更新。

開關在下一輪請求立即生效，不需要重啟路由器或 Codex。開啟期間，每個 GPT 請求都會附加一份指令，不是只在第一次或精簡上下文後附加，也不會逐輪累加到歷史。

關閉不需要網路，停止附加並移除使用中的提示詞副本；備份仍可供回復。路由器更新會保留開關狀態與 GPT 指令；舊版設定中的 Claude 指令、來源及授權副本會在備份後移除。即使尚未遷移，路由器也不會讀取或附加舊 Claude 指令。

附加的指令不寫入路由器的歷史快取，所以切 GPT／Claude 時不會由路由器重播上一個模型的指令。但已產生的回答、工具輸出或精簡摘要可能反映先前的指令；需要完全乾淨的上下文時請開新對話。原先另行全域安裝的 Keysmith 不受這個開關管理，須先自行卸載，避免兩份指令同時生效。

鎖定來源：codex-keysmith `cfcd96eb727c324ee8649170c43aaa632ff53cb3`。來源與授權文字會隨下載結果保存在 `keysmith.json`；不再下載 claude-keysmith。
