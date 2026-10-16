// 背景任務模型：Codex 固定用官方小模型跑任務標題、後續建議、分支描述與記憶整理。
// 選了代答模型時，路由器只把這些背景任務改送第三方模型；一般對話不受影響。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { loadRouterInDir } from "./helpers/payloads.mjs";

const customRoute = {
  pickerSlug: "custom/owo-gpt", upstreamModel: "gpt-6.1-sol", displayName: "owo/gpt-6.1-sol",
  providerHost: "gateway.example", efforts: ["low", "medium", "high"], stripReasoning: false, contextWindow: null,
};
const userText = (text) => [{ type: "message", role: "user", content: [{ type: "input_text", text }] }];
const titlePrompt = "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.";

async function setup(t) {
  const { dir, router } = await loadRouterInDir({ upstreamWebSocket: false, routes: [customRoute] });
  const path = join(dir, "background-model.json");
  t.after(() => rmSync(path, { force: true }));
  return { router, choose: (model) => writeFileSync(path, JSON.stringify({ model })), clear: () => rmSync(path, { force: true }), dir };
}

test("辨認 Codex 固定的背景任務提示詞，一般對話與自訂模型不算", async (t) => {
  const { router } = await setup(t);
  const kind = (body) => router.backgroundTaskKind(body);
  assert.equal(kind({ model: "gpt-6-luna", input: userText(titlePrompt) }), "title");
  assert.equal(kind({ model: "gpt-6-luna", input: userText("# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do") }), "suggestions");
  assert.equal(kind({ model: "gpt-6-luna", input: userText("You are in a fork of an existing Codex thread.\nFill the structured description field") }), "fork-description");
  assert.equal(kind({ model: "gpt-5.6-terra", input: userText("## Memory Writing Agent: Phase 2 (Consolidation)") }), "memory");
  assert.equal(kind({ model: "gpt-5.6-terra", instructions: "Consolidate the supplied rollout summaries into `memory_summary.md` so another" }), "memory");
  assert.equal(kind({ model: "gpt-6-luna", input: userText("幫我取個標題") }), null);
  assert.equal(kind({ model: "gpt-6.1-sol", input: userText("hello " + titlePrompt) }), null);
  assert.equal(kind({ model: "custom/owo-gpt", input: userText(titlePrompt) }), null);
});

test("選了代答模型才改送；模型已刪除或未設定時維持原樣", async (t) => {
  const { router, choose, clear } = await setup(t);
  const body = { model: "gpt-6-luna", input: userText(titlePrompt) };
  assert.equal(router.applyBackgroundModel(body), body);
  choose("custom/owo-gpt");
  assert.equal(router.applyBackgroundModel(body).model, "custom/owo-gpt");
  const normal = { model: "gpt-6.1-sol", input: userText("hi") };
  assert.equal(router.applyBackgroundModel(normal), normal);
  choose("custom/deleted-model");
  assert.equal(router.applyBackgroundModel(body), body);
  clear();
  assert.equal(router.applyBackgroundModel(body), body);
});

test("記憶整理與其他背景任務分開設定", async (t) => {
  const { router, dir } = await setup(t);
  const twoRoutes = [customRoute, { ...customRoute, pickerSlug: "custom/cheap", upstreamModel: "cheap" }];
  // 路由表在載入時建立；這裡用只有一條路由的實例驗證「沒設定的種類維持官方」。
  writeFileSync(join(dir, "background-model.json"), JSON.stringify({ light: null, memory: "custom/owo-gpt" }));
  const title = { model: "gpt-6-luna", input: userText(titlePrompt) };
  const memory = { model: "gpt-5.6-terra", input: userText("## Memory Writing Agent: Phase 2") };
  assert.equal(router.applyBackgroundModel(title), title);
  assert.equal(router.applyBackgroundModel(memory).model, "custom/owo-gpt");
  writeFileSync(join(dir, "background-model.json"), JSON.stringify({ light: "custom/owo-gpt", memory: null }));
  assert.equal(router.applyBackgroundModel(title).model, "custom/owo-gpt");
  assert.equal(router.applyBackgroundModel(memory), memory);
  assert.equal(twoRoutes.length, 2);
});

test("大小相同、修改時間也相同的改寫一樣會生效（Windows 同一時間刻度內的連續寫入）", async (t) => {
  const { router, dir } = await setup(t);
  const path = join(dir, "background-model.json");
  const before = JSON.stringify({ light: null, memory: "custom/owo-gpt" });
  const after = JSON.stringify({ light: "custom/owo-gpt", memory: null });
  assert.equal(before.length, after.length);
  const title = { model: "gpt-6-luna", input: userText(titlePrompt) };
  writeFileSync(path, before);
  const { atime, mtime } = statSync(path);
  assert.equal(router.applyBackgroundModel(title), title);
  writeFileSync(path, after);
  utimesSync(path, atime, mtime);
  assert.equal(router.applyBackgroundModel(title).model, "custom/owo-gpt");
});

test("使用記錄：完成、失敗與沒有用量的終止事件都記成一筆，非終止事件不記", async (t) => {
  const { router } = await setup(t);
  const context = { startedAt: 1000, model: "custom/owo-gpt", route: "custom", provider: "owo", transport: "websocket",
    backgroundKind: "title", thread: "th-1" };
  const done = router.usageRecord(context, { type: "response.completed", response: { model: "gpt-6.1-sol",
    usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 900, cache_write_tokens: 100 }, output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 20 } } } }, 3500);
  assert.deepEqual({ ...done, at: undefined }, { at: undefined, model: "custom/owo-gpt", upstreamModel: "gpt-6.1-sol", route: "custom",
    provider: "owo", transport: "websocket", background: "title", thread: "th-1", status: "completed", durationMs: 2500,
    input: 1200, cached: 900, cacheWrite: 100, output: 50, reasoning: 20, hasUsage: true });
  const failed = router.usageRecord(context, { type: "response.failed", response: { error: { code: "rate_limit_exceeded" } } }, 2000);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "rate_limit_exceeded");
  assert.equal(failed.hasUsage, false);
  assert.equal(router.usageRecord(context, { type: "response.output_text.delta" }), null);
});

test("背景任務經過路由器時改送第三方上游，API Key 模式下也不被擋", async (t) => {
  const previous = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-provider-key";
  t.after(() => { if (previous === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY; else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previous; });
  const { router, choose, dir } = await setup(t);
  choose("custom/owo-gpt");
  const { createHash } = await import("node:crypto");
  const key = "sk-codex-router-quota-" + "cd".repeat(24);
  const quotaPath = join(dir, "quota-mode.json");
  writeFileSync(quotaPath, JSON.stringify({ enabled: true, keySha256: createHash("sha256").update(key).digest("hex") }));
  t.after(() => rmSync(quotaPath, { force: true }));
  router.routerServer.listen(0, "127.0.0.1");
  await once(router.routerServer, "listening");
  t.after(() => new Promise((resolve) => router.routerServer.close(resolve)));
  const origin = `http://127.0.0.1:${router.routerServer.address().port}`;
  const realFetch = globalThis.fetch;
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    sent.push({ href: String(url), body: options.body ? JSON.parse(options.body) : null });
    return new Response(JSON.stringify({ id: "resp_1", object: "response", status: "completed", output: [], model: "gpt-6.1-sol" }),
      { headers: { "content-type": "application/json" } });
  });
  const response = await realFetch(origin + "/v1/responses", {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6-luna", input: userText(titlePrompt), stream: false }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const upstream = sent.filter((call) => call.href.startsWith("https://gateway.example"));
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0].body.model, "gpt-6.1-sol");
});
