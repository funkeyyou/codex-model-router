// Responses <-> Chat Completions 轉譯。
//
// 只有 /chat/completions 的模型（DeepSeek、通義千問、GLM、Kimi、Ollama、vLLM）靠這一層
// 才能在 Codex 裡用。這裡盯的是 Chat Completions 最常把請求打回來的幾條規則：
//   - 帶 tool_calls 的 assistant 訊息後面必須緊接著每個呼叫各自的 tool 訊息；
//   - tool 訊息只能放文字；
//   - 推理只在同一輪的工具往返裡送回。
// 以及回應方向：串流片段要拼回完整的推理、文字與工具呼叫，並且一定以終止事件收尾。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { chat } = await loadPayloads();
const { toChatRequest, bridgeChatStream, CHAT_REASONING_MARKER, isChatReasoning } = chat;

const route = (extra = {}) => ({ upstreamModel: "deepseek-chat", efforts: ["low", "medium", "high"], ...extra });
const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistantText = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const call = (id, name = "lookup", args = { q: 1 }) => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
const output = (id, value = "result") => ({ type: "function_call_output", call_id: id, output: value });
const reasoning = (text) => ({ type: "reasoning", summary: [{ type: "summary_text", text }], encrypted_content: CHAT_REASONING_MARKER });
const fn = (name) => ({ type: "function", name, description: `${name} tool`, parameters: { type: "object", properties: { q: { type: "number" } } } });
const translate = (body, options) => toChatRequest(body, route(options)).request;

// --- 請求方向 ---------------------------------------------------------------

test("instructions 與 developer 訊息合成一則最前面的 system；純文字的 user 訊息送字串", () => {
  const request = translate({
    instructions: "base rules",
    input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "dev rule" }] }, user("hello")],
  });
  assert.deepEqual(request.messages, [
    { role: "system", content: "base rules\n\ndev rule" },
    { role: "user", content: "hello" },
  ]);
  assert.equal(request.model, "deepseek-chat");
  assert.equal(request.stream, true);
  assert.deepEqual(request.stream_options, { include_usage: true });
});

