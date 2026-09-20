import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { imagegen, installer } = await loadPayloads();
const all = imagegen.IMAGE_MODELS;
const ark = imagegen.ARK_IMAGE_PATH;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZB9sAAAAASUVORK5CYII=", "base64");
const candidates = all.slice(1).map((id) => ({ id, upstreamModel: "ark/" + id }));
const payload = { model: all[2], prompt: "test", output_format: "png" };
const ready = () => Response.json({ task_id: "img_gen_fixture", status: "succeeded",
  result: { images: [{ url: "https://images.example/image.png" }] } });

test("通用部分成功就停止，不額外試 Ark，也不補測未選模型", async () => {
  const calls = [];
  const result = await imagegen.discoverUsableRelayImages({ candidates, apiRoot: "https://gateway.example/v1", apiKey: "fixture",
    fetchImpl: async (url, options) => {
      calls.push({ url, model: JSON.parse(options.body).model });
      assert.equal(url, "https://gateway.example/v1/images/generations");
      return calls.length === 1 ? Response.json({ data: [{ b64_json: png.toString("base64") }] })
        : Response.json({ error: "unsupported" }, { status: 404 });
    } });
  assert.equal(result.apiMode, "images");
  assert.deepEqual(result.models.map((m) => m.id), [all[1]]);
  assert.equal(calls.length, 2);
});

test("通用全失敗才回退 Ark，只測原先勾選的模型且不攜帶不支援參數", async () => {
  const calls = [];
  const result = await imagegen.discoverUsableRelayImages({ candidates, apiRoot: "https://gateway.example/v1", apiKey: "fixture",
    downloadImpl: async () => png, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/v1/images/")) return Response.json({ error: "unsupported" }, { status: 404 });
      assert.equal(options.headers.authorization, "Bearer fixture");
      if (options.method === "GET") return ready();
      assert.equal(url, "https://gateway.example" + ark + "/generations");
      const body = JSON.parse(options.body);
      assert.ok(all.slice(1).includes(body.model));
      assert.deepEqual(Object.keys(body).sort(), ["model", "output_format", "prompt"]);
      return Response.json({ task_id: "img_gen_fixture" });
    } });
  assert.equal(result.apiMode, "ark-task");
  assert.deepEqual(result.models.map((m) => m.id), all.slice(1));
  assert.deepEqual(result.models.map((m) => m.upstreamModel), all.slice(1));
  assert.equal(calls.filter((c) => c.options.method === "POST").length, 4);
  assert.ok(calls.slice(0, 2).every((c) => c.url.includes("/v1/images/")));
});

test("Ark 任務未完成只查詢同一 task_id，提交只有一次", async () => {
  const calls = [];
  const result = await imagegen.runArkImageTask({ origin: "https://gateway.example/v1", payload, pollIntervalMs: 1,
    downloadImpl: async () => png, fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      if (options.method === "POST") return Response.json({ task_id: "img_gen_fixture" });
      return calls.length < 4 ? Response.json({ task_id: "img_gen_fixture", status: "running" }) : ready();
    } });
  assert.deepEqual(result.bytes, png);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  assert.ok(calls.slice(1).every((c) => c.url.endsWith("/tasks/img_gen_fixture")));
});

test("Ark 查詢或下載失敗保留 task_id、不重新提交，字串錯誤遮蔽 Key", async () => {
  let posts = 0;
  await assert.rejects(imagegen.runArkImageTask({ origin: "https://gateway.example", payload, apiKey: "sensitive-fixture-key",
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") { posts++; return Response.json({ task_id: "img_gen_fixture" }); }
      return Response.json({ error: "denied sensitive-fixture-key" }, { status: 403 });
    } }), (error) => /HTTP 403/.test(error.message) && /task_id=img_gen_fixture/.test(error.message) && !/sensitive-fixture-key/.test(error.message));
  assert.equal(posts, 1);
  posts = 0;
  await assert.rejects(imagegen.runArkImageTask({ origin: "https://gateway.example", payload,
    downloadImpl: async () => { throw new Error("download unavailable"); },
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") { posts++; return Response.json({ task_id: "img_gen_fixture" }); }
      return ready();
    } }), /task_id=img_gen_fixture.*未重新提交/);
  assert.equal(posts, 1);
});

