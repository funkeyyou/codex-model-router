import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRouterWith } from "./helpers/payloads.mjs";

const headers = {
  authorization: "Bearer fixture", "chatgpt-account-id": "fixture-account", "session-id": "recovery",
};
const inputUrl = new URL("http://127.0.0.1/v1/responses");
const initial = (model = "official-test") => ({ model, input: [{ role: "user", content: "查資料" }] });
const tool = { type: "function_call", id: "fc_test", call_id: "call_test", name: "lookup", arguments: "{}" };
const continuation = (id, model = "official-test") => ({
  model, previous_response_id: id,
  input: [{ type: "function_call_output", call_id: "call_test", output: "查詢結果" }],
});
const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const completed = (id, output = [tool]) => ({ type: "response.completed", response: { id, status: "completed", output } });
const stream = (events, status = 200) => new Response(sse(events), {
  status, headers: { "content-type": "text/event-stream" },
});

function socketFor(router) {
  const chunks = [];
  return {
    destroyed: false, writable: true,
    write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
    end() { this.writable = false; },
    get events() {
      return router.parseWebSocketFrames(Buffer.concat(chunks)).frames
        .filter((frame) => frame.opcode === 1).map((frame) => JSON.parse(frame.payload));
    },
  };
}

async function turn(router, body) {
  const meta = {};
  const upstream = await router.fetchModelUpstream(headers, inputUrl, body, Buffer.from(JSON.stringify(body)), undefined, meta);
  const socket = socketFor(router);
  if (meta.translate === "anthropic" && upstream.ok) await router.bridgeAnthropicToWebSocket(upstream, socket, meta);
  else await router.bridgeSseToWebSocket(upstream, socket, null, meta.history);
  return socket.events;
}

for (const failure of ["502", "network", "truncated", "failed-event"]) {
  test(`${failure} 後重送同一增量，不重複工具結果或保存半輪輸出`, async (t) => {
    const router = await loadRouterWith({ upstreamWebSocket: false });
    const sent = [];
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      sent.push(JSON.parse(options.body));
      if (sent.length === 1) return stream([completed("resp_first")]);
      if (sent.length === 2) {
        if (failure === "502") return new Response('{"error":{"message":"temporary failure"}}', { status: 502 });
        if (failure === "network") throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
        const partial = [{ type: "response.output_item.done", item: { type: "message", role: "assistant", content: "不完整內容" } }];
        if (failure === "failed-event") partial.push({ type: "response.failed", response: { id: "resp_failed" } });
        return stream(partial);
      }
      return stream([completed("resp_retry", [])]);
    });
    await turn(router, initial());
    if (failure === "network") await assert.rejects(turn(router, continuation("resp_first")));
    else await turn(router, continuation("resp_first"));
    await turn(router, continuation("resp_first"));
    assert.deepEqual(sent[2].input, sent[1].input);
    assert.equal(sent[2].input.filter((item) => item.type === "function_call_output").length, 1);
    assert.ok(sent[2].input.some((item) => item.type === "function_call"));
    assert.doesNotMatch(JSON.stringify(sent[2]), /不完整內容/);
  });
}

test("成功回應後再次重送同一 previous_response_id，仍從該 ID 的快照開始", async (t) => {
  const router = await loadRouterWith({});
  const sent = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return stream([completed(`resp_${sent.length}`)]);
  });
  await turn(router, initial());
  await turn(router, continuation("resp_1"));
  await turn(router, continuation("resp_1"));
  assert.deepEqual(sent[2].input, sent[1].input);
});

test("取消請求後的重試保留原本成功的快照", async (t) => {
  const router = await loadRouterWith({});
  const sent = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    sent.push(JSON.parse(options.body));
    if (options.signal?.aborted) throw options.signal.reason;
    return stream([completed("resp_first")]);
  });
  await turn(router, initial());
  const next = continuation("resp_first");
  await assert.rejects(router.fetchModelUpstream(headers, inputUrl, next, Buffer.from(JSON.stringify(next)), AbortSignal.abort(), {}));
  await turn(router, next);
  assert.deepEqual(sent[2].input, sent[1].input);
});

test("沒有對應歷史時明確要求重送完整對話，不把孤立工具輸出交給 Claude", async (t) => {
  const router = await loadRouterWith({});
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("不應發送上游請求"));
  await assert.rejects(turn(router, continuation("resp_missing", "custom/claude-test")), (error) => {
    assert.equal(router.describeRouterError(error).code, "router_history_unavailable");
    return true;
  });
  assert.equal(fetch.mock.callCount(), 0);
});

