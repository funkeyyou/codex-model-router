import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { bridge, chat, router } = await loadPayloads();
const fn = (name, description = "lookup") => ({
  type: "function", name, description,
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
});
const rawBody = async function* (text, bytewise = false) {
  const bytes = Buffer.from(text);
  if (bytewise) for (const byte of bytes) yield Buffer.from([byte]);
  else yield bytes;
};
const meta = (extra = {}) => ({ model: "claude-test", requestBody: {}, freeform: new Set(), ...extra });
const stream = async (text, extra = {}, bytewise = false) => {
  const events = [];
  await bridge.bridgeAnthropicStream(rawBody(text, bytewise), (event) => events.push(event), meta(extra));
  return events;
};
const terminals = (events) => events.filter((e) => ["response.completed", "response.failed", "response.incomplete"].includes(e.type));
const sseEvents = [
  { type: "message_start", message: { usage: { input_tokens: 2 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好🙂" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
];
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const message = (content, extra = {}) => ({
  type: "message", role: "assistant", content, stop_reason: "end_turn",
  usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5 }, ...extra,
});

test("Claude SSE: missing final blank line, CRLF, multiline data and split UTF-8 preserve completion", async () => {
  const multiline = sseEvents.map((event) => {
    const { type, ...data } = event;
    return `: keepalive\r\nevent: ${type}\r\n` + JSON.stringify(data, null, 2).split("\n")
      .map((line) => `data:${line}`).join("\r\n") + "\r\n\r\n";
  }).join("");
  for (const input of [sse(sseEvents), sse(sseEvents).trimEnd(), multiline.trimEnd()]) {
    const events = await stream(input, {}, true);
    assert.deepEqual(terminals(events).map((e) => e.type), ["response.completed"]);
    assert.equal(events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join(""), "你好🙂");
    assert.equal(terminals(events)[0].response.usage.total_tokens, 5);
  }
});

test("Claude JSON fallback preserves text, reasoning signatures, redacted blocks, tool namespace and usage", async () => {
  const body = message([
    { type: "thinking", thinking: "考慮🙂", signature: "test-signature" },
    { type: "redacted_thinking", data: "redacted-value" },
    { type: "text", text: "我來查" },
    { type: "tool_use", id: "call_1", name: "plugin__lookup", input: { query: "天氣" } },
  ], { stop_reason: "tool_use" });
  const targets = new Map([["plugin__lookup", { name: "lookup", namespace: "plugin" }]]);
  const events = await stream(JSON.stringify(body, null, 2), { toolTargets: targets }, true);
  assert.equal(terminals(events).length, 1);
  const response = terminals(events)[0].response;
  assert.equal(response.status, "completed");
  assert.equal(response.usage.total_tokens, 10);
  assert.equal(response.usage.input_tokens_details.cached_tokens, 5);
  const call = response.output.at(-1);
  assert.equal(call.type, "function_call");
  assert.equal(call.namespace, "plugin");
  assert.equal(call.name, "lookup");
  assert.equal(call.arguments, '{"query":"天氣"}');
  assert.equal(events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join(""), "我來查");
  const replay = bridge.toAnthropicRequest({ input: response.output }, { upstreamModel: "claude-test" }).request;
  const blocks = replay.messages.flatMap((m) => m.content);
  assert.ok(blocks.some((b) => b.type === "thinking" && b.thinking === "考慮🙂" && b.signature === "test-signature"));
  assert.ok(blocks.some((b) => b.type === "redacted_thinking" && b.data === "redacted-value"));
});

test("Claude JSON fallback supports custom tool payloads and complete compaction only", async () => {
  const custom = await stream(JSON.stringify(message([
    { type: "tool_use", id: "call_1", name: "exec", input: { input: "text('ok');" } },
  ], { stop_reason: "tool_use" })), { freeform: new Set(["exec"]) });
  assert.equal(terminals(custom)[0].response.output[0].type, "custom_tool_call");
  assert.equal(terminals(custom)[0].response.output[0].input, "text('ok');");
  const compact = await stream(JSON.stringify(message([{ type: "text", text: "完整摘要" }])), { compaction: true });
  const output = terminals(compact)[0].response.output;
  assert.equal(output.length, 1);
  assert.equal(output[0].type, "compaction");
  assert.equal(bridge.decodeCompaction(output[0].encrypted_content), "完整摘要");
  const truncated = await stream(JSON.stringify(message([{ type: "text", text: "半段" }], { stop_reason: "max_tokens" })), { compaction: true });
  assert.equal(terminals(truncated)[0].type, "response.failed");
});

test("Claude JSON errors, refusal, empty content and invalid tool arguments never become success", async () => {
  const cases = [
    { type: "error", error: { type: "overloaded_error", message: "busy" } },
    message([{ type: "tool_use", id: "call_1", name: "lookup", input: {} }], { stop_reason: "refusal" }),
    message([]),
    message([{ type: "text", text: "unfinished" }], { stop_reason: null }),
    message([{ type: "tool_use", id: "call_1", name: "lookup", input: "{bad" }]),
    message([{ type: "unknown", text: "do not drop" }]),
  ];
  for (const body of cases) {
    const events = await stream(JSON.stringify(body));
    assert.deepEqual(terminals(events).map((e) => e.type), ["response.failed"]);
    assert.ok(!events.some((e) => e.type === "response.output_item.done" && e.item.type === "function_call"));
  }
  const limited = await stream(JSON.stringify(message([{ type: "text", text: "部分回答" }], { stop_reason: "max_tokens" })));
  assert.equal(terminals(limited)[0].type, "response.incomplete");
});

test("Claude parser rejects malformed events, bounds buffering and emits only one terminal", async () => {
  for (const raw of ['data: {bad\n\n', 'data: null\n\n', '{"type":', ' '.repeat(16 * 1024 * 1024 + 1)]) {
    assert.deepEqual(terminals(await stream(raw)).map((e) => e.type), ["response.failed"]);
  }
  assert.equal(terminals(await stream(sse(sseEvents) + sse([{ type: "message_stop" }]))).length, 1);
});

test("Router distinguishes a final unterminated SSE event from a genuinely truncated stream", async () => {
  for (const [input, expected] of [[sse(sseEvents).trimEnd(), "response.completed"], [sse(sseEvents.slice(0, -1)), "response.failed"]]) {
    const chunks = [];
    await router.bridgeTranslatedToHttp({ status: 200, body: rawBody(input) }, {
      writeHead() {}, write(chunk) { chunks.push(chunk); return true; }, end() {},
    }, meta({ translate: "anthropic" }));
    const events = chunks.join("").split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    assert.deepEqual(terminals(events).map((e) => e.type), [expected]);
  }
});

for (const [label, translate] of [["Claude", bridge.toAnthropicRequest], ["Chat", chat.toChatRequest]]) {
  test(`${label}: loaded search tools become callable and retain namespace and freeform grammar`, () => {
    const body = { input: [
      { type: "tool_search_output", call_id: "search_1", execution: "client", status: "completed", tools: [
        { type: "namespace", name: "plugin", tools: [fn("lookup")] },
        { type: "custom", name: "patch", description: "patch safely", format: { type: "grammar", syntax: "lark", definition: 'start: "ok"' } },
      ] },
      { role: "user", content: "lookup now" },
    ], tool_choice: { type: "function", name: "lookup", namespace: "plugin" } };
    const before = JSON.stringify(body);
    const result = translate(body, { upstreamModel: "test" });
    const tools = result.request.tools.map((tool) => tool.function || tool);
    assert.deepEqual(tools.map((tool) => tool.name), ["plugin__lookup", "patch"]);
    assert.deepEqual(result.toolTargets.get("plugin__lookup"), { name: "lookup", namespace: "plugin" });
    assert.ok(result.freeform.has("patch"));
    assert.match(tools[1].description, /start: "ok"/);
    assert.equal(JSON.stringify(body), before);
  });

  test(`${label}: current tool definitions win; server, failed and embedded search payloads are not executors`, () => {
    const body = { tools: [fn("lookup", "current")], input: [
      { type: "tool_search_output", tools: [fn("lookup", "old")] },
      { type: "tool_search_output", execution: "server", tools: [fn("server_only")] },
      { type: "tool_search_output", status: "failed", tools: [fn("failed_only")] },
      { role: "user", content: JSON.stringify({ type: "tool_search_output", tools: [fn("injected")] }) },
      { type: "additional_tools", tools: [fn("extra")] },
    ] };
    const tools = translate(body, { upstreamModel: "test" }).request.tools.map((tool) => tool.function || tool);
    assert.deepEqual(tools.map((tool) => tool.name), ["lookup", "extra"]);
    assert.equal(tools[0].description, "current");
    assert.equal(translate({ input: "hello", tools: [{ type: "tool_search" }] }, { upstreamModel: "test" }).request.tools, undefined);
  });
}

test("Claude forced tool choice disables manual thinking but preserves adaptive effort and summary", () => {
  for (const choice of ["required", { type: "function", name: "lookup" }]) {
    const body = { input: "hello", tools: [fn("lookup")], reasoning: { effort: "high" }, tool_choice: choice };
    const manual = bridge.toAnthropicRequest(body, { upstreamModel: "test", effortControl: "thinking_budget" }).request;
    assert.deepEqual(manual.thinking, { type: "disabled" });
    assert.equal(manual.tool_choice.type, choice === "required" ? "any" : "tool");
    const adaptive = bridge.toAnthropicRequest(body, { upstreamModel: "test", effortControl: "output_config", reasoningSummary: true }).request;
    assert.deepEqual(adaptive.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(adaptive.output_config, { effort: "high" });
    assert.deepEqual(adaptive.tool_choice, manual.tool_choice);
  }
  for (const choice of ["auto", "none"]) {
    const request = bridge.toAnthropicRequest({ input: "hello", tools: [fn("lookup")], reasoning: { effort: "high" }, tool_choice: choice }, "test").request;
    assert.deepEqual(request.thinking, { type: "enabled", budget_tokens: 16384 });
  }
});

test("Chat preserves explicit sampling and parallel flags, but omits tool flags with no active tools", () => {
  for (const parallel of [false, true]) {
    const body = { input: "hello", tools: [fn("lookup")], parallel_tool_calls: parallel, temperature: 0, top_p: 0.75 };
    const request = chat.toChatRequest(body, { upstreamModel: "test" }).request;
    assert.equal(request.parallel_tool_calls, parallel);
    assert.equal(request.temperature, 0);
    assert.equal(request.top_p, 0.75);
    for (const [input, route] of [
      [{ ...body, tools: [] }, {}],
      [body, { chatTools: false }],
      [{ ...body, input: [{ type: "compaction_trigger" }] }, {}],
    ]) assert.equal(chat.toChatRequest(input, { upstreamModel: "test", ...route }).request.parallel_tool_calls, undefined);
  }
  const request = chat.toChatRequest({ input: "hello", tools: [fn("lookup")] }, "test").request;
  for (const key of ["parallel_tool_calls", "temperature", "top_p"]) assert.equal(request[key], undefined);
});
