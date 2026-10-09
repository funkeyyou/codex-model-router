// 網頁管理介面的伺服器層：存取控制、背景工作與頁面本身。
//
// 這裡用假的 ops 驗證 HTTP 這一層；真正的操作（寫檔、重啟、驗證）由 manager-plans 與
// manager-e2e 測試涵蓋。管理頁必須服務瀏覽器，所以存取控制是這層最重要的事：
// 沒有權杖、Host 不是本機、跨站 Origin 都不能碰到任何 API。

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { once } from "node:events";
import { loadPayloads } from "./helpers/payloads.mjs";

const { manager, managerPage } = await loadPayloads();
const TOKEN = "test-token-123";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// gate：hello 工作等到測試放行才結束，「同時只跑一項」的檢查才不受機器快慢影響。
function fakeOps(calls = [], gate = Promise.resolve()) {
  return {
    state: async () => ({ installed: true, models: [] }),
    version: async (options) => ({ refresh: options.refresh }),
    errors: async () => ({ entries: [] }),
    discover: async (body) => ({ echo: body }),
    providerDraft: async () => { throw new Error("Base URL 無效：x"); },
    queries: {
      echo: async (params) => ({ params }),
      broken: async () => { throw new Error("查詢失敗的原因"); },
    },
    jobs: {
      hello: { title: "測試工作", run: async (params) => {
        calls.push(params);
        console.log("開始 " + params.name);
        await gate;
        process.stdout.write("進度 50%\r進度 100%\n");
        console.error("\u001b[31m警告訊息\u001b[0m");
        return { ok: true, name: params.name };
      } },
      boom: { title: "會失敗", run: async () => {
        console.log("準備失敗");
        throw new Error("刻意的錯誤");
      } },
      slow: { title: "慢工作", run: () => delay(150).then(() => "done") },
    },
  };
}

async function until(check, label) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error("等待逾時：" + label);
}

