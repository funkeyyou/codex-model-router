import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { zstdCompressSync } from "node:zlib";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { bridge, router } = await loadPayloads();
const headers = { authorization: "Bearer fixture", "chatgpt-account-id": "fixture", "session-id": "hardening" };
const url = new URL("http://127.0.0.1/v1/responses");
const user = (text) => ({ role: "user", content: text });
const fn = (name) => ({ type: "function", name, parameters: { type: "object" } });
const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const completed = (id) => ({ type: "response.completed", response: { id, status: "completed", output: [] } });
const stream = (events) => new Response(sse(events), { headers: { "content-type": "text/event-stream" } });
function responseSink() {
  const chunks = [];
  return { writeHead() {}, write(chunk) { chunks.push(String(chunk)); return true; }, end() {},
    get text() { return chunks.join(""); } };
}
const translate = (body) => bridge.toAnthropicRequest(body, { upstreamModel: "claude-test" });

test("取消官方 WS 後銷毀舊 session，遲到的事件不能完成下一輪", async () => {
  const session = { responseIds: new Set(), sent: [], send(p) { this.sent.push(p); }, destroy() { this.closed = true; } };
  const controller = new AbortController();
  const received = [];
  const first = router.runUpstreamWebSocketTurn(session, { model: "gpt-test" }, { signal: controller.signal, onEvent: (e) => received.push(e) });
  controller.abort();
  await assert.rejects(first, /已取消/);
  assert.equal(session.closed, true);
  assert.equal(session.onEvent, null);
  session.onEvent?.(completed("cancelled"));
  assert.deepEqual(received, []);
  assert.equal(session.sent.at(-1).type, "response.cancel");
  const nextSession = { responseIds: new Set(), send() { queueMicrotask(() => this.onEvent(completed("new"))); } };
  await router.runUpstreamWebSocketTurn(nextSession, { model: "gpt-test" }, { onEvent: (e) => received.push(e) });
  assert.deepEqual(received.map((event) => event.response.id), ["new"]);
});

test("GPT HTTP SSE 即使沒有 session/history 也偵測提早結束；其他端點不注入事件", async () => {
  for (const responsesStream of [true, false]) {
    const response = responseSink();
    await router.streamUpstream(stream([{ type: "response.output_text.delta", delta: "half" }]), response, null, responsesStream);
    assert.equal(response.text.includes("upstream_stream_truncated"), responsesStream);
  }
  // 頂層 error 不在其中：Codex 會忽略它，只送 error 的情況見 stream-truncation.test.mjs。
  for (const type of ["response.completed", "response.incomplete", "response.failed"]) {
    const response = responseSink();
    await router.streamUpstream(stream([{ type, response: { id: "ok" } }]), response, null, true);
    assert.doesNotMatch(response.text, /upstream_stream_truncated/);
  }
});

test("Claude 接收頂層 instructions/tools、簡寫訊息，合併 additional_tools 並保留指定工具", () => {
  const { request } = translate({ instructions: "system rule", tools: [fn("first")],
    input: [{ type: "additional_tools", tools: [fn("second")] }, user("actual question")],
    tool_choice: { type: "function", name: "second" }, parallel_tool_calls: false });
  assert.equal(request.system[0].text, "system rule");
  assert.deepEqual(request.tools.map((tool) => tool.name), ["first", "second"]);
  assert.equal(request.messages[0].content[0].text, "actual question");
  assert.deepEqual(request.tool_choice, { type: "tool", name: "second", disable_parallel_tool_use: true });
});

test("歧義、保留前綴與過長工具名稱仍唯一，歷史使用同一別名", () => {
  const identities = [["a", "b__c"], ["a__b", "c"], [null, "a__b__c"], [null, "cmr_existing"], ["long".repeat(30), "run"]];
  const names = identities.map(([ns, name]) => bridge.toolAlias(ns, name));
  assert.equal(new Set(names).size, names.length);
  names.forEach((name) => assert.match(name, /^[A-Za-z0-9_-]{1,64}$/));
  const tools = identities.map(([namespace, name]) => namespace ? { type: "namespace", name: namespace, tools: [fn(name)] } : fn(name));
  const calls = identities.map(([namespace, name], i) => ({ type: "function_call", name, namespace, call_id: `c${i}`, arguments: "{}" }));
  const { request, toolTargets } = translate({ tools, input: [user("hi"), ...calls] });
  assert.deepEqual(request.tools.map((tool) => tool.name), names);
  assert.deepEqual(request.messages.flatMap((m) => m.content).filter((c) => c.type === "tool_use").map((c) => c.name), names);
  names.forEach((alias, i) => assert.equal(toolTargets.get(alias).name, identities[i][1]));
});

