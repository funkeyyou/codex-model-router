// 真實 Codex 執行 Code Mode 的 notify()，再經 Claude 轉譯。上游與登入都是假的，不連網。
// 需要 CODEX_MODEL_ROUTER_TEST_CODEX_BIN 指向 codex 執行檔，否則略過。
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
import { assertAnthropicToolPairing } from "./helpers/anthropic-rules.mjs";

const bin = process.env.CODEX_MODEL_ROUTER_TEST_CODEX_BIN;
const CALL_ID = "toolu_notify_e2e";
const MARKERS = ["NOTIFY_ONE", "NOTIFY_TWO", "NOTIFY_THREE", "FINAL_OUTPUT"];

test("Code Mode notify() 的多筆輸出經 Claude 轉譯後只剩一個 tool_result", { skip: !bin, timeout: 30000 }, async () => {
  const { bridge } = await loadPayloads();
  const home = mkdtempSync(join(tmpdir(), "router-notify-e2e-"));
  const env = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_MODEL_ROUTER_IMPORT_ONLY;
  const bundled = JSON.parse(execFileSync(bin, ["debug", "models", "--bundled"], { env, cwd: home, encoding: "utf8" }));
  const model = {
    ...bundled.models.find((m) => m.visibility === "list"),
    slug: "custom/notify-fixture", tool_mode: "code_mode_only", supports_search_tool: false,
  };
  const code = MARKERS.slice(0, 3).map((marker) => `notify("${marker}");`).join(" ") + ` text("${MARKERS[3]}");`;
  const captures = [], failures = [];
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
      const ctx = bridge.toAnthropicRequest(body, { upstreamModel: "claude-fixture" });
      captures.push({ body, ctx });
      const step = captures.length;
      assert.ok(step <= 2, "unexpected retry or extra inference");
      const block = step === 1
        ? { type: "tool_use", id: CALL_ID, name: "exec", input: {} }
        : { type: "text", text: "" };
      const events = [
        { type: "message_start", message: { id: `msg_${step}`, type: "message", role: "assistant", content: [], model: "claude-fixture", usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: block },
        { type: "content_block_delta", index: 0, delta: step === 1
          ? { type: "input_json_delta", partial_json: JSON.stringify({ input: code }) }
          : { type: "text_delta", text: "fixture done" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: step === 1 ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      async function* stream() {
        yield Buffer.from(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      await bridge.bridgeAnthropicStream(stream(), (e) => res.write(`data: ${JSON.stringify(e)}\n\n`), { ...ctx, model: body.model, requestBody: body });
      res.end();
    } catch (error) { failures.push(error); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(join(home, "models.json"), JSON.stringify({ models: [model] }));
  writeFileSync(join(home, "config.toml"), `model = "${model.slug}"\nmodel_catalog_json = ${JSON.stringify(join(home, "models.json"))}\nopenai_base_url = "http://127.0.0.1:${server.address().port}/v1"\n[features]\napps = false\nplugins = false\n`);
  const jwt = "e30." + Buffer.from(JSON.stringify({ sub: "fixture", email: "fixture@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "fixture", chatgpt_plan_type: "plus", chatgpt_user_id: "fixture" } })).toString("base64url") + ".fake";
  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", last_refresh: new Date().toISOString(), tokens: { access_token: jwt, id_token: jwt, refresh_token: "fake", account_id: "fixture" } }));
  const app = spawn(bin, ["app-server"], { env, cwd: home, stdio: ["pipe", "pipe", "ignore"] });
  const exited = once(app, "exit");
  const send = (message) => app.stdin.write(JSON.stringify(message) + "\n");
  let buffer = "";
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("notify e2e timeout")), 20000);
      app.once("error", (error) => { clearTimeout(timer); reject(error); });
      app.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (message.error) { clearTimeout(timer); reject(new Error(JSON.stringify(message.error))); }
          if (message.id === 1) {
            send({ method: "initialized" });
            send({ id: 2, method: "thread/start", params: { cwd: home, model: model.slug, ephemeral: true, approvalPolicy: "never" } });
          }
          if (message.id === 2 && message.result) {
            send({ id: 3, method: "turn/start", params: { threadId: message.result.thread.id, input: [{ type: "text", text: "Report progress.", text_elements: [] }] } });
          }
          if (message.method === "turn/completed") {
            clearTimeout(timer);
            try { assert.equal(message.params.turn.status, "completed"); resolve(); } catch (error) { reject(error); }
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "notify_test", version: "1" }, capabilities: { experimentalApi: true } } });
    });
    assert.deepEqual(failures, []);
    assert.equal(captures.length, 2);
    // Codex 本身確實替同一個 call_id 送出多筆輸出——這正是 Anthropic 會拒收的輸入形狀。
    const outputs = captures[1].body.input.filter((item) => item?.call_id === CALL_ID && /_output$/.test(item.type));
    assert.ok(outputs.length > 1, `預期 Codex 送出多筆輸出，實際 ${outputs.length} 筆`);
    const { request, toolOutputsMerged, lateToolOutputs } = captures[1].ctx;
    assertAnthropicToolPairing(request.messages);
    const results = request.messages.flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result" && block.tool_use_id === CALL_ID);
    assert.equal(results.length, 1);
    const merged = JSON.stringify(results[0].content);
    for (const marker of MARKERS) assert.ok(merged.includes(marker), `合併後的結果缺少 ${marker}`);
    assert.equal(toolOutputsMerged, outputs.length - 1);
    assert.equal(lateToolOutputs, 0);
  } finally {
    app.kill();
    await exited;
    server.closeAllConnections();
    server.close();
  }
});
