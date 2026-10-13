// 第三方 Fast（service_tier=priority）：新增時探測、選擇器顯示、手動切換，以及路由器只對
// 開啟 Fast 的路由轉送 service_tier。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer, router, chat } = await loadPayloads();
const silent = { write() {}, line() {} };
const sender = (results) => {
  const sent = [];
  return { sent, send: async (tier) => { sent.push(tier); const next = results.shift(); if (next instanceof Error) throw next; return next; } };
};

test("probeServiceTier 只有 priority 通過且無效等級被拒時才算支援", async () => {
  const cases = [
    [[{ ok: true, status: 200 }, { ok: false, status: 400 }], "supported"],
    [[{ ok: true, status: 200 }, { ok: false, status: 422 }], "supported"],
    [[{ ok: true, status: 200 }, { ok: true, status: 200 }], "unvalidated"],
    [[{ ok: false, status: 400 }], "unsupported"],
    [[{ ok: false, status: 429 }], "unknown"],
    [[{ ok: true, status: 200 }, { ok: false, status: 503 }], "unknown"],
    [[new Error("fetch failed")], "unknown"],
  ];
  for (const [results, expected] of cases) {
    const { sent, send } = sender([...results]);
    assert.equal(await installer.probeServiceTier(send, silent), expected);
    assert.equal(sent[0], "priority");
    if (sent.length > 1) assert.equal(sent[1], installer.FAST_PROBE_INVALID_TIER);
  }
});

test("Responses 與 Chat 路由開啟 Fast 時選擇器顯示 Fast；Claude API 路由不顯示", () => {
  const base = { pickerSlug: "custom/x", upstreamModel: "gpt-6.1-sol", efforts: ["low"] };
  assert.deepEqual(installer.customSpeedTiers({ ...base, fast: true }).additional_speed_tiers, ["fast"]);
  assert.equal(installer.customSpeedTiers({ ...base, fast: true }).service_tiers[0].id, "priority");
  assert.deepEqual(installer.customSpeedTiers({ ...base, translate: "chat", fast: true }).additional_speed_tiers, ["fast"]);
  assert.deepEqual(installer.customSpeedTiers({ ...base, fast: false }).additional_speed_tiers, []);
  assert.deepEqual(installer.customSpeedTiers(base).additional_speed_tiers, []);
  assert.deepEqual(installer.customSpeedTiers({ ...base, translate: "anthropic", fast: true }).additional_speed_tiers, []);
});

const fixture = () => {
  const route = { pickerSlug: "custom/owo-gpt", upstreamModel: "gpt-6.1-sol", displayName: "owo/gpt-6.1-sol",
    efforts: ["low", "high"], providerId: "owo", contextWindow: 1000000 };
  return {
    manifest: { version: "1.0.0", routes: [route] },
    settings: { port: 48953, routes: [route] },
    catalog: { models: [{ slug: "custom/owo-gpt", display_name: "owo/gpt-6.1-sol", context_window: 1000000,
      additional_speed_tiers: [], service_tiers: [] }] },
  };
};

test("手動開啟 Fast 會寫入 fastManual、更新目錄並重啟路由器", () => {
  const { manifest, settings, catalog } = fixture();
  const plan = installer.planEditModel(manifest, settings, catalog, "custom/owo-gpt", { fast: true });
  assert.equal(plan.changed, true);
  assert.equal(plan.restartRouter, true);
  assert.equal(plan.restartDesktop, true);
  assert.equal(plan.settings.routes[0].fast, true);
  assert.equal(plan.settings.routes[0].fastManual, true);
  assert.equal(plan.manifest.routes[0].fast, true);
  assert.deepEqual(plan.catalog.models[0].additional_speed_tiers, ["fast"]);
  assert.equal(installer.planEditModel(manifest, plan.settings, plan.catalog, "custom/owo-gpt", { fast: true }).changed, false);
  assert.throws(() => installer.planEditModel(manifest, settings, catalog, "custom/owo-gpt", { fast: "yes" }));
  const claude = { ...fixture(), };
  claude.settings.routes[0] = { ...claude.settings.routes[0], translate: "anthropic" };
  assert.throws(() => installer.planEditModel(claude.manifest, claude.settings, claude.catalog, "custom/owo-gpt", { fast: true }));
});

test("重新偵測依結果開關 Fast 並清除手動設定；問不到時不改", () => {
  const { manifest, settings, catalog } = fixture();
  settings.routes[0] = { ...settings.routes[0], fast: false, fastManual: true };
  const plan = installer.planDetectedFast(manifest, settings, catalog, "custom/owo-gpt", "supported");
  assert.equal(plan.changed, true);
  assert.equal(plan.fast, true);
  assert.equal(plan.settings.routes[0].fastProbe, "supported");
  assert.equal("fastManual" in plan.settings.routes[0], false);
  assert.deepEqual(plan.catalog.models[0].additional_speed_tiers, ["fast"]);
  assert.equal(installer.planDetectedFast(manifest, settings, catalog, "custom/owo-gpt", "unknown").changed, false);
  const off = installer.planDetectedFast(manifest, plan.settings, plan.catalog, "custom/owo-gpt", "unvalidated");
  assert.equal(off.fast, false);
  assert.deepEqual(off.catalog.models[0].additional_speed_tiers, []);
});

test("重新探測保留手動設定；這次問不到時沿用上次結果", () => {
  const fresh = { pickerSlug: "custom/a", upstreamModel: "a", efforts: ["low"] };
  const manual = installer.resolveRouteWithPrevious({ route: { ...fresh, fast: false, fastProbe: "unvalidated" } },
    { ...fresh, fast: true, fastManual: true });
  assert.equal(manual.route.fast, true);
  assert.equal(manual.route.fastManual, true);
  const unknown = installer.resolveRouteWithPrevious({ route: { ...fresh, fast: false, fastProbe: "unknown" } },
    { ...fresh, fast: true, fastProbe: "supported" });
  assert.equal(unknown.route.fast, true);
  assert.equal(unknown.route.fastProbe, "supported");
  const replaced = installer.resolveRouteWithPrevious({ route: { ...fresh, fast: false, fastProbe: "unsupported" } },
    { ...fresh, fast: true, fastProbe: "supported" });
  assert.equal(replaced.route.fast, false);
});

test("路由器只對開啟 Fast 的路由轉送 service_tier，Chat 轉譯一併帶上", () => {
  const body = { model: "custom/owo-gpt", input: [], service_tier: "priority" };
  const route = { upstreamModel: "gpt-6.1-sol", efforts: ["low"] };
  assert.equal(router.rewriteCustomBody(body, { ...route, fast: true }).service_tier, "priority");
  assert.equal("service_tier" in router.rewriteCustomBody(body, route), false);
  assert.equal("service_tier" in router.rewriteCustomBody(body, { ...route, fast: true, translate: "anthropic" }), false);
  assert.equal(router.rewriteCustomBody(body, { ...route, transport: "claude-cli" }).service_tier, "priority");
  const chatRoute = { ...route, translate: "chat" };
  assert.equal(chat.toChatRequest(body, { ...chatRoute, fast: true }).request.service_tier, "priority");
  assert.equal("service_tier" in chat.toChatRequest(body, chatRoute).request, false);
});
