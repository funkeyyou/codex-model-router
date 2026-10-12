// Nano Banana（Gemini 圖片模型）：回應解析、逐模型介面偵測、正式命令與路由器轉送。
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { imagegen, installer } = await loadPayloads();
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZB9sAAAAASUVORK5CYII=", "base64");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const banana = "gemini-nano-banana-2.1";

test("模型清單：五個 Nano Banana 型號與說明，-preview 只適用 Gemini，Google 的 models/ 不算前綴", () => {
  assert.deepEqual(imagegen.GEMINI_IMAGE_MODELS, [banana, "gemini-3-pro-image", "gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-2.5-flash-image"]);
  assert.deepEqual(installer.RELAY_IMAGE_MODELS.map((model) => model.id), imagegen.IMAGE_MODELS);
  assert.ok(installer.RELAY_IMAGE_MODELS.every((model) => model.label && model.description));
  assert.equal(imagegen.validImageUpstream("gemini-3-pro-image", "gemini-3-pro-image-preview"), true);
  assert.equal(imagegen.validImageUpstream("gemini-3-pro-image", "ark/gemini-3-pro-image-preview"), true);
  assert.equal(imagegen.validImageUpstream("gpt-image-2", "gpt-image-2-preview"), false);
  const found = installer.detectRelayImageModels(["gemini-3-pro-image-preview", "gemini-3-pro-image", "ark/gemini-2.5-flash-image-preview"]);
  assert.deepEqual(found.map((model) => [model.id, model.upstreamModel]),
    [["gemini-3-pro-image", "gemini-3-pro-image"], ["gemini-2.5-flash-image", "ark/gemini-2.5-flash-image-preview"]]);
  assert.equal(imagegen.chooseImageModel({ models: [banana, "gemini-3-pro-image"] }, "banana-pro", "generate"), "gemini-3-pro-image");
  assert.equal(imagegen.chooseImageModel({ models: [banana, "gemini-3-pro-image"] }, null, "generate"), banana);
  assert.equal(imagegen.chooseImageModel({ models: [banana, "gemini-3-pro-image"] }, null, "edit"), "gemini-3-pro-image");
});

test("chat 回應：message.images、content 陣列、Markdown data URL 與 https 圖片都能取出；沒有圖片明確報錯", async () => {
  const url = "data:image/png;base64," + png.toString("base64");
  assert.equal((await imagegen.extractChatImage({ choices: [{ message: { images: [{ type: "image_url", image_url: { url } }] } }] })).format, "png");
  assert.equal((await imagegen.extractChatImage({ choices: [{ message: { content: [{ type: "image_url", image_url: { url } }] } }] })).format, "png");
  assert.equal((await imagegen.extractChatImage({ choices: [{ message: { content: "好了：\n![image](" + url + ")" } }] })).format, "png");
  const downloaded = [];
  const remote = await imagegen.extractChatImage({ choices: [{ message: { content: "![x](https://cdn.example/a.jpg)" } }] },
    { download: async (target) => { downloaded.push(target); return jpeg; } });
  assert.deepEqual([remote.format, downloaded], ["jpeg", ["https://cdn.example/a.jpg"]]);
  await assert.rejects(imagegen.extractChatImage({ choices: [{ message: { content: "我無法生成圖片" } }] }), /沒有回傳圖片/);
  assert.equal(imagegen.extractGeminiImage({ candidates: [{ content: { parts: [{ text: "ok" }, { inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } }] } }] }).format, "jpeg");
  assert.throws(() => imagegen.extractGeminiImage({ candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [] } }] }), /IMAGE_SAFETY/);
});

test("偵測：Nano Banana 逐一試 chat → Gemini 原生，通過就停；GPT Image 照舊；不支援 modalities 時去掉重送一次", async () => {
  const calls = [];
  const result = await imagegen.discoverUsableRelayImages({
    candidates: [{ id: banana, upstreamModel: banana }, { id: "gemini-3-pro-image", upstreamModel: "gemini-3-pro-image-preview" },
      { id: "gpt-image-2.5-flare", upstreamModel: "gpt-image-2.5-flare" }],
    apiRoot: "https://gateway.example/v1", apiKey: "fixture",
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body, headers: options.headers });
      if (url.endsWith("/images/generations")) return Response.json({ data: [{ b64_json: png.toString("base64") }] });
      if (url.endsWith("/chat/completions")) {
        assert.equal(options.headers.authorization, "Bearer fixture");
        if (body.model === banana && body.modalities) return Response.json({ error: { message: "Unknown field: modalities" } }, { status: 400 });
        if (body.model === banana) return Response.json({ choices: [{ message: { content: "![](data:image/png;base64," + png.toString("base64") + ")" } }] });
        return Response.json({ error: { message: "not found" } }, { status: 404 });
      }
      assert.equal(url, "https://gateway.example/v1beta/models/gemini-3-pro-image-preview:generateContent");
      assert.equal(options.headers["x-goog-api-key"], "fixture");
      assert.equal(options.headers.authorization, undefined);
      return Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: jpeg.toString("base64") } }] } }] });
    } });
  assert.deepEqual(result.apiModes, { "gpt-image-2.5-flare": "images", [banana]: "chat", "gemini-3-pro-image": "gemini" });
  assert.equal(result.apiMode, "images");
  assert.deepEqual(result.models.map((model) => [model.id, model.format || "png"]),
    [["gpt-image-2.5-flare", "png"], [banana, "png"], ["gemini-3-pro-image", "jpeg"]]);
  assert.deepEqual(calls.filter((call) => call.url.endsWith("/chat/completions")).map((call) => [call.body.model, Boolean(call.body.modalities)]),
    [[banana, true], [banana, false], ["gemini-3-pro-image-preview", true]]);
  assert.equal(calls.length, 5, "通過後不再試其他介面");
});

