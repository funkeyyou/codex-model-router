import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadRouterInDir, loadPayloads } from "./helpers/payloads.mjs";
import { desktopRoutes, desktopModels, desktopRoute, desktopHeaders, newDesktopConfig,
  desktopUsageObserver, desktopUsageEvent, connectDesktop, restoreDesktop, integrationStatus,
  desktopDirectories, desktopLifecycle } from "../src/claude-desktop.mjs";

const a = { pickerSlug: "custom/relay-claude-opus", upstreamModel: "ark/claude-opus-5-5", translate: "anthropic",
  providerId: "a", displayName: "Relay Opus", contextWindow: 1000000 };
const b = { ...a, pickerSlug: "custom/other-claude-opus", providerId: "b" };
const settings = { providers: [{ id: "a", apiRoot: "https://relay.example/v1" }, { id: "b", apiRoot: "https://api.anthropic.com/v1" }],
  routes: [a, b, { ...a, pickerSlug: "custom/cli", transport: "claude-cli" },
    { ...a, pickerSlug: "custom/gpt", upstreamModel: "gpt-6" }, { ...a, pickerSlug: "custom/deleted", providerId: "gone" }] };

test("Desktop model catalog excludes CLI, GPT and orphan providers; ambiguous upstream IDs fail closed", () => {
  assert.deepEqual(desktopRoutes(settings), [a, b]);
  const catalog = desktopModels(settings);
  assert.equal(catalog.data[0].anthropic_family_tier, "opus");
  assert.equal(catalog.data[0].is_family_default, true);
  assert.equal(catalog.data[1].is_family_default, false);
  assert.equal(catalog.data[0].supports_1m, undefined);
  assert.equal(desktopRoute(settings, a.pickerSlug), a);
  assert.throws(() => desktopRoute(settings, a.upstreamModel), { status: 404 });
  assert.throws(() => desktopRoute(settings, "custom/cli"), { status: 404 });
  assert.deepEqual(desktopModels({}).data, []);
});

test("Native headers preserve Anthropic version/beta without forwarding client credentials", () => {
  const incoming = { authorization: "Bearer local-secret", "x-api-key": "local-secret", cookie: "private",
    "chatgpt-account-id": "private", "anthropic-version": "2023-06-01", "anthropic-beta": "test-beta" };
  const official = desktopHeaders(incoming, "upstream-key", "https://api.anthropic.com/v1/messages/count_tokens");
  assert.equal(official.get("x-api-key"), "upstream-key");
  assert.equal(official.get("authorization"), null);
  const relay = desktopHeaders(incoming, "relay-key", "https://relay.example/v1/messages");
  assert.equal(relay.get("authorization"), "Bearer relay-key");
  for (const headers of [official, relay]) {
    assert.equal(headers.get("anthropic-beta"), "test-beta");
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("chatgpt-account-id"), null);
    assert.ok(!JSON.stringify([...headers]).includes("local-secret"));
  }
});

