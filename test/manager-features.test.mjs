// 第二階段的網頁功能：全域上下文、隱藏官方模型、Claude CLI 的模型設定與測試邏輯。
// 寫檔、重啟與 Codex 驗證由 manager-e2e 與既有的終端流程測試涵蓋；這裡測純邏輯。

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer, dir } = await loadPayloads();

test("全域上下文：空值代表移除，其他必須是 16,000～4,000,000 的整數", () => {
  for (const value of [undefined, null, ""]) assert.equal(installer.normalizeGlobalContextWindow(value), null);
  assert.equal(installer.normalizeGlobalContextWindow(1000000), 1000000);
  assert.equal(installer.normalizeGlobalContextWindow("272000"), 272000);
  for (const value of [15999, 4000001, 272000.5, "1M", -1]) {
    assert.throws(() => installer.normalizeGlobalContextWindow(value), /全域上下文必須是 16,000 到 4,000,000 之間的整數/);
  }
});

test("隱藏官方模型的可選清單：只列內建目錄標成 hide 的官方模型，並標出目前強制顯示的", () => {
  const bundled = { models: [
    { slug: "gpt-visible", display_name: "Visible", visibility: "list" },
    { slug: "gpt-hidden", display_name: "Hidden", description: "預覽模型", visibility: "hide" },
    { slug: "gpt-hidden-2", visibility: "hide" },
    { slug: "custom/x", visibility: "hide" },
  ] };
  assert.deepEqual(installer.hiddenModelChoices(bundled, ["gpt-hidden-2", "gpt-visible", "missing"]), [
    { slug: "gpt-hidden", displayName: "Hidden", description: "預覽模型", forced: false },
    { slug: "gpt-hidden-2", displayName: "gpt-hidden-2", description: "", forced: true },
  ]);
  assert.deepEqual(installer.hiddenModelChoices(bundled).map((model) => model.forced), [false, false]);
  assert.deepEqual(installer.hiddenModelChoices(null), []);
});

const binary = join(dir, "claude-native");
const provider = { id: "default", baseUrl: "https://relay.example", apiRoot: "https://relay.example/v1", keychainService: "fixture" };
const state = () => ({ providers: [provider], manifest: { port: 4567, providers: [provider], routes: [] },
  settings: { port: 4567, providers: [provider], routes: [] },
  catalog: { models: [{ slug: "gpt-fixture", priority: 1, context_window: 200000, visibility: "list" }] } });

test("Claude CLI 新增模型：網頁的輸出設定同時寫成上限與預設輸出；終端流程維持 32,000", () => {
  const web = installer.planClaudeCliModels(state(), binary, ["opus"], 1000000, { opus: "claude-opus-5-5" }, { maxOutputTokens: 128000 });
  const route = web.settings.routes[0];
  assert.deepEqual([route.contextWindow, route.maxOutputTokens, route.defaultMaxOutputTokens], [1000000, 128000, 128000]);
  assert.equal(installer.routeOutputLimit(route), 128000);
  assert.equal(web.catalog.models.find((model) => model.slug === route.pickerSlug).max_output_tokens, 128000);
  const terminal = installer.planClaudeCliModels(state(), binary, ["opus"], 200000).settings.routes[0];
  assert.deepEqual([terminal.maxOutputTokens, terminal.defaultMaxOutputTokens], [32000, undefined]);
  assert.throws(() => installer.planClaudeCliModels(state(), binary, ["opus"], 50000, {}, { maxOutputTokens: 64000 }), /不能超過上下文上限/);
  assert.throws(() => installer.planClaudeCliModels(state(), binary, ["opus"], 200000, {}, { maxOutputTokens: 100 }), /最大輸出必須是/);
});

// 假的 Claude CLI 轉接：依模型名稱回傳預先寫好的 SSE 事件或錯誤。
function fakeTransport(script) {
  const calls = [];
  return {
    calls,
    fetchClaudeCli: async (request, configuration) => {
      calls.push({ model: request.model, binary: configuration.binary, maxTokens: request.max_tokens });
      const next = script[request.model].shift();
      if (next.status) return Response.json({ error: next.error }, { status: next.status });
      return new Response(next.events.map((event) => "data: " + JSON.stringify(event)).join("\n") + "\n");
    },
  };
}
const success = (model) => ({ events: [
  { type: "message_start", message: { model } },
  { type: "content_block_delta", delta: { text: "OK" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
  { type: "message_stop" },
] });
const upgrade = { events: [{ type: "error", error: { type: "claude_cli_upgrade_required", message: "需要較新的 CLI", requiredVersion: "2.2.0" } }] };

test("Claude CLI 模型測試：通過的記下實際版本，失敗與沒有版本編號的都不添加", async () => {
  const transport = fakeTransport({
    opus: [success("claude-opus-5-5")],
    haiku: [{ events: [{ type: "error", error: { message: "訂閱用量已達上限" } }] }],
    "claude-x": [success("<synthetic>")],
    sonnet: [{ status: 503, error: { message: "無法啟動 Claude CLI" } }],
  });
  const result = await installer.testClaudeCliModels(transport, { binary: "/bin/claude", version: "2.1.285",
    models: ["opus", "haiku", "claude-x", "sonnet"] });
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.passed, ["opus"]);
  assert.deepEqual(result.resolvedModels, { opus: "claude-opus-5-5" });
  assert.deepEqual(result.failures, {
    haiku: "訂閱用量已達上限", "claude-x": "回應沒有明確的模型版本編號。", sonnet: "無法啟動 Claude CLI",
  });
  assert.ok(transport.calls.every((call) => call.maxTokens === 1024), "測試只要求很短的回覆");
});

test("Claude CLI 需要較新版本：網頁不自動更新，只記為未通過；終端同意更新後用新版重測一次", async () => {
  const web = fakeTransport({ sonnet: [upgrade, success("claude-sonnet-5-5")] });
  const declined = await installer.testClaudeCliModels(web, { binary: "/bin/claude", version: "2.1.285", models: ["sonnet"] });
  assert.deepEqual([declined.passed, declined.failures.sonnet, web.calls.length], [[], "需要較新的 CLI", 1]);

  const terminal = fakeTransport({ sonnet: [upgrade, success("claude-sonnet-5-5")] });
  const upgraded = await installer.testClaudeCliModels(terminal, { binary: "/bin/claude", version: "2.1.285", models: ["sonnet"],
    onUpgradeRequired: async (required) => ({ binary: "/new/claude", version: required }) });
  assert.deepEqual(upgraded.passed, ["sonnet"]);
  assert.deepEqual([upgraded.binary, upgraded.version], ["/new/claude", "2.2.0"]);
  assert.deepEqual(terminal.calls.map((call) => call.binary), ["/bin/claude", "/new/claude"]);

  const cancelled = await installer.testClaudeCliModels(fakeTransport({ sonnet: [upgrade] }),
    { binary: "/bin/claude", version: "2.1.285", models: ["sonnet"], onUpgradeRequired: async () => null });
  assert.equal(cancelled.cancelled, true);
  // 已經是新版仍收到同樣的錯誤時，不再要求更新，直接記為未通過。
  const current = await installer.testClaudeCliModels(fakeTransport({ sonnet: [upgrade] }),
    { binary: "/bin/claude", version: "2.2.0", models: ["sonnet"], onUpgradeRequired: async () => assert.fail("不應要求更新") });
  assert.deepEqual(current.passed, []);
});