test("Claude 成功工具回合後遇到 502，重試保留配對且只送一份工具結果", async (t) => {
  const router = await loadRouterWith({});
  router.markAuthValidated(headers);
  const oldKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = oldKey;
  });
  const sent = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    sent.push(JSON.parse(options.body));
    if (sent.length === 2) return new Response("temporary failure", { status: 502 });
    return stream([
      { type: "message_start", message: { id: "msg_test", usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_test", name: "lookup", input: {} } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
  });
  const first = await turn(router, initial("custom/claude-test"));
  const id = first.find((event) => event.type === "response.completed").response.id;
  await turn(router, continuation(id, "custom/claude-test"));
  await turn(router, continuation(id, "custom/claude-test"));
  assert.deepEqual(sent[2], sent[1]);
  const blocks = sent[2].messages.flatMap((message) => message.content);
  assert.equal(blocks.filter((block) => block.type === "tool_result" && block.tool_use_id === "call_test").length, 1);
  assert.equal(blocks.filter((block) => block.type === "tool_use" && block.id === "call_test").length, 1);
});

for (const fallback of [false, true]) {
  test(`官方 WebSocket 接續遭拒後${fallback ? "再回退 HTTP" : "重播"}，不重複加入工具結果`, async (t) => {
    const router = await loadRouterWith({});
    const sent = [];
    const httpSent = [];
    const session = {
      closed: false, responseIds: new Set(),
      send(payload) {
        sent.push(payload);
        queueMicrotask(() => {
          if (sent.length === 1) this.onEvent?.(completed("resp_ws"));
          else if (sent.length === 2) this.onEvent?.({ type: "response.failed", response: { error: { message: "Invalid previous_response_id" } } });
          else if (fallback) this.onClosed?.("connection dropped");
          else this.onEvent?.(completed("resp_replay", []));
        });
      },
      destroy() { this.closed = true; },
    };
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      httpSent.push(JSON.parse(options.body));
      return stream([completed("resp_http", [])]);
    });
    const state = { session, connectionNamespace: "ws-test", upstreamDisabled: false };
    const run = (body) => router.handleWebSocketResponseInner(
      { headers }, socketFor(router), inputUrl, { type: "response.create", ...body }, new AbortController(), state,
    );
    await run(initial());
    await run(continuation("resp_ws"));
    assert.equal(sent[1].previous_response_id, "resp_ws");
    assert.equal(sent[2].previous_response_id, undefined);
    assert.equal(sent[2].input.filter((item) => item.type === "function_call_output").length, 1);
    assert.equal(httpSent.length, fallback ? 1 : 0);
    if (fallback) assert.deepEqual(httpSent[0].input, sent[2].input);
  });
}

// 官方上游的訊息不一定提到 previous_response_id，要看錯誤碼。沒認出來的話錯誤會轉給
// Codex，它得斷線重連、整段重送一次，畫面上還會跳出重試提示。
test("官方 WebSocket 回 previous_response_not_found 時由路由器重播，Codex 看不到錯誤", async (t) => {
  const router = await loadRouterWith({});
  const sent = [];
  const session = {
    closed: false, responseIds: new Set(),
    send(payload) {
      sent.push(payload);
      queueMicrotask(() => {
        if (sent.length === 1) this.onEvent?.(completed("resp_ws"));
        else if (sent.length === 2) this.onEvent?.({ type: "error", status: 400, error: {
          type: "invalid_request_error", code: "previous_response_not_found",
          message: "Previous response with id 'resp_ws' not found.", param: "previous_response_id",
        } });
        else this.onEvent?.(completed("resp_replay", []));
      });
    },
    destroy() { this.closed = true; },
  };
  t.mock.method(globalThis, "fetch", () => assert.fail("重播應留在同一條 WebSocket，不必回退 HTTP"));
  const state = { session, connectionNamespace: "ws-not-found", upstreamDisabled: false };
  const socket = socketFor(router);
  const run = (body) => router.handleWebSocketResponseInner(
    { headers }, socket, inputUrl, { type: "response.create", ...body }, new AbortController(), state,
  );
  await run(initial());
  await run(continuation("resp_ws"));
  assert.equal(sent[1].previous_response_id, "resp_ws");
  assert.equal(sent[2].previous_response_id, undefined);
  assert.equal(sent[2].input.filter((item) => item.type === "function_call_output").length, 1);
  assert.deepEqual(socket.events.map((event) => event.type), ["response.completed", "response.completed"]);
  assert.equal(socket.events.at(-1).response.id, "resp_replay");
});

test("WebSocket 已轉發內容後斷線，不再透明回退而重複產生輸出", async (t) => {
  const router = await loadRouterWith({});
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("不能重播已開始的回合"));
  const session = {
    closed: false, responseIds: new Set(), destroy() { this.closed = true; },
    send() { queueMicrotask(() => {
      this.onEvent?.({ type: "response.in_progress", response: { id: "resp_partial" } });
      this.onEvent?.({ type: "response.output_text.delta", delta: "部分內容" });
      this.onClosed?.("connection dropped");
    }); },
  };
  await assert.rejects(router.handleWebSocketResponseInner(
    { headers }, socketFor(router), inputUrl, { type: "response.create", ...initial() }, new AbortController(),
    { session, connectionNamespace: "partial", upstreamDisabled: false },
  ), (error) => error.eventsForwarded === true);
  assert.equal(fetch.mock.callCount(), 0);
});
