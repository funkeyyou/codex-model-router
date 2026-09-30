import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { bridge, chat } = await loadPayloads();
const agent = (content) => ({
  type: "agent_message", author: "/root/reviewer", recipient: "/root",
  content, id: "amsg_test",
});
const plaintext = agent([
  { type: "input_text", text: "檢查完成：" },
  { type: "input_text", text: "保留現有設定。\n下一步執行測試。" },
]);

for (const [name, translate] of [
  ["Claude", (input) => bridge.toAnthropicRequest({ input }, { upstreamModel: "claude-test" }).request],
  ["Chat", (input) => chat.toChatRequest({ input }, { upstreamModel: "chat-test" }).request],
]) {
  test(`${name}: inter-agent plaintext preserves provenance, block order and user role`, () => {
    const request = translate([plaintext]);
    assert.equal(request.messages[0].role, "user");
    const encoded = JSON.stringify(request.messages);
    assert.ok(encoded.includes("/root/reviewer"));
    assert.ok(encoded.includes("recipient"));
    assert.ok(encoded.includes("檢查完成：\\n保留現有設定。\\n下一步執行測試。"));
    assert.ok(!encoded.includes("amsg_test"));
  });

  test(`${name}: inter-agent message after tool result preserves pairing and chronology`, () => {
    const request = translate([
      { type: "message", role: "user", content: "開始" },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "工具完成" },
      plaintext,
      { type: "message", role: "user", content: "繼續" },
    ]);
    const encoded = JSON.stringify(request.messages);
    assert.equal(encoded.split("call_1").length - 1, 2);
    assert.ok(encoded.indexOf("工具完成") < encoded.indexOf("檢查完成"));
    assert.ok(encoded.indexOf("檢查完成") < encoded.indexOf("繼續"));
  });

  test(`${name}: encrypted and malformed agent messages fail without leaking payload`, () => {
    for (const item of [
      agent([{ type: "input_text", text: "header" }, { type: "encrypted_content", encrypted_content: "SECRET" }]),
      agent([{ type: "future_content", text: "SECRET" }]),
      agent([{ type: "input_text", text: 42 }]),
      agent("SECRET"),
      { ...plaintext, author: null },
    ]) {
      assert.throws(() => translate([item]), (error) =>
        error.name === "BridgeRequestError" && error.message.includes("agent_message") && !error.message.includes("SECRET"));
    }
  });
}
