import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { loadPayloads } from "./helpers/payloads.mjs";

const { router, installer, bridge, chat, dir, managerPage } = await loadPayloads();
const config = { enabled: true, prompts: { gpt: "GPT_PROFILE", claude: "CLAUDE_PROFILE" } };
const user = { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] };
const body = model => ({ model, instructions: "ORIGINAL", input: [user], stream: true });

test("family selection uses actual upstream model, never the display alias", () => {
  for (const model of ["gpt-6.1-sol", "ark/gpt-6-astra", "o3", "GPT-5.6"]) assert.equal(router.keysmithFamily(body(model)), "gpt");
  for (const model of ["claude-opus-5-5", "claude-cli/claude-sonnet-4", "opus"]) assert.equal(router.keysmithFamily(body(model)), null);
  assert.equal(router.keysmithFamily(body("custom/gpt-fake"), { upstreamModel: "grok-4.7" }), null);
  assert.equal(router.keysmithFamily(body("custom/gpt-alias"), { upstreamModel: "ark/claude-opus-5-5" }), null);
  for (const model of ["grok-4.7", "gemini-3", "not-gpt-5", ""]) assert.equal(router.keysmithFamily(body(model)), null);
});

test("opt-in injection preserves original instructions, tools, inputs, and caller objects", () => {
  const original = { ...body("gpt-6-sol"), tools: [{ type: "function", name: "run", parameters: {} }] };
  const before = structuredClone(original);
  const injected = router.applyKeysmith(original, null, config);
  assert.equal(injected.instructions, "ORIGINAL\n\nGPT_PROFILE");
  assert.equal(injected.input, original.input);
  assert.equal(injected.tools, original.tools);
  assert.deepEqual(original, before);
  assert.equal(router.applyKeysmith(original, null, null), original);
  assert.equal(router.applyKeysmith(original, null, { ...config, enabled: false }), original);
  assert.equal(router.applyKeysmith(body("grok-4.7"), null, config).instructions, "ORIGINAL");
});

test("switching model and switching off do not leave the prior profile in replayed messages", () => {
  const original = body("gpt-6-sol");
  const gpt = router.applyKeysmith(original, null, config);
  const claude = router.applyKeysmith({ ...original, model: "claude-opus-5-5" }, null, config);
  assert.doesNotMatch(claude.instructions, /GPT_PROFILE/);
  assert.equal(claude.instructions, "ORIGINAL");
  assert.doesNotMatch(JSON.stringify(original.input), /PROFILE/);
  assert.doesNotMatch(JSON.stringify(gpt.input), /PROFILE/);
  assert.equal(router.applyKeysmith(original, null, { enabled: false }).instructions, "ORIGINAL");
});

test("GPT profile removes the upstream fixed operator name without removing unrelated instructions", () => {
  for (const family of ["gpt"]) {
    const source = "Intro\nThe operator is Ethan. Address him as Ethan.\nKeep all tools.\n";
    const custom = { enabled: true, prompts: { [family]: source } };
    const result = router.applyKeysmith(body(family === "gpt" ? "gpt-6-sol" : "claude-opus-5-5"), null, custom);
    assert.doesNotMatch(result.instructions, /Ethan/);
    assert.match(result.instructions, /Keep all tools/);
    assert.equal(custom.prompts[family], source, "retain original licensed source");
  }
});

test("manager switch asks before enabling, disables directly, and honors read-only state", async () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(managerPage)[1];
  const render = script.slice(script.indexOf("function renderKeysmithPanel("), script.indexOf("function renderQuotaModePanel("));
  for (const on of [false, true]) {
    const jobs = [];
    let confirmations = 0;
    const context = {
      state: { keysmith: { enabled: on } },
      h: (tag, props, ...children) => ({ tag, props, children }), t: text => text,
      paragraph: text => ({ tag: "p", text }),
      confirmDialog: async () => { confirmations++; return true; },
      runJob: (type, params) => { jobs.push({ type, params }); },
    };
    const panel = vm.runInNewContext(render + "\nrenderKeysmithPanel(false)", context);
    const find = node => node && (node.props?.role === "switch" ? node : node.children?.map(find).find(Boolean));
    const control = find(panel);
    assert.equal(control.props.checked, on);
    assert.equal(control.props.disabled, false);
    await control.props.onchange({ target: { checked: !on } });
    await Promise.resolve();
    assert.equal(confirmations, on ? 0 : 1);
    assert.equal(jobs[0].type, "set-keysmith");
    assert.equal(jobs[0].params.enabled, !on);
    const blocked = vm.runInNewContext(render + "\nrenderKeysmithPanel(true)", context);
    assert.equal(find(blocked).props.disabled, true);
  }
});

