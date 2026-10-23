import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
const { publicGithubDownloadUrls, downloadPublicGithubFile } = installer;
const url = "https://github.com/funkeyyou/codex-model-router/releases/download/v1.38.0/SHA256SUMS";

test("公開下載只將本專案的無憑證網址送往代理", () => {
  assert.deepEqual(publicGithubDownloadUrls(url), [`https://gh-proxy.com/${url}`, url]);
  for (const value of [
    "https://github.com/other/private/raw/main/file",
    "https://api.github.com/repos/funkeyyou/codex-model-router",
    "https://github.com/funkeyyou/codex-model-router/issues/8",
    "https://github.com/funkeyyou/codex-model-router.evil/raw/main/file",
    url + "?token=secret", url + "#fragment",
    url.replace("https://", "https://user:secret@"),
    url.replace("https://", "http://"),
    "http://127.0.0.1:12345/releases",
  ]) assert.deepEqual(publicGithubDownloadUrls(value), [value]);
});

test("代理成功就不直連，且不附帶使用者憑證", async () => {
  const calls = [];
  const content = await downloadPublicGithubFile(url, { limit: 64, fetchImpl: async (target, options) => {
    calls.push(target);
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers.authorization, undefined);
    return new Response("expected");
  } });
  assert.equal(content.toString(), "expected");
  assert.deepEqual(calls, [`https://gh-proxy.com/${url}`]);
});

for (const failure of ["network", "http", "html", "invalid", "truncated", "oversized"]) {
  test(`代理 ${failure} 時以直連重新下載完整檔案`, async () => {
    const calls = [];
    const content = await downloadPublicGithubFile(url, {
      limit: 32,
      validate: (data) => assert.equal(data.toString(), "valid"),
      fetchImpl: async (target) => {
        calls.push(target);
        if (calls.length === 2) return new Response("valid");
        if (failure === "network") throw new TypeError("fetch failed");
        if (failure === "http") return new Response("unavailable", { status: 503 });
        if (failure === "html") return new Response("webpage", { headers: { "content-type": "text/html" } });
        if (failure === "truncated") return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.error(new Error("connection lost")); } }));
        return new Response(failure === "oversized" ? "x".repeat(33) : "invalid");
      },
    });
    assert.equal(content.toString(), "valid");
    assert.deepEqual(calls, [`https://gh-proxy.com/${url}`, url]);
  });
}

test("代理 404 時仍直連確認，兩邊皆 404 才回報缺少檔案", async () => {
  for (const directMissing of [false, true]) {
    const calls = [];
    const download = downloadPublicGithubFile(url, { limit: 32, fetchImpl: async (target) => {
      calls.push(target);
      return target !== url || directMissing ? new Response("missing", { status: 404 }) : new Response("new release");
    } });
    if (directMissing) await assert.rejects(download, /HTTP 404/);
    else assert.equal((await download).toString(), "new release");
    assert.deepEqual(calls, [`https://gh-proxy.com/${url}`, url]);
  }
});

test("兩條路都失敗時回報失敗；非 GitHub 自訂來源不改走代理", async () => {
  for (const target of [url, "http://localhost/releases"]) {
    let calls = 0;
    await assert.rejects(downloadPublicGithubFile(target, { limit: 32, fetchImpl: async () => {
      calls += 1;
      throw new Error("offline");
    } }), /offline/);
    assert.equal(calls, target === url ? 2 : 1);
  }
});

test("代理逾時會中止後改走直連", async () => {
  let calls = 0;
  const content = await downloadPublicGithubFile(url, { limit: 32, timeoutMs: 20, fetchImpl: async (_, { signal }) => {
    calls += 1;
    if (calls === 2) return new Response("valid");
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  assert.equal(content.toString(), "valid");
  assert.equal(calls, 2);
});

test("收到標頭後本文停住也會逾時，直連重試不會拼接殘缺內容", async (t) => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    if (calls === 1) res.write("partial");
    else res.end("complete");
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const content = await downloadPublicGithubFile(url, {
    limit: 32, timeoutMs: 100,
    fetchImpl: (_, options) => fetch(`http://127.0.0.1:${server.address().port}`, options),
  });
  assert.equal(content.toString(), "complete");
  assert.equal(calls, 2);
});
