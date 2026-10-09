// Codex 開新任務或打開舊任務時送的 generate:false 預熱（startup prewarm）。
//
// 官方後端只預先處理提示詞前綴、不生成內容，下一輪再以預熱回應的 id 增量接續。
// 第三方上游沒有這種語意，generate 又會在轉送前被剝掉，以前每打開一個任務就多付
// 一次完整生成；任務若還記著已刪除的模型，則會在管理頁留下一筆 404 雜訊。

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { router } = await loadPayloads();
const headers = { authorization: "Bearer fixture", "chatgpt-account-id": "fixture-account", "session-id": "prewarm" };
const url = new URL("http://127.0.0.1/v1/responses");
const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const developer = (text) => ({ type: "message", role: "developer", content: [{ type: "input_text", text }] });
const base = [developer("<permissions>base</permissions>"), user("<environment_context>cwd</environment_context>")];
const claude = {
  pickerSlug: "custom/claude-test", upstreamModel: "claude-test", displayName: "claude-test",
  providerHost: "gateway.example", efforts: ["low", "medium", "high"], stripReasoning: false,
  translate: "anthropic", contextWindow: 200000, maxOutputTokens: 64000,
};
const relay = {
  pickerSlug: "custom/relay-gpt-1a2b3c4d", upstreamModel: "relay-gpt", displayName: "api/relay-gpt",
  providerHost: "gateway.example", efforts: ["low", "medium", "high"], stripReasoning: false, contextWindow: null,
};
const sse = (events) => new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""),
  { headers: { "content-type": "text/event-stream" } });
const completed = (id) => ({ type: "response.completed", response: { id, status: "completed", output: [] } });
const anthropicStream = (text) => new Response([
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [],
    stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
].map((event) => "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n").join(""),
{ headers: { "content-type": "text/event-stream" } });

function useTestKey(t) {
  const previous = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-key";
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previous;
  });
}

// 回傳記錄上游請求的陣列；ChatGPT 身份探測（/models）視為通過且不算上游請求。
function mockUpstream(t, reply = () => sse([completed("upstream")])) {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (target, options = {}) => {
    const href = String(target);
    if (href.endsWith("/models")) return new Response("missing client_version", { status: 400 });
    const request = { href, body: JSON.parse(options.body) };
    sent.push(request);
    return reply(sent.length, request);
  });
  return sent;
}

function socketFor(instance) {
  const chunks = [];
  return {
    destroyed: false, writable: true,
    write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
    end() { this.writable = false; },
    destroy() { this.destroyed = true; },
    get events() {
      return instance.parseWebSocketFrames(Buffer.concat(chunks)).frames
        .filter((frame) => frame.opcode === 1).map((frame) => JSON.parse(frame.payload));
    },
  };
}

async function turn(instance, state, message) {
  const socket = socketFor(instance);
  await instance.handleWebSocketResponseInner({ headers }, socket, url, { type: "response.create", ...message },
    new AbortController(), state);
  return socket.events;
}

test("已刪除模型的名稱從選擇器 ID 還原，去掉雜湊與 custom/ 前綴", () => {
  assert.equal(router.customModelLabel("custom/ark-claude-opus-5-6be3fe22"), "ark-claude-opus-5");
  assert.equal(router.customModelLabel("custom/owo-gpt-6.1-sol-8e1acebe"), "owo-gpt-6.1-sol");
  assert.equal(router.customModelLabel("custom/missing"), "missing");
  assert.equal(router.isPrewarmRequest({ type: "response.create", generate: false }), true);
  assert.equal(router.isPrewarmRequest({ type: "response.create" }), false);
  assert.equal(router.isPrewarmRequest({ type: "response.create", generate: true }), false);
});