test("GPT Chat keeps its profile, Anthropic and Claude CLI get no Keysmith instructions even with legacy config", () => {
  const original = { ...body("claude-opus-5-5"), tools: [{ type: "function", name: "run", description: "Run", parameters: { type: "object", properties: {} } }] };
  const claude = bridge.toAnthropicRequest(router.applyKeysmith(original, null, config), { upstreamModel: original.model }).request;
  assert.match(JSON.stringify(claude.system), /ORIGINAL/);
  assert.doesNotMatch(JSON.stringify(claude), /GPT_PROFILE|CLAUDE_PROFILE/);
  const cliRoute = { upstreamModel: "claude-opus-5-5", transport: "claude-cli", translate: "anthropic" };
  assert.equal(router.applyKeysmith(original, cliRoute, config), original);
  const claudeChat = chat.toChatRequest(router.applyKeysmith(original, null, config), { upstreamModel: original.model }).request;
  assert.doesNotMatch(JSON.stringify(claudeChat), /GPT_PROFILE|CLAUDE_PROFILE/);
  assert.equal(claude.tools[0].name, "run");
  const translated = chat.toChatRequest(router.applyKeysmith({ ...original, model: "gpt-6-sol" }, null, config), { upstreamModel: "gpt-6-sol" }).request;
  assert.match(JSON.stringify(translated.messages), /ORIGINAL.*GPT_PROFILE/s);
  assert.doesNotMatch(JSON.stringify(translated), /CLAUDE_PROFILE/);
});

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), "router-keysmith-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("local config: missing, malformed, too large or disabled all leave requests unchanged", t => {
  const path = join(temp(t), "keysmith.json");
  assert.equal(router.readKeysmithConfig(path), null);
  for (const text of ["bad JSON", JSON.stringify({ ...config, enabled: false }), " ".repeat(65537)]) {
    writeFileSync(path, text);
    assert.equal(router.readKeysmithConfig(path), null);
  }
  writeFileSync(path, JSON.stringify(config));
  assert.deepEqual(router.readKeysmithConfig(path), config);
  const gptOnly = { enabled: true, prompts: { gpt: "GPT_PROFILE" } };
  writeFileSync(path, JSON.stringify(gptOnly));
  assert.deepEqual(router.readKeysmithConfig(path), gptOnly);
});

test("real forwarding paths read toggles each turn: GPT Responses, Claude API and then off", async t => {
  const path = join(dir, "keysmith.json");
  t.after(() => rmSync(path, { force: true }));
  writeFileSync(path, JSON.stringify(config));
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (String(url).endsWith("/models")) return new Response("missing client_version", { status: 400 });
    sent.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json({ ok: true });
  });
  const oldKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "test-key";
  t.after(() => { if (oldKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY; else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = oldKey; });
  const headers = { authorization: "Bearer test", "chatgpt-account-id": "test" };
  const forward = async model => {
    const input = body(model);
    return router.fetchModelUpstream(headers, new URL("http://127.0.0.1/v1/responses"), input, Buffer.from(JSON.stringify(input)), new AbortController().signal);
  };
  await forward("gpt-6-sol");
  assert.match(sent.at(-1).body.instructions, /GPT_PROFILE/);
  await forward("custom/claude-test");
  assert.match(sent.at(-1).url, /\/messages$/);
  assert.match(JSON.stringify(sent.at(-1).body.system), /ORIGINAL/);
  assert.doesNotMatch(JSON.stringify(sent.at(-1).body), /GPT_PROFILE|CLAUDE_PROFILE/);
  writeFileSync(path, JSON.stringify({ enabled: false }));
  await forward("gpt-6-sol");
  assert.equal(sent.at(-1).body.instructions, "ORIGINAL");
});

