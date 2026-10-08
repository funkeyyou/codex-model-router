// 端對端：真的執行安裝器的 ui 命令，透過網頁 API 操作。
//
// 1. 排序與修改：真的路由器、真的 Codex app-server（合成登入、本機假上游），驗證只改模型目錄、
//    不重啟路由器，且 Codex 的模型清單驗證通過；也驗證重複開啟會沿用同一個管理頁。
// 2. 一鍵更新：本機假發佈伺服器提供新版安裝器與 SHA256SUMS，驗證下載、核對與執行，
//    以及雜湊不符、檔案還沒發佈時都會停下。
// 不送任何推理請求，不碰真的憑證、背景服務或使用者設定。

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexBin } from "./helpers/codex-bin.mjs";
import { loadPayloads } from "./helpers/payloads.mjs";

const { dir: payloadDir } = await loadPayloads();
const shellPath = fileURLToPath(new URL("../codex-model-router.sh", import.meta.url));
const releases = JSON.parse(readFileSync(new URL("../releases.json", import.meta.url), "utf8"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 逾時用的計時器要 unref：比賽贏的一方先結束時，它不能讓測試檔多掛著等它跑完。
const timeoutAfter = (ms, value) => new Promise((resolve) => setTimeout(resolve, ms, value).unref());

// 額外的本機驗收：只控制當次產生的測試 App，絕不重新啟動使用者的 ChatGPT。
// 明確加 CODEX_MODEL_ROUTER_TEST_DESKTOP_RESTART=1 才跑，CI 不碰 GUI / launchd。
test("macOS launchd 接手管理頁後，獨立 worker 能正常結束並重新開啟測試 App", {
  skip: process.platform !== "darwin" || process.env.CODEX_MODEL_ROUTER_TEST_DESKTOP_RESTART !== "1",
  timeout: 120000,
}, async (t) => {
  const defer = cleanupStack(t);
  const root = mkdtempSync(join(tmpdir(), "router-manager-desktop-"));
  defer(() => removeTree(root));
  const runtime = join(root, "model-router");
  mkdirSync(runtime);
  copyFileSync(shellPath, join(runtime, "codex-model-router.sh"));
  const app = join(root, "RouterRestartTest-" + Date.now() + ".app");
  execFileSync("/usr/bin/osacompile", ["-s", "-o", app, "-e", "on idle", "-e", "return 60", "-e", "end idle",
    "-e", "on quit", "-e", "continue quit", "-e", "end quit"], { timeout: 30000 });
  const bundleId = "com.example.router-restart-" + Date.now();
  execFileSync("/usr/bin/plutil", ["-insert", "CFBundleIdentifier", "-string", bundleId, join(app, "Contents", "Info.plist")]);
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], { timeout: 10000 });
  const running = () => execFileSync("/usr/bin/osascript", ["-e", `application ${JSON.stringify(app)} is running`], { encoding: "utf8", timeout: 10000 }).trim() === "true";
  defer(() => { if (running()) execFileSync("/usr/bin/osascript", ["-e", `tell application ${JSON.stringify(app)} to quit`], { timeout: 15000 }); });
  execFileSync("/usr/bin/open", ["-g", app], { timeout: 10000 });
  for (let attempt = 0; attempt < 100 && !running(); attempt += 1) await delay(100);
  assert.equal(running(), true, "測試 App 已啟動");
  const provider = { baseUrl: "http://127.0.0.1:9", apiRoot: "http://127.0.0.1:9/v1", keychainService: "fixture.desktop" };
  for (const name of ["install.json", "settings.json"]) writeFileSync(join(runtime, name), JSON.stringify({ version: releases.latest, port: 9, routes: [], ...provider }));
  writeFileSync(join(runtime, "models.json"), JSON.stringify({ models: [] }));
  const environment = baseEnv(root, runtime);
  environment.CODEX_MODEL_ROUTER_TEST_MODE = "0"; // 真的走 launchctl submit，但 App 強制指定為測試用。
  environment.CODEX_MODEL_ROUTER_DESKTOP_APP = app;
  const ui = await startManager(defer, environment);
  defer(async () => {
    try { await ui.call("/api/shutdown", { method: "POST" }); } catch {}
    for (let attempt = 0; attempt < 200 && readdirSync(runtime).some((name) => /^manager-worker-.*\.mjs$/.test(name)); attempt += 1) await delay(50);
  });
  const previousPing = (await ui.call("/api/ping", { method: "POST" })).json;
  const started = await ui.call("/api/jobs", { method: "POST", body: { type: "restart-desktop", params: {} } });
  assert.equal(started.status, 202);
  assert.equal((await ui.waitExit())[0], 0, ui.output());
  assert.notEqual((await ui.call("/api/ping", { method: "POST" })).json.instanceId, previousPing.instanceId);
  let finished;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    finished = (await ui.call("/api/jobs/" + started.json.id)).json;
    if (finished.status !== "running") break;
    await delay(100);
  }
  assert.equal(finished.status, "succeeded", JSON.stringify(finished));
  assert.equal(finished.result.desktopRestarted, true, finished.output + "\n" + finished.result.desktopError);
  assert.match(finished.output, /正常結束/);
  assert.match(finished.output, /已確認.*重新啟動/);
  assert.equal(running(), true);
});

