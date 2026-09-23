import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
const routes = [
  { pickerSlug: "custom/claude", upstreamModel: "ark/claude", displayName: "手動名稱", contextWindow: 1000000 },
  { pickerSlug: "custom/gpt", upstreamModel: "ark/gpt", displayName: "ark/gpt", efforts: ["high"] },
];
const manifest = () => ({ version: "1.22.1", baseUrl: "https://example.test", routes: structuredClone(routes), keep: "manifest" });
const settings = () => ({ version: "1.22.1", port: 48953, routes: structuredClone(routes), keep: "settings" });
const catalog = () => ({ schema: 1, models: [
  { slug: "gpt-official", priority: 40, visibility: "list" },
  { slug: "custom/claude", display_name: "手動名稱", context_window: 1000000, priority: 41 },
  { slug: "custom/gpt", display_name: "ark/gpt", priority: 42 },
], keep: "catalog" });

test("只刪所選自訂模型，官方與其餘模型及設定逐欄位保留", () => {
  const before = { manifest: manifest(), settings: settings(), catalog: catalog() };
  const original = structuredClone(before);
  const result = installer.planRemoveModels(before.manifest, before.settings, before.catalog, ["custom/claude"]);
  assert.deepEqual(result.removed, [routes[0]]);
  assert.deepEqual(result.settings.routes, [routes[1]]);
  assert.deepEqual(result.manifest.routes, [routes[1]]);
  assert.deepEqual(result.catalog.models, [original.catalog.models[0], original.catalog.models[2]]);
  assert.equal(result.settings.keep, "settings");
  assert.equal(result.manifest.keep, "manifest");
  assert.equal(result.catalog.keep, "catalog");
  assert.deepEqual(before, original, "不能改動傳入的配置或模型目錄");
});

test("全部刪除後仍保留官方模型，更新命令仍可使用", () => {
  const result = installer.planRemoveModels(manifest(), settings(), catalog(), routes.map(route => route.pickerSlug));
  assert.deepEqual(result.settings.routes, []);
  assert.deepEqual(result.manifest.routes, []);
  assert.deepEqual(result.catalog.models, [catalog().models[0]]);
  assert.equal(installer.planUpdate(result.manifest, result.settings).ok, true);
});

test("拒絕刪除官方模型、未知模型、空選擇或損壞的設定", () => {
  for (const slugs of [["gpt-official"], ["custom/missing"], [], ["custom/claude", "gpt-official"]]) {
    assert.throws(() => installer.planRemoveModels(manifest(), settings(), catalog(), slugs));
  }
  assert.throws(() => installer.planRemoveModels(manifest(), { routes: null }, catalog(), ["custom/claude"]));
  assert.throws(() => installer.planRemoveModels(manifest(), settings(), {}, ["custom/claude"]));
});

test("模型清單驗證同時檢查保留項目存在與刪除項目消失", () => {
  const wanted = ["custom/gpt"];
  const absent = ["custom/claude"];
  assert.equal(installer.hasExpectedModels({ data: [{ id: "custom/gpt" }] }, wanted, absent), true);
  assert.equal(installer.hasExpectedModels({ data: [{ id: "custom/gpt" }, { id: "custom/claude" }] }, wanted, absent), false);
  assert.equal(installer.hasExpectedModels({ data: [] }, wanted, absent), false);
  assert.equal(installer.hasExpectedModels({ data: [{ id: "gpt-official" }] }, [], absent), true);
});

test("只有刪除命中全域預設模型時才清除預設", () => {
  const config = { model: "custom/claude" };
  assert.equal(installer.removedDefaultModel(config, ["custom/claude"]), "custom/claude");
  assert.equal(installer.removedDefaultModel(config, ["custom/gpt"]), null);
  assert.equal(installer.removedDefaultModel({}, ["custom/claude"]), null);
});

test("選單按安裝、模型管理、其他設定、狀態與退出分組", () => {
  assert.deepEqual(installer.MENU_ITEMS.map(([action]) => action), [
    "install", "update", "add", "remove", "hidden-models", "context-1m", "imagegen", "status", "rollback", "exit",
  ]);
});

test("remove 輸入 cancel 不修改檔案也不建立備份", { skip: process.platform !== "darwin" }, t => {
  const root = mkdtempSync(join(tmpdir(), "router-remove-cancel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installRoot = join(root, "model-router");
  mkdirSync(installRoot);
  const files = new Map([
    ["router.mjs", "// fixture router\n"],
    ["claude-bridge.mjs", "// fixture bridge\n"],
    ["settings.json", JSON.stringify(settings())],
    ["models.json", JSON.stringify(catalog())],
    ["install.json", JSON.stringify(manifest())],
  ]);
  for (const [name, content] of files) writeFileSync(join(installRoot, name), content);
  const config = 'model = "custom/claude"\n';
  writeFileSync(join(root, "config.toml"), config);
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "codex-model-router.sh");
  const childEnv = {
    ...process.env,
    CODEX_HOME: root,
    CODEX_MODEL_ROUTER_CODEX_BIN: process.execPath,
    CODEX_MODEL_ROUTER_RELEASES_JSON: JSON.stringify({
      latest: "1.22.2", releases: [{ version: "1.22.2", changes: ["test"] }],
    }),
  };
  delete childEnv.CODEX_MODEL_ROUTER_IMPORT_ONLY;
  delete childEnv.CODEX_MODEL_ROUTER_YES;
  delete childEnv.CODEX_MODEL_ROUTER_BASE_URL;
  const child = spawnSync("bash", [script, "remove"], { env: childEnv, input: "cancel\n", encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /未進行任何修改/);
  const menu = spawnSync("bash", [script], { env: childEnv, input: "10\n", encoding: "utf8" });
  assert.equal(menu.status, 0, menu.stderr || menu.stdout);
  assert.match(menu.stdout, /10\. 退出/);
  assert.match(menu.stdout, /未進行任何修改/);
  for (const [name, content] of files) assert.equal(readFileSync(join(installRoot, name), "utf8"), content);
  assert.equal(readFileSync(join(root, "config.toml"), "utf8"), config);
  assert.equal(existsSync(join(root, "backups")), false);
});
