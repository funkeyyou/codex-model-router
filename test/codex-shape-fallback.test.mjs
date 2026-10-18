// 部分 Responses 相容上游（例如 xAI）不認得 Codex 的 additional_tools、namespace 與 custom 工具。
// 路由器遇到這種拒絕時改走 Chat 轉譯並記住；安裝器探測時就分流。

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { router, installer } = await loadPayloads();
const headers = { authorization: "Bearer fixture", "chatgpt-account-id": "fixture-account", "session-id": "shape-fallback" };
const route = {
  pickerSlug: "custom/xai-grok-test", upstreamModel: "grok-test", displayName: "xai/grok-test",
  providerHost: "gateway.example", efforts: ["low", "medium", "high", "xhigh"], stripReasoning: false, contextWindow: null,
};
const XAI_REJECTION = "Failed to deserialize the JSON body into the target type: input[0]: unknown item type \"additional_tools\"; expected one of: message, reasoning, function_call";
const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const codexTools = { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [
  { type: "custom", name: "exec", description: "Run code", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
] }] };
const delta = (value, finish = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] });
const chatStream = (chunks) => new Response(
  [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""),
  { headers: { "content-type": "text/event-stream" } },
);
const parseSse = (text) => text.split(/\n\n/)
  .map((block) => /^data: (.*)$/m.exec(block)?.[1]).filter(Boolean).map((data) => JSON.parse(data));

test("辨識上游拒收 Codex 工具格式的錯誤，不誤判其他 400／422", () => {
  assert.equal(router.codexShapeRejected(422, XAI_REJECTION), true);
  assert.equal(router.codexShapeRejected(422, "tools[0].type: unknown variant `namespace`, expected one of `function`"), true);
  assert.equal(router.codexShapeRejected(422, "tools[0].type: unknown variant `custom`, expected one of `function`"), true);
  assert.equal(router.codexShapeRejected(400, "Unsupported tool type: custom"), true);
  assert.equal(router.codexShapeRejected(400, "max_output_tokens must be at least 16"), false);
  assert.equal(router.codexShapeRejected(400, "This model's maximum context length is 65536 tokens"), false);
  assert.equal(router.codexShapeRejected(500, XAI_REJECTION), false);
  assert.equal(router.usesCodexToolShapes({ input: [codexTools, user("hi")] }), true);
  assert.equal(router.usesCodexToolShapes({ input: [user("hi")], tools: [{ type: "function", name: "f" }] }), false);
  assert.equal(router.usesCodexToolShapes({ input: [{ type: "function_call", name: "spawn_agent", namespace: "collaboration", call_id: "c", arguments: "{}" }] }), true);
});

async function startRouter(t) {
  const previousKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previousKey;
  });
  const instance = await loadRouterWith({ upstreamWebSocket: false, routes: [route] });
  instance.routerServer.listen(0, "127.0.0.1");
  await once(instance.routerServer, "listening");
  t.after(() => new Promise((resolve) => instance.routerServer.close(resolve)));
  return `http://127.0.0.1:${instance.routerServer.address().port}`;
}

function mockUpstream(t, reply) {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const href = String(url);
    if (href.endsWith("/models")) return new Response("missing client_version", { status: 400 });
    sent.push({ href, body: JSON.parse(options.body) });
    return reply(href);
  });
  return sent;
}

test("Responses 上游拒收 Codex 工具格式：這一輪改走 Chat 轉譯，之後直接走 Chat", async (t) => {
  const originalFetch = globalThis.fetch;
  const origin = await startRouter(t);
  const sent = mockUpstream(t, (href) => href.endsWith("/responses")
    ? new Response(JSON.stringify({ code: "Client specified an invalid argument", error: XAI_REJECTION }), { status: 422, headers: { "content-type": "application/json" } })
    : chatStream([delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec", arguments: "{\"input\":\"1+1\"}" } }] }, "tool_calls")]));
  const post = async () => {
    const response = await originalFetch(`${origin}/v1/responses`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model: route.pickerSlug, input: [codexTools, user("算一下")], stream: true, reasoning: { effort: "xhigh" } }),
    });
    return { status: response.status, events: parseSse(await response.text()) };
  };

  const first = await post();
  assert.equal(first.status, 200);
  assert.deepEqual(sent.map((request) => new URL(request.href).pathname), ["/v1/responses", "/v1/chat/completions"]);
  const chatBody = sent[1].body;
  assert.equal(chatBody.model, "grok-test");
  assert.deepEqual(chatBody.tools.map((tool) => tool.function.name), ["exec"], "namespace 攤平、custom 轉成 function");
  assert.equal(chatBody.reasoning_effort, "high");
  const done = first.events.find((event) => event.type === "response.completed");
  assert.deepEqual(done.response.output.map((item) => [item.type, item.name, item.input]), [["custom_tool_call", "exec", "1+1"]]);

  await post();
  assert.deepEqual(sent.slice(2).map((request) => new URL(request.href).pathname), ["/v1/chat/completions"], "記住後不再先打 /responses");
});

test("與工具格式無關的 422 照原樣回傳，不改走 Chat", async (t) => {
  const originalFetch = globalThis.fetch;
  const origin = await startRouter(t);
  const sent = mockUpstream(t, () => new Response(JSON.stringify({ error: { message: "max_output_tokens must be at least 16" } }),
    { status: 422, headers: { "content-type": "application/json" } }));
  const response = await originalFetch(`${origin}/v1/responses`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ model: route.pickerSlug, input: [codexTools, user("hi")], stream: true }),
  });
  assert.equal(response.status, 422);
  assert.match(await response.text(), /max_output_tokens/);
  assert.deepEqual(sent.map((request) => new URL(request.href).pathname), ["/v1/responses"]);
});

test("安裝器探測 Codex 工具格式：通過、被拒、問不到分開判斷", async () => {
  const silent = { write() {}, line() {} };
  let seen;
  assert.equal(await installer.probeCodexToolShapes(async (extra) => { seen = extra; return { ok: true, status: 200 }; }, silent), "supported");
  assert.equal(seen.input[0].type, "additional_tools");
  assert.equal(seen.input[0].tools[0].type, "namespace");
  assert.equal(seen.input[0].tools[0].tools[0].type, "custom");
  assert.equal(await installer.probeCodexToolShapes(async () => ({ ok: false, status: 422 }), silent), "unsupported");
  assert.equal(await installer.probeCodexToolShapes(async () => ({ ok: false, status: 400 }), silent), "unsupported");
  assert.equal(await installer.probeCodexToolShapes(async () => ({ ok: false, status: 429 }), silent), "unknown");
  assert.equal(await installer.probeCodexToolShapes(async () => { throw new Error("timeout"); }, silent), "unknown");
});