// 清理依登記的相反順序執行（像 defer）：先停子行程，最後才刪暫存目錄。Windows 不能刪除子行程
// 還在使用的目錄（例如它的工作目錄）；刪除失敗也不能讓子行程留著，否則整個測試檔不會結束。
function cleanupStack(t) {
  const tasks = [];
  t.after(async () => {
    for (const task of tasks.reverse()) {
      try { await task(); } catch { /* 一項清理失敗不影響其他清理 */ }
    }
  });
  return (task) => { tasks.push(task); };
}

async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = once(child, "exit");
  child.kill();
  await Promise.race([exited, timeoutAfter(10000)]);
}

const removeTree = (path) => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

// Windows 上設定寫入失敗時，附上仍在執行的 codex 行程，判斷是不是有行程沒結束、還開著檔案。
function windowsProcesses() {
  if (process.platform !== "win32") return "";
  try {
    return "\n" + execFileSync("tasklist", ["/FI", "IMAGENAME eq codex.exe"], { encoding: "utf8", timeout: 10000 });
  } catch (error) {
    return "\n(tasklist 失敗：" + error.message + ")";
  }
}

function baseEnv(root, runtime, extra = {}) {
  const env = {
    ...process.env, CODEX_HOME: root, CODEX_MODEL_ROUTER_HOME: runtime,
    CODEX_MODEL_ROUTER_SCRIPT_PATH: shellPath, CODEX_MODEL_ROUTER_NODE_BIN: process.execPath,
    CODEX_MODEL_ROUTER_CODEX_BIN: process.execPath, CODEX_MODEL_ROUTER_TEST_MODE: "1",
    CODEX_MODEL_ROUTER_TEST_API_KEY: "fixture-key", CODEX_MODEL_ROUTER_RELEASES_JSON: JSON.stringify(releases),
    CODEX_MODEL_ROUTER_UI_NO_OPEN: "1", CODEX_MODEL_ROUTER_SHORTCUT_DIR: join(root, "shortcuts"),
    ...extra,
  };
  for (const name of ["CODEX_MODEL_ROUTER_IMPORT_ONLY", "CODEX_MODEL_ROUTER_BASE_URL", "CODEX_MODEL_ROUTER_YES",
    "CODEX_MODEL_ROUTER_TEST_MODELS", "CODEX_MODEL_ROUTER_UI_TOKEN", "CODEX_MODEL_ROUTER_DESKTOP_APP"]) delete env[name];
  return env;
}

async function startManager(defer, env) {
  const child = spawn(process.execPath, [join(payloadDir, "installer.mjs"), "ui"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const exited = once(child, "exit");
  defer(() => stopChild(child));
  const match = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ui 沒有啟動：\n" + output)), 20000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const found = /網址：(http:\/\/127\.0\.0\.1:(\d+)\/#t=(\S+))/.exec(output);
      if (found) { clearTimeout(timer); resolve(found); }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error("ui 提前結束（" + code + "）：\n" + output)); });
  });
  const port = Number(match[2]);
  const token = decodeURIComponent(match[3]);
  const call = async (path, { method = "GET", body } = {}) => {
    const response = await fetch("http://127.0.0.1:" + port + path, {
      method,
      headers: { "x-router-manager-token": token, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      body: method === "POST" ? JSON.stringify(body || {}) : undefined,
    });
    return { status: response.status, json: await response.json() };
  };
  const runJob = async (type, params) => {
    const started = await call("/api/jobs", { method: "POST", body: { type, params } });
    assert.equal(started.status, 202, JSON.stringify(started.json));
    let view = started.json;
    let text = view.output;
    for (let attempt = 0; attempt < 600 && view.status === "running"; attempt += 1) {
      await delay(100);
      view = (await call("/api/jobs/" + started.json.id + "?offset=" + view.offset)).json;
      text += view.output;
    }
    return { ...view, output: text };
  };
  // 結束時最多等 20 秒；逾時回傳 "timeout"，讓斷言失敗而不是卡住。
  const waitExit = () => Promise.race([exited, timeoutAfter(20000, ["timeout"])]);
  return { child, waitExit, port, token, call, runJob, output: () => output, url: match[1] };
}

