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

test("各模型的首次輸出與總耗時取平均，TPS 取中位數，各自採計有數值的請求", () => {
  const { models, total } = installer.summarizeUsage([
    { model: "custom/a", durationMs: 3000, firstOutputMs: 1000, firstTextMs: 1500, generationMs: 1800, outputTps: 10 },
    { model: "custom/a", durationMs: 10000, firstOutputMs: null, firstTextMs: 3000, generationMs: 6500, outputTps: 50 },
    { model: "custom/a", durationMs: 0, firstOutputMs: 0, status: "failed", outputTps: null },
    { model: "custom/a", firstOutputMs: -1, outputTps: -1 },
    { model: "custom/b", durationMs: 7000, firstOutputMs: null, outputTps: null },
    { model: "custom/c", durationMs: null },
    { model: "custom/d", durationMs: 4000, firstOutputMs: 1000, firstTextMs: null, generationMs: 2500, outputTps: 500 },
    { model: "custom/d", durationMs: 5000, firstOutputMs: 2000, firstTextMs: null, hasText: true, generationMs: 2500, outputTps: 20 },
  ]);
  const a = models.find((item) => item.model === "custom/a");
  const b = models.find((item) => item.model === "custom/b");
  const c = models.find((item) => item.model === "custom/c");
  const d = models.find((item) => item.model === "custom/d");
  assert.equal(a.avgDurationMs, 13000 / 3);
  assert.equal(a.avgFirstOutputMs, 4000 / 3);
  assert.equal(a.medianOutputTps, 30);
  assert.equal(a.outputTpsSamples, 2);
  assert.equal(b.avgDurationMs, 7000);
  assert.equal(b.avgFirstOutputMs, null);
  assert.equal(b.medianOutputTps, null);
  assert.equal(c.avgDurationMs, null);
  assert.equal(d.avgFirstOutputMs, 1500);
  assert.equal(d.medianOutputTps, 20);
  assert.equal(total.avgDurationMs, 29000 / 6);
  assert.equal(total.avgFirstOutputMs, 7000 / 5);
});

test("舊版使用記錄依新規則重算 TPS；各模型的中位數不受少數極端值影響", () => {
  const legacy = (fields) => ({ model: "custom/x", hasText: true, outputTps: 129000, ...fields });
  const { models } = installer.summarizeUsage([
    // 中轉站把整段一次送出：首次輸出到結束只有 3 毫秒，量不到生成速度。
    legacy({ durationMs: 8980, firstOutputMs: 8977, firstTextMs: 8977, output: 387, reasoning: 166 }),
    // 推理沒有串流：隱藏的 500 個推理 tokens 不計入，(1001 − 1) ÷ 10 秒。
    legacy({ durationMs: 12000, firstOutputMs: 2000, firstTextMs: 2000, output: 1501, reasoning: 500 }),
    // 先串流思考再出正文：推理 tokens 也在視窗內，(601 − 1) ÷ 10 秒。
    legacy({ durationMs: 12000, firstOutputMs: 2000, firstTextMs: 7000, output: 601, reasoning: 300 }),
    { model: "custom/x", hasText: true, generationMs: 1000, outputTps: 80 },
    // 原本就沒有 TPS 的紀錄（例如整段一次送達的 CLI 回覆）維持不計算。
    { model: "custom/x", hasText: true, outputTps: null, durationMs: 5000, firstOutputMs: 1000, output: 500 },
  ]);
  assert.equal(models[0].medianOutputTps, 80);
  assert.equal(models[0].outputTpsSamples, 3);
});

test("趨勢小圖的時間區段", () => {
  const since = Date.parse("2026-11-25T00:00:00Z");
  const at = (hours) => new Date(since + hours * 3600000).toISOString();
  const series = installer.usageSeries([
    { at: at(0.5), status: "completed", input: 100, cached: 80, output: 10, durationMs: 2000 },
    { at: at(0.9), status: "failed", durationMs: 1000 },
    { at: at(23.99), status: "completed", input: 50, cached: 50 },
    { at: at(30), status: "completed" },
    { at: "invalid" },
  ], since, since + 24 * 3600000);
  assert.equal(series.length, 24);
  assert.deepEqual(series[0], { requests: 2, failed: 1, input: 100, cached: 80, output: 10, durationMs: 3000, durationSamples: 2 });
  assert.equal(series[23].requests, 1);
  assert.equal(series.reduce((sum, bucket) => sum + bucket.requests, 0), 3);
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
          // 視窗要超過 0.5 秒才算得出 TPS；更短的多半是整段一次送達。
          await delay(520);
          send(delta("response.output_text.delta", " continued"));
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
  // 串流的思考就是第一段輸出；TPS 從那裡算到最後一段串流輸出，推理 tokens 也在視窗內。
  assert.ok(record.firstTextMs - record.firstOutputMs >= 15);
  assert.ok(record.generationMs >= 530);
  assert.ok(record.generationMs <= record.durationMs - record.firstOutputMs);
  assert.equal(record.outputTps, 29000 / record.generationMs);

  toolOnly = true;
  const toolResponse = await sendRequest();
  assert.equal(toolResponse.status, 200);
  await toolResponse.text();
  const updated = readFileSync(path, "utf8");
  assert.ok(!updated.includes("private tool input"));
  const toolRecord = JSON.parse(updated.trim().split("\n").at(-1));
  assert.equal(toolRecord.firstTextMs, null);
  assert.ok(toolRecord.durationMs - toolRecord.firstOutputMs >= 30, "streamed thinking starts the output clock");
  assert.equal(toolRecord.output, 30);
  assert.equal(toolRecord.outputTps, null);
});
