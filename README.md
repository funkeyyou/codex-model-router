# codex-model-router — Codex 多模型路由工具

[简体中文](README.md) · [繁體中文](README.zh-TW.md) · [English](README.en.md) · [下载 Releases](https://github.com/funkeyyou/codex-model-router/releases) · [问题反馈](https://github.com/funkeyyou/codex-model-router/issues)

**在 Codex Desktop 使用 Claude 与第三方模型，同时保留官方 GPT 模型。**

模型菜单仍显示旧名称或已删除的模型？从 1.27.8 起，可在网页管理页总览点击「同步與修復模型清單」，或运行 `bash codex-model-router.sh repair-models`（Windows：`powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 repair-models`）。这会备份并清除可重建的模型列表缓存，校验名称、可见性及默认模型，不发送模型推理请求。只有旧路由能证明同一供应商、同一上游模型的唯一对应时才迁移默认 ID，否则清除失效默认。完成后重新展开模型菜单；界面仍未刷新时，请完全退出桌面版再打开（macOS 用 ⌘Q，关闭窗口不等于退出）。已有任务保存的模型选择需要手动重选。

Use Claude and OpenAI-compatible models in Codex Desktop alongside official GPT models.
Local multi-provider routing for macOS and Windows.

为 Codex Desktop／ChatGPT Desktop 添加第三方 API、自定义模型与多供应商管理的本机代理（LLM proxy / model router）。支持 OpenAI Responses API、Anthropic Claude Messages API 与 OpenAI-compatible Chat Completions；另提供实验性的 Claude Code CLI 订阅账号路由。

- **同一个模型菜单**：在官方 GPT、自定义 GPT 与 Claude 之间选择，无需反复更换全局供应商。
- **多家 API 各自管理**：每家保存自己的 API Key，支持模型检测、添加、删除与更换 Key。
- **兼容多种接口**：支持 Responses API、Claude Messages 转译，以及 Chat Completions 兼容端点；实际能力会先探测。
- **macOS／Windows 安装器**：互动设置、更新备份与回退，另可启用中转 API 生图技能。
- **网页管理界面**：在浏览器管理模型、供应商、Claude 订阅、生图与全局设置，可检查更新并一键升级。
- **Claude Code 订阅路由（实验性）**：通过已登录的 Claude CLI 探测并添加模型，工具仍由 Codex 执行；需要可用的订阅权限与额度。

[安装](#安装) · [网页管理](#网页管理界面) · [升级](#升级) · [多供应商](#同时使用多家供应商) · [Chat Completions](#只有-chat-completions-的模型) · [Claude CLI 说明](docs/claude-cli-experimental.md)

### 适合哪些使用情境？

- 想在 Codex 中使用 Claude，并保留官方 GPT 模型与既有工作流程。
- 想让 Codex 连接自定义 Base URL、第三方 API 或中转 API，并分别管理多家供应商的 Key。
- 想尝试 DeepSeek、Qwen（通义千问）、GLM、Kimi、Gemini，或通过 Ollama／vLLM 提供的 OpenAI 兼容端点。是否可用及工具能力以实际探测为准，不代表所有模型或部署方式都已验证。

<img src="docs/images/codex-model-picker.png" alt="Codex Desktop 模型菜单：官方 GPT、ark 自定义 GPT 与两家供应商的 Claude 模型并列" width="420">

*实际模型菜单示例。前缀与模型可用性取决于你的供应商及账号；截图不是预装模型清单。*

### 开始前需要什么？

已安装的 Codex Desktop／ChatGPT Desktop、已登录的 ChatGPT 账号，以及中转供应商的 Base URL 和 API Key。
第三方 API 的费用由供应商计算；工具不提供模型额度，也不解锁账号未开放的内建工具。
本项目是非官方社区工具，与 OpenAI、Anthropic 无隶属关系。

自定义模型的工具能力依模型与 API 而异，请参考[工具兼容性说明](#工具可用性与兼容范围)。
若要移除，先阅读[回退与旧对话注意事项](#回退之后用过-claude-模型的旧对话会坏掉)。

### 请求如何路由？

官方 ChatGPT 模型仍直接送往 OpenAI，只有你选取的自定义模型会送往你设置的 Base URL。
可以同时设置多家供应商，各自保存 API Key（见「[同时使用多家供应商](#同时使用多家供应商)」）；
只提供 `/chat/completions` 的模型也能用（见「[只有 Chat Completions 的模型](#只有-chat-completions-的模型)」）。
Codex 仍使用内建的 `openai` 供应商 ID，所以桌面版与手机 Remote 既有的对话都不受影响。

支持 macOS 与 Windows：两边跑的是同一份路由器与转译代码，只有「凭据存放」与
「背景常驻」两件事按平台走各自的原生机制。

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

Git 项目也可选用仓库提供的 [Actions 配置](.codex/environments/environment.toml)。Actions 受 Codex 项目环境支持范围限制，不作为通用入口。

- **总览**：路由器状态、请求统计、最近的错误与诊断 ID、执行环境。
- **模型**：拖曳排序，修改显示名称、上下文与输出，勾选删除。新增模型时可选中转供应商或 Claude 订阅；默认上下文 1,000,000、输出 128,000，上游回报的上限较小时以上游为准。
- **供应商**：新增「OpenAI 兼容 API」或「Claude 订阅账号（Claude CLI）」，更换 API Key、移除供应商。选 Claude 订阅时会依序检查 CLI 是否安装、版本与订阅登录，缺少的步骤可直接处理。1.28.0 起可修改供应商的显示名称与模型前缀：名称只影响显示，内部 ID、已有对话与 API Key 不变；前缀决定选择器里的「前缀/模型名」，会替换上游自带的前缀（如 `ark/`），只改自动生成的名称，手动改过的名称保留，之后新增的模型也会套用。修改前可预览，不重启路由器。Claude 订阅目前只能改前缀。
- **生图**：检测、启用或停用中转 API 生图。
- **设置**：设置或移除全局上下文，勾选强制显示被隐藏的官方模型。
- **版本**：左上角显示当前版本，有新版时列出更新内容，可一键更新。

背后沿用菜单的流程：写入前备份，失败自动还原；会产生费用或使用订阅额度的探测、生图检测与 Claude 测试，都会先列出内容再确认。排序、改名与修改上下文只写入模型目录，不重启路由器；修改输出、添加或删除模型会重启路由器。输出上限只对 Claude 模型有效（送往 Claude 的 `max_tokens`，或 Claude CLI 的 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`），GPT 与 Chat Completions 模型不送这个值，由上游决定。

管理页只监听 `127.0.0.1`，网址附带本次的访问令牌（请勿分享），并检查 Host 与 Origin、只接受 JSON 请求、启用 CSP。API Key 只写入钥匙圈或 DPAPI，不会回传到页面。1.27.5 起默认在后台运行，打开命令完成即退出；Windows 的 Codex 入口和开始菜单快捷方式不会留下 CMD／PowerShell 窗口。重复打开复用同一个管理页，请点击「结束管理页」关闭，或闲置 20 分钟后自动结束；`ui --foreground` 可保留终端诊断模式。常驻的路由器本身不提供网页。首次安装与回退仍在终端执行。

1.28.0 起界面支持简体中文、繁体中文与英文，默认跟随浏览器语言（都不符合时用英文），可在左下角切换并记住选择。安装器产生的操作记录与错误细节会在简体界面自动转成简体；英文界面会翻译常见错误，操作记录仍以中文显示。

## 升级

实验性的「[Claude CLI 订阅路由](docs/claude-cli-experimental.md)」可从主菜单第 7 项或 `claude-cli` 开启，1.27.0 起也可在网页管理界面的「新增供应商」或「新增模型」选择 Claude 订阅。缺少 CLI 或版本过旧时会先询问是否安装／更新，未登录时引导官方登录。

从 1.26.1 起，优先读取 Claude CLI 当前模型清单并以编号列出完整版本。输入 `1` 选一个、`1,3` 复选、`1-3` 选范围，也支持 `all`、完整模型 ID 及 `cancel` 返回。编号依当次清单排列，已添加的项目会标示；相同版本的别名会合并。

列清单不发送推理请求，只有选中的模型会做短测试并使用订阅用量。CLI 未提供可辨识清单时才使用备援候选，画面会标示来源；CLI 清单可能与 Claude 桌面版不同，也不代表所有项目均有可用额度。未列出的版本仍可输入完整 ID 测试。

真实订阅已通过短文字与一般工具往返测试，Chrome、生图、长对话及 Windows 订阅执行流程仍待验收。上下文上限是手动配置值，不代表已验证该容量；设置 1M 并保留 95% 可用比例时，Codex 显示约 950K。

1.26.5 起改善订阅路由的提示缓存：重播历史的结尾加上一个 1 小时缓存断点，CLI 自己的缓存也固定为 1 小时，下一轮可直接读取上一轮的历史。本机以假 API 模拟 4 轮、10 次请求，缓存命中率从约 37% 提高到约 85%；实际用量仍依对话内容与 Anthropic 计算方式而定。同版本起 Codex 工具说明完整送出，不再被 CLI 在 2,048 字符处截断。

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

## 版本信息与更新内容

安装器启动时会显示「已安装版本」、「目前这支安装器版本」与「GitHub 线上最新版本」。
若有更新，会按版本顺序列出从已安装版本到最新版之间的所有变更；若手上的安装器本身
已落后，也会先提示重新下载最新版，避免用旧脚本覆盖新安装。

版本资料来自 repo 根目录的 `releases.json`。检查逾时或离线时只会显示无法检查，
不会阻塞安装、添加模型、状态检查或回退流程，也不会上传任何本机设置。

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

> 回退前请先看「[回退之后，用过 Claude 模型的旧对话会坏掉](#回退之后用过-claude-模型的旧对话会坏掉)」。

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

## 功能

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

## 健康检查

macOS：

```bash
curl -s http://127.0.0.1:48953/healthz | python3 -m json.tool
```

Windows：

```powershell
Invoke-RestMethod http://127.0.0.1:48953/healthz | ConvertTo-Json -Depth 5
```

`failures` 应恒为 0。`statefulFallbacks` 或 `responseFailedSent` 持续增加代表上游有状况；
`statefulRebuilds` 与 `queuedResponses` 增加属正常。

`localPrewarms` 是本机完成的预热次数，打开或新建自定义模型任务时增加属正常；
`stalePrewarms` 与 `lastStalePrewarmModel` 记录打开仍绑定已删除模型的任务，见[疑难排解](#管理页出现-404-custom_model_not_configured)。

`oversizeRejects` 增加代表有请求因为太大而被路由器挡下来，没有送往上游。

`toolImagesOmitted` 与 `toolImageBytesSaved` 记录图片大小预算省下的旧工具截图与位元组；
`lastRequestBytesBeforeBudget` / `lastRequestBytesAfterBudget` 是最近一次自定义请求缩减前后的大小。
`imageArchiveFailures` 增加代表原图无法保存，这些图片会留在请求中，不会被悄悄丢掉。

`/healthz` 的 `historyCache` 显示快照笔数、序列化位元组总量、预算及过期时间，
不包含对话内容。此数字不是整个 Node.js 程序的实际内存占用量。

`imagesOmitted` 增加代表有图片在送出前被换成占位文字。单次请求超过 20 张图时，上游会把
每张图的尺寸上限从 8000 收紧到 2000 像素（iPhone 截图 942 x 2048 就会超过），因此路由器
把数量压在 20 张以内；启用 Claude 提示快取时，每跨过上限就整批省略最旧的 8 张，
否则只省略超出的张数。
单张任一边超过 8000 像素的也会被换掉。

`truncatedUpstreamStreams` 增加代表上游在送出终止事件前就把串流结束掉了（网关中断回应
最常见）。这种情况读取端只看到干净的 EOF、不是例外，所以路由器会补一个 `response.failed`
让客户端明确收尾，而不是无声断线。

`upstreamErrorsWithoutTerminal` 是上游只送了顶层 `error` 就结束串流的次数。Codex 会忽略
单独的 `error`，路由器因此用它的内容补上 `response.failed`。错误码会换成 Codex 认得的值：
上下文爆掉是 `context_length_exceeded`（不重试）、过载是 `server_is_overloaded`、
限流是 `rate_limit_exceeded`（上游给了 `retry-after` 就照着等）、额度用尽是 `insufficient_quota`。

`claudeRefusals` 记录 Claude 串流明确以 `stop_reason: refusal` 拒答的次数；Codex 会显示上游
提供的类别与原因。`claudeEmptyResponses` 记录上游宣告完成、却没有答案或工具呼叫的次数，
这只能确认回复为空，不能单靠它判定为拒答。`claudeCompactionFailures` 记录压缩时遭拒、
摘要为空或未完整生成的次数；这些回合以失败收尾，不会写入占位摘要取代原始历史。

`credentialReads` 是实际读取（Windows 为解密）API Key 的次数。Windows 以凭据档的修改时间
判断 Key 是否更换，文件没变就沿用快取，这个数字应该很少增加。每家供应商各自快取。

`providers` 列出每家供应商的名称、上游主机与模型数；`stats.lastProvider` 是最近一次自定义模型
请求送到哪一家，`stats.lastImageProvider` 是最近一次生图送到哪一家。

`chatTranslatedRequests` 是经 Chat Completions 转译送出的请求数。`chatPlaceholderToolResults` 是替
没有结果的工具呼叫补上 `(no output)` 的次数，`chatToolOutputsMerged` 与 `chatLateToolOutputs` 分别是
并回原结果、改成文字的后续工具输出数；同一段历史每送一次就再累加，增加本身不代表出错。

`foreignHostRejects` 是 Host 不是本机名称而被拒绝的请求数（DNS rebinding 会是这种样子）；
`browserRequestsRejected` 是浏览器网页对生图或 Ark 端点发起、被拒绝的请求数。
两者在正常使用下都应为 0。

`authProbeGraceUsed` 是 ChatGPT 验证探测失败（网路错误或 401/403 以外的状态），但同一组凭据
在宽限期内验证成功过而放行的次数。宽限期默认 24 小时，可用 `settings.json` 的
`authProbeGraceMs` 调整（毫秒，0 代表关闭），重启路由器后生效；401/403 一律拒绝。

`upstreamWebSocketFallbacks` 增加代表官方的上游 WebSocket 当下不通，已自动回退 HTTP，
功能不受影响。连续握手失败达门槛后 `upstreamWebSocketCooldowns` 会加一，路由器接着
一段时间内直接走 HTTP，不再每条新连线都重试；上游一旦恢复就立刻解除。

`claudeToolOutputsMerged` 是 Claude 转译时并回原结果的后续工具输出数，`claudeLateToolOutputs`
是改成文字的迟到输出数，`claudeToolResultsReordered` 是为了让工具结果排在最前面而调整的消息数。
这些值每次转译都会重新计算，同一段历史每送一次就再累加；增加本身不代表出错。

实际埠号以 `status` 印出的为准：48953 被占用时安装器会自动往后找。

## 疑难排解

### Claude 回合突然没有回复

更新到 1.25.2 以上后，明确的上游拒答会显示原因；没有标示拒答的空回复也会显示错误。
拒答时，移除或改写触发的内容后再试；若同一对话仍带着该内容，请改开新对话。单纯按「继续」
会再次送出相同历史。旧版若已把 `(compaction produced no summary)` 写进压缩历史，更新无法
自动还原那次已被取代的内容。

若安装时 Claude 模型被跳过，用诊断脚本确认是哪一类问题：

```bash
bash claude-probe-diag.sh <API_ROOT> <模型名>
```

```powershell
powershell -ExecutionPolicy Bypass -File .\claude-probe-diag.ps1 <API_ROOT> <模型名>
```

两个脚本都会以隐藏输入的方式询问 API Key，不会留在命令历史；macOS 版也可改用环境变数
`CODEX_ROUTER_API_KEY` 提供。它会分别检查模型是否在清单中、原生 `/v1/messages` 的实际
状态码与消息、以及 `/v1/responses` 对照组。上游暂时不可用（5xx）时重跑安装器即可加入。

`status` 会印出实际使用的 Node 与 Codex 执行档路径。Windows 上如果 Codex 桌面版升级后
换掉了自带执行档的版本目录，这两行会标示「文件已不存在」——重跑一次安装器即可修正。

路由器的 stderr 记录在 `<CODEX_HOME>/model-router/router.err.log`。服务启动时若发现
该档超过 5 MB 会就地清空（可用 `settings.json` 的 `maxLogBytes` 调整），因此长期
出错也不会把磁碟写满。

这个档是不带 BOM 的 UTF-8。Windows PowerShell 5.1 的 `Get-Content` 默认用系统
ANSI 代码页读档（跟主控台的 `chcp 65001` 无关），中文会整片变乱码，要明讲编码：

```powershell
Get-Content "$env:USERPROFILE\.codex\model-router\router.err.log" -Tail 50 -Encoding UTF8
```

### 某条对话一直失败，但新开的对话正常

长对话会累积大量历史图片。Codex 的压缩门槛按 token 计算，Base64 图片的传输大小却可能
先撞上 HTTP 请求上限。已观察到一条对话成功压缩后再累积 13 张工具截图，加上 5 张用户
图片就超过 32 MB；总共不到 20 张，原本的图片张数限制完全不会触发。

**1.18.2 起会自动缩减旧工具截图。** 自定义 GPT 与 Claude 路由在完成历史重建、格式转译后，
依实际送出的 JSON 大小处理；超过请求上限的 75% 时，从最旧的工具截图开始替换成原图路径。
默认上限仍是 32 MiB（消息显示为 MB），因此缩减目标为 24 MiB，保留后续工具往返的空间。
`settings.json` 的 `maxUpstreamRequestBytes` 可调整请求上限；数值须符合实际上游限制。

位元组预算会保留用户附件、文字与工具呼叫配对，至少留下最新四张工具截图，且最新一组
工具结果中的图片全部保留。省略前会把原图存到 `<CODEX_HOME>/model-router/history-images/`，
模型需要细节时可依路径重新读取。档名依内容去重，重试不会重复保存同一张图；路由器不会
自动删除封存图，也不改写 Codex 的对话历史。保存失败时保留原图。

一般回合、HTTP / WebSocket 与压缩请求都套用同一个预算，因此旧截图造成的 413 可以在
原对话重试。使用实际失败历史的离线重播，一般与压缩请求都由 32.63 MiB 降到 21.78 MiB，
移出四张旧工具截图；这是本机重建验证，未将该历史重新送往上游。

若用户附件、近期截图或文字本身就超限，仍会回 413 并说明原因，需要缩小图片、减少附件，
或把工作摘要带到新对话。压缩能否成功取决于缩减后的请求大小；不是所有 413 都只能开新对话。

### Claude 对话出现 each tool_use must have a single result

错误全文类似
``messages.60.content.1: each tool_use must have a single result. Found multiple `tool_result` blocks with id: toolu_...``。
通常是模型在 Code Mode 的 `exec` 里呼叫了 `notify()` 反馈进度：
Codex 会把每则通知记成同一个工具呼叫的额外输出，1.22.3 以前的 Claude 转译把每一笔都转成独立的
`tool_result`，上游因此拒收。之后每一轮都会重送同一段历史，连用 Claude 压缩也会失败，整条对话看起来就像卡死。

升级到 1.22.4 以上即可。路由器每次都会重新转译完整历史，原本卡住的对话不必压缩或新开就能继续；
`/healthz` 的 `claudeToolOutputsMerged` 大于 0 代表这类历史已被合并处理。

### 管理页出现 404 custom_model_not_configured

每个任务都会记住自己最后用的模型。模型从路由器删除后，任务的设置不会跟着改；
Codex 每次打开这类任务，都会先用记住的模型发一个预热请求。1.27.x 以前路由器会把它
记成 404，看起来像有人还在用已删除的模型，其实只是任务被打开，没有发往上游、不消耗用量。

1.28.0 起，这类预热改为静默完成，只在 `/healthz` 的 `stalePrewarms` 与
`lastStalePrewarmModel` 留下计数与最近一次的模型；在那个任务真的发出消息时才回 404，
错误会写出模型名称，也不再误记成主要供应商。在同一个任务的模型菜单改选现有模型再重发
即可，不必开新任务；不再需要的任务直接归档也可以。

### 选择器里看不到某个官方模型

1.22.0 起，重新启动 Codex 会向官方同步账号最新模型清单。先更新路由器并重开 Codex；
如果同步失败，会使用本地清单，可从 `/healthz` 的 `stats.lastCatalogSync` 查看状态。
若自行配置了 `model_catalog_json`，它仍会阻止远端同步；升级只移除本工具管理的固定目录。

用 `hidden-models` 命令即可——它会列出所有被标成隐藏的模型让你勾选，选中的会强制显示。
安装与重新配置不会询问这一项，但既有选择会原样沿用。也可以直接编辑 `settings.json` 的
`forceListedModels`（一组 slug 字串），重启路由器及 Codex 后合并时会套用。

强制显示只影响选择器。能不能用仍然由后端决定，账号没权限的话选了会在请求时失败。

管理隐藏模型不需要重新探测或重设任何自定义模型，直接执行：

```bash
bash codex-model-router.sh hidden-models
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 hidden-models
```

这个命令只会重新读取 Codex 的 bundled 模型目录，更新 `forceListedModels` 与
`models.json`，保留既有的 `custom/*` 模型；写入前会备份，完成后会验证目录并重启路由器。
它不需要 Base URL 或 API Key。选择时留空会保留目前设置，输入 `none` 才会全部恢复为隐藏。
执行完请完全退出并重新打开 Codex Desktop，模型选择器才会刷新。

### 需要看路由器实际送出去的内容

`settings.json` 设 `captureDir` 为一个目录路径，重启路由器后每一轮都会落地成文件：
送往上游的请求、转译后的 Anthropic 请求、上游回应与错误内文。WebSocket 与 HTTP 两条
路径都会撷取。

这些文件含有完整的对话内容，查完请自行删除，并把 `captureDir` 拿掉。

### 回退之后，用过 Claude 模型的旧对话会坏掉

症状是切回官方模型后，该对话每次都被挡下来：

```
Invalid 'input[60].id': 'cmp_PTzs...'. Expected an ID that contains letters,
numbers, underscores, or dashes, but this value contained additional characters.
```

（`cmp_` 也可能是 `msg_`、`fc_`、`rs_`。官方那句「contained additional
characters」讲得不准，那些 id 其实只有英数字和底线。）

原因是转译层会自铸项目 id：Anthropic 的原生事件没有 Codex 要的那些 id，本机转译时
只能自己生。这些项目留在 Codex 的对话历史里，而**路由器本来就会在把请求送往非
Anthropic 路由前，把它们改写或剥除掉**——健康检查的 `bridgeIdsStripped` 与
`bridgeCompactionRewritten` 数的就是这件事。

回退等于把这个清理层一起移掉，于是 Codex 会把原封不动的历史直接送给官方后端，然后
被拒。这不是回退没做干净——历史存在 Codex 那边，不在路由器管得到的范围。

两种解法：

- **重新安装路由器**，清理层回来，那条对话就能接着用；
- 或**开一条新对话**。用过 Claude 模型的旧对话，只要不装路由器就救不回来。

没用过 Claude 模型的对话不受影响。

## 需求

- 兼容 OpenAI 接口的供应商端点
- **macOS**：Codex Desktop
- **Windows**：Windows 10 1809 以上或 Windows 11、Codex 桌面版、Node.js v22.15 以上
  （路由器需要 `node:zlib` 的 zstd 支持；Codex 自带的 Node 也算数）

## 开发

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

### 测试

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

### CI

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

## 授权

MIT
