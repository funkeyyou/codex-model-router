// Responses namespace 工具與 Anthropic 單層工具之間的雙向轉譯。
//
// Anthropic 端用 `<namespace>__<name>` 當唯一別名；Codex 端的正確格式則是
// `{ name, namespace }` 兩個獨立欄位。只做前半段會讓 Codex 把整串別名當成工具名，
// 回 `unsupported call`。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { bridge } = await loadPayloads();
const { toAnthropicRequest, bridgeAnthropicStream } = bridge;

const userMessage = (text) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

const fn = (name) => ({
  type: "function",
  name,
  description: "",
  parameters: { type: "object", properties: {} },
});

const custom = (name) => ({ type: "custom", name, description: "" });
const namespace = (name, tools) => ({ type: "namespace", name, tools });

const translate = (tools, extraInput = []) =>
  toAnthropicRequest(
    {
      input: [
        { type: "additional_tools", role: "developer", tools },
        userMessage("hi"),
        ...extraInput,
      ],
    },
    { upstreamModel: "claude-x" },
  );

const namesOf = (request) => request.tools.map((tool) => tool.name);

const sse = (events) => {
  const body = events.map((event) =>
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
};

async function runToolStream(alias, json, context) {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "call_1", name: alias, input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: json },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  const output = [];
  await bridgeAnthropicStream(sse(events), (event) => output.push(event), {
    model: "custom/x",
    requestBody: {},
    compaction: false,
    ...context,
  });
  return output;
}

test("Anthropic 端使用唯一別名，並保留回到 Codex 所需的 target", () => {
  const { request, toolTargets } = translate([
    namespace("functions", [custom("exec"), fn("wait")]),
    namespace("mcp__cua_repl", [fn("js"), fn("js_reset")]),
  ]);
  assert.deepEqual(namesOf(request), [
    "exec",
    "wait",
    "mcp__cua_repl__js",
    "mcp__cua_repl__js_reset",
  ]);
  assert.deepEqual(toolTargets.get("exec"), { name: "exec" });
  assert.deepEqual(toolTargets.get("mcp__cua_repl__js"), {
    name: "js",
    namespace: "mcp__cua_repl",
  });
});

test("不同 namespace 裡的同名工具不會撞名", () => {
  const { request, toolTargets } = translate([
    namespace("alpha", [fn("js")]),
    namespace("beta", [fn("js")]),
  ]);
  assert.deepEqual(namesOf(request), ["alpha__js", "beta__js"]);
  assert.deepEqual(toolTargets.get("alpha__js"), { name: "js", namespace: "alpha" });
  assert.deepEqual(toolTargets.get("beta__js"), { name: "js", namespace: "beta" });
});

test("function tool 回到 Codex 時拆成 name 與 namespace", async () => {
  const translated = translate([namespace("mcp__cua_repl", [fn("js")])]);
  const output = await runToolStream(
    "mcp__cua_repl__js",
    '{"code":"await cua.getState();"}',
    translated,
  );
  const items = output
    .filter((event) => event.type === "response.output_item.added" ||
      event.type === "response.output_item.done")
    .map((event) => event.item)
    .filter((item) => item.type === "function_call");
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.equal(item.name, "js");
    assert.equal(item.namespace, "mcp__cua_repl");
  }
  assert.deepEqual(JSON.parse(items.at(-1).arguments), {
    code: "await cua.getState();",
  });
  const completed = output.find((event) => event.type === "response.completed");
  const finalItem = completed.response.output.find((item) => item.type === "function_call");
  assert.equal(finalItem.name, "js");
  assert.equal(finalItem.namespace, "mcp__cua_repl");
});

test("custom tool 同樣拆回 name 與 namespace，且保留自由格式內容", async () => {
  const translated = translate([namespace("external", [custom("run")])]);
  const output = await runToolStream(
    "external__run",
    '{"input":"raw payload"}',
    translated,
  );
  const item = output
    .filter((event) => event.type === "response.output_item.done")
    .map((event) => event.item)
    .find((candidate) => candidate.type === "custom_tool_call");
  assert.equal(item.name, "run");
  assert.equal(item.namespace, "external");
  assert.equal(item.input, "raw payload");
});

test("functions 命名空間回到 Codex 時仍是裸名", async () => {
  const translated = translate([namespace("functions", [fn("wait")])]);
  const output = await runToolStream("wait", "{}", translated);
  const item = output
    .filter((event) => event.type === "response.output_item.done")
    .map((event) => event.item)
    .find((candidate) => candidate.type === "function_call");
  assert.equal(item.name, "wait");
  assert.equal(Object.hasOwn(item, "namespace"), false);
});

test("帶 namespace 的歷史工具呼叫送回 Anthropic 時恢復成同一別名", () => {
  const { request } = translate(
    [namespace("mcp__cua_repl", [fn("js")])],
    [
      {
        type: "function_call",
        call_id: "call_old",
        name: "js",
        namespace: "mcp__cua_repl",
        arguments: '{"code":"1+1"}',
      },
      { type: "function_call_output", call_id: "call_old", output: "2" },
    ],
  );
  const toolUse = request.messages
    .flatMap((message) => message.content)
    .find((block) => block.type === "tool_use");
  assert.equal(toolUse.name, "mcp__cua_repl__js");
  assert.deepEqual(toolUse.input, { code: "1+1" });
});

test("namespace 底下的 freeform 工具以 Anthropic 別名登記", () => {
  const { request, freeform } = translate([namespace("ns", [custom("run")])]);
  assert.deepEqual(namesOf(request), ["ns__run"]);
  assert.ok(freeform.has("ns__run"), "回程要靠 Anthropic 別名判定 custom_tool_call");
  assert.ok(!freeform.has("run"), "Codex 裸名不該出現在 Anthropic freeform 集合");
});

test("沒有 namespace 包裝的工具維持原名", () => {
  const { request, toolTargets } = translate([fn("plain"), custom("raw")]);
  assert.deepEqual(namesOf(request), ["plain", "raw"]);
  assert.deepEqual(toolTargets.get("plain"), { name: "plain" });
});

test("攤平不會就地改到 Codex 傳進來的原始工具物件", () => {
  const original = fn("js");
  translate([namespace("mcp__cua_repl", [original])]);
  assert.equal(original.name, "js");
});
