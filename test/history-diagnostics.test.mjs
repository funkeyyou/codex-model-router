import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
const headers = { authorization: "Bearer private-token", "chatgpt-account-id": "private-account", "thread-id": "task-a" };
const url = new URL("http://127.0.0.1/v1/responses");
const user = content => ({ role: "user", content });
const done = (id, output = []) => ({ type: "response.completed", response: { id, status: "completed", output } });
const stream = event => new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
const body = (input = [user("private-input")], extra = {}) => ({ model: "gpt-test", input, ...extra });
const delta = [{ type: "function_call_output", call_id: "call_private", output: "private-result" }];
const missing = () => body(delta, { previous_response_id: "resp_missing" });
const replay = () => body([user("private-input"), ...delta]);

async function save(router, input, id, { requestHeaders = headers, previousId, namespace, output = [] } = {}) {
  const request = body(input, previousId ? { previous_response_id: previousId } : {});
  const meta = { connectionNamespace: namespace };
  const upstream = await router.fetchModelUpstream(requestHeaders, url, request, Buffer.from(JSON.stringify(request)), undefined, meta);
  // 真正完成回應才讓路由器保存快照，避免測試直接操縱快取內部。
  const chunks = [];
  await router.bridgeSseToWebSocket(upstream, { destroyed: false, writable: true, write: chunk => chunks.push(chunk) }, null, meta.history);
  return { id, output };
}

async function missReason(router, id, { requestHeaders = headers, namespace } = {}) {
  const request = body(delta, { previous_response_id: id });
  let failure;
  await assert.rejects(router.fetchModelUpstream(requestHeaders, url, request, Buffer.from(JSON.stringify(request)), undefined,
    { connectionNamespace: namespace }), error => {
    failure = error;
    assert.equal(error.code, "router_history_unavailable");
    return true;
  });
  return router.describeRouterError(failure).historyReason;
}

test("歷史遺失原因：容量淘汰、過期、重送完整請求取代，以及連線識別改變", async t => {
  const router = await loadRouterWith({ maxHistoryBytes: 450, historyTtlMs: 1000 });
  let id;
  t.mock.method(globalThis, "fetch", async () => stream(done(id)));
  id = "resp_one";
  await save(router, [user("a".repeat(220))], id, { requestHeaders: { ...headers, "thread-id": "one" }, namespace: "conn-a" });
  assert.equal(await missReason(router, id, { requestHeaders: { ...headers, "thread-id": "one" }, namespace: "conn-b" }), "scope_changed");
  id = "resp_two";
  await save(router, [user("b".repeat(220))], id, { requestHeaders: { ...headers, "thread-id": "two" } });
  assert.equal(await missReason(router, "resp_one", { requestHeaders: { ...headers, "thread-id": "one" }, namespace: "conn-a" }), "capacity");
  router.historyCacheInfo(Date.now() + 2000);
  assert.equal(await missReason(router, "resp_two", { requestHeaders: { ...headers, "thread-id": "two" } }), "expired");
  id = "resp_old";
  await save(router, [user("old")], id);
  id = "resp_new";
  await save(router, [user("new")], id);
  assert.equal(await missReason(router, "resp_old"), "replaced");
});

test("歷史遺失原因：每條連線回應上限與工作階段上限", async t => {
  const router = await loadRouterWith({});
  let id;
  t.mock.method(globalThis, "fetch", async () => stream(done(id)));
  for (let n = 0; n < 5; n++) {
    id = `resp_chain_${n}`;
    await save(router, [user(String(n))], id, { previousId: n ? `resp_chain_${n - 1}` : null });
  }
  assert.equal(await missReason(router, "resp_chain_0"), "response_limit");
  for (let n = 0; n < 32; n++) {
    id = `resp_task_${n}`;
    await save(router, [user(String(n))], id, { requestHeaders: { ...headers, "thread-id": `task-${n}` } });
  }
  assert.equal(await missReason(router, "resp_chain_4"), "thread_limit");
});