test("圖片轉成 image_url parts；檔案附件明確拒絕，不默默丟掉", () => {
  const request = translate({ input: [{ type: "message", role: "user", content: [
    { type: "input_text", text: "看這張" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" },
  ] }] });
  assert.deepEqual(request.messages[0].content, [
    { type: "text", text: "看這張" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ]);
  assert.throws(() => translate({ input: [{ type: "message", role: "user", content: [
    { type: "input_file", file_data: "data:application/pdf;base64,AAAA" },
  ] }] }), /檔案附件/);
});

test("文字與工具呼叫合成一則 assistant 訊息，後面緊接著各自的 tool 訊息", () => {
  const request = translate({ tools: [fn("lookup")], input: [
    user("查"), assistantText("我來查"), call("call_1"), call("call_2", "lookup", { q: 2 }),
    output("call_1", "一"), output("call_2", "二"), assistantText("好了"),
  ] });
  assert.deepEqual(request.messages, [
    { role: "user", content: "查" },
    { role: "assistant", content: "我來查", tool_calls: [
      { id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":1}" } },
      { id: "call_2", type: "function", function: { name: "lookup", arguments: "{\"q\":2}" } },
    ] },
    { role: "tool", tool_call_id: "call_1", content: "一" },
    { role: "tool", tool_call_id: "call_2", content: "二" },
    { role: "assistant", content: "好了" },
  ]);
  assert.deepEqual(request.tools, [{ type: "function", function: {
    name: "lookup", description: "lookup tool", parameters: { type: "object", properties: { q: { type: "number" } } },
  } }]);
});

test("沒有結果的呼叫補佔位結果；同一呼叫的後續輸出併回原結果；太晚的輸出改成使用者文字", () => {
  const { request, placeholderToolResults, toolOutputsMerged, lateToolOutputs } = toChatRequest({ input: [
    user("開始"), call("call_1"), call("call_2"), output("call_1", "第一筆"), output("call_1", "通知"),
    user("中斷之後"), output("call_2", "遲到的結果"),
  ] }, route());
  const roles = request.messages.map((message) => message.role);
  assert.deepEqual(roles, ["user", "assistant", "tool", "tool", "user"]);
  assert.equal(request.messages[2].content, "第一筆\n通知");
  assert.equal(request.messages[3].content, "(no output)");
  assert.match(request.messages[4].content, /中斷之後/);
  assert.match(request.messages[4].content, /call_2/);
  assert.match(request.messages[4].content, /遲到的結果/);
  assert.equal(placeholderToolResults, 1);
  assert.equal(toolOutputsMerged, 1);
  assert.equal(lateToolOutputs, 1);
});

test("工具結果裡的圖片等這一組 tool 訊息結束後，才以 user 訊息附上", () => {
  const image = { type: "input_image", image_url: "data:image/png;base64,BBBB" };
  const request = translate({ input: [
    user("截圖"), call("call_1"), call("call_2"),
    output("call_1", [{ type: "input_text", text: "截好了" }, image]), output("call_2", "ok"),
  ] });
  assert.deepEqual(request.messages.map((message) => message.role), ["user", "assistant", "tool", "tool", "user"]);
  assert.equal(request.messages[2].content, "截好了");
  assert.deepEqual(request.messages[4].content, [
    { type: "text", text: "(工具呼叫 call_1 回傳的圖片)" },
    { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
  ]);
});

test("推理只在這一輪（最後一則使用者訊息之後）的工具往返裡送回", () => {
  const request = translate({ input: [
    user("第一題"), reasoning("舊的推理"), assistantText("答一"),
    user("第二題"), reasoning("新的推理"), call("call_1"), output("call_1"),
  ] });
  const assistants = request.messages.filter((message) => message.role === "assistant");
  assert.equal(assistants[0].reasoning_content, undefined);
  assert.equal(assistants[1].reasoning_content, "新的推理");
  // 官方加密推理與 Claude 的簽章在這裡用不上，不能混進訊息。
  const other = translate({ input: [user("q"), { type: "reasoning", summary: [], encrypted_content: "gAAAAB" }, assistantText("a")] });
  assert.equal(other.messages.find((message) => message.role === "assistant").reasoning_content, undefined);
  assert.equal(isChatReasoning(reasoning("x")), true);
  assert.equal(isChatReasoning({ type: "reasoning", encrypted_content: "gAAAAB" }), false);
});

test("namespace 工具攤平、自由格式工具改成單一字串參數，歷史呼叫用同一套名稱", () => {
  const { request, freeform, toolTargets } = toChatRequest({
    tools: [
      { type: "namespace", name: "mcp__docs", tools: [fn("search")] },
      { type: "custom", name: "apply_patch", description: "patch" },
    ],
    input: [
      user("改"),
      { type: "custom_tool_call", call_id: "call_p", name: "apply_patch", input: "*** Begin Patch" },
      { type: "custom_tool_call_output", call_id: "call_p", output: "done" },
      { type: "function_call", call_id: "call_s", namespace: "mcp__docs", name: "search", arguments: "{}" },
      output("call_s"),
    ],
  }, route());
  const names = request.tools.map((tool) => tool.function.name);
  assert.deepEqual(names, ["mcp__docs__search", "apply_patch"]);
  assert.deepEqual(request.tools[1].function.parameters.required, ["input"]);
  assert.equal(freeform.has("apply_patch"), true);
  assert.deepEqual(toolTargets.get("mcp__docs__search"), { name: "search", namespace: "mcp__docs" });
  const calls = request.messages.filter((message) => message.tool_calls).flatMap((message) => message.tool_calls);
  assert.deepEqual(calls.map((item) => [item.function.name, item.function.arguments]), [
    ["apply_patch", JSON.stringify({ input: "*** Begin Patch" })],
    ["mcp__docs__search", "{}"],
  ]);
});

test("壓縮回合不送 tools，補上壓縮提示詞；歷史裡的工具呼叫照樣保留", () => {
  const { request, compaction } = toChatRequest({ tools: [fn("lookup")], input: [
    user("做事"), call("call_1"), output("call_1"), { type: "compaction_trigger" },
  ] }, route());
  assert.equal(compaction, true);
  assert.equal(request.tools, undefined);
  assert.equal(request.tool_choice, undefined);
  assert.match(request.messages.at(-1).content, /CONTEXT CHECKPOINT COMPACTION/);
  assert.ok(request.messages.some((message) => message.role === "tool"));
});

test("tool_choice、推理強度、輸出上限與 JSON schema 都對到 Chat Completions 的欄位", () => {
  const base = { tools: [fn("lookup")], input: [user("q")] };
  assert.equal(translate({ ...base, tool_choice: "required" }).tool_choice, "required");
  assert.equal(translate({ ...base, tool_choice: "none" }).tool_choice, "none");
  assert.deepEqual(translate({ ...base, tool_choice: { type: "function", name: "lookup" } }).tool_choice,
    { type: "function", function: { name: "lookup" } });
  assert.throws(() => translate({ ...base, tool_choice: { type: "function", name: "missing" } }), /不在這次可用工具清單內/);
  assert.equal(translate({ ...base, reasoning: { effort: "xhigh" } }).reasoning_effort, "high");
  assert.equal(translate({ ...base, reasoning: { effort: "low" } }, { efforts: [] }).reasoning_effort, undefined);
  assert.equal(translate({ ...base, max_output_tokens: 777 }).max_tokens, 777);
  assert.deepEqual(translate({ ...base, text: { format: { type: "json_schema", name: "out", schema: { type: "object" }, strict: true } } }).response_format,
    { type: "json_schema", json_schema: { name: "out", schema: { type: "object" }, strict: true } });
  assert.equal(translate(base, { chatStreamOptions: false }).stream_options, undefined);
});

test("上游不支援工具時：不送 tools，歷史裡的呼叫與結果改成文字，並說明無法執行工具", () => {
  const request = translate({ tools: [fn("lookup")], input: [user("查"), call("call_1"), output("call_1", "結果")] },
    { chatTools: false });
  assert.equal(request.tools, undefined);
  assert.match(request.messages[0].content, /不支援工具呼叫/);
  assert.ok(!request.messages.some((message) => message.tool_calls || message.role === "tool"));
  assert.match(request.messages.find((message) => message.role === "assistant").content, /呼叫工具 lookup/);
  assert.match(request.messages.at(-1).content, /結果/);
});

test("官方回合的平台內建工具項目轉成文字；不認得的項目明確拒絕", () => {
  const request = translate({ tools: [{ type: "web_search" }], input: [
    user("搜"), { type: "web_search_call", action: { type: "search", query: "天氣" } }, assistantText("晴"),
  ] });
  assert.match(request.messages[0].content, /web_search/);
  assert.match(request.messages.find((message) => message.role === "assistant").content, /網頁搜尋：天氣/);
  assert.throws(() => translate({ input: [user("x"), { type: "brand_new_item" }] }), /不支援的對話項目（brand_new_item）/);
});

test("第一則不是使用者訊息時補一則，部分模型的對話範本要求如此", () => {
  const request = translate({ input: [assistantText("我先說")] });
  assert.deepEqual(request.messages.map((message) => message.role), ["user", "assistant"]);
});

// --- 回應方向 ---------------------------------------------------------------

const ctx = (extra = {}) => ({ model: "custom/chat", requestBody: {}, freeform: new Set(), toolTargets: new Map(), ...extra });
const sse = (chunks, done = true) => [
  ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
  ...(done ? ["data: [DONE]\n\n"] : []),
];
const delta = (value, finish = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] });

