// 重新配置時，暫時性的探測失敗不可以推翻上次已經驗證過的設定。
//
// 真實案例：閘道額度用盡回 503，重跑安裝器就把整條 Claude 路由刪掉，
// 同時砍掉另一個模型的 xhigh；三者其實全都好好的。損失是靜默的——
// 使用者要等到下次想切模型才會發現，而且會誤以為是模型不受支持。
//
// 這裡測的是 install() 實際呼叫的那個函式本身，不是另外抄一份規則。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
const { isTransientProbeStatus, resolveRouteWithPrevious } = installer;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// --- 暫時性的判定 -----------------------------------------------------------

test("額度、容量、逾時、限流都算暫時性", () => {
  for (const status of [0, 408, 429, 500, 502, 503, 504, 520]) {
    assert.equal(isTransientProbeStatus(status), true, `HTTP ${status}`);
  }
});

test("模型真的不支援或無權存取，不算暫時性", () => {
  for (const status of [400, 401, 403, 404, 405, 422]) {
    assert.equal(isTransientProbeStatus(status), false, `HTTP ${status}`);
  }
});

test("今天實際踩到的兩個狀態碼都會被判為暫時性", () => {
  assert.equal(isTransientProbeStatus(503), true, "claude-opus-5: No available accounts");
  assert.equal(isTransientProbeStatus(502), true, "gpt-5.6-sol xhigh: Upstream unavailable");
});

// --- 整條路由的去留 ---------------------------------------------------------

const claudeRoute = {
  upstreamModel: "ark/claude-opus-5",
  translate: "anthropic",
  efforts: EFFORTS,
  maxOutputTokens: 128000,
  contextWindow: 1000000,
};

test("暫時性失敗且有既有設定 -> 整條沿用", () => {
  const result = resolveRouteWithPrevious({ route: null, transient: true }, claudeRoute);
  assert.equal(result.kept, "model");
  // 轉譯層設定與探測到的上限都必須完整帶回來，少一個 Claude 就不會走轉譯。
  assert.deepEqual(result.route, claudeRoute);
});

test("確定不支援 -> 照樣移除，不能無限期沿用舊設定", () => {
  const result = resolveRouteWithPrevious({ route: null, transient: false }, claudeRoute);
  assert.equal(result.route, null);
  assert.equal(result.kept, null);
});

test("全新模型沒有既有設定 -> 不會憑空生出一條", () => {
  for (const previous of [undefined, null]) {
    const result = resolveRouteWithPrevious({ route: null, transient: true }, previous);
    assert.equal(result.route, null);
  }
});

// --- 推理強度的去留 ---------------------------------------------------------

test("暫時失敗的那一檔，若上次驗過就補回來，且順序不跳動", () => {
  const result = resolveRouteWithPrevious(
    {
      route: { upstreamModel: "ark/gpt-5.6-sol", efforts: ["low", "medium", "high", "max"] },
      transient: false,
      transientEfforts: ["xhigh"],
    },
    { upstreamModel: "ark/gpt-5.6-sol", efforts: EFFORTS },
  );
  assert.equal(result.kept, "efforts");
  assert.deepEqual(result.restored, ["xhigh"]);
  assert.deepEqual(result.route.efforts, ["low", "medium", "high", "xhigh", "max"]);
});

test("上次也沒有的那一檔不會被憑空加進來", () => {
  const result = resolveRouteWithPrevious(
    { route: { upstreamModel: "m", efforts: ["low", "medium"] },
      transient: false, transientEfforts: ["xhigh", "max"] },
    { upstreamModel: "m", efforts: ["low", "medium", "max"] },
  );
  assert.deepEqual(result.restored, ["max"]);
  assert.deepEqual(result.route.efforts, ["low", "medium", "max"]);
});

test("確定不支援的那一檔會被移除（不是暫時性就不補）", () => {
  const result = resolveRouteWithPrevious(
    { route: { upstreamModel: "m", efforts: ["low", "medium"] },
      transient: false, transientEfforts: [] },
    { upstreamModel: "m", efforts: EFFORTS },
  );
  assert.equal(result.kept, null);
  assert.deepEqual(result.route.efforts, ["low", "medium"]);
});

test("探測全數成功時直接用最新結果，不受既有設定影響", () => {
  const fresh = { upstreamModel: "m", efforts: EFFORTS };
  const result = resolveRouteWithPrevious(
    { route: fresh, transient: false, transientEfforts: [] },
    { upstreamModel: "m", efforts: ["low"] },
  );
  assert.equal(result.route, fresh);
  assert.equal(result.kept, null);
});

test("沒有 transientEfforts 欄位也不能炸（舊呼叫端／預設值）", () => {
  const route = { upstreamModel: "m", efforts: ["low"] };
  const result = resolveRouteWithPrevious({ route, transient: false }, { upstreamModel: "m", efforts: EFFORTS });
  assert.equal(result.route, route);
});

test("不會就地改動傳進來的既有路由", () => {
  const previous = { upstreamModel: "m", efforts: [...EFFORTS] };
  resolveRouteWithPrevious(
    { route: { upstreamModel: "m", efforts: ["low"] }, transient: false, transientEfforts: ["max"] },
    previous,
  );
  assert.deepEqual(previous.efforts, EFFORTS, "previous 應保持原樣");
});

// --- 今天那一輪重裝的完整重演 -----------------------------------------------

test("用新規則重跑今天那次重裝，三條路由全部保住", () => {
  const previous = [
    claudeRoute,
    { upstreamModel: "ark/gpt-5.6-luna", efforts: EFFORTS },
    { upstreamModel: "ark/gpt-5.6-sol", efforts: EFFORTS },
  ];
  // 當天實際的探測結果：claude 整個 503、sol 的 xhigh 502、luna 全過。
  const outcomes = [
    { route: null, transient: true, transientEfforts: [] },
    { route: { upstreamModel: "ark/gpt-5.6-luna", efforts: EFFORTS },
      transient: false, transientEfforts: [] },
    { route: { upstreamModel: "ark/gpt-5.6-sol", efforts: ["low", "medium", "high", "max"] },
      transient: false, transientEfforts: ["xhigh"] },
  ];

  const routes = outcomes
    .map((outcome, index) => resolveRouteWithPrevious(outcome, previous[index]).route)
    .filter(Boolean);

  assert.equal(routes.length, 3, "三條路由都要留著");
  assert.equal(routes[0].translate, "anthropic", "Claude 的轉譯設定不能掉");
  assert.equal(routes[0].maxOutputTokens, 128000, "探測到的輸出上限不能掉");
  assert.deepEqual(routes[2].efforts, EFFORTS, "sol 的 xhigh 要補回來");
});

test("舊行為的對照：不看既有設定就會掉成兩條、且 sol 少一檔", () => {
  // 這就是 1.9.0 之前實際發生的事，留著當作反例。
  const outcomes = [
    { route: null },
    { route: { upstreamModel: "ark/gpt-5.6-luna", efforts: EFFORTS } },
    { route: { upstreamModel: "ark/gpt-5.6-sol", efforts: ["low", "medium", "high", "max"] } },
  ];
  const naive = outcomes.map((o) => o.route).filter(Boolean);
  assert.equal(naive.length, 2);
  assert.equal(naive.some((r) => r.upstreamModel === "ark/claude-opus-5"), false);
});