async function toolStream(json, { custom = false, reason = "tool_use", initial = {} } = {}) {
  const events = [{ type: "content_block_start", content_block: { type: "tool_use", id: "call1", name: "run", input: initial } }];
  if (json !== null) events.push({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: json } });
  events.push({ type: "content_block_stop" }, { type: "message_delta", delta: { stop_reason: reason } }, { type: "message_stop" });
  const result = [];
  await bridge.bridgeAnthropicStream(stream(events).body, (e) => result.push(e), { model: "claude-test", requestBody: {}, freeform: new Set(custom ? ["run"] : []) });
  return result;
}

test("Claude 不將損壞 JSON／非物件／缺 freeform input 轉成可執行工具", async () => {
  for (const [json, custom] of [['{"path":', false], ["[]", false], ["null", false], ["{}", true]]) {
    const events = await toolStream(json, { custom, reason: "max_tokens" });
    assert.equal(events.at(-1).type, "response.failed");
    assert.equal(events.at(-1).response.error.code, "invalid_tool_arguments");
    assert.ok(!events.some((e) => e.type === "response.output_item.done"));
    assert.ok(!events.some((e) => e.type === "response.function_call_arguments.done"));
  }
});

test("歷史工具的非字串 freeform 與非物件參數不被替換成空內容", () => {
  for (const call of [
    { type: "custom_tool_call", input: { value: "do not erase" } },
    { type: "function_call", arguments: "[]" },
    { type: "function_call", arguments: 0 },
  ]) assert.throws(() => translate({ input: [user("hi"), { name: "run", call_id: "call1", ...call }] }), { name: "BridgeRequestError" });
});

test("Claude 保留非空起始工具參數；max_tokens 使用 response.incomplete", async () => {
  const events = await toolStream(null, { initial: { path: "/tmp/example" }, reason: "max_tokens" });
  assert.equal(events.find((e) => e.type === "response.output_item.done").item.arguments, '{"path":"/tmp/example"}');
  assert.equal(events.at(-1).type, "response.incomplete");
  assert.equal(events.at(-1).response.status, "incomplete");
});

test("MCP 圖片和 PDF 內容轉成原生區塊，不靜默遺失附件", () => {
  const { request } = translate({ input: [user([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    { type: "input_file", file_data: "data:application/pdf;base64,JVBERg==" },
    { type: "input_file", file_url: "https://example.com/doc.pdf" }])] });
  assert.deepEqual(request.messages[0].content.map((block) => block.type), ["image", "document", "document"]);
  assert.equal(request.messages[0].content[0].source.data, "aGVsbG8=");
  for (const part of [{ type: "input_file", file_id: "file-private" }, { type: "input_audio", input_audio: { data: "secret" } }]) {
    assert.throws(() => translate({ input: [user([part])] }), { name: "BridgeRequestError" });
  }
});

test("MCP 資源連結與內嵌文字保留內容，無需額外下載", () => {
  const { request } = translate({ input: [user([
    { type: "resource_link", uri: "resource://report", name: "report" },
    { type: "resource", resource: { uri: "resource://note", text: "exact document content" } },
  ])] });
  assert.match(request.messages[0].content[0].text, /resource:\/\/report/);
  assert.equal(request.messages[0].content[1].text, "exact document content");
});

test("平台內建工具可用性明確告知；不能指定未提供工具或假裝支援結構化輸出", () => {
  const { request } = translate({ tools: [{ type: "image_generation" }, { type: "web_search" }, fn("local_read")], input: "hi" });
  assert.deepEqual(request.tools.map((tool) => tool.name), ["local_read"]);
  assert.match(request.system.map((s) => s.text).join(""), /image_generation, web_search/);
  assert.match(request.system.map((s) => s.text).join(""), /router-imagegen/);
  for (const body of [{ tools: [fn("a")], tool_choice: { type: "function", name: "missing" } },
    { tools: [{ type: "image_generation" }], tool_choice: { type: "image_generation" } },
    { text: { format: { type: "json_schema" } } }]) {
    assert.throws(() => translate({ input: "hi", ...body }), { name: "BridgeRequestError" });
  }
});

