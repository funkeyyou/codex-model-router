// 供應商相關的互動命令，實際執行安裝器、照提示輸入答案。
//
// 會重啟背景服務的那一步（寫檔、重啟、等 Codex 同步）測不了，由各個 plan* 純函式與
// multi-provider.test.mjs 驗證；這裡盯的是之前的每一步：選單、選哪一家、送到哪一家的
// 上游，以及任何一步取消或被擋下時，安裝目錄一個位元組都不能變。

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexBin } from "./helpers/codex-bin.mjs";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer, dir: payloadDir } = await loadPayloads();
const sourcePath = fileURLToPath(new URL("../codex-model-router.sh", import.meta.url));
const releases = JSON.parse(readFileSync(new URL("../releases.json", import.meta.url), "utf8"));

// 假上游：/p1、/p2、/p3 各當一家供應商的 Base URL，記下每個請求。
async function fakeUpstream(t) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, auth: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    const match = /^\/(p[123])\/v1\/models$/.exec(request.url);
    if (match) {
      response.end(JSON.stringify({ data: [{ id: `${match[1]}-model` }] }));
    } else if (request.url === "/healthz") {
      response.end(JSON.stringify({ status: "ok", stats: {} }));
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  return { requests, port, origin: `http://127.0.0.1:${port}` };
}

function providerAt(origin, id, path) {
  return {
    id, baseUrl: `${origin}/${path}`, apiRoot: `${origin}/${path}/v1`,
    keychainService: `fixture.${id}`, keychainAccount: "codex", credentialPath: null,
  };
}

function installation(upstream, { providers }) {
  const routes = providers.map((provider) => ({
    pickerSlug: installer.pickerSlug(`${provider.id}-model`, provider.id),
    upstreamModel: `${provider.id}-model`,
    displayName: provider.id === "default" ? `api/${provider.id}-model` : `${provider.id}/${provider.id}-model`,
    providerHost: new URL(provider.apiRoot).host, efforts: [], stripReasoning: true, contextWindow: 100000,
    ...(provider.id === "default" ? {} : { providerId: provider.id }),
  }));
  const settings = installer.withProviders({ version: releases.latest, port: upstream.port, routes, forceListedModels: [] }, providers);
  const manifest = installer.withProviders({ version: releases.latest, port: upstream.port, routes }, providers);
  const catalog = { models: [
    { slug: "gpt-official", display_name: "GPT", priority: 1, visibility: "list" },
    ...routes.map((route, index) => ({ slug: route.pickerSlug, display_name: route.displayName, priority: 2 + index })),
  ] };
  return { settings, manifest, catalog };
}

async function runInstaller(t, args, state, replies = [], extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "router-providers-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const routerDir = join(home, "model-router");
  mkdirSync(routerDir);
  const files = {
    "settings.json": JSON.stringify(state.settings), "install.json": JSON.stringify(state.manifest),
    "models.json": JSON.stringify(state.catalog), "router.mjs": "// fixture\n", "claude-bridge.mjs": "// fixture\n",
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(routerDir, name), content);
  const env = {
    ...process.env, CODEX_HOME: home, CODEX_MODEL_ROUTER_HOME: routerDir,
    CODEX_MODEL_ROUTER_SCRIPT_PATH: sourcePath, CODEX_MODEL_ROUTER_NODE_BIN: process.execPath,
    CODEX_MODEL_ROUTER_CODEX_BIN: process.execPath, CODEX_MODEL_ROUTER_TEST_MODE: "1",
    CODEX_MODEL_ROUTER_TEST_API_KEY: "fixture-key", CODEX_MODEL_ROUTER_RELEASES_JSON: JSON.stringify(releases),
    ...extraEnv,
  };
  for (const name of ["CODEX_MODEL_ROUTER_IMPORT_ONLY", "CODEX_MODEL_ROUTER_BASE_URL", "CODEX_MODEL_ROUTER_YES",
    "CODEX_MODEL_ROUTER_TEST_MODELS"]) delete env[name];
  const child = spawn(process.execPath, [join(payloadDir, "installer.mjs"), ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  const pending = replies.map((reply) => ({ ...reply }));
  const answer = () => {
    const next = pending.find((reply) => !reply.sent);
    if (next && output.includes(next.marker)) {
      next.sent = true;
      child.stdin.write(`${next.answer}\n`);
    }
  };
  child.stdout.on("data", (chunk) => { output += chunk; answer(); });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const timeout = setTimeout(() => child.kill(), 30000);
  const [code] = await once(child, "close");
  clearTimeout(timeout);
  const unchanged = Object.entries(files).every(([name, content]) => readFileSync(join(routerDir, name), "utf8") === content);
  return { code, output, unchanged, backups: existsSync(join(home, "backups")) ? readdirSync(join(home, "backups")) : [] };
}

test("providers 選單按 Enter 返回，不做任何修改", async (t) => {
  const upstream = await fakeUpstream(t);
  const state = installation(upstream, { providers: [providerAt(upstream.origin, "default", "p1")] });
  const result = await runInstaller(t, ["providers"], state, [{ marker: "請選擇操作（Enter 返回）", answer: "" }]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /1\. default（127\.0\.0\.1:\d+）— 1 個模型，主要供應商/);
  assert.match(result.output, /未進行任何修改/);
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.backups, []);
});

test("只有一家供應商時不能移除，提示改用回退", async (t) => {
  const upstream = await fakeUpstream(t);
  const state = installation(upstream, { providers: [providerAt(upstream.origin, "default", "p1")] });
  const result = await runInstaller(t, ["providers", "remove"], state);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /目前只有一家供應商，無法移除/);
  assert.equal(result.unchanged, true);
});

