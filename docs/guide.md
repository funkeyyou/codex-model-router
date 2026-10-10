# 完整使用说明

[简体中文](guide.md) · [繁體中文](guide.zh-TW.md) · [English](guide.en.md) · [返回 README](../README.md)

快速安装与常用命令见 [README](../README.md)；遇到错误请看[疑难排解与健康检查](troubleshooting.md)，开发与发布流程见[开发文档](development.md)。

**目录**

- [适合哪些使用情境？](#适合哪些使用情境)
- [请求如何路由？](#请求如何路由)
- [需求](#需求)
- [安装](#安装)
- [网页管理界面](#网页管理界面)
- [升级](#升级)
- [其他指令](#其他指令)
- [版本信息与更新内容](#版本信息与更新内容)
- [同时使用多家供应商](#同时使用多家供应商)
- [只有 Chat Completions 的模型](#只有-chat-completions-的模型)
- [Claude Code 订阅路由（实验性）](#claude-code-订阅路由实验性)
- [中转 API 生图（可选）](#中转-api-生图可选)
- [工具可用性与兼容范围](#工具可用性与兼容范围)
- [平台差异](#平台差异)
- [功能细节](#功能细节)

## 适合哪些使用情境？

- 想在 Codex 中使用 Claude，并保留官方 GPT 模型与既有工作流程。
- 想让 Codex 连接自定义 Base URL、第三方 API 或中转 API，并分别管理多家供应商的 Key。
- 想尝试 DeepSeek、Qwen（通义千问）、GLM、Kimi、Gemini，或通过 Ollama／vLLM 提供的 OpenAI 兼容端点。是否可用及工具能力以实际探测为准，不代表所有模型或部署方式都已验证。

<img src="images/codex-model-picker.png" alt="Codex Desktop 模型菜单：官方 GPT、ark 自定义 GPT 与两家供应商的 Claude 模型并列" width="420">

*实际模型菜单示例。前缀与模型可用性取决于你的供应商及账号；截图不是预装模型清单。*

## 请求如何路由？

官方 ChatGPT 模型仍直接送往 OpenAI，只有你选取的自定义模型会送往你设置的 Base URL。
可以同时设置多家供应商，各自保存 API Key（见「[同时使用多家供应商](#同时使用多家供应商)」）；
只提供 `/chat/completions` 的模型也能用（见「[只有 Chat Completions 的模型](#只有-chat-completions-的模型)」）。
Codex 仍使用内建的 `openai` 供应商 ID，所以桌面版与手机 Remote 既有的对话都不受影响。

支持 macOS 与 Windows：两边跑的是同一份路由器与转译代码，只有「凭据存放」与
「背景常驻」两件事按平台走各自的原生机制。

## 需求

- 兼容 OpenAI 接口的供应商端点
- **macOS**：Codex Desktop
- **Windows**：Windows 10 1809 以上或 Windows 11、Codex 桌面版、Node.js v22.15 以上
  （路由器需要 `node:zlib` 的 zstd 支持；Codex 自带的 Node 也算数）

## 安装

本文默认使用简体中文；安装器的交互提示目前仍为繁体中文。

两个平台各有一支进入点——macOS 是 bash 脚本，Windows 是 PowerShell 脚本。两边的
shell 与下载工具不同，没办法共用同一行指令；但装出来的东西完全一样：同一份路由器
与转译代码、同一套设置流程。

### macOS

```bash
curl -fsSL https://github.com/funkeyyou/codex-model-router/raw/refs/heads/main/codex-model-router.sh -o codex-model-router.sh && bash codex-model-router.sh
```

> 用 `curl` 下载不会被加上隔离属性，所以不会跳 Gatekeeper 警告。
> 若改用浏览器下载，请以 `bash codex-model-router.sh` 执行，不要在 Finder 双击。

### Windows

在 PowerShell 窗口里执行（`.ps1` 直接双击只会用记事本开启）：

```powershell
curl.exe -fsSL https://github.com/funkeyyou/codex-model-router/raw/refs/heads/main/codex-model-router.ps1 -o codex-model-router.ps1; powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1
```

> 同样地，用 `curl.exe` 下载不会被标上「来自互联网」，不会触发 SmartScreen 警告。
> 若改用浏览器下载，先在文件内容里按「解除封锁」再执行。

安装时会询问三件事：Base URL、API Key、以及要加入哪些模型。
输入 API Key 时画面不会显示任何字符（跟 `sudo` 一样），贴上后直接按 Enter。
选模型时可以输入编号、范围或 `all`；网关的 `/models` 没列出的模型，也可以直接输入模型 ID
（例如 `1,3,qwen3-max`），一样要通过探测才会加入。选中的模型会平行探测，同时最多 3 个；
网关限流较严时可设环境变数 `CODEX_MODEL_ROUTER_PROBE_CONCURRENCY=1` 改回逐一探测。
路由器安装成功后，另会询问是否使用中转 API 生图，默认为否；同意后才检测图片模型并安装独立技能。

### 固定版本并验证下载（可选）

上面的指令下载的是 `main` 上的最新安装器。想固定某个版本，或下载后先确认文件没被窜改，
可以改从 [Releases](https://github.com/funkeyyou/codex-model-router/releases) 下载：
每个版本都附有两支安装器、诊断脚本与 `SHA256SUMS`。
`releases/latest/download/` 永远指向最新的正式版本。

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

两行输出的哈希相同再执行安装器。

## 网页管理界面

从 1.27.0 起，菜单第 2 项「开启网页管理界面」或 `ui` 指令会在浏览器打开本机管理页：

```bash
bash codex-model-router.sh ui
```

```powershell
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 ui
```

安装或更新完成后，安装器会在路由器目录放一份安装器副本，并建立「Codex 模型路由器」快捷方式（macOS 在 `~/Applications`，Windows 在开始菜单），之后双击即可打开，不必再找当初下载的安装器。

从 1.27.5 起，安装或更新会自动加入 Codex 的「自訂模型管理」全局入口。重新打开 Codex 后，点击入口即可在浏览器打开本机管理页，不需要下载仓库或配置项目 Actions。入口使用官方支持的 [MCP Apps 全局扩展](https://developers.openai.com/plugins/build/extensions#sidebar-apps)，需要支持 MCP Apps 的桌面版本；不同版本会显示在顶部或侧边栏。打开入口不需要模型推理或消耗中转额度。若只想重新注册入口，可运行 `ui-setup`，不重启路由器。

这个本机 MCP 只提供「打开管理页」工具，不暴露配置读写或 API Key。管理操作仍在原有的本机网页中完成。安装器只管理自己的 `mcp_servers.model_router_manager` 项目；同名项目已被用户配置时会保留并提示，其他 MCP 服务器不受影响。回退会移除仍由本工具管理的入口。

Git 项目也可选用仓库提供的 [Actions 配置](../.codex/environments/environment.toml)。Actions 受 Codex 项目环境支持范围限制，不作为通用入口。

- **总览**：路由器状态、请求统计、最近的错误与诊断 ID、执行环境。
- **模型**：拖曳排序，修改显示名称、上下文与输出，勾选删除。新增模型时可选中转供应商或 Claude 订阅；默认上下文 1,000,000、输出 128,000，上游回报的上限较小时以上游为准。
- **供应商**：新增「API Key 连接」（中转站、OpenAI 兼容服务或官方 Anthropic API）或「Claude 订阅账号（Claude CLI）」，更换 API Key、移除供应商。选 Claude 订阅时会依序检查 CLI 是否安装、版本与订阅登录，缺少的步骤可直接处理。1.28.0 起可修改供应商的显示名称与模型前缀：名称只影响显示，内部 ID、已有对话与 API Key 不变；前缀决定选择器里的「前缀/模型名」，会替换上游自带的前缀（如 `ark/`），只改自动生成的名称，手动改过的名称保留，之后新增的模型也会套用。修改前可预览，不重启路由器。Claude 订阅目前只能改前缀。
- **生图**：检测、启用或停用中转 API 生图。
- **设置**：设置或移除全局上下文，勾选强制显示被隐藏的官方模型。
- **版本**：左上角显示当前版本，有新版时列出更新内容，可一键更新。

背后沿用菜单的流程：写入前备份，失败自动还原；会产生费用或使用订阅额度的探测、生图检测与 Claude 测试，都会先列出内容再确认。排序、改名与修改上下文只写入模型目录，不重启路由器；修改输出、添加或删除模型会重启路由器。输出上限只对 Claude 模型有效（送往 Claude 的 `max_tokens`，或 Claude CLI 的 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`），GPT 与 Chat Completions 模型不送这个值，由上游决定。

管理页只监听 `127.0.0.1`，网址附带本次的访问令牌（请勿分享），并检查 Host 与 Origin、只接受 JSON 请求、启用 CSP。API Key 只写入钥匙圈或 DPAPI，不会回传到页面。1.27.5 起默认在后台运行，打开命令完成即退出；Windows 的 Codex 入口和开始菜单快捷方式不会留下 CMD／PowerShell 窗口。重复打开复用同一个管理页，请点击「结束管理页」关闭，或闲置 20 分钟后自动结束；`ui --foreground` 可保留终端诊断模式。常驻的路由器本身不提供网页。首次安装与回退仍在终端执行。

1.28.0 起界面支持简体中文、繁体中文与英文，默认跟随浏览器语言（都不符合时用英文），可在左下角切换并记住选择。安装器产生的操作记录与错误细节会在简体界面自动转成简体；英文界面会翻译常见错误，操作记录仍以中文显示。

## 升级

已经装过的话，日常升级用 `update`，不要重跑 `install`：

```bash
bash codex-model-router.sh update
```

```powershell
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 update
```

从 1.27.0 起，也可以在网页管理界面左上角的版本菜单一键更新：从 GitHub Release 下载新版安装器、核对 `SHA256SUMS` 后执行同样的 `update`；macOS 上可选择完成后重新启动 ChatGPT。

1.27.3 起，更新成功后会自动交接新版管理程序，沿用同一个网址并恢复操作记录，不需要浏览器保持轮询；桌面重启由独立程序执行，重开后确认 App 确实启动。若交接或重启失败，可查看路由器目录内的 `manager-worker.log`。从 1.27.0～1.27.2 升级时，请先使用新安装器的 `update` 与 `ui` 命令重新打开管理页，旧版页面无法自行应用这项修复。

`update` 只换掉路由器与转译层的代码并重写服务定义，然后重启服务并做健康检查。
Base URL、API Key、连接埠与所有已设置的自定义模型全部沿用，不会重问任何一项。
从 1.22.0 起，更新会通过 Codex CLI 备份并移除本工具旧版写入的
`model_catalog_json`，让启动时可以同步官方清单；其他全局配置与用户自行指定的目录保留。
从 1.19.1 起，没有上游前缀的默认模型名称会补上 `api/`，自定义模型 ID、能力与手动名称保留。
更新前的 `router.mjs`、`claude-bridge.mjs`、`settings.json`、
`install.json` 与服务定义都会备份到 `~/.codex/backups/model-router/update-<時間戳>/`，
需要迁移名称时也会备份 `models.json`，移除固定目录设置前会备份 `config.toml`。
任何一步失败都会自动还原并重启回原本的版本。
已启用的中转生图技能也会独立备份与更新，保留手动修改的文件；技能更新失败时维持原状并提示，
不影响已完成的路由器更新。尚未启用的技能不会被 `update` 自动安装。

`install` 保留给第一次安装、换 Base URL 或 API Key、以及重新挑选模型的情况。
设置了多家供应商时，`install` 只重新配置主要供应商，其他家与它们的模型保持不变。

`add` 只探测新选的模型；完成后，自定义模型会按本次探测清单的顺序排列。
已配置但未出现在本次清单的模型会留在后方，原有名称与能力设置不变。

`remove` 或菜单第 5 项可复选删除已配置的自定义模型；空白／`cancel` 返回，删除前会再确认。
安装器先备份设置、模型目录与路由程序，再移除选中的模型并验证 Codex 菜单；失败会还原。
官方模型、API Key 与中转生图技能不受影响；若删除全局默认模型，会清除指向该模型的 `model` 设置。
可以删到零个自定义模型，日后仍可更新或重新添加。
既有任务若仍使用已删除的模型，需先切换模型才能继续。

## 其他指令

菜单第 9 项「设置全局上下文 100 万」也可用
`bash codex-model-router.sh context-1m` 执行；Windows 使用
`powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 context-1m`。
功能会备份用户配置，只将全局 `model_context_window` 设为 1000000，并读回验证。
最大输出、模型目录与路由器设置均不修改，也不重启路由器。菜单第 10 项为中转 API 生图，第 13 项为退出。
网页管理界面的「设置」页也能把全局上下文改成其他值或移除。
完成后重新开启桌面版并建立新任务。配置不会增加上游模型本身的能力或账号权限。

不带参数执行会出现菜单，也可以直接指定动作。

macOS：

```bash
bash codex-model-router.sh update     # 升級程式碼，保留現有設定
bash codex-model-router.sh ui         # 開啟網頁管理介面
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
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 ui
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 add
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 remove
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 providers
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 hidden-models
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 imagegen
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 status
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 rollback
```

> 回退前请先看「[回退之后，用过 Claude 模型的旧对话会坏掉](troubleshooting.md#回退之后用过-claude-模型的旧对话会坏掉)」。

## 版本信息与更新内容

安装器启动时会显示「已安装版本」、「目前这支安装器版本」与「GitHub 线上最新版本」。
若有更新，会按版本顺序列出从已安装版本到最新版之间的所有变更；若手上的安装器本身
已落后，也会先提示重新下载最新版，避免用旧脚本覆盖新安装。

版本资料来自 repo 根目录的 `releases.json`。检查逾时或离线时只会显示无法检查，
不会阻塞安装、添加模型、状态检查或回退流程，也不会上传任何本机设置。

## 同时使用多家供应商

从 1.24.0 起可以同时设置多家中转供应商，各自保存 API Key，模型都会出现在 Codex 的菜单上，
可以混用，也可以把另一家当备援。用 `providers`（菜单第 6 项）管理：

```bash
bash codex-model-router.sh providers add      # 新增一家：Base URL、API Key，探測並添加它的模型
bash codex-model-router.sh providers remove   # 移除一家與它的全部模型
bash codex-model-router.sh providers key      # 更換某一家的 API Key
```

Windows 同样是 `powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 providers add` 等。

- 第一家是主要供应商：`install` 重新配置的是它，Codex 内建的 `image_gen` 也送到它。
- 已有前缀的模型保留上游原名，例如 `ark/gpt-6-sol`；无前缀的模型才补上供应商名称。
  新增时若所选模型都有前缀，会跳过名称输入，自动从网址产生唯一的供应商管理名称；
  其他情况可按 Enter 接受默认名称。内部选择器 ID 仍按供应商隔离，两家提供同名模型也不会混用 Key，
  但菜单可能显示相同名称；既有手动名称与已保存的显示名称保留。
- 有多家时，`add` 会先问要替哪一家添加模型；`remove` 可以一次删不同家的模型。
- 移除供应商会一并移除它的模型；全局默认模型是其中之一时会清除该设置，中转 API 生图用的是
  这家时会停用技能（之后可重新设置）。最后一家不能移除，要整个移除请用 `rollback`。
  移除前会备份，任何一步失败都会还原。
- `imagegen` 在有多家时会问要用哪一家生图。
- 更换 API Key 后，Windows 下一个请求就改用新 Key；macOS 最晚 5 分钟内生效，
  上游拒绝旧 Key 时立即改用。
- 从旧版更新时，原本唯一的供应商成为主要供应商（名称 `default`），模型、选择器 ID 与
  名称都不变，既有对话照常使用。

## 只有 Chat Completions 的模型

Codex 只会说 Responses API。以前只有 `/chat/completions` 的模型在探测时会被跳过，例如
DeepSeek、通义千问、GLM、Kimi、Gemini 的 OpenAI 兼容接口、Ollama、vLLM。从 1.25.0 起，
`/responses` 探测不通时安装器会改探 `/chat/completions`；通过的模型由路由器在本机转译，
和 Claude 走 `/messages` 的做法一样，在 Codex 菜单上照常出现。

探测时会另外确认三件事，结果记在路由设置里：

- **工具呼叫**：上游收不收 `tools` 参数。不收的模型在 Codex 里只能用文字回答，历史里的
  工具呼叫与结果会改成文字给它看。
- **推理强度**：上游收不收 `reasoning_effort`。收的话 Codex 里可选 low／medium／high。
- **用量**：上游收不收 `stream_options`。不收的网关不会反馈用量，Codex 显示的上下文用量会比较不准。

转译时的几个规则：

- 这些模型用一般的函数工具（`exec_command`、`apply_patch` 等），不用 Code Mode：Code Mode 要模型
  把整段 JavaScript 塞进单一工具参数，一般的函数呼叫是这些模型熟悉得多的形式。
- 模型的推理（`reasoning_content`、`reasoning`，或内文开头的 `<think>…</think>`）显示成 Codex 的
  推理摘要。同一轮的工具往返里会送回给模型（DeepSeek、Kimi 等需要），更早的轮次不送；切到官方或
  其他路由时会先剥掉。
- Chat Completions 要求每个工具呼叫后面紧接着它的结果。中断后没有结果的呼叫会补上
  `(no output)`；太晚送达的结果改成标明来源的文字；工具回传的图片改在结果后面以用户消息附上。

限制：

- 这些模型的工具呼叫能力参差不齐，在 Codex 里的效果可能不如 GPT 或 Claude，建议先用简单任务试。
- 平台内建工具（网页搜寻、内建生图等）与 PDF 等文件附件不支持，会明确告知模型或反馈错误，
  不会默默丢掉。生图可以用中转 API 生图技能。
- 上游多半不反馈上下文上限。没有同名的官方模型可以参考时，会沿用通用模板的上限并在安装时提示；
  与实际不符时请手动修改 `models.json`。

## Claude Code 订阅路由（实验性）

实验性的「[Claude CLI 订阅路由](claude-cli-experimental.md)」可从主菜单第 7 项或 `claude-cli` 开启，1.27.0 起也可在网页管理界面的「新增供应商」或「新增模型」选择 Claude 订阅。缺少 CLI 或版本过旧时会先询问是否安装／更新，未登录时引导官方登录。

从 1.26.1 起，优先读取 Claude CLI 当前模型清单并以编号列出完整版本。输入 `1` 选一个、`1,3` 复选、`1-3` 选范围，也支持 `all`、完整模型 ID 及 `cancel` 返回。编号依当次清单排列，已添加的项目会标示；相同版本的别名会合并。

列清单不发送推理请求，只有选中的模型会做短测试并使用订阅用量。CLI 未提供可辨识清单时才使用备援候选，画面会标示来源；CLI 清单可能与 Claude 桌面版不同，也不代表所有项目均有可用额度。未列出的版本仍可输入完整 ID 测试。

真实订阅已通过短文字与一般工具往返测试，Chrome、生图、长对话及 Windows 订阅执行流程仍待验收。上下文上限是手动配置值，不代表已验证该容量；设置 1M 并保留 95% 可用比例时，Codex 显示约 950K。

1.26.5 起改善订阅路由的提示缓存：重播历史的结尾加上一个 1 小时缓存断点，CLI 自己的缓存也固定为 1 小时，下一轮可直接读取上一轮的历史。本机以假 API 模拟 4 轮、10 次请求，缓存命中率从约 37% 提高到约 85%；实际用量仍依对话内容与 Anthropic 计算方式而定。同版本起 Codex 工具说明完整送出，不再被 CLI 在 2,048 字符处截断。

1.29.0 起，Claude 订阅的 Opus 模型在 Codex 菜单提供 Fast（快速模式）开关，对应 Claude Code 的 fast mode：输出更快，但改扣 Claude 账号的使用点数（usage credits），不使用订阅方案额度。账号未开使用点数、方案不支持或模型不支持时，CLI 会自动改用普通速度；可从 `/healthz` 的 `claudeCliFastRequests`、`lastClaudeCliFastState`（`on` 表示实际生效）与 `lastClaudeCliFastDisabledReason` 确认。Sonnet、Haiku 与其他自定义模型不显示 Fast；同一任务中途切换可能让提示缓存重新建立一次。

## 中转 API 生图（可选）

安装时同意启用，或事后选择菜单第 10 项／执行 `imagegen`／在网页管理界面的「生图」页，即可添加独立的 `$router-imagegen` 技能。
不修改官方 `.system/imagegen`，也不需要内建 `image_gen` 工具。请求经本机路由器使用已保存的
API Key；图片费用由你的中转供应商计算，不使用 ChatGPT 方案内含生图额度。
设置了多家供应商时会先问要用哪一家；技能会记住这个选择，之后的生图都送到那一家，
那一家被移除时技能会一并停用，不会改用别家的账号计费。

设置时先选择要检测的模型（可复选），工具会自动测试并添加成功的项目。
先使用目前 API Key 呼叫通用 `/v1/images/generations`；已选模型全部未通过时，才自动改测 Ark 任务接口。
只测试勾选的模型，只有成功取得 PNG 图片的模型才会添加；未选模型不会测试，也不会作为失败后的替代。
通用接口只要有一个成功，就保留这次成功的模型，不再额外呼叫 Ark。
新设置预选 Flare，已有技能则预选目前启用的模型；也可输入 `all` 选择全部三个。
`/models` 只协助判断名称与前缀；即使清单没有图片模型或查询失败，也能进行实测。
清单未列出的模型自动沿用既有设置中的共同前缀；无法推断时使用原始模型名称。
清单已列出的模型保留原始名称。Ark 任务接口使用这三个模型的原始 ID。

**检测会真的生图，可能产生费用。** 选完模型后自动执行，不再询问接口类型、前缀或测试确认。
每个已选模型每种接口最多提交一次；选一个最多两次、选两个最多四次，通用成功时不会执行第二轮。
通用测试使用一张 `1024x1024`、`quality=low`、PNG；Ark 每次单张，尺寸与品质由上游决定。每次最多等待 300 秒。
同一接口内不自动重送，Ark 查询任务不会重新提交。成功的测试图片保留在 `$CODEX_HOME/model-router/imagegen-probes/<時間戳>/`。
两种流程都未通过就显示「没找到可用模型」，不新增技能，现有生图设置保留。
最近一次检测的内部错误会保存到 `$CODEX_HOME/model-router/imagegen-last-check.json`，不含 API Key，方便诊断而不增加画面提示。
测试只能确认当下文字生图可用，尚未测试编辑端点，也不保证日后配额或服务状态。

| 选项 | API 模型 ID | 选用方向 |
| --- | --- | --- |
| Image 2 | `gpt-image-2` | 上一代模型，保留给既有流程或兼容需求 |
| Image 2.5 Sunburst | `gpt-image-2.5-sunburst` | 偏重编辑精准度，适合精细改图与保留原图细节 |
| Image 2.5 Flare | `gpt-image-2.5-flare` | 偏重速度，适合一般生图与快速迭代 |

检测前可输入模型编号（例如 `1,2`）或 `all`；输入 `cancel` 返回，不送生图请求。
成功后自动添加通过的已选模型并记住接口类型，正式生图不会重新探测或切换接口重送。
只启用一个就固定使用；多选时由 AI 按需求
在命令中明确指定，用户指定优先。命令拒绝未勾选的模型，失败不会自动切换模型或重送付费请求。
模型差异参考 [OpenAI 图片指南](https://developers.openai.com/api/docs/guides/image-generation)，速度与价格以中转商为准。

技能安装在 `$CODEX_HOME/skills/router-imagegen/`（未设置 `CODEX_HOME` 时为 `~/.codex/skills/router-imagegen/`），
内含 `SKILL.md`、模型设置、UI 信息与 `scripts/imagegen.mjs` 命令。不含 API Key，不需 Python 或额外包。
新任务中可直接说：

```text
使用 $router-imagegen 幫我畫一隻貓。
使用 $router-imagegen 的 Sunburst 修改這張圖片，只替換背景。
```

也可用安装器选定的 Node 执行技能目录内的命令：

```bash
node "$HOME/.codex/skills/router-imagegen/scripts/imagegen.mjs" list
node "$HOME/.codex/skills/router-imagegen/scripts/imagegen.mjs" generate --model flare --prompt-file prompt.txt --out cat.png
node "$HOME/.codex/skills/router-imagegen/scripts/imagegen.mjs" edit --model sunburst --prompt-file edit.txt --image cat.png --out cat-v2.png
```

Windows 示例（`node` 不在 PATH 时，使用生成的 `SKILL.md` 内记录的完整 Node 路径）：

```powershell
node "$env:USERPROFILE\.codex\skills\router-imagegen\scripts\imagegen.mjs" list
node "$env:USERPROFILE\.codex\skills\router-imagegen\scripts\imagegen.mjs" generate --model flare --prompt-file prompt.txt --out cat.png
```

每次生成一张图，默认 `size=auto`、`quality=auto`、输出 PNG，保留已存在的输出档。
`--image` 可重复提供参考图，`--dry-run` 不送出生成请求。`--model` 省略时，生图依
Flare → Sunburst → Image 2、改图依 Sunburst → Flare → Image 2，使用第一个已启用模型。
通用模式需支持 Images API 的 JSON／multipart 请求与 `b64_json` 图片回应。
Ark 模式使用同一供应商 origin 下的 `/v2/extend/image/ark_gpt_image/generations`、`edits` 及 `tasks/{task_id}`：
提交取得任务编号后查询结果，再下载公开 HTTPS 图片；下载不附带 API Key，并验证目的位址与图片格式。
若代理 DNS 返回 `198.18.0.0/15` 假 IP，会通过 Cloudflare HTTPS DNS 查询该图片网域的真实公开 IP，再验证并固定连线位址；查询不包含图片路径、签名或 API Key。
Ark 不支持指定尺寸／品质或透明背景，`--size`、`--quality` 须保持 `auto`，`--background` 使用 `auto` 或 `opaque`。
改图时命令将本机参考图转为 JSON Base64，API 仍经本机路由器读取凭据；查询或下载失败不重新提交付费任务。
旧路由器须先用新版安装器执行 `update`，才能使用 Ark 任务端点；命令会在提交前检查支持情况。

重新执行 `imagegen` 可重新选择并自动实测模型；选择模型时输入 `none` 或直接执行 `imagegen-disable` 可停用（两者都不生图），技能会封存到
`$CODEX_HOME/backups/model-router/`。`rollback` 也会封存由此路由器建立的技能。手动修改会保留，
同名但不属于此路由器的技能不会被覆写。重新开任务让技能清单刷新，必要时重开 Codex。

## 工具可用性与兼容范围

路由器只能转送 Codex 已提供的工具与请求，不能替账号解锁功能，或把未挂载的工具加进
目前任务。OpenAI 的[工具文件](https://developers.openai.com/api/docs/guides/tools)也区分
平台内建工具与由呼叫端执行的函数工具；改用 Claude Messages API 不会自动取得前者。

| 功能 | 路由处理与限制 |
| --- | --- |
| 终端机、文件编辑、MCP、浏览器等 function/custom 工具 | GPT 保留定义；Claude 与 Chat Completions 做双向转译，包含 namespace 与自由格式输入。仍需 Codex 本身挂载工具并允许执行。 |
| Codex 的搜寻、笔记、历史 HTTP 端点 | 继续送往官方后端，由官方验证账号权限；不会因选择自定义模型而改用中转 Key。 |
| 平台内建 image_generation、web_search、file_search 等工具 | 自定义 GPT 依中转能力而定；Claude 与 Chat Completions 转译无法执行这些内建工具，会告知模型限制。明确强制使用不可用工具时反馈 422，不自动改投其他供应商。官方 GPT 回合已完成的这类项目，切到 Claude 时会转成文字摘要（本机命令转成配对的工具呼叫），同一条对话可以继续。 |
| 中转 API 生图 | 使用已启用的 router-imagegen 技能与既有 Images／Ark 路径，无需内建 image_gen。 |
| 图片与 MCP 图片结果 | Claude 支持 URL、data URL 及 MCP 的 data/mimeType 图片区块。图片数量与大小限制仍适用。 |
| PDF、MCP 资源 | PDF data URL／文件 URL 转为 Claude document；Chat Completions 转译不支持 PDF，明确反馈。MCP 文字资源与链接保留为文字，不额外下载。上游仍需支持文件功能。 |
| 私有 file_id、音讯或未知内容类型 | Claude 转译明确反馈不支持，不默默删除。可先用本机读档／转录工具转成文字或图片。 |
| 严格结构化输出 | Claude 转译尚未适配，明确反馈 422；请改用文字或函数工具。Chat Completions 转译对到 `response_format`，上游需支持。GPT 路径维持原样转发。 |

**1.22.3 起，Claude Code Mode 默认按需读取外部工具说明。** 可辨识的巢状工具
先提供名称与摘要，模型呼叫前从 Codex 的 `ALL_TOOLS` 取得完整说明、参数 schema
及权限要求。实际工具注册与执行权限不变；核心执行工具、网页、生图仍保留完整说明。
不支持这种格式的工具保留原文，不直接启用 Responses 原生 `tool_search`。
此方式可降低工具较多时的初始上下文，但可能增加查找工具的往返；实际节省依工具组合而定。
健康检查的 `lastClaudeToolContext` 显示最近一次转译的工具缩减数、原始／转送字符数，
`claudeToolDefinitionsDeferred` 与 `claudeToolDescriptionCharsSaved` 为启动后累计值。
这些是字符统计，不是 token 数，也不是帐单节省。

**1.22.4 起，同一个工具呼叫的多笔输出会合并成一个结果。** Code Mode 的 `exec` 每呼叫一次
`notify()`，Codex 就替同一个 `call_id` 追加一笔输出；Responses 接受这种历史，Anthropic 则规定
每个 `tool_use` 只能有一个 `tool_result`。Claude 转译会把同一则消息内的后续输出依序并回原本的结果；
模型已往下执行后才送达的输出，改成标明来源的文字放在当下的位置，不改写先前的结果，提示快取不受影响。
user 消息中的 `tool_result` 也一律排在文字之前。GPT 路由维持原样转发。

**1.22.5 起，Claude 的推理改以短索引往返。** Anthropic 反馈的输入用量已包含送回去的
历史推理；Codex 会对旧版的长 `encrypted_content` 再估一次 token，可能在画面显示上下文
仍约半满时就达到自动精简门槛。新版把完整 thinking 和签章以 gzip 压缩存于
`$CODEX_HOME/model-router/reasoning-store/`，交给 Codex 的历史只放短索引；下轮依索引
还原，原有完整内容格式也继续支持。文件不随时间自动删除，因为旧任务仍可能引用；
更新会保留目录，回退会把整个安装目录封存。备份或搬移 `CODEX_HOME` 时须连同该目录一起保留。
磁碟不可写时会回退旧格式并在错误日志记一笔提示，不会中断当前回应。
更新前已经记在 Codex 历史里的长推理不能由路由器直接缩短，会在下一次精简后退出历史；
新版产生的推理立即使用短索引。若手动降版到 1.22.4 或更早，旧版无法还原短索引；
要继续使用这些 Claude 任务，请重新升级并保留 `reasoning-store`。

同版本也调整了 Claude 的图片预算：启用提示快取的路由在超过 20 张图时一次把最旧的
8 张换成占位文字；接下来新增 7 张图都不会再修改早期历史，顶层滚动快取能继续命中。
第 29 张起会再整批省略 8 张。未启用提示快取的路由仍只省略超过 20 张的数量。
实际快取命中仍取决于上游的快取保存时间与网关实作，可从上游反馈的
`cached_input_tokens`、`cache_write_input_tokens` 判断。

因此「模型看不到工具」应先查任务工具清单；「工具可见但执行失败」才往权限、工具服务、
路由及上游检查。安装路由器不会自动安装所有 MCP／插件或更改其权限。

## 平台差异

安装流程、模型探测、路由与 Claude 转译在两个平台完全相同，差别只有这两项：

| | macOS | Windows |
| --- | --- | --- |
| API Key 存放 | 钥匙圈（`security`） | 凭据保护 DPAPI，以目前用户身分加密后存成文件 |
| 背景常驻 | LaunchAgent（`launchctl`） | 工作排程器，登录时启动 |

Windows 的常驻做法是：工作排程器以 `wscript.exe` 执行一支守护回圈，回圈再用隐藏窗口
启动 `router.mjs`，路由器结束就重跑——等同 LaunchAgent 的 `KeepAlive`，而且全程不会
有主控台窗口跳出来。排程另外每 10 分钟检查一次，守护行程本身若被杀掉也能自动补回。

守护回圈是 JScript 写的 `router-launcher.js`。1.22.5 以前用 VBScript（`.vbs`），但微软
预计约 2027 年起默认停用 VBScript，届时新装的服务会起不来；执行 `update` 就会换成新版。
工作若是以系统管理员身分建立的，一般权限可能无法重新注册，`update` 会沿用旧定义并提示，
此时以系统管理员身分执行一次 `update` 即可。安装前会先确认 Windows Script Host 没被系统
原则停用。

API Key 只有目前的 Windows 用户账号解得开，换账号或搬到别台机器都无法解密；
两个平台都不会把金钥写进 `config.toml` 或安装器文件。

## 功能细节

- **区分自定义模型名称**——上游模型名称没有 `/` 前缀时，默认在菜单显示为 `api/模型名`；
  例如 `gpt-test` 显示为 `api/gpt-test`，`ark/gpt-test` 则保持原样。
  请求仍使用上游原名，既有 `custom/*` 选择器 ID 不变，旧对话不需要改模型 ID。
  手动取过的显示名称保留。未配置的 `custom/*` 会直接反馈路由遗失，不会转送官方。
- **重试保留正确历史**——成功终止后才保存对话快照，502、网路失败、串流截断与取消
  不会将半轮内容混入后续重试。官方 WebSocket 接续遭拒后重播、或回退 HTTP 时，也不会
  重复加入工具结果；若对应快照已不存在，会明确要求重新送出完整对话。
  1.21.0 起取消会关闭该上游 WebSocket，避免迟到的旧事件混进下一轮；切换官方模型时
  重播完整历史。GPT 的 HTTP/SSE 回退同样检查终止事件，提早结束会明确反馈失败。
  HTTP 接收与 zstd 解压默认上限为 128 MiB；历史快照依序列化位元组计帐，总预算
  128 MiB、30 分钟过期，同时保留原本最多 32 组、每组 4 个回应的限制。可在 settings.json
  设置 `maxHttpBodyBytes`（最高 512 MiB）、`maxHistoryBytes`、`historyTtlMs`，重启路由器后生效。
  这些是路由器的资源限制，不改 Codex 的上下文设置；快照淘汰后要求完整重送，不截断内容。
- **可定位的网路错误**——DNS、TLS、连线中断、逾时与登录验证遭拒分开反馈，附诊断 ID。
  `/healthz` 的 `stats.lastError` 与 `router.err.log` 可对照时间、上游主机、阶段与原因码，
  诊断纪录不包含金钥、认证标头或对话内容。ChatGPT 验证探测设有 15 秒上限，暂时性
  故障不会被误报为需要重新登录，也不会快取成验证成功。
- **自动检测上下文上限**——Anthropic 模型通过供应商的验证错误精确取得（该探测不计费），
  其余沿用官方同名模板；找不到时明确警告，不会静默填入错误的默认值。
- **官方 Anthropic API**——1.29.4 起可直接以 `https://api.anthropic.com` 为 Base URL 添加 Claude 模型：发往官方时改用 `x-api-key` 与 `anthropic-version` 认证，Key 不会以 Bearer 发送；中转站仍用 Bearer，Claude 原生 `/messages` 请求一律补上 `anthropic-version`。
- **自动判断是否需要转译**——优先依 `/v1/models` 的 `owned_by`；部分自架网关完全不回
  这个栏位（例如直接回 Anthropic 格式的 `{id, type, display_name}`），此时改用模型名推断，
  再以原生 `/messages` 验证。推断错误是安全的：探测不通会回退到通用 Responses 路由并提示。
- **Claude 模型本机转译**——部分网关的 Responses 兼容层对 Claude 有缺陷：有的串流回
  `stream_options` 错误、非串流内容为空；有的会把 Codex Code Mode 的 `namespace`
  工具包装原样转给 Anthropic 而被拒（`Input tag 'namespace' does not match...`），
  导致模型调不到任何工具。此时改走 Anthropic 原生 `/v1/messages` 并在本机做双向转译：
  送往 Anthropic 时把 namespace 编成不重名的工具别名，回到 Codex 时再拆回独立的
  `name` 与 `namespace` 栏位，历史重播也做相同的反向转换；同时挂上 `cache_control`
  以启用提示快取。
  1.21.0 起也接受顶层 `instructions` / `tools`、简写消息、指定函数工具与
  `parallel_tool_calls: false`。过长或容易碰撞的工具名称使用稳定别名，回程还原原名称。
  工具 JSON 损坏或自由格式工具缺少字串输入时反馈失败，不以空参数继续执行。
- **推理强度真的会生效**——`thinking.budget_tokens` 在较新的模型上已被移除（官方直接
  400，部分网关静默丢弃），结果是在 Codex 里选 low 或 max 毫无差别、而且一律跑在高强度。
  安装时会探测 `output_config.effort`，支持的话把五档直接透传。实测 low 档耗时从
  约 17 秒降到约 9.5 秒。
- **网关生的图不再石沉大海**——部分网关会自行启用 `image_generation`，回应带着整张图，
  但 Codex 只在自己发起生图时才会建立可渲染项目，收到了也只是塞进历史。路由器因此把它
  翻成 Codex 的内建 `view_image` 呼叫：图先落地（默认是用户的「下载」，安装时解析后
  写进 `settings.json` 的 `imageOutputDir`，可自行改掉；Windows 会读已知资料夹的实际
  位置，「下载」被搬到别的磁碟也不会写错地方），
  再合成一次工具呼叫，Codex 就会产生 `ImageView` 项目显示出来（在工具活动区块里），
  模型自己也拿得到那张图。合成的呼叫用可辨识的 `call_id` 前缀，送往上游前连同输出一起剥除
  ——上游不认得这个工具，留着会让下一轮被拒。`viewImageBridge = false` 可只保留存档。
- **显示推理摘要**——这些模型默认 `display` 是 `omitted`：thinking 区块照样送来，
  但文字是空的。安装时探测 `adaptive`／`summarized`，支持就明确要求摘要，并把它串成
  `reasoning_summary` 事件、写进 reasoning 项目的 `summary` 栏位——Codex 显示的是
  这个栏位，`encrypted_content` 只负责往返，两者都要处理才看得到。
- **对话历史可被快取**——Anthropic 的快取前缀是 `tools → system → messages`，只在
  system 挂断点的话，会长大的历史每轮都要重算。安装时探测顶层 `cache_control`，
  支持就加上滚动断点。实测约 2 万 token 的历史，未快取输入从 19650 降到 2。
  两项探测失败或不支持时都自动沿用原有行为。
  1.26.5 起，对话中途补送的 developer 消息（技能清单、协作模式、切换模型等）留在原位，
  以 `<system-reminder>` 标示来源，不再改写 system；开头那组仍放在 system。
- **Claude 会汇报进度，最后答案标成最终答案**——Codex 发给自定义模型的是 GPT 版系统提示，
  要求把进度发到 `commentary` 频道；Claude 的输出没有频道，实测在 Codex 里很少在工具之间说话。
  1.26.6 起在 Claude 路由的 system 最后加一段固定说明，把频道对应到 Claude 的文字输出，
  并比照 Claude Code 要求「第一次调用工具前说明要做什么、有重要发现时简短更新」。
  同版本起转译路由（Claude 与 Chat Completions）把整轮最后一段、没有接工具调用的文字标成
  `final_answer`，其余维持 `commentary`；流式输出时先以进度更新显示，完成时才定案。
- **有状态接续的本机重建**——Codex 在工具接续回合只送工具结果并倚赖
  `previous_response_id`，但该参数需要真正的 WebSocket 上游。本路由改以
  「上次完整输入 + 该轮输出 + 本次新项目」在本机重建等价的完整请求；每条
  WebSocket 都有独立的历史 namespace，背景任务即使重复使用同一个 `session_id`
  也不会覆盖目前对话。
- **打开任务不会多付一次生成**——Codex 开新任务或打开旧任务时，会先用该任务记住的模型
  发一个 `generate:false` 的预热：官方后端只预先处理提示词、不生成内容，下一轮再以它的 id
  增量接续。第三方上游没有这种语义，1.27.x 以前路由器会把它当成一次完整生成转给上游，
  每打开一个自定义模型的任务就多消耗一次初始上下文的用量。1.28.0 起自定义模型与 HTTP 回退的
  预热由路由器本机完成，并把预热输入记成历史，下一轮照常重建；官方模型走得通上游
  WebSocket 时仍交给官方处理。
- **上游不通时自动收敛重试**——官方的上游 WebSocket 连续握手失败后，整个路由器
  暂停尝试一段时间并直接走 HTTP，避免每个新对话的第一轮都先赔一次握手；
  上游恢复后立刻解除。门槛与冷却时间可用 `settings.json` 的
  `upstreamWebSocketFailureThreshold` 与 `upstreamWebSocketCooldownMs` 调整。
- **重启时同步最新模型**——Codex 启动向本机 `/models` 请求时，路由器先用该请求的
  ChatGPT 登录信息读取官方清单，再合并既有 `custom/*` 模型与强制显示设置。
  Codex 启动瞬间可能先显示自己的快取，背景同步完成后再次开启模型菜单即可读取新清单。
  不需等待 Codex 执行档更新；不呼叫推理或付费探测。不再配置固定 `model_catalog_json`。
  官方查询最长等待 10 秒；网路、登录或资料格式失败时保留本地清单。
  `settings.json` 的 `catalogRefresh = false` 可停用远端同步，重启路由器后生效。
  `/healthz` 的 `stats.lastCatalogSync` 显示最近一次来源、HTTP 状态及时间，不含凭据。
- **被藏起来的官方模型可以叫出来**——内建目录会把尚未普及的模型标成 `hide`，但实际
  能不能用是后端依账号决定的。通过独立的 `hidden-models` 菜单可选择强制显示，
  选择记在 `settings.json` 的 `forceListedModels`。
- **连线保活**——长请求期间送出 WebSocket ping，避免客户端闲置逾时。
- **错误可见**——上游错误会转为标准的 `response.failed` 事件，不会让客户端无声卡住。
  这包含最难察觉的一种：网关在回应中途把串流丢掉。此时读取端收到的是干净的 EOF 而不是
  例外，状态码当初又是 200，两种既有的错误处理都接不到——三条串流路径因此都会在读完后
  确认终止事件真的送出去了，没有就补上。同样地，请求大到上游一定会拒收时，
  在送出前就挡下来并讲明原因——否则客户端只会收到网关那句通用的错误，然后不停重试，
  每次都把整份历史再上传一遍。
