// Codex Responses -> Anthropic Messages 的請求轉譯。
// 這一層每一條規則都是踩過坑才寫下的，回歸測試盯的就是那些坑。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { bridge } = await loadPayloads();
const { toAnthropicRequest, encodeReasoning, encodeCompaction, decodeCompaction,
        COMPACTION_REPLAY_PREFIX } = bridge;

const userMessage = (text) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

const build = (input, extra = {}, route = { upstreamModel: "claude-x" }) =>
  toAnthropicRequest({ input, ...extra }, route).request;

// --- max_tokens 與 thinking budget -----------------------------------------
// Anthropic 要求 max_tokens 嚴格大於 thinking.budget_tokens，否則整輪 400。

test("每個 effort 都維持 budget < max_tokens", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
    const request = build([userMessage("hi")], { reasoning: { effort } });
    assert.ok(request.thinking, `${effort} 應該啟用 thinking`);
    assert.ok(
      request.thinking.budget_tokens < request.max_tokens,
      `${effort}: budget=${request.thinking.budget_tokens} max=${request.max_tokens}`,
    );
  }
});

test("模型輸出上限會夾住 max_tokens，且 budget 跟著縮", () => {
  const request = build([userMessage("hi")], { reasoning: { effort: "max" } },
    { upstreamModel: "claude-x", maxOutputTokens: 8192 });
  assert.equal(request.max_tokens, 8192);
  assert.ok(request.thinking.budget_tokens < 8192);
});

test("輸出上限低到放不下 thinking 時，寧可不送 thinking 也不能違反不變式", () => {
  // 閘道的 maxOutputTokens 是從錯誤訊息正則抓的，可能回報極小的值。
  for (const maxOutputTokens of [4096, 2048, 1024, 512]) {
    const request = build([userMessage("hi")], { reasoning: { effort: "high" } },
      { upstreamModel: "claude-x", maxOutputTokens });
    assert.equal(request.max_tokens, maxOutputTokens);
    if (request.thinking) {
      assert.ok(
        request.thinking.budget_tokens < request.max_tokens,
        `maxOutputTokens=${maxOutputTokens}: budget=${request.thinking.budget_tokens} >= max=${request.max_tokens}`,
      );
    }
  }
});

test("沒有 effort 就不送 thinking", () => {
  assert.equal(build([userMessage("hi")]).thinking, undefined);
});

// --- 訊息結構 ---------------------------------------------------------------

test("developer / system 訊息進 system，最後一段掛 cache_control", () => {
  const request = build([
    { type: "message", role: "developer", content: [{ type: "input_text", text: "規則 A" }] },
    { type: "message", role: "system", content: [{ type: "input_text", text: "規則 B" }] },
    userMessage("hi"),
  ]);
  assert.deepEqual(request.system.map((b) => b.text), ["規則 A", "規則 B"]);
  assert.equal(request.system[0].cache_control, undefined);
  assert.deepEqual(request.system[1].cache_control, { type: "ephemeral" });
});

test("連續同 role 的區塊會合併成一則訊息", () => {
  const request = build([userMessage("一"), userMessage("二"), userMessage("三")]);
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].role, "user");
  assert.deepEqual(request.messages[0].content.map((b) => b.text), ["一", "二", "三"]);
});

test("首則訊息不是 user 時會補一個佔位 user", () => {
  const request = build([
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "先開口" }] },
    userMessage("再回"),
  ]);
  assert.equal(request.messages[0].role, "user");
  assert.equal(request.messages[1].role, "assistant");
});

test("assistant 訊息不接受圖片區塊", () => {
  const request = build([
    userMessage("看圖"),
    {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "好" },
        { image_url: "data:image/png;base64,AAAA" },
      ],
    },
  ]);
  const assistant = request.messages.find((m) => m.role === "assistant");
  assert.deepEqual(assistant.content.map((b) => b.type), ["text"]);
});

// --- 圖片 -------------------------------------------------------------------
// 整包 stringify 會讓一張截圖吃掉數十萬 token，必須轉成原生 image 區塊。