test("添加模型時先選供應商，只向那一家查模型；取消探測不改任何檔案", async (t) => {
  const upstream = await fakeUpstream(t);
  const state = installation(upstream, { providers: [
    providerAt(upstream.origin, "default", "p1"), providerAt(upstream.origin, "backup", "p2"),
  ] });
  const result = await runInstaller(t, ["add"], state, [
    { marker: "要替哪一家供應商添加模型", answer: "2" },
    { marker: "請輸入模型編號", answer: "p2-extra" },
    { marker: "是否繼續進行能力探測", answer: "n" },
  ]);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /供應商：backup/);
  assert.match(result.output, /已在修改配置前取消/);
  assert.deepEqual(upstream.requests.filter((request) => request.path.endsWith("/models")),
    [{ path: "/p2/v1/models", auth: "Bearer fixture-key" }]);
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.backups, []);
});

test("新增供應商：重複的 Base URL 直接擋下；新網址查到模型後，取消探測也不改任何檔案", async (t) => {
  const upstream = await fakeUpstream(t);
  const state = installation(upstream, { providers: [providerAt(upstream.origin, "default", "p1")] });
  const duplicate = await runInstaller(t, ["providers", "add"], state, [
    { marker: "兼容 OpenAI 的 Base URL", answer: `${upstream.origin}/p1` },
  ]);
  assert.equal(duplicate.code, 1, duplicate.output);
  assert.match(duplicate.output, /已經是供應商「default」/);
  assert.equal(duplicate.unchanged, true);

  const added = await runInstaller(t, ["providers", "add"], state, [
    { marker: "兼容 OpenAI 的 Base URL", answer: `${upstream.origin}/p3` },
    { marker: "供應商名稱", answer: "Bad_Name" },
    { marker: "不能以連字號開頭或結尾", answer: "" },
    { marker: "請輸入模型編號", answer: "1" },
    { marker: "是否繼續進行能力探測", answer: "n" },
  ]);
  assert.equal(added.code, 1, added.output);
  assert.match(added.output, /供應商名稱（會顯示在它的模型名稱前面） \[local\]/);
  assert.match(added.output, /p3-model/);
  assert.match(added.output, /已在修改配置前取消/);
  assert.equal(added.unchanged, true);
  assert.deepEqual(added.backups, []);
});

test("status 列出每家供應商與各自的模型數", async (t) => {
  const upstream = await fakeUpstream(t);
  const state = installation(upstream, { providers: [
    providerAt(upstream.origin, "default", "p1"), providerAt(upstream.origin, "backup", "p2"),
  ] });
  const result = await runInstaller(t, ["status"], state);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /1\. default（主要）：http:\/\/127\.0\.0\.1:\d+\/p1\/v1，1 個模型/);
  assert.match(result.output, /2\. backup：http:\/\/127\.0\.0\.1:\d+\/p2\/v1，1 個模型/);
  assert.match(result.output, /backup\/backup-model -> backup-model/);
});

test("移除供應商前列出它的模型；確認時回答否就不改任何檔案", { skip: codexBin ? false : "需要 Codex CLI" }, async (t) => {
  const upstream = await fakeUpstream(t);
  const state = installation(upstream, { providers: [
    providerAt(upstream.origin, "default", "p1"), providerAt(upstream.origin, "backup", "p2"),
  ] });
  const result = await runInstaller(t, ["providers", "remove"], state, [
    { marker: "要移除哪一家供應商", answer: "backup" },
    { marker: "確認移除供應商「backup」", answer: "n" },
  ], { CODEX_MODEL_ROUTER_CODEX_BIN: codexBin });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /即將移除供應商「backup」.*與它的 1 個模型/);
  assert.match(result.output, /- backup\/backup-model/);
  assert.match(result.output, /未進行任何修改/);
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.backups, []);
});
