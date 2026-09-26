// 真的 Codex 執行器 + Chat Completions 轉譯的兩個方向；登入與上游都是假的，不做推論。
//
// 假上游收到 Codex 的 Responses 請求後，用 toChatRequest 轉成 Chat Completions（這就是
// 會送往 DeepSeek 等供應商的內容），再把合成的 Chat Completions 串流經 bridgeChatStream
// 轉回 Responses 事件交給 Codex。驗的是整個工具往返：Codex 真的執行了模型要求的工具，
// 下一輪的請求裡工具呼叫、結果與推理都以 Chat Completions 接受的形狀出現。
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

const bin = codexBin;
const route = {
  pickerSlug: "custom/chat-fixture", upstreamModel: "deepseek-chat", displayName: "api/deepseek-chat",
  providerHost: "gateway.example", efforts: [], stripReasoning: true, contextWindow: 128000,
  translate: "chat", chatTools: true, chatStreamOptions: true,
};

test("Chat Completions 路由完成一次工具往返：Codex 執行工具，下一輪帶回呼叫、結果與推理", { skip: !bin, timeout: 30000 }, async () => {
  const { chat, installer } = await loadPayloads();
  const home = mkdtempSync(join(tmpdir(), "router-chat-e2e-"));
  const env = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_MODEL_ROUTER_IMPORT_ONLY;
  const bundled = JSON.parse(execFileSync(bin, ["debug", "models", "--bundled"], { env, cwd: home, encoding: "utf8" }));
  // 用安裝器真正會寫進目錄的項目：它會拿 Code Mode 的官方模型當模板，
  // Chat Completions 路由要把它改回一般函式工具。
  const model = installer.customCatalogEntry(bundled.models.filter((item) => !item.slug.startsWith("custom/")), route, 0);
  const captures = [];
  const failures = [];
  const calls = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let data = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "zstd") data = zstdDecompressSync(data);
      if (!req.url.includes("/responses")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [model] }));
        return;
      }
      if (!data.length) { res.writeHead(426); res.end(); return; }
      const body = JSON.parse(data.toString());
      const ctx = chat.toChatRequest(body, route);
      captures.push({ body, ctx });
      const step = captures.length;
      assert.ok(step <= 2, "unexpected retry or extra inference");
      const alias = ctx.request.tools?.find((tool) => tool.function.name.endsWith("lookup"))?.function.name;
      const upstream = step === 1
        ? [
          { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "需要查資料" } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_fixture", type: "function",
            function: { name: alias, arguments: "{\"city\":\"Taipei\"," } }] } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"options\":{\"ids\":[\"a\",\"b\"]}}" } }] },
            finish_reason: "tool_calls" }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
        ]
        : [
          { choices: [{ index: 0, delta: { content: "fixture done" }, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } },
        ];
      async function* stream() {
        yield Buffer.from(upstream.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      await chat.bridgeChatStream(stream(), (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
        { ...ctx, model: body.model, requestBody: body });
      res.end();
    } catch (error) {
      failures.push(error);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(join(home, "models.json"), JSON.stringify({ models: [model] }));
  writeFileSync(join(home, "config.toml"), `model = "${model.slug}"\nmodel_catalog_json = ${JSON.stringify(join(home, "models.json"))}\nopenai_base_url = "http://127.0.0.1:${server.address().port}/v1"\n[features]\napps = false\nplugins = false\n`);
  const jwt = "e30." + Buffer.from(JSON.stringify({ sub: "fixture", email: "fixture@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture", chatgpt_plan_type: "plus", chatgpt_user_id: "fixture" } })).toString("base64url") + ".fake";
  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", last_refresh: new Date().toISOString(),
    tokens: { access_token: jwt, id_token: jwt, refresh_token: "fake", account_id: "fixture" } }));
  const tool = { type: "function", name: "lookup", description: "Read the fixture.", deferLoading: false,
    inputSchema: { type: "object", properties: { city: { type: "string" },
      options: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
    required: ["city", "options"] } };
  const app = spawn(bin, ["app-server"], { env, cwd: home, stdio: ["pipe", "pipe", "ignore"] });
  const exited = once(app, "exit");
  const send = (message) => app.stdin.write(JSON.stringify(message) + "\n");
  let buffer = "";
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("chat e2e timeout")), 20000);
      app.once("error", (error) => { clearTimeout(timer); reject(error); });
      app.stdout.on("data", (data) => {
        buffer += data;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (message.error) { clearTimeout(timer); reject(new Error(JSON.stringify(message.error))); }
          if (message.id === 1) {
            send({ method: "initialized" });
            send({ id: 2, method: "thread/start", params: { cwd: home, model: model.slug, ephemeral: true, approvalPolicy: "never",
              dynamicTools: [{ type: "namespace", name: "research_fixture", description: "Fixture lookup", tools: [tool] }] } });
          }
          if (message.id === 2 && message.result) {
            send({ id: 3, method: "turn/start", params: { threadId: message.result.thread.id,
              input: [{ type: "text", text: "Read the fixture.", text_elements: [] }] } });
          }
          if (message.method === "item/tool/call") {
            calls.push(message.params);
            send({ id: message.id, result: { success: true, contentItems: [{ type: "inputText", text: "FIXTURE_RESULT_OK" }] } });
          }
          if (message.method === "turn/completed") {
            clearTimeout(timer);
            try { assert.equal(message.params.turn.status, "completed"); resolve(); } catch (error) { reject(error); }
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "chat_test", version: "1" }, capabilities: { experimentalApi: true } } });
    });
    assert.deepEqual(failures, []);
    assert.equal(captures.length, 2);
    const names = captures[0].ctx.request.tools.map((tool) => tool.function.name);
    assert.ok(names.includes("exec_command") && !names.includes("exec"), `應該是一般函式工具，而不是 Code Mode：${names}`);
    const patch = captures[0].ctx.request.tools.find((tool) => tool.function.name === "apply_patch");
    assert.deepEqual(patch.function.parameters.required, ["input"]);
    assert.match(patch.function.description, /\*\*\* Begin Patch/, "apply_patch 的文法要併進說明");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].namespace, "research_fixture");
    assert.equal(calls[0].tool, "lookup");
    assert.deepEqual(calls[0].arguments, { city: "Taipei", options: { ids: ["a", "b"] } });

    const messages = captures[1].ctx.request.messages;
    const assistant = messages.find((message) => message.tool_calls);
    assert.equal(assistant.reasoning_content, "需要查資料");
    assert.deepEqual(assistant.tool_calls.map((item) => [item.id, item.function.name]),
      [["call_fixture", "research_fixture__lookup"]]);
    const toolMessage = messages[messages.indexOf(assistant) + 1];
    assert.equal(toolMessage.role, "tool");
    assert.equal(toolMessage.tool_call_id, "call_fixture");
    assert.match(toolMessage.content, /FIXTURE_RESULT_OK/);
  } finally {
    app.kill();
    await exited;
    server.closeAllConnections();
    server.close();
  }
});