const sse = (event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
const events = [
  { type: "message_start", message: { id: "msg_native", type: "message", role: "assistant", model: a.upstreamModel,
    content: [], usage: { input_tokens: 10, cache_read_input_tokens: 400, cache_creation_input_tokens: 20, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private thinking" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-signature" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_1", name: "lookup", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"hello"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
  { type: "message_stop" },
];

test("Usage observer handles split UTF-8/CRLF and huge tool frames, preserving cache counters", () => {
  const observer = desktopUsageObserver();
  const bytes = Buffer.from(sse(events[0]) + sse({ type: "content_block_delta", delta: { text: "繁體".repeat(50000) } })
    + events.slice(1).map(sse).join(""));
  for (let offset = 0; offset < bytes.length; offset += 31) observer.push(bytes.subarray(offset, offset + 31));
  const result = observer.result();
  assert.equal(result.status, "completed");
  const usage = desktopUsageEvent(result, a.upstreamModel).response.usage;
  assert.equal(usage.input_tokens, 430);
  assert.deepEqual(usage.input_tokens_details, { cached_tokens: 400, cache_write_tokens: 20 });
  assert.equal(usage.output_tokens, 7);
  const partial = desktopUsageObserver();
  partial.push(Buffer.from(sse(events[0])));
  assert.equal(partial.result().status, "failed");
});

async function start(t, upstreamHandler) {
  const oldKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-upstream-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = oldKey;
  });
  const { router, dir } = await loadRouterInDir(settings);
  const config = newDesktopConfig();
  const configPath = join(dir, "claude-desktop.json");
  writeFileSync(configPath, JSON.stringify(config));
  const fetchOriginal = globalThis.fetch;
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    seen.push({ url: String(url), options });
    return upstreamHandler ? upstreamHandler(url, options, seen.length) : Response.json({ type: "message", content: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  });
  router.routerServer.listen(0, "127.0.0.1");
  await once(router.routerServer, "listening");
  t.after(() => new Promise((resolve) => { router.routerServer.closeAllConnections(); router.routerServer.close(resolve); }));
  const base = `http://127.0.0.1:${router.routerServer.address().port}`;
  const call = (path, options = {}) => fetchOriginal(base + path, { ...options,
    headers: { "x-api-key": config.token, ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers } });
  return { dir, config, configPath, seen, call };
}

test("Desktop ingress authenticates Electron metadata without enabling cross-origin browser access or leaking keys", async (t) => {
  const { call, seen, config, configPath } = await start(t);
  assert.equal((await call("/claude/v1/models", { headers: { "x-api-key": "wrong" } })).status, 401);
  for (const fetchSite of ["none", "cross-site", "same-origin"]) {
    const response = await call("/claude/v1/models", { headers: { origin: "null", "sec-fetch-site": fetchSite } });
    assert.equal(response.status, 200, fetchSite);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.equal((await call("/claude/v1/models", { headers: { origin: "http://evil.example", "x-api-key": "" } })).status, 401);
  const preflight = await call("/claude/v1/models", { method: "OPTIONS", headers: { origin: "http://evil.example", "x-api-key": "",
    "access-control-request-headers": "authorization" } });
  assert.equal(preflight.status, 401);
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
  const models = await (await call("/claude/v1/models")).json();
  assert.deepEqual(models.data.map((model) => model.id), [a.pickerSlug, b.pickerSlug]);
  assert.equal((await call("/claude/v1/models", { headers: { "x-api-key": "", authorization: `Bearer ${config.token}` } })).status, 200);
  assert.equal((await call("/v1/models")).status, 403);
  assert.equal((await call("/v1/responses", { method: "POST", body: '{}' })).status, 403);
  writeFileSync(configPath, JSON.stringify({ enabled: false }));
  assert.equal((await call("/claude/v1/models")).status, 401);
  writeFileSync(configPath, "broken");
  assert.equal((await call("/claude/v1/models")).status, 401);
  assert.equal(seen.length, 0);
});

test("Native tool history, thinking, images and cache hints pass unchanged; stream and usage are preserved", async (t) => {
  const raw = events.map(sse).join("");
  const { call, seen, dir, config } = await start(t, () => new Response(raw, { headers: { "content-type": "text/event-stream" } }));
  const body = { model: a.pickerSlug, stream: true, max_tokens: 1024, thinking: { type: "adaptive" },
    system: [{ type: "text", text: "private system", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "lookup", input_schema: { type: "object", properties: { query: { type: "string" } } }, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "fixture" } }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "history", signature: "signature" }, { type: "tool_use", id: "call", name: "lookup", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "result", cache_control: { type: "ephemeral" } }] }] };
  const response = await call("/claude/v1/messages", { method: "POST", headers: { "anthropic-beta": "beta-fixture" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), raw);
  assert.equal(seen[0].url, "https://relay.example/v1/messages");
  assert.deepEqual(JSON.parse(seen[0].options.body.toString()), { ...body, model: a.upstreamModel });
  assert.equal(seen[0].options.headers.get("anthropic-beta"), "beta-fixture");
  assert.equal(seen[0].options.headers.get("authorization"), "Bearer fixture-upstream-key");
  const usageText = readFileSync(join(dir, "usage.jsonl"), "utf8");
  for (const secret of [config.token, "private system", "private thinking", "opaque-signature"]) assert.ok(!usageText.includes(secret));
  const usage = JSON.parse(usageText);
  assert.equal(usage.transport, "claude-desktop");
  assert.equal(usage.provider, "a");
  assert.equal(usage.status, "completed");
  assert.deepEqual([usage.input, usage.cached, usage.cacheWrite, usage.output], [430, 400, 20, 7]);
});

