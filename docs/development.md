# 开发与发布

[简体中文](development.md) · [繁體中文](development.zh-TW.md) · [返回 README](../README.md)

代码放在 `src/`：六段 JavaScript（`installer.mjs`、`router.mjs`、`claude-bridge.mjs`、`claude-cli.mjs`、
`chat-bridge.mjs`、`imagegen.mjs`）都是一般模组，另有 `wrapper.sh` 与 `wrapper.ps1` 两个启动外壳。
repo 根目录的 `codex-model-router.sh`／`.ps1` 是建置产物：同一份负载分别包进 bash heredoc
与 PowerShell 注解区块，让用户只需下载单一文件。改完 `src/` 之后要重新建置：

```bash
node tools/build.mjs           # 寫入 .sh 與 .ps1
node tools/build.mjs --check   # 只比對，有落差就以非零狀態結束
```

两支安装器都要提交进 repo，因为安装指令直接从 `main` 下载它们。

发布新版本：更新 `src/installer.mjs` 的 `INSTALLER_VERSION` 与 `releases.json`，执行
`node tools/build.mjs`，合并进 `main` 后推送对应的 tag：

```bash
git tag v1.23.0
git push origin v1.23.0
```

`.github/workflows/release.yml` 会先验证 tag、安装器版本与 `releases.json` 一致并跑完测试，
再建立 GitHub Release，附上安装器、诊断脚本与 `SHA256SUMS`。
发布新版本时也要更新 `releases.json` 的 `latest` 与对应更新说明；建置工具会验证
`latest` 是否和安装器内的 `INSTALLER_VERSION` 一致。

## 测试

测试直接把建置后 `.sh` 里的六段负载取出来 import，所以测到的一定是会发布出去的那份。

```bash
npm test        # node --test，無需安裝任何相依套件
npm ci          # 安裝 ESLint 與 e2e 測試用的 Codex CLI
npm run lint    # ESLint
npm run check   # 等同 CI：安裝器與 src/ 一致、ESLint、測試
```

安装器与路由器的顶层本来就有副作用（跑安装流程、占用连接埠），测试靠
`CODEX_MODEL_ROUTER_IMPORT_ONLY=1` 挡掉，其余模组加载行为完全一致。

几个 e2e 测试会启动真的 Codex（`app-server`），搭配假的登录信息与本机上游，不连网、
不需要真实凭据。执行档来自 `npm ci` 安装的 `@openai/codex`（版本固定在
`package-lock.json`），也可以用 `CODEX_MODEL_ROUTER_TEST_CODEX_BIN` 指定；两者都没有时略过。

## CI

`.github/workflows/ci.yml` 在 push 与 PR 上跑两个 job：

- **ubuntu**——建置一致性检查、ESLint、测试（Node 22 与 24）、`.sh` 与 `.ps1` 的语法检查，
  以及 `.ps1` 的 UTF-8 BOM 检查。
- **windows**——同一份建置检查与测试在 Windows 签出上再跑一次，语法检查改用
  Windows 内建的 PowerShell 5.1，并确认 5.1 读这支 `.ps1` 的编码是对的。

两个 job 都会装好固定版本的 Codex CLI，e2e 测试一定会跑。另有
`.github/workflows/codex-latest.yml` 每天改用 npm 上最新的 Codex 跑一次完整测试：Codex 更新频繁，
协定一改路由器就可能在用户那边坏掉，这个排程能先发现。确认兼容后更新 `package.json`
里固定的版本即可；Dependabot 每周也会提出更新。

之所以要有第二个 job：用户实际跑的是 5.1，但 CI 上的 `pwsh` 是 7，`??`、`?.`、
三元运算子与 `&&` 在 7 上都合法、到了 5.1 才是语法错误。负载这边也一样——POSIX
专用的路径（拿 `/dev/null/nope` 当「写不进去的目录」是实际发生过的例子）在
Windows 上会变成普通相对路径，测试照样绿灯，其实什么都没验到。

下面那两件事之所以要自动挡，是因为它们坏掉都不会立刻报错。

**请不要手改根目录的 `.sh`／`.ps1`，也不要自己写同步脚本。** 建置工具除了搬运文字，
还负责几件容易被忽略、坏掉又不会立刻报错的事：

- `.ps1` 开头必须保留 UTF-8 BOM。PowerShell 5.1 少了 BOM 会改用 ANSI 代码页读档，
  安装器的所有中文消息都会变成乱码。
- 六段负载要整批写入。只更新其中一段会让某个平台静默停留在旧的 router 或转译层。
- 负载里不能出现标记行或 `#>`，否则 bash heredoc 或 PowerShell 注解会提早结束。

换行由 `.gitattributes` 统一成 LF；混进 CRLF 会让 `--check` 在不同平台的签出上误报。
