// 模型的上下文與輸出設定：網頁顯示的輸出要與 Claude 轉譯實際送出的 max_tokens 一致，
// 修改時不能超過上游回報的上限，新增模型的預設值（1M／128000）遇到較小的上游上限時以上游為準。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer, bridge, managerPage } = await loadPayloads();
const userMessage = { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] };
const sentMaxTokens = (route) => bridge.toAnthropicRequest({ input: [userMessage], reasoning: { effort: "high" } },
  { upstreamModel: "claude-x", effortControl: "output_config", ...route }).request.max_tokens;

test("網頁顯示的輸出與 Claude 轉譯實際送出的 max_tokens 相同", () => {
  const cases = [
    {},
    { maxOutputTokens: 128000 },
    { maxOutputTokens: 16000 },
    { maxOutputTokens: 128000, defaultMaxOutputTokens: 128000 },
    { maxOutputTokens: 64000, defaultMaxOutputTokens: 128000 },
    { defaultMaxOutputTokens: 96000 },
    { maxOutputTokens: 32000, defaultMaxOutputTokens: 4000 },
    { maxOutputTokens: 2048 },
    { defaultMaxOutputTokens: 4096 },
  ];
  for (const fields of cases) {
    const route = { translate: "anthropic", ...fields };
    assert.equal(installer.routeOutputLimit(route), sentMaxTokens(route), JSON.stringify(fields));
  }
  assert.equal(installer.CLAUDE_DEFAULT_MAX_OUTPUT, sentMaxTokens({}), "未設定時的預設值要與轉譯層一致");
  assert.equal(installer.routeOutputLimit({ upstreamModel: "gpt-x" }), null, "Responses 路由不送輸出上限");
  assert.equal(installer.routeOutputLimit({ translate: "chat", maxOutputTokens: 8000 }), null, "Chat 路由不送輸出上限");
  assert.equal(installer.routeUsesOutputSetting({ transport: "claude-cli", translate: "anthropic" }), true);
});

const routes = [
  { pickerSlug: "custom/claude", upstreamModel: "ark/claude", displayName: "ark/claude", translate: "anthropic", efforts: [], contextWindow: 1000000, maxOutputTokens: 128000 },
  { pickerSlug: "custom/nocap", upstreamModel: "nocap", displayName: "api/nocap", translate: "anthropic", efforts: [], contextWindow: null, maxOutputTokens: null },
  { pickerSlug: "custom/cli", upstreamModel: "claude-opus", displayName: "claude-cli/claude-opus", providerId: "claude-cli", transport: "claude-cli", translate: "anthropic", efforts: [], contextWindow: 1000000, maxOutputTokens: 32000 },
  { pickerSlug: "custom/gpt", upstreamModel: "ark/gpt", displayName: "ark/gpt", efforts: ["high"], contextWindow: null },
];
const fixture = () => ({
  manifest: { version: "1.27.0", routes: structuredClone(routes) },
  settings: { version: "1.27.0", port: 1, routes: structuredClone(routes) },
  catalog: { models: [
    { slug: "official", priority: 1 },
    { slug: "custom/claude", display_name: "ark/claude", context_window: 1000000, max_output_tokens: 128000 },
    { slug: "custom/nocap", display_name: "api/nocap", context_window: 272000 },
    { slug: "custom/cli", display_name: "claude-cli/claude-opus", context_window: 1000000, max_output_tokens: 32000 },
    { slug: "custom/gpt", display_name: "ark/gpt", context_window: 272000 },
  ] },
});
const edit = (slug, changes, state = fixture()) => installer.planEditModel(state.manifest, state.settings, state.catalog, slug, changes);
const routeOf = (plan, slug) => plan.settings.routes.find((route) => route.pickerSlug === slug);