test("Official Anthropic JSON and token counting use the selected provider, not the primary relay", async (t) => {
  const { call, seen, dir } = await start(t, (url) => String(url).endsWith("count_tokens")
    ? Response.json({ input_tokens: 83 })
    : Response.json({ type: "message", content: [{ type: "text", text: "hello" }], stop_reason: "max_tokens", usage: { input_tokens: 2, output_tokens: 5 } }));
  const body = JSON.stringify({ model: b.pickerSlug, messages: [{ role: "user", content: "hi" }] });
  assert.equal((await (await call("/claude/v1/messages/count_tokens", { method: "POST", body })).json()).input_tokens, 83);
  assert.equal(existsSync(join(dir, "usage.jsonl")), false);
  const json = await (await call("/claude/v1/messages", { method: "POST", body })).json();
  assert.equal(json.content[0].text, "hello");
  assert.equal(seen[0].url, "https://api.anthropic.com/v1/messages/count_tokens");
  assert.equal(seen[0].options.headers.get("x-api-key"), "fixture-upstream-key");
  assert.equal(JSON.parse(readFileSync(join(dir, "usage.jsonl"))).status, "incomplete");
});

test("Truncated native SSE reports failure and preserves partial usage instead of marking EOF successful", async (t) => {
  const { call, dir } = await start(t, () => new Response(sse(events[0]), { headers: { "content-type": "text/event-stream" } }));
  const text = await (await call("/claude/v1/messages", { method: "POST", body: JSON.stringify({ model: a.pickerSlug, stream: true }) })).text();
  assert.match(text, /event: error/);
  const usage = JSON.parse(readFileSync(join(dir, "usage.jsonl")));
  assert.equal(usage.status, "failed");
  assert.equal(usage.cached, 400);
});

test("Unsupported models, bad JSON and upstream redirects never fall back to official routes", async (t) => {
  const { call, seen } = await start(t, () => new Response(null, { status: 302, headers: { location: "https://untrusted.example" } }));
  assert.equal((await call("/claude/v1/messages", { method: "POST", body: "{" })).status, 400);
  assert.equal((await call("/claude/v1/messages", { method: "POST", body: JSON.stringify({ model: "gpt-6" }) })).status, 404);
  assert.equal(seen.length, 0);
  assert.equal((await call("/claude/v1/messages", { method: "POST", body: JSON.stringify({ model: a.pickerSlug }) })).status, 502);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].options.redirect, "manual");
});

test("Native request uses backup key on 429 and retains beta/cache payload", async (t) => {
  const { call, dir, seen } = await start(t, (_url, _options, attempt) => attempt === 1
    ? new Response("rate limited", { status: 429 }) : Response.json({ type: "message", content: [], stop_reason: "end_turn", usage: {} }));
  writeFileSync(join(dir, "key-pool.json"), JSON.stringify({ providers: { a: [{ id: "backup1", keychainService: "fixture.backup", keychainAccount: "codex" }] } }));
  const response = await call("/claude/v1/messages", { method: "POST", headers: { "anthropic-beta": "native-beta" },
    body: JSON.stringify({ model: a.pickerSlug, system: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }) });
  assert.equal(response.status, 200);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].options.headers.get("authorization"), "Bearer fixture-upstream-key-backup1");
  assert.equal(seen[1].options.headers.get("anthropic-beta"), "native-beta");
  assert.deepEqual(seen[1].options.body, seen[0].options.body);
});

test("Manager enable/status/disable preserves accounts and routes, hides token by default, and backs up before revoking", async () => {
  const { dir } = await loadPayloads();
  const root = mkdtempSync(join(tmpdir(), "desktop-manager-test-"));
  const runtime = join(root, "model-router");
  mkdirSync(runtime);
  const source = JSON.stringify({ ...settings, port: 48953 });
  writeFileSync(join(runtime, "settings.json"), source);
  const configPath = join(runtime, "claude-desktop.json");
  const run = async (operation, ready = true) => {
    const code = `globalThis.fetch = async () => Response.json({status:'ok', claudeDesktopGateway:${ready}});
      console.log = () => {};
      const installer = await import(${JSON.stringify(pathToFileURL(join(dir, "installer.mjs")).href)});
      process.stdout.write(JSON.stringify(await ${operation}));`;
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, CODEX_MODEL_ROUTER_IMPORT_ONLY: "1", CODEX_MODEL_ROUTER_HOME: runtime, CODEX_HOME: root,
        CODEX_MODEL_ROUTER_SCRIPT_PATH: fileURLToPath(new URL("../codex-model-router.sh", import.meta.url)) },
    });
    return JSON.parse(result.stdout);
  };
  await assert.rejects(run("installer.managerSetClaudeDesktop({enabled:true})", false));
  assert.equal(existsSync(configPath), false);
  await run("installer.managerSetClaudeDesktop({enabled:true})");
  const first = JSON.parse(readFileSync(configPath));
  assert.match(first.token, /^cmr-claude-/);
  const status = await run("installer.managerClaudeDesktop()");
  assert.equal(status.enabled, true);
  assert.ok(!JSON.stringify(status).includes(first.token));
  const connection = await run("installer.managerClaudeDesktop({connection:true})");
  assert.equal(connection.connection.inferenceGatewayApiKey, first.token);
  assert.equal(connection.connection.inferenceGatewayBaseUrl, "http://127.0.0.1:48953/claude");
  await run("installer.managerSetClaudeDesktop({enabled:false})", false);
  assert.equal(JSON.parse(readFileSync(configPath)).enabled, false);
  assert.ok(!readFileSync(configPath, "utf8").includes(first.token));
  const backups = join(root, "backups", "model-router");
  const backup = readdirSync(backups).find((name) => name.startsWith("claude-desktop-"));
  assert.equal(JSON.parse(readFileSync(join(backups, backup, "claude-desktop.json"))).token, first.token);
  await run("installer.managerSetClaudeDesktop({enabled:true})");
  assert.notEqual(JSON.parse(readFileSync(configPath)).token, first.token);
  assert.equal(readFileSync(join(runtime, "settings.json"), "utf8"), source);
  assert.equal(existsSync(join(root, "auth.json")), false);
  assert.equal(existsSync(join(root, "config.toml")), false);
  if (process.platform !== "win32") assert.equal(statSync(configPath).mode & 0o777, 0o600);
});

