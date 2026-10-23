// Chat Completions 路由在路由器裡的接法。
//
// HTTP 與 WebSocket 都送到 /chat/completions，回應轉回 Responses 事件；錯誤碼改寫成
// Codex 認得的值；下一輪由歷史重建時，工具往返與推理照 Chat Completions 的規則還原；
// 這個轉譯層的推理不能漏到官方或其他路由。安裝器的探測見 chat-probe.test.mjs。

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { chat, bridge, router } = await loadPayloads();
const headers = { authorization: "Bearer fixture", "chatgpt-account-id": "fixture-account", "session-id": "chat-route" };
const chatRoute = {
  pickerSlug: "custom/deepseek-chat", upstreamModel: "deepseek-chat", displayName: "api/deepseek-chat",
  providerHost: "gateway.example", efforts: ["low", "medium", "high"], stripReasoning: false, contextWindow: null,
  translate: "chat", chatTools: true, chatStreamOptions: true,
};
const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: { q: { type: "number" } } } }];
const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const delta = (value, finish = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] });
const chatStream = (chunks) => new Response(
  [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""),
  { headers: { "content-type": "text/event-stream" } },
);
const parseSse = (text) => text.split(/\n\n/)
  .map((block) => /^data: (.*)$/m.exec(block)?.[1]).filter(Boolean).map((data) => JSON.parse(data));

function useTestKey(t) {
  const previousKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previousKey;
  });
}

async function startRouter(t, overrides = {}) {
  const instance = await loadRouterWith({ upstreamWebSocket: false, routes: [chatRoute], ...overrides });
  instance.routerServer.listen(0, "127.0.0.1");
  await once(instance.routerServer, "listening");
  t.after(() => new Promise((resolve) => instance.routerServer.close(resolve)));
  return { instance, origin: `http://127.0.0.1:${instance.routerServer.address().port}` };
}

// 回傳記錄上游請求的陣列；reply(index, request) 決定第幾個上游請求回什麼。
function mockUpstream(t, reply) {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const href = String(url);
    // ChatGPT 身份探測缺 client_version 時回 400，路由器視為通過。
    if (href.endsWith("/models")) return new Response("missing client_version", { status: 400 });
    const request = { href, body: JSON.parse(options.body), authorization: new Headers(options.headers).get("authorization") };
    sent.push(request);
    return reply(sent.length, request);
  });
  return sent;
}

// --- 路由器 -----------------------------------------------------------------

test("DeepSeek 自動轉譯僅適用 Codex 工具、壓縮與 chat 推理接續", () => {
  const native = { upstreamModel: "deepseek-v4.1-flash-1017" };
  assert.equal(router.needsDeepseekChat({ tools: [{ type: "custom", name: "exec" }] }, native), true);
  assert.equal(router.needsDeepseekChat({ input: [{ type: "additional_tools", tools }] }, native), true);
  assert.equal(router.needsDeepseekChat({ input: [{ type: "compaction_trigger" }] }, native), true);
  assert.equal(router.needsDeepseekChat({ tools }, native), false);
  assert.equal(router.needsDeepseekChat({ input: "hello" }, native), false);
  for (const route of [{ upstreamModel: "gpt-test" }, { upstreamModel: "not-deepseek" },
    { ...native, translate: "anthropic" }]) {
    assert.equal(router.needsDeepseekChat({ tools: [{ type: "custom", name: "exec" }] }, route), false);
  }
});

