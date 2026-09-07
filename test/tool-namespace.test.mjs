// additional_tools 的 namespace 攤平。
// Codex 認的工具真名是 `<namespace>__<tool>`；攤平時把前綴丟掉，模型就會照裸名回呼，
// Codex 端查無此工具、回 "unsupported call: <name>"。Computer Use 的 js / js_reset
// 曾經因此整組失效，這支測試盯的就是那個回歸。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { bridge } = await loadPayloads();
const { toAnthropicRequest } = bridge;

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

const translate = (tools) =>
  toAnthropicRequest(
    {
      input: [
        { type: "additional_tools", role: "developer", tools },
        userMessage("hi"),
      ],
    },
    { upstreamModel: "claude-x" },
  );

const namesOf = (request) => request.tools.map((tool) => tool.name);

test("functions 維持裸名，其他 namespace 補上 <namespace>__ 前綴", () => {
  const { request } = translate([
    namespace("functions", [custom("exec"), fn("wait"), fn("request_user_input")]),
    namespace("mcp__cua_repl", [fn("js"), fn("js_reset")]),
  ]);
  assert.deepEqual(namesOf(request), [
    "exec",
    "wait",
    "request_user_input",
    "mcp__cua_repl__js",
    "mcp__cua_repl__js_reset",
  ]);
});

test("巢狀 namespace 逐層累積前綴", () => {
  const { request } = translate([namespace("outer", [namespace("inner", [fn("leaf")])])]);
  assert.deepEqual(namesOf(request), ["outer__inner__leaf"]);
});

test("namespace 底下的 freeform 工具以完整名稱登記", () => {
  const { request, freeform } = translate([namespace("ns", [custom("run")])]);
  assert.deepEqual(namesOf(request), ["ns__run"]);
  assert.ok(freeform.has("ns__run"), "回程要靠完整名稱判定 custom_tool_call");
  assert.ok(!freeform.has("run"), "裸名不該留在 freeform 集合裡");
});

test("沒有 namespace 包裝的工具維持原名", () => {
  const { request } = translate([fn("plain"), custom("raw")]);
  assert.deepEqual(namesOf(request), ["plain", "raw"]);
});

test("攤平不會就地改到 Codex 傳進來的原始工具物件", () => {
  const original = fn("js");
  translate([namespace("mcp__cua_repl", [original])]);
  assert.equal(original.name, "js", "原始物件必須保持不變");
});
