// GPT 快速轉送不得省略重啟／匯入歷史的清理；診斷擷取關閉時也不應
// 為了會被丟棄的檔案，重複序列化整份對話。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { bridge } = await loadPayloads();
const headers = { authorization: "Bearer fixture", "chatgpt-account-id": "fixture", "session-id": "forwarding" };
const route = { pickerSlug: "custom/gpt-test", upstreamModel: "ark/gpt-test", efforts: ["high"], stripReasoning: false };
const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

for (const transport of ["HTTP", "WebSocket"]) {
  for (const capture of [false, true]) {
    test(`${transport}: GPT cold replay keeps tool pairing and bridge cleanup; capture=${capture}`, async (t) => {
      const captureDir = mkdtempSync(join(tmpdir(), "router-forwarding-capture-"));
      t.after(() => rmSync(captureDir, { recursive: true, force: true }));
      const instance = await loadRouterWith({ routes: [route], captureDir: capture ? captureDir : null });
      instance.markAuthValidated(headers);
      const priorKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
      process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-key";
      t.after(() => {
        if (priorKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
        else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = priorKey;
      });
      const body = { model: route.pickerSlug, reasoning: { effort: "high" }, stream: true, input: [
        user("start"),
        { type: "reasoning", encrypted_content: bridge.encodeReasoning("private bridge thinking", "signature") },
        { type: "reasoning", encrypted_content: "upstream-opaque-reasoning" },
        { type: "custom_tool_call", id: "fc_0123456789abcdef0123", call_id: "call_patch", name: "apply_patch", input: "patch" },
        { type: "custom_tool_call_output", call_id: "call_patch", output: "patched" },
        { type: "compaction", encrypted_content: bridge.encodeCompaction("retained work summary") },
        user("continue"),
      ] };
      const original = structuredClone(body);
      const encoded = JSON.stringify(body);
      const stringify = JSON.stringify;
      let requestEncodings = 0;
      t.mock.method(JSON, "stringify", (value, ...args) => {
        if ([route.pickerSlug, route.upstreamModel].includes(value?.model) && Array.isArray(value?.input)) requestEncodings += 1;
        return stringify(value, ...args);
      });
      const originalFetch = globalThis.fetch;
      let sent;
      t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(String(url), "https://gateway.example/v1/responses");
        sent = JSON.parse(options.body);
        return new Response(`data: ${stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", output: [] } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } });
      });
      if (transport === "HTTP") {
        instance.routerServer.listen(0, "127.0.0.1");
        await once(instance.routerServer, "listening");
        t.after(() => new Promise(resolve => instance.routerServer.close(resolve)));
        const response = await originalFetch(`http://127.0.0.1:${instance.routerServer.address().port}/v1/responses`, {
          method: "POST", headers: { ...headers, "content-type": "application/json" }, body: encoded,
        });
        assert.equal(response.status, 200);
        assert.match(await response.text(), /response.completed/);
      } else {
        const chunks = [];
        const socket = { destroyed: false, writable: true, write(chunk) { chunks.push(Buffer.from(chunk)); return true; } };
        await instance.handleWebSocketResponseInner({ headers }, socket, new URL("http://localhost/v1/responses"),
          { ...body, type: "response.create" }, new AbortController(), { upstreamDisabled: true, connectionNamespace: "cold" });
        const events = instance.parseWebSocketFrames(Buffer.concat(chunks)).frames.map(frame => JSON.parse(frame.payload));
        assert.equal(events.at(-1).type, "response.completed");
      }
      assert.equal(requestEncodings, capture ? 2 : 1, "正常路徑只編碼一次，啟用擷取才多產生一份診斷 JSON");
      assert.equal(sent.model, route.upstreamModel);
      assert.deepEqual(sent.reasoning, { effort: "high" });
      const call = sent.input.find(item => item.type === "custom_tool_call");
      const result = sent.input.find(item => item.type === "custom_tool_call_output");
      assert.equal(call.id, undefined);
      assert.equal(call.call_id, result.call_id);
      assert.equal(call.input, "patch");
      assert.equal(result.output, "patched");
      assert.deepEqual(sent.input.filter(item => item.type === "reasoning"), [{ type: "reasoning", encrypted_content: "upstream-opaque-reasoning" }]);
      assert.ok(sent.input.some(item => item.content?.[0]?.text?.includes("retained work summary")));
      assert.deepEqual(body, original, "清理不能改動呼叫端的歷史");
      const requestFiles = readdirSync(captureDir).filter(name => name.endsWith(".request.json"));
      assert.equal(requestFiles.length, capture ? 1 : 0);
      if (capture) assert.deepEqual(JSON.parse(readFileSync(join(captureDir, requestFiles[0]), "utf8")), original);
    });
  }
}

test("official HTTP preserves raw bytes only for unchanged requests; legacy tool repair still wins", async (t) => {
  const instance = await loadRouterWith({});
  const encoded = '{ "model": "official-test", "input": "hello" }';
  const body = JSON.parse(encoded);
  const sent = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    sent.push(Buffer.from(options.body).toString("utf8"));
    return Response.json({ output: [] });
  });
  await instance.fetchModelUpstream(headers, new URL("http://localhost/v1/responses"), body, Buffer.from(encoded), undefined, {});
  assert.equal(sent[0], encoded);
  const legacy = { model: "official-test", input: [{ type: "custom_tool_call", id: "fc_0123456789abcdef0123", call_id: "call_1", name: "patch", input: "text" }] };
  await instance.fetchModelUpstream(headers, new URL("http://localhost/v1/responses"), legacy, Buffer.from(JSON.stringify(legacy)), undefined, {});
  assert.equal(JSON.parse(sent[1]).input[0].id, undefined);
});