const fixtureSources = [
  { family: "gpt", repo: "codex-keysmith", commit: "a".repeat(40), path: "gpt.md", text: "GPT" },
  { family: null, repo: "codex-keysmith", commit: "a".repeat(40), path: "LICENSE", text: "MIT" },
].map(item => ({ ...item, sha256: createHash("sha256").update(item.text).digest("hex") }));

test("downloader pins revisions and hashes, retains licenses, and never executes scripts", async () => {
  const fetched = [];
  const result = await installer.downloadKeysmithProfiles({ sources: fixtureSources, fetchImpl: async (url, options) => {
    fetched.push(url);
    assert.equal(options.redirect, "error");
    return new Response(fixtureSources.find(source => url.endsWith(source.path)).text);
  } });
  assert.deepEqual(result.prompts, { gpt: "GPT" });
  assert.equal(result.licenses["codex-keysmith"], "MIT");
  assert.equal(result.enabled, false);
  assert.equal(fetched.length, 2);
  for (const item of installer.KEYSMITH_SOURCES) {
    assert.match(item.commit, /^[a-f0-9]{40}$/);
    assert.equal(item.repo, "codex-keysmith");
  }
  await assert.rejects(installer.downloadKeysmithProfiles({ sources: fixtureSources, fetchImpl: async () => new Response("tampered") }), /SHA256/);
  await assert.rejects(installer.downloadKeysmithProfiles({ fetchImpl: async () => new Response("bad", { status: 503 }) }), /503/);
});

test("migration removes Claude profile, sources and license but preserves GPT, toggle and reversible backup", t => {
  for (const enabled of [true, false]) {
    const root = temp(t);
    const backupRoot = join(root, "backups");
    const path = join(root, "keysmith.json");
    const legacy = { ...config, enabled, sources: [{ repo: "codex-keysmith" }, { repo: "claude-keysmith" }],
      licenses: { "codex-keysmith": "GPT license", "claude-keysmith": "Claude license" } };
    writeFileSync(path, JSON.stringify(legacy));
    const result = installer.migrateKeysmithGptOnly({ root, backupRoot });
    const migrated = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(migrated.enabled, enabled);
    assert.deepEqual(migrated.prompts, { gpt: "GPT_PROFILE" });
    assert.deepEqual(migrated.sources, [{ repo: "codex-keysmith" }]);
    assert.deepEqual(migrated.licenses, { "codex-keysmith": "GPT license" });
    assert.deepEqual(JSON.parse(readFileSync(join(result.backupDir, "keysmith.json"), "utf8")), legacy);
    assert.equal(installer.migrateKeysmithGptOnly({ root, backupRoot }), null);
  }
});

test("failed enable preserves the file; disabling works offline, backs up corrupt files and takes effect immediately", async t => {
  const root = temp(t);
  const backupRoot = join(root, "backups");
  const path = join(root, "keysmith.json");
  const original = JSON.stringify(config);
  writeFileSync(path, original);
  await assert.rejects(installer.setKeysmithEnabled(true, { root, backupRoot, fetchImpl: async () => { throw new Error("offline"); } }), /offline/);
  assert.equal(readFileSync(path, "utf8"), original);
  writeFileSync(path, "corrupted");
  await installer.setKeysmithEnabled(false, { root, backupRoot, fetchImpl: () => assert.fail("must stay offline") });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).enabled, false);
  assert.equal(router.readKeysmithConfig(path), null);
  const backup = readdirSync(backupRoot)[0];
  assert.equal(readFileSync(join(backupRoot, backup, "keysmith.json"), "utf8"), "corrupted");
  assert.equal(existsSync(join(root, "config.toml")), false);
});