test("網頁管理介面：排序與修改只改模型目錄，Codex 模型清單仍完整", { skip: !codexBin && "需要 Codex CLI", timeout: 120000 }, async (t) => {
  const defer = cleanupStack(t);
  const root = mkdtempSync(join(tmpdir(), "router-manager-e2e-"));
  defer(() => removeTree(root));
  const runtime = join(root, "model-router");
  mkdirSync(runtime);
  const codexEnv = { ...process.env, CODEX_HOME: root };
  delete codexEnv.CODEX_MODEL_ROUTER_IMPORT_ONLY;
  const bundled = JSON.parse(execFileSync(codexBin, ["debug", "models", "--bundled"], { env: codexEnv, cwd: root, encoding: "utf8" }));
  const template = bundled.models.find((model) => model.visibility === "list");
  const entry = (slug, extra = {}) => ({ ...template, slug, display_name: slug, visibility: "list", ...extra });
  const official = [entry("gpt-6-sol")];

  const upstream = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url.startsWith("/models") ? { models: official } : { data: [] }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  defer(() => { upstream.closeAllConnections(); upstream.close(); });
  const reservation = http.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));

  for (const name of ["router.mjs", "bridge.mjs", "claude-bridge.mjs", "chat-bridge.mjs", "claude-cli.mjs"]) {
    if (existsSync(join(payloadDir, name))) copyFileSync(join(payloadDir, name), join(runtime, name));
  }
  const routes = [
    { pickerSlug: "custom/e2e-a", upstreamModel: "e2e-a", displayName: "api/e2e-a", providerHost: "127.0.0.1", efforts: ["high"], contextWindow: 200000 },
    { pickerSlug: "custom/e2e-b", upstreamModel: "e2e-b", displayName: "api/e2e-b", providerHost: "127.0.0.1", efforts: ["low", "high"], contextWindow: null },
  ];
  const catalogPath = join(runtime, "models.json");
  const catalog = { models: [...official, entry("custom/e2e-a", { display_name: "api/e2e-a", context_window: 200000 }), entry("custom/e2e-b", { display_name: "api/e2e-b" })] };
  writeFileSync(catalogPath, JSON.stringify(catalog));
  const upstreamRoot = "http://127.0.0.1:" + upstream.address().port;
  const provider = { baseUrl: upstreamRoot + "/p1", apiRoot: upstreamRoot + "/p1/v1", keychainService: "fixture.e2e" };
  writeFileSync(join(runtime, "settings.json"), JSON.stringify({ version: releases.latest, ...provider,
    officialBaseUrl: upstreamRoot, catalogPath, logPath: join(runtime, "router.err.log"), port, routes }));
  writeFileSync(join(runtime, "install.json"), JSON.stringify({ version: releases.latest, port, routes, ...provider }));
  writeFileSync(join(root, "config.toml"), "openai_base_url = \"http://127.0.0.1:" + port + "/v1\"\n");
  const jwt = "e30." + Buffer.from(JSON.stringify({ sub: "fixture", email: "fixture@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture", chatgpt_plan_type: "plus", chatgpt_user_id: "fixture" },
  })).toString("base64url") + ".fake";
  writeFileSync(join(root, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", last_refresh: new Date().toISOString(),
    tokens: { access_token: jwt, id_token: jwt, refresh_token: "fake", account_id: "fixture" } }));

  const router = spawn(process.execPath, [join(runtime, "router.mjs")], { env: codexEnv, cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  defer(() => stopChild(router));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("router startup timeout")), 8000);
    router.stderr.on("data", (data) => { if (String(data).includes("model-router-ready:")) { clearTimeout(timer); resolve(); } });
    router.once("error", reject);
  });

  const env = baseEnv(root, runtime, { CODEX_MODEL_ROUTER_CODEX_BIN: codexBin });
  const ui = await startManager(defer, env);
  const lock = JSON.parse(readFileSync(join(runtime, "manager.json"), "utf8"));
  assert.equal(lock.port, ui.port);

  const state = await ui.call("/api/state");
  assert.equal(state.status, 200);
  assert.equal(state.json.installed, true);
  assert.equal(state.json.writeBlocked, null);
  assert.equal(state.json.router.ok, true);
  assert.equal(state.json.versions.installed, releases.latest);
  assert.deepEqual(state.json.models.map((model) => model.slug), ["custom/e2e-a", "custom/e2e-b"]);
  assert.deepEqual(state.json.providers.map((item) => [item.id, item.primary, item.keyStored, item.modelCount]), [["default", true, true, 2]]);
  assert.equal(state.json.models[0].contextSource, "configured");
  assert.equal(state.json.models[1].contextSource, "template");
  assert.deepEqual(state.json.models.map((model) => [model.outputConfigurable, model.outputTokens]), [[false, null], [false, null]],
    "Responses 路由的輸出由上游決定");

  // 重複開啟：沿用正在執行的管理頁，不另開第二個。
  const again = spawn(process.execPath, [join(payloadDir, "installer.mjs"), "ui"], { env, stdio: ["ignore", "pipe", "pipe"] });
  defer(() => stopChild(again));
  let againOutput = "";
  again.stdout.on("data", (chunk) => { againOutput += chunk; });
  again.stderr.on("data", (chunk) => { againOutput += chunk; });
  const [againCode] = await Promise.race([once(again, "exit"), timeoutAfter(20000, ["timeout"])]);
  assert.equal(againCode, 0, againOutput);
  assert.match(againOutput, /網頁管理介面已經在執行/);
  assert.ok(againOutput.includes(ui.url), againOutput);

  const reorder = await ui.runJob("reorder-models", { slugs: ["custom/e2e-b", "custom/e2e-a"] });
  assert.equal(reorder.status, "succeeded", reorder.output);
  assert.match(reorder.output, /不需要重新啟動路由器/);
  const reordered = JSON.parse(readFileSync(catalogPath, "utf8"));
  assert.deepEqual(reordered.models.filter((model) => model.slug.startsWith("custom/")).map((model) => model.slug), ["custom/e2e-b", "custom/e2e-a"]);
  assert.equal(JSON.parse(readFileSync(join(runtime, "settings.json"), "utf8")).customModelOrder, "manual");
  assert.deepEqual((await ui.call("/api/state")).json.models.map((model) => model.slug), ["custom/e2e-b", "custom/e2e-a"]);
  assert.ok(readdirSync(join(root, "backups", "model-router")).some((name) => name.startsWith("reorder-models-")));

  const edit = await ui.runJob("edit-model", { slug: "custom/e2e-a", displayName: "我的 A", contextWindow: 333000 });
  assert.equal(edit.status, "succeeded", edit.output);
  const edited = JSON.parse(readFileSync(catalogPath, "utf8")).models.find((model) => model.slug === "custom/e2e-a");
  assert.deepEqual([edited.display_name, edited.context_window, edited.max_context_window], ["我的 A", 333000, 333000]);
  const savedRoute = JSON.parse(readFileSync(join(runtime, "settings.json"), "utf8")).routes.find((route) => route.pickerSlug === "custom/e2e-a");
  assert.deepEqual([savedRoute.displayName, savedRoute.contextWindow], ["我的 A", 333000]);
  assert.equal(JSON.parse(readFileSync(join(runtime, "install.json"), "utf8")).routes[0].displayName, "我的 A");

  const before = readFileSync(catalogPath, "utf8");
  const invalid = await ui.runJob("edit-model", { slug: "custom/e2e-a", contextWindow: 5 });
  assert.equal(invalid.status, "failed");
  assert.match(invalid.error, /上下文上限必須是/);
  assert.equal(readFileSync(catalogPath, "utf8"), before, "驗證失敗不能動到檔案");

  // 全域上下文：經由真的 Codex 設定 API 寫入與移除，其他設定保留。
  const query = async (type) => (await ui.call("/api/query", { method: "POST", body: { type } })).json;
  const contextBefore = await query("global-context");
  assert.equal(contextBefore.value, null, JSON.stringify(contextBefore));
  const setContext = await ui.runJob("set-global-context", { value: 1000000 });
  assert.equal(setContext.status, "succeeded", setContext.output + windowsProcesses());
  assert.equal(setContext.result.restartDesktop, true);
  assert.match(readFileSync(join(root, "config.toml"), "utf8"), /model_context_window = 1000000/);
  assert.ok(readFileSync(join(root, "config.toml"), "utf8").includes("http://127.0.0.1:" + port + "/v1"), "其他設定保留");
  // 設定完成後管理頁會在背景讀一次設定，這裡的查詢緊接在後；兩個 Codex 行程不能同時跑（Windows 會失敗）。
  const contextAfter = await query("global-context");
  assert.equal(contextAfter.value, 1000000, JSON.stringify(contextAfter));
  const sameContext = await ui.runJob("set-global-context", { value: 1000000 });
  assert.deepEqual([sameContext.status, sameContext.result.changed], ["succeeded", false]);
  const badContext = await ui.runJob("set-global-context", { value: 5 });
  assert.equal(badContext.status, "failed");
  assert.match(badContext.error, /全域上下文必須是/);
  const clearContext = await ui.runJob("set-global-context", { value: null });
  assert.equal(clearContext.status, "succeeded", clearContext.output + windowsProcesses());
  assert.doesNotMatch(readFileSync(join(root, "config.toml"), "utf8"), /model_context_window/);
  const contextCleared = await query("global-context");
  assert.equal(contextCleared.value, null, JSON.stringify(contextCleared));
  assert.ok(readdirSync(join(root, "backups", "model-router")).filter((name) => name.startsWith("global-context-")).length >= 2);

  // 隱藏的官方模型：清單來自 Codex 內建目錄，只列 visibility=hide 的官方模型。
  const hiddenResponse = await query("hidden-models");
  assert.ok(Array.isArray(hiddenResponse.models), JSON.stringify(hiddenResponse));
  const hiddenModels = hiddenResponse.models;
  const expectedHidden = bundled.models.filter((model) => model.visibility === "hide" && !model.slug.startsWith("custom/")).map((model) => model.slug);
  assert.deepEqual(hiddenModels.map((model) => model.slug), expectedHidden);
  const unknownHidden = await ui.runJob("set-hidden-models", { slugs: ["custom/e2e-a"] });
  assert.equal(unknownHidden.status, "failed");
  assert.match(unknownHidden.error, /不是可強制顯示的隱藏模型/);

  assert.equal((await ui.call("/api/jobs", { method: "POST", body: { type: "nope" } })).status, 400);
  assert.equal((await ui.call("/api/shutdown", { method: "POST" })).status, 202);
  const [code] = await ui.waitExit();
  assert.equal(code, 0, ui.output());
  assert.equal(existsSync(join(runtime, "manager.json")), false, "結束後移除管理頁的鎖檔");
});

