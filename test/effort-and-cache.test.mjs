// 推理強度控制與提示詞快取。
//
// 兩件實測出來的事：
//   1. budget_tokens 在較新的模型上已無作用（官方 400，部分閘道靜默丟棄）。
//      量測：budget 2048 與 32768 的輸出與耗時實質相同（~1109 vs ~1167 tokens，
//      16.6s vs 17.0s），而 output_config.effort=low 只要 9.5s。
//      也就是說使用者在 Codex 選的強度完全沒有生效，且一律跑在高強度。
//   2. 快取斷點只掛在 system 時，會長大的對話歷史每輪都重算。
//      量測：~20K 歷史的第二輪 input=19650 未快取；加上頂層 cache_control 後
//      input=2、cache_read=20177。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { bridge } = await loadPayloads();
const { toAnthropicRequest } = bridge;

const userMessage = (text) => ({
  type: "message", role: "user", content: [{ type: "input_text", text }],
});

const newRoute = {
  upstreamModel: "claude-x",
  maxOutputTokens: 64000,
  effortControl: "output_config",
  promptCache: true,
};
const oldRoute = {
  upstreamModel: "claude-old",
  maxOutputTokens: 64000,
  effortControl: "thinking_budget",
  promptCache: false,
};

const build = (route, extra = {}) =>
  toAnthropicRequest({ input: [userMessage("hi")], ...extra }, route).request;

// --- 新式：output_config.effort 直接透傳 --------------------------------------

test("五檔都原樣透傳給 output_config.effort", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    const request = build(newRoute, { reasoning: { effort } });
    assert.deepEqual(request.output_config, { effort }, effort);
  }
});

test("走 output_config 時不再送 thinking.budget_tokens", () => {
  // 這正是舊行為失效的原因：送了也沒用，還會在官方 API 上 400。
  for (const effort of ["low", "max"]) {
    const request = build(newRoute, { reasoning: { effort } });
    assert.equal(request.thinking, undefined, effort);
  }
});

test("Codex 的 ultra 對到 Anthropic 的 max（沒有對應檔位）", () => {
  assert.deepEqual(build(newRoute, { reasoning: { effort: "ultra" } }).output_config,
    { effort: "max" });
});

test("沒有指定強度時不送 output_config，交給模型預設", () => {
  assert.equal(build(newRoute).output_config, undefined);
});

test("認不得的強度不會被硬塞進去", () => {
  assert.equal(build(newRoute, { reasoning: { effort: "turbo" } }).output_config, undefined);
});

test("走 output_config 時 max_tokens 不再被 thinking 預算撐大", () => {
  // 舊路徑會把 max_tokens 拉到 budget + headroom；新路徑沒有預算要遷就。
  const request = build(newRoute, { reasoning: { effort: "max" } });
  assert.equal(request.max_tokens, 32000);
});

// --- 舊式：探測不支援時完全維持原行為 -----------------------------------------

test("舊路徑仍送 thinking.budget_tokens，且不送 output_config", () => {
  const request = build(oldRoute, { reasoning: { effort: "high" } });
  assert.equal(request.output_config, undefined);
  assert.equal(request.thinking.type, "enabled");
  assert.ok(request.thinking.budget_tokens > 0);
});

test("舊路徑的 budget < max_tokens 不變式仍然成立", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
    const request = build(oldRoute, { reasoning: { effort } });
    assert.ok(request.thinking.budget_tokens < request.max_tokens, effort);
  }
});

test("沒有標記的舊路由（升級前裝的）保守走舊行為", () => {
  const legacy = { upstreamModel: "claude-legacy", maxOutputTokens: 64000 };
  const request = build(legacy, { reasoning: { effort: "high" } });
  assert.equal(request.output_config, undefined);
  assert.ok(request.thinking.budget_tokens > 0);
});

// --- 提示詞快取 --------------------------------------------------------------

test("支援時掛上頂層 cache_control，讓斷點滾到最新一輪", () => {
  assert.deepEqual(build(newRoute).cache_control, { type: "ephemeral" });
});

test("探測不支援時不送頂層 cache_control（否則整條路由 400）", () => {
  assert.equal(build(oldRoute).cache_control, undefined);
});

test("沒有標記的舊路由不會突然開始送 cache_control", () => {
  assert.equal(build({ upstreamModel: "claude-legacy" }).cache_control, undefined);
});

test("system 自己的斷點仍然保留（兩者可以並存）", () => {
  const request = toAnthropicRequest({
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "規則" }] },
      userMessage("hi"),
    ],
  }, newRoute).request;
  assert.deepEqual(request.system.at(-1).cache_control, { type: "ephemeral" });
  assert.deepEqual(request.cache_control, { type: "ephemeral" });
});

test("route 傳字串時走保守路徑（沒有探測結果可用）", () => {
  const request = toAnthropicRequest({ input: "hi", reasoning: { effort: "high" } }, "claude-x").request;
  assert.equal(request.output_config, undefined);
  assert.equal(request.cache_control, undefined);
  assert.ok(request.thinking.budget_tokens > 0);
});
