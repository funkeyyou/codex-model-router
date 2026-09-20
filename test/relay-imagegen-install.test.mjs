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
import { fileURLToPath, pathToFileURL } from "node:url";
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

const probePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZB9sAAAAASUVORK5CYII=", "base64");

async function setupThroughCommand(t, { ids = [], status = 200, testModels = "all",
  imageResponses = {}, arkModels = [], routes = [], existingModels = null, extraEnv = {} } = {}) {
  const { home, options } = fixture(t);
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ path: request.url, method: request.method, auth: request.headers.authorization, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/releases") {
      response.end(JSON.stringify({ latest: "1.20.1", releases: [{ version: "1.20.1", changes: ["fixture"] }] }));
    } else if (request.url === "/v1/models") {
      response.statusCode = status;
      response.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
    } else if (request.url === "/v1/images/generations") {
      const result = imageResponses[body.model] || { status: 404, payload: { error: { message: "model_not_found" } } };
      response.statusCode = result.status || 200;
      response.end(JSON.stringify(result.payload || { data: [{ b64_json: probePng.toString("base64") }] }));
    } else if (request.url === "/v2/extend/image/ark_gpt_image/generations") {
      if (arkModels.includes(body.model)) response.end(JSON.stringify({ task_id: "img_gen_fixture" }));
      else { response.statusCode = 403; response.end(JSON.stringify({ error: "unavailable" })); }
    } else if (request.url === "/v2/extend/image/ark_gpt_image/tasks/img_gen_fixture") {
      response.end(JSON.stringify({ task_id: "img_gen_fixture", status: "succeeded", result: { images: [{ url: "https://images.example/fixture.png" }] } }));
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const routerDir = join(home, "model-router");
  mkdirSync(routerDir);
  writeFileSync(join(routerDir, "install.json"), JSON.stringify({ version: "1.20.0" }));
  writeFileSync(options.settingsFile, JSON.stringify({ apiRoot: origin + "/v1", port: 48953, keychainService: "fixture", routes }));
  if (existingModels) installer.installRelayImageSkill({ ...options, models: existingModels });
  const before = readFileSync(options.settingsFile);
  const configBefore = existingModels ? readFileSync(join(options.root, "config.json")) : null;
  const env = { ...process.env, CODEX_HOME: home, CODEX_MODEL_ROUTER_HOME: routerDir,
    CODEX_MODEL_ROUTER_SCRIPT_PATH: sourcePath, CODEX_MODEL_ROUTER_NODE_BIN: process.execPath,
    CODEX_MODEL_ROUTER_TEST_API_KEY: "fixture-key", CODEX_MODEL_ROUTER_RELEASES_URL: origin + "/releases", ...extraEnv };
  delete env.CODEX_MODEL_ROUTER_IMPORT_ONLY;
  delete env.CODEX_MODEL_ROUTER_BASE_URL;
  // 只在測試子行程替換圖片下載；產品程式不提供繞過公開 URL 驗證的環境開關。
  const preload = join(home, "mock-image-download.mjs");
  writeFileSync(preload, [
    'import https from "node:https";', 'import dns from "node:dns/promises";',
    'import { Readable } from "node:stream";', 'import { EventEmitter } from "node:events";',
    'import { syncBuiltinESMExports } from "node:module";',
    'dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];',
    'https.get = (url, options, callback) => {',
    '  if (String(url) !== "https://images.example/fixture.png" || options.headers.authorization) throw new Error("unexpected image download");',
    '  const request = new EventEmitter();',
    `  queueMicrotask(() => { const response = Readable.from([Buffer.from(${JSON.stringify(probePng.toString("base64"))}, "base64")]); response.statusCode = 200; response.headers = {}; callback(response); });`,
    '  return request;', '};', 'syncBuiltinESMExports();',
  ].join("\n"));
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, join(payloadDir, "installer.mjs"), "imagegen"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  const replies = [
    { marker: "選擇要偵測的模型編號", answer: testModels },
  ];
  child.stdout.on("data", (chunk) => {
    output += chunk;
    for (const reply of replies) {
      if (reply.sent || !output.includes(reply.marker)) continue;
      reply.sent = true;
      child.stdin.write(reply.answer + "\n");
    }
  });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [code] = await once(child, "close");
  clearTimeout(timeout);
  assert.deepEqual(readFileSync(options.settingsFile), before);
  assert.doesNotMatch(output, /是否同意|清單未列出的圖片模型前綴|選擇顯示的模型編號/);
  return { code, output, root: options.root, routerDir, requests, configBefore };
}

