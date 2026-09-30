import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import { loadPayloads } from "./helpers/payloads.mjs";
import { codexBin } from "./helpers/codex-bin.mjs";
import { fetchClaudeCli, claudeCliEnvironment } from "../src/claude-cli.mjs";

test("real Codex executes a Claude CLI tool call and receives the final response", {
  skip: !codexBin || !process.env.TEST_CLAUDE_CLI_BIN, timeout: 45000,
}, async (t) => {
  const { bridge, installer } = await loadPayloads();
  const home = mkdtempSync(join(tmpdir(), "router-cli-codex-e2e-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_MODEL_ROUTER_IMPORT_ONLY;
  const bundled = JSON.parse(execFileSync(codexBin, ["debug", "models", "--bundled"], { env, cwd: home, encoding: "utf8" }));
  const route = { pickerSlug: "custom/claude-cli-e2e", upstreamModel: "claude-opus-4-6", displayName: "claude-cli/fixture",
    transport: "claude-cli", providerHost: "fixture", efforts: ["medium"], translate: "anthropic", contextWindow: 200000 };
  const model = installer.customCatalogEntry(bundled.models, route, 0);
  delete model.tool_mode;
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" }); res.end('{"input_tokens":100}'); return;
    }
    const parsed = JSON.parse(body);
    upstreamRequests.push(parsed);
    const tool = parsed.tools.find((tool) => tool.description?.split("\n")[0].endsWith("exec_command"));
    const final = upstreamRequests.length > 1;
    const block = (index, start, deltas) => [
      { type: "content_block_start", index, content_block: start },
      ...deltas.map((delta) => ({ type: "content_block_delta", index, delta })),
      { type: "content_block_stop", index },
    ];
    // 第一輪：先寫一句進度再呼叫工具；第二輪：思考摘要加最終答案。
    const content = final
      ? [...block(0, { type: "thinking", thinking: "" }, [{ type: "thinking_delta", thinking: "Checking the echoed output." },
        { type: "signature_delta", signature: "fixture-signature" }]),
        ...block(1, { type: "text", text: "" }, [{ type: "text_delta", text: "CLI roundtrip verified." }])]
      : [...block(0, { type: "text", text: "" }, [{ type: "text_delta", text: "Running the echo check first." }]),
        ...block(1, { type: "tool_use", id: "toolu_echo", name: tool?.name || "missing_exec_command", input: {} },
          [{ type: "input_json_delta", partial_json: '{"cmd":"echo router-cli-ok"}' }])];
    const events = [
      { type: "message_start", message: { id: `msg_${upstreamRequests.length}`, type: "message", role: "assistant", content: [],
        model: route.upstreamModel, stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } },
      ...content,
      { type: "message_delta", delta: { stop_reason: final ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const cliEnv = { ...claudeCliEnvironment(), CLAUDE_CONFIG_DIR: join(home, "claude"),
    ANTHROPIC_API_KEY: "fixture-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, CLAUDE_CODE_MAX_RETRIES: "0" };
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "zstd") body = zstdDecompressSync(body);
      if (!req.url.includes("/responses")) { res.end(JSON.stringify({ models: [model] })); return; }
      if (!body.length) { res.writeHead(426); res.end(); return; }
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const translated = bridge.toAnthropicRequest(parsed, route);
      const response = await fetchClaudeCli(translated.request, { binary: process.env.TEST_CLAUDE_CLI_BIN, timeoutMs: 12000 }, null, { env: cliEnv });
      res.writeHead(200, { "content-type": "text/event-stream" });
      await bridge.bridgeAnthropicStream(response.body, (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
        { ...translated, model: parsed.model, requestBody: parsed });
      res.end();
    } catch { res.destroy(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
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
  let pending = "";
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CLI/Codex roundtrip timeout")), 25000);
      app.once("error", (error) => { clearTimeout(timer); reject(error); });
      app.stdout.setEncoding("utf8");
      app.stdout.on("data", (data) => {
        pending += data;
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const message = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
          notifications.push(message);
          if (message.error) { clearTimeout(timer); reject(new Error(JSON.stringify(message.error))); }
          if (message.id === 1) { send({ method: "initialized" }); send({ id: 2, method: "thread/start", params: {
            cwd: home, model: model.slug, ephemeral: true, approvalPolicy: "never" } }); }
          if (message.id === 2 && message.result) send({ id: 3, method: "turn/start", params: { threadId: message.result.thread.id,
            input: [{ type: "text", text: "Run echo router-cli-ok using exec_command, then confirm.", text_elements: [] }] } });
          if (message.method === "turn/completed") { clearTimeout(timer); resolve(); }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "cli_test", version: "1" }, capabilities: { experimentalApi: true } } });
    });
    assert.equal(requests.length, 2, JSON.stringify(notifications.filter((n) => /error|turn\/completed/.test(n.method || ""))));
    assert.equal(upstreamRequests.length, 2);
    assert.ok(upstreamRequests[1].messages.some((message) => message.role === "user"
      && JSON.stringify(message.content).includes("router-cli-ok") && JSON.stringify(message.content).includes("tool_result")));
    assert.match(JSON.stringify(notifications), /CLI roundtrip verified/);
    assert.equal(notifications.find((n) => n.method === "turn/completed")?.params?.turn?.status, "completed");
    // Codex 桌面版收到的階段標記：工具前的文字是進度更新，最後一段是最終答案。
    const completedItems = notifications.filter((n) => n.method === "item/completed").map((n) => n.params.item);
    // 串流時一律先以進度更新開始（無法預知後面是否還有工具呼叫），完成時才定案。
    assert.ok(notifications.filter((n) => n.method === "item/started" && n.params.item.type === "agentMessage")
      .every((n) => n.params.item.phase === "commentary"));
    assert.deepEqual(completedItems.filter((item) => item.type === "agentMessage").map((item) => [item.text, item.phase]),
      [["Running the echo check first.", "commentary"], ["CLI roundtrip verified.", "final_answer"]]);
    assert.match(JSON.stringify(completedItems.filter((item) => item.type === "reasoning")), /Checking the echoed output\./,
      "the thinking summary reaches Codex");
    assert.ok(upstreamRequests.every((request) => request.thinking?.display === "summarized"), JSON.stringify(upstreamRequests.map((r) => r.thinking)));
    assert.ok(upstreamRequests.every((request) => JSON.stringify(request.system).includes("Notes for Claude models in Codex")));
  } finally { app.kill(); await exited; }
});
