# codex-model-router

讓 Codex Desktop 在保留官方模型的同時，額外使用相容 OpenAI 介面的自訂供應商。

官方 ChatGPT 模型仍直接送往 OpenAI，只有你選取的自訂模型會送往你設定的 Base URL。
可以同時設定多家供應商，各自保存 API Key（見「[同時使用多家供應商](#同時使用多家供應商)」）。
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
選模型時可以輸入編號、範圍或 `all`；閘道的 `/models` 沒列出的模型，也可以直接輸入模型 ID
（例如 `1,3,qwen3-max`），一樣要通過探測才會加入。選中的模型會平行探測，同時最多 3 個；
閘道限流較嚴時可設環境變數 `CODEX_MODEL_ROUTER_PROBE_CONCURRENCY=1` 改回逐一探測。
路由器安裝成功後，另會詢問是否使用中轉 API 生圖，預設為否；同意後才偵測圖片模型並安裝獨立技能。

### 固定版本並驗證下載（可選）

上面的指令下載的是 `main` 上的最新安裝器。想固定某個版本，或下載後先確認檔案沒被竄改，
可以改從 [Releases](https://github.com/funkeyyou/codex-model-router/releases) 下載：
每個版本都附有兩支安裝器、診斷腳本與 `SHA256SUMS`。
`releases/latest/download/` 永遠指向最新的正式版本。

macOS：

```bash
curl -fsSLO https://github.com/funkeyyou/codex-model-router/releases/latest/download/codex-model-router.sh
curl -fsSLO https://github.com/funkeyyou/codex-model-router/releases/latest/download/SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing && bash codex-model-router.sh
```

Windows：

```powershell
curl.exe -fsSLO https://github.com/funkeyyou/codex-model-router/releases/latest/download/codex-model-router.ps1
curl.exe -fsSLO https://github.com/funkeyyou/codex-model-router/releases/latest/download/SHA256SUMS
(Get-FileHash .\codex-model-router.ps1 -Algorithm SHA256).Hash.ToLower()
Select-String codex-model-router.ps1 .\SHA256SUMS
```

兩行輸出的雜湊相同再執行安裝器。

## 升級

已經裝過的話，日常升級用 `update`，不要重跑 `install`：

```bash
bash codex-model-router.sh update
```

```powershell
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 update
```

`update` 只換掉路由器與轉譯層的程式碼並重寫服務定義，然後重啟服務並做健康檢查。
Base URL、API Key、連接埠與所有已設定的自訂模型全部沿用，不會重問任何一項。
從 1.22.0 起，更新會透過 Codex CLI 備份並移除本工具舊版寫入的
`model_catalog_json`，讓啟動時可以同步官方清單；其他全域配置與使用者自行指定的目錄保留。
從 1.19.1 起，沒有上游前綴的預設模型名稱會補上 `api/`，自訂模型 ID、能力與手動名稱保留。
更新前的 `router.mjs`、`claude-bridge.mjs`、`settings.json`、
`install.json` 與服務定義都會備份到 `~/.codex/backups/model-router/update-<時間戳>/`，
需要遷移名稱時也會備份 `models.json`，移除固定目錄設定前會備份 `config.toml`。
任何一步失敗都會自動還原並重啟回原本的版本。
已啟用的中轉生圖技能也會獨立備份與更新，保留手動修改的檔案；技能更新失敗時維持原狀並提示，
不影響已完成的路由器更新。尚未啟用的技能不會被 `update` 自動安裝。

`install` 保留給第一次安裝、換 Base URL 或 API Key、以及重新挑選模型的情況。
設定了多家供應商時，`install` 只重新配置主要供應商，其他家與它們的模型保持不變。

`add` 只探測新選的模型；完成後，自訂模型會按本次探測清單的順序排列。
已配置但未出現在本次清單的模型會留在後方，原有名稱與能力設定不變。

`remove` 或選單第 4 項可複選刪除已配置的自訂模型；空白／`cancel` 返回，刪除前會再確認。
安裝器先備份設定、模型目錄與路由程式，再移除選中的模型並驗證 Codex 選單；失敗會還原。
官方模型、API Key 與中轉生圖技能不受影響；若刪除全域預設模型，會清除指向該模型的 `model` 設定。
可以刪到零個自訂模型，日後仍可更新或重新添加。
既有任務若仍使用已刪除的模型，需先切換模型才能繼續。

## 同時使用多家供應商

從 1.24.0 起可以同時設定多家中轉供應商，各自保存 API Key，模型都會出現在 Codex 的選單上，
可以混用，也可以把另一家當備援。用 `providers`（選單第 5 項）管理：

```bash
bash codex-model-router.sh providers add      # 新增一家：Base URL、API Key，探測並添加它的模型
bash codex-model-router.sh providers remove   # 移除一家與它的全部模型
bash codex-model-router.sh providers key      # 更換某一家的 API Key
```

Windows 同樣是 `powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 providers add` 等。

- 第一家是主要供應商：`install` 重新配置的是它，Codex 內建的 `image_gen` 也送到它。
- 其他家的模型名稱前面帶供應商名稱，例如 `openrouter/claude-sonnet-4.5`；選擇器 ID 也帶，
  同一個模型在兩家都有時不會撞在一起。名稱在新增時決定，預設從網址猜
  （`api.openrouter.ai` → `openrouter`），只能用小寫英文、數字與連字號。
- 有多家時，`add` 會先問要替哪一家添加模型；`remove` 可以一次刪不同家的模型。
- 移除供應商會一併移除它的模型；全域預設模型是其中之一時會清除該設定，中轉 API 生圖用的是
  這家時會停用技能（之後可重新設定）。最後一家不能移除，要整個移除請用 `rollback`。
  移除前會備份，任何一步失敗都會還原。
- `imagegen` 在有多家時會問要用哪一家生圖。
- 更換 API Key 後，Windows 下一個請求就改用新 Key；macOS 最晚 5 分鐘內生效，
  上游拒絕舊 Key 時立即改用。
- 從舊版更新時，原本唯一的供應商成為主要供應商（名稱 `default`），模型、選擇器 ID 與
  名稱都不變，既有對話照常使用。

## 版本資訊與更新內容

安裝器啟動時會顯示「已安裝版本」、「目前這支安裝器版本」與「GitHub 線上最新版本」。
若有更新，會按版本順序列出從已安裝版本到最新版之間的所有變更；若手上的安裝器本身
已落後，也會先提示重新下載最新版，避免用舊腳本覆蓋新安裝。

版本資料來自 repo 根目錄的 `releases.json`。檢查逾時或離線時只會顯示無法檢查，
不會阻塞安裝、添加模型、狀態檢查或回退流程，也不會上傳任何本機設定。

## 其他指令

選單第 7 項「設定全域上下文 100 萬」也可用
`bash codex-model-router.sh context-1m` 執行；Windows 使用
`powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 context-1m`。
功能會備份使用者配置，只將全域 `model_context_window` 設為 1000000，並讀回驗證。
最大輸出、模型目錄與路由器設定均不修改，也不重啟路由器。選單第 8 項為中轉 API 生圖，第 11 項為退出。
完成後重新開啟桌面版並建立新任務。配置不會增加上游模型本身的能力或帳號權限。

不帶參數執行會出現選單，也可以直接指定動作。

macOS：

```bash
bash codex-model-router.sh update     # 升級程式碼，保留現有設定
bash codex-model-router.sh add        # 添加自訂模型
bash codex-model-router.sh remove     # 刪除自訂模型
bash codex-model-router.sh providers  # 新增／移除供應商、更換 API Key
bash codex-model-router.sh hidden-models # 單獨管理被隱藏的官方模型
bash codex-model-router.sh imagegen   # 單獨添加／設定中轉 API 生圖
bash codex-model-router.sh status     # 檢視安裝狀態與健康度
bash codex-model-router.sh rollback   # 回退（安裝檔會封存，不會刪除）
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 update
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 add
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 remove
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 providers
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 hidden-models
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 imagegen
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 status
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 rollback
```

> 回退前請先看「[回退之後，用過 Claude 模型的舊對話會壞掉](#回退之後用過-claude-模型的舊對話會壞掉)」。

## 中轉 API 生圖（可選）

安裝時同意啟用，或事後選擇選單第 8 項／執行 `imagegen`，即可添加獨立的 `$router-imagegen` 技能。
不修改官方 `.system/imagegen`，也不需要內建 `image_gen` 工具。請求經本機路由器使用已保存的
API Key；圖片費用由你的中轉供應商計算，不使用 ChatGPT 方案內含生圖額度。
設定了多家供應商時會先問要用哪一家；技能會記住這個選擇，之後的生圖都送到那一家，
那一家被移除時技能會一併停用，不會改用別家的帳號計費。

設定時先選擇要偵測的模型（可複選），工具會自動測試並添加成功的項目。
先使用目前 API Key 呼叫通用 `/v1/images/generations`；已選模型全部未通過時，才自動改測 Ark 任務介面。
只測試勾選的模型，只有成功取得 PNG 圖片的模型才會添加；未選模型不會測試，也不會作為失敗後的替代。
通用介面只要有一個成功，就保留這次成功的模型，不再額外呼叫 Ark。
新設定預選 Flare，已有技能則預選目前啟用的模型；也可輸入 `all` 選擇全部三個。
`/models` 只協助判斷名稱與前綴；即使清單沒有圖片模型或查詢失敗，也能進行實測。
清單未列出的模型自動沿用既有設定中的共同前綴；無法推斷時使用原始模型名稱。
清單已列出的模型保留原始名稱。Ark 任務介面使用這三個模型的原始 ID。

**偵測會真的生圖，可能產生費用。** 選完模型後自動執行，不再詢問介面類型、前綴或測試確認。
每個已選模型每種介面最多提交一次；選一個最多兩次、選兩個最多四次，通用成功時不會執行第二輪。
通用測試使用一張 `1024x1024`、`quality=low`、PNG；Ark 每次單張，尺寸與品質由上游決定。每次最多等待 300 秒。
同一介面內不自動重送，Ark 查詢任務不會重新提交。成功的測試圖片保留在 `$CODEX_HOME/model-router/imagegen-probes/<時間戳>/`。
兩種流程都未通過就顯示「沒找到可用模型」，不新增技能，現有生圖設定保留。
最近一次偵測的內部錯誤會保存到 `$CODEX_HOME/model-router/imagegen-last-check.json`，不含 API Key，方便診斷而不增加畫面提示。
測試只能確認當下文字生圖可用，尚未測試編輯端點，也不保證日後配額或服務狀態。

| 選項 | API 模型 ID | 選用方向 |
| --- | --- | --- |
| Image 2 | `gpt-image-2` | 上一代模型，保留給既有流程或相容需求 |
| Image 2.5 Sunburst | `gpt-image-2.5-sunburst` | 偏重編輯精準度，適合精細改圖與保留原圖細節 |
| Image 2.5 Flare | `gpt-image-2.5-flare` | 偏重速度，適合一般生圖與快速迭代 |

偵測前可輸入模型編號（例如 `1,2`）或 `all`；輸入 `cancel` 返回，不送生圖請求。
成功後自動添加通過的已選模型並記住介面類型，正式生圖不會重新探測或切換介面重送。
只啟用一個就固定使用；多選時由 AI 按需求
在命令中明確指定，使用者指定優先。命令拒絕未勾選的模型，失敗不會自動切換模型或重送付費請求。
模型差異參考 [OpenAI 圖片指南](https://developers.openai.com/api/docs/guides/image-generation)，速度與價格以中轉商為準。

技能安裝在 `$CODEX_HOME/skills/router-imagegen/`（未設定 `CODEX_HOME` 時為 `~/.codex/skills/router-imagegen/`），
內含 `SKILL.md`、模型設定、UI 資訊與 `scripts/imagegen.mjs` 命令。不含 API Key，不需 Python 或額外套件。
新任務中可直接說：

```text
使用 $router-imagegen 幫我畫一隻貓。
使用 $router-imagegen 的 Sunburst 修改這張圖片，只替換背景。
```

也可用安裝器選定的 Node 執行技能目錄內的命令：

```bash
node "$HOME/.codex/skills/router-imagegen/scripts/imagegen.mjs" list
node "$HOME/.codex/skills/router-imagegen/scripts/imagegen.mjs" generate --model flare --prompt-file prompt.txt --out cat.png
node "$HOME/.codex/skills/router-imagegen/scripts/imagegen.mjs" edit --model sunburst --prompt-file edit.txt --image cat.png --out cat-v2.png
```

Windows 範例（`node` 不在 PATH 時，使用生成的 `SKILL.md` 內記錄的完整 Node 路徑）：

```powershell
node "$env:USERPROFILE\.codex\skills\router-imagegen\scripts\imagegen.mjs" list
node "$env:USERPROFILE\.codex\skills\router-imagegen\scripts\imagegen.mjs" generate --model flare --prompt-file prompt.txt --out cat.png
```

每次生成一張圖，預設 `size=auto`、`quality=auto`、輸出 PNG，保留已存在的輸出檔。
`--image` 可重複提供參考圖，`--dry-run` 不送出生成請求。`--model` 省略時，生圖依
Flare → Sunburst → Image 2、改圖依 Sunburst → Flare → Image 2，使用第一個已啟用模型。
通用模式需支援 Images API 的 JSON／multipart 請求與 `b64_json` 圖片回應。
Ark 模式使用同一供應商 origin 下的 `/v2/extend/image/ark_gpt_image/generations`、`edits` 及 `tasks/{task_id}`：
提交取得任務編號後查詢結果，再下載公開 HTTPS 圖片；下載不附帶 API Key，並驗證目的位址與圖片格式。
若代理 DNS 返回 `198.18.0.0/15` 假 IP，會透過 Cloudflare HTTPS DNS 查詢該圖片網域的真實公開 IP，再驗證並固定連線位址；查詢不包含圖片路徑、簽名或 API Key。
Ark 不支援指定尺寸／品質或透明背景，`--size`、`--quality` 須保持 `auto`，`--background` 使用 `auto` 或 `opaque`。
改圖時命令將本機參考圖轉為 JSON Base64，API 仍經本機路由器讀取憑證；查詢或下載失敗不重新提交付費任務。
舊路由器須先用新版安裝器執行 `update`，才能使用 Ark 任務端點；命令會在提交前檢查支援情況。

重新執行 `imagegen` 可重新選擇並自動實測模型；選擇模型時輸入 `none` 或直接執行 `imagegen-disable` 可停用（兩者都不生圖），技能會封存到
`$CODEX_HOME/backups/model-router/`。`rollback` 也會封存由此路由器建立的技能。手動修改會保留，
同名但不屬於此路由器的技能不會被覆寫。重新開任務讓技能清單刷新，必要時重開 Codex。

## 工具可用性與相容範圍

路由器只能轉送 Codex 已提供的工具與請求，不能替帳號解鎖功能，或把未掛載的工具加進
目前任務。OpenAI 的[工具文件](https://developers.openai.com/api/docs/guides/tools)也區分
平台內建工具與由呼叫端執行的函式工具；改用 Claude Messages API 不會自動取得前者。

| 功能 | 路由處理與限制 |
| --- | --- |
| 終端機、檔案編輯、MCP、瀏覽器等 function/custom 工具 | GPT 保留定義；Claude 做雙向轉譯，包含 namespace 與自由格式輸入。仍需 Codex 本身掛載工具並允許執行。 |
| Codex 的搜尋、筆記、歷史 HTTP 端點 | 繼續送往官方後端，由官方驗證帳號權限；不會因選擇自訂模型而改用中轉 Key。 |
| 平台內建 image_generation、web_search、file_search 等工具 | 自訂 GPT 依中轉能力而定；Claude 轉譯無法執行這些內建工具，會告知模型限制。明確強制使用不可用工具時回報 422，不自動改投其他供應商。官方 GPT 回合已完成的這類項目，切到 Claude 時會轉成文字摘要（本機命令轉成配對的工具呼叫），同一條對話可以繼續。 |
| 中轉 API 生圖 | 使用已啟用的 router-imagegen 技能與既有 Images／Ark 路徑，無需內建 image_gen。 |
| 圖片與 MCP 圖片結果 | Claude 支援 URL、data URL 及 MCP 的 data/mimeType 圖片區塊。圖片數量與大小限制仍適用。 |
| PDF、MCP 資源 | PDF data URL／文件 URL 轉為 Claude document；MCP 文字資源與連結保留為文字，不額外下載。上游仍需支援文件功能。 |
| 私有 file_id、音訊或未知內容類型 | Claude 轉譯明確回報不支援，不默默刪除。可先用本機讀檔／轉錄工具轉成文字或圖片。 |
| 嚴格結構化輸出 | Claude 轉譯尚未適配，明確回報 422；請改用文字或函式工具。GPT 路徑維持原樣轉發。 |

**1.22.3 起，Claude Code Mode 預設按需讀取外部工具說明。** 可辨識的巢狀工具
先提供名稱與摘要，模型呼叫前從 Codex 的 `ALL_TOOLS` 取得完整說明、參數 schema
及權限要求。實際工具註冊與執行權限不變；核心執行工具、網頁、生圖仍保留完整說明。
不支援這種格式的工具保留原文，不直接啟用 Responses 原生 `tool_search`。
此方式可降低工具較多時的初始上下文，但可能增加查找工具的往返；實際節省依工具組合而定。
健康檢查的 `lastClaudeToolContext` 顯示最近一次轉譯的工具縮減數、原始／轉送字元數，
`claudeToolDefinitionsDeferred` 與 `claudeToolDescriptionCharsSaved` 為啟動後累計值。
這些是字元統計，不是 token 數，也不是帳單節省。

**1.22.4 起，同一個工具呼叫的多筆輸出會合併成一個結果。** Code Mode 的 `exec` 每呼叫一次
`notify()`，Codex 就替同一個 `call_id` 追加一筆輸出；Responses 接受這種歷史，Anthropic 則規定
每個 `tool_use` 只能有一個 `tool_result`。Claude 轉譯會把同一則訊息內的後續輸出依序併回原本的結果；
模型已往下執行後才送達的輸出，改成標明來源的文字放在當下的位置，不改寫先前的結果，提示快取不受影響。
user 訊息中的 `tool_result` 也一律排在文字之前。GPT 路由維持原樣轉發。

**1.22.5 起，Claude 的推理改以短索引往返。** Anthropic 回報的輸入用量已包含送回去的
歷史推理；Codex 會對舊版的長 `encrypted_content` 再估一次 token，可能在畫面顯示上下文
仍約半滿時就達到自動精簡門檻。新版把完整 thinking 和簽章以 gzip 壓縮存於
`$CODEX_HOME/model-router/reasoning-store/`，交給 Codex 的歷史只放短索引；下輪依索引
還原，原有完整內容格式也繼續支援。檔案不隨時間自動刪除，因為舊任務仍可能引用；
更新會保留目錄，回退會把整個安裝目錄封存。備份或搬移 `CODEX_HOME` 時須連同該目錄一起保留。
磁碟不可寫時會回退舊格式並在錯誤日誌記一筆提示，不會中斷當前回應。
更新前已經記在 Codex 歷史裡的長推理不能由路由器直接縮短，會在下一次精簡後退出歷史；
新版產生的推理立即使用短索引。若手動降版到 1.22.4 或更早，舊版無法還原短索引；
要繼續使用這些 Claude 任務，請重新升級並保留 `reasoning-store`。

同版本也調整了 Claude 的圖片預算：啟用提示快取的路由在超過 20 張圖時一次把最舊的
8 張換成佔位文字；接下來新增 7 張圖都不會再修改早期歷史，頂層滾動快取能繼續命中。
第 29 張起會再整批省略 8 張。未啟用提示快取的路由仍只省略超過 20 張的數量。
實際快取命中仍取決於上游的快取保存時間與閘道實作，可從上游回報的
`cached_input_tokens`、`cache_write_input_tokens` 判斷。

因此「模型看不到工具」應先查任務工具清單；「工具可見但執行失敗」才往權限、工具服務、
路由及上游檢查。安裝路由器不會自動安裝所有 MCP／插件或更改其權限。

## 平台差異

安裝流程、模型探測、路由與 Claude 轉譯在兩個平台完全相同，差別只有這兩項：

| | macOS | Windows |
| --- | --- | --- |
| API Key 存放 | 鑰匙圈（`security`） | 憑證保護 DPAPI，以目前使用者身分加密後存成檔案 |
| 背景常駐 | LaunchAgent（`launchctl`） | 工作排程器，登入時啟動 |

Windows 的常駐做法是：工作排程器以 `wscript.exe` 執行一支守護迴圈，迴圈再用隱藏視窗
啟動 `router.mjs`，路由器結束就重跑——等同 LaunchAgent 的 `KeepAlive`，而且全程不會
有主控台視窗跳出來。排程另外每 10 分鐘檢查一次，守護行程本身若被殺掉也能自動補回。

守護迴圈是 JScript 寫的 `router-launcher.js`。1.22.5 以前用 VBScript（`.vbs`），但微軟
預計約 2027 年起預設停用 VBScript，屆時新裝的服務會起不來；執行 `update` 就會換成新版。
工作若是以系統管理員身分建立的，一般權限可能無法重新註冊，`update` 會沿用舊定義並提示，
此時以系統管理員身分執行一次 `update` 即可。安裝前會先確認 Windows Script Host 沒被系統
原則停用。

API Key 只有目前的 Windows 使用者帳號解得開，換帳號或搬到別台機器都無法解密；
兩個平台都不會把金鑰寫進 `config.toml` 或安裝器檔案。

## 功能

- **區分自訂模型名稱**——上游模型名稱沒有 `/` 前綴時，預設在選單顯示為 `api/模型名`；
  例如 `gpt-test` 顯示為 `api/gpt-test`，`ark/gpt-test` 則保持原樣。
  請求仍使用上游原名，既有 `custom/*` 選擇器 ID 不變，舊對話不需要改模型 ID。
  手動取過的顯示名稱保留。未配置的 `custom/*` 會直接回報路由遺失，不會轉送官方。
- **重試保留正確歷史**——成功終止後才保存對話快照，502、網路失敗、串流截斷與取消
  不會將半輪內容混入後續重試。官方 WebSocket 接續遭拒後重播、或回退 HTTP 時，也不會
  重複加入工具結果；若對應快照已不存在，會明確要求重新送出完整對話。
  1.21.0 起取消會關閉該上游 WebSocket，避免遲到的舊事件混進下一輪；切換官方模型時
  重播完整歷史。GPT 的 HTTP/SSE 回退同樣檢查終止事件，提早結束會明確回報失敗。
  HTTP 接收與 zstd 解壓預設上限為 128 MiB；歷史快照依序列化位元組計帳，總預算
  128 MiB、30 分鐘過期，同時保留原本最多 32 組、每組 4 個回應的限制。可在 settings.json
  設定 `maxHttpBodyBytes`（最高 512 MiB）、`maxHistoryBytes`、`historyTtlMs`，重啟路由器後生效。
  這些是路由器的資源限制，不改 Codex 的上下文設定；快照淘汰後要求完整重送，不截斷內容。
- **可定位的網路錯誤**——DNS、TLS、連線中斷、逾時與登入驗證遭拒分開回報，附診斷 ID。
  `/healthz` 的 `stats.lastError` 與 `router.err.log` 可對照時間、上游主機、階段與原因碼，
  診斷紀錄不包含金鑰、認證標頭或對話內容。ChatGPT 驗證探測設有 15 秒上限，暫時性
  故障不會被誤報為需要重新登入，也不會快取成驗證成功。
- **自動偵測上下文上限**——Anthropic 模型透過供應商的驗證錯誤精確取得（該探測不計費），
  其餘沿用官方同名模板；找不到時明確警告，不會靜默填入錯誤的預設值。
- **自動判斷是否需要轉譯**——優先依 `/v1/models` 的 `owned_by`；部分自架閘道完全不回
  這個欄位（例如直接回 Anthropic 格式的 `{id, type, display_name}`），此時改用模型名推斷，
  再以原生 `/messages` 驗證。推斷錯誤是安全的：探測不通會回退到通用 Responses 路由並提示。
- **Claude 模型本機轉譯**——部分閘道的 Responses 相容層對 Claude 有缺陷：有的串流回
  `stream_options` 錯誤、非串流內容為空；有的會把 Codex Code Mode 的 `namespace`
  工具包裝原樣轉給 Anthropic 而被拒（`Input tag 'namespace' does not match...`），
  導致模型調不到任何工具。此時改走 Anthropic 原生 `/v1/messages` 並在本機做雙向轉譯：
  送往 Anthropic 時把 namespace 編成不重名的工具別名，回到 Codex 時再拆回獨立的
  `name` 與 `namespace` 欄位，歷史重播也做相同的反向轉換；同時掛上 `cache_control`
  以啟用提示快取。
  1.21.0 起也接受頂層 `instructions` / `tools`、簡寫訊息、指定函式工具與
  `parallel_tool_calls: false`。過長或容易碰撞的工具名稱使用穩定別名，回程還原原名稱。
  工具 JSON 損壞或自由格式工具缺少字串輸入時回報失敗，不以空參數繼續執行。
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
- **重啟時同步最新模型**——Codex 啟動向本機 `/models` 請求時，路由器先用該請求的
  ChatGPT 登入資訊讀取官方清單，再合併既有 `custom/*` 模型與強制顯示設定。
  Codex 啟動瞬間可能先顯示自己的快取，背景同步完成後再次開啟模型選單即可讀取新清單。
  不需等待 Codex 執行檔更新；不呼叫推理或付費探測。不再配置固定 `model_catalog_json`。
  官方查詢最長等待 10 秒；網路、登入或資料格式失敗時保留本地清單。
  `settings.json` 的 `catalogRefresh = false` 可停用遠端同步，重啟路由器後生效。
  `/healthz` 的 `stats.lastCatalogSync` 顯示最近一次來源、HTTP 狀態及時間，不含憑證。
- **被藏起來的官方模型可以叫出來**——內建目錄會把尚未普及的模型標成 `hide`，但實際
  能不能用是後端依帳號決定的。透過獨立的 `hidden-models` 選單可選擇強制顯示，
  選擇記在 `settings.json` 的 `forceListedModels`。
- **連線保活**——長請求期間送出 WebSocket ping，避免客戶端閒置逾時。
- **錯誤可見**——上游錯誤會轉為標準的 `response.failed` 事件，不會讓客戶端無聲卡住。
  這包含最難察覺的一種：閘道在回應中途把串流丟掉。此時讀取端收到的是乾淨的 EOF 而不是
  例外，狀態碼當初又是 200，兩種既有的錯誤處理都接不到——三條串流路徑因此都會在讀完後
  確認終止事件真的送出去了，沒有就補上。同樣地，請求大到上游一定會拒收時，
  在送出前就擋下來並講明原因——否則客戶端只會收到閘道那句通用的錯誤，然後不停重試，
  每次都把整份歷史再上傳一遍。

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

`credentialReads` 是實際讀取（Windows 為解密）API Key 的次數。Windows 以憑證檔的修改時間
判斷 Key 是否更換，檔案沒變就沿用快取，這個數字應該很少增加。每家供應商各自快取。

`providers` 列出每家供應商的名稱、上游主機與模型數；`stats.lastProvider` 是最近一次自訂模型
請求送到哪一家，`stats.lastImageProvider` 是最近一次生圖送到哪一家。

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

## 疑難排解

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

### 某條對話一直失敗，但新開的對話正常

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

### Claude 對話出現 each tool_use must have a single result

錯誤全文類似
``messages.60.content.1: each tool_use must have a single result. Found multiple `tool_result` blocks with id: toolu_...``。
通常是模型在 Code Mode 的 `exec` 裡呼叫了 `notify()` 回報進度：
Codex 會把每則通知記成同一個工具呼叫的額外輸出，1.22.3 以前的 Claude 轉譯把每一筆都轉成獨立的
`tool_result`，上游因此拒收。之後每一輪都會重送同一段歷史，連用 Claude 壓縮也會失敗，整條對話看起來就像卡死。

升級到 1.22.4 以上即可。路由器每次都會重新轉譯完整歷史，原本卡住的對話不必壓縮或新開就能繼續；
`/healthz` 的 `claudeToolOutputsMerged` 大於 0 代表這類歷史已被合併處理。

### 選擇器裡看不到某個官方模型

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

程式碼放在 `src/`：四段 JavaScript（`installer.mjs`、`router.mjs`、`claude-bridge.mjs`、
`imagegen.mjs`）都是一般模組，另有 `wrapper.sh` 與 `wrapper.ps1` 兩個啟動外殼。
repo 根目錄的 `codex-model-router.sh`／`.ps1` 是建置產物：同一份負載分別包進 bash heredoc
與 PowerShell 註解區塊，讓使用者只需下載單一檔案。改完 `src/` 之後要重新建置：

```bash
node tools/build.mjs           # 寫入 .sh 與 .ps1
node tools/build.mjs --check   # 只比對，有落差就以非零狀態結束
```

兩支安裝器都要提交進 repo，因為安裝指令直接從 `main` 下載它們。

發佈新版本：更新 `src/installer.mjs` 的 `INSTALLER_VERSION` 與 `releases.json`，執行
`node tools/build.mjs`，合併進 `main` 後推送對應的 tag：

```bash
git tag v1.23.0
git push origin v1.23.0
```

`.github/workflows/release.yml` 會先驗證 tag、安裝器版本與 `releases.json` 一致並跑完測試，
再建立 GitHub Release，附上安裝器、診斷腳本與 `SHA256SUMS`。
發布新版本時也要更新 `releases.json` 的 `latest` 與對應更新說明；建置工具會驗證
`latest` 是否和安裝器內的 `INSTALLER_VERSION` 一致。

### 測試

測試直接把建置後 `.sh` 裡的四段負載取出來 import，所以測到的一定是會發佈出去的那份。

```bash
npm test        # node --test，無需安裝任何相依套件
npm ci          # 安裝 ESLint 與 e2e 測試用的 Codex CLI
npm run lint    # ESLint
npm run check   # 等同 CI：安裝器與 src/ 一致、ESLint、測試
```

安裝器與路由器的頂層本來就有副作用（跑安裝流程、佔用連接埠），測試靠
`CODEX_MODEL_ROUTER_IMPORT_ONLY=1` 擋掉，其餘模組載入行為完全一致。

幾個 e2e 測試會啟動真的 Codex（`app-server`），搭配假的登入資訊與本機上游，不連網、
不需要真實憑證。執行檔來自 `npm ci` 安裝的 `@openai/codex`（版本固定在
`package-lock.json`），也可以用 `CODEX_MODEL_ROUTER_TEST_CODEX_BIN` 指定；兩者都沒有時略過。

### CI

`.github/workflows/ci.yml` 在 push 與 PR 上跑兩個 job：

- **ubuntu**——建置一致性檢查、ESLint、測試（Node 22 與 24）、`.sh` 與 `.ps1` 的語法檢查，
  以及 `.ps1` 的 UTF-8 BOM 檢查。
- **windows**——同一份建置檢查與測試在 Windows 簽出上再跑一次，語法檢查改用
  Windows 內建的 PowerShell 5.1，並確認 5.1 讀這支 `.ps1` 的編碼是對的。

兩個 job 都會裝好固定版本的 Codex CLI，e2e 測試一定會跑。另有
`.github/workflows/codex-latest.yml` 每天改用 npm 上最新的 Codex 跑一次完整測試：Codex 更新頻繁，
協定一改路由器就可能在使用者那邊壞掉，這個排程能先發現。確認相容後更新 `package.json`
裡固定的版本即可；Dependabot 每週也會提出更新。

之所以要有第二個 job：使用者實際跑的是 5.1，但 CI 上的 `pwsh` 是 7，`??`、`?.`、
三元運算子與 `&&` 在 7 上都合法、到了 5.1 才是語法錯誤。負載這邊也一樣——POSIX
專用的路徑（拿 `/dev/null/nope` 當「寫不進去的目錄」是實際發生過的例子）在
Windows 上會變成普通相對路徑，測試照樣綠燈，其實什麼都沒驗到。

下面那兩件事之所以要自動擋，是因為它們壞掉都不會立刻報錯。

**請不要手改根目錄的 `.sh`／`.ps1`，也不要自己寫同步腳本。** 建置工具除了搬運文字，
還負責幾件容易被忽略、壞掉又不會立刻報錯的事：

- `.ps1` 開頭必須保留 UTF-8 BOM。PowerShell 5.1 少了 BOM 會改用 ANSI 代碼頁讀檔，
  安裝器的所有中文訊息都會變成亂碼。
- 四段負載要整批寫入。只更新其中一段會讓某個平台靜默停留在舊的 router 或 claude-bridge。
- 負載裡不能出現標記行或 `#>`，否則 bash heredoc 或 PowerShell 註解會提早結束。

換行由 `.gitattributes` 統一成 LF；混進 CRLF 會讓 `--check` 在不同平台的簽出上誤報。

## 授權

MIT
