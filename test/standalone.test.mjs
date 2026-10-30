// 在隔離目錄執行真正的安裝／修改／更新／卸載流程；只以一般子行程取代 OS 服務管理。
// 真實路由器與假 Anthropic 上游完成請求，整個流程不提供任何 Codex 執行檔。
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPayloads } from "./helpers/payloads.mjs";
import { codexBin } from "./helpers/codex-bin.mjs";

const { installer, dir } = await loadPayloads();
const scriptPath = fileURLToPath(new URL("../codex-model-router.sh", import.meta.url));
const releases = JSON.parse(readFileSync(new URL("../releases.json", import.meta.url), "utf8"));

test("獨立模式明確保存；舊版 Codex 安裝的預設仍是已接入", () => {
  assert.equal(installer.codexIntegrationEnabled(null, false), false);
  assert.equal(installer.codexIntegrationEnabled(null, true), true);
  assert.equal(installer.codexIntegrationEnabled({ version: "1.39.4" }, false), true);
  assert.equal(installer.codexIntegrationEnabled({ codexIntegration: false }, true), false);
  assert.equal(installer.codexIntegrationEnabled({ codexIntegration: true }, true), true);
  const entry = installer.customCatalogEntry([], { pickerSlug: "custom/claude-fixture", upstreamModel: "claude-fixture",
    providerHost: "fixture.example", efforts: ["high"], translate: "anthropic", contextWindow: 1000000, maxOutputTokens: 128000 }, 0);
  assert.equal(entry.priority, 1);
  assert.equal(entry.context_window, 1000000);
  assert.equal(entry.max_output_tokens, 128000);
  assert.equal(entry.tool_mode, undefined, "沒有 Codex 目錄時不虛構工具能力");
});

function fixtureSource(scenario) {
  let source = readFileSync(join(dir, "installer.mjs"), "utf8");
  const replaceFunction = (name, body) => {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, name);
    const end = source.indexOf("\n}", start) + 2;
    source = source.slice(0, start) + `function ${name}() {\n${body}\n}` + source.slice(end);
  };
  replaceFunction("startService", `
    stopService();
    sleepSync(150);
    const environment = { ...env };
    delete environment.CODEX_MODEL_ROUTER_IMPORT_ONLY;
    fixtureRouter = spawn(process.execPath, [routerPath], { env: environment, stdio: "ignore", windowsHide: true });
  `);
  replaceFunction("restartServiceInPlace", "startService();");
  replaceFunction("stopService", "if (fixtureRouter) { fixtureRouter.kill(); fixtureRouter = null; }");
  replaceFunction("removeServiceRegistration", "");
  replaceFunction("writeServiceDefinition", "");
  replaceFunction("serviceDefinitionUnchanged", "return true;");
  return source + `
let fixtureRouter;
managerMode = true;
const assert = (await import("node:assert/strict")).default;
try {
${scenario}
  console.log("STANDALONE_FIXTURE_OK");
} finally {
  stopService();
}
`;
}

