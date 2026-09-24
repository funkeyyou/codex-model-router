// Claude 的歷史推理須能在 Codex 裡以短索引保存、在新路由行程中完整還原。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPayloads } from "./helpers/payloads.mjs";

const { bridge, router, dir } = await loadPayloads();
const user = { type: "message", role: "user", content: [{ type: "input_text", text: "繼續" }] };
const requestWith = (encrypted_content, module = bridge) =>
  module.toAnthropicRequest({ input: [
    user,
    { type: "reasoning", encrypted_content },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "完成" }] },
  ] }, "claude-x").request;

test("長推理以短索引保存，重載 bridge 後仍能還原原文和簽章", async () => {
  const thinking = "這是需要保留的 Claude 推理。".repeat(5000);
  const signature = "sig-test-123";
  const encoded = bridge.encodeReasoning(thinking, signature);
  assert.ok(encoded.length < 200, `索引過長：${encoded.length}`);
  const ref = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.equal(ref.router_reasoning_ref, 1);
  assert.match(ref.sha256, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(join(dir, "reasoning-store", ref.sha256 + ".json.gz")), true);

  // 模擬服務重啟：以新的模組實例從檔案還原，而非靠原模組的記憶體。
  const reloaded = await import(pathToFileURL(join(dir, "bridge.mjs")).href + "?reloaded=1");
  const request = requestWith(encoded, reloaded);
  assert.deepEqual(request.messages.at(-1).content[0],
    { type: "thinking", thinking, signature });
  assert.equal(router.stripBridgeReasoning([{ type: "reasoning", encrypted_content: encoded }]).removed, 1);
});

test("舊版內嵌完整推理的歷史仍可還原並在切換 GPT 時剝除", () => {
  const encoded = Buffer.from(JSON.stringify({ thinking: "舊推理", signature: "old-sig" }), "utf8").toString("base64");
  const request = requestWith(encoded);
  assert.deepEqual(request.messages.at(-1).content[0],
    { type: "thinking", thinking: "舊推理", signature: "old-sig" });
  assert.equal(router.stripBridgeReasoning([{ type: "reasoning", encrypted_content: encoded }]).removed, 1);
});

test("索引指向的檔案遺失時明確回報，不能悄悄丟掉簽章", () => {
  const encoded = Buffer.from(JSON.stringify({
    router_reasoning_ref: 1, sha256: "0".repeat(64),
  }), "utf8").toString("base64");
  assert.throws(() => requestWith(encoded), /歷史推理檔案遺失或損壞/);
});

test("無效索引格式不會被當成舊版 thinking 送往上游", () => {
  const encoded = Buffer.from(JSON.stringify({
    thinking: "", signature: "r", router_reasoning_ref: 1, sha256: "../bad",
  }), "utf8").toString("base64");
  assert.throws(() => requestWith(encoded), /歷史推理索引格式無效/);
});