test("Disconnected client aborts upstream streaming without replaying the request", async (t) => {
  let signal, cancelled = false;
  const { call, seen } = await start(t, (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(sse(events[0])));
        signal.addEventListener("abort", () => { cancelled = true; controller.error(new Error("aborted")); }, { once: true });
      },
    }), { headers: { "content-type": "text/event-stream" } });
  });
  const response = await call("/claude/v1/messages", { method: "POST", body: JSON.stringify({ model: a.pickerSlug, stream: true }) });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  for (let attempt = 0; attempt < 100 && !cancelled; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
  assert.equal(seen.length, 1);
});

function integrationFixture() {
  const root = mkdtempSync(join(tmpdir(), "desktop-integration-test-"));
  const directory = join(root, "Claude-3p");
  mkdirSync(join(directory, "configLibrary"), { recursive: true });
  const modePath = join(directory, "claude_desktop_config.json");
  const metaPath = join(directory, "configLibrary", "_meta.json");
  const originalId = "b705cccf-dc9c-4df4-a4a7-7b4d90c3159a";
  const originalMode = { deploymentMode: "1p", mcpServers: { example: { command: "fixture" } }, preferences: { theme: "dark" } };
  const originalMeta = { appliedId: originalId, entries: [{ id: originalId, name: "Original" }], hybridPointer: { bootstrapUrl: "https://organization.example" } };
  writeFileSync(modePath, encodedFixture(originalMode));
  writeFileSync(metaPath, encodedFixture(originalMeta));
  const calls = [];
  return { directory, modePath, metaPath, originalMode, originalMeta, calls,
    gatewayPath: join(root, "claude-desktop.json"), backupPath: join(root, "backup", "active.json"),
    settings: { ...settings, port: 48953 }, lifecycle: { stop: async () => { calls.push("stop"); return true; }, start: async () => { calls.push("start"); } } };
}
const encodedFixture = (value) => JSON.stringify(value, null, 2) + "\n";

test("One-click connect and restore round-trip modes/profiles without touching account or conversation data", async () => {
  const fixture = integrationFixture();
  const { modePath, metaPath, directory, calls, originalMode, originalMeta, gatewayPath, backupPath } = fixture;
  const chat = join(directory, "conversation-fixture.json");
  writeFileSync(chat, '"original chat"');
  await connectDesktop(fixture);
  const state = integrationStatus(backupPath);
  const profilePath = join(directory, "configLibrary", state.id + ".json");
  assert.equal(state.status, "applied");
  assert.equal(JSON.parse(readFileSync(metaPath)).appliedId, state.id);
  assert.equal(JSON.parse(readFileSync(metaPath)).hybridPointer, undefined);
  assert.equal(JSON.parse(readFileSync(modePath)).deploymentMode, "3p");
  const profile = JSON.parse(readFileSync(profilePath));
  assert.equal(profile.inferenceGatewayBaseUrl, "http://127.0.0.1:48953/claude");
  assert.equal(profile.inferenceGatewayApiKey, JSON.parse(readFileSync(gatewayPath)).token);
  assert.equal(profile.disableDeploymentModeChooser, undefined);
  await assert.rejects(connectDesktop(fixture), /已有接入備份/);
  await restoreDesktop(fixture);
  assert.equal(readFileSync(modePath, "utf8"), encodedFixture(originalMode));
  assert.equal(readFileSync(metaPath, "utf8"), encodedFixture(originalMeta));
  assert.equal(existsSync(profilePath), false);
  assert.equal(existsSync(gatewayPath), false);
  assert.equal(readFileSync(chat, "utf8"), '"original chat"');
  assert.deepEqual(calls, ["stop", "start", "stop", "start"]);
  assert.equal(integrationStatus(backupPath).status, "restored");
  await restoreDesktop(fixture);
  assert.equal(calls.length, 4);
});