async function runScenario(t, scenario, { noCodex = true, root = null } = {}) {
  root ||= mkdtempSync(join(tmpdir(), "router-standalone-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const harness = join(root, "fixture.mjs");
  writeFileSync(harness, fixtureSource(scenario));
  const environment = {
    ...process.env, CODEX_HOME: root, CODEX_MODEL_ROUTER_HOME: join(root, "model-router"),
    CODEX_MODEL_ROUTER_SCRIPT_PATH: scriptPath, CODEX_MODEL_ROUTER_NODE_BIN: process.execPath,
    CODEX_MODEL_ROUTER_IMPORT_ONLY: "1", CODEX_MODEL_ROUTER_TEST_MODE: "1",
    CODEX_MODEL_ROUTER_TEST_NO_CODEX: noCodex ? "1" : "0", CODEX_MODEL_ROUTER_CODEX_BIN: codexBin || "",
    CODEX_MODEL_ROUTER_TEST_API_KEY: "fixture-key", CODEX_MODEL_ROUTER_RELEASES_JSON: JSON.stringify(releases),
    CODEX_MODEL_ROUTER_SHORTCUT_DIR: join(root, "shortcuts"), CODEX_MODEL_ROUTER_LAUNCH_AGENTS_DIR: join(root, "agents"),
    CODEX_MODEL_ROUTER_UI_NO_OPEN: "1",
  };
  const child = spawn(process.execPath, [harness], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill(), 85000).unref();
  const [code] = await once(child, "close");
  clearTimeout(timer);
  assert.equal(code, 0, output);
  assert.match(output, /STANDALONE_FIXTURE_OK/);
}

async function upstream(t) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    requests.push({ path: req.url, model: body.model, key: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url.split("?")[0].endsWith("/models")) return res.end(JSON.stringify({ data: ["claude-opus-fixture", "claude-sonnet-fixture"].map(id => ({ id })) }));
    if (body.max_tokens === 9999999) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: "max_tokens: 9999999 > 128000" } }));
    }
    if (JSON.stringify(body.messages || []).length > 100000) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: "prompt is too long: 1300000 tokens > 1000000 maximum" } }));
    }
    res.end(JSON.stringify({ id: "msg_fixture", type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 1 } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

test("沒有 Codex：首次安裝、Claude Gateway 對話、模型管理、更新及卸載；Codex 檔案完全不變", { timeout: 90000 }, async t => {
  const api = await upstream(t);
  await runScenario(t, `
  assert.equal(codexBin, null);
  const untouched = { "config.toml": "# unrelated Codex settings\\n", "auth.json": "original auth", "models_cache.json": "original cache" };
  for (const [file, content] of Object.entries(untouched)) writeFileSync(join(codexHome, file), content);
  await installManagerOnly();
  const initial = await managerState();
  assert.deepEqual(initial.codex, { available: false, connected: false });
  assert.equal(initial.setupBlocked, null);
  assert.equal(readManagerRecord().managerMcpEntry, undefined);
  const ops = managerOperations();
  const draft = await ops.providerDraft({ baseUrl: ${JSON.stringify(api.baseUrl)}, apiKey: "fixture-key" });
  const installed = await ops.jobs.install.run({ draftId: draft.draftId, models: ["claude-opus-fixture"] });
  assert.equal(installed.restartDesktop, false);
  assert.equal(readManifest().codexIntegration, false);
  assert.equal(readManifest().previousConfig, null);
  assert.equal(readSettingsIfExists().catalogRefresh, false);
  assert.equal(readSettingsIfExists().codexBin, null);
  const first = await managerState();
  assert.equal(first.writeBlocked, null);
  assert.equal(first.officialModelCount, 0);
  assert.equal(first.models.length, 1);
  assert.equal(first.desktop.canRestart, false);
  const root = "http://127.0.0.1:" + first.router.port;
  await ops.jobs["set-claude-desktop"].run({ enabled: true });
  const desktop = await ops.queries["claude-desktop-connection"]();
  const connection = desktop.connection;
  const headers = { "x-api-key": connection.inferenceGatewayApiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  const list = await fetch(root + "/claude/v1/models", { headers });
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.equal(listBody.data.length, 1);
  assert.equal((await fetch(root + "/claude/v1/models", { headers: { "x-api-key": "wrong" } })).status, 401);
  const answer = await fetch(root + "/claude/v1/messages", { method: "POST", headers, body: JSON.stringify({
    model: first.models[0].slug, max_tokens: 16, messages: [{ role: "user", content: "fixture" }] }) });
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).content[0].text, "OK");
  await ops.jobs["add-models"].run({ providerId: "default", models: ["claude-sonnet-fixture"] });
  let models = (await managerState()).models;
  assert.equal(models.length, 2);
  await ops.jobs["reorder-models"].run({ slugs: models.map(m => m.slug).reverse() });
  await ops.jobs["edit-model"].run({ slug: models[0].slug, displayName: "Fixture Opus", contextWindow: 500000, maxOutputTokens: 64000 });
  await ops.jobs["edit-provider"].run({ providerId: "default", name: "Fixture", modelPrefix: "fixture" });
  const second = await ops.providerDraft({ baseUrl: ${JSON.stringify(api.baseUrl + "/second")}, apiKey: "fixture-key" });
  await ops.jobs["add-provider"].run({ draftId: second.draftId, providerId: "second", models: ["claude-sonnet-fixture"] });
  await ops.jobs["remove-provider"].run({ providerId: "second", deleteKey: false });
  await ops.jobs["remove-models"].run({ slugs: [models[1].slug] });
  assert.equal((await managerState()).models.length, 1);
  for (const type of ["set-global-context", "set-hidden-models", "set-quota-mode", "set-background-model", "connect-codex"]) {
    await assert.rejects(ops.jobs[type].run({ value: 1000000, slugs: [], enabled: true, kind: "light", model: null }), /Codex CLI/);
  }
  const snapshot = readSettingsIfExists();
  await update();
  const updated = readSettingsIfExists();
  assert.deepEqual(updated.routes, snapshot.routes);
  assert.equal(updated.codexIntegration, false);
  assert.equal(updated.catalogRefresh, false);
  assert.equal((await managerState()).router.ok, true);
  for (const [file, content] of Object.entries(untouched)) assert.equal(readFileSync(join(codexHome, file), "utf8"), content);
  const result = await uninstallRouter(readManifest(), { deleteKeys: async () => false });
  assert.equal(existsSync(installRoot), false);
  assert.equal(existsSync(join(result.archiveDir, "model-router", "settings.json")), true);
  for (const [file, content] of Object.entries(untouched)) assert.equal(readFileSync(join(codexHome, file), "utf8"), content);
  `);
  assert.ok(api.requests.some(req => req.model === "claude-opus-fixture" && req.key === "Bearer fixture-key"));
});

test("獨立安裝後偵測到 Codex 不自動改設定；明確連接可用真實 Codex model/list 驗證並可回退", {
  skip: !codexBin && "需要 Codex CLI", timeout: 90000,
}, async t => {
  const api = await upstream(t);
  await runScenario(t, `
  assert.ok(codexBin);
  await installManagerOnly();
  const jwt = "e30." + Buffer.from(JSON.stringify({ sub: "fixture", email: "fixture@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture", chatgpt_plan_type: "plus", chatgpt_user_id: "fixture" },
  })).toString("base64url") + ".fake";
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", last_refresh: new Date().toISOString(),
    tokens: { access_token: jwt, id_token: jwt, refresh_token: "fake", account_id: "fixture" } }));
  const user = await readUserConfig();
  const original = { ...user.config };
  // 建立獨立安裝，模擬先裝 Claude，之後才裝 Codex。
  const hadCodex = codexIntegrationEnabled;
  codexIntegrationEnabled = (manifest = readManifest()) => manifest ? manifest.codexIntegration !== false : false;
  const ops = managerOperations();
  const draft = await ops.providerDraft({ baseUrl: ${JSON.stringify(api.baseUrl)}, apiKey: "fixture-key" });
  await ops.jobs.install.run({ draftId: draft.draftId, models: ["claude-opus-fixture"] });
  codexIntegrationEnabled = hadCodex;
  writeJsonAtomic(settingsPath, { ...readSettingsIfExists(), officialBaseUrl: ${JSON.stringify(api.baseUrl)} });
  assert.equal((await managerState()).codex.available, true);
  assert.equal((await managerState()).codex.connected, false);
  assert.deepEqual((await readUserConfig()).config, original);
  const result = await ops.jobs["connect-codex"].run();
  assert.equal(result.changed, true);
  assert.equal(readManifest().codexIntegration, true);
  assert.equal((await readUserConfig()).config.openai_base_url, "http://127.0.0.1:" + readSettingsIfExists().port + "/v1");
  assert.equal((await managerState()).codex.connected, true);
  assert.equal(readSettingsIfExists().routes.length, 1);
  await uninstallRouter(readManifest(), { deleteKeys: async () => false });
  assert.deepEqual((await readUserConfig()).config, original);
  `, { noCodex: false });
});

for (const failValidation of [false, true]) {
  test(`獨立安裝連接未登入的 Codex：${failValidation ? "清單驗證失敗會還原設定與登入檔" : "先啟用 API Key 模式再驗證模型清單"}`, {
    skip: !codexBin && "需要 Codex CLI", timeout: 90000,
  }, async t => {
    const api = await upstream(t);
    await runScenario(t, `
    await installManagerOnly();
    const original = (await readUserConfig()).config;
    const hadCodex = codexIntegrationEnabled;
    codexIntegrationEnabled = (manifest = readManifest()) => manifest ? manifest.codexIntegration !== false : false;
    const draft = await managerProviderDraft({ baseUrl: ${JSON.stringify(api.baseUrl)}, apiKey: "fixture-key" });
    await managerFirstInstall({ draftId: draft.draftId, models: ["claude-opus-fixture"] });
    codexIntegrationEnabled = hadCodex;
    writeJsonAtomic(settingsPath, { ...readSettingsIfExists(), officialBaseUrl: ${JSON.stringify(api.baseUrl)} });
    const before = readSettingsIfExists();
    verifyLoginForCodex = () => "none";
    const validate = waitForPickerModels;
    if (${failValidation}) waitForPickerModels = async () => { throw new Error("fixture-picker-failed"); };
    if (${failValidation}) {
      await assert.rejects(managerConnectCodex(), /fixture-picker-failed/);
      assert.equal(readManifest().codexIntegration, false);
      assert.deepEqual(readSettingsIfExists(), before);
      assert.equal(quotaModeEnabled(), false);
      assert.equal(existsSync(codexAuthPath), false);
      assert.deepEqual((await readUserConfig()).config, original);
    } else {
      const result = await managerConnectCodex();
      assert.equal(result.apiKeyMode, true);
      assert.equal(quotaModeEnabled(), true);
      assert.equal((await codexRpc("account/read", { refreshToken: false })).account.type, "apiKey");
      await validate(readSettingsIfExists().routes);
    }
    await uninstallRouter(readManifest(), { deleteKeys: async () => false });
    assert.equal(existsSync(codexAuthPath), false);
    assert.deepEqual((await readUserConfig()).config, original);
    `, { noCodex: false });
  });
}
