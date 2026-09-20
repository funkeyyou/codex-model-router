import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { imagegen } = await loadPayloads();
const all = imagegen.IMAGE_MODELS;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZB9sAAAAASUVORK5CYII=", "base64");

function fixture(t, models = all) {
  const dir = mkdtempSync(join(tmpdir(), "router-image-command-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  const settingsPath = join(dir, "settings.json");
  writeFileSync(configPath, JSON.stringify({ managedBy: "codex-model-router", models, routerSettingsPath: settingsPath,
    upstreamModels: Object.fromEntries(models.map((id) => [id, id])) }));
  writeFileSync(settingsPath, JSON.stringify({ port: 48953 }));
  const prompt = join(dir, "提示詞.txt");
  writeFileSync(prompt, "畫一隻貓，文字：Hello $WORLD `keep literal`。");
  const out = join(dir, "圖片.png");
  return { dir, configPath, settingsPath, prompt, out,
    generate: ["generate", "--prompt-file", prompt, "--out", out] };
}

test("多模型有確定預設，使用者明確指定優先，單一模型固定，未勾選即拒絕", () => {
  const config = { models: all };
  assert.equal(imagegen.chooseImageModel(config, null, "generate"), all[2]);
  assert.equal(imagegen.chooseImageModel(config, null, "edit"), all[1]);
  assert.equal(imagegen.chooseImageModel(config, "image2", "generate"), all[0]);
  assert.equal(imagegen.chooseImageModel(config, "image2.5-Sunburst", "generate"), all[1]);
  assert.equal(imagegen.chooseImageModel({ models: [all[0]] }, null, "edit"), all[0]);
  assert.throws(() => imagegen.chooseImageModel({ models: [all[2]] }, "sunburst", "edit"), /未啟用/);
  assert.throws(() => imagegen.chooseImageModel(config, "gpt-image-1.5", "generate"), /未啟用/);
});

test("dry-run 不連網、不產生檔案，也不需要 API Key", async (t) => {
  const f = fixture(t);
  const result = await imagegen.runRelayImagegen([...f.generate, "--dry-run"], {
    configPath: f.configPath, fetchImpl: () => assert.fail("不能連網"),
  });
  assert.equal(result.model, all[2]);
  assert.equal(result.dryRun, true);
  assert.equal(existsSync(f.out), false);
});

test("只使用 loopback 路由、不送認證標頭，依上游原名送出圖片請求並保存 Base64 圖片", async (t) => {
  const f = fixture(t);
  const config = JSON.parse(readFileSync(f.configPath, "utf8"));
  config.upstreamModels[all[2]] = "ark/" + all[2];
  writeFileSync(f.configPath, JSON.stringify(config));
  const requests = [];
  const result = await imagegen.runRelayImagegen([...f.generate, "--model", "flare"], {
    configPath: f.configPath,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (String(url).endsWith("/healthz")) return Response.json({ status: "ok", stats: { imageRequests: 0 } });
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "http://127.0.0.1:48953/v1/images/generations");
  assert.equal(new Headers(requests[1].options.headers).get("authorization"), null);
  const body = JSON.parse(requests[1].options.body);
  assert.equal(body.model, "ark/" + all[2]);
  assert.equal(body.prompt, readFileSync(f.prompt, "utf8"));
  assert.equal(body.n, 1);
  assert.deepEqual(readFileSync(result.path), png);
});

test("改圖用 multipart 保留圖片原位元組；2.5 模型支援 max 與透明背景", async (t) => {
  const f = fixture(t);
  const reference = join(f.dir, "原圖.png");
  writeFileSync(reference, png);
  let request;
  await imagegen.runRelayImagegen(["edit", "--model", "sunburst", "--prompt-file", f.prompt,
    "--image", reference, "--out", f.out, "--quality", "max", "--background", "transparent"], {
    configPath: f.configPath, fetchImpl: async (url, options) => {
      if (String(url).endsWith("/healthz")) return Response.json({ status: "ok", stats: { imageRequests: 0 } });
      request = { url, options };
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    },
  });
  assert.match(request.url, /\/images\/edits$/);
  assert.ok(request.options.body instanceof FormData);
  assert.equal(request.options.body.get("model"), all[1]);
  assert.equal(request.options.body.get("quality"), "max");
  assert.equal(request.options.body.get("background"), "transparent");
  const file = request.options.body.get("image[]");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
  assert.equal(file.name, "原圖.png");
});

test("未啟用模型、已有輸出、Image 2 的 max、無效尺寸都在付費請求前拒絕", async (t) => {
  const f = fixture(t, [all[0]]);
  const options = { configPath: f.configPath, fetchImpl: () => assert.fail("不應發送請求") };
  await assert.rejects(imagegen.runRelayImagegen([...f.generate, "--model", "flare"], options), /未啟用/);
  await assert.rejects(imagegen.runRelayImagegen([...f.generate, "--quality", "max"], options), /不支援/);
  await assert.rejects(imagegen.runRelayImagegen([...f.generate, "--size", "1x1"], options), /尺寸/);
  writeFileSync(f.out, "existing image");
  await assert.rejects(imagegen.runRelayImagegen(f.generate, options), /已存在/);
  assert.equal(readFileSync(f.out, "utf8"), "existing image");
});

test("路由器沒起來時不送生圖；上游 429 不自動重試，也不切換模型", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(imagegen.runRelayImagegen(f.generate, { configPath: f.configPath,
    fetchImpl: async () => { calls++; throw new Error("offline"); } }), /沒有送出生圖請求/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(imagegen.runRelayImagegen(f.generate, { configPath: f.configPath,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/healthz")) return Response.json({ status: "ok", stats: { imageRequests: 0 } });
      calls++;
      return Response.json({ error: { message: "capacity unavailable" } }, { status: 429 });
    } }), /HTTP 429/);
  assert.equal(calls, 1);
  assert.equal(existsSync(f.out), false);
});

test("成功 HTTP 但沒有圖片，或檔案格式不符，不生成假成功檔案", async (t) => {
  const f = fixture(t);
  for (const payload of [{ data: [] }, { data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }]) {
    await assert.rejects(imagegen.runRelayImagegen(f.generate, { configPath: f.configPath,
      fetchImpl: async (url) => String(url).endsWith("/healthz")
        ? Response.json({ status: "ok", stats: { imageRequests: 0 } }) : Response.json(payload),
    }));
    assert.equal(existsSync(f.out), false);
  }
});

test("完整命令經真實 HTTP 路由轉送到模擬上游，保留中轉認證與生成／改圖位元組", async (t) => {
  const f = fixture(t);
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    received.push({ path: req.url, headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const router = await loadRouterWith({ apiRoot: `http://127.0.0.1:${upstream.address().port}/v1` });
  router.routerServer.listen(0, "127.0.0.1");
  await once(router.routerServer, "listening");
  const oldKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "relay-fixture-key";
  t.after(async () => {
    if (oldKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = oldKey;
    router.routerServer.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([new Promise((r) => router.routerServer.close(r)), new Promise((r) => upstream.close(r))]);
  });
  writeFileSync(f.settingsPath, JSON.stringify({ port: router.routerServer.address().port }));
  await imagegen.runRelayImagegen([...f.generate, "--model", "flare"], { configPath: f.configPath });
  const edited = join(f.dir, "edited.png");
  await imagegen.runRelayImagegen(["edit", "--model", "sunburst", "--prompt-file", f.prompt,
    "--image", f.out, "--out", edited], { configPath: f.configPath });
  assert.equal(received.length, 2);
  assert.equal(received[0].headers.authorization, "Bearer relay-fixture-key");
  assert.equal(JSON.parse(received[0].body).model, all[2]);
  assert.equal(received[1].path, "/v1/images/edits");
  assert.match(received[1].headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.ok(received[1].body.includes(png));
  assert.ok(received[1].body.includes(Buffer.from(all[1])));
  assert.deepEqual(readFileSync(edited), png);
});