test("歷史遺失原因：快照過大、空輸入、沒有任務識別；未知原因不聲稱已確認重啟", async t => {
  const router = await loadRouterWith({ maxHistoryBytes: 180 });
  let id = "resp_large";
  let output = [];
  t.mock.method(globalThis, "fetch", async () => stream(done(id, output)));
  await save(router, [user("x".repeat(200))], id);
  assert.equal(await missReason(router, id), "snapshot_too_large");
  id = "resp_empty";
  await save(router, [], id);
  assert.equal(await missReason(router, id), "empty_snapshot");
  assert.equal(await missReason(router, "resp_missing"), "unknown");
  assert.equal(await missReason(router, "resp_missing", { requestHeaders: { authorization: "Bearer fixture" } }), "missing_session_key");
  id = "resp_large_output";
  output = [{ type: "message", role: "assistant", content: "x".repeat(200) }];
  await save(router, [user("short")], id);
  assert.equal(await missReason(router, id), "snapshot_too_large");
});

async function httpFixture(t, overrides = {}) {
  const router = await loadRouterWith({ upstreamWebSocket: false, ...overrides });
  const logs = [];
  const originalWrite = process.stderr.write;
  t.mock.method(process.stderr, "write", function (chunk, ...args) {
    if (/^model-router-(?:error|history-recovered):/.test(String(chunk))) { logs.push(String(chunk)); return true; }
    return originalWrite.call(this, chunk, ...args);
  });
  router.routerServer.listen(0, "127.0.0.1");
  await once(router.routerServer, "listening");
  t.after(() => new Promise(resolve => { router.routerServer.close(resolve); router.routerServer.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${router.routerServer.address().port}`;
  const realFetch = globalThis.fetch;
  let responseNumber = 0;
  let reply = () => stream(done(`resp_ok_${++responseNumber}`));
  t.mock.method(globalThis, "fetch", async (...args) => reply(...args));
  return {
    router, logs,
    setReply(fn) { reply = fn; },
    async call(request, extraHeaders = {}) {
      const response = await realFetch(origin + "/v1/responses", { method: "POST",
        headers: { ...headers, "content-type": "application/json", ...extraHeaders }, body: JSON.stringify(request) });
      const text = await response.text();
      return { status: response.status, text };
    },
    entries: () => installer.parseRouterLog(logs.join("")),
  };
}

test("真實 HTTP：錯誤記錄帶遺失原因，同任務完整重送成功後按診斷 ID 標記恢復", async t => {
  const fixture = await httpFixture(t);
  const failure = await fixture.call(missing());
  assert.equal(failure.status, 409);
  const [entry] = fixture.entries();
  assert.equal(entry.historyReason, "unknown");
  assert.ok(failure.text.includes(entry.requestId));
  assert.equal(entry.recoveredAt, undefined);
  assert.equal((await fixture.call(replay())).status, 200);
  const recovered = fixture.entries()[0];
  assert.equal(recovered.requestId, entry.requestId);
  assert.ok(Number.isFinite(Date.parse(recovered.recoveredAt)));
  await fixture.call(replay());
  assert.equal(fixture.logs.filter(line => line.startsWith("model-router-history-recovered:")).length, 1);
  await fixture.call(missing());
  assert.equal(fixture.entries()[0].recoveredAt, undefined, "新失敗不繼承舊恢復狀態");
  assert.ok(fixture.entries()[1].recoveredAt);
  assert.doesNotMatch(fixture.logs.join(""), /private-token|private-account|private-input|private-result|call_private|resp_missing/);
});

test("不同任務、帳號、模型、只有工具輸出或不相符的增量都不誤標恢復", async t => {
  const fixture = await httpFixture(t);
  await fixture.call(missing());
  await fixture.call(replay(), { "thread-id": "other-task" });
  await fixture.call(replay(), { "chatgpt-account-id": "other-account" });
  await fixture.call({ ...replay(), model: "other-model" });
  await fixture.call(body(delta));
  await fixture.call(body([user("different-input")]));
  await fixture.call({ ...replay(), generate: false });
  assert.equal(fixture.entries()[0].recoveredAt, undefined);
  await fixture.call(replay());
  assert.ok(fixture.entries()[0].recoveredAt);
});

test("失敗、取消、串流中斷、未完成與超大歷史都不標記已恢復", async t => {
  const fixture = await httpFixture(t, { maxHistoryBytes: 450 });
  await fixture.call(missing());
  for (const reply of [
    () => new Response("unavailable", { status: 503 }),
    () => { throw new DOMException("cancelled", "AbortError"); },
    () => stream({ type: "response.failed", response: { id: "resp_failed", status: "failed" } }),
    () => stream({ type: "response.in_progress", response: { id: "resp_truncated" } }),
    () => stream({ type: "response.incomplete", response: { id: "resp_incomplete", status: "incomplete" } }),
    () => stream(done("resp_large", [{ type: "message", role: "assistant", content: "x".repeat(500) }])),
  ]) {
    fixture.setReply(reply);
    await fixture.call(replay());
    assert.equal(fixture.entries().find(entry => entry.code === "router_history_unavailable").recoveredAt, undefined);
  }
  fixture.setReply(() => stream(done("resp_success")));
  await fixture.call(replay());
  assert.ok(fixture.entries().find(entry => entry.code === "router_history_unavailable").recoveredAt);
});

test("重送已開始後出現的新失敗，不會被那個較早開始的請求誤標恢復", async t => {
  const fixture = await httpFixture(t);
  await fixture.call(missing());
  const firstId = fixture.entries()[0].requestId;
  let release;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  fixture.setReply(() => new Promise(resolve => { release = () => resolve(stream(done("resp_late"))); started(); }));
  const earlier = fixture.call(replay());
  await waiting;
  await fixture.call(missing());
  release();
  await earlier;
  const entries = fixture.entries();
  assert.equal(entries[0].recoveredAt, undefined);
  assert.ok(entries.find(entry => entry.requestId === firstId).recoveredAt);
});

test("只有可能共用的 client_metadata，不足以判定同任務已恢復", async t => {
  const fixture = await httpFixture(t);
  const metadata = { session_id: "shared-background-session" };
  const noThread = { "thread-id": "" };
  await fixture.call({ ...missing(), client_metadata: metadata }, noThread);
  await fixture.call({ ...replay(), client_metadata: metadata }, noThread);
  assert.equal(fixture.entries()[0].recoveredAt, undefined);
});

test("官方 WebSocket 換連線後，完整重送完成也會按原診斷 ID 標記恢復", async t => {
  const router = await loadRouterWith({});
  const logs = [];
  const originalWrite = process.stderr.write;
  t.mock.method(process.stderr, "write", function (chunk, ...args) {
    if (String(chunk).startsWith("model-router-history-recovered:")) { logs.push(String(chunk)); return true; }
    return originalWrite.call(this, chunk, ...args);
  });
  t.mock.method(globalThis, "fetch", () => assert.fail("完整重送應走既有上游 WebSocket"));
  const state = namespace => ({ connectionNamespace: namespace, upstreamDisabled: false, session: {
    closed: false, responseIds: new Set(), destroy() { this.closed = true; },
    send() { queueMicrotask(() => this.onEvent?.(done("resp_ws_recovered"))); },
  } });
  const socket = { destroyed: false, writable: true, write() { return true; } };
  const run = (request, connection) => router.handleWebSocketResponseInner({ headers }, socket, url,
    { type: "response.create", ...request }, new AbortController(), connection);
  let failure;
  await assert.rejects(run(missing(), state("old-connection")), error => {
    failure = error;
    return error.code === "router_history_unavailable";
  });
  await run(replay(), state("new-connection"));
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0].slice("model-router-history-recovered:".length)).requestIds, [failure.historyDiagnosticId]);
});