test("中轉 GPT 的預熱由路由器本機完成，不送上游；下一輪增量接續照常重建完整輸入", async (t) => {
  useTestKey(t);
  const instance = await loadRouterWith({ upstreamWebSocket: false, routes: [claude, relay] });
  const sent = mockUpstream(t);
  const state = { session: null, connectionNamespace: "relay-prewarm", upstreamDisabled: true };

  const warm = await turn(instance, state, { model: relay.pickerSlug, generate: false, instructions: "sys", tools: [], input: base });
  assert.equal(sent.length, 0, "預熱不能變成一次完整生成");
  assert.deepEqual(warm.map((event) => event.type), ["response.created", "response.completed"]);
  const prewarmId = warm.at(-1).response.id;
  assert.match(prewarmId, /^resp_prewarm_[0-9a-f]{24}$/);
  assert.equal(warm[0].response.id, prewarmId);
  assert.deepEqual(warm.at(-1).response.output, []);

  const next = await turn(instance, state, { model: relay.pickerSlug, previous_response_id: prewarmId, instructions: "sys", tools: [], input: [user("嗨")] });
  assert.equal(next.at(-1).type, "response.completed");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body.input, [...base, user("嗨")]);
  assert.equal(sent[0].body.previous_response_id, undefined);
  assert.equal("generate" in sent[0].body, false);
  assert.equal(sent[0].body.model, "relay-gpt");
});

test("預熱只有指令與工具（沒有輸入）時，下一輪仍可接續，不會要求完整重送", async (t) => {
  useTestKey(t);
  const instance = await loadRouterWith({ upstreamWebSocket: false, routes: [claude, relay] });
  const sent = mockUpstream(t);
  const state = { session: null, connectionNamespace: "empty-prewarm", upstreamDisabled: true };
  const warm = await turn(instance, state, { model: relay.pickerSlug, generate: false, instructions: "sys", tools: [], input: [] });
  const next = await turn(instance, state, { model: relay.pickerSlug, previous_response_id: warm.at(-1).response.id, input: [user("第一則")] });
  assert.equal(next.at(-1).type, "response.completed");
  assert.deepEqual(sent.map((request) => request.body.input), [[user("第一則")]]);
});

test("預熱與下一輪帶的工作階段識別不同時，仍能憑預熱 id 接續；一般回應 id 不會跨 key 借用", async (t) => {
  useTestKey(t);
  const instance = await loadRouterWith({ upstreamWebSocket: false, routes: [claude, relay] });
  const sent = mockUpstream(t);
  const state = { session: null, connectionNamespace: "identity-prewarm", upstreamDisabled: true };
  const warm = await turn(instance, state, { model: relay.pickerSlug, generate: false, input: base,
    client_metadata: { session_id: "prewarm-meta" } });
  await turn(instance, state, { model: relay.pickerSlug, previous_response_id: warm.at(-1).response.id,
    input: [user("嗨")], client_metadata: { session_id: "turn-meta" } });
  assert.deepEqual(sent[0].body.input, [...base, user("嗨")]);

  // 上游回應的 id（upstream）屬於 turn-meta；換一個工作階段識別引用它仍視為遺失。
  await assert.rejects(turn(instance, state, { model: relay.pickerSlug, previous_response_id: "upstream",
    input: [user("再一則")], client_metadata: { session_id: "other-meta" } }), { code: "router_history_unavailable" });
});

test("Claude 路由的預熱同樣不送上游；接續時把預熱輸入一起轉譯", async (t) => {
  useTestKey(t);
  const instance = await loadRouterWith({ upstreamWebSocket: false, routes: [claude, relay] });
  const sent = mockUpstream(t, () => anthropicStream("好"));
  const state = { session: null, connectionNamespace: "claude-prewarm", upstreamDisabled: true };
  const warm = await turn(instance, state, { model: claude.pickerSlug, generate: false, instructions: "sys", tools: [], input: base });
  assert.equal(sent.length, 0);
  assert.equal(warm.at(-1).type, "response.completed");
  const next = await turn(instance, state, { model: claude.pickerSlug, previous_response_id: warm.at(-1).response.id, instructions: "sys", tools: [], input: [user("嗨")] });
  assert.equal(next.at(-1).type, "response.completed");
  assert.equal(sent.length, 1);
  assert.match(sent[0].href, /\/v1\/messages$/);
  const text = JSON.stringify(sent[0].body.messages);
  assert.match(text, /environment_context/);
  assert.match(text, /嗨/);
});