test("data URL 轉成原生 image 區塊，不落成文字", () => {
  const request = build([
    { type: "message", role: "user", content: [{ image_url: "data:image/png;base64,QUJD" }] },
  ]);
  assert.deepEqual(request.messages[0].content[0], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJD" },
  });
});

test("http(s) 圖片走 url 來源", () => {
  const request = build([
    { type: "message", role: "user", content: [{ image_url: "https://example.com/a.png" }] },
  ]);
  assert.deepEqual(request.messages[0].content[0].source,
    { type: "url", url: "https://example.com/a.png" });
});

// --- 工具 -------------------------------------------------------------------

test("function_call 與 output 以 call_id 配對成 tool_use / tool_result", () => {
  const request = build([
    userMessage("查一下"),
    { type: "function_call", call_id: "call_1", name: "grep", arguments: '{"q":"x"}' },
    { type: "function_call_output", call_id: "call_1", output: "找到 3 筆" },
  ]);
  const toolUse = request.messages.find((m) => m.role === "assistant").content[0];
  assert.deepEqual(toolUse, { type: "tool_use", id: "call_1", name: "grep", input: { q: "x" } });
  const toolResult = request.messages.at(-1).content[0];
  assert.equal(toolResult.type, "tool_result");
  assert.equal(toolResult.tool_use_id, "call_1");
  assert.deepEqual(toolResult.content, [{ type: "text", text: "找到 3 筆" }]);
});

test("壞掉的 arguments JSON 退成空物件，不整輪炸掉", () => {
  const request = build([
    userMessage("x"),
    { type: "function_call", call_id: "c", name: "t", arguments: "{不是 JSON" },
  ]);
  assert.deepEqual(request.messages.at(-1).content[0].input, {});
});

test("空的工具輸出補上佔位文字（Anthropic 不收空 content）", () => {
  const request = build([
    userMessage("x"),
    { type: "function_call", call_id: "c", name: "t", arguments: "{}" },
    { type: "function_call_output", call_id: "c", output: "" },
  ]);
  assert.deepEqual(request.messages.at(-1).content[0].content, [{ type: "text", text: "(no output)" }]);
});

test("custom（自由格式）工具模擬成單一 string 參數", () => {
  const request = build([
    { type: "additional_tools", tools: [{ type: "custom", name: "shell", description: "run" }] },
    userMessage("x"),
  ]);
  assert.deepEqual(request.tools[0].input_schema, {
    type: "object",
    properties: {
      input: { type: "string", description: "The raw payload for this tool, passed through verbatim." },
    },
    required: ["input"],
  });
});

test("namespace 巢狀工具會攤平", () => {
  const request = build([
    {
      type: "additional_tools",
      tools: [{
        type: "namespace",
        tools: [
          { type: "function", name: "a", parameters: { type: "object", properties: {} } },
          { type: "function", name: "b", parameters: { type: "object", properties: {} } },
        ],
      }],
    },
    userMessage("x"),
  ]);
  assert.deepEqual(request.tools.map((t) => t.name), ["a", "b"]);
});

test("tool_choice 對應：required -> any、none -> 不送 tools", () => {
  const tools = [{ type: "additional_tools", tools: [{ type: "function", name: "a", parameters: {} }] }];
  assert.deepEqual(build([...tools, userMessage("x")], { tool_choice: "required" }).tool_choice, { type: "any" });
  assert.deepEqual(build([...tools, userMessage("x")], { tool_choice: "auto" }).tool_choice, { type: "auto" });
  assert.equal(build([...tools, userMessage("x")], { tool_choice: "none" }).tools, undefined);
});

// --- input_schema 的頂層組合關鍵字 -------------------------------------------
// Anthropic 明確拒絕頂層的 oneOf / allOf / anyOf。

