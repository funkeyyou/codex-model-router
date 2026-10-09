# Claude CLI 訂閱路由（實驗性）

自 1.26.0 起提供。已在 macOS 以真實訂閱驗證短文字與一般工具往返，並驗證 Claude Code 2.1.285 的工具協定；Chrome、生圖、長對話與 Windows 訂閱執行仍待驗收。需要既有路由器安裝，以及原生 Claude Code 2.1.280 或更新版本（Opus 5.5 的官方最低要求）。第一版尚不支援「沒有任何 API 供應商，直接全新安裝」。

在安裝器所在目錄執行：

```bash
bash codex-model-router.sh claude-cli
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 claude-cli
```

也可選主選單第 7 項「連接 Claude 訂閱帳號（實驗性）」。CLI 的 Windows 執行路徑尚需實機驗收。

1.27.0 起也可以在網頁管理介面操作：「新增供應商」選「Claude 訂閱帳號（Claude CLI）」，或在「新增模型」的供應商選單選「Claude 訂閱」。頁面會依序檢查 CLI 安裝、版本與訂閱登入，缺少的步驟可直接處理：安裝與更新同樣需要明確確認，登入會在執行管理頁的終端機視窗啟動官方流程。三項都通過才讀取模型清單。網頁新增時預設上下文 1,000,000、輸出 128,000，之後可在模型頁修改；終端流程仍預設 200000／32000。模型回報需要較新的 CLI 時，網頁只標示未通過，不會自動更新。

1. 偵測原生 Claude CLI；非標準安裝位置可用 `CODEX_MODEL_ROUTER_CLAUDE_BIN` 指定絕對路徑。未安裝時先詢問是否下載並執行 Anthropic 官方安裝程式；版本低於最低要求時先詢問是否備份執行檔並執行 `claude update`。兩者預設為否，只有在互動終端輸入 `y`／`yes` 才執行，路由器的批次 YES 旗標不會代替這次同意。完成後會重新偵測路徑與版本；失敗或拒絕時不修改路由配置。
2. 由 `claude auth login` 開啟官方登入流程，登入訂閱帳號。路由器不讀取／保存 OAuth token；也不會自動登出原本帳號。
3. 優先從 Claude CLI 的 SDK 初始化控制介面讀取模型清單，不發送推理請求。依 CLI 原順序列出完整版本，相同版本的別名去重，保留 CLI 描述與計費提示；再附上本次未列出的既有 CLI 模型。輸入 `1` 或 `1,2` 等編號選擇，也接受範圍、`all` 或完整模型 ID。編號隨當次清單變動，請以畫面為準。只有讀取失敗／沒有可辨識項目時才顯示內建備援候選，並明確標示來源。CLI 清單不一定與 Claude 桌面版完全相同，也不保證每個項目都有可用額度；未列出的版本仍可手動輸入。只有選中的模型會進行推理測試，通過後使用回應中的完整模型編號作為顯示名稱及實際呼叫目標；無法確認版本時不添加。
4. 指定上下文上限，未知時預設 200000；這是保守設定，不是探測結果。輸出暫定 32000（網頁新增預設 128000，兩者都可在網頁管理介面的模型頁修改）。已有全域 `model_context_window` 時，需注意全域值可能覆蓋模型設定；本功能不修改該值。
5. 每個選定模型以 medium effort 做一次短推理測試，會使用訂閱用量。通過後才寫入模型目錄，備份並重啟路由器；寫入／驗證失敗會還原。
6. 重開 Codex，選擇 `claude-cli/claude-opus-5` 等新增模型。舊的別名項目會保留內部選擇器 ID，讓既有對話仍能使用；完成遷移後固定呼叫該版本。日後別名指向其他版本時，重新添加會建立獨立項目，不改掉原版本。

思考深度提供 Claude CLI 的五個選項：`low`、`medium`、`high`、`xhigh`、`max`，預設為 `medium`，透過 `--effort` 傳給 CLI。沒有額外添加 CLI 不支援的 `ultra` 選項。

