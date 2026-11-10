import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { router } = await loadPayloads();
const headers = { authorization: "Bearer fixture", "chatgpt-account-id": "fixture", "session-id": "missing-call" };
const call = { type: "function_call", id: "fc_lookup", call_id: "call_lookup", name: "lookup", arguments: "{}" };
const output = (extra = {}) => ({ type: "function_call_output", output: "result", ...extra });
const route = { pickerSlug: "custom/gpt-test", upstreamModel: "ark/gpt-test", efforts: ["high"] };

test("unpaired forwarded output becomes a message, preserving text, images, files and JSON", () => {
  const parts = ["forwarded message", { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
    { type: "input_file", file_id: "file_fixture" }, { type: "output_text", text: "detail" }, { nested: { value: 123 } }];
  const body = { input: [output({ name: "send_message_to_thread", output: parts })] };
  const original = structuredClone(body);
  const fixed = router.normalizeHttpToolOutputs(body);
  assert.deepEqual(fixed.input, [{ type: "message", role: "user", content: [
    { type: "input_text", text: parts[0] }, parts[1], parts[2],
    { type: "input_text", text: "detail" }, { type: "input_text", text: JSON.stringify(parts[4]) },
  ] }]);
  assert.deepEqual(body, original);
  assert.strictEqual(router.normalizeHttpToolOutputs(fixed), fixed);
});

test("only explicit item identity repairs a result; valid call IDs are unchanged", () => {
  for (const type of ["function", "custom_tool"]) {
    const tool = { ...call, type: `${type}_call` };
    for (const id of [tool.id, tool.call_id]) {
      const body = { input: [tool, output({ type: `${type}_call_output`, id })] };
      const fixed = router.normalizeHttpToolOutputs(body);
      assert.equal(fixed.input[1].call_id, tool.call_id);
      assert.equal(fixed.input[1].id, undefined);
      assert.equal(body.input[1].call_id, undefined);
    }
  }
  const valid = { input: [call, output({ call_id: call.call_id }), output({ call_id: call.call_id, output: "late notification" })] };
  assert.strictEqual(router.normalizeHttpToolOutputs(valid), valid);
});

test("anonymous results cannot be assigned by position, name or a fabricated ID", () => {
  for (const calls of [[call], [call, { ...call, id: "fc_other", call_id: "call_other" }]]) {
    for (const extra of [{}, { name: "lookup" }, { id: "unknown" }, { call_id: " " }]) {
      assert.throws(() => router.normalizeHttpToolOutputs({ input: [...calls, output(extra)] }), {
        status: 422, code: "tool_output_call_id_missing",
      });
    }
  }
  assert.throws(() => router.normalizeHttpToolOutputs({ input: [call,
    { ...call, call_id: "call_duplicate" }, output({ id: call.id })] }), { code: "tool_output_call_id_missing" });
});

test("cross-task messages cannot consume an outstanding call, and empty output is retained", () => {
  const fixed = router.normalizeHttpToolOutputs({ input: [call,
    output({ name: "send_message_to_thread", output: "other task" }),
    output({ call_id: call.call_id }), output({ output: [] }),
    output({ type: "custom_tool_call_output", call_id: null, output: "unpaired" })] });
  assert.equal(fixed.input[1].type, "message");
  assert.equal(fixed.input[2].call_id, call.call_id);
  assert.equal(fixed.input[3].content[0].text, "(no output)");
  assert.equal(fixed.input[4].content[0].text, "unpaired");
});

for (const model of ["official-test", route.pickerSlug]) {
  test(`${model}: WebSocket to HTTP continuation, retries and compaction preserve the repaired history`, async (t) => {
    const instance = await loadRouterWith({ routes: [route], upstreamWebSocket: false });
    instance.markAuthValidated(headers);
    const previousKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-key";
    t.after(() => {
      if (previousKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
      else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previousKey;
    });
    const originalFetch = globalThis.fetch;
    const sent = [];
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      const body = JSON.parse(options.body);
      sent.push(body);
      assert.ok(body.input.every((item) => !["function_call_output", "custom_tool_call_output"].includes(item.type) || item.call_id));
      const event = { type: "response.completed", response: {
        id: `resp_${sent.length}`, status: "completed", output: sent.length === 1 ? [call] : [],
      } };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    instance.routerServer.listen(0, "127.0.0.1");
    await once(instance.routerServer, "listening");
    t.after(() => new Promise((resolve) => instance.routerServer.close(resolve)));
    const port = instance.routerServer.address().port;
    // Exercise the actual WebSocket adapter and its history capture, not just a helper.
    const connection = { connectionNamespace: "http-tools" };
    const turn = async (body) => {
      const chunks = [];
      const socket = { destroyed: false, writable: true,
        write(chunk) { chunks.push(Buffer.from(chunk)); return true; }, end() {} };
      await instance.handleWebSocketResponseInner({ headers }, socket,
        new URL(`http://127.0.0.1:${port}/v1/responses`),
        { ...body, type: "response.create" }, new AbortController(), connection);
      const events = instance.parseWebSocketFrames(Buffer.concat(chunks)).frames
        .filter((frame) => frame.opcode === 1).map((frame) => JSON.parse(frame.payload));
      assert.equal(events.at(-1).type, "response.completed");
    };
    await turn({ model, input: [{ role: "user", content: "lookup" }] });
    const next = { model, previous_response_id: "resp_1", input: [
      output({ id: call.id }), output({ name: "send_message_to_thread", output: "task update" }),
    ] };
    await turn(next);
    await turn(next);
    assert.deepEqual(sent[1].input, sent[2].input);
    assert.equal(sent[1].previous_response_id, undefined);
    assert.equal(sent[1].input[2].call_id, call.call_id);
    assert.equal(sent[1].input[3].content[0].text, "task update");
    const response = await originalFetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model, input: [output({ name: "create_thread", output: "summary" })] }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(sent.at(-1).input[0].type, "message");
  });
}