test("選 all 時測三個模型，只讓成功回圖的模型可選，正確映射動態選號", async (t) => {
  const result = await setupThroughCommand(t, { ids: ["ark/" + all[2], "gpt-6-astra"],
    imageResponses: { ["ark/" + all[2]]: {} } });
  assert.equal(result.code, 0, result.output);
  const choices = result.output.split("以下已選模型通過生圖測試，將自動添加：")[1];
  assert.match(choices, /1\. Image 2.5 Flare/);
  assert.doesNotMatch(choices, /Sunburst|上一代圖片模型/);
  const config = JSON.parse(readFileSync(join(result.root, "config.json"), "utf8"));
  assert.deepEqual(config.models, [all[2]]);
  assert.equal(config.upstreamModels[all[2]], "ark/" + all[2]);
  assert.equal(config.apiMode, "images");
  assert.equal(result.requests.some((r) => r.path.includes("ark_gpt_image")), false);
  assert.equal(result.requests.find((request) => request.path === "/v1/models").auth, "Bearer fixture-key");
  const paid = result.requests.filter((request) => /images/.test(request.path));
  assert.deepEqual(paid.map((request) => request.body.model), all.map((id) => "ark/" + id));
  for (const request of paid) {
    assert.equal(request.auth, "Bearer fixture-key");
    assert.equal(request.body.n, 1);
    assert.equal(request.body.quality, "low");
    assert.equal(request.body.size, "1024x1024");
  }
  assert.doesNotMatch(result.output, /fixture-key/);
});

test("清單沒有圖片模型時，依既有路由前綴實測成功後仍可添加，保留測試圖片", async (t) => {
  const result = await setupThroughCommand(t, { ids: ["ark/gpt-6-astra"], routes: [{ upstreamModel: "ark/gpt-6-astra" }],
    testModels: "2,3", imageResponses: Object.fromEntries(all.map((id) => ["ark/" + id, {}])) });
  assert.equal(result.code, 0, result.output);
  const config = JSON.parse(readFileSync(join(result.root, "config.json"), "utf8"));
  assert.deepEqual(config.models, all.slice(1));
  assert.equal(config.upstreamModels[all[1]], "ark/" + all[1]);
  const probeDir = join(result.routerDir, "imagegen-probes");
  const generated = fs.readdirSync(join(probeDir, fs.readdirSync(probeDir)[0]));
  assert.deepEqual(generated.sort(), all.slice(1).map((id) => `${id}.png`).sort());
  assert.deepEqual(result.requests.filter((r) => /images/.test(r.path)).map((r) => r.body.model), all.slice(1).map((id) => "ark/" + id));
  assert.match(result.output, /每種介面最多測 2 次/);
});

test("只選 Flare 就只測一次，即使重複填編號也不重送；未選模型不觸發前綴問題", async (t) => {
  const result = await setupThroughCommand(t, { ids: ["ark/" + all[2]], testModels: "3,3",
    imageResponses: Object.fromEntries(all.map((id) => ["ark/" + id, {}])) });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.requests.filter((r) => /images/.test(r.path)).map((r) => r.body.model), ["ark/" + all[2]]);
  assert.match(result.output, /每種介面最多測 1 次/);
  assert.doesNotMatch(result.output, /清單未列出的圖片模型前綴/);
  const config = JSON.parse(readFileSync(join(result.root, "config.json"), "utf8"));
  assert.deepEqual(config.models, [all[2]]);
});

test("測試選擇留空時，新設定預選 Flare，既有設定只預選已啟用模型", async (t) => {
  for (const existingModels of [null, [all[0], all[1]]]) {
    const result = await setupThroughCommand(t, { ids: all, testModels: "", existingModels,
      imageResponses: Object.fromEntries(all.map((id) => [id, {}])) });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(result.requests.filter((r) => /images/.test(r.path)).map((r) => r.body.model), existingModels || [all[2]]);
  }
});