`claude-cli status` 只檢查版本與登入，不詢問安裝／更新、不啟動登入，也不送模型請求。`claude-cli login` 先檢查安裝與版本，再重新登入，不添加模型。登入取消或未成功時不修改路由配置。從原有「刪除自訂模型」移除 CLI 模型不會登出 Claude，API 供應商與金鑰保持原樣。

原生安裝使用官方的 `https://claude.ai/install.sh`（macOS）或 `https://claude.ai/install.ps1`（Windows），不從第三方下載 CLI。Homebrew／WinGet 管理的版本若不能透過 `claude update` 更新，會停止並提示使用原套件管理器，避免悄悄改換安裝來源。模型探測若回報更高的 CLI 最低版本，會再次詢問更新；成功後只重試該模型一次，不把它誤判成帳號無權使用。安裝／更新 Claude CLI 本身不是路由配置交易的一部分：若稍後取消登入，已同意完成的 CLI 安裝／更新仍會保留。

## 工作方式與限制

每輪建立獨立 CLI 行程，以暫存的 JSONL 恢復完整對話（角色、工具 ID／結果、圖片），不共享 CLI 工作階段。暫存目錄限本機使用者讀取，結束／取消後清理；強制終止整個路由器或系統斷電仍可能留下系統暫存檔。

CLI 只看得到以 MCP 提供的 Codex 工具定義；原生 Bash／Edit／Read、Chrome、skills、使用者／專案設定與 hooks 關閉。MCP 端點永遠不執行工具，收到第一輪完整模型回應後就結束 CLI，工具由 Codex 執行，再把真實結果帶進下一輪。管理員強制設定仍由 Claude CLI 控制。

Claude CLI 預設把每個 MCP 工具說明截斷在 2,048 字元，Codex Code Mode 的巢狀工具文件因此看不到。1.26.5 起路由器以 `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` 保留完整說明，並以 `ENABLE_TOOL_SEARCH=false` 讓所有 Codex 工具直接可用，不改成延遲載入。

### 思考摘要與進度更新

Claude 5 系列預設不回傳思考文字（`display: omitted`），Codex 因此看不到思考過程。1.26.6 起 CLI 路由加上 `--thinking-display summarized`，思考摘要會以 Codex 的推理摘要顯示；依 Anthropic 說明計費不變，只會稍微增加延遲。這個參數不在 `--help` 中，2.1.231 起可用，而且只會附加在 adaptive／enabled 思考設定上。

Claude Code 自己的系統提示要求模型在工具之間簡短回報進度，但 CLI 路由以 Codex 的提示取代了它。1.26.6 起 Claude 路由在 system 最後加一段固定說明，把 Codex 的 `commentary`／`final` 頻道對應到 Claude 的文字輸出，並要求相同的更新方式。

### 串流逾時

1.27.7 起，終端新添加且已解析為 `claude-opus-5-5` 的 CLI 模型，預設輸出為 128,000 tokens（不超過設定的上下文）。明確指定的輸出值優先，重新添加會保留既有輸出設定；更新程式不會自動提高既有路由的額度，可在模型管理頁調整。

若上游以 `max_tokens` 結束、只有思考而沒有回答或工具呼叫，會明確提示輸出額度耗盡，仍視為失敗。`/healthz` 的 `stats.lastClaudeFailure` 與 `router.err.log` 的 `model-router-claude-failure:` 記錄會保留 `stop_reason`、請求的 `max_tokens`、上游回報的 token 用量與內容類型數量；缺少的用量為 `null`，不推測為零。`claudeOutputLimitFailures` 計算這類停止原因的失敗。診斷不包含提示、思考文字或簽章。

1.27.6 起，`settings.json` 的 `claudeCli.timeoutMs` 表示閒置時限（預設 `180000`，3 分鐘），收到有效的模型串流事件就重新計時，包含思考、文字與工具參數；CLI 啟動訊息、stderr 與尚未組成完整 JSON 的資料不延長計時。既有的 `timeoutMs` 設定會直接套用此語意。