test("修改 Claude 模型的輸出：寫入預設輸出、要求重啟路由器，不能超過上游回報的上限", () => {
  const plan = edit("custom/claude", { maxOutputTokens: 128000 });
  assert.equal(plan.changed, true);
  assert.equal(plan.restartRouter, true, "輸出由路由器套用，必須重啟才生效");
  assert.equal(plan.restartDesktop, false, "只改輸出時不必重啟桌面版");
  assert.equal(routeOf(plan, "custom/claude").defaultMaxOutputTokens, 128000);
  assert.equal(routeOf(plan, "custom/claude").maxOutputTokens, 128000, "上游回報的上限不變");
  assert.equal(plan.manifest.routes.find((route) => route.pickerSlug === "custom/claude").defaultMaxOutputTokens, 128000);
  assert.equal(installer.routeOutputLimit(routeOf(plan, "custom/claude")), 128000);
  assert.equal(edit("custom/claude", { maxOutputTokens: 64000 }).settings.routes[0].defaultMaxOutputTokens, 64000);
  assert.throws(() => edit("custom/claude", { maxOutputTokens: 200000 }), /不能超過這個模型的輸出上限 128,000/);
  const same = edit("custom/claude", { maxOutputTokens: 32000 });
  assert.equal(same.changed, false, "與目前實際送出的 32,000 相同，不寫入也不重啟");
  assert.equal(same.restartRouter, false);
  const noCap = edit("custom/nocap", { maxOutputTokens: 200000 });
  assert.equal(routeOf(noCap, "custom/nocap").defaultMaxOutputTokens, 200000, "沒有上游上限時照設定值");
  assert.throws(() => edit("custom/nocap", { maxOutputTokens: 300000 }), /不能超過上下文上限/, "不能超過模型目錄裡的上下文");
});

test("修改 CLI 模型的輸出：上限與預設輸出一起調整，模型目錄同步", () => {
  const plan = edit("custom/cli", { maxOutputTokens: 128000 });
  const route = routeOf(plan, "custom/cli");
  assert.deepEqual([route.maxOutputTokens, route.defaultMaxOutputTokens], [128000, 128000]);
  assert.equal(installer.routeOutputLimit(route), 128000);
  assert.equal(plan.catalog.models.find((model) => model.slug === "custom/cli").max_output_tokens, 128000);
  assert.equal(plan.restartRouter, true);
  assert.equal(edit("custom/cli", { maxOutputTokens: 32000 }).changed, false);
  assert.equal(routeOf(edit("custom/cli", { maxOutputTokens: 16000 }), "custom/cli").maxOutputTokens, 16000);
});

test("GPT 與 Chat 模型不能設定輸出；名稱與上下文照常可改，且不重啟路由器", () => {
  assert.throws(() => edit("custom/gpt", { maxOutputTokens: 128000 }), /由上游決定/);
  const plan = edit("custom/gpt", { displayName: "GPT", contextWindow: 1000000 });
  assert.deepEqual([plan.changed, plan.restartRouter, plan.restartDesktop], [true, false, true]);
  assert.equal(routeOf(plan, "custom/gpt").contextWindow, 1000000);
  assert.equal(routeOf(plan, "custom/gpt").defaultMaxOutputTokens, undefined);
  const both = edit("custom/claude", { displayName: "Claude", maxOutputTokens: 100000 });
  assert.deepEqual([both.restartRouter, both.restartDesktop], [true, true]);
  for (const value of [4095, 1000001, 8192.5, "abc"]) {
    assert.throws(() => edit("custom/claude", { maxOutputTokens: value }), /最大輸出必須是 4,096 到 1,000,000 之間的整數/);
  }
  assert.throws(() => edit("custom/claude", { contextWindow: 50000, maxOutputTokens: 64000 }), /不能超過上下文上限/);
});

test("新增模型的預設值：1M／128000，可自訂；格式錯誤或輸出大於上下文時擋下", () => {
  assert.deepEqual({ ...installer.NEW_MODEL_DEFAULTS }, { contextWindow: 1000000, maxOutputTokens: 128000 });
  assert.deepEqual(installer.normalizeNewModelDefaults(), { contextWindow: 1000000, maxOutputTokens: 128000 });
  assert.deepEqual(installer.normalizeNewModelDefaults({ contextWindow: null, maxOutputTokens: "" }), { contextWindow: 1000000, maxOutputTokens: 128000 });
  assert.deepEqual(installer.normalizeNewModelDefaults({ contextWindow: "400000", maxOutputTokens: 64000 }), { contextWindow: 400000, maxOutputTokens: 64000 });
  assert.throws(() => installer.normalizeNewModelDefaults({ contextWindow: 5000 }), /上下文上限必須是 16,000 到 4,000,000/);
  assert.throws(() => installer.normalizeNewModelDefaults({ maxOutputTokens: 10 }), /最大輸出必須是 4,096 到 1,000,000/);
  assert.throws(() => installer.normalizeNewModelDefaults({ contextWindow: 100000, maxOutputTokens: 128000 }), /不能超過上下文上限/);
});

