# Summer Shark Issue bot

新 Issue 自動分析。已有 Issue 可在留言開頭呼叫：

```text
@summer-shark 請重新分析這個 Issue
```

單次指定思考深度：

```text
@summer-shark effort=high 請依照新的重現步驟分析
```

支援 `low`、`medium`、`high`、`xhigh`、`max`。repository 預設為 `max`，
可在 Actions Variables 的 `CODEX_REASONING_EFFORT` 修改。
`Run workflow` 也可選擇本次 effort；選 `default` 會使用 repository 設定。
分析與修復兩個階段使用同一個 effort。第三方供應商需要接受相應參數。

每次新呼叫會新增一則 bot 回覆，並連結到觸發它的留言。原本的回覆會保留，
對話依留言時間排列。同一次 Actions run 重試才會更新該次 run 的回覆，避免重複發送。

`CODEX_BOT_MENTION` 可調整呼叫名稱，預設 `@summer-shark`。真正 GitHub App 的
`@summer-shark[bot]` 也能辨識。只有一般使用者在開啟中的 Issue 留言才會觸發；
機器人回覆、PR 留言、引用、程式碼區塊與一般提及不會呼叫模型。

URL、key 與模型沿用 `CODEX_BASE_URL`、`OPENAI_API_KEY`、`CODEX_MODEL`。
思考深度或留言指令均不會變更這些設定。

## 專用回覆帳號

呼叫名稱與實際 GitHub 回覆身分分開設定。要顯示專用 bot 身分，需要在
`funkeyyou` 帳號建立 GitHub App，並只安裝到 `funkeyyou/codex-model-router`。
所需 repository 權限：Contents、Issues、Pull requests 的 Read and write，
以及 GitHub 必要的 Metadata Read-only。Webhook 不啟用，事件由 Actions 接收。

在 repository 的 Actions 設定加入：

| 類型 | 名稱 | 內容 |
|---|---|---|
| Variable | `CODEX_APP_ID` | GitHub App 的數字 App ID |
| Secret | `CODEX_APP_PRIVATE_KEY` | App private key 的完整 PEM 內容 |

發布 job 會使用 GitHub 官方 `actions/create-github-app-token` 產生只限本
repository 的短期 token，讓留言與 PR 顯示為 App 的 bot 身分。
App private key 與發布 token 不會傳給執行模型或候選補丁測試的 job。
在 App 尚未配置完成時，仍會用 `github-actions[bot]` 回覆。

參考：[GitHub App 註冊](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)、
[在 Actions 使用 GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow)、
[Codex Action effort](https://learn.chatgpt.com/docs/github-action)。

## 專案驗證

本專案使用 Node.js 24。安裝開發依賴：`npm ci`。
完整驗證：`npm run check`；修改 `src/` 後先執行 `npm run build`，
讓兩個產生的安裝器同步，再執行完整驗證。
原有 CI 會另外執行 Node.js 22／24 與 Windows 的檢查。