test("空任務編號、錯誤任務、過期、無圖片 URL 都不能當成探測成功", async () => {
  for (const variant of ["missing-id", "wrong-id", "expired", "failed", "empty-url"]) {
    let posts = 0;
    const result = await imagegen.probeRelayImageModel({ model: all[2], apiMode: "ark-task", apiRoot: "https://gateway.example/v1", apiKey: "fixture",
      downloadImpl: () => assert.fail("不能下載"), fetchImpl: async (_url, options) => {
        if (options.method === "POST") { posts++; return Response.json(variant === "missing-id" ? {} : { task_id: "img_gen_fixture" }); }
        if (variant === "expired") return Response.json({ error: { message: "Task not found" } }, { status: 404 });
        if (variant === "wrong-id") return Response.json({ task_id: "different", status: "succeeded" });
        return Response.json({ status: variant === "failed" ? "failed" : "succeeded", result: { images: [] } });
      } });
    assert.equal(result.ok, false);
    assert.equal(posts, 1);
  }
});

test("下載使用已驗證 DNS 位址，不攜帶中轉 Key，並驗證圖片", async () => {
  const bytes = await imagegen.downloadArkImage("https://images.example/signed.png?token=fixture", {
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    requestImpl: async (url, options) => {
      assert.equal(url.hostname, "images.example");
      assert.deepEqual(options.addresses, [{ address: "93.184.216.34", family: 4 }]);
      assert.equal(options.headers, undefined);
      assert.equal(options.apiKey, undefined);
      return new Response(png);
    },
  });
  assert.deepEqual(bytes, png);
  await assert.rejects(imagegen.downloadArkImage("https://images.example/bad.png", {
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }], requestImpl: async () => new Response("not-image"),
  }), /未返回有效圖片/);
});

test("拒絕內網、IPv6 本機、DNS 私有位址與不安全重導", async () => {
  for (const url of ["http://images.example/image", "https://127.0.0.1/image", "https://198.18.0.1/image", "https://[::1]/image", "https://user:pass@images.example/image", "https://localhost/image"]) {
    await assert.rejects(imagegen.downloadArkImage(url, { requestImpl: () => assert.fail("不應發送"),
      lookupImpl: () => assert.fail("不需 DNS") }));
  }
  await assert.rejects(imagegen.downloadArkImage("https://images.example/image", {
    lookupImpl: async () => [{ address: "10.0.0.1", family: 4 }], requestImpl: () => assert.fail("不應發送"),
  }), /本機或內網/);
  let calls = 0;
  await assert.rejects(imagegen.downloadArkImage("https://images.example/image", {
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    requestImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/metadata" } }); },
  }), /本機或內網/);
  assert.equal(calls, 1);
});

test("代理假 IP 改用 HTTPS DNS 真實公開位址，查詢不含簽名 URL 或中轉憑證", async () => {
  let dnsCalls = 0;
  const bytes = await imagegen.downloadArkImage("https://images.example/result.png?signature=private-signature", {
    lookupImpl: async () => [{ address: "198.18.0.110", family: 4 }],
    dnsFetchImpl: async (url, options) => {
      dnsCalls++;
      assert.equal(url.origin, "https://cloudflare-dns.com");
      assert.equal(url.searchParams.get("name"), "images.example");
      assert.equal(url.searchParams.get("type"), "A");
      assert.ok(!String(url).includes("private-signature"));
      assert.deepEqual(options.headers, { accept: "application/dns-json" });
      return Response.json({ Status: 0, Answer: [{ type: 5, data: "cdn.example" }, { type: 1, data: "93.184.216.34" }] });
    },
    requestImpl: async (_url, options) => {
      assert.deepEqual(options.addresses, [{ address: "93.184.216.34", family: 4 }]);
      return new Response(png);
    },
  });
  assert.equal(dnsCalls, 1);
  assert.deepEqual(bytes, png);
});

test("HTTPS DNS 仍須通過公開位址檢查，失敗或返回內網不能下載", async () => {
  for (const answer of [{ Status: 0, Answer: [{ type: 1, data: "10.0.0.1" }] }, { Status: 2 }, { Status: 0, Answer: [] }]) {
    await assert.rejects(imagegen.downloadArkImage("https://images.example/test.png", {
      lookupImpl: async () => [{ address: "198.19.0.1", family: 4 }], dnsFetchImpl: async () => Response.json(answer),
      requestImpl: () => assert.fail("不能下載"),
    }), /本機或內網/);
  }
  await assert.rejects(imagegen.downloadArkImage("https://images.example/test.png", {
    lookupImpl: async () => [{ address: "10.0.0.1", family: 4 }], dnsFetchImpl: () => assert.fail("一般內網不走回退"),
    requestImpl: () => assert.fail("不能下載"),
  }), /本機或內網/);
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "router-ark-command-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings = join(dir, "settings.json");
  const config = join(dir, "config.json");
  writeFileSync(settings, JSON.stringify({ port: 48953 }));
  writeFileSync(config, JSON.stringify({ managedBy: "codex-model-router", models: [all[2]], routerSettingsPath: settings, apiMode: "ark-task" }));
  return { dir, settings, config, args: ["generate", "--prompt", "a test image", "--out", join(dir, "output.png")] };
}

test("正式 Ark 命令先拒絕不支援的尺寸、品質與透明背景；dry-run 不連網", async (t) => {
  const f = fixture(t);
  const options = { configPath: f.config, fetchImpl: () => assert.fail("不能請求") };
  for (const flags of [["--size", "1024x1024"], ["--quality", "low"], ["--background", "transparent"]]) {
    await assert.rejects(imagegen.runRelayImagegen([...f.args, ...flags], options), /Ark 任務介面/);
  }
  const dry = await imagegen.runRelayImagegen([...f.args, "--dry-run"], options);
  assert.equal(dry.apiMode, "ark-task");
  assert.equal(dry.endpoint, "http://127.0.0.1:48953" + ark + "/generations");
  assert.equal(existsSync(join(f.dir, "output.png")), false);
  const listed = await imagegen.runRelayImagegen(["list"], options);
  assert.equal(listed.apiMode, "ark-task");
});

test("舊路由器未支援 Ark 時在付費提交前提示 update", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(imagegen.runRelayImagegen(f.args, { configPath: f.config, fetchImpl: async (url) => {
    calls++; assert.ok(url.endsWith("/healthz")); return Response.json({ status: "ok", stats: { imageRequests: 0 } });
  } }), /update.*沒有送出/);
  assert.equal(calls, 1);
});