// 中轉生圖：本機假圖片 API，驗證偵測、技能安裝、狀態查詢與停用；不送任何真的生圖請求。
test("網頁管理介面：偵測並啟用中轉生圖，再停用封存", { timeout: 60000 }, async (t) => {
  const defer = cleanupStack(t);
  const root = mkdtempSync(join(tmpdir(), "router-manager-imagegen-"));
  defer(() => removeTree(root));
  const runtime = join(root, "model-router");
  mkdirSync(runtime);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZB9sAAAAASUVORK5CYII=", "base64");
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ path: request.url, auth: request.headers.authorization, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "ark/gpt-image-2.5-flare" }, { id: "ark/gpt-6-sol" }] }));
    } else if (request.url === "/v1/images/generations" && body.model === "ark/gpt-image-2.5-flare") {
      response.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { message: "model_not_found" } }));
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  defer(() => { upstream.closeAllConnections(); upstream.close(); });
  const origin = "http://127.0.0.1:" + upstream.address().port;
  const provider = { baseUrl: origin, apiRoot: origin + "/v1", keychainService: "fixture.imagegen" };
  writeFileSync(join(runtime, "settings.json"), JSON.stringify({ version: releases.latest, port: 9, routes: [], ...provider }));
  writeFileSync(join(runtime, "install.json"), JSON.stringify({ version: releases.latest, port: 9, routes: [], ...provider }));
  writeFileSync(join(runtime, "models.json"), JSON.stringify({ models: [] }));

  const ui = await startManager(defer, baseEnv(root, runtime));
  const query = async (type) => (await ui.call("/api/query", { method: "POST", body: { type } })).json;
  const before = await query("imagegen");
  assert.deepEqual([before.enabled, before.models, before.lastCheck], [false, [], null]);
  assert.deepEqual(before.choices.map((choice) => choice.id), ["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"]);

  const invalid = await ui.runJob("imagegen-setup", { models: ["gpt-image-1"] });
  assert.equal(invalid.status, "failed");
  assert.equal(requests.length, 0, "選擇無效時不能查上游或生圖");

  const setup = await ui.runJob("imagegen-setup", { models: ["gpt-image-2.5-flare", "gpt-image-2"] });
  assert.equal(setup.status, "succeeded", setup.output);
  assert.deepEqual(setup.result.models, ["gpt-image-2.5-flare"]);
  assert.equal(setup.result.apiMode, "images");
  assert.match(setup.output, /已啟用 \$router-imagegen/);
  const generations = requests.filter((request) => request.path === "/v1/images/generations");
  assert.deepEqual(generations.map((request) => request.body.model), ["ark/gpt-image-2", "ark/gpt-image-2.5-flare"], "只測勾選的模型，並沿用清單上的前綴");
  assert.ok(generations.every((request) => request.auth === "Bearer fixture-key" && request.body.quality === "low"));
  const skillRoot = join(root, "skills", "router-imagegen");
  const config = JSON.parse(readFileSync(join(skillRoot, "config.json"), "utf8"));
  assert.deepEqual([config.models, config.upstreamModels["gpt-image-2.5-flare"], config.apiMode], [["gpt-image-2.5-flare"], "ark/gpt-image-2.5-flare", "images"]);
  assert.ok(existsSync(join(skillRoot, "SKILL.md")));
  assert.ok(existsSync(setup.result.probeRoot), "保留測試圖片");

  const enabled = await query("imagegen");
  assert.deepEqual([enabled.enabled, enabled.models, enabled.providerId, enabled.apiMode], [true, ["gpt-image-2.5-flare"], "default", "images"]);
  assert.deepEqual(enabled.lastCheck.checks.map((check) => [check.model, check.ok]), [["ark/gpt-image-2", false], ["ark/gpt-image-2.5-flare", true]]);

  const disabled = await ui.runJob("imagegen-disable", {});
  assert.equal(disabled.status, "succeeded", disabled.output);
  assert.equal(existsSync(skillRoot), false);
  assert.ok(existsSync(join(disabled.result.backup, "router-imagegen", "config.json")), "停用後可以從備份恢復");
  assert.equal((await query("imagegen")).enabled, false);
  const again = await ui.runJob("imagegen-disable", {});
  assert.equal(again.status, "failed");
  assert.match(again.error, /尚未啟用/);

  assert.equal((await ui.call("/api/shutdown", { method: "POST" })).status, 202);
  assert.equal((await ui.waitExit())[0], 0, ui.output());
});

