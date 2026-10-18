import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { bridge, chat } = await loadPayloads();
const { ENCRYPTED_AGENT_PAYLOAD_NOTICE, FOREIGN_COMPACTION_NOTICE, encodeCompaction } = bridge;
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

  test(`${name}: encrypted agent payload (GPT multi-agent) becomes an explicit notice instead of failing the turn`, () => {
    // 實際格式：明文標頭 + OpenAI 加密的內容。GPT 沒額度改用其他模型接手時不能整輪擋下。
    const request = translate([
      { type: "message", role: "user", content: "開始" },
      agent([
        { type: "input_text", text: "Message Type: MESSAGE\nTask name: /root\nSender: /root/reviewer\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: "gAAAAABSECRET" },
      ]),
      { type: "message", role: "user", content: "繼續" },
    ]);
    const encoded = JSON.stringify(request.messages);
    assert.ok(!encoded.includes("gAAAAABSECRET"), "加密內容不送往上游");
    assert.ok(encoded.includes("Sender: /root/reviewer"), "保留明文標頭");
    assert.ok(encoded.includes(JSON.stringify(ENCRYPTED_AGENT_PAYLOAD_NOTICE).slice(1, 60)), "明確標示缺少的內容");
    assert.ok(encoded.indexOf("開始") < encoded.indexOf("Encrypted payload omitted"));
    assert.ok(encoded.indexOf("Encrypted payload omitted") < encoded.indexOf("繼續"));
  });

  test(`${name}: compaction summary from another model becomes a notice; router summaries still replay`, () => {
    const foreign = JSON.stringify(translate([
      { type: "message", role: "user", content: "之前的需求" },
      { type: "compaction", encrypted_content: "gAAAAABFOREIGNSUMMARY" },
      { type: "message", role: "user", content: "接著做" },
    ]).messages);
    assert.ok(!foreign.includes("FOREIGNSUMMARY"));
    assert.ok(foreign.includes(JSON.stringify(FOREIGN_COMPACTION_NOTICE).slice(1, 60)));
    assert.ok(foreign.indexOf("之前的需求") < foreign.indexOf("compacted while another model"));
    const own = JSON.stringify(translate([
      { type: "compaction", encrypted_content: encodeCompaction("自己的摘要") },
      { type: "message", role: "user", content: "接著做" },
    ]).messages);
    assert.ok(own.includes("自己的摘要"));
    assert.ok(!own.includes("compacted while another model"));
  });

  test(`${name}: malformed agent messages fail without leaking payload`, () => {
    for (const item of [
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