test("Rollback preserves unrelated preferences and new profiles but refuses changed owned fields", async () => {
  const fixture = integrationFixture();
  await connectDesktop(fixture);
  const { modePath, metaPath, originalMeta } = fixture;
  const mode = JSON.parse(readFileSync(modePath));
  mode.preferences.theme = "light";
  writeFileSync(modePath, encodedFixture(mode));
  const meta = JSON.parse(readFileSync(metaPath));
  meta.entries.push({ id: "new-profile", name: "Keep this" });
  writeFileSync(metaPath, encodedFixture(meta));
  await restoreDesktop(fixture);
  assert.equal(JSON.parse(readFileSync(modePath)).preferences.theme, "light");
  assert.equal(JSON.parse(readFileSync(modePath)).deploymentMode, "1p");
  assert.deepEqual(JSON.parse(readFileSync(metaPath)).entries, [...originalMeta.entries, { id: "new-profile", name: "Keep this" }]);
  await connectDesktop(fixture);
  const changed = JSON.parse(readFileSync(metaPath));
  changed.appliedId = "other-profile";
  writeFileSync(metaPath, encodedFixture(changed));
  const callsBefore = fixture.calls.length;
  await assert.rejects(restoreDesktop(fixture), /已被其他操作修改/);
  assert.equal(fixture.calls.length, callsBefore, "conflicts are detected before closing the app");
  assert.equal(JSON.parse(readFileSync(metaPath)).appliedId, "other-profile");
});

test("Refused app exit changes no files; start failure restores the backed-up settings", async () => {
  const fixture = integrationFixture();
  await assert.rejects(connectDesktop({ ...fixture, lifecycle: { stop: async () => { throw new Error("busy"); } } }), /busy/);
  assert.equal(existsSync(fixture.backupPath), false);
  let attempts = 0;
  await assert.rejects(connectDesktop({ ...fixture, lifecycle: { stop: fixture.lifecycle.stop, start: async () => {
    if (++attempts === 1) throw new Error("start failed");
  } } }), /start failed/);
  assert.equal(integrationStatus(fixture.backupPath).status, "restored");
  assert.equal(readFileSync(fixture.modePath, "utf8"), encodedFixture(fixture.originalMode));
  assert.equal(readFileSync(fixture.metaPath, "utf8"), encodedFixture(fixture.originalMeta));
  assert.equal(attempts, 2, "reopen original mode after rolling back failed start");
});

test("Windows/macOS configuration paths and graceful lifecycle commands remain platform-specific", async () => {
  assert.equal(desktopDirectories({ platform: "darwin", home: "/Users/example" }), "/Users/example/Library/Application Support/Claude-3p");
  assert.equal(desktopDirectories({ platform: "win32", home: "C:\\Users\\Example", localAppData: "D:\\Local" }), "D:\\Local\\Claude-3p");
  for (const platform of ["darwin", "win32"]) {
    const commands = [];
    let running = true;
    const lifecycle = desktopLifecycle({ platform, app: platform === "darwin" ? "/Applications/Claude.app" : "C:\\Claude\\Claude.exe" }, {
      run: async (command, args) => {
        commands.push([command, args]);
        const text = args.join(" ");
        if (text.includes("is running") || text.startsWith("-NoProfile -NonInteractive -Command if(Get-Process")) return { stdout: String(running) };
        if (text.includes(" to quit") || text.includes("CloseMainWindow")) running = false;
        else running = true;
        return { stdout: "" };
      }, wait: async () => {},
    });
    assert.equal(await lifecycle.stop(), true);
    await lifecycle.start();
    assert.equal(running, true);
    assert.ok(!JSON.stringify(commands).includes("taskkill"));
    assert.ok(!JSON.stringify(commands).includes("Stop-Process"));
  }
});
