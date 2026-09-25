// 路由器讀取中轉 API Key 的方式。
//
// Windows 以前用 execFileSync 起 powershell.exe 解 DPAPI：每次 1 秒以上，期間整個
// 路由器停住。每 5 分鐘一次還算可以，但 Ark 生圖每個請求都強制重讀——連每 2 秒一次的
// 任務輪詢也是——生圖期間路由器約有三分之一的時間是凍住的，其他對話的串流跟著卡。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { router } = await loadPayloads();
const { createSecretCache } = router;

function fixture({ values = ["key-1"], ttlMs = 60000 } = {}) {
  let reads = 0;
  let fingerprint = "a";
  let clock = 1000;
  const get = createSecretCache({
    read: async () => values[Math.min(reads++, values.length - 1)],
    fingerprint: () => fingerprint,
    ttlMs,
    now: () => clock,
  });
  return {
    get,
    reads: () => reads,
    setFingerprint: (value) => { fingerprint = value; },
    advance: (ms) => { clock += ms; },
  };
}

test("快取期間不重讀", async () => {
  const cache = fixture();
  assert.equal(await cache.get(), "key-1");
  assert.equal(await cache.get(), "key-1");
  assert.equal(cache.reads(), 1);
});

test("密文檔被改寫（fingerprint 變了）就重讀，拿到新 Key", async () => {
  const cache = fixture({ values: ["old", "new"] });
  assert.equal(await cache.get(), "old");
  cache.setFingerprint("b");
  assert.equal(await cache.get(), "new");
  assert.equal(cache.reads(), 2);
});

test("上游回 401/403 時可以強制重讀", async () => {
  const cache = fixture({ values: ["old", "new"] });
  await cache.get();
  assert.equal(await cache.get({ reload: true }), "new");
});

test("TTL 到期後重讀", async () => {
  const cache = fixture({ ttlMs: 100 });
  await cache.get();
  cache.advance(101);
  await cache.get();
  assert.equal(cache.reads(), 2);
});

test("同時間的多個請求共用同一次讀取", async () => {
  const cache = fixture();
  const results = await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.deepEqual(results, ["key-1", "key-1", "key-1"]);
  assert.equal(cache.reads(), 1);
});

test("讀到空值會報錯，而且不會被快取", async () => {
  const cache = fixture({ values: ["", "key-2"] });
  await assert.rejects(cache.get(), /憑證為空/);
  assert.equal(await cache.get(), "key-2");
});

// --- Windows：真的解 DPAPI ---------------------------------------------------

const onWindows = process.platform === "win32";

// 與安裝器相同的格式：以目前使用者的 DPAPI 加密，entropy 是 keychainService。
function writeDpapiCredential() {
  const credentialPath = join(mkdtempSync(join(tmpdir(), "router-credential-")), "credential.dat");
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$bytes = [Text.Encoding]::UTF8.GetBytes('sk-dpapi-fixture')",
    "$entropy = [Text.Encoding]::UTF8.GetBytes('test.service')",
    "$blob = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    `[IO.File]::WriteAllText('${credentialPath.replaceAll("'", "''")}', [Convert]::ToBase64String($blob))`,
  ].join("\n");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
  return credentialPath;
}

test("Windows：解 DPAPI 期間事件迴圈照常運作", { skip: !onWindows, timeout: 30000 }, async () => {
  const windowsRouter = await loadRouterWith({ credentialPath: writeDpapiCredential(), keychainService: "test.service" });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  try {
    const started = performance.now();
    const value = await windowsRouter.readStoredSecret();
    const elapsed = performance.now() - started;
    assert.equal(value, "sk-dpapi-fixture");
    // 讀取要花數百毫秒；同步寫法的期間計時器一次都不會觸發。
    if (elapsed > 100) assert.ok(ticks > 0, `解密花了 ${Math.round(elapsed)} ms，計時器卻沒有觸發`);
  } finally {
    clearInterval(timer);
  }
});

test("Windows：Ark 任務輪詢沿用快取的 Key，不再每次起 PowerShell", { skip: !onWindows, timeout: 60000 }, async (t) => {
  const previousKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  t.after(() => { if (previousKey !== undefined) process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previousKey; });

  const windowsRouter = await loadRouterWith({ credentialPath: writeDpapiCredential(), keychainService: "test.service" });
  windowsRouter.routerServer.listen(0, "127.0.0.1");
  await once(windowsRouter.routerServer, "listening");
  t.after(() => new Promise((resolve) => windowsRouter.routerServer.close(resolve)));
  const originalFetch = globalThis.fetch;
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    seen.push(new Headers(options.headers).get("authorization"));
    return Response.json({ task_id: "task_1", status: "running" });
  });
  const origin = `http://127.0.0.1:${windowsRouter.routerServer.address().port}`;
  for (let poll = 0; poll < 3; poll += 1) {
    const response = await originalFetch(`${origin}/v2/extend/image/ark_gpt_image/tasks/task_1`);
    assert.equal(response.status, 200);
    await response.json();
  }
  assert.deepEqual(seen, Array(3).fill("Bearer sk-dpapi-fixture"));
  const health = await originalFetch(`${origin}/healthz`).then((response) => response.json());
  assert.equal(health.stats.credentialReads, 1, "三次輪詢只該解密一次");
});