test("HTTP 接收及解壓上限在 JSON 解析前生效，壞壓縮返回 400", async () => {
  await assert.rejects(router.readRequestBody((async function* () { yield Buffer.alloc(8); yield Buffer.alloc(8); })(), 10), { status: 413 });
  assert.equal((await router.readRequestBody((async function* () { yield Buffer.from("ok"); })(), 10)).toString(), "ok");
  assert.throws(() => router.decodeRequestBody(zstdCompressSync(Buffer.alloc(4096)), "zstd", 100), { status: 413 });
  assert.throws(() => router.decodeRequestBody(Buffer.from("broken"), "zstd"), { status: 400 });
});

async function saveTurn(instance, text, id, session = "hardening") {
  const body = { model: "gpt-test", input: [user(text)] };
  const meta = {};
  const upstream = await instance.fetchModelUpstream({ ...headers, "session-id": session }, url, body, Buffer.from(JSON.stringify(body)), undefined, meta);
  await instance.streamUpstream(upstream, responseSink(), meta.history, true);
}

test("歷史總容量淘汰最舊快照，保留最新完整輸入；過期後要求完整重送", async (t) => {
  const instance = await loadRouterWith({ maxHistoryBytes: 240, historyTtlMs: 1000 });
  let n = 0;
  t.mock.method(globalThis, "fetch", async () => stream([completed(`resp_${++n}`)]));
  await saveTurn(instance, "a".repeat(80), "resp_1", "one");
  await saveTurn(instance, "b".repeat(80), "resp_2", "two");
  assert.ok(instance.historyCacheInfo().bytes <= 240);
  const resume = async (previous_response_id, session) => {
    const body = { model: "gpt-test", previous_response_id, input: [user("next")] };
    const meta = {};
    await instance.fetchModelUpstream({ ...headers, "session-id": session }, url, body, Buffer.from(JSON.stringify(body)), undefined, meta);
    return meta;
  };
  await assert.rejects(resume("resp_1", "one"), { code: "router_history_unavailable" });
  const meta = await resume("resp_2", "two");
  assert.equal(meta.history.input[0].content, "b".repeat(80));
  instance.historyCacheInfo(Date.now() + 2000);
  assert.equal(instance.historyCacheInfo().bytes, 0);
  await assert.rejects(resume("resp_2", "two"), { code: "router_history_unavailable" });
});

test("超出歷史容量的成功回合不保存截斷快照", async (t) => {
  const instance = await loadRouterWith({ maxHistoryBytes: 80 });
  t.mock.method(globalThis, "fetch", async () => stream([completed("large")]));
  await saveTurn(instance, "x".repeat(200), "large");
  assert.equal(instance.historyCacheInfo().count, 0);
});

test("切換官方 GPT 模型會重播完整歷史，且不外送本機圖片工具", async () => {
  const instance = await loadRouterWith({});
  const sent = [];
  const session = { closed: false, responseIds: new Set(), destroy() { this.closed = true; },
    send(payload) { sent.push(payload); queueMicrotask(() => this.onEvent(completed(`r${sent.length}`))); } };
  const state = { session, connectionNamespace: "model-switch", upstreamDisabled: false };
  const socket = { destroyed: false, writable: true, write() { return true; } };
  await instance.handleWebSocketResponseInner({ headers }, socket, url, { type: "response.create", model: "gpt-one", input: [user("original")] }, new AbortController(), state);
  await instance.handleWebSocketResponseInner({ headers }, socket, url, { type: "response.create", model: "gpt-two", previous_response_id: "r1", input: [user("next")] }, new AbortController(), state);
  assert.equal(sent[1].previous_response_id, undefined);
  assert.deepEqual(sent[1].input, [user("original"), user("next")]);
  await instance.handleWebSocketResponseInner({ headers }, socket, url, { type: "response.create", model: "gpt-two", input: [user("image"),
    { type: "function_call", call_id: "call_rtrimg_test", name: "view_image", arguments: "{}" },
    { type: "function_call_output", call_id: "call_rtrimg_test", output: "image bytes" },
  ] }, new AbortController(), state);
  assert.deepEqual(sent[2].input, [user("image")]);
});

