// 部分中轉站看到 Codex 的 User-Agent 就在伺服器端代為生圖，並把思考深度當成圖片 complexity，
// 不支援時整輪失敗（Complexity 'high' is not supported for this image model）。路由器預設對
// Responses 直通改用自己的 User-Agent；只接受 Codex 用戶端的中轉站自動退回原本的識別。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRouterInDir } from "./helpers/payloads.mjs";

const CODEX_UA = "Codex Desktop/26.1104 (Mac OS 26.1.0; arm64)";
const headers = { authorization: "Bearer fixture", "chatgpt-account-id": "fixture", "session-id": "ua", "user-agent": CODEX_UA };
const route = { pickerSlug: "custom/gpt-test", upstreamModel: "ark/gpt-test", efforts: ["high"], stripReasoning: false };
const completed = `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_ua", status: "completed", output: [] } })}\n\n`;

async function start(t, { guardFile = null } = {}) {
  const { dir, router } = await loadRouterInDir({ routes: [route] });
  if (guardFile !== null) writeFileSync(join(dir, "upstream-image-guard.json"), guardFile);
  router.markAuthValidated(headers);
  const priorKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-key";
  t.after(() => {
    if (priorKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = priorKey;
  });
  const originalFetch = globalThis.fetch;
  router.routerServer.listen(0, "127.0.0.1");
  await once(router.routerServer, "listening");
  t.after(() => new Promise((resolve) => router.routerServer.close(resolve)));
  const port = router.routerServer.address().port;
  const send = async (body = { model: route.pickerSlug, stream: true, reasoning: { effort: "high" }, input: "畫一隻貓" }) => {
    const response = await originalFetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  };
  return { dir, router, send };
}

function mockUpstream(t, respond) {
  const agents = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const agent = new Headers(options.headers).get("user-agent");
    agents.push(agent);
    return respond(agent, String(url));
  });
  return agents;
}

test("預設對第三方 Responses 直通改用路由器自己的 User-Agent", async (t) => {
  const { router, send } = await start(t);
  const agents = mockUpstream(t, () => new Response(completed, { headers: { "content-type": "text/event-stream" } }));
  const result = await send();
  assert.equal(result.status, 200);
  assert.match(result.text, /response.completed/);
  assert.deepEqual(agents, [router.ROUTER_USER_AGENT]);
  assert.match(router.ROUTER_USER_AGENT, /^codex-model-router\//);
  assert.doesNotMatch(router.ROUTER_USER_AGENT, /Codex Desktop|codex_exec|codex_cli_rs/);
});

test("關閉保護時沿用 Codex 原本的 User-Agent", async (t) => {
  const { send } = await start(t, { guardFile: JSON.stringify({ enabled: false }) });
  const agents = mockUpstream(t, () => new Response(completed, { headers: { "content-type": "text/event-stream" } }));
  assert.equal((await send()).status, 200);
  assert.deepEqual(agents, [CODEX_UA]);
});

test("開關檔每次重讀：損壞時維持開啟，改內容不必重啟", async (t) => {
  const { dir, router, send } = await start(t, { guardFile: "{not json" });
  const agents = mockUpstream(t, () => new Response(completed, { headers: { "content-type": "text/event-stream" } }));
  await send();
  writeFileSync(join(dir, "upstream-image-guard.json"), JSON.stringify({ enabled: false }));
  await send();
  assert.deepEqual(agents, [router.ROUTER_USER_AGENT, CODEX_UA]);
});

test("只接受 Codex 用戶端的中轉站：被拒後用原 User-Agent 重送，之後記住這家", async (t) => {
  const { router, send } = await start(t);
  const agents = mockUpstream(t, (agent) => agent === CODEX_UA
    ? new Response(completed, { headers: { "content-type": "text/event-stream" } })
    : new Response(JSON.stringify({ error: { message: "only codex clients" } }), { status: 403, headers: { "content-type": "application/json" } }));
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  assert.deepEqual(agents, [router.ROUTER_USER_AGENT, CODEX_UA, CODEX_UA]);
});

test("Key 本身無效時退回原 User-Agent 仍被拒，不會記住這家", async (t) => {
  const { router, send } = await start(t);
  const agents = mockUpstream(t, () => new Response(JSON.stringify({ error: { message: "bad key" } }),
    { status: 401, headers: { "content-type": "application/json" } }));
  assert.equal((await send()).status, 401);
  assert.equal((await send()).status, 401);
  assert.deepEqual(agents, [router.ROUTER_USER_AGENT, CODEX_UA, router.ROUTER_USER_AGENT, CODEX_UA]);
});
