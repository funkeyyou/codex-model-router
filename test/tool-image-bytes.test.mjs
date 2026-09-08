// 18 張圖仍可能超過 32 MB：圖片張數與 token 都無法替代傳輸位元組預算。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { router, bridge } = await loadPayloads();
const { budgetToolImages, archiveHistoryImage, upstreamRequestTooLarge } = router;
const MAX = 48 * 1024;

function image(seed, size = 4096) {
  const bytes = Buffer.alloc(size, seed);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(800, 16);
  bytes.writeUInt32BE(600, 20);
  return { type: "input_image", image_url: `data:image/png;base64,${bytes.toString("base64")}` };
}

function request(count = 10) {
  return {
    model: "custom/gpt-test",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "保留附件" }, image(90, 1024)] },
      ...Array.from({ length: count }, (_, i) => [
        { type: "function_call", namespace: "mcp__cua_repl", name: "js", call_id: `call-${i}`, arguments: "{}" },
        { type: "function_call_output", call_id: `call-${i}`, output: [{ type: "input_text", text: `畫面 ${i} 的觀察` }, image(i)] },
      ]).flat(),
    ],
  };
}

const archiveStub = ({ data }) => `/safe/history/${createHash("sha256").update(data).digest("hex")}.png`;
const budget = (body, options = {}) => budgetToolImages(body, { maxBytes: MAX, archive: archiveStub, ...options });

test("大小未達預算時不複製、不保存圖片，也不改請求", () => {
  const body = request(2);
  const result = budget(body, { archive: () => assert.fail("不應封存") });
  assert.equal(result.request, body);
  assert.equal(result.imagesOmitted, 0);
  assert.equal(result.bytesSaved, 0);
});

test("不到 20 張的大圖也會縮減，保留使用者圖片、近期畫面、文字與工具配對", () => {
  const body = request();
  const before = structuredClone(body);
  const result = budget(body);
  assert.ok(upstreamRequestTooLarge(result.originalBytes, MAX));
  assert.ok(result.imagesOmitted > 0);
  assert.ok(result.buffer.length <= MAX * 0.75);
  assert.equal(result.bytesSaved, result.originalBytes - result.buffer.length);
  assert.deepEqual(body, before, "不能把 Codex 的完整歷史就地改掉");
  assert.deepEqual(result.request.input[0], before.input[0]);
  assert.deepEqual(result.request.input.slice(-8), before.input.slice(-8), "最新四張及配對原封不動");
  assert.deepEqual(result.request.input.map(i => [i.type, i.call_id]), before.input.map(i => [i.type, i.call_id]));
  for (let i = 1; i < before.input.length; i += 2) {
    assert.deepEqual(result.request.input[i], before.input[i]);
    assert.deepEqual(result.request.input[i + 1].output[0], before.input[i + 1].output[0]);
  }
  assert.match(result.request.input[2].output[1].text, /原圖：\/safe\/history\//);
  assert.equal(result.request.input[2].output[1].type, "input_text");
  assert.deepEqual(JSON.parse(result.buffer), result.request);
});

test("custom_tool_call_output 與壓縮控制項同樣適用", () => {
  const body = request();
  for (const item of body.input) {
    if (item.type === "function_call_output") item.type = "custom_tool_call_output";
  }
  body.input.push({ type: "compaction_trigger" });
  const result = budget(body);
  assert.ok(result.imagesOmitted > 0);
  assert.deepEqual(result.request.input.at(-1), { type: "compaction_trigger" });
});

test("Claude 轉譯後按實際 JSON 大小縮減；壓縮回合與 tool_use_id 仍完整", () => {
  const body = request();
  body.input.push({ type: "compaction_trigger" });
  const converted = bridge.toAnthropicRequest(body, { upstreamModel: "claude-test" });
  assert.equal(converted.compaction, true);
  assert.equal(converted.imagesOmitted, 0, "舊版張數限制抓不到此案例");
  const result = budget(converted.request, { anthropic: true });
  assert.ok(result.imagesOmitted > 0);
  assert.ok(result.buffer.length < MAX);
  assert.deepEqual(result.request.messages[0], converted.request.messages[0], "使用者附件完整保留");
  const oldResults = converted.request.messages.flatMap(m => m.content).filter(b => b.type === "tool_result");
  const newResults = result.request.messages.flatMap(m => m.content).filter(b => b.type === "tool_result");
  assert.deepEqual(newResults.map(b => b.tool_use_id), oldResults.map(b => b.tool_use_id));
  assert.equal(newResults[0].content[1].type, "text");
  assert.deepEqual(newResults.slice(-4), oldResults.slice(-4));
  assert.deepEqual(result.request.messages.at(-1).content.at(-1), converted.request.messages.at(-1).content.at(-1));
});

test("最新一組工具結果有多張比較圖時整組保留", () => {
  const body = request();
  body.input.at(-1).output.push(...Array.from({ length: 4 }, (_, i) => image(30 + i)));
  const result = budget(body);
  assert.ok(result.imagesOmitted > 0);
  assert.deepEqual(result.request.input.at(-1), body.input.at(-1));
});

test("使用者附件、最新四張或純文字本身超限時不刪內容，交給明確的 413", () => {
  for (const body of [request(4), { input: [{ type: "message", role: "user", content: [image(1, MAX)] }] }, { input: "x".repeat(MAX + 1) }]) {
    const result = budgetToolImages(body, { maxBytes: 1024, archive: () => assert.fail("不應保存受保護內容") });
    assert.equal(result.imagesOmitted, 0);
    assert.equal(result.request, body);
    assert.ok(upstreamRequestTooLarge(result.buffer.length, 1024));
  }
});

test("沒有 call_id 的跨任務內容不當成可省略的工具圖片", () => {
  const body = request();
  for (const item of body.input) if (item.type === "function_call_output") delete item.call_id;
  const result = budget(body, { archive: () => assert.fail("不應封存") });
  assert.equal(result.request, body);
});

test("封存失敗保留原圖；不偽造可回讀的檔案路徑", () => {
  const body = request();
  for (const archive of [() => null, () => { throw new Error("disk full"); }]) {
    const result = budget(body, { archive });
    assert.equal(result.request, body);
    assert.equal(result.imagesOmitted, 0);
    assert.ok(result.archiveFailures > 0);
  }
});

test("原圖按內容去重、逐位元組保存，中文目錄可回讀", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "router-history-圖片-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = image(8).image_url.split(",")[1];
  const source = { data, mediaType: "image/png" };
  const first = archiveHistoryImage(source, dir);
  assert.equal(archiveHistoryImage(source, dir), first);
  assert.equal(readdirSync(dir).length, 1);
  assert.deepEqual(readFileSync(first), Buffer.from(data, "base64"));
  writeFileSync(first, "broken");
  assert.throws(() => archiveHistoryImage(source, dir), "不把損壞的既有檔案當作已保存");
  assert.equal(archiveHistoryImage({ data: "invalid", mediaType: "image/png" }, dir), null);
  assert.equal(archiveHistoryImage({ data, mediaType: "image/svg+xml" }, dir), null);
});