for (const transport of ["HTTP", "WebSocket"]) {
  test(`${transport}: DeepSeek Code Mode 工具走 chat 並保留命名空間、進度與下一輪推理`, async (t) => {
    useTestKey(t);
    const originalFetch = globalThis.fetch;
    const native = { ...chatRoute, translate: undefined, upstreamModel: "deepseek-flash" };
    const { instance, origin } = await startRouter(t, { routes: [native] });
    const sent = mockUpstream(t, (index) => index === 1 ? chatStream([
      delta({ reasoning_content: "fixture reasoning" }),
      delta({ content: "先執行測試。" }),
      delta({ tool_calls: [{ index: 0, id: "call_exec", type: "function",
        function: { name: "sandbox__exec", arguments: JSON.stringify({ input: "text(2+2);" }) } }] }, "tool_calls"),
    ]) : chatStream([delta({ content: "結果是 4。" }, "stop")]));
    const run = async (body) => {
      if (transport === "HTTP") {
        const response = await originalFetch(`${origin}/v1/responses`, {
          method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
        });
        assert.equal(response.status, 200);
        return parseSse(await response.text());
      }
      const socket = socketFor(instance);
      await instance.handleWebSocketResponseInner({ headers }, socket, new URL("http://localhost/v1/responses"),
        { ...body, type: "response.create" }, new AbortController(),
        { session: null, connectionNamespace: "deepseek-tools", upstreamDisabled: true });
      return socket.events;
    };
    const events = await run({ model: native.pickerSlug, stream: true, input: [
      // 新聊天的任務可能是沒有 call_id 的工具轉送訊息，不可丟棄。
      { type: "function_call_output", name: "create_thread", output: "請計算 2+2" },
      { type: "additional_tools", tools: [{ type: "namespace", name: "sandbox", tools: [
        { type: "custom", name: "exec", description: "Execute JavaScript" },
      ] }] },
    ] });
    assert.equal(sent[0].href, "https://gateway.example/v1/chat/completions");
    assert.ok(JSON.stringify(sent[0].body.messages).includes("請計算 2+2"));
    assert.equal(sent[0].body.tools[0].type, "function");
    const first = events.at(-1).response;
    assert.equal(events.at(-1).type, "response.completed");
    assert.equal(first.output.find((item) => item.type === "message").phase, "commentary");
    const call = first.output.find((item) => item.type === "custom_tool_call");
    assert.equal(call.namespace, "sandbox");
    assert.equal(call.name, "exec");
    assert.equal(call.input, "text(2+2);");
    assert.match(call.id, /^ctc_/);
    await run({ model: native.pickerSlug, stream: true, input: [user("請計算 2+2"), ...first.output,
      { type: "custom_tool_call_output", call_id: call.call_id, output: "4" }] });
    assert.equal(sent[1].href, "https://gateway.example/v1/chat/completions");
    const assistant = sent[1].body.messages.find((item) => item.tool_calls);
    assert.equal(assistant.reasoning_content, "fixture reasoning");
    assert.equal(sent[1].body.messages.at(-1).role, "tool");
    assert.equal(sent[1].body.messages.at(-1).content, "4");
  });
}

for (const transport of ["HTTP", "WebSocket"]) {
  test(`${transport}: DeepSeek Responses 相容路由的壓縮由 chat bridge 封裝為唯一 compaction`, async (t) => {
    useTestKey(t);
    const originalFetch = globalThis.fetch;
    const native = { ...chatRoute, translate: undefined, upstreamModel: "deepseek-v4.1-flash-1017" };
    const { instance, origin } = await startRouter(t, { routes: [native] });
    const sent = mockUpstream(t, () => chatStream([delta({ content: "保留的工作摘要" }, "stop")]));
    const body = { model: native.pickerSlug, stream: true, tools, input: [
      user("原工作"),
      { type: "custom_tool_call", id: "fc_a8acf1e3cf564fb8be20", call_id: "call_p", name: "patch", input: "text" },
      { type: "custom_tool_call_output", call_id: "call_p", output: "done" },
      { type: "compaction_trigger" },
    ] };
    let events;
    if (transport === "HTTP") {
      const response = await originalFetch(`${origin}/v1/responses`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      events = parseSse(await response.text());
    } else {
      const socket = socketFor(instance);
      await instance.handleWebSocketResponseInner({ headers }, socket, new URL("http://localhost/v1/responses"),
        { ...body, type: "response.create" }, new AbortController(),
        { session: null, connectionNamespace: "compact", upstreamDisabled: true });
      events = socket.events;
    }
    assert.equal(sent.length, 1);
    assert.equal(sent[0].href, "https://gateway.example/v1/chat/completions");
    assert.equal(sent[0].body.tools, undefined);
    const done = events.at(-1);
    assert.equal(done.type, "response.completed");
    assert.equal(done.response.output.length, 1);
    assert.equal(done.response.output[0].type, "compaction");
    assert.equal(bridge.decodeCompaction(done.response.output[0].encrypted_content), "保留的工作摘要");
    assert.equal(events.some((event) => event.type === "response.output_text.delta"), false);
    // 壓縮後的下一輪仍能重播摘要；非壓縮回合不改走 Chat Completions。
    const meta = {};
    const next = { model: native.pickerSlug, input: [done.response.output[0], user("繼續")] };
    await instance.fetchModelUpstream(headers, new URL("http://localhost/v1/responses"), next,
      Buffer.from(JSON.stringify(next)), undefined, meta);
    assert.equal(sent[1].href, "https://gateway.example/v1/responses");
    assert.ok(JSON.stringify(sent[1].body.input).includes("保留的工作摘要"));
  });
}

test("HTTP：送到 /chat/completions、轉回 Responses 事件；下一輪由歷史重建出工具往返與推理", async (t) => {
  useTestKey(t);
  const originalFetch = globalThis.fetch;
  const { origin } = await startRouter(t);
  const sent = mockUpstream(t, (index) => (index === 1
    ? chatStream([
      delta({ reasoning_content: "先查資料" }),
      delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":1}" } }] }, "tool_calls"),
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
    ])
    : chatStream([delta({ content: "查好了" }, "stop")])));
  const post = async (body) => {
    const response = await originalFetch(`${origin}/v1/responses`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, events: parseSse(await response.text()) };
  };

  const first = await post({ model: chatRoute.pickerSlug, input: [user("查")], tools, reasoning: { effort: "high" }, stream: true });
  assert.equal(first.status, 200);
  const completed = first.events.find((event) => event.type === "response.completed");
  assert.deepEqual(completed.response.output.map((item) => item.type), ["reasoning", "function_call"]);
  assert.equal(sent[0].href, "https://gateway.example/v1/chat/completions");
  assert.equal(sent[0].authorization, "Bearer fixture-key");
  assert.equal(sent[0].body.model, "deepseek-chat");
  assert.equal(sent[0].body.reasoning_effort, "high");
  assert.deepEqual(sent[0].body.tools.map((tool) => tool.function.name), ["lookup"]);

  const second = await post({
    model: chatRoute.pickerSlug, previous_response_id: completed.response.id, tools, stream: true,
    input: [{ type: "function_call_output", call_id: "call_1", output: "結果" }],
  });
  assert.equal(second.status, 200);
  assert.equal(second.events.at(-1).type, "response.completed");
  const messages = sent[1].body.messages;
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool"]);
  assert.equal(messages[1].reasoning_content, "先查資料");
  assert.deepEqual(messages[1].tool_calls, [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":1}" } }]);
  assert.equal(messages[2].content, "結果");
});

