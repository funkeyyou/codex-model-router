import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { installer, dir } = await loadPayloads();
const cli = await import(pathToFileURL(join(dir, "claude-cli.mjs")));
const binary = join(dir, "claude-native");
const provider = { id: "default", baseUrl: "https://relay.example", apiRoot: "https://relay.example/v1", keychainService: "fixture" };
const state = () => ({ providers: [provider], manifest: { port: 4567, providers: [provider], routes: [] },
  settings: { port: 4567, providers: [provider], routes: [] },
  catalog: { models: [{ slug: "gpt-fixture", priority: 1, context_window: 200000, visibility: "list" }] } });

test("model-specific CLI version errors retain a validated minimum version", () => {
  const required = cli.requiredCliVersion({ message: { content: [{ type: "text", text:
    "API Error: 400 Claude Code 2.1.231 does not support this model; version 2.1.280 or newer is required. Run claude update." }] } });
  assert.equal(required, "2.1.280");
  assert.equal(cli.cliFailure("upgrade_required", required).error.requiredVersion, "2.1.280");
  assert.equal(cli.requiredCliVersion({ message: { content: [{ type: "text", text: "unrelated API error" }] } }), null);
});

test("Claude CLI model planning preserves API settings, adds isolated routes, supports update/removal", () => {
  const before = state();
  const snapshot = structuredClone(before);
  const plan = installer.planClaudeCliModels(before, binary, ["opus", "opus", "claude-test"], 200000);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(plan.settings.providers, [provider]);
  assert.equal(plan.settings.routes.length, 2);
  assert.ok(plan.settings.routes.every((route) => route.transport === "claude-cli" && route.providerId === "claude-cli"));
  assert.deepEqual(plan.settings.claudeCli, { binary, timeoutMs: 180000 });
  assert.equal(plan.catalog.models[1].display_name, "claude-cli/opus");
  assert.deepEqual(plan.settings.routes[0].efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(plan.catalog.models[1].supported_reasoning_levels.map((level) => level.effort),
    ["low", "medium", "high", "xhigh", "max"]);
  const update = installer.planUpdate(plan.manifest, plan.settings);
  assert.equal(update.ok, true);
  assert.deepEqual(update.settings.claudeCli, plan.settings.claudeCli);
  const removal = installer.planRemoveModels(plan.manifest, plan.settings, plan.catalog, [plan.settings.routes[0].pickerSlug]);
  assert.equal(removal.settings.routes.length, 1);
  assert.deepEqual(removal.settings.providers, [provider]);
  assert.throws(() => installer.planClaudeCliModels(before, binary, ["opus; touch anything"]), /模型名稱/);
  assert.throws(() => installer.planClaudeCliModels(before, binary, ["opus"], NaN), /上下文/);
  assert.throws(() => installer.planClaudeCliModels({ ...before, providers: [{ id: "claude-cli" }] }, binary, ["opus"]), /衝突/);
  assert.ok(installer.preservedSettingKeys.includes("claudeCli"));
});

test("subscription environment removes inherited credentials/providers while retaining network proxy", () => {
  const env = cli.claudeCliEnvironment({ HOME: "/fixture", ANTHROPIC_API_KEY: "secret", ANTHROPIC_AUTH_TOKEN: "secret2",
    ANTHROPIC_BASE_URL: "https://wrong.example", CLAUDE_CODE_OAUTH_TOKEN: "secret3", CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CONFIG_DIR: "/other-account", CLAUDECODE: "nested", HTTPS_PROXY: "http://local-proxy", PATH: "fixture" });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.HTTPS_PROXY, "http://local-proxy");
});

test("resolved model IDs are pinned; legacy alias picker IDs survive migration and versions remain distinct", () => {
  const initial = installer.planClaudeCliModels(state(), binary, ["opus"]);
  const legacy = { ...initial, providers: [provider] };
  const upgraded = installer.planClaudeCliModels(legacy, binary, ["opus"], 200000, { opus: "claude-opus-5" });
  const route = upgraded.settings.routes[0];
  assert.equal(route.pickerSlug, initial.settings.routes[0].pickerSlug);
  assert.equal(route.upstreamModel, "claude-opus-5");
  assert.equal(route.displayName, "claude-cli/claude-opus-5");
  assert.equal(upgraded.catalog.models[1].display_name, route.displayName);
  const next = installer.planClaudeCliModels({ ...upgraded, providers: [provider] }, binary, ["opus"], 200000,
    { opus: "claude-opus-5-5" });
  assert.deepEqual(next.settings.routes.map((item) => item.upstreamModel), ["claude-opus-5", "claude-opus-5-5"]);
  const dedup = installer.planClaudeCliModels(state(), binary, ["opus", "claude-opus-5"], 200000,
    { opus: "claude-opus-5", "claude-opus-5": "claude-opus-5" });
  assert.equal(dedup.settings.routes.length, 1);
});

test("native replay preserves paired results, image bytes and roles without changing original request", () => {
  const source = { model: "opus", system: [{ type: "text", text: "System" }], tools: [
    { name: "ns__exec", description: "Execute via Codex", input_schema: { type: "object" } },
  ], messages: [
    { role: "user", content: [{ type: "text", text: "anchor" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ns__exec", input: { cmd: "test" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "image-bytes" } },
    ] }] },
  ] };
  const copy = structuredClone(source);
  const prepared = cli.prepareCliConversation(source, dir);
  const rows = prepared.transcript.split("\n").map(JSON.parse);
  assert.deepEqual(rows.map((row) => row.message.role), ["user", "assistant", "user"]);
  assert.equal(rows[1].message.content[0].name, "mcp__codex__t0");
  assert.equal(rows[2].message.content[0].content[0].source.data, "image-bytes");
  assert.equal(rows[1].parentUuid, rows[0].uuid);
  assert.equal(rows[2].parentUuid, rows[1].uuid);
  assert.deepEqual(source, copy);
  assert.notEqual(cli.prepareCliConversation(source, dir).transcript, prepared.transcript, "threads never share mutable session IDs");
  const forbidden = cli.prepareCliConversation({ ...source, tool_choice: { type: "none" } }, dir);
  assert.equal(forbidden.tools.length, 1, "previous tool definitions remain available during replay");
  assert.match(forbidden.system, /do not call any tools/);
});

test("MCP relay requires per-request authorization and never executes a requested tool", async () => {
  const server = await cli.startCliToolServer([{ name: "t0", inputSchema: { type: "object" } }]);
  try {
    const { url, headers } = server.config.mcpServers.codex;
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 403);
    const result = await fetch(url, { method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "t0", arguments: {} } }) });
    assert.equal((await result.json()).result.isError, true);
  } finally { server.close(); }
});

test("CLI route never looks up API provider/key or falls back when CLI is missing", async (t) => {
  const plan = installer.planClaudeCliModels(state(), binary, ["opus"]);
  const instance = await loadRouterWith({ ...plan.settings, officialBaseUrl: "https://official.example" });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => { calls.push(String(url)); return Response.json({ models: [] }); });
  const body = { model: plan.settings.routes[0].pickerSlug, input: "fixture", stream: true };
  const upstream = await instance.fetchModelUpstream({ authorization: "Bearer fixture", "chatgpt-account-id": "fixture" },
    new URL("http://127.0.0.1/v1/responses"), body, Buffer.from(JSON.stringify(body)), undefined, {});
  assert.equal(upstream.status, 503);
  assert.match((await upstream.json()).error.message, /Claude CLI/);
  assert.ok(calls.every((url) => url.startsWith("https://official.example/")));
});
