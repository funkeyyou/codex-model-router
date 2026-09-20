import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer, imagegen } = await loadPayloads();
const all = imagegen.IMAGE_MODELS;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZB9sAAAAASUVORK5CYII=", "base64");
const base = { model: all[2], apiRoot: "https://gateway.example/v1", apiKey: "probe-fixture-secret" };

test("探測規劃永遠限定三種模型，列出的原名優先，隱藏模型使用推斷的前綴", () => {
  const plan = installer.planRelayImageProbes([all[0], "ark/" + all[1], "gpt-image-1.5"], "akr");
  assert.deepEqual(plan.map((m) => m.upstreamModel), [all[0], "ark/" + all[1], "akr/" + all[2]]);
  assert.deepEqual(installer.planRelayImageProbes([], "none").map((m) => m.upstreamModel), all);
  assert.throws(() => installer.planRelayImageProbes([], "ark/?key=secret"));
});

test("前綴優先使用已啟用圖片模型，再取已列出的圖片或既有路由；混用前綴不猜測", () => {
  assert.equal(installer.inferRelayImagePrefix([], [{ upstreamModel: "ark/gpt-6-astra" }]), "ark/");
  assert.equal(installer.inferRelayImagePrefix(["ark/" + all[2]], [], { [all[0]]: "api/" + all[0] }), "api/");
  assert.equal(installer.inferRelayImagePrefix(["ark/" + all[2], "gpt-6-astra"]), "ark/");
  assert.equal(installer.inferRelayImagePrefix([], [{ upstreamModel: "ark/gpt-6-astra" }, { upstreamModel: "gpt-5.6-sol" }]), "");
  assert.equal(installer.inferRelayImagePrefix(["akr/gpt-6-astra"]), "akr/");
});

test("測試只送一個低品質單圖請求，使用上游名稱與 Key，成功必須回傳圖片位元組", async () => {
  const calls = [];
  const result = await imagegen.probeRelayImageModel({ ...base, upstreamModel: "ark/" + all[2],
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.bytes, png);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gateway.example/v1/images/generations");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.authorization, "Bearer " + base.apiKey);
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: "ark/" + all[2],
    prompt: "A small black circle centered on a plain white background.", n: 1, quality: "low", size: "1024x1024", output_format: "png" });
  assert.doesNotMatch(JSON.stringify(result), /probe-fixture-secret/);
});

test("401、403、404、429、502 保留 HTTP 錯誤，不重試；遮蔽實際 Key 與其他憑證", async () => {
  for (const status of [401, 403, 404, 429, 502]) {
    let calls = 0;
    const result = await imagegen.probeRelayImageModel({ ...base, fetchImpl: async () => {
      calls++;
      return Response.json({ error: { message: `denied ${base.apiKey} Bearer other-private-secret sk-another-secret` } }, { status });
    } });
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(result.error, /probe-fixture-secret|other-private-secret|sk-another-secret/);
    assert.equal(calls, 1);
  }
});

test("HTTP 成功但空內容、僅 URL、非圖片 Base64、非 JSON，均不算模型可用", async () => {
  const responses = [
    () => Response.json({ data: [] }),
    () => Response.json({ data: [{ url: "https://example.com/image.png" }] }),
    () => Response.json({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }),
    () => new Response("<html>proxy error</html>"),
  ];
  for (const respond of responses) {
    let calls = 0;
    const result = await imagegen.probeRelayImageModel({ ...base, fetchImpl: async () => { calls++; return respond(); } });
    assert.equal(result.ok, false);
    assert.equal(result.bytes, undefined);
    assert.equal(calls, 1);
  }
});

test("實際 HTTP 逾時會中止等待，不重送，也不把逾時說成模型不存在", async (t) => {
  let calls = 0;
  const server = http.createServer(() => { calls++; });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  const result = await imagegen.probeRelayImageModel({ ...base, apiRoot: `http://127.0.0.1:${server.address().port}/v1`, timeoutMs: 100 });
  assert.equal(result.ok, false);
  assert.match(result.error, /逾時.*可能仍在處理或計費/);
  assert.equal(calls, 1);
});

test("網路失敗只回報連線問題，不洩漏 fetch 例外中的憑證，也不重試", async () => {
  let calls = 0;
  const result = await imagegen.probeRelayImageModel({ ...base, fetchImpl: async () => {
    calls++; throw new Error(base.apiKey);
  } });
  assert.equal(result.ok, false);
  assert.match(result.error, /連線失敗/);
  assert.doesNotMatch(result.error, /probe-fixture-secret/);
  assert.equal(calls, 1);
});

test("三種以外的模型或錯誤前綴在發請求前拒絕", async () => {
  const fetchImpl = () => assert.fail("不能發送請求");
  await assert.rejects(imagegen.probeRelayImageModel({ ...base, model: "gpt-image-1.5", fetchImpl }));
  await assert.rejects(imagegen.probeRelayImageModel({ ...base, upstreamModel: all[0], fetchImpl }));
  await assert.rejects(imagegen.probeRelayImageModel({ ...base, upstreamModel: "ark/\n" + all[2], fetchImpl }));
});