test("HTTP：Chat Completions 的錯誤改寫成 Codex 認得的錯誤碼，保留狀態碼", async (t) => {
  useTestKey(t);
  const originalFetch = globalThis.fetch;
  const { origin } = await startRouter(t);
  mockUpstream(t, () => new Response(JSON.stringify({ error: {
    message: "This model's maximum context length is 65536 tokens. However, you requested 70000 tokens.",
    type: "invalid_request_error",
  } }), { status: 400, headers: { "content-type": "application/json" } }));
  const response = await originalFetch(`${origin}/v1/responses`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ model: chatRoute.pickerSlug, input: "hi", stream: true }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "context_length_exceeded");
});

function socketFor(instance) {
  const chunks = [];
  return {
    destroyed: false, writable: true,
    write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
    end() { this.writable = false; },
    get events() {
      return instance.parseWebSocketFrames(Buffer.concat(chunks)).frames
        .filter((frame) => frame.opcode === 1).map((frame) => JSON.parse(frame.payload));
    },
  };
}

test("WebSocket：同樣轉成 Responses 事件並以終止事件收尾；上游截斷時補 response.failed", async (t) => {
  useTestKey(t);
  const instance = await loadRouterWith({ upstreamWebSocket: false, routes: [chatRoute] });
  let truncate = false;
  mockUpstream(t, () => (truncate
    ? new Response(`data: ${JSON.stringify(delta({ content: "一半" }))}\n\n`, { headers: { "content-type": "text/event-stream" } })
    : chatStream([delta({ content: "嗨" }, "stop")])));
  const run = async () => {
    const socket = socketFor(instance);
    await instance.handleWebSocketResponseInner({ headers }, socket, new URL("http://127.0.0.1/v1/responses"),
      { type: "response.create", model: chatRoute.pickerSlug, input: "hi" }, new AbortController(),
      { session: null, connectionNamespace: "chat-ws", upstreamDisabled: true });
    return socket.events;
  };
  const events = await run();
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).response.output[0].content[0].text, "嗨");
  truncate = true;
  const cut = await run();
  assert.equal(cut.at(-1).type, "response.failed");
  assert.equal(cut.at(-1).response.error.code, "upstream_stream_truncated");
});

test("這個轉譯層的推理不會漏到官方路由，Claude 轉譯也會略過；chat 路由自己保留", async (t) => {
  const thought = { type: "reasoning", summary: [{ type: "summary_text", text: "想法" }], encrypted_content: chat.CHAT_REASONING_MARKER };
  const input = [user("q"), thought, { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] }, user("next")];
  assert.equal(router.stripBridgeReasoning(input).removed, 1);
  assert.equal(router.stripBridgeReasoning(input, { keepChatReasoning: true }).removed, 0);
  const anthropic = bridge.toAnthropicRequest({ input }, "claude-test").request;
  assert.ok(!JSON.stringify(anthropic).includes("想法"), "Claude 轉譯不能把它當成 thinking");

  useTestKey(t);
  const instance = await loadRouterWith({ upstreamWebSocket: false, routes: [chatRoute] });
  const sent = mockUpstream(t, () => new Response("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"output\":[]}}\n\n",
    { headers: { "content-type": "text/event-stream" } }));
  const body = { model: "gpt-official", input, stream: true };
  const upstream = await instance.fetchModelUpstream(headers, new URL("http://127.0.0.1/v1/responses"), body,
    Buffer.from(JSON.stringify(body)), undefined, {});
  await upstream.text();
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].body.input.some((item) => item.type === "reasoning"), "官方路由收到的請求裡不能有這種推理");
});
