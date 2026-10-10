# 疑难排解与健康检查

[简体中文](troubleshooting.md) · [繁體中文](troubleshooting.zh-TW.md) · [返回 README](../README.md) · [完整使用说明](guide.md)

先运行 `status` 确认安装与服务状态，再查找下面对应的症状。反馈问题时请附上操作系统、桌面版版本、路由器版本，以及去除 API Key 后的错误信息。

**目录**

- [模型菜单显示旧名称或已删除的模型](#模型菜单显示旧名称或已删除的模型)
- [Claude 回合突然没有回复](#claude-回合突然没有回复)
- [某条对话一直失败，但新开的对话正常](#某条对话一直失败但新开的对话正常)
- [Claude 对话出现 each tool_use must have a single result](#claude-对话出现-each-tool_use-must-have-a-single-result)
- [管理页出现 404 custom_model_not_configured](#管理页出现-404-custom_model_not_configured)
- [选择器里看不到某个官方模型](#选择器里看不到某个官方模型)
- [需要看路由器实际送出去的内容](#需要看路由器实际送出去的内容)
- [回退之后，用过 Claude 模型的旧对话会坏掉](#回退之后用过-claude-模型的旧对话会坏掉)
- [健康检查](#健康检查)

## 模型菜单显示旧名称或已删除的模型

从 1.27.8 起，可在网页管理页总览点击「同步與修復模型清單」，或运行 `bash codex-model-router.sh repair-models`（Windows：`powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 repair-models`）。这会备份并清除可重建的模型列表缓存，校验名称、可见性及默认模型，不发送模型推理请求。只有旧路由能证明同一供应商、同一上游模型的唯一对应时才迁移默认 ID，否则清除失效默认。完成后重新展开模型菜单；界面仍未刷新时，请完全退出桌面版再打开（macOS 用 ⌘Q，关闭窗口不等于退出）。已有任务保存的模型选择需要手动重选。

## Claude 回合突然没有回复

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

## 某条对话一直失败，但新开的对话正常

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

## Claude 对话出现 each tool_use must have a single result

错误全文类似
``messages.60.content.1: each tool_use must have a single result. Found multiple `tool_result` blocks with id: toolu_...``。
通常是模型在 Code Mode 的 `exec` 里呼叫了 `notify()` 反馈进度：
Codex 会把每则通知记成同一个工具呼叫的额外输出，1.22.3 以前的 Claude 转译把每一笔都转成独立的
`tool_result`，上游因此拒收。之后每一轮都会重送同一段历史，连用 Claude 压缩也会失败，整条对话看起来就像卡死。

升级到 1.22.4 以上即可。路由器每次都会重新转译完整历史，原本卡住的对话不必压缩或新开就能继续；
`/healthz` 的 `claudeToolOutputsMerged` 大于 0 代表这类历史已被合并处理。

## 管理页出现 404 custom_model_not_configured

每个任务都会记住自己最后用的模型。模型从路由器删除后，任务的设置不会跟着改；
Codex 每次打开这类任务，都会先用记住的模型发一个预热请求。1.27.x 以前路由器会把它
记成 404，看起来像有人还在用已删除的模型，其实只是任务被打开，没有发往上游、不消耗用量。

1.28.0 起，这类预热改为静默完成，只在 `/healthz` 的 `stalePrewarms` 与
`lastStalePrewarmModel` 留下计数与最近一次的模型；在那个任务真的发出消息时才回 404，
错误会写出模型名称，也不再误记成主要供应商。在同一个任务的模型菜单改选现有模型再重发
即可，不必开新任务；不再需要的任务直接归档也可以。

## 选择器里看不到某个官方模型

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

## 需要看路由器实际送出去的内容

`settings.json` 设 `captureDir` 为一个目录路径，重启路由器后每一轮都会落地成文件：
送往上游的请求、转译后的 Anthropic 请求、上游回应与错误内文。WebSocket 与 HTTP 两条
路径都会撷取。

这些文件含有完整的对话内容，查完请自行删除，并把 `captureDir` 拿掉。

## 回退之后，用过 Claude 模型的旧对话会坏掉

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
