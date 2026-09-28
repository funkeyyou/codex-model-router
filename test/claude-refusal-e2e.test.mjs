import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import { loadPayloads } from "./helpers/payloads.mjs";
import { codexBin } from "./helpers/codex-bin.mjs";

test("Codex 收到 Claude 拒答時顯示原因，不把空輸出當作成功", { skip: !codexBin, timeout: 30000 }, async () => {
  const { bridge, installer } = await loadPayloads();
  const home = mkdtempSync(join(tmpdir(), "router-refusal-e2e-"));
  const env = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_MODEL_ROUTER_IMPORT_ONLY;
  const bundled = JSON.parse(execFileSync(codexBin, ["debug", "models", "--bundled"], { env, cwd: home, encoding: "utf8" }));
  const route = {
    pickerSlug: "custom/claude-refusal-fixture", upstreamModel: "claude-fixture",
    providerHost: "gateway.example", efforts: [], translate: "anthropic", contextWindow: 200000,
  };
  const model = installer.customCatalogEntry(bundled.models.filter((item) => !item.slug.startsWith("custom/")), route, 0);
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = Buffer.concat(chunks);
    if (request.headers["content-encoding"] === "zstd") body = zstdDecompressSync(body);
    if (!request.url.includes("/responses")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [model] }));
      return;
    }
    if (!body.length) { response.writeHead(426); response.end(); return; }
    const parsed = JSON.parse(body.toString());
    requests.push(parsed);
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "refusal" },
        stop_details: { type: "refusal", category: "cyber", explanation: "Fixture request declined." } },
      { type: "message_stop" },
    ];
    async function* stream() {
      yield Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    await bridge.bridgeAnthropicStream(stream(), (event) => response.write(`data: ${JSON.stringify(event)}\n\n`),
      { model: parsed.model, requestBody: parsed, freeform: new Set(), compaction: false });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  writeFileSync(join(home, "models.json"), JSON.stringify({ models: [model] }));
  writeFileSync(join(home, "config.toml"), `model = "${model.slug}"\nmodel_catalog_json = ${JSON.stringify(join(home, "models.json"))}\nopenai_base_url = "http://127.0.0.1:${server.address().port}/v1"\n[features]\napps = false\nplugins = false\n`);
  const jwt = "e30." + Buffer.from(JSON.stringify({ sub: "fixture", email: "fixture@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture", chatgpt_plan_type: "plus", chatgpt_user_id: "fixture" } })).toString("base64url") + ".fake";
  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", last_refresh: new Date().toISOString(),
    tokens: { access_token: jwt, id_token: jwt, refresh_token: "fake", account_id: "fixture" } }));

  const app = spawn(codexBin, ["app-server"], { env, cwd: home, stdio: ["pipe", "pipe", "ignore"] });
  const exited = once(app, "exit");
  const notifications = [];
  const send = (message) => app.stdin.write(JSON.stringify(message) + "\n");
  let buffer = "";
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("refusal e2e timeout")), 20000);
      app.once("error", (error) => { clearTimeout(timer); reject(error); });
      app.stdout.on("data", (data) => {
        buffer += data;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          notifications.push(message);
          if (message.error) { clearTimeout(timer); reject(new Error(JSON.stringify(message.error))); }
          if (message.id === 1) {
            send({ method: "initialized" });
            send({ id: 2, method: "thread/start", params: { cwd: home, model: model.slug, ephemeral: true, approvalPolicy: "never" } });
          }
          if (message.id === 2 && message.result) {
            send({ id: 3, method: "turn/start", params: { threadId: message.result.thread.id,
              input: [{ type: "text", text: "Describe the fixture.", text_elements: [] }] } });
          }
          if (message.method === "turn/completed") { clearTimeout(timer); resolve(); }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "refusal_test", version: "1" }, capabilities: { experimentalApi: true } } });
    });
    assert.equal(requests.length, 1, "拒答後不應自動重送同一份提示詞");
    assert.match(JSON.stringify(notifications), /Fixture request declined/);
    assert.notEqual(notifications.find((message) => message.method === "turn/completed")?.params?.turn?.status, "completed");
  } finally {
    app.kill();
    await exited;
    server.closeAllConnections();
    server.close();
  }
});
