import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { router } = await loadPayloads();
const legacy = () => ({
  model: "official-test",
  input: [
    { type: "custom_tool_call", id: "fc_a8acf1e3cf564fb8be20", call_id: "call_patch", name: "apply_patch", input: "patch content" },
    { type: "custom_tool_call_output", call_id: "call_patch", output: "patched" },
    { type: "function_call", id: "ctc_1234", call_id: "call_fn", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_fn", output: "found" },
    { type: "compaction_trigger" },
  ],
});

test("legacy tool item ids are optional; repair preserves call pairing and caller history", () => {
  const body = legacy();
  const original = structuredClone(body);
  const fixed = router.normalizeToolCallIds(body);
  const expected = structuredClone(body);
  delete expected.input[0].id;
  delete expected.input[2].id;
  assert.deepEqual(fixed, expected);
  assert.deepEqual(body, original);
  assert.strictEqual(router.normalizeToolCallIds(fixed), fixed);
  const valid = { input: [
    { type: "custom_tool_call", id: "ctc_abcd" },
    { type: "function_call", id: "fc_abcd" },
    { type: "message", id: "msg_abcd" },
  ] };
  assert.strictEqual(router.normalizeToolCallIds(valid), valid);
  assert.strictEqual(router.normalizeToolCallIds({ input: "text" }).input, "text");
});

test("new custom bridge ids are stripped on cross-provider replay", () => {
  const id = "ctc_AbCdEfGhIjKlMnOpQrSt";
  assert.equal(router.isBridgeMintedId(id), true);
  assert.deepEqual(router.stripBridgeItemIds([{ type: "custom_tool_call", id, call_id: "call_1" }]), {
    input: [{ type: "custom_tool_call", call_id: "call_1" }], removed: 1,
  });
  assert.equal(router.isBridgeMintedId("ctc_a8acf1e3cf564fb8be20"), false);
});

for (const path of ["/v1/responses", "/v1/responses/compact"]) {
  test(`outbound ${path} repairs the reported id before upstream validation`, async (t) => {
    const instance = await loadRouterWith({ upstreamWebSocket: false });
    const body = legacy();
    t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(new URL(url).pathname.endsWith(path.slice(3)), true);
      const sent = JSON.parse(options.body);
      assert.equal(sent.input[0].id, undefined);
      assert.equal(sent.input[0].input, "patch content");
      assert.equal(sent.input[0].call_id, sent.input[1].call_id);
      assert.equal(sent.input[2].id, undefined);
      assert.equal(sent.input[2].call_id, sent.input[3].call_id);
      return new Response(JSON.stringify({ output: [] }), { headers: { "content-type": "application/json" } });
    });
    const response = await instance.fetchModelUpstream(
      { authorization: "Bearer fixture", "chatgpt-account-id": "fixture-account", "session-id": "id-repair" },
      new URL(`http://127.0.0.1${path}`), body, Buffer.from(JSON.stringify(body)), undefined, {},
    );
    assert.equal(response.status, 200);
    assert.equal(body.input[0].id, "fc_a8acf1e3cf564fb8be20");
  });
}