test("頂層 anyOf 攤平：properties 取聯集、required 取交集", () => {
  const request = build([
    {
      type: "additional_tools",
      tools: [{
        type: "function",
        name: "t",
        parameters: {
          anyOf: [
            { type: "object", properties: { a: { type: "string" }, c: { type: "string" } }, required: ["a", "c"] },
            { type: "object", properties: { b: { type: "string" }, c: { type: "string" } }, required: ["b", "c"] },
          ],
        },
      }],
    },
    userMessage("x"),
  ]);
  const schema = request.tools[0].input_schema;
  assert.equal(schema.anyOf, undefined);
  assert.equal(schema.type, "object");
  assert.deepEqual(Object.keys(schema.properties).sort(), ["a", "b", "c"]);
  assert.deepEqual(schema.required, ["c"]);
});

test("頂層 allOf 攤平：required 取聯集", () => {
  const request = build([
    {
      type: "additional_tools",
      tools: [{
        type: "function",
        name: "t",
        parameters: {
          allOf: [
            { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
            { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
          ],
        },
      }],
    },
    userMessage("x"),
  ]);
  const schema = request.tools[0].input_schema;
  assert.equal(schema.allOf, undefined);
  assert.deepEqual(schema.required.sort(), ["a", "b"]);
});

test("非物件 schema 包裝成 object（Anthropic 只收物件）", () => {
  const request = build([
    { type: "additional_tools", tools: [{ type: "function", name: "t", parameters: { type: "string" } }] },
    userMessage("x"),
  ]);
  assert.equal(request.tools[0].input_schema.type, "object");
  assert.deepEqual(request.tools[0].input_schema.required, ["value"]);
});

// --- reasoning 與 compaction 的往返 -----------------------------------------

test("reasoning 的 encrypted_content 還原成 thinking 區塊", () => {
  // 結尾不能是 thinking，所以補一則 assistant 輸出讓形狀合法。
  const request = build([
    userMessage("x"),
    { type: "reasoning", encrypted_content: encodeReasoning("想一下", "sig-1") },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "答案" }] },
  ]);
  assert.deepEqual(request.messages.at(-1).content[0],
    { type: "thinking", thinking: "想一下", signature: "sig-1" });
});

test("認不得的 reasoning 內容直接略過，不噴例外", () => {
  const request = build([userMessage("x"), { type: "reasoning", encrypted_content: "not-base64-json" }]);
  assert.equal(request.messages.length, 1);
});

test("encodeCompaction / decodeCompaction 可往返", () => {
  assert.equal(decodeCompaction(encodeCompaction("摘要內容")), "摘要內容");
  assert.equal(decodeCompaction("垃圾"), null);
  assert.equal(decodeCompaction(""), null);
  assert.equal(decodeCompaction(undefined), null);
});

test("既有 compaction 項目還原成帶前綴的 user 文字", () => {
  const request = build([
    { type: "compaction", encrypted_content: encodeCompaction("之前做到一半") },
    userMessage("繼續"),
  ]);
  assert.equal(request.messages[0].content[0].text,
    `${COMPACTION_REPLAY_PREFIX}之前做到一半`);
});

test("壓縮回合會補提示詞，且不帶工具（帶了模型會改去呼叫工具）", () => {
  const result = toAnthropicRequest({
    input: [
      { type: "additional_tools", tools: [{ type: "function", name: "a", parameters: {} }] },
      userMessage("一堆歷史"),
      { type: "compaction_trigger" },
    ],
  }, { upstreamModel: "claude-x" });
  assert.equal(result.compaction, true);
  assert.equal(result.request.tools, undefined);
  assert.match(result.request.messages.at(-1).content.at(-1).text, /COMPACTION/);
});

// --- 其他 -------------------------------------------------------------------

test("input 是純字串時也能轉", () => {
  const request = build("直接一句話");
  assert.deepEqual(request.messages[0].content, [{ type: "text", text: "直接一句話" }]);
});

test("route 傳字串時只當模型名用", () => {
  const request = toAnthropicRequest({ input: "x" }, "claude-y").request;
  assert.equal(request.model, "claude-y");
});

test("一律要求串流", () => {
  assert.equal(build([userMessage("x")]).stream, true);
});