// Claude CLI：用假的 CLI 驗證狀態查詢、模型清單與登入流程；不會呼叫真的 Claude，也不花用量。
test("網頁管理介面：Claude CLI 的狀態、模型清單與登入", {
  skip: (process.platform === "win32" || /\s/.test(process.execPath)) && "需要可直接執行的 shebang 腳本", timeout: 60000,
}, async (t) => {
  const defer = cleanupStack(t);
  const root = mkdtempSync(join(tmpdir(), "router-manager-claude-"));
  defer(() => removeTree(root));
  const runtime = join(root, "model-router");
  mkdirSync(runtime);
  const loginMarker = join(root, "login-ran");
  const fakeCli = join(root, "fake-claude");
  writeFileSync(fakeCli, [
    "#!" + process.execPath,
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') { console.log('2.1.285 (Claude Code)'); process.exit(0); }",
    "if (args[0] === 'auth' && args[1] === 'status') {",
    "  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }));",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'auth' && args[1] === 'login') { fs.writeFileSync(" + JSON.stringify(loginMarker) + ", 'ok'); process.exit(0); }",
    "let buffer = '';",
    "process.stdin.on('data', (chunk) => {",
    "  buffer += chunk;",
    "  if (!buffer.includes('\\n')) return;",
    "  const request = JSON.parse(buffer.split('\\n')[0]);",
    "  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id,",
    "    response: { models: [",
    "      { value: 'opus', resolvedModel: 'claude-opus-5-5', description: 'Opus 5.5 · 最適合複雜工作' },",
    "      { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' },",
    "    ] } } }) + '\\n');",
    "});",
    "",
  ].join("\n"), { mode: 0o755 });
  const routes = [{ pickerSlug: "custom/claude-cli-claude-opus-5-5-a0482299", upstreamModel: "claude-opus-5-5",
    displayName: "claude-cli/claude-opus-5-5", providerId: "claude-cli", transport: "claude-cli", translate: "anthropic", efforts: [] }];
  const provider = { baseUrl: "http://127.0.0.1:9", apiRoot: "http://127.0.0.1:9/v1", keychainService: "fixture.cli" };
  const settings = { version: releases.latest, port: 9, routes, claudeCli: { binary: fakeCli, timeoutMs: 180000 }, ...provider };
  writeFileSync(join(runtime, "settings.json"), JSON.stringify(settings));
  writeFileSync(join(runtime, "install.json"), JSON.stringify({ version: releases.latest, port: 9, routes, ...provider }));
  writeFileSync(join(runtime, "models.json"), JSON.stringify({ models: [] }));

  const ui = await startManager(defer, baseEnv(root, runtime, { CODEX_MODEL_ROUTER_CLAUDE_BIN: fakeCli }));
  const query = async (type) => (await ui.call("/api/query", { method: "POST", body: { type } })).json;
  const status = await query("claude-cli");
  assert.deepEqual([status.installed, status.binary, status.version, status.upToDate, status.subscription],
    [true, fakeCli, "2.1.285", true, true]);
  assert.deepEqual(status.routes.map((route) => route.upstreamModel), ["claude-opus-5-5"]);
  assert.match(status.installerUrl, /^https:\/\/claude\.ai\/install\./);

  const models = await query("claude-cli-models");
  assert.equal(models.fromCli, true);
  assert.deepEqual(models.choices.map((choice) => [choice.id, choice.configured]),
    [["claude-opus-5-5", true], ["claude-sonnet-5-5", false]]);
  assert.equal(models.choices[0].label, "Opus 5.5 · 最適合複雜工作");

  const install = await ui.runJob("claude-cli-install", {});
  assert.equal(install.status, "failed");
  assert.match(install.error, /已經安裝 Claude CLI/);

  const login = await ui.runJob("claude-cli-login", { force: false });
  assert.equal(login.status, "succeeded", login.output);
  assert.equal(existsSync(loginMarker), false, "已登入訂閱帳號時不重跑登入");
  const relogin = await ui.runJob("claude-cli-login", { force: true });
  assert.equal(relogin.status, "succeeded", relogin.output);
  assert.equal(existsSync(loginMarker), true, "重新登入會執行 claude auth login");
  assert.match(relogin.output, /終端機視窗/);

  const badModel = await ui.runJob("claude-cli-add", { models: ["opus; rm -rf"], contextWindow: 1000000, maxOutputTokens: 128000 });
  assert.equal(badModel.status, "failed");
  assert.match(badModel.error, /模型名稱只能是/);
  const bigContext = await ui.runJob("claude-cli-add", { models: ["opus"], contextWindow: 2000000, maxOutputTokens: 128000 });
  assert.equal(bigContext.status, "failed");
  assert.match(bigContext.error, /最多 1,000,000/);

  assert.equal((await ui.call("/api/shutdown", { method: "POST" })).status, 202);
  assert.equal((await ui.waitExit())[0], 0, ui.output());
});

