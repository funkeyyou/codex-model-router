import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { router } = await loadPayloads();
const headers = { authorization: "Bearer fixture", "chatgpt-account-id": "fixture", "session-id": "missing-call" };
const call = { type: "function_call", id: "fc_lookup", call_id: "call_lookup", name: "lookup", arguments: "{}" };
const output = (extra = {}) => ({ type: "function_call_output", output: "result", ...extra });
const route = { pickerSlug: "custom/gpt-test", upstreamModel: "ark/gpt-test", efforts: ["high"] };
const delegation = (text = "task update", extra = {}) => output({ name: "create_thread", namespace: "codex_app",
  output: `<codex_delegation>\n<source_thread_id>source-fixture</source_thread_id>\n<input>${text}</input>\n</codex_delegation>`, ...extra });

test("recognized delegation preserves the entire envelope, input order and caller data", () => {
  for (const namespace of ["codex_app", "codex_tui"]) for (const name of ["create_thread", "send_message_to_thread"]) {
  const item = delegation("first line\nsecond line & code <div>", { namespace, name });
  const before = { role: "user", content: "before" };
  const after = { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] };
  const body = { input: [before, item, after] };
  const original = structuredClone(body);
  const fixed = router.normalizeHttpToolOutputs(body);
  assert.deepEqual(fixed.input, [before, { type: "message", role: "user", content: [
    { type: "input_text", text: item.output },
  ] }, after]);
  assert.deepEqual(body, original);
  assert.strictEqual(router.normalizeHttpToolOutputs(fixed), fixed);
  }
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

test("unknown or malformed outputs remain errors even without pending tools", () => {
  const valid = delegation();
  for (const item of [output(), output({ output: [] }),
    { ...valid, type: "custom_tool_call_output" }, { ...valid, namespace: "unknown" },
    { ...valid, name: "lookup" }, { ...valid, output: [valid.output] }, { ...valid, call_id: 123 },
    { ...valid, output: "prefix" + valid.output }, { ...valid, output: valid.output + "suffix" },
    { ...valid, output: valid.output + valid.output }, delegation(" "),
    { ...valid, output: valid.output.replace("source-fixture", " ") },
    { ...valid, output: valid.output.replace("</input>", "") },
    delegation("x</input><input>y"), delegation("<codex_delegation>nested</codex_delegation>")]) {
    assert.throws(() => router.normalizeHttpToolOutputs({ input: [item] }), { code: "tool_output_call_id_missing" });
  }
});

test("delegation shape does not bypass real tool context or incremental continuation", () => {
  for (const calls of [[call], [call, { ...call, call_id: "call_other" }]]) {
    assert.throws(() => router.normalizeHttpToolOutputs({ input: [...calls, delegation()] }), { code: "tool_output_call_id_missing" });
  }
  assert.throws(() => router.normalizeHttpToolOutputs({ previous_response_id: "resp_1", input: [delegation()] }), { code: "tool_output_call_id_missing" });
  const valid = { input: [delegation("result", { call_id: "real_call" })] };
  assert.strictEqual(router.normalizeHttpToolOutputs(valid), valid);
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
      output({ id: call.id }), delegation(),
    ] };
    await turn(next);
    await turn(next);
    assert.deepEqual(sent[1].input, sent[2].input);
    assert.equal(sent[1].previous_response_id, undefined);
    assert.equal(sent[1].input[2].call_id, call.call_id);
    assert.equal(sent[1].input[3].content[0].text, delegation().output);
    const response = await originalFetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model, input: [delegation("summary")] }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(sent.at(-1).input[0].type, "message");
    const count = sent.length;
    const rejected = await originalFetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model, input: [output({ name: "create_thread", output: "private-invalid-content" })] }),
    });
    assert.equal(rejected.status, 422);
    const error = await rejected.json();
    assert.equal(error.error.code, "tool_output_call_id_missing");
    assert.doesNotMatch(JSON.stringify(error), /private-invalid-content/);
    assert.equal(sent.length, count);
  });
}
