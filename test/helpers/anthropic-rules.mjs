// 以 Anthropic Messages API 的工具配對規則檢查轉譯後的 messages。
// 違反任何一條，上游都會整輪 400，而且同一段歷史每次重送都會再失敗：
//   1. tool_result 只能回應上一則 assistant 訊息裡的 tool_use，而且每個 tool_use 恰好一個
//      （each tool_use must have a single result）；
//   2. user 訊息裡的 tool_result 必須排在其他區塊前面
//      （tool_use ids were found without tool_result blocks immediately after）。

import assert from "node:assert/strict";

export function assertAnthropicToolPairing(messages) {
  messages.forEach((message, index) => {
    if (message.role === "assistant") {
      const ids = message.content.filter((block) => block.type === "tool_use").map((block) => block.id);
      assert.equal(new Set(ids).size, ids.length, `messages.${index}: tool_use id 重複`);
      if (ids.length) assert.equal(messages[index + 1]?.role, "user", `messages.${index}: tool_use 後面沒有 user 訊息`);
      return;
    }
    const blocks = message.content;
    const firstOther = blocks.findIndex((block) => block.type !== "tool_result");
    if (firstOther >= 0) {
      assert.ok(
        !blocks.slice(firstOther).some((block) => block.type === "tool_result"),
        `messages.${index}: tool_result 必須排在其他區塊前面`,
      );
    }
    const previous = messages[index - 1];
    const expected = previous?.role === "assistant"
      ? previous.content.filter((block) => block.type === "tool_use").map((block) => block.id)
      : [];
    const results = blocks.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id);
    assert.equal(new Set(results).size, results.length, `messages.${index}: 同一個 tool_use 有多個 tool_result`);
    assert.deepEqual([...results].sort(), [...expected].sort(), `messages.${index}: tool_result 與上一則的 tool_use 不相符`);
  });
}