test("Claude 工具完成及失敗經真實 HTTP 返回 Codex 格式，未知附件在付費請求前拒絕", async (t) => {
  let bad = false;
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push(body);
    const alias = body.tools[0].name;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse([{ type: "content_block_start", content_block: { type: "tool_use", name: alias, id: "call_local", input: {} } },
      { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: bad ? '{"path":' : '{"path":"report.txt"}' } },
      { type: "content_block_stop" }, { type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" }]));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const instance = await loadRouterWith({ apiRoot: `http://127.0.0.1:${upstream.address().port}/v1` });
  instance.markAuthValidated(headers);
  const previous = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-local-only";
  t.after(() => { if (previous === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY; else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previous; });
  const server = instance.routerServer;
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const body = { model: "custom/claude-test", stream: true, instructions: "Keep files safe", input: [user("read report")],
    tools: [{ type: "namespace", name: "files", tools: [fn("read__text")] }] };
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: "POST", headers,
    body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
  const text = await (await post(body)).text();
  const events = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
  const call = events.find((e) => e.type === "response.output_item.done").item;
  assert.equal(call.name, "read__text"); assert.equal(call.namespace, "files");
  assert.equal(call.arguments, '{"path":"report.txt"}');
  assert.equal(requests[0].system[0].text, "Keep files safe");
  const id = events.at(-1).response.id;
  await (await post({ ...body, previous_response_id: id, input: [{ type: "function_call_output", call_id: "call_local", output: "content" }] })).text();
  const history = requests[1].messages.flatMap((m) => m.content);
  assert.equal(history.find((block) => block.type === "tool_use").name, requests[1].tools[0].name);
  assert.equal(history.find((block) => block.type === "tool_result").tool_use_id, "call_local");
  bad = true;
  const failed = await (await post(body)).text();
  assert.match(failed, /invalid_tool_arguments/);
  assert.doesNotMatch(failed, /response\.output_item\.done/);
  const before = requests.length;
  const unsupported = await post({ ...body, input: [user([{ type: "input_file", file_id: "file-private" }])] });
  assert.equal(unsupported.status, 422);
  const detail = await unsupported.json();
  assert.equal(detail.error.code, "unsupported_bridge_input");
  assert.doesNotMatch(JSON.stringify(detail), /fixture-local-only|file-private/);
  assert.equal(requests.length, before);
});

test("真實 HTTP：GPT 截斷通知、官方搜尋/筆記透傳、壓縮錯誤及接收上限", async (t) => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url, body: Buffer.concat(chunks).toString() });
    if (req.url.endsWith("/responses")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse([{ type: "response.output_text.delta", delta: "half" }]));
      if (JSON.parse(Buffer.concat(chunks)).input === "disconnect") setTimeout(() => res.destroy(), 25);
      else res.end();
    } else { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); }
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const instance = await loadRouterWith({ maxHttpBodyBytes: 200, officialBaseUrl: `http://127.0.0.1:${upstream.address().port}` });
  const server = instance.routerServer;
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, extra = {}) => fetch(base + path, { method: "POST", headers: { ...headers, ...extra }, body, signal: AbortSignal.timeout(3000) });
  const response = await post("/v1/responses", JSON.stringify({ model: "gpt-test", input: "hi", stream: true }));
  assert.match(await response.text(), /upstream_stream_truncated/);
  const disconnected = await post("/v1/responses", JSON.stringify({ model: "gpt-test", input: "disconnect", stream: true }));
  const disconnectedText = await disconnected.text();
  assert.match(disconnectedText, /response\.failed/);
  assert.match(disconnectedText, /upstream_connection_error/);
  for (const path of ["/v1/alpha/search", "/v1/alpha/notes/v2/read_file", "/v1/alpha/history/v2/list_items"]) {
    const result = await post(path, '{"q":"test"}');
    assert.deepEqual(await result.json(), { ok: true });
    assert.equal(seen.at(-1).path, path.slice(3));
    assert.equal(seen.at(-1).body, '{"q":"test"}');
  }
  const before = seen.length;
  for (const path of ["/v1/responses", "/v1/images/generations", "/v1/alpha/search"]) {
    assert.equal((await post(path, "x".repeat(201))).status, 413);
  }
  assert.equal((await post("/v1/responses", zstdCompressSync(Buffer.alloc(400)), { "content-encoding": "zstd" })).status, 413);
  assert.equal((await post("/v1/responses", "invalid", { "content-encoding": "zstd" })).status, 400);
  assert.equal(seen.length, before);
});
