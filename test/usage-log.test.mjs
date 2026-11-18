// 模型使用記錄：路由器每一輪寫一筆到 usage.jsonl，管理頁彙整各模型的 token、快取命中率與耗時。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadPayloads, loadRouterInDir } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();

test("summarizeUsage 依模型彙整並計算快取命中率", () => {
  const summary = installer.summarizeUsage([
    { model: "custom/a", route: "custom", provider: "owo", status: "completed", input: 1000, cached: 800, cacheWrite: 0, output: 100, reasoning: 10, durationMs: 2000 },
    { model: "custom/a", route: "custom", provider: "owo", status: "failed", input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, durationMs: 500 },
    { model: "gpt-6-luna", route: "official", status: "completed", input: 200, cached: 0, cacheWrite: 0, output: 20, reasoning: 0, durationMs: 300, background: "title" },
  ]);
  assert.equal(summary.total.requests, 3);
  assert.equal(summary.total.failed, 1);
  assert.equal(summary.total.input, 1200);
  assert.equal(summary.total.cacheHitRate, 800 / 1200);
  const a = summary.models.find((item) => item.model === "custom/a");
  assert.equal(a.requests, 2);
  assert.equal(a.cacheHitRate, 0.8);
  assert.equal(a.avgDurationMs, 1250);
  assert.equal(summary.models.find((item) => item.model === "gpt-6-luna").background, 1);
  assert.equal(installer.summarizeUsage([]).total.cacheHitRate, null);
});

test("各模型的三項效能平均分別採計有數值的請求", () => {
  const { models, total } = installer.summarizeUsage([
    { model: "custom/a", durationMs: 3000, firstOutputMs: 1000, firstTextMs: 1500, outputTps: 10 },
    { model: "custom/a", durationMs: 10000, firstOutputMs: null, firstTextMs: 3000, outputTps: 50 },
    { model: "custom/a", durationMs: 0, firstOutputMs: 0, status: "failed", outputTps: null },
    { model: "custom/a", firstOutputMs: -1, outputTps: -1 },
    { model: "custom/b", durationMs: 7000, firstOutputMs: null, outputTps: null },
    { model: "custom/c", durationMs: null },
  ]);
  const a = models.find((item) => item.model === "custom/a");
  const b = models.find((item) => item.model === "custom/b");
  const c = models.find((item) => item.model === "custom/c");
  assert.equal(a.avgDurationMs, 13000 / 3);
  assert.equal(a.avgFirstOutputMs, 4000 / 3);
  assert.equal(a.avgOutputTps, 30);
  assert.equal(b.avgDurationMs, 7000);
  assert.equal(b.avgFirstOutputMs, null);
  assert.equal(b.avgOutputTps, null);
  assert.equal(c.avgDurationMs, null);
  assert.equal(total.avgDurationMs, 5000);
});

test("經過路由器的一輪會寫進 usage.jsonl，不含提示詞內容", async (t) => {
  const previous = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-provider-key";
  t.after(() => { if (previous === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY; else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previous; });
  const route = { pickerSlug: "custom/owo-gpt", upstreamModel: "gpt-6.1-sol", displayName: "owo/gpt-6.1-sol",
    providerHost: "gateway.example", efforts: ["low"], stripReasoning: false, contextWindow: null };
  const { dir, router } = await loadRouterInDir({ upstreamWebSocket: false, routes: [route] });
  router.routerServer.listen(0, "127.0.0.1");
  await once(router.routerServer, "listening");
  t.after(() => new Promise((resolve) => router.routerServer.close(resolve)));
  const origin = `http://127.0.0.1:${router.routerServer.address().port}`;
  const realFetch = globalThis.fetch;
  const secret = "這段提示詞不該出現在使用記錄裡";
  const result = { id: "resp_1", object: "response", status: "completed", output: [], model: "gpt-6.1-sol",
    usage: { input_tokens: 500, input_tokens_details: { cached_tokens: 400 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 5 } } };
  const delta = (type, text) => `data: ${JSON.stringify({ type, delta: text })}\n\n`;
  let toolOnly = false;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/models")) return new Response("missing client_version", { status: 400 });
    return new Response(new ReadableStream({
      async start(controller) {
        const send = (text) => controller.enqueue(Buffer.from(text));
        send(delta("response.reasoning_summary_text.delta", "private reasoning"));
        await delay(20);
        if (toolOnly) {
          send(`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "custom_tool_call", input: "" } })}\n\n`);
          send(delta("response.custom_tool_call_input.delta", "private tool input"));
        } else {
          send(delta("response.output_text.delta", "private output"));
        }
        await delay(20);
        send(`data: ${JSON.stringify({ type: "response.completed", response: result })}\n\n`);
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });
  });
  const path = join(dir, "usage.jsonl");
  const yesterday = new Date(Date.now() - 86400000);
  writeFileSync(path, JSON.stringify({ at: yesterday.toISOString(), model: "previous-day" }) + "\n");
  utimesSync(path, yesterday, yesterday);
  const sendRequest = () => realFetch(origin + "/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer fixture", "chatgpt-account-id": "acct", "session-id": "usage-test", "content-type": "application/json" },
    body: JSON.stringify({ model: "custom/owo-gpt", input: secret, stream: true }),
  });
  const response = await sendRequest();
  assert.equal(response.status, 200, await response.clone().text());
  await response.text();
  assert.ok(existsSync(path));
  const text = readFileSync(path, "utf8");
  for (const privateText of [secret, "private reasoning", "private output"]) assert.ok(!text.includes(privateText));
  const archive = readdirSync(dir).find((name) => name.startsWith("usage.jsonl." + yesterday.toISOString().slice(0, 10)));
  assert.equal(JSON.parse(readFileSync(join(dir, archive), "utf8")).model, "previous-day");
  const record = JSON.parse(text.trim().split("\n").pop());
  assert.equal(record.model, "custom/owo-gpt");
  assert.equal(record.status, "completed");
  assert.equal(record.input, 500);
  assert.equal(record.cached, 400);
  assert.equal(record.output, 30);
  assert.equal(record.thread, "usage-test");
  assert.ok(record.firstTextMs >= 15);
  assert.ok(record.durationMs - record.firstTextMs >= 15);
  assert.equal(record.outputTps, 30000 / (record.durationMs - record.firstTextMs));
  assert.equal(record.firstOutputMs, record.firstTextMs);

  toolOnly = true;
  const toolResponse = await sendRequest();
  assert.equal(toolResponse.status, 200);
  await toolResponse.text();
  const updated = readFileSync(path, "utf8");
  assert.ok(!updated.includes("private tool input"));
  const toolRecord = JSON.parse(updated.trim().split("\n").at(-1));
  assert.equal(toolRecord.firstTextMs, null);
  assert.ok(toolRecord.firstOutputMs >= 15);
  assert.equal(toolRecord.outputTps, 30000 / (toolRecord.durationMs - toolRecord.firstOutputMs));
});