test("新技能與後續更新保留偵測的 Ark 模式，舊設定預設通用模式", (t) => {
  const f = fixture(t);
  const options = { models: [all[2]], root: join(f.dir, "router-imagegen"), settingsFile: f.settings, backupRoot: join(f.dir, "backups"),
    nodePath: process.execPath, sourcePath: fileURLToPath(new URL("../codex-model-router.sh", import.meta.url)) };
  assert.equal(installer.installRelayImageSkill(options).config.apiMode, "images");
  assert.equal(installer.installRelayImageSkill({ ...options, apiMode: "ark-task" }).config.apiMode, "ark-task");
  assert.equal(installer.installRelayImageSkill(options).config.apiMode, "ark-task");
  assert.throws(() => installer.installRelayImageSkill({ ...options, apiMode: "other" }));
});

test("圖片 DNS 查詢也受整體逾時控制，逾時後不下載", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), 20);
  try {
    await assert.rejects(imagegen.downloadArkImage("https://images.example/test.png", {
      signal: controller.signal, lookupImpl: () => new Promise(() => {}), requestImpl: () => assert.fail("不能下載"),
    }), (error) => error.name === "TimeoutError");
  } finally { clearTimeout(timer); }
});

test("完整 Ark 生圖／改圖經本機路由：POST 與 GET 正確轉送同一供應商，參考圖用 JSON", async (t) => {
  const f = fixture(t);
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    received.push({ path: req.url, method: req.method, headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.method === "POST" ? { task_id: "img_gen_fixture" }
      : { status: "succeeded", task_id: "img_gen_fixture", result: { images: [{ url: "https://images.example/test.png" }] } }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const router = await loadRouterWith({ apiRoot: `http://127.0.0.1:${upstream.address().port}/v1` });
  router.routerServer.listen(0, "127.0.0.1");
  await once(router.routerServer, "listening");
  const previousKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "ark-fixture-key";
  t.after(async () => {
    if (previousKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY; else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previousKey;
    router.routerServer.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise((r) => router.routerServer.close(r)), new Promise((r) => upstream.close(r))]);
  });
  writeFileSync(f.settings, JSON.stringify({ port: router.routerServer.address().port }));
  const options = { configPath: f.config, downloadImpl: async () => png };
  await imagegen.runRelayImagegen(f.args, options);
  await imagegen.runRelayImagegen(["edit", "--prompt", "keep the image", "--image", join(f.dir, "output.png"), "--out", join(f.dir, "edited.png")], options);
  assert.deepEqual(received.map((r) => [r.method, r.path]), [["POST", ark + "/generations"], ["GET", ark + "/tasks/img_gen_fixture"], ["POST", ark + "/edits"], ["GET", ark + "/tasks/img_gen_fixture"]]);
  for (const request of received) assert.equal(request.headers.authorization, "Bearer ark-fixture-key");
  for (const request of received.filter((r) => r.method === "POST")) {
    for (const unsupported of ["n", "size", "quality", "response_format", "stream"]) assert.equal(request.body[unsupported], undefined);
  }
  assert.deepEqual(received[2].body.image_base64s, ["data:image/png;base64," + png.toString("base64")]);
  assert.deepEqual(readFileSync(join(f.dir, "edited.png")), png);
  const invalid = await fetch(`http://127.0.0.1:${router.routerServer.address().port}${ark}/unexpected`);
  assert.equal(invalid.status, 404);
  assert.equal(received.length, 4);
});
