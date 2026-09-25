// 同一條對話先用官方 GPT、再切到 Claude。
//
// GPT 回合可能留下平台內建工具的項目（網頁搜尋、生圖、本機命令…）。它們已經完成，
// Claude 路由也沒有對應的執行器；以前一律回 422，而且每一輪都重送同一段歷史，
// 那條對話就再也無法用 Claude 繼續。現在轉成文字，本機命令則轉成配對的工具呼叫。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";
import { assertAnthropicToolPairing } from "./helpers/anthropic-rules.mjs";

const { bridge, router } = await loadPayloads();
const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistant = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const translate = (input) => bridge.toAnthropicRequest({ input }, { upstreamModel: "claude-x" }).request;
const texts = (request) => request.messages.flatMap((message) =>
  message.content.filter((block) => block.type === "text").map((block) => `${message.role}:${block.text}`));

test("網頁搜尋轉成 assistant 文字，保留查詢內容", () => {
  const request = translate([
    user("查一下天氣"),
    { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "台北 天氣" } },
    assistant("今天晴天。"),
    user("改用 Claude 繼續"),
  ]);
  assert.ok(texts(request).some((text) => text.startsWith("assistant:") && text.includes("網頁搜尋") && text.includes("台北 天氣")));
  assertAnthropicToolPairing(request.messages);
});

test("開啟網頁與頁內尋找也有描述", () => {
  const open = bridge.hostedToolSummary({ type: "web_search_call", action: { type: "open_page", url: "https://example.com" } });
  assert.match(open.text, /開啟 https:\/\/example\.com/);
  const find = bridge.hostedToolSummary({ type: "web_search_call", action: { type: "find", url: "https://example.com", pattern: "price" } });
  assert.match(find.text, /中尋找 price/);
});

test("生圖項目只留提示詞，不把整張 base64 圖塞進文字", () => {
  const request = translate([
    user("畫一隻貓"),
    { type: "image_generation_call", id: "ig_1", status: "completed", result: "iVBORw0KGgo".repeat(1000), revised_prompt: "一隻橘貓" },
    user("繼續"),
  ]);
  const joined = texts(request).join("\n");
  assert.match(joined, /生圖，提示詞：一隻橘貓/);
  assert.doesNotMatch(joined, /iVBORw0KGgo/);
});

test("本機命令轉成 tool_use，後面的輸出配成 tool_result", () => {
  const request = translate([
    user("列出檔案"),
    { type: "local_shell_call", id: "lsh_1", call_id: "call_ls", status: "completed", action: { type: "exec", command: ["ls", "-la"] } },
    { type: "function_call_output", call_id: "call_ls", output: "a.txt" },
    user("改用 Claude"),
  ]);
  assertAnthropicToolPairing(request.messages);
  const use = request.messages.flatMap((m) => m.content).find((block) => block.type === "tool_use");
  assert.deepEqual([use.id, use.name, use.input.command], ["call_ls", "local_shell", ["ls", "-la"]]);
  // 這一輪沒有提供工具，歷史卻有 tool_use：補佔位定義並禁止呼叫。
  assert.deepEqual(request.tools.map((tool) => tool.name), ["local_shell"]);
  assert.deepEqual(request.tool_choice, { type: "none" });
});

test("local_shell_call_output 以 id 指向呼叫時也能配對", () => {
  const request = translate([
    user("列出檔案"),
    { type: "local_shell_call", id: "lsh_1", call_id: "call_ls", status: "completed", action: { type: "exec", command: ["ls"] } },
    { type: "local_shell_call_output", id: "call_ls", output: "a.txt" },
  ]);
  assertAnthropicToolPairing(request.messages);
  const result = request.messages.flatMap((m) => m.content).find((block) => block.type === "tool_result");
  assert.equal(result.tool_use_id, "call_ls");
});

test("MCP 伺服器端呼叫轉成含結果摘要的文字", () => {
  const summary = bridge.hostedToolSummary({ type: "mcp_call", server_label: "docs", name: "search", output: "found 3 results" });
  assert.equal(summary.role, "assistant");
  assert.match(summary.text, /docs\/search，結果：found 3 results/);
  assert.equal(bridge.hostedToolSummary({ type: "mcp_approval_response", approve: true }).role, "user");
});

test("長內容會被截斷", () => {
  const summary = bridge.hostedToolSummary({ type: "web_search_call", action: { type: "search", query: "x".repeat(5000) } });
  assert.ok(summary.text.length < 400);
});

test("仍不認得的項目照舊拒絕，錯誤訊息帶出項目類型", () => {
  assert.throws(() => translate([user("x"), { type: "brand_new_item", payload: 1 }]), (error) => {
    const details = router.describeRouterError(error);
    assert.equal(details.status, 422);
    assert.match(details.message, /brand_new_item/);
    return true;
  });
});