test("一鍵更新：下載並核對 SHA256SUMS 與版本後才執行新版安裝器的 update", { skip: process.platform === "win32" && "用 bash 執行假的新版安裝器", timeout: 60000 }, async (t) => {
  const defer = cleanupStack(t);
  const root = mkdtempSync(join(tmpdir(), "router-manager-update-"));
  defer(() => removeTree(root));
  const runtime = join(root, "model-router");
  mkdirSync(runtime);
  const provider = { baseUrl: "http://127.0.0.1:9/p1", apiRoot: "http://127.0.0.1:9/p1/v1", keychainService: "fixture.update" };
  writeFileSync(join(runtime, "settings.json"), JSON.stringify({ version: releases.latest, port: 9, routes: [], ...provider }));
  writeFileSync(join(runtime, "install.json"), JSON.stringify({ version: releases.latest, port: 9, routes: [], ...provider }));
  writeFileSync(join(runtime, "models.json"), JSON.stringify({ models: [] }));

  // 假的新版安裝器：通過格式、版本與內嵌段落檢查，執行時只印出收到的參數。
  const marker = (name) => "__CODEX_MODEL_ROUTER_" + name + "__";
  const fakeInstaller = Buffer.from([
    "#!/bin/bash",
    "echo \"fake installer: $*\"",
    "echo \"home=$CODEX_HOME script=$" + "{CODEX_MODEL_ROUTER_SCRIPT_PATH:-unset}\"",
    "exit 0",
    ": <<'FAKE_END'",
    marker("INSTALLER_JS"),
    "const INSTALLER_VERSION = \"9.9.9\";",
    marker("ROUTER_JS"),
    marker("EMBEDDED"),
    "FAKE_END",
    "",
  ].join("\n"));
  let mode = "ok";
  let asset = fakeInstaller;
  const requests = [];
  const releaseServer = http.createServer((request, response) => {
    requests.push(request.url);
    const sums = (mode === "bad-hash" ? "0".repeat(64) : createHash("sha256").update(asset).digest("hex")) + "  codex-model-router.sh\n";
    if (mode === "missing") { response.writeHead(404); response.end(); return; }
    if (request.url === "/v9.9.9/SHA256SUMS") { response.end(sums); return; }
    if (request.url === "/v9.9.9/codex-model-router.sh") { response.end(asset); return; }
    response.writeHead(404);
    response.end();
  });
  releaseServer.listen(0, "127.0.0.1");
  await once(releaseServer, "listening");
  defer(() => { releaseServer.closeAllConnections(); releaseServer.close(); });

  const catalog = { latest: "9.9.9", releases: [
    { version: "9.9.9", date: "2099-01-01", changes: ["假的新版本"] },
    { version: releases.latest, changes: ["目前的版本"] },
  ] };
  const ui = await startManager(defer, baseEnv(root, runtime, {
    CODEX_MODEL_ROUTER_RELEASES_JSON: JSON.stringify(catalog),
    CODEX_MODEL_ROUTER_RELEASE_DOWNLOAD_URL: "http://127.0.0.1:" + releaseServer.address().port + "/",
  }));
  const version = (await ui.call("/api/version")).json;
  assert.equal(version.status, "update-available");
  assert.equal(version.latest, "9.9.9");
  assert.deepEqual(version.releases.map((release) => release.version), ["9.9.9"]);
  assert.equal(version.canRestartDesktop, false, "測試模式絕不碰真的桌面版");

  mode = "missing";
  const missing = await ui.runJob("update", { restartDesktop: false });
  assert.equal(missing.status, "failed");
  assert.match(missing.error, /還沒有 v9\.9\.9 的發佈檔案/);

  mode = "bad-hash";
  const mismatch = await ui.runJob("update", { restartDesktop: false });
  assert.equal(mismatch.status, "failed");
  assert.match(mismatch.error, /與 SHA256SUMS 不符/);
  assert.doesNotMatch(mismatch.output, /fake installer/, "雜湊不符時不能執行下載的檔案");

  mode = "ok";
  const updated = await ui.runJob("update", { restartDesktop: false });
  assert.equal(updated.status, "succeeded", updated.output);
  assert.match(updated.output, /雜湊與版本核對通過/);
  assert.match(updated.output, /fake installer: update/, "新版安裝器的輸出也要出現在網頁記錄裡");
  assert.match(updated.output, /script=unset/, "不能把舊安裝器的路徑傳給新版");
  assert.deepEqual(updated.result, { version: "9.9.9", managerRestart: false, restartDesktop: true });
  assert.deepEqual(requests.filter((url) => url.startsWith("/v9.9.9/")).slice(-2), ["/v9.9.9/SHA256SUMS", "/v9.9.9/codex-model-router.sh"]);

  // 第二次提供真的新版管理頁，只把 update 寫檔步驟換成 fixture。送出後完全不輪詢，
  // 模擬瀏覽器已關閉；新版必須自己接手同一個埠，且舊程序退出後仍可使用。
  const installedScript = readFileSync(shellPath, "utf8").replace(`const INSTALLER_VERSION = "${releases.latest}";`, 'const INSTALLER_VERSION = "9.9.9";');
  writeFileSync(join(root, "new-manager.sh"), installedScript);
  const entry = ["#!/bin/bash", 'if [ "$1" = update ]; then',
    '  cp "$CODEX_HOME/new-manager.sh" "$CODEX_MODEL_ROUTER_HOME/codex-model-router.sh"',
    '  echo "fixture: update complete"', "  exit 0", "fi", ""].join("\n");
  asset = Buffer.from(entry + installedScript.slice("#!/bin/bash\n".length));
  const previousPing = (await ui.call("/api/ping", { method: "POST" })).json;
  const started = await ui.call("/api/jobs", { method: "POST", body: { type: "update", params: { restartDesktop: false } } });
  assert.equal(started.status, 202);
  defer(async () => {
    try { await ui.call("/api/shutdown", { method: "POST" }); } catch {}
    for (let attempt = 0; attempt < 200 && readdirSync(runtime).some((name) => /^manager-worker-.*\.mjs$/.test(name)); attempt += 1) await delay(50);
  });
  assert.equal((await ui.waitExit())[0], 0, ui.output());
  const newPing = (await ui.call("/api/ping", { method: "POST" })).json;
  assert.equal(newPing.version, "9.9.9");
  assert.notEqual(newPing.instanceId, previousPing.instanceId);
  const handedOff = (await ui.call("/api/jobs/" + started.json.id)).json;
  assert.equal(handedOff.id, started.json.id);
  assert.equal(handedOff.status, "succeeded", JSON.stringify(handedOff));
  assert.match(handedOff.output, /fixture: update complete/);
  assert.equal(handedOff.result.managerRestart, false, "新程序不會再次交接形成迴圈");
  assert.equal(existsSync(join(runtime, "manager-handoff.json")), false);
  assert.equal((await ui.call("/api/shutdown", { method: "POST" })).status, 202);
});
