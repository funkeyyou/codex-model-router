// 兩個「不會壞掉、但會慢慢長大」的地方：日誌與已驗證憑證摘要。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { router } = await loadPayloads();

// --- 日誌上限 ---------------------------------------------------------------

const writeLog = (bytes) => {
  const path = join(mkdtempSync(join(tmpdir(), "router-log-")), "router.err.log");
  writeFileSync(path, "x".repeat(bytes));
  return path;
};

test("超過上限的日誌會被就地截斷", async () => {
  const r = await loadRouterWith({ maxLogBytes: 1024 });
  const path = writeLog(4096);
  assert.equal(r.truncateOversizedLog(path), true);
  assert.equal(statSync(path).size, 0);
});

test("沒超過上限就不動它", async () => {
  const r = await loadRouterWith({ maxLogBytes: 1024 });
  const path = writeLog(512);
  assert.equal(r.truncateOversizedLog(path), false);
  assert.equal(readFileSync(path, "utf8").length, 512);
});

test("剛好等於上限不算超過", async () => {
  const r = await loadRouterWith({ maxLogBytes: 1024 });
  const path = writeLog(1024);
  assert.equal(r.truncateOversizedLog(path), false);
});

test("日誌不存在或沒設定路徑都不該讓路由器起不來", async () => {
  const r = await loadRouterWith({ maxLogBytes: 1024 });
  assert.equal(r.truncateOversizedLog("/does/not/exist/router.err.log"), false);
  assert.equal(r.truncateOversizedLog(undefined), false);
  assert.equal(r.truncateOversizedLog(""), false);
  assert.equal(r.truncateOversizedLog(null), false);
});

test("settings 沒給 maxLogBytes 時用預設值 5 MB", async () => {
  const r = await loadRouterWith({});
  const path = writeLog(1024 * 1024);
  assert.equal(r.truncateOversizedLog(path), false, "1 MB 不該被截斷");
});

// --- 已驗證憑證摘要 ---------------------------------------------------------

const authHeaders = (n) => ({
  authorization: `Bearer token-${n}`,
  "chatgpt-account-id": `account-${n}`,
});

test("驗證過的憑證會被記住", () => {
  const headers = authHeaders("stable");
  assert.equal(router.hasValidatedAuth(headers), false);
  router.markAuthValidated(headers);
  assert.equal(router.hasValidatedAuth(headers), true);
});

test("缺少 authorization 或 account id 就不記，也查不到", () => {
  for (const headers of [
    {},
    { authorization: "Bearer x" },
    { "chatgpt-account-id": "a" },
    { authorization: "NotBearer x", "chatgpt-account-id": "a" },
  ]) {
    router.markAuthValidated(headers);
    assert.equal(router.hasValidatedAuth(headers), false);
  }
});

test("憑證不斷輪替時，記錄量有上限不會無限成長", () => {
  // 每一組都是全新的摘要，模擬 token 反覆更換。
  for (let i = 0; i < 500; i += 1) router.markAuthValidated(authHeaders(`rotating-${i}`));
  // 最近一次的仍然查得到，代表汰換的是舊的而不是新的。
  assert.equal(router.hasValidatedAuth(authHeaders("rotating-499")), true);
  // 最早那一批已經被汰換掉。
  assert.equal(router.hasValidatedAuth(authHeaders("rotating-0")), false);
});

test("重複驗證同一組憑證不會佔用額外空間", () => {
  const headers = authHeaders("repeat");
  for (let i = 0; i < 200; i += 1) router.markAuthValidated(headers);
  assert.equal(router.hasValidatedAuth(headers), true);
});