async function startServer(t, options = {}) {
  const jobs = options.jobs || manager.createJobRunner();
  const restoreOutput = manager.installOutputCapture(jobs);
  const events = [];
  const server = manager.createManagerServer({
    html: options.html || "<!doctype html><html><head><style>p{color:red}</style></head><body><script>1</script></body></html>",
    token: TOKEN, version: "9.9.9", ops: options.ops || fakeOps(), jobs, preferences: options.preferences || null,
    onShutdown: () => events.push("shutdown"),
    onRestart: options.noRestart ? null : () => events.push("restart"),
    restartBlocked: options.restartBlocked || (() => null),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => {
    restoreOutput();
    server.closeAllConnections();
    server.close(resolve);
  }));
  const port = server.address().port;
  // fetch 不能改 Host，存取控制的測試改用 http.request 自己帶標頭。
  const raw = (path, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path, method, headers: { host: "127.0.0.1:" + port, ...headers } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
  const call = (path, { method = "GET", body, headers = {} } = {}) => raw(path, {
    method,
    headers: { [manager.TOKEN_HEADER]: TOKEN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const waitJob = async (id) => {
    let offset = 0;
    let output = "";
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const view = (await call("/api/jobs/" + id + "?offset=" + offset)).json;
      output += view.output;
      offset = view.offset;
      if (view.status !== "running") return { ...view, output };
      await delay(15);
    }
    throw new Error("job did not finish");
  };
  return { port, raw, call, waitJob, events, jobs };
}

test("管理頁帶 CSP nonce，禁止嵌入，不外送 Referer", async (t) => {
  const { raw } = await startServer(t);
  const page = await raw("/");
  assert.equal(page.status, 200);
  const csp = page.headers["content-security-policy"];
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce, csp);
  assert.match(csp, new RegExp("style-src 'nonce-" + nonce.replace(/[+/=]/g, "\\$&") + "'"));
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(page.text.includes('<script nonce="' + nonce + '">'));
  assert.ok(page.text.includes('<style nonce="' + nonce + '">'));
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.equal(page.headers["cache-control"], "no-store");
  const second = await raw("/");
  assert.notEqual(/nonce-([^']+)/.exec(second.headers["content-security-policy"])[1], nonce, "每次回應換一個 nonce");
});

test("API 需要權杖、本機 Host 與同源 Origin", async (t) => {
  const { port, raw, call } = await startServer(t);
  assert.equal((await raw("/api/state")).status, 401);
  assert.equal((await raw("/api/state", { headers: { [manager.TOKEN_HEADER]: "wrong" } })).status, 401);
  assert.equal((await call("/api/state", { headers: { host: "evil.example:" + port } })).status, 403);
  assert.equal((await raw("/", { headers: { host: "evil.example:" + port } })).status, 403, "DNS rebinding 連頁面都拿不到");
  assert.equal((await call("/api/state", { headers: { host: "127.0.0.1:1" } })).status, 403);
  assert.equal((await call("/api/state", { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("/api/state", { headers: { origin: "null" } })).status, 403);
  assert.equal((await call("/api/state", { headers: { origin: "http://localhost:" + port, host: "localhost:" + port } })).status, 200);
  const state = await call("/api/state");
  assert.equal(state.status, 200);
  assert.match(state.json.manager.instanceId, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(state.json, { installed: true, models: [], manager: { version: "9.9.9", instanceId: state.headers["x-router-manager-instance"], activeJob: null } });
  assert.equal((await call("/api/version?refresh=1")).json.refresh, true);
  assert.equal((await call("/api/nope")).status, 404);
  assert.equal((await raw("/elsewhere")).status, 404);
});

test("POST 只收 JSON；使用者錯誤回 400，未知操作與格式錯誤也擋下", async (t) => {
  const { call, raw } = await startServer(t);
  const form = await raw("/api/discover", { method: "POST", headers: { [manager.TOKEN_HEADER]: TOKEN, "content-type": "text/plain" }, body: "{}" });
  assert.equal(form.status, 415);
  const broken = await raw("/api/discover", { method: "POST", headers: { [manager.TOKEN_HEADER]: TOKEN, "content-type": "application/json" }, body: "{" });
  assert.equal(broken.status, 400);
  const array = await call("/api/discover", { method: "POST", body: [] });
  assert.equal(array.status, 400);
  assert.deepEqual((await call("/api/discover", { method: "POST", body: { providerId: "a" } })).json, { echo: { providerId: "a" } });
  const draft = await call("/api/provider-draft", { method: "POST", body: {} });
  assert.equal(draft.status, 400);
  assert.equal(draft.json.error, "Base URL 無效：x");
  assert.equal((await call("/api/jobs", { method: "POST", body: { type: "toString" } })).status, 400, "不能呼叫原型上的屬性");
  assert.equal((await call("/api/jobs", { method: "POST", body: { type: "missing" } })).status, 400);
  const huge = await raw("/api/discover", { method: "POST", headers: { [manager.TOKEN_HEADER]: TOKEN, "content-type": "application/json" }, body: JSON.stringify({ x: "a".repeat(70 * 1024) }) });
  assert.equal(huge.status, 413);
});

test("唯讀查詢：只能呼叫登記過的查詢，參數只接受物件，錯誤訊息照實回傳", async (t) => {
  const { call, raw } = await startServer(t);
  assert.deepEqual((await call("/api/query", { method: "POST", body: { type: "echo", params: { a: 1 } } })).json, { params: { a: 1 } });
  assert.deepEqual((await call("/api/query", { method: "POST", body: { type: "echo", params: [1] } })).json, { params: {} });
  for (const type of ["missing", "toString", "__proto__", 42]) {
    assert.equal((await call("/api/query", { method: "POST", body: { type } })).status, 400, String(type));
  }
  const broken = await call("/api/query", { method: "POST", body: { type: "broken" } });
  assert.deepEqual([broken.status, broken.json.error], [400, "查詢失敗的原因"]);
  assert.equal((await raw("/api/query", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
});

test("背景工作擷取終端輸出，可依 offset 增量讀取；同時只跑一項", async (t) => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { call, waitJob } = await startServer(t, { ops: fakeOps(calls, gate) });
  const started = await call("/api/jobs", { method: "POST", body: { type: "hello", params: { name: "甲" } } });
  assert.equal(started.status, 202);
  assert.equal(started.json.status, "running");
  assert.equal(started.json.title, "測試工作");
  const busy = await call("/api/jobs", { method: "POST", body: { type: "slow" } });
  assert.equal(busy.status, 409);
  assert.match(busy.json.error, /測試工作/);
  const state = await call("/api/state");
  assert.equal(state.json.manager.activeJob.id, started.json.id);
  release();
  const done = await waitJob(started.json.id);
  assert.equal(done.status, "succeeded");
  assert.deepEqual(done.result, { ok: true, name: "甲" });
  assert.equal(done.output, "開始 甲\n進度 50%\n進度 100%\n警告訊息\n");
  assert.deepEqual(calls, [{ name: "甲" }]);
  const tail = await call("/api/jobs/" + started.json.id + "?offset=" + (done.offset - 5));
  assert.equal(tail.json.output, "警告訊息\n".slice(-5));
  assert.equal((await call("/api/jobs/" + started.json.id + "?offset=" + done.offset)).json.output, "");
  assert.equal((await call("/api/jobs/unknown-id")).status, 404);
  assert.equal((await call("/api/state")).json.manager.activeJob, null);
});

test("失敗的工作保留錯誤訊息，工作外的輸出不會混進記錄", async (t) => {
  const { call, waitJob } = await startServer(t);
  const started = await call("/api/jobs", { method: "POST", body: { type: "boom" } });
  console.log("這行在工作之外");
  const done = await waitJob(started.json.id);
  assert.equal(done.status, "failed");
  assert.equal(done.error, "刻意的錯誤");
  assert.equal(done.output, "準備失敗\n\n錯誤：刻意的錯誤\n");
});

test("工作輸出超過上限時只保留最後一段，offset 仍然連續", async () => {
  const jobs = manager.createJobRunner({ maxOutput: 10 });
  const job = jobs.start("x", "x", () => new Promise(() => {}));
  jobs.append(job, "0123456789");
  jobs.append(job, "abcdef");
  assert.equal(job.output, "6789abcdef");
  assert.deepEqual([jobs.view(job, 0).output, jobs.view(job, 0).offset], ["6789abcdef", 16]);
  assert.equal(jobs.view(job, 12).output, "cdef");
  assert.equal(jobs.view(job, 16).output, "");
});

test("完成事件不依賴瀏覽器輪詢，交接後恢復同一項操作與輸出", async () => {
  let snapshot;
  const first = manager.createJobRunner({ onFinished: (job) => { snapshot = first.view(job); } });
  const job = first.start("update", "更新", () => ({ managerRestart: true }));
  first.append(job, "已更新路由器\n");
  await until(() => snapshot, "無瀏覽器請求也完成交接");
  const next = manager.createJobRunner();
  const restored = next.restore(snapshot);
  assert.equal(restored.id, job.id);
  assert.equal(next.view(restored).output, "已更新路由器\n");
  next.resume(restored, () => { next.append(restored, "桌面版已重開\n"); return { desktopRestarted: true }; });
  await until(() => !next.active(), "交接後完成桌面重啟");
  assert.equal(next.view(restored).status, "succeeded");
  assert.equal(next.view(restored, snapshot.offset).output, "桌面版已重開\n");
  assert.equal(next.view(restored).result.desktopRestarted, true);
  assert.throws(() => next.restore({ ...snapshot, status: "running" }), /交接記錄無效/);
});

test("桌面版重新開啟後必須確認程序存在，拒絕退出時不強制結束", async () => {
  const app = { name: "測試 App", path: "/fixture/Test App.app", bundleId: "example.router.test" };
  let running = true;
  let opened = false;
  let checksAfterOpen = 0;
  let clock = 0;
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === "/usr/bin/open") { opened = true; return { status: 0, stdout: "", stderr: "" }; }
    if (args.some((arg) => arg.includes("to quit"))) { running = false; return { status: 0, stdout: "", stderr: "" }; }
    if (opened && ++checksAfterOpen >= 2) running = true;
    return { status: 0, stdout: String(running), stderr: "" };
  };
  const result = await manager.restartDesktopProcess(app, { run, now: () => clock, wait: async (ms) => { clock += ms; } });
  assert.deepEqual(result, { restarted: app.name });
  assert.equal(checksAfterOpen, 2, "open 回傳成功後仍要等到應用程式真的啟動");
  assert.deepEqual(calls.find(([command]) => command === "/usr/bin/open"), ["/usr/bin/open", [app.path]]);
  let launches = 0;
  await assert.rejects(manager.restartDesktopProcess(app, { run: async (command, args) => {
    if (command === "/usr/bin/open") launches += 1;
    return args.some((arg) => arg.includes("to quit"))
      ? { status: 1, stdout: "", stderr: "使用者拒絕授權" }
      : { status: 0, stdout: "true", stderr: "" };
  } }), /使用者拒絕授權/);
  assert.equal(launches, 0);
});

test("open 成功但應用程式未啟動時回報錯誤，狀態查詢失敗不能當成未執行", async () => {
  const app = { name: "測試 App", path: "/fixture/Test.app", bundleId: "example.router.test" };
  let clock = 0;
  await assert.rejects(manager.restartDesktopProcess(app, { timeoutMs: 500, now: () => clock,
    wait: async (ms) => { clock += ms; }, run: async () => ({ status: 0, stdout: "false", stderr: "" }),
  }), /未在預期時間內啟動/);
  await assert.rejects(manager.restartDesktopProcess(app, {
    run: async () => ({ status: 1, stdout: "", stderr: "Apple Event 失敗" }),
  }), /無法確認.*Apple Event 失敗/);
});

test("管理程序瞬間換新且沒有斷線時，頁面也會重新整理", async () => {
  const start = managerPage.indexOf("async function restartManager(");
  const end = managerPage.indexOf("\n// ---- 模型", start);
  assert.ok(start >= 0 && end > start);
  let polls = 0;
  let restartCalls = 0;
  let reloaded;
  const done = new Promise((resolve) => { reloaded = resolve; });
  const context = vm.createContext({ restartingManager: false, managerInstance: "old-instance", token: TOKEN, Date, AbortSignal,
    showOverlay: () => ({ message: {} }), api: async () => { restartCalls += 1; }, t: (key) => key,
    fetch: async () => ({ ok: true, json: async () => ({ instanceId: ++polls === 1 ? "old-instance" : "new-instance", version: "1.27.3" }) }),
    setTimeout: (fn) => { queueMicrotask(fn); }, location: { reload: () => reloaded() },
  });
  await vm.runInContext(managerPage.slice(start, end) + "\nrestartManager({ alreadyRequested: true });", context);
  await Promise.race([done, delay(1000).then(() => { throw new Error("頁面沒有重新整理"); })]);
  assert.equal(polls, 2);
  assert.equal(restartCalls, 0, "更新程序自己交接，不需要由頁面觸發");
});

test("結束與重新啟動：有工作進行時拒絕；restartBlocked 擋下時回傳原因", async (t) => {
  const blocked = await startServer(t, { restartBlocked: () => "找不到安裝器副本" });
  const refused = await blocked.call("/api/restart", { method: "POST", body: {} });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error, "找不到安裝器副本");

  const server = await startServer(t);
  await server.call("/api/jobs", { method: "POST", body: { type: "slow" } });
  assert.equal((await server.call("/api/shutdown", { method: "POST", body: {} })).status, 409);
  await until(async () => (await server.call("/api/state")).json.manager.activeJob === null, "慢工作結束");
  assert.equal((await server.call("/api/restart", { method: "POST", body: {} })).status, 202);
  assert.equal((await server.call("/api/shutdown", { method: "POST", body: {} })).status, 202);
  await until(() => server.events.length === 2, "收到結束與重新啟動");
  assert.deepEqual(server.events, ["restart", "shutdown"]);

  const noRestart = await startServer(t, { noRestart: true });
  assert.equal((await noRestart.call("/api/restart", { method: "POST", body: {} })).status, 400);
});

test("介面語言：頁面帶入已儲存的偏好，設定 API 只收支援的語言", async (t) => {
  const html = '<!doctype html><html lang="zh-Hant" data-language-preference="auto"><head></head><body><script>1</script></body></html>';
  let stored = { language: "zh-Hans", other: "kept" };
  const writes = [];
  const preferences = { read: () => stored, write: (patch) => { writes.push(patch); stored = { ...stored, ...patch }; return stored; } };
  const server = await startServer(t, { html, preferences });
  assert.match((await server.raw("/")).text, /<html lang="zh-Hant" data-language-preference="zh-Hans">/);
  const saved = await server.call("/api/preferences", { method: "POST", body: { language: "en" } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, { language: "en", saved: true });
  assert.deepEqual(writes, [{ language: "en" }]);
  assert.equal(stored.other, "kept", "只改語言");
  assert.match((await server.raw("/")).text, /data-language-preference="en"/);
  for (const language of ["fr", "", null, 1, "<script>"]) {
    assert.equal((await server.call("/api/preferences", { method: "POST", body: { language } })).status, 400, String(language));
  }
  assert.equal((await server.raw("/api/preferences", { method: "POST", headers: { "content-type": "application/json" }, body: '{"language":"en"}' })).status, 401);
  assert.equal(writes.length, 1, "無效或未授權的請求不寫入");

  stored = { language: "<script>" };
  assert.match((await server.raw("/")).text, /data-language-preference="auto"/, "讀到無效值時用自動");
  const broken = await startServer(t, { html, preferences: { read: () => { throw new Error("讀不到"); }, write: () => ({}) } });
  assert.match((await broken.raw("/")).text, /data-language-preference="auto"/);
  const none = await startServer(t, { html });
  assert.match((await none.raw("/")).text, /data-language-preference="auto"/);
  assert.deepEqual((await none.call("/api/preferences", { method: "POST", body: { language: "zh-Hant" } })).json, { language: "zh-Hant", saved: false });

  assert.equal(manager.pageWithLanguage(html, "xx"), html);
  assert.equal(manager.pageWithLanguage("<html><body data-language-preference=\"auto\"></body></html>", "en"),
    "<html><body data-language-preference=\"auto\"></body></html>", "只改 <html> 標籤上的屬性");
  assert.deepEqual([...manager.MANAGER_LANGUAGES], ["auto", "zh-Hant", "zh-Hans", "en"]);
  assert.match(managerPage, /<html lang="zh-Hant" data-language-preference="auto">/);
});

test("Host、Origin 與權杖的比對規則", () => {
  assert.equal(manager.isAllowedHost("127.0.0.1:4000", 4000), true);
  assert.equal(manager.isAllowedHost("localhost:4000", 4000), true);
  assert.equal(manager.isAllowedHost("LOCALHOST.:4000", 4000), true);
  assert.equal(manager.isAllowedHost("[::1]:4000", 4000), true);
  assert.equal(manager.isAllowedHost("127.0.0.1", 4000), false, "瀏覽器對非 80 埠一定帶埠號");
  assert.equal(manager.isAllowedHost("127.0.0.1:4001", 4000), false);
  assert.equal(manager.isAllowedHost("127.0.0.1.evil.example:4000", 4000), false);
  assert.equal(manager.isAllowedHost(undefined, 4000), false);
  assert.equal(manager.isAllowedOrigin(undefined, 4000), true);
  assert.equal(manager.isAllowedOrigin("http://127.0.0.1:4000", 4000), true);
  assert.equal(manager.isAllowedOrigin("http://[::1]:4000", 4000), true);
  assert.equal(manager.isAllowedOrigin("https://127.0.0.1:4000", 4000), false);
  assert.equal(manager.isAllowedOrigin("http://127.0.0.1:4001", 4000), false);
  assert.equal(manager.isAllowedOrigin("null", 4000), false);
  assert.equal(manager.tokenMatches("abc", "abc"), true);
  assert.equal(manager.tokenMatches("abd", "abc"), false);
  assert.equal(manager.tokenMatches("ab", "abc"), false);
  assert.equal(manager.tokenMatches(undefined, "abc"), false);
  assert.equal(manager.tokenMatches("", ""), false);
  assert.match(manager.createToken(), /^[A-Za-z0-9_-]{32}$/);
  assert.equal(manager.stripAnsi("\u001b[1;32m好\u001b[0m\u001b]0;title\u0007"), "好");
});

test("管理頁腳本可編譯，且符合 CSP：無行內事件、無 style 屬性、無外部資源", () => {
  const scripts = [...managerPage.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0], { filename: "manager.html" }));
  assert.equal((managerPage.match(/<style>/g) || []).length, 1);
  assert.doesNotMatch(managerPage, /\son[a-z]+\s*=\s*["']/i, "行內事件會被 CSP 擋掉");
  assert.doesNotMatch(managerPage, /\sstyle\s*=\s*["']/i, "style 屬性會被 CSP 擋掉");
  assert.doesNotMatch(managerPage, /<(script|link|img|iframe)[^>]+(src|href)=["']https?:/i, "不載入任何外部資源");
  // replaceChildren／append 會把 null 轉成文字 "null"（版本徽章曾顯示成 v1.27.0null）。
  for (const line of managerPage.split("\n").filter((text) => /\.(replaceChildren|append)\(/.test(text))) {
    assert.doesNotMatch(line.replace(/\.filter\(Boolean\)/g, ""), /\?[^;]*:\s*null\s*\)/, line.trim());
  }
  assert.match(managerPage, /id="version-badge"/);
  assert.match(managerPage, /x-router-manager-token/);
  assert.equal(manager.TOKEN_HEADER, "x-router-manager-token");
  // 頁面裡實際呼叫的 API 都要存在於伺服器。
  const used = new Set([...managerPage.matchAll(/"\/api\/([a-z-]+)/g)].map((match) => match[1]));
  for (const name of used) assert.ok(["state", "version", "errors", "ping", "preferences", "discover", "provider-draft", "query", "jobs", "restart", "shutdown"].includes(name), name);
  // 頁面送出的工作類型都要是安裝器提供的。
  const jobTypes = new Set([...managerPage.matchAll(/runJob\("([a-z-]+)"/g)].map((match) => match[1]));
  jobTypes.add("update");
  jobTypes.add("apply-update");
  assert.deepEqual([...jobTypes].sort(), ["add-models", "add-provider", "apply-update", "claude-cli-add", "claude-cli-install",
    "claude-cli-login", "claude-cli-update", "edit-model", "edit-provider", "imagegen-disable", "imagegen-setup", "remove-models", "remove-provider",
    "reorder-models", "repair-models", "replace-key", "restart-desktop", "restart-router", "set-global-context", "set-hidden-models", "update"]);
  // 頁面用到的查詢都要是安裝器提供的。
  const queryTypes = new Set([...managerPage.matchAll(/(?:ensureQuery|refreshButton|reloadQuery)\("([a-z-]+)"/g)].map((match) => match[1]));
  for (const match of managerPage.matchAll(/type: "([a-z-]+)" \} \}\)/g)) queryTypes.add(match[1]);
  assert.deepEqual([...queryTypes].sort(), ["claude-cli", "claude-cli-models", "global-context", "hidden-models", "imagegen", "provider-preview"]);
});

test("新增模型與新增供應商都提供 Claude 訂閱，並共用 Claude CLI 的準備檢查與確認步驟", () => {
  const body = (name) => {
    const start = managerPage.indexOf("\nfunction " + name + "(");
    assert.ok(start >= 0, "頁面缺少 " + name);
    return managerPage.slice(start, managerPage.indexOf("\nfunction ", start + 1));
  };
  assert.match(managerPage, /const CLAUDE_CLI_ID = "claude-cli";/, "與路由器記錄的 providerId 相同");
  for (const name of ["openAddModels", "openAddProvider"]) {
    assert.match(body(name), /claudeCliChooser\(/, name);
    assert.match(body(name), /showClaudeCliConfirm\(/, name);
  }
  assert.match(body("openAddModels"), /value: CLAUDE_CLI_ID/, "供應商選單有 Claude 訂閱");
  assert.match(body("openAddProvider"), /typeOption\("providers"[\s\S]*typeOption\("claude"/, "先選供應商類型");
  // 準備步驟只用既有的安裝、更新與登入工作，不另外開新的寫入入口。
  assert.match(body("claudeCliChecklist"), /confirmClaudeCliInstall[\s\S]*confirmClaudeCliUpdate[\s\S]*confirmClaudeCliLogin/);
  assert.match(body("showClaudeCliConfirm"), /runJob\("claude-cli-add"/);
  // Esc 只關最上層的對話框：疊開確認框時，不能連下面的新增對話框一起關掉。
  assert.match(body("openModal"), /modalStack\.push\(entry\)/);
  assert.doesNotMatch(body("openModal"), /addEventListener\("keydown"/);
});
