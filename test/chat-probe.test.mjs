// 安裝器探測只有 /chat/completions 的模型。
//
// /responses 探測不通時改探 /chat/completions，並記下上游收不收 tools、reasoning_effort
// 與 stream_options；這些結果決定路由器怎麼轉譯。目錄項目改用一般函式工具，不用 Code Mode。

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
const delta = (value, finish = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] });
const chatRoute = {
  pickerSlug: "custom/deepseek-chat", upstreamModel: "deepseek-chat", displayName: "api/deepseek-chat",
  providerHost: "gateway.example", efforts: ["low", "medium", "high"], stripReasoning: false, contextWindow: null,
  translate: "chat", chatTools: true, chatStreamOptions: true,
};

const silent = { write() {}, line() {} };

// 假的 Chat Completions 上游。behavior 決定哪些參數會被拒收。
async function fakeGateway(t, behavior = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ path: request.url, body });
    const reject = (status) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "rejected" } })); };
    if (request.url.endsWith("/responses")) return reject(404);
    if (!request.url.endsWith("/chat/completions")) return reject(404);
    if (behavior.status) return reject(behavior.status);
    if (behavior.rejectStreamOptions && body.stream_options) return reject(400);
    if (behavior.rejectTools && body.tools) return reject(400);
    if (behavior.rejectEffort && body.reasoning_effort) return reject(400);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify(delta({ content: "OK" }, "stop"))}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { requests, apiRoot: `http://127.0.0.1:${server.address().port}/v1` };
}

test("探測：支援工具與推理強度時全部記下；不收 stream_options 的閘道改成不要求用量", async (t) => {
  const full = await fakeGateway(t);
  assert.deepEqual(await installer.probeChatModel(full.apiRoot, "key", "deepseek-chat", silent),
    { supported: true, transient: false, tools: true, streamOptions: true, efforts: ["low", "medium", "high"] });

  const strict = await fakeGateway(t, { rejectStreamOptions: true, rejectTools: true, rejectEffort: true });
  assert.deepEqual(await installer.probeChatModel(strict.apiRoot, "key", "qwen-local", silent),
    { supported: true, transient: false, tools: false, streamOptions: false, efforts: [] });
  assert.ok(strict.requests.filter((request) => request.body?.tools || request.body?.reasoning_effort)
    .every((request) => !request.body.stream_options), "拿掉 stream_options 之後的探測都不能再帶它");
});

test("探測：404 代表不支援，5xx 代表暫時問不到", async (t) => {
  const missing = await fakeGateway(t, { status: 404 });
  assert.deepEqual(await installer.probeChatModel(missing.apiRoot, "key", "m", silent), { supported: false, transient: false });
  const busy = await fakeGateway(t, { status: 503 });
  assert.deepEqual(await installer.probeChatModel(busy.apiRoot, "key", "m", silent), { supported: false, transient: true });
});

test("/responses 不通時改走 Chat Completions，路由標上 translate:chat 與探測結果", async (t) => {
  const gateway = await fakeGateway(t, { rejectEffort: true });
  const outcome = await installer.buildRouteForModel({ apiRoot: gateway.apiRoot, models: ["deepseek-chat"] },
    "key", "deepseek-chat", silent, "deepseek");
  assert.equal(outcome.transient, false);
  assert.deepEqual(outcome.route, {
    pickerSlug: installer.pickerSlug("deepseek-chat", "deepseek"),
    upstreamModel: "deepseek-chat",
    displayName: "deepseek/deepseek-chat",
    providerHost: new URL(gateway.apiRoot).host,
    providerId: "deepseek",
    efforts: [],
    stripReasoning: true,
    contextWindow: null,
    translate: "chat",
    chatTools: true,
    chatStreamOptions: true,
  });
  assert.ok(gateway.requests.some((request) => request.path.endsWith("/responses")), "先探 /responses");
});

test("目錄項目：Chat Completions 路由用一般函式工具，其他路由沿用模板的工具模式", () => {
  const templates = [{ slug: "gpt-5.6-sol", visibility: "list", tool_mode: "code_mode_only", priority: 1, context_window: 272000 }];
  const chatEntry = installer.customCatalogEntry(templates, { ...chatRoute, contextWindow: 65536 }, 0);
  assert.equal("tool_mode" in chatEntry, false);
  const plainEntry = installer.customCatalogEntry(templates, { ...chatRoute, translate: undefined, contextWindow: 65536 }, 0);
  assert.equal(plainEntry.tool_mode, "code_mode_only");
});