test("實際轉送路徑與增量重建都使用縮減後的請求，原本超限仍能繼續", async (t) => {
  const routes = [
    { pickerSlug: "custom/gpt-test", upstreamModel: "gpt-test", efforts: [] },
    { pickerSlug: "custom/claude-test", upstreamModel: "claude-test", translate: "anthropic", efforts: [] },
  ];
  const instance = await loadRouterWith({ routes, maxUpstreamRequestBytes: MAX });
  const originalFetch = globalThis.fetch;
  const previousTestKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-key";
  const received = [];
  globalThis.fetch = async (url, options) => {
    received.push({ url: String(url), bytes: options.body.length, body: JSON.parse(options.body) });
    return new Response("ok", { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousTestKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previousTestKey;
  });
  const headers = { authorization: "Bearer fixture", "chatgpt-account-id": "fixture-account" };
  instance.markAuthValidated(headers);
  for (const route of routes) {
    const full = { ...request(), model: route.pickerSlug, client_metadata: { session_id: route.pickerSlug } };
    const inputUrl = new URL("http://127.0.0.1/v1/responses");
    const meta = {};
    const first = await instance.fetchModelUpstream(headers, inputUrl, full, Buffer.from(JSON.stringify(full)), undefined, meta);
    assert.equal(first.status, 200);
    assert.ok(received.at(-1).bytes < MAX);
    assert.match(JSON.stringify(received.at(-1).body), /history-images/);
    if (route.translate) assert.deepEqual(meta.anthropicRequest, received.at(-1).body);
    const next = { model: route.pickerSlug, client_metadata: full.client_metadata, previous_response_id: "response-previous", input: [{ type: "compaction_trigger" }] };
    const second = await instance.fetchModelUpstream(headers, inputUrl, next, Buffer.from(JSON.stringify(next)), undefined, {});
    assert.equal(second.status, 200);
    assert.ok(received.at(-1).bytes < MAX);
    assert.equal(received.at(-1).body.previous_response_id, undefined);
  }
  assert.equal(received.length, 4);
});
