// ChatGPT 驗證探測的寬限期。
//
// 自訂模型的請求要先向 chatgpt.com 驗證呼叫端是已登入的 Codex。以前只要 chatgpt.com
// 連不上（網路、代理、官方故障），中轉模型也一起不能用——偏偏那正是最需要中轉當備援
// 的時候。現在同一組憑證在寬限期內真的驗證成功過，探測遇到網路錯誤或 401/403 以外的
// 失敗就放行；401/403 照樣拒絕。

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { loadRouterWith } from "./helpers/payloads.mjs";

const headers = { authorization: "Bearer grace-fixture", "chatgpt-account-id": "grace-account", "session-id": "grace" };
const originalFetch = globalThis.fetch;
const route = { pickerSlug: "custom/gpt-test", upstreamModel: "gpt-test", displayName: "api/gpt-test", efforts: [] };

async function serve(t, settings = {}) {
  const instance = await loadRouterWith({ upstreamWebSocket: false, routes: [route], ...settings });
  instance.routerServer.listen(0, "127.0.0.1");
  await once(instance.routerServer, "listening");
  t.after(() => new Promise((resolve) => instance.routerServer.close(resolve)));
  const previousKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previousKey;
  });
  const state = { probe: "ok", probes: 0 };
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/models")) {
      state.probes += 1;
      if (state.probe === "network") {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
      }
      // 缺 client_version 時官方回 400，路由器視為驗證通過。
      return new Response("", { status: state.probe === "ok" ? 400 : Number(state.probe) });
    }
    return Response.json({ id: "resp_ok", object: "response", status: "completed", output: [] });
  });
  const origin = `http://127.0.0.1:${instance.routerServer.address().port}`;
  return {
    state,
    post: () => originalFetch(`${origin}/v1/responses`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model: "custom/gpt-test", input: [] }),
    }),
    health: () => originalFetch(`${origin}/healthz`).then((response) => response.json()),
  };
}

const minutes = (count) => count * 60 * 1000;

test("驗證成功過的憑證，在 chatgpt.com 連不上時仍可使用中轉模型", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { state, post, health } = await serve(t);
  assert.equal((await post()).status, 200);

  t.mock.timers.tick(minutes(6)); // 短期快取（5 分鐘）過期，下一個請求會重新探測
  state.probe = "network";
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 200, "寬限放行後短期內不再每個請求都探測");
  assert.equal(state.probes, 2);

  t.mock.timers.tick(minutes(6));
  state.probe = "503";
  assert.equal((await post()).status, 200);
  assert.equal((await health()).stats.authProbeGraceUsed, 2);
});

test("401/403 照樣拒絕，而且清掉寬限紀錄", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { state, post } = await serve(t);
  assert.equal((await post()).status, 200);

  t.mock.timers.tick(minutes(6));
  state.probe = "401";
  assert.equal((await post()).status, 401);

  state.probe = "network";
  assert.equal((await post()).status, 502, "被拒過的憑證不能再靠寬限期放行");
});

test("從未驗證成功的憑證沒有寬限", async (t) => {
  const { state, post } = await serve(t);
  state.probe = "network";
  assert.equal((await post()).status, 502);
});

test("寬限期過了就不再放行；也可以在 settings 關掉", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { state, post } = await serve(t);
  assert.equal((await post()).status, 200);
  t.mock.timers.tick(minutes(25 * 60));
  state.probe = "network";
  assert.equal((await post()).status, 502);

  const disabled = await serve(t, { authProbeGraceMs: 0 });
  assert.equal((await disabled.post()).status, 200);
  t.mock.timers.tick(minutes(6));
  disabled.state.probe = "503";
  assert.equal((await disabled.post()).status, 503);
});