`claudeCli.totalTimeoutMs` 是獨立的單次生成總時限（預設 `900000`，15 分鐘），包含提示快取斷點被拒後的內部重送，不因持續輸出或重送而延長。它限制單次模型生成，不限制整個多輪工具任務。兩項設定皆須為 `1`～`2147483647` 的整數毫秒；無效值使用各自預設。重新添加 CLI 模型及更新安裝器會保留自訂值。

閒置逾時回報 `claude_cli_timeout`，達到總時限回報 `claude_cli_total_timeout`；完成、失敗與取消都會清理兩個計時器及 CLI 子行程。添加模型與診斷腳本的短探測仍保留原本的總時限。

### 提示快取

CLI 會把最後一個快取斷點放在它附加於歷史之後、每個行程重建的環境內容上，下一輪無法重用，每輪幾乎都要重寫整段對話。1.26.5 起：

- 在重播歷史的最後一個可快取區塊加上 1 小時斷點（不放在 thinking 區塊，也不放在本輪新輸入），下一輪重播相同前綴時直接讀取快取；
- 以 `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` 固定 CLI 自己的快取時間，讓兩者 TTL 一致，並忽略繼承的其他快取環境變數；額外用量（overage）期間同樣使用 1 小時；
- 本輪的工具限制指示放在本輪輸入，不改寫 system；對話中途的 developer 訊息留在原位，同樣不改寫 system。

若 CLI 版本不接受這個斷點（例如忽略 TTL 設定，或自己已用滿 4 個斷點），上游會在產生內容前拒收；路由器改以不帶斷點重送一次，並在 30 分鐘內暫停加斷點。`/healthz` 的 `claudeCliCacheFallbacks` 記錄次數，正常應為 0。

有工具結果的回合，會在原始工具往返之後追加一則固定的「繼續處理」訊息，避免 CLI 恢復時把尚未配對的工具呼叫清除。這個適配依賴 Claude 的 transcript 格式，因此標記為實驗性；CLI 改版後需重跑相容性測試。

開始推理前重新確認訂閱登入；忽略繼承的 Anthropic API Key、Base URL、第三方後端與模型環境變數，防止悄悄改用 API 計费。不會在授權失效或用量不足時自動切 API 供應商。仍保留 HTTP(S) 代理環境變數。路由器既有的 ChatGPT 登入檢查不變。

上下文超限、CLI 授權失效、用量不足、中斷、未知工具與拒答會回報失敗，不當作空白成功。CLI 沒有原生 `tool_choice` 選项，因此以本輪指示加輸出驗證實作；禁止／指定工具時仍保留歷史工具定義，避免恢復對話時丟失工具的含義。若模型提出禁止的工具，會在交給 Codex 前拒絕；指定工具／必須呼叫工具及禁止平行呼叫的限制若未被遵守，回合會失敗。SDK 原生工具執行不在第一版範圍。

訂閱用量政策以 [Anthropic 官方說明](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) 為準；不承諾永久使用相同額度或計費方式。CLI 恢復介面參考 [官方 session 文件](https://code.claude.com/docs/en/sessions)。

## 開發驗證

```bash
node tools/build.mjs
npm run check
TEST_CLAUDE_CLI_BIN=/absolute/path/to/claude node --test test/claude-cli-native.test.mjs
```

最後一項使用真正的 Claude CLI，但上游是本機假 API，使用隔離的設定目錄與假 Key，不會消耗真實用量。這能驗證協定與資料保留，不能取代訂閱登入、實際模型能力、Chrome 與生圖的實機驗收。

明確需要消耗訂閱用量的兩輪測試：

```bash
CODEX_MODEL_ROUTER_CLAUDE_BIN=/absolute/path/to/claude node tools/probe-claude-cli.mjs --live opus
```

測試讓模型讀取外部數值並計算，不執行系統命令。上游仍可能依提示詞或歷史內容拒答；曾觀察到原樣回傳隨機字串的測試被 Opus 5 標記為 `reasoning_extraction`。拒答會原樣回報失敗，不會隱藏、強制重試或改用其他模型。
