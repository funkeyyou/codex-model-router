import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayloads } from "./helpers/payloads.mjs";
import vm from "node:vm";

const home = mkdtempSync(join(tmpdir(), "native-tool-budget-"));
process.env.CODEX_HOME = home;
const { installer, managerPage } = await loadPayloads();

test("manager defaults to 10000, displays existing budget, and saves only the budget", () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(managerPage)[1];
  const code = script.slice(script.indexOf("function renderToolOutputBudgetPanel("), script.indexOf("function renderGlobalContextPanel("));
  for (const current of [null, 12000]) {
    const jobs = [];
    const context = { t: text => text, formatNumber: String,
      ensureQuery: () => ({ data: { value: current, defaultValue: 10000 } }), refreshButton: () => null,
      h: (tag, attrs, ...children) => ({ tag, attrs, value: attrs?.value, children, append(...items) { this.children.push(...items); } }),
      paragraph: text => ({ text }), toast: () => {}, runJob: (type, params) => jobs.push({ type, params }) };
    const panel = vm.runInNewContext(code + "\nrenderToolOutputBudgetPanel(false)", context);
    const find = (node, tag) => node?.tag === tag ? node : node?.children?.map(child => find(child, tag)).find(Boolean);
    const input = find(panel, "input");
    assert.equal(input.value, String(current ?? 10000));
    input.value = "16000";
    find(panel, "button").attrs.onclick();
    assert.equal(JSON.stringify(jobs), JSON.stringify([{ type: "set-tool-output-budget", params: { value: 16000 } }]));
  }
});

test("native budget defaults to 10000 and rejects invalid values", () => {
  assert.equal(installer.normalizeToolOutputBudget(), 10000);
  assert.equal(installer.normalizeToolOutputBudget("12000"), 12000);
  for (const value of [null, "", false, 0, -1, 1.5, 1000001, "8k"]) {
    assert.throws(() => installer.normalizeToolOutputBudget(value));
  }
});

test("saving a native budget only edits that key, backs up, verifies, and is idempotent", async () => {
  const filePath = join(home, "config.toml");
  const original = "model_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n";
  writeFileSync(filePath, original);
  const config = { model_context_window: 1000000, model_auto_compact_token_limit: 900000, unrelated: true };
  const writes = [];
  const deps = { readConfig: async () => ({ config, filePath }), writeConfig: async edits => {
    writes.push(edits);
    for (const { keyPath, value } of edits) config[keyPath] = value;
  } };
  const result = await installer.setToolOutputBudget(8000, deps);
  assert.equal(result.changed, true);
  assert.equal(readFileSync(join(result.backupDir, "config.toml"), "utf8"), original);
  assert.deepEqual(writes, [[{ keyPath: "tool_output_token_limit", value: 8000 }]]);
  assert.deepEqual(config, { model_context_window: 1000000, model_auto_compact_token_limit: 900000, unrelated: true, tool_output_token_limit: 8000 });
  assert.equal((await installer.setToolOutputBudget(8000, deps)).changed, false);
  assert.equal(writes.length, 1);
});

test("verification failure restores the previous tool budget without changing context", async () => {
  const filePath = join(home, "rollback.toml");
  writeFileSync(filePath, "tool_output_token_limit = 12000\n");
  const config = { tool_output_token_limit: 12000, model_context_window: 1000000 };
  const writes = [];
  await assert.rejects(installer.setToolOutputBudget(8000, {
    readConfig: async () => ({ config, filePath }), writeConfig: async edits => { writes.push(edits); },
  }), /驗證失敗/);
  assert.deepEqual(writes, [[{ keyPath: "tool_output_token_limit", value: 8000 }], [{ keyPath: "tool_output_token_limit", value: 12000 }]]);
  assert.equal(config.model_context_window, 1000000);
});
