// 上游 WebSocket 的全域冷卻。
//
// 每條 Codex 連線各自記 upstreamDisabled，所以上游持續 404 時，每個新對話的
// 第一輪都要先賠一次 TLS 連線加握手才回退。冷卻把這個成本收斂成「每個冷卻
// 週期最多一次」，同時不能讓上游恢復後遲遲不回來用。

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { loadRouterWith } from "./helpers/payloads.mjs";

const fresh = (overrides = {}) => loadRouterWith({
  upstreamWebSocketFailureThreshold: 2,
  upstreamWebSocketCooldownMs: 60_000,
  ...overrides,
});

test("預設不在冷卻中", async () => {
  const router = await fresh();
  assert.equal(router.upstreamWebSocketInCooldown(), false);
});

test("單次失敗不觸發冷卻（可能只是暫時的）", async () => {
  const router = await fresh();
  router.noteUpstreamWebSocketConnectFailure();
  assert.equal(router.upstreamWebSocketInCooldown(), false);
});

test("連續失敗達門檻後進入冷卻", async () => {
  const router = await fresh();
  router.noteUpstreamWebSocketConnectFailure();
  router.noteUpstreamWebSocketConnectFailure();
  assert.equal(router.upstreamWebSocketInCooldown(), true);
});

test("冷卻期間反覆詢問都維持擋下（不會自己解除）", async () => {
  const router = await fresh();
  router.noteUpstreamWebSocketConnectFailure();
  router.noteUpstreamWebSocketConnectFailure();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(router.upstreamWebSocketInCooldown(), true, `第 ${i} 次`);
  }
});

test("握手成功會立刻清掉失敗計數，門檻要重新累積", async () => {
  const router = await fresh();
  router.noteUpstreamWebSocketConnectFailure();
  router.noteUpstreamWebSocketConnected();
  router.noteUpstreamWebSocketConnectFailure();
  // 中間成功過，所以這只是「連續第 1 次」失敗。
  assert.equal(router.upstreamWebSocketInCooldown(), false);
});

test("上游恢復後冷卻立即解除，不必等冷卻期滿", async () => {
  const router = await fresh();
  router.noteUpstreamWebSocketConnectFailure();
  router.noteUpstreamWebSocketConnectFailure();
  assert.equal(router.upstreamWebSocketInCooldown(), true);
  router.noteUpstreamWebSocketConnected();
  assert.equal(router.upstreamWebSocketInCooldown(), false);
});

test("冷卻到期會放行探測；再失敗則重新進入冷卻", async () => {
  const router = await fresh({ upstreamWebSocketCooldownMs: 60 });
  router.noteUpstreamWebSocketConnectFailure();
  router.noteUpstreamWebSocketConnectFailure();
  assert.equal(router.upstreamWebSocketInCooldown(), true);

  await sleep(90);
  // 到期後放行一次，且失敗計數歸零，所以下一次失敗又只是「第 1 次」。
  assert.equal(router.upstreamWebSocketInCooldown(), false);

  router.noteUpstreamWebSocketConnectFailure();
  assert.equal(router.upstreamWebSocketInCooldown(), false);
  router.noteUpstreamWebSocketConnectFailure();
  assert.equal(router.upstreamWebSocketInCooldown(), true);
});

test("門檻與冷卻時間可由 settings 覆寫", async () => {
  const router = await fresh({ upstreamWebSocketFailureThreshold: 3 });
  router.noteUpstreamWebSocketConnectFailure();
  router.noteUpstreamWebSocketConnectFailure();
  assert.equal(router.upstreamWebSocketInCooldown(), false);
  router.noteUpstreamWebSocketConnectFailure();
  assert.equal(router.upstreamWebSocketInCooldown(), true);
});

test("無效的設定值退回預設，不會變成永不冷卻或永遠冷卻", async () => {
  for (const bad of [0, -1, "abc", null]) {
    const router = await loadRouterWith({
      upstreamWebSocketFailureThreshold: bad,
      upstreamWebSocketCooldownMs: bad,
    });
    router.noteUpstreamWebSocketConnectFailure();
    assert.equal(router.upstreamWebSocketInCooldown(), false, `${bad}: 第 1 次就冷卻了`);
    router.noteUpstreamWebSocketConnectFailure();
    assert.equal(router.upstreamWebSocketInCooldown(), true, `${bad}: 達預設門檻仍未冷卻`);
  }
});