async function run(pieces, context = ctx()) {
  const events = [];
  async function* body() { for (const piece of pieces) yield Buffer.from(piece); }
  await bridgeChatStream(body(), (event) => events.push(event), context);
  return events;
}
const terminal = (events) => events.filter((event) => /^response\.(completed|incomplete|failed)$/.test(event.type));

test("文字串流成一則訊息，用量對到 Responses 的欄位", async () => {
  const events = await run(sse([
    delta({ role: "assistant", content: "" }), delta({ content: "你" }), delta({ content: "好" }, "stop"),
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 4 } } },
  ]));
  assert.deepEqual(events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta), ["你", "好"]);
  const [done] = terminal(events);
  assert.equal(done.type, "response.completed");
  assert.equal(done.response.output[0].content[0].text, "你好");
  assert.deepEqual(done.response.usage, {
    input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 3,
    output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13,
  });
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
});

test("reasoning_content 與 reasoning 都成為推理項目，摘要就是完整推理，encrypted_content 是標記", async () => {
  for (const field of ["reasoning_content", "reasoning"]) {
    const events = await run(sse([delta({ [field]: "先想" }), delta({ [field]: "一下" }), delta({ content: "答案" }, "stop")]));
    const [done] = terminal(events);
    const [thought, message] = done.response.output;
    assert.equal(thought.type, "reasoning");
    assert.deepEqual(thought.summary, [{ type: "summary_text", text: "先想一下" }]);
    assert.equal(thought.encrypted_content, CHAT_REASONING_MARKER);
    assert.equal(message.content[0].text, "答案");
  }
});

test("內文開頭的 <think> 區塊拆成推理，標記被切在兩個片段之間也一樣", async () => {
  const events = await run(sse([delta({ content: " <thi" }), delta({ content: "nk>推理內容</th" }), delta({ content: "ink>\n\n正式回答" }, "stop")]));
  const [done] = terminal(events);
  assert.equal(done.response.output[0].summary[0].text, "推理內容");
  assert.equal(done.response.output[1].content[0].text, "正式回答");
  const plain = terminal(await run(sse([delta({ content: "<b>粗體</b>" }, "stop")])))[0];
  assert.equal(plain.response.output[0].content[0].text, "<b>粗體</b>");
});