function commandFixture(t, apiModes) {
  const dir = mkdtempSync(join(tmpdir(), "router-gemini-command-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  const settingsPath = join(dir, "settings.json");
  writeFileSync(configPath, JSON.stringify({ managedBy: "codex-model-router", models: Object.keys(apiModes), routerSettingsPath: settingsPath,
    upstreamModels: Object.fromEntries(Object.keys(apiModes).map((id) => [id, "ark/" + id])), apiMode: "images", apiModes, providerId: "relay" }));
  writeFileSync(settingsPath, JSON.stringify({ port: 48953 }));
  return { dir, configPath };
}

test("命令：chat 介面經本機路由器、帶供應商標頭；尺寸／品質只能 auto；上游回 JPEG 時改用 .jpg 儲存", async (t) => {
  const f = commandFixture(t, { [banana]: "chat" });
  const out = join(f.dir, "貓.png");
  const requests = [];
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith("/healthz")) return Response.json({ status: "ok", stats: { imageRequests: 0, geminiImageRequests: 0 } });
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return Response.json({ choices: [{ message: { images: [{ image_url: { url: "data:image/jpeg;base64," + jpeg.toString("base64") } }] } }] });
  };
  await assert.rejects(imagegen.runRelayImagegen(["generate", "--prompt", "貓", "--out", out, "--quality", "high"], { configPath: f.configPath, fetchImpl }), /auto/);
  assert.equal(requests.length, 0);
  const result = await imagegen.runRelayImagegen(["generate", "--prompt", "貓", "--out", out], { configPath: f.configPath, fetchImpl });
  assert.equal(requests[0].url, "http://127.0.0.1:48953" + imagegen.CHAT_IMAGE_PATH);
  assert.equal(requests[0].headers["x-codex-router-provider"], "relay");
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[0].body.model, "ark/" + banana);
  assert.deepEqual([result.apiMode, result.format, result.path], ["chat", "jpeg", join(f.dir, "貓.jpg")]);
  assert.deepEqual(readFileSync(result.path), jpeg);
  assert.equal(existsSync(out), false);
  const list = await imagegen.runRelayImagegen(["list"], { configPath: f.configPath });
  assert.deepEqual(list.apiModes, { [banana]: "chat" });
});

test("命令：舊版路由器（健康檢查沒有 geminiImageRequests）時不送出付費請求", async (t) => {
  const f = commandFixture(t, { [banana]: "gemini" });
  let sent = 0;
  await assert.rejects(imagegen.runRelayImagegen(["generate", "--prompt", "貓", "--out", join(f.dir, "a.png")], { configPath: f.configPath,
    fetchImpl: async (url) => { if (String(url).endsWith("/healthz")) return Response.json({ status: "ok", stats: { imageRequests: 0 } }); sent++; } }), /update/);
  assert.equal(sent, 0);
});

test("路由器：chat 轉到供應商 chat/completions（Bearer），gemini 轉到 origin 的原生 generateContent（x-goog-api-key）", async (t) => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ path: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const router = await loadRouterWith({ apiRoot: `http://127.0.0.1:${upstream.address().port}/v1` });
  router.routerServer.listen(0, "127.0.0.1");
  await once(router.routerServer, "listening");
  const previousKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "gemini-fixture-key";
  t.after(async () => {
    if (previousKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY; else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previousKey;
    router.routerServer.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise((r) => router.routerServer.close(r)), new Promise((r) => upstream.close(r))]);
  });
  const base = `http://127.0.0.1:${router.routerServer.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await post(imagegen.CHAT_IMAGE_PATH, { model: banana, messages: [] })).status, 200);
  assert.equal((await post(imagegen.GEMINI_IMAGE_PATH, { model: "gemini-3-pro-image", contents: [] })).status, 200);
  assert.equal((await post(imagegen.GEMINI_IMAGE_PATH, { model: "../secret?x=1", contents: [] })).status, 400);
  assert.equal((await post(imagegen.CHAT_IMAGE_PATH, {}, { origin: "https://evil.example" })).status, 403, "瀏覽器網頁不能用中轉額度生圖");
  assert.deepEqual(received.map((item) => item.path), ["/v1/chat/completions", "/v1beta/models/gemini-3-pro-image:generateContent"]);
  assert.equal(received[0].headers.authorization, "Bearer gemini-fixture-key");
  assert.equal(received[1].headers["x-goog-api-key"], "gemini-fixture-key");
  assert.equal(received[1].headers.authorization, undefined);
  assert.equal(received[1].body.model, undefined, "model 只放在網址裡");
  const health = await (await fetch(base + "/healthz")).json();
  assert.equal(health.stats.geminiImageRequests, 2);
});

test("技能設定：逐模型保存介面，GPT Image 沿用共用 apiMode；技能說明列出 Nano Banana 的選擇原則", () => {
  const text = installer.renderRelayImageSkill({ root: "/skills/router-imagegen", nodePath: "/node", models: [banana, "gemini-3-pro-image"], platform: "darwin" });
  assert.match(text, /Nano Banana 2\.1/);
  assert.match(text, /Nano Banana Pro/);
  assert.match(text, /apiModes/);
});
