# 開發與發布

[简体中文](development.md) · [繁體中文](development.zh-TW.md) · [回到 README](../README.zh-TW.md)

程式碼放在 `src/`：六段 JavaScript（`installer.mjs`、`router.mjs`、`claude-bridge.mjs`、`claude-cli.mjs`、
`chat-bridge.mjs`、`imagegen.mjs`）都是一般模組，另有 `wrapper.sh` 與 `wrapper.ps1` 兩個啟動外殼。
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

## 測試

測試直接把建置後 `.sh` 裡的六段負載取出來 import，所以測到的一定是會發佈出去的那份。

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

## CI

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
- 六段負載要整批寫入。只更新其中一段會讓某個平台靜默停留在舊的 router 或轉譯層。
- 負載裡不能出現標記行或 `#>`，否則 bash heredoc 或 PowerShell 註解會提早結束。

換行由 `.gitattributes` 統一成 LF；混進 CRLF 會讓 `--check` 在不同平台的簽出上誤報。