test("工具呼叫的片段依 index 拼回；namespace 與自由格式工具還原成 Codex 的形狀", async () => {
  const context = ctx({
    freeform: new Set(["apply_patch"]),
    toolTargets: new Map([["mcp__docs__search", { name: "search", namespace: "mcp__docs" }], ["apply_patch", { name: "apply_patch" }]]),
  });
  const events = await run(sse([
    delta({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "mcp__docs__search", arguments: "{\"q\":" } }] }),
    delta({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "apply_patch", arguments: "" } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: "\"天氣\"}" } }, { index: 1, function: { arguments: "{\"input\":\"*** Begin Patch\"}" } }] }, "tool_calls"),
  ]), context);
  const [done] = terminal(events);
  assert.deepEqual(done.response.output, [
    { id: done.response.output[0].id, type: "function_call", status: "completed", call_id: "call_a", arguments: "{\"q\":\"天氣\"}", name: "search", namespace: "mcp__docs" },
    { id: done.response.output[1].id, type: "custom_tool_call", status: "completed", call_id: "call_b", input: "*** Begin Patch", name: "apply_patch" },
  ]);
  assert.equal(events.filter((event) => event.type === "response.output_item.added").length, 2);
});

test("自由格式工具直接給原始內容也接受；以 { 開頭卻不完整的參數則讓這一輪失敗", async () => {
  const context = ctx({ freeform: new Set(["apply_patch"]) });
  const raw = terminal(await run(sse([delta({ tool_calls: [{ index: 0, id: "c", function: { name: "apply_patch", arguments: "*** Begin Patch" } }] }, "tool_calls")]), context))[0];
  assert.equal(raw.response.output[0].input, "*** Begin Patch");
  const broken = terminal(await run(sse([delta({ tool_calls: [{ index: 0, id: "c", function: { name: "lookup", arguments: "{\"q\":" } }] }, "tool_calls")])))[0];
  assert.equal(broken.type, "response.failed");
  assert.equal(broken.response.error.code, "invalid_tool_arguments");
});

test("finish_reason 為 length 時回 incomplete；上游在串流中送錯誤時回 failed 並換成 Codex 的錯誤碼", async () => {
  const cut = terminal(await run(sse([delta({ content: "半" }, "length")])))[0];
  assert.equal(cut.type, "response.incomplete");
  assert.deepEqual(cut.response.incomplete_details, { reason: "max_output_tokens" });
  const failed = terminal(await run(sse([delta({ content: "開始" }), { error: { message: "This model's maximum context length is 8192 tokens." } }])))[0];
  assert.equal(failed.type, "response.failed");
  assert.equal(failed.response.error.code, "context_length_exceeded");
});

test("沒送 [DONE] 但看過 finish_reason 視為正常結束；兩者都沒有就不送終止事件，交給路由器補", async () => {
  assert.equal(terminal(await run(sse([delta({ content: "好" }, "stop")], false)))[0].type, "response.completed");
  assert.deepEqual(terminal(await run(sse([delta({ content: "被截斷" })], false))), []);
});

test("伺服器不理會 stream 直接回整個 JSON 時也能轉譯", async () => {
  const body = JSON.stringify({ choices: [{ index: 0, finish_reason: "tool_calls", message: {
    role: "assistant", content: "查一下",
    tool_calls: [{ id: "call_x", type: "function", function: { name: "lookup", arguments: "{\"q\":1}" } }],
  } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
  const [done] = terminal(await run([body]));
  assert.equal(done.type, "response.completed");
  assert.deepEqual(done.response.output.map((item) => item.type), ["message", "function_call"]);
  assert.equal(done.response.usage.total_tokens, 7);
});

test("壓縮回合只輸出一個 compaction 項目，內容是模型寫的摘要", async () => {
  const events = await run(sse([delta({ reasoning_content: "想" }), delta({ content: "摘要內容" }, "stop")]), ctx({ compaction: true }));
  const [done] = terminal(events);
  assert.equal(done.response.output.length, 1);
  assert.equal(done.response.output[0].type, "compaction");
  const decoded = JSON.parse(Buffer.from(done.response.output[0].encrypted_content, "base64").toString("utf8"));
  assert.equal(decoded.compaction, "摘要內容");
  assert.equal(events.some((event) => event.type === "response.output_text.delta"), false, "壓縮回合的內容不能外送");
});