test("選測模型時取消或輸入無效編號，不查上游模型、不生圖、不更動技能", async (t) => {
  for (const testModels of ["cancel", "4"]) {
    const result = await setupThroughCommand(t, { testModels, existingModels: [all[2]] });
    assert.equal(result.code, testModels === "cancel" ? 0 : 1, result.output);
    assert.equal(result.requests.some((r) => r.path.startsWith("/v1/")), false);
    assert.deepEqual(readFileSync(join(result.root, "config.json")), result.configBefore);
  }
});

test("已選模型通用失敗時只回退同一模型，未選模型不測不添加", async (t) => {
  const result = await setupThroughCommand(t, { ids: all, testModels: "2",
    imageResponses: { [all[0]]: {}, [all[2]]: {} } });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.requests.filter((r) => /images/.test(r.path)).map((r) => r.body.model), [all[1]]);
  assert.deepEqual(result.requests.filter((r) => r.path.endsWith("/ark_gpt_image/generations")).map((r) => r.body.model), [all[1]]);
  assert.match(result.output, /沒找到可用模型/);
  assert.equal(existsSync(result.root), false);
});

test("兩種流程都未通過時只顯示沒找到可用模型，不建立技能", async (t) => {
  const result = await setupThroughCommand(t, { ids: ["gpt-6-astra", "gpt-image-1.5"] });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /沒找到可用模型/);
  assert.doesNotMatch(result.output, /HTTP 404|model_not_found|unavailable/);
  assert.equal(result.requests.filter((r) => r.method === "POST").length, 6);
  const diagnostic = JSON.parse(readFileSync(join(result.routerDir, "imagegen-last-check.json"), "utf8"));
  assert.equal(diagnostic.checks.length, 6);
  assert.ok(diagnostic.checks.every((check) => check.ok === false && typeof check.error === "string"));
  assert.doesNotMatch(JSON.stringify(diagnostic), /fixture-key|authorization/);
  assert.equal(existsSync(result.root), false);
  assert.equal(existsSync(join(result.routerDir, "imagegen-probes")), false);
});

test("模型清單不可用時仍自動推斷前綴，不詢問額外問題", async (t) => {
  const result = await setupThroughCommand(t, { status: 401, routes: [{ upstreamModel: "akr/gpt-6-astra" }], imageResponses: { ["akr/" + all[0]]: {} } });
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /HTTP 401/);
  const config = JSON.parse(readFileSync(join(result.root, "config.json"), "utf8"));
  assert.deepEqual(config.upstreamModels, { [all[0]]: "akr/" + all[0] });
});

test("通用全部失敗後自動用 Ark 查任務並下載，記住模式與成功模型", async (t) => {
  const result = await setupThroughCommand(t, { ids: ["ark/gpt-6-astra"], testModels: "2,3", arkModels: [all[2]] });
  assert.equal(result.code, 0, result.output);
  const posts = result.requests.filter((r) => r.method === "POST");
  assert.deepEqual(posts.map((r) => r.body.model), ["ark/" + all[1], "ark/" + all[2], all[1], all[2]]);
  for (const r of posts.filter((r) => r.path.includes("ark_gpt_image"))) {
    assert.deepEqual(Object.keys(r.body).sort(), ["model", "output_format", "prompt"]);
  }
  assert.equal(result.requests.filter((r) => r.path.includes("/tasks/")).length, 1);
  const config = JSON.parse(readFileSync(join(result.root, "config.json"), "utf8"));
  assert.equal(config.apiMode, "ark-task");
  assert.deepEqual(config.models, [all[2]]);
  assert.deepEqual(config.upstreamModels, { [all[2]]: all[2] });
});

test("none 直接停用，不查模型也不生圖", async (t) => {
  const result = await setupThroughCommand(t, { testModels: "none", existingModels: [all[2]] });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.requests.some((request) => request.path !== "/releases"), false);
  assert.equal(existsSync(result.root), false);
});

test("兩種實測都失敗時保留完整既有生圖設定", async (t) => {
  const result = await setupThroughCommand(t, { ids: all, existingModels: [all[0]] });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(readFileSync(join(result.root, "config.json")), result.configBefore);
});

test("HTTP 200 卻沒有圖片時不讓模型成為可選項", async (t) => {
  const result = await setupThroughCommand(t, { ids: all,
    imageResponses: Object.fromEntries(all.map((id) => [id, { payload: { data: [] } }])) });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /沒找到可用模型/);
  assert.doesNotMatch(result.output, /選擇顯示的模型編號/);
  assert.equal(existsSync(result.root), false);
});
