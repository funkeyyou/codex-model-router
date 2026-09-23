// Opt-in integration: real Codex app-server, real router HTTP handler, synthetic login and
// local upstream only. No inference, real credentials, installed service, or user config edits.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPayloads } from "./helpers/payloads.mjs";

const bin = process.env.CODEX_MODEL_ROUTER_TEST_CODEX_BIN;
test("Codex 連續重啟同步新增官方模型；離線仍保留自訂模型", { skip: !bin, timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "router-catalog-e2e-"));
  const runtime = join(root, "model-router");
  mkdirSync(runtime);
  const env = { ...process.env, CODEX_HOME: root };
  delete env.CODEX_MODEL_ROUTER_IMPORT_ONLY;
  const bundled = JSON.parse(execFileSync(bin, ["debug", "models", "--bundled"], { env, cwd: root, encoding: "utf8" }));
  const template = bundled.models.find(m => m.visibility === "list");
  const entry = slug => ({ ...template, slug, display_name: slug, visibility: "list" });
  const custom = entry("custom/test-model");
  let models = [entry("gpt-6-sol")];
  let offline = false, queries = 0;
  const upstream = http.createServer((req, res) => {
    assert.match(req.url, /^\/models\?client_version=/);
    assert.match(req.headers.authorization, /^Bearer /);
    queries++;
    res.writeHead(offline ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const { dir } = await loadPayloads();
  for (const name of ["router.mjs", "bridge.mjs", "claude-bridge.mjs"]) copyFileSync(join(dir, name), join(runtime, name));
  const catalogPath = join(runtime, "models.json");
  writeFileSync(catalogPath, JSON.stringify({ models: [entry("old-model"), custom] }));
  writeFileSync(join(runtime, "settings.json"), JSON.stringify({ apiRoot: "https://unused.example/v1",
    officialBaseUrl: `http://127.0.0.1:${upstream.address().port}`, catalogPath, port, routes: [] }));
  writeFileSync(join(root, "config.toml"), `openai_base_url = "http://127.0.0.1:${port}/v1"\nmodel_context_window = 1000000\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\n`);
  const jwt = "e30." + Buffer.from(JSON.stringify({ sub: "fixture", email: "fixture@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture", chatgpt_plan_type: "plus", chatgpt_user_id: "fixture" },
  })).toString("base64url") + ".fake";
  writeFileSync(join(root, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", last_refresh: new Date().toISOString(),
    tokens: { access_token: jwt, id_token: jwt, refresh_token: "fake", account_id: "fixture" } }));
  const service = spawn(process.execPath, [join(runtime, "router.mjs")], { env, cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => service.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("router startup timeout")), 5000);
    service.stderr.on("data", d => { if (d.toString().includes("model-router-ready:")) { clearTimeout(timer); resolve(); } });
    service.once("error", reject);
  });
  async function picker(expected, migrate = false) {
    const app = spawn(bin, ["app-server"], { env, cwd: root, stdio: ["pipe", "pipe", "ignore"] });
    const exited = once(app, "exit");
    const send = m => app.stdin.write(JSON.stringify(m) + "\n");
    let buffer = "";
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("picker timeout")), 7000);
        app.once("error", error => { clearTimeout(timer); reject(error); });
        app.stdout.on("data", d => {
          buffer += d;
          let n;
          while ((n = buffer.indexOf("\n")) >= 0) {
            const message = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
            if (message.id === 1) {
              send({ method: "initialized" });
              send(migrate
                ? { id: 2, method: "config/batchWrite", params: { edits: [{ keyPath: "model_catalog_json", value: null, mergeStrategy: "replace" }], reloadUserConfig: false } }
                : { id: 2, method: "model/list", params: { includeHidden: true } });
            }
            if (message.id === 2) {
              if (message.error) { clearTimeout(timer); reject(new Error(message.error.message)); }
              else if (migrate) { clearTimeout(timer); resolve(); }
              else {
                const ids = message.result.data.map(m => m.id);
                // Codex 可先回答磁碟快取並在背景同步。模擬同一程序再次開啟選單，
                // 不是多重啟一次或以 router 磁碟結果冒充 app-server 的模型列表。
                if (ids.includes(expected)) { clearTimeout(timer); resolve(ids); }
                else setTimeout(() => send({ id: 2, method: "model/list", params: { includeHidden: true } }), 50);
              }
            }
          }
        });
        send({ id: 1, method: "initialize", params: { clientInfo: { name: "router_test", version: "1.0.0" } } });
      });
    } finally { app.kill(); await exited; }
  }
  // 舊安裝的固定目錄用與 installer 相同的 Codex RPC 移除；其他全域配置保留。
  await picker(undefined, true);
  const migratedConfig = readFileSync(join(root, "config.toml"), "utf8");
  assert.doesNotMatch(migratedConfig, /model_catalog_json/);
  assert.match(migratedConfig, /model_context_window = 1000000/);
  assert.ok(migratedConfig.includes(`http://127.0.0.1:${port}/v1`));
  let result = await picker("gpt-6-sol");
  assert.ok(result.includes("gpt-6-sol"));
  assert.ok(result.includes(custom.slug));
  const before = queries;
  models = [...models, entry("gpt-6-luna")];
  result = await picker("gpt-6-luna");
  assert.ok(queries > before, "重啟後沒有沿用前一次快取跳過官方查詢");
  assert.ok(result.includes("gpt-6-luna"));
  assert.ok(result.includes(custom.slug));
  const saved = readFileSync(catalogPath, "utf8");
  offline = true;
  result = await picker("gpt-6-luna");
  assert.ok(result.includes("gpt-6-luna"));
  assert.ok(result.includes(custom.slug));
  assert.equal(readFileSync(catalogPath, "utf8"), saved);
});
