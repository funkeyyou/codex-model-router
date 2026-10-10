# More details

[简体中文](guide.md) · [繁體中文](guide.zh-TW.md) · [English](guide.en.md) · [Back to README](../README.en.md)

Quick install and everyday commands are in the [README](../README.en.md). The complete reference, including troubleshooting and health-check fields, is in Chinese: [简体中文](guide.md) · [繁體中文](guide.zh-TW.md).

**Contents**

- [What it does](#what-it-does)
- [Requirements and limits](#requirements-and-limits)
- [Web manager](#web-manager)
- [Manage models and providers](#manage-models-and-providers)
- [Update and rollback](#update-and-rollback)
- [Claude Code subscription routing (experimental)](#claude-code-subscription-routing-experimental)
- [Model picker shows stale or removed models](#model-picker-shows-stale-or-removed-models)
- [Development and help](#development-and-help)

## What it does

A local model router for macOS and Windows. Add your own API providers to the Codex model picker, keep their API keys separate, and switch models without repeatedly changing the global provider configuration.

- Keeps official ChatGPT model requests going to OpenAI; selected custom models use your configured API endpoint.
- Supports OpenAI Responses API endpoints, translates Claude Messages, and probes Chat Completions as a fallback for compatible models.
- Manages multiple providers, API keys, model discovery, model removal, and provider-scoped routing IDs.
- Answers the warm-up request Codex sends when you open or create a chat locally for custom models, so it no longer becomes an extra paid generation (since v1.28.0). Chats still set to a deleted model stay quiet until you send a message, then name the model to replace.
- Provides interactive macOS and Windows installers, backups during updates, and rollback.
- Includes a local [web manager](#web-manager) for models, providers, the Claude subscription, image generation, settings, and one-click updates.
- Optionally installs a separate relay image-generation skill using your provider's supported image models.

Chat Completions support can be useful for compatible DeepSeek, Qwen, GLM, Kimi, Gemini, Ollama, or vLLM endpoints. Availability and tool support depend on the endpoint and the model; installation probes capabilities rather than assuming support.

## Requirements and limits

You need Codex Desktop / ChatGPT Desktop, a Codex login using a ChatGPT account, and your provider's Base URL and API key. The installer requires Node.js 22.15 or newer and can use the desktop app's bundled Node.js when available.

Provider API usage is billed by the provider. This tool does not supply credits, a Claude subscription, or access to account-restricted native tools. It is an unofficial community project, not affiliated with OpenAI or Anthropic.

Tool and attachment support varies. Claude and Chat Completions translation cannot execute OpenAI-hosted tools such as native web search or native image generation. The optional relay image skill is a separate capability. See the [full compatibility reference in Chinese](guide.md#工具可用性与兼容范围).

## Web manager

Since v1.27.0, menu item 2 or the `ui` command opens a local management page in your browser:

```bash
bash codex-model-router.sh ui
```

After installing or updating, the installer keeps a copy of itself in the router directory and creates a "Codex 模型路由器" shortcut (`~/Applications` on macOS, the Start menu on Windows), so you can reopen the page without finding the downloaded installer.

Since v1.27.5, installation and updates add "自訂模型管理" (custom model management) as a global Codex entry. Restart Codex once to load it, then click the entry to open the local manager in your browser. No repository checkout or project Actions setup is required. It uses the officially supported [MCP Apps global extensions](https://developers.openai.com/plugins/build/extensions#sidebar-apps) and requires a desktop version that supports MCP Apps; placement in the header or sidebar depends on the client version. Opening it makes no model inference request and uses no provider quota. Run `ui-setup` to repair the entry without restarting the router.

This local MCP exposes only an "open manager" tool, with no configuration writes or API-key access. Management stays in the existing local web page. The installer manages only its own `mcp_servers.model_router_manager` entry; conflicting user configurations are preserved with a warning, and other MCP servers remain unchanged. Rollback removes the entry only while it is still managed by the router.

Git projects may also use the optional [Actions configuration](../.codex/environments/environment.toml). Its visibility depends on Codex's project environment support; it is not the general entry point.

- **Overview**: router status, request counts, recent errors with diagnostic IDs, and the runtime environment.
- **Models**: drag to reorder; edit display names, context and output limits; remove models. When adding models you can pick an API provider or the Claude subscription. New models default to a 1,000,000-token context and 128,000-token output, capped by any smaller limit the upstream reports.
- **Providers**: add an OpenAI-compatible API or a Claude subscription (Claude CLI), change API keys, and remove providers. The Claude subscription path checks the CLI installation, version, and subscription sign-in in order, and lets you fix each step in place. Since v1.28.0 you can edit a provider's display name and model prefix: the name is display-only, so the internal ID, existing chats, and API key stay the same; the prefix sets "prefix/model" in the picker, replaces an upstream prefix such as `ark/`, changes only auto-generated names (manual renames are kept), and also applies to models added later. Changes are previewed first and don't restart the router. For the Claude subscription, only the prefix can be changed for now.
- **Image generation**: detect, enable, or disable relay image generation.
- **Settings**: set or remove the global context window, and force-show official models hidden by Codex's bundled catalog.
- **Version**: shows the current version, lists changes when a new release exists, and updates in one click.

It uses the same backup-and-restore flows as the menu. Probes that cost money or subscription quota are listed and confirmed first. Reordering, renaming, and context changes only rewrite the model catalog; output changes and adding or removing models restart the router. Output limits apply only to Claude models (Claude's `max_tokens`, or `CLAUDE_CODE_MAX_OUTPUT_TOKENS` for Claude CLI); GPT and Chat Completions routes leave output length to the upstream.

The page listens only on `127.0.0.1`. Its URL carries this session's access token (do not share it), and it checks Host and Origin, accepts only JSON requests, and sets a strict CSP. API keys go only to the macOS Keychain or Windows DPAPI and are never sent back to the page. Since v1.27.5, it runs in the background and the launch command exits once it is ready; Windows Codex entries and Start menu shortcuts leave no CMD or PowerShell window. Repeated launches reuse the same manager. Use "Quit manager" to close it, or let it exit after 20 idle minutes; `ui --foreground` retains terminal diagnostics. The background router serves no web pages. First-time installation and rollback still run in the terminal.

Since v1.28.0 the page is available in English, Simplified Chinese, and Traditional Chinese. It follows your browser language (English when none of them matches) and can be switched at the bottom left; the choice is remembered. Common errors are translated in English, while operation logs from the installer stay in Chinese (they're converted automatically in the Simplified Chinese interface).

## Manage models and providers

Run these commands from the directory containing the downloaded installer:

```bash
bash codex-model-router.sh ui                 # Open the web manager
bash codex-model-router.sh add                # Add custom models
bash codex-model-router.sh remove             # Remove custom models
bash codex-model-router.sh providers add      # Add an API provider
bash codex-model-router.sh providers key      # Change a provider's API key
bash codex-model-router.sh providers remove   # Remove a provider and its models
bash codex-model-router.sh imagegen           # Configure relay image generation
bash codex-model-router.sh status             # Check installation and service status
```

On Windows, replace `bash codex-model-router.sh` with `powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1`.

Models that already have a prefix, such as `ark/model-name`, keep that name when newly added. Provider-specific internal IDs keep different providers' credentials separate even if their model display names match.

Since v1.29.4, you can add Claude models with the official `https://api.anthropic.com` Base URL: requests to it authenticate with `x-api-key` and `anthropic-version` and never send the key as Bearer. Relays keep Bearer authentication, and native Claude `/messages` requests always include `anthropic-version`.

## Update and rollback

Download the latest installer with the [install command](../README.en.md#install), then select the update option (menu item 3), or run:

```bash
bash codex-model-router.sh update
```

Updates preserve configured providers and models and back up managed files. A failed update attempts to restore the prior installation and restart the service.

Since v1.27.0 you can also update from the version menu in the web manager. It downloads the new installer from GitHub Releases, verifies it against `SHA256SUMS`, and runs the same `update`; on macOS it can restart ChatGPT afterwards.

Since v1.27.3, updates hand off to the new manager automatically, keeping the URL and operation log even if the browser stops polling. An independent process restarts the desktop app and checks that it is running afterwards. See `manager-worker.log` in the router directory for handoff or restart errors. When upgrading from v1.27.0–1.27.2, run the new installer's `update` and `ui` commands to reopen the manager; the old page cannot apply this fix to itself.

To remove the router configuration:

```bash
bash codex-model-router.sh rollback
```

**Before rollback:** conversations containing translated Claude history may no longer work with the official backend once the router is removed. Start a new conversation after rollback, or keep the router for those existing conversations. Read the [rollback details](troubleshooting.zh-TW.md#回退之後用過-claude-模型的舊對話會壞掉) first.

## Claude Code subscription routing (experimental)

Experimental [Claude CLI subscription routing](claude-cli-experimental.md) is available through menu item 7 or the `claude-cli` command, and since v1.27.0 also from Add provider or Add model in the [web manager](#web-manager). It asks before installing or updating Claude Code and guides subscription sign-in when needed.

Since v1.26.1, the installer reads the CLI's current model list first and shows numbered entries with full model IDs. Enter `1`, `1,3`, `1-3`, or `all`; you can also enter an explicit model ID or `cancel`. Numbers follow the current list order. Aliases resolving to the same version are deduplicated, and previously configured models remain listed.

Listing models sends no inference request. Only selected models are tested, using subscription quota. If discovery fails, the installer clearly labels its built-in fallback candidates. The CLI list may differ from Claude Desktop and does not guarantee available quota for every model; unlisted versions can still be tested by explicit ID.

Short text and tool roundtrips passed with a live subscription on macOS; Chrome, image generation, long conversations and Windows subscription execution still need validation. Context limits are manual settings, not verified capacities: a 1M setting with the retained 95% usable ratio appears as about 950K in Codex.

Since v1.26.5, the replayed history ends with a one-hour prompt-cache breakpoint and the CLI's own cache TTL is pinned to one hour, so each turn can read the previous turn's history from cache. In a local fake-API simulation of 4 turns and 10 requests, the cache hit rate rose from about 37% to about 85%; real usage still depends on the conversation and Anthropic's accounting. Codex tool descriptions are now sent in full instead of being truncated by the CLI at 2,048 characters. Developer messages that Codex adds mid-conversation stay in place, marked with `<system-reminder>`, instead of rewriting the system prompt.

Since v1.26.6, Claude routes add a fixed note at the end of the system prompt that maps Codex's GPT-specific `commentary` and `final` channels to Claude's text output and asks for Claude Code-style progress updates, so Claude no longer runs through tool calls in silence. The CLI route requests summarized thinking (`--thinking-display summarized`; billing is unchanged), and translated routes label the last text of a turn without tool calls as `final_answer` instead of `commentary`.

Since v1.29.0, Claude subscription Opus models offer a Fast toggle in the Codex picker, mapped to Claude Code fast mode: faster output, billed to your Claude usage credits instead of the subscription allowance. If credits are off or the plan or model is ineligible, the CLI falls back to standard speed; check `claudeCliFastRequests`, `lastClaudeCliFastState` (`on` means it took effect) and `lastClaudeCliFastDisabledReason` in `/healthz`. Sonnet, Haiku and other custom models do not show Fast; switching mid-task may rebuild the prompt cache once.

## Model picker shows stale or removed models

If the picker shows stale names or removed models, v1.27.8 adds **Sync and repair model list** in the web manager overview (`同步與修復模型清單`), or run `bash codex-model-router.sh repair-models` (Windows: `powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 repair-models`). It backs up and invalidates the rebuildable model cache, checks names and visibility, and repairs invalid custom defaults without inference requests. Migration requires an unambiguous old route with the same provider and upstream model; otherwise the invalid default is cleared. Reopen the picker afterward. If the UI remains stale, fully quit and reopen Desktop (⌘Q on macOS). Existing tasks may still need their saved model selection changed manually.

## Development and help

Source files live in `src/`; the single-file installers are generated with `node tools/build.mjs`. Run `npm ci` and `npm run check` for build consistency, lint, and tests.

For troubleshooting, advanced settings, and architecture, see the Chinese [guide](guide.md) and [troubleshooting](troubleshooting.md) pages. When [reporting an issue](https://github.com/funkeyyou/codex-model-router/issues), include your OS, desktop/CLI version, router version, and redacted error output. Do not include API keys or login tokens.
