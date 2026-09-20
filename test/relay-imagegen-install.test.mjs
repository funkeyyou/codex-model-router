import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer, dir: payloadDir } = await loadPayloads();
const all = installer.RELAY_IMAGE_MODELS.map((model) => model.id);
const sourcePath = fileURLToPath(new URL("../codex-model-router.sh", import.meta.url));

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "router-imagegen-install-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { root: join(home, "skills", "router-imagegen"),
    settingsFile: join(home, "model-router", "settings.json"), backupRoot: join(home, "backups"),
    nodePath: process.execPath, sourcePath, models: all };
  return { home, options };
}

test("只偵測三種圖片模型，支援供應商前綴，完全不展示其他模型", () => {
  const found = installer.detectRelayImageModels(["ark/gpt-image-2.5-flare", "gpt-image-2", "gpt-image-1.5", "gpt-image-2.5-sunburst-preview", "gpt-6-astra"]);
  assert.deepEqual(found.map((model) => [model.id, model.upstreamModel]), [
    [all[0], all[0]], [all[2], "ark/gpt-image-2.5-flare"],
  ]);
  assert.deepEqual(installer.selectRelayImageModels("2", found), [all[2]]);
  assert.deepEqual(installer.selectRelayImageModels("all", found), [all[0], all[2]]);
  assert.throws(() => installer.selectRelayImageModels("3", found));
  assert.deepEqual(installer.detectRelayImageModels(["gpt-image-1", "image-other"]), []);
});

test("同名模型同時有原名與供應商前綴時，優先使用原名", () => {
  const found = installer.detectRelayImageModels(["ark/" + all[1], all[1]]);
  assert.equal(found[0].upstreamModel, all[1]);
});

test("安裝時拒絕生圖不寫技能，也不呼叫設定流程；可稍後獨立添加", async (t) => {
  const { options } = fixture(t);
  let configured = 0;
  const configure = () => { configured++; installer.installRelayImageSkill(options); };
  assert.equal(await installer.offerRelayImagegen({ consent: async () => false, configure }), false);
  assert.equal(configured, 0);
  assert.equal(existsSync(options.root), false);
  await configure();
  assert.equal(existsSync(join(options.root, "SKILL.md")), true);
});

test("同意後建立獨立技能、命令及模型限制，不寫入 Key 或官方技能", async (t) => {
  const { home, options } = fixture(t);
  const official = join(home, "skills", ".system", "imagegen");
  mkdirSync(official, { recursive: true });
  writeFileSync(join(official, "SKILL.md"), "official untouched");
  await installer.offerRelayImagegen({ consent: async () => true,
    configure: () => installer.installRelayImageSkill(options) });
  const config = JSON.parse(readFileSync(join(options.root, "config.json"), "utf8"));
  assert.deepEqual(config.models, all);
  assert.equal(config.routerSettingsPath, options.settingsFile);
  assert.equal(existsSync(join(options.root, "scripts", "imagegen.mjs")), true);
  assert.equal(readFileSync(join(official, "SKILL.md"), "utf8"), "official untouched");
  assert.equal(existsSync(options.settingsFile), false, "新增技能不重寫路由設定");
  assert.equal(existsSync(join(home, "config.toml")), false);
  assert.ok(!Object.keys(config).some((key) => /secret|apiKey|credential/i.test(key)));
});

test("既有技能更新保留手動修改與其他檔案，停用封存後可恢復", (t) => {
  const { options } = fixture(t);
  installer.installRelayImageSkill(options);
  writeFileSync(join(options.root, "SKILL.md"), "manual instructions");
  writeFileSync(join(options.root, "notes.txt"), "user notes");
  const updated = installer.installRelayImageSkill({ ...options, models: [all[2]] });
  assert.deepEqual(updated.preserved, ["SKILL.md"]);
  assert.equal(readFileSync(join(options.root, "SKILL.md"), "utf8"), "manual instructions");
  assert.equal(readFileSync(join(options.root, "notes.txt"), "utf8"), "user notes");
  assert.equal(readFileSync(join(updated.backup, "router-imagegen", "SKILL.md"), "utf8"), "manual instructions");
  const archive = join(options.backupRoot, "disabled");
  assert.equal(installer.archiveRelayImageSkill(archive, options.root, options.settingsFile), true);
  assert.equal(existsSync(options.root), false);
  assert.equal(readFileSync(join(archive, "router-imagegen", "notes.txt"), "utf8"), "user notes");
});

test("遇到同名非本路由器管理的技能或不同 CODEX_HOME 綁定，不覆寫", (t) => {
  const { options } = fixture(t);
  mkdirSync(options.root, { recursive: true });
  writeFileSync(join(options.root, "SKILL.md"), "user skill");
  assert.throws(() => installer.installRelayImageSkill(options), /未覆寫/);
  assert.equal(readFileSync(join(options.root, "SKILL.md"), "utf8"), "user skill");
  writeFileSync(join(options.root, "config.json"), JSON.stringify({ managedBy: "codex-model-router", routerSettingsPath: "different-home" }));
  assert.throws(() => installer.archiveRelayImageSkill(options.backupRoot, options.root, options.settingsFile), /未覆寫/);
});

