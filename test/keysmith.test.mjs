import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { codexBin } from "./helpers/codex-bin.mjs";
import { loadPayloads } from "./helpers/payloads.mjs";
const { installer, managerPage, dir } = await loadPayloads();
const source = "Intro\nThe operator is Ethan. Address him as Ethan.\nKeep all tools.\n";
const hash = text => createHash("sha256").update(text).digest("hex");
function fixture(t, current = null) {
  const home = mkdtempSync(join(tmpdir(), "router-keysmith-global-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "model-router"); mkdirSync(root);
  const filePath = join(home, "config.toml"); writeFileSync(filePath, "# config\n");
  const config = { model: "keep-model", model_instructions_file: current };
  const options = { home, root, backupRoot: join(home, "backups"),
    fetchImpl: async url => new Response(url.endsWith("LICENSE") ? "MIT" : source),
    readConfig: async () => ({ config: structuredClone(config), filePath }),
    writeConfig: async edits => { for (const edit of edits) config[edit.keyPath] = edit.value; } };
  return { home, root, config, options, path: join(root, "keysmith.json"), prompt: join(root, "keysmith-global.md") };
}
function original(f) {
  writeFileSync(join(f.home, "gpt-overlay.md"), source);
  writeFileSync(join(f.home, "config.toml.bak"), "model = 'keep-model'\n");
  writeFileSync(join(f.home, ".codex-keysmith-manifest.json"), JSON.stringify({ md: { path: "gpt-overlay.md", after: { sha256: hash(source) } }, config: { backup: "config.toml.bak" } }));
  f.config.model_instructions_file = "./gpt-overlay.md";
}
test("adopt verified original global install, remove fixed name, disable offline without losing other settings", async t => {
  const f = fixture(t); original(f);
  assert.equal((await installer.keysmithStatus(f.options)).external, true);
  const result = await installer.setKeysmithEnabled(true, f.options);
  assert.equal(f.config.model_instructions_file, f.prompt);
  assert.doesNotMatch(readFileSync(f.prompt, "utf8"), /Ethan/);
  assert.match(readFileSync(f.prompt, "utf8"), /Keep all tools/);
  const record = JSON.parse(readFileSync(f.path, "utf8"));
  assert.equal(record.enabled, false, "old running routers must not inject again");
  assert.equal(record.globalEnabled, true);
  assert.equal(record.previousValue, null);
  assert.ok(existsSync(join(result.backupDir, "adopted-upstream-manifest.json")));
  assert.equal(readFileSync(join(f.home, "gpt-overlay.md"), "utf8"), source);
  assert.equal((await installer.keysmithStatus(f.options)).enabled, true);
  await installer.setKeysmithEnabled(false, { ...f.options, fetchImpl: () => assert.fail("offline") });
  assert.equal(f.config.model_instructions_file, null);
  assert.equal((await installer.keysmithStatus(f.options)).enabled, false);
  assert.equal(f.config.model, "keep-model");
});
test("original can be switched off directly; unknown edited prompt is left alone", async t => {
  const f = fixture(t); original(f);
  await installer.setKeysmithEnabled(false, f.options);
  assert.equal(f.config.model_instructions_file, null);
  assert.ok(existsSync(join(f.home, "gpt-overlay.md")));
  original(f); writeFileSync(join(f.home, "gpt-overlay.md"), "User changes");
  assert.equal(installer.originalKeysmithInstall(f.home, f.config.model_instructions_file), null);
  await installer.setKeysmithEnabled(false, f.options);
  assert.equal(f.config.model_instructions_file, "./gpt-overlay.md");
});
test("failed config write rolls back legacy record and prompt; ownership metadata stays", async t => {
  const f = fixture(t); original(f);
  const legacy = JSON.stringify({ enabled: true, prompts: { gpt: "OLD" } }); writeFileSync(f.path, legacy);
  let calls = 0;
  await assert.rejects(installer.setKeysmithEnabled(true, { ...f.options, writeConfig: async edits => {
    if (++calls === 1) throw new Error("write failed");
    return f.options.writeConfig(edits);
  } }), /write failed/);
  assert.equal(f.config.model_instructions_file, "./gpt-overlay.md");
  assert.equal(readFileSync(f.path, "utf8"), legacy);
  assert.equal(existsSync(f.prompt), false);
  assert.ok(existsSync(join(f.home, ".codex-keysmith-manifest.json")));
});
test("disable restores previous instruction setting and preserves later manual edits", async t => {
  const f = fixture(t);
  writeFileSync(f.prompt, source);
  writeFileSync(f.path, JSON.stringify({ mode: "global", previousValue: "/custom/other.md" }));
  f.config.model_instructions_file = f.prompt; f.config.extra = "keep";
  await installer.setKeysmithEnabled(false, f.options);
  assert.equal(f.config.model_instructions_file, "/custom/other.md"); assert.equal(f.config.extra, "keep");
  writeFileSync(f.path, JSON.stringify({ mode: "global", previousValue: null }));
  f.config.model_instructions_file = "/user/new.md";
  await installer.setKeysmithEnabled(false, f.options);
  assert.equal(f.config.model_instructions_file, "/user/new.md");
});
test("pinned download verifies prompt and license; network failure leaves config untouched", async t => {
  const sources = [
    { family: "gpt", repo: "codex-keysmith", commit: "a".repeat(40), path: "prompt.md", sha256: hash(source) },
    { family: null, repo: "codex-keysmith", commit: "a".repeat(40), path: "LICENSE", sha256: hash("MIT") },
  ];
  const f = fixture(t);
  const result = await installer.downloadKeysmithProfiles({ sources, fetchImpl: f.options.fetchImpl });
  assert.equal(result.prompts.gpt, source); assert.equal(result.licenses["codex-keysmith"], "MIT");
  await assert.rejects(installer.downloadKeysmithProfiles({ sources, fetchImpl: async () => new Response("bad") }), /SHA256/);
  await assert.rejects(installer.setKeysmithEnabled(true, { ...f.options, fetchImpl: async () => { throw new Error("offline"); } }), /offline/);
  assert.equal(existsSync(f.path), false); assert.equal(f.config.model_instructions_file, null);
});
test("router no longer has an injection path", () => {
  assert.doesNotMatch(readFileSync(new URL("../src/router.mjs", import.meta.url), "utf8"), /applyKeysmith|keysmithFamily|keysmith\.json/);
});
test("real Codex config RPC adopts original, toggles off, and preserves unrelated settings", { skip: !codexBin }, t => {
  const f = fixture(t); original(f);
  writeFileSync(join(f.home, "config.toml"), 'model = "gpt-6-sol"\nmodel_instructions_file = "./gpt-overlay.md"\n');
  const code = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    const installer = await import(${JSON.stringify(pathToFileURL(join(dir, "installer.mjs")).href)});
    assert.equal((await installer.keysmithStatus()).external, true);
    await installer.setKeysmithEnabled(true);
    assert.equal((await installer.keysmithStatus()).enabled, true);
    await installer.setKeysmithEnabled(false);
    assert.equal((await installer.keysmithStatus()).enabled, false);
    const text = readFileSync(${JSON.stringify(join(f.home, "config.toml"))}, 'utf8');
    assert.match(text, /model = "gpt-6-sol"/);
    assert.doesNotMatch(text, /^model_instructions_file\\s*=/m);
    console.log('global config RPC roundtrip passed');
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, CODEX_HOME: f.home, CODEX_MODEL_ROUTER_HOME: f.root,
      CODEX_MODEL_ROUTER_CODEX_BIN: codexBin, CODEX_MODEL_ROUTER_IMPORT_ONLY: "1" },
    encoding: "utf8", timeout: 30000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
test("manager warns about Claude on both page and enable confirmation", async () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(managerPage)[1];
  const code = script.slice(script.indexOf("function renderKeysmithPanel("), script.indexOf("function renderQuotaModePanel("));
  for (const on of [false, true]) {
    const jobs = []; let dialog;
    const context = { state: { keysmith: { enabled: on } }, t: text => text,
      h: (tag, props, ...children) => ({ tag, props, children }), paragraph: (text, className) => ({ text, className }),
      confirmDialog: async options => { dialog = options; return true; }, runJob: (type, params) => jobs.push({ type, params }) };
    const panel = vm.runInNewContext(code + "\nrenderKeysmithPanel(false)", context);
    assert.match(JSON.stringify(panel), /Claude.*CLI/);
    assert.doesNotMatch(JSON.stringify(panel), /model_instructions_file|per-request router/);
    const find = node => node && (node.props?.role === "switch" ? node : node.children?.map(find).find(Boolean));
    await find(panel).props.onchange({ target: {} }); await Promise.resolve();
    if (!on) assert.match(JSON.stringify(dialog.body), /Claude.*CLI/);
    assert.equal(jobs[0].params.enabled, !on);
  }
});
