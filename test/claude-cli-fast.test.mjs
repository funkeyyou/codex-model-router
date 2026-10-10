// Claude CLI 快速模式：Codex 的 Fast（service_tier=priority）對應 CLI 的 fastMode 設定。
// 無頭模式預設不開，必須由 --settings 明確 opt in；可用與否交給 CLI 判斷並回報。

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer, dir } = await loadPayloads();
const cli = await import(pathToFileURL(join(dir, "claude-cli.mjs")));

test("only Claude CLI Opus routes advertise the Fast tier", () => {
  const templates = [{ slug: "gpt-5.6-sol", priority: 1, visibility: "list", context_window: 272000,
    additional_speed_tiers: ["fast"], service_tiers: [{ id: "priority", name: "Fast" }] }];
  const route = (upstreamModel, transport) => ({ upstreamModel, transport, pickerSlug: "custom/" + upstreamModel,
    efforts: ["low"], providerHost: "example.test", contextWindow: 1000000 });
  const opus = installer.customCatalogEntry(templates, route("claude-opus-5-5", "claude-cli"), 0);
  assert.deepEqual(opus.additional_speed_tiers, ["fast"]);
  assert.equal(opus.service_tiers[0].id, "priority");
  for (const entry of [
    installer.customCatalogEntry(templates, route("claude-sonnet-5-5", "claude-cli"), 0),
    installer.customCatalogEntry(templates, route("claude-opus-5-5", undefined), 0),
    installer.customCatalogEntry(templates, route("gpt-6-sol", undefined), 0),
  ]) {
    assert.deepEqual(entry.additional_speed_tiers, []);
    assert.deepEqual(entry.service_tiers, []);
  }
});

test("update migrates speed tiers of existing custom entries without touching other fields", () => {
  const routes = [
    { pickerSlug: "custom/opus", upstreamModel: "claude-opus-5-5", transport: "claude-cli" },
    { pickerSlug: "custom/sonnet", upstreamModel: "claude-sonnet-5-5", transport: "claude-cli" },
  ];
  const catalog = { models: [
    { slug: "gpt-6-sol", additional_speed_tiers: ["fast"] },
    { slug: "custom/opus", display_name: "手動", additional_speed_tiers: [], service_tiers: [] },
    { slug: "custom/sonnet", additional_speed_tiers: [], service_tiers: [] },
  ] };
  const updated = installer.refreshCustomSpeedTiers(catalog, routes);
  assert.notEqual(updated, catalog);
  assert.deepEqual(updated.models[1].additional_speed_tiers, ["fast"]);
  assert.equal(updated.models[1].display_name, "手動");
  assert.equal(updated.models[0], catalog.models[0]);
  assert.equal(updated.models[2], catalog.models[2]);
  assert.equal(installer.refreshCustomSpeedTiers(updated, routes), updated);
});

test("fastMode is opted in through --settings only when requested", () => {
  const settingsOf = (args) => JSON.parse(args[args.indexOf("--settings") + 1]);
  assert.deepEqual(settingsOf(cli.cliSettingsArgs()), { disableAllHooks: true });
  assert.deepEqual(settingsOf(cli.cliSettingsArgs({ fast: true })), { disableAllHooks: true, fastMode: true });
  assert.equal(cli.cliSettingsArgs({ fast: true })[1], "");
});

test("fetchClaudeCli passes fastMode and reports the CLI fast state", { skip: process.platform === "win32" }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "router-cli-fast-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = join(directory, "claude");
  writeFileSync(script, [
    "#!" + process.execPath,
    'const fs = require("fs"); const args = process.argv.slice(2);',
    'const settings = JSON.parse(args[args.indexOf("--settings") + 1]);',
    'fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(settings) + "\\n");',
    'const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");',
    'process.stdin.resume(); process.stdin.on("end", () => {',
    '  out(settings.fastMode ? { type: "system", subtype: "init", fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" }',
    '    : { type: "system", subtype: "init" });',
    '  for (const event of [',
    '    { type: "message_start", message: { usage: { input_tokens: 1 } } },',
    '    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },',
    '    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },',
    '    { type: "content_block_stop", index: 0 },',
    '    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },',
    '    { type: "message_stop" },',
    '  ]) out({ type: "stream_event", event });',
    "});",
    "",
  ].join("\n"));
  chmodSync(script, 0o755);
  const log = join(directory, "calls.jsonl");
  const env = { ...process.env, FAKE_CLI_LOG: log };
  const request = { model: "claude-opus-5-5", system: "S", tools: [], max_tokens: 100,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
  const diagnostics = [];
  const fast = await (await cli.fetchClaudeCli(request, { binary: script, timeoutMs: 10000, fast: true }, null,
    { env, onDiagnostic: (event) => diagnostics.push(event) })).text();
  assert.match(fast, /"type":"message_stop"/);
  await (await cli.fetchClaudeCli(request, { binary: script, timeoutMs: 10000 }, null, { env })).text();
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    [{ disableAllHooks: true, fastMode: true }, { disableAllHooks: true }]);
  const state = diagnostics.find((event) => event.fastState);
  assert.equal(state.fastState, "off");
  assert.equal(state.fastDisabledReason, "extra_usage_disabled");
});
