// 瀏覽器裡的網頁不能借本機路由器花掉使用者的中轉額度。
//
// 路由器只聽 127.0.0.1，但瀏覽器可以對它發請求：跨站的 text/plain 或
// multipart/form-data POST 不觸發 CORS 預檢；DNS rebinding 更能讓惡意網頁以同源身分
// 送出請求並讀到回應。生圖與 Ark 端點不要求 ChatGPT 憑證，路由器會自己附上中轉 Key。

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { router } = await loadPayloads();

test("只有本機名稱算本機 Host", () => {
  for (const host of ["127.0.0.1:48953", "localhost:48953", "LOCALHOST", "[::1]:48953", "localhost.", undefined]) {
    assert.equal(router.isLoopbackHost(host), true, String(host));
  }
  for (const host of ["attacker.example:48953", "127.0.0.1.nip.io:48953", "evil.localhost:80", "[::2]:1"]) {
    assert.equal(router.isLoopbackHost(host), false, host);
  }
});

test("帶 Origin 或跨站 Sec-Fetch-Site 的是瀏覽器請求；Node fetch 與 Codex 都不帶", () => {
  assert.equal(router.isBrowserRequest({ origin: "https://evil.example" }), true);
  assert.equal(router.isBrowserRequest({ origin: "null" }), true, "沙箱 iframe 送的是 Origin: null");
  assert.equal(router.isBrowserRequest({ "sec-fetch-site": "cross-site" }), true);
  assert.equal(router.isBrowserRequest({ "sec-fetch-site": "same-origin" }), true, "DNS rebinding 是同源請求");
  assert.equal(router.isBrowserRequest({ "sec-fetch-site": "none" }), false, "使用者自己在網址列開啟");
  assert.equal(router.isBrowserRequest({ "sec-fetch-mode": "cors", "user-agent": "node" }), false);
});

async function serve(t) {
  const upstreamRequests = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk)).on("end", () => {
      upstreamRequests.push({ path: request.url, authorization: request.headers.authorization });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=" }], task_id: "task_1", status: "running" }));
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const previousKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "sk-relay-fixture";
  const instance = await loadRouterWith({ apiRoot: `http://127.0.0.1:${upstream.address().port}/v1` });
  instance.routerServer.listen(0, "127.0.0.1");
  await once(instance.routerServer, "listening");
  t.after(async () => {
    if (previousKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previousKey;
    await new Promise((resolve) => instance.routerServer.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  });
  return { instance, upstreamRequests, port: instance.routerServer.address().port };
}

test("跨站網頁送來的生圖請求被擋下，中轉 Key 沒有送出去", async (t) => {
  const { port, upstreamRequests, instance } = await serve(t);
  // 與瀏覽器的「簡單請求」相同：text/plain、帶 Origin 與 Sec-Fetch-Site，不會有 CORS 預檢。
  const response = await fetch(`http://127.0.0.1:${port}/v1/images/generations`, {
    method: "POST",
    headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" },
    body: JSON.stringify({ model: "gpt-image-2", prompt: "x" }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "browser_request_rejected");
  const ark = await fetch(`http://127.0.0.1:${port}/v2/extend/image/ark_gpt_image/generations`, {
    method: "POST", headers: { origin: "https://evil.example", "content-type": "text/plain" }, body: "{}",
  });
  assert.equal(ark.status, 403);
  assert.deepEqual(upstreamRequests, []);
  const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
  assert.equal(health.stats.browserRequestsRejected, 2);
  assert.ok(instance);
});

test("Codex 與 imagegen 命令（不帶 Origin）照常轉送", async (t) => {
  const { port, upstreamRequests } = await serve(t);
  const response = await fetch(`http://127.0.0.1:${port}/v1/images/generations`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-image-2", prompt: "x" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(upstreamRequests, [{ path: "/v1/images/generations", authorization: "Bearer sk-relay-fixture" }]);
});

function rawRequest(port, host, path = "/healthz") {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path, headers: { host } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk)).on("end", () =>
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("DNS rebinding：Host 是外部網域的請求一律拒絕", async (t) => {
  const { port } = await serve(t);
  const foreign = await rawRequest(port, "attacker.example:1234");
  assert.equal(foreign.status, 403);
  assert.equal(JSON.parse(foreign.body).error.code, "forbidden_host");
  assert.equal((await rawRequest(port, `localhost:${port}`)).status, 200);
  assert.equal((await rawRequest(port, `127.0.0.1:${port}`)).status, 200);
});

test("DNS rebinding：WebSocket 升級同樣檢查 Host", async (t) => {
  const { port } = await serve(t);
  const statusLine = (host) => new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(
      `GET /v1/responses HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"));
    socket.once("data", (data) => { resolve(data.toString().split("\r\n")[0]); socket.destroy(); });
    // 伺服器沒送狀態列就關線時不能讓測試卡住。
    socket.once("close", () => resolve("(closed without response)"));
  });
  assert.equal(await statusLine("attacker.example:1234"), "HTTP/1.1 403 Forbidden");
  assert.equal(await statusLine(`127.0.0.1:${port}`), "HTTP/1.1 101 Switching Protocols");
});