test("官方路由：上游 WebSocket 可用時預熱原樣交給官方；回退時改由本機完成並在下一輪重建", async (t) => {
  const instance = await loadRouterWith({});
  const forwarded = [];
  const session = { closed: false, responseIds: new Set(), destroy() { this.closed = true; },
    send(payload) { forwarded.push(payload); queueMicrotask(() => this.onEvent(completed("official-" + forwarded.length))); } };
  const live = { session, connectionNamespace: "official-live", upstreamDisabled: false };
  const warm = await turn(instance, live, { model: "gpt-test", generate: false, input: base });
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].generate, false, "官方後端自己支援預熱，要原樣轉交");
  assert.equal(warm.at(-1).response.id, "official-1");

  const sent = mockUpstream(t);
  const fallback = { session: null, connectionNamespace: "official-fallback", upstreamDisabled: true };
  const local = await turn(instance, fallback, { model: "gpt-test", generate: false, input: base });
  assert.equal(sent.length, 0, "HTTP 回退時不能把預熱變成完整生成");
  assert.match(local.at(-1).response.id, /^resp_prewarm_/);
  await turn(instance, fallback, { model: "gpt-test", previous_response_id: local.at(-1).response.id, input: [user("嗨")] });
  assert.equal(sent.length, 1);
  assert.match(sent[0].href, /chatgpt\.example/);
  assert.deepEqual(sent[0].body.input, [...base, user("嗨")]);
  assert.equal(sent[0].body.previous_response_id, undefined);
});

async function serve(t) {
  const instance = await loadRouterWith({ upstreamWebSocket: true });
  const sockets = new Set();
  instance.routerServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  instance.routerServer.listen(0, "127.0.0.1");
  await once(instance.routerServer, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => instance.routerServer.close(resolve));
  });
  return { instance, origin: "http://127.0.0.1:" + instance.routerServer.address().port };
}

test("任務還記著已刪除的模型：打開時的預熱靜默完成、不記錯誤；真的送出才回 404 並點名模型", { timeout: 5000 }, async (t) => {
  const originalFetch = globalThis.fetch;
  const { origin } = await serve(t);
  const upstream = t.mock.method(globalThis, "fetch", () => assert.fail("已刪除的模型不能送往任何上游"));
  const errorLines = [];
  const write = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, "write", (chunk, ...rest) => {
    if (String(chunk).startsWith("model-router-error:")) {
      errorLines.push(JSON.parse(String(chunk).slice("model-router-error:".length)));
      return true;
    }
    return write(chunk, ...rest);
  });

  const stale = "custom/ark-claude-opus-5-6be3fe22";
  const ws = new WebSocket(origin.replace("http:", "ws:") + "/v1/responses");
  const events = [];
  let waiting = null;
  ws.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    events.push(event);
    if (waiting && ["response.completed", "response.failed"].includes(event.type)) waiting();
  });
  const terminal = () => new Promise((resolve) => { waiting = resolve; });
  await once(ws, "open");

  let done = terminal();
  ws.send(JSON.stringify({ type: "response.create", model: stale, generate: false, input: base }));
  await done;
  assert.deepEqual(events.map((event) => event.type), ["response.created", "response.completed"]);
  assert.deepEqual(errorLines, [], "打開任務本身不算錯誤，不能進管理頁");

  events.length = 0;
  done = terminal();
  ws.send(JSON.stringify({ type: "response.create", model: stale, input: [user("嗨")] }));
  await done;
  assert.deepEqual(events.map((event) => event.type), ["error", "response.failed"]);
  assert.equal(events[0].error.code, "custom_model_not_configured");
  assert.match(events[0].error.message, /「ark-claude-opus-5」/);
  assert.match(events[0].error.message, /這個任務的模型選單/);
  assert.equal(errorLines.length, 1);
  assert.equal(errorLines[0].code, "custom_model_not_configured");
  assert.equal(errorLines[0].provider, undefined, "未配置的模型不屬於任何供應商");
  assert.equal(errorLines[0].upstreamHost, null);
  assert.equal(upstream.mock.callCount(), 0);

  const health = await originalFetch(origin + "/healthz").then((response) => response.json());
  assert.equal(health.stats.stalePrewarms, 1);
  assert.equal(health.stats.lastStalePrewarmModel, stale);
  assert.equal(health.stats.localPrewarms, 0);
  ws.close();
  await once(ws, "close");
});