test("套用新增模型的預設值：探測到較小的上游上限時以上游為準，GPT 與 Chat 不寫輸出", () => {
  const defaults = installer.normalizeNewModelDefaults();
  const gpt = installer.applyNewModelDefaults({ upstreamModel: "gpt", contextWindow: null, efforts: ["high"] }, defaults);
  assert.equal(gpt.contextWindow, 1000000);
  assert.equal("defaultMaxOutputTokens" in gpt, false);
  assert.equal(installer.applyNewModelDefaults({ translate: "chat", contextWindow: null }, defaults).defaultMaxOutputTokens, undefined);
  const claude = installer.applyNewModelDefaults({ translate: "anthropic", contextWindow: 1000000, maxOutputTokens: 128000 }, defaults);
  assert.deepEqual([claude.contextWindow, claude.defaultMaxOutputTokens, installer.routeOutputLimit(claude)], [1000000, 128000, 128000]);
  const smaller = installer.applyNewModelDefaults({ translate: "anthropic", contextWindow: 200000, maxOutputTokens: 64000 }, defaults);
  assert.deepEqual([smaller.contextWindow, smaller.defaultMaxOutputTokens, smaller.maxOutputTokens], [200000, 64000, 64000]);
  const unknown = installer.applyNewModelDefaults({ translate: "anthropic", contextWindow: null, maxOutputTokens: null }, defaults);
  assert.deepEqual([unknown.contextWindow, unknown.defaultMaxOutputTokens], [1000000, 128000], "上游沒回報上限時照設定值");
  const custom = installer.applyNewModelDefaults({ translate: "anthropic", contextWindow: 1000000, maxOutputTokens: 128000 },
    installer.normalizeNewModelDefaults({ contextWindow: 400000, maxOutputTokens: 32000 }));
  assert.deepEqual([custom.contextWindow, custom.defaultMaxOutputTokens], [400000, 32000], "使用者設定較小時用使用者的值");
  assert.equal(installer.describeRouteLimits(smaller), "上下文 200,000，輸出 64,000");
  assert.equal(installer.describeRouteLimits(gpt), "上下文 1,000,000，輸出 由上游決定");
  // 寫進模型目錄後，選擇器看到的上下文就是套用後的值。
  const entry = installer.customCatalogEntry([{ slug: "gpt-5.6-sol", priority: 1, context_window: 272000, supported_reasoning_levels: [] }],
    { ...gpt, pickerSlug: "custom/gpt", displayName: "api/gpt", providerHost: "gw" }, 0);
  assert.deepEqual([entry.context_window, entry.max_context_window, entry.effective_context_window_percent], [1000000, 1000000, 95]);
});

test("網頁表單的預設值與上下限和安裝器一致", () => {
  const defaults = /const NEW_MODEL_DEFAULTS = \{ contextWindow: (\d+), maxOutputTokens: (\d+) \};/.exec(managerPage);
  assert.ok(defaults, "頁面缺少 NEW_MODEL_DEFAULTS");
  assert.deepEqual(defaults.slice(1).map(Number), [installer.NEW_MODEL_DEFAULTS.contextWindow, installer.NEW_MODEL_DEFAULTS.maxOutputTokens]);
  const limits = /const TOKEN_LIMITS = \{ minContext: (\d+), maxContext: (\d+), minOutput: (\d+), maxOutput: (\d+) \};/.exec(managerPage);
  assert.ok(limits, "頁面缺少 TOKEN_LIMITS");
  assert.deepEqual(limits.slice(1).map(Number), [installer.MIN_CONTEXT_WINDOW, installer.MAX_CONTEXT_WINDOW, installer.MIN_OUTPUT_TOKENS, installer.MAX_OUTPUT_TOKENS]);
});
