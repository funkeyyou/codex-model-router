# codex-model-router — Multi-model routing for Codex Desktop

[简体中文](README.md) · [繁體中文](README.zh-TW.md) · [English](README.en.md)

**Add Claude and third-party API models to the Codex Desktop model picker, alongside the official GPT models.** Works on macOS and Windows.

It is a small router that runs on your computer (a local LLM proxy). Official models still go straight to OpenAI; only the custom models you add are sent to the API you configure. Your Codex sign-in, existing chats, and official models are unaffected.

- **Supported APIs**: OpenAI Responses API, Anthropic Claude Messages API, and Chat Completions-only endpoints (DeepSeek, Qwen, GLM, Kimi, Gemini, Ollama, vLLM, and more; capabilities are probed during setup).
- **Multiple providers**: connect several at once; each API key is stored encrypted (macOS Keychain / Windows DPAPI).
- **Web manager**: add or remove models, manage providers and API keys, and update in one click from your browser.
- **Optional**: relay image generation and Claude Code subscription routing (experimental).

## Install

Before you start, you need:

- Codex Desktop (ChatGPT Desktop) signed in with a ChatGPT account
- Your provider's Base URL and API key
- macOS, or Windows 10 1809+ / Windows 11 (Node.js 22.15+ is required; the desktop app's bundled Node.js works, so you usually don't need to install it)

**macOS**: run in Terminal

```bash
curl -fsSL https://github.com/funkeyyou/codex-model-router/raw/refs/heads/main/codex-model-router.sh -o codex-model-router.sh && bash codex-model-router.sh
```

**Windows**: run in PowerShell

```powershell
curl.exe -fsSL https://github.com/funkeyyou/codex-model-router/raw/refs/heads/main/codex-model-router.ps1 -o codex-model-router.ps1; powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1
```

A menu appears first; press Enter to choose the default item 1 (install). The installer then asks for your Base URL, API key, and the models to add. API key input is hidden; paste it and press Enter. Selected models are tested with real API requests, which may incur small charges. Installer prompts are currently in Traditional Chinese; the web manager is available in English.

For a pinned version, download the installers and `SHA256SUMS` from [Releases](https://github.com/funkeyyou/codex-model-router/releases).

Restart Codex afterwards and the new models appear in the model picker:

<img src="docs/images/codex-model-picker.png" alt="Codex Desktop model picker showing official GPT models alongside custom GPT and Claude models from multiple providers" width="420">

*An actual model picker example. Prefixes and available models depend on your providers and account; these models are not bundled with the installer.*

## Usage

Most tasks can be done in the web manager. Open it from any of:

- the "自訂模型管理" (custom model management) entry in Codex, which appears after restarting Codex once
- the "Codex 模型路由器" shortcut (Start menu on Windows, `~/Applications` on macOS)
- the `ui` command

You can also run commands from the folder containing the installer: `bash codex-model-router.sh <command>` on macOS, or `powershell -ExecutionPolicy Bypass -File .\codex-model-router.ps1 <command>` on Windows. Run it without a command to get the menu.

| Command | What it does |
| --- | --- |
| `ui` | Open the web manager |
| `update` | Upgrade, keeping all settings |
| `add`, `remove` | Add or remove custom models |
| `providers` | Add or remove providers, change API keys |
| `imagegen` | Configure relay image generation |
| `repair-models` | Fix stale or removed models in the picker |
| `status` | Check installation and service status |
| `rollback` | Remove the router |

## Update and uninstall

**Update**: use the version menu at the top left of the web manager, or rerun the install command above and enter `3` ("更新到最新版本", same as `update`). Your Base URL, API keys, and models are kept; a failed update is rolled back automatically.

**Uninstall**: run `rollback`. Chats that used Claude models may stop working with official models afterwards, so start a new chat for them ([details in Chinese](docs/troubleshooting.zh-TW.md#回退之後用過-claude-模型的舊對話會壞掉)).

## Limits

- Provider API usage is billed by your provider. This tool doesn't supply credits or unlock features your account lacks.
- Claude and Chat Completions models can use terminal, file editing, MCP, and other function tools (Chat Completions needs upstream tool-call support), but not OpenAI-hosted tools such as native web search or image generation. Use the relay image skill for images.
- Unofficial community project, not affiliated with OpenAI or Anthropic.

## More docs

- [More details in English](docs/guide.en.md): web manager, providers, updates, Claude subscription routing
- Complete reference in Chinese: [简体中文](docs/guide.md) · [繁體中文](docs/guide.zh-TW.md)
- Troubleshooting and health checks in Chinese: [简体中文](docs/troubleshooting.md) · [繁體中文](docs/troubleshooting.zh-TW.md)
- [Releases and changelogs](https://github.com/funkeyyou/codex-model-router/releases)

When [reporting an issue](https://github.com/funkeyyou/codex-model-router/issues), include your OS, desktop/CLI version, router version, and redacted error output. Do not include API keys or login tokens.

## License

MIT