test("更新在搬移新技能時失敗，會把完整舊技能還原", (t) => {
  const { options } = fixture(t);
  installer.installRelayImageSkill(options);
  const oldConfig = readFileSync(join(options.root, "config.json"));
  const oldSkill = readFileSync(join(options.root, "SKILL.md"));
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, "renameSync", (source, destination) => {
    if (String(source).includes(".router-imagegen-stage-") && destination === options.root) {
      throw Object.assign(new Error("fixture rename denied"), { code: "EACCES" });
    }
    return rename(source, destination);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => installer.installRelayImageSkill({ ...options, models: [all[2]] }), /fixture rename denied/);
    assert.deepEqual(readFileSync(join(options.root, "config.json")), oldConfig);
    assert.deepEqual(readFileSync(join(options.root, "SKILL.md")), oldSkill);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("拒絕三種以外的模型以及替換成其他模型的別名", (t) => {
  const { options } = fixture(t);
  assert.throws(() => installer.installRelayImageSkill({ ...options, models: ["gpt-image-1.5"] }));
  assert.throws(() => installer.installRelayImageSkill({ ...options, aliases: { [all[2]]: "gpt-image-other" } }));
  assert.equal(existsSync(options.root), false);
});

test("已同意的安裝會沿用授權刷新，不再重問同意", async () => {
  const existing = { models: all };
  let refreshed = false;
  await installer.offerRelayImagegen({ existing, consent: () => assert.fail("不應重問"),
    refresh: (value) => { assert.equal(value, existing); refreshed = true; } });
  assert.equal(refreshed, true);
});

async function setupThroughCommand(t, { ids = [], status = 200, answer = "all" } = {}) {
  const { home, options } = fixture(t);
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, auth: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    if (request.url === "/releases") {
      response.end(JSON.stringify({ latest: "1.20.0", releases: [{ version: "1.20.0", changes: ["fixture"] }] }));
    } else {
      response.statusCode = status;
      response.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const routerDir = join(home, "model-router");
  mkdirSync(routerDir);
  writeFileSync(join(routerDir, "install.json"), JSON.stringify({ version: "1.20.0" }));
  writeFileSync(options.settingsFile, JSON.stringify({ apiRoot: origin + "/v1", port: 48953, keychainService: "fixture" }));
  const before = readFileSync(options.settingsFile);
  const env = { ...process.env, CODEX_HOME: home, CODEX_MODEL_ROUTER_HOME: routerDir,
    CODEX_MODEL_ROUTER_SCRIPT_PATH: sourcePath, CODEX_MODEL_ROUTER_NODE_BIN: process.execPath,
    CODEX_MODEL_ROUTER_TEST_API_KEY: "fixture-key", CODEX_MODEL_ROUTER_RELEASES_URL: origin + "/releases" };
  delete env.CODEX_MODEL_ROUTER_IMPORT_ONLY;
  delete env.CODEX_MODEL_ROUTER_BASE_URL;
  const child = spawn(process.execPath, [join(payloadDir, "installer.mjs"), "imagegen"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let answered = false;
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (!answered && output.includes("選擇顯示的模型編號")) { answered = true; child.stdin.end(answer + "\n"); }
  });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [code] = await once(child, "exit");
  clearTimeout(timeout);
  assert.deepEqual(readFileSync(options.settingsFile), before);
  return { code, output, root: options.root, requests };
}

test("命令先用已保存 Key 偵測；只展示清單中存在的圖片模型並正確映射選號", async (t) => {
  const result = await setupThroughCommand(t, { ids: ["ark/" + all[2], "gpt-6-astra"], answer: "1" });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /1\. Image 2.5 Flare/);
  assert.doesNotMatch(result.output, /Sunburst|上一代圖片模型/);
  const config = JSON.parse(readFileSync(join(result.root, "config.json"), "utf8"));
  assert.deepEqual(config.models, [all[2]]);
  assert.equal(config.upstreamModels[all[2]], "ark/" + all[2]);
  assert.deepEqual(result.requests.filter((request) => request.path === "/v1/models"), [{ path: "/v1/models", auth: "Bearer fixture-key" }]);
  assert.equal(result.requests.some((request) => /images/.test(request.path)), false);
  assert.doesNotMatch(result.output, /fixture-key/);
});

test("三個模型都沒有時明確說無法添加，不建立技能", async (t) => {
  const result = await setupThroughCommand(t, { ids: ["gpt-6-astra", "gpt-image-1.5"] });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /沒有偵測到支援的圖片模型，無法添加/);
  assert.equal(existsSync(result.root), false);
});

test("模型清單 401 不冒充『沒有模型』，也不先建立技能", async (t) => {
  const result = await setupThroughCommand(t, { status: 401 });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /HTTP 401/);
  assert.doesNotMatch(result.output, /沒有偵測到/);
  assert.equal(existsSync(result.root), false);
});

test("發現模型後取消，仍不建立技能", async (t) => {
  const result = await setupThroughCommand(t, { ids: all, answer: "cancel" });
  assert.equal(result.code, 0, result.output);
  assert.equal(existsSync(result.root), false);
});
