// 組合模型：大腦規劃、雙手執行。路由器把一輪拆成數次內部請求，合成一個 Responses 串流。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { router, installer, chat } = await loadPayloads();

const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const developerTexts = (input) => input.filter((item) => item.type === "message" && item.role === "developer").map((item) => item.content[0].text);
const userTexts = (input) => input.filter((item) => item.type === "message" && item.role === "user").map((item) => item.content[0].text);

test("計畫插在使用者訊息之後、問答插在錨點之後；欄位差異（id、status）不影響位置", () => {
  const ask = user("修好登入");
  const call = { type: "function_call", call_id: "c1", name: "shell", arguments: "{}", id: "fc_1", status: "completed" };
  const output = { type: "function_call_output", call_id: "c1", output: "ok" };
  const input = [user("<environment_context>x</environment_context>"), ask, call, output];
  const prints = input.map(router.comboFingerprint);
  const conversation = { turns: [{ anchor: { fp: prints[1], nth: 0 }, plan: "PLAN", reviews: 0,
    notes: [{ anchor: { fp: prints[2], nth: 0 }, text: "NOTE" }] }] };
  const injected = router.comboInjectInput(input, conversation);
  assert.deepEqual(injected.map((item) => item.role === "developer" ? item.content[0].text : item.type + ":" + (item.call_id || item.role)),
    ["message:user", "message:user", "PLAN", "function_call:c1", "NOTE", "function_call_output:c1"]);
  // WebSocket 重播的項目沒有 id／status，位置仍相同。
  const { id, status, ...bare } = call;
  assert.deepEqual(developerTexts(router.comboInjectInput([input[0], ask, bare, output], conversation)), ["PLAN", "NOTE"]);
  // 錨點已不存在（例如被精簡）時略過，不亂插。
  assert.equal(router.comboInjectInput([user("別的")], conversation).length, 1);
});

test("只把真正的使用者輸入當成新回合；驗收結果與直通判斷", () => {
  assert.equal(router.isComboUserMessage(user("<environment_context>cwd</environment_context>")), false);
  assert.equal(router.isComboUserMessage(user("  修好登入")), true);
  assert.equal(router.isComboUserMessage({ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:" }] }), true);
  assert.equal(router.isComboUserMessage({ type: "function_call_output", call_id: "c", output: "x" }), false);
  assert.equal(router.comboReviewVerdict("APPROVED\n沒問題"), "approved");
  assert.equal(router.comboReviewVerdict("**REVISE**\n補測試"), "revise");
  assert.equal(router.comboReviewVerdict("看起來可以"), "approved");
  const tools = [{ type: "function", name: "shell" }];
  assert.equal(router.comboDirectRequest({ input: [user("hi")], tools }, null), false);
  assert.equal(router.comboDirectRequest({ input: [user("hi")], tools }, "title"), true);
  assert.equal(router.comboDirectRequest({ input: [user("hi")], tools: [] }, null), true);
  // Codex 實際的形狀：頂層 tools 為空，工具放在 input 的 additional_tools。
  const additional = { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "shell" }] }] };
  assert.equal(router.comboDirectRequest({ input: [additional, user("hi")], tools: [] }, null), false);
  assert.equal(router.comboDirectRequest({ input: [additional, user("hi")] }, null), false);
  assert.equal(router.comboDirectRequest({ input: [user("hi")], tools, text: { format: { type: "json_schema" } } }, null), true);
  assert.equal(router.comboDirectRequest({ input: [{ type: "compaction_trigger" }, user("hi")], tools }, null), true);
  // 給大腦的指令在規劃、詢問與驗收都會帶入；舊版的 criteria 欄位照樣讀得到。
  for (const kind of ["plan", "consult", "review-strict"]) {
    assert.match(router.comboPlannerInstruction(kind, { combo: { instructions: "不要改 public API" }, executor: { displayName: "neon" } }),
      /<planner_instructions>\n不要改 public API\n<\/planner_instructions>/);
  }
  assert.match(router.comboPlannerInstruction("review-strict", { combo: { criteria: "npm test 要過" }, executor: { displayName: "neon" } }),
    /npm test 要過[\s\S]*actual tool output[\s\S]*REVISE/);
});

test("自訂模型的提示詞跟著官方模板同步，兩個欄位都換成上游模型的身分句", () => {
  const template = (version) => ({
    base_instructions: "You are Codex, an agent based on GPT-6. You and the user share a workspace. v" + version,
    model_messages: { instructions_template: "You are Codex, an agent based on GPT-6. You and the user share a workspace. v" + version, approvals: { v: version } },
  });
  const catalog = { models: [
    { slug: "gpt-6.2-sol", visibility: "list", ...template(2) },
    { slug: "gpt-5.6-sol", visibility: "list", ...template(5) },
    { slug: "custom/ark-gpt-6.2-sol", ...template(1) },
    { slug: "custom/claude", ...template(1) },
    { slug: "custom/unrouted", ...template(1) },
  ] };
  const routes = [{ pickerSlug: "custom/ark-gpt-6.2-sol", upstreamModel: "ark/gpt-6.2-sol" },
    { pickerSlug: "custom/claude", upstreamModel: "claude-opus-5-5" }];
  const synced = router.syncCustomInstructions(catalog, routes);
  const bySlug = new Map(synced.models.map((model) => [model.slug, model]));
  assert.match(bySlug.get("custom/ark-gpt-6.2-sol").model_messages.instructions_template, /^You are Codex, an agent based on gpt-6\.2-sol\. .* v2$/);
  assert.match(bySlug.get("custom/ark-gpt-6.2-sol").base_instructions, /based on gpt-6\.2-sol\. .* v2$/);
  assert.match(bySlug.get("custom/claude").model_messages.instructions_template, /^You are Codex, an agent based on claude-opus-5-5\. .* v5$/);
  assert.deepEqual(bySlug.get("custom/claude").model_messages.approvals, { v: 5 });
  assert.equal(bySlug.get("custom/unrouted"), catalog.models[4], "沒有路由的項目不動");
  assert.equal(router.syncCustomInstructions(synced, routes), synced, "已同步時不再產生新物件");
  // 安裝器新增模型時也改到 model_messages。
  const messages = installer.modelIdentityMessages(template(1).model_messages, { upstreamModel: "deepseek-flash" });
  assert.match(messages.instructions_template, /^You are Codex, an agent based on deepseek-flash\./);
});

const plannerRoute = { pickerSlug: "custom/planner", upstreamModel: "planner-model", displayName: "api/planner-model",
  providerHost: "gateway.example", efforts: ["low", "medium", "high"], contextWindow: 1000000 };
const executorRoute = { pickerSlug: "custom/executor", upstreamModel: "exec-model", displayName: "api/exec-model",
  providerHost: "gateway.example", efforts: ["low", "medium", "high", "xhigh"], contextWindow: 400000, translate: "chat" };
const agyRoute = { pickerSlug: "custom/agy", upstreamModel: "gemini-4-neon", displayName: "antigravity-cli/gemini-4-neon",
  providerId: "antigravity-cli", transport: "antigravity-cli", translate: "chat", efforts: ["low", "high"] };
const catalogFor = (routes) => ({ models: [
  { slug: "gpt-5.6-sol", visibility: "list", priority: 1, context_window: 272000, tool_mode: "code" },
  ...routes.map((route, index) => ({ slug: route.pickerSlug, display_name: route.displayName, priority: 10 + index,
    context_window: route.contextWindow || 272000, input_modalities: ["text", "image"], visibility: "list" })),
] });

test("建立與修改組合：成員檢查、上下文取較小值、推理強度跟隨雙手、刪除成員時連帶刪除", () => {
  const routes = [plannerRoute, executorRoute, agyRoute];
  const settings = { routes, port: 1 };
  const manifest = { routes, version: "1.0.0" };
  const catalog = catalogFor(routes);
  const input = { name: "Opus 規劃 + Neon", planner: { slug: "custom/planner", effort: "high" }, executor: { slug: "custom/executor" }, review: "strict", instructions: "npm test" };
  const plan = installer.planSaveCombo(manifest, settings, catalog, input);
  const { route } = plan;
  assert.equal(route.transport, "combo");
  assert.match(route.pickerSlug, /^custom\/combo-Opus-Neon-[0-9a-f]{8}$/);
  assert.equal(route.contextWindow, 400000);
  assert.deepEqual(route.efforts, executorRoute.efforts);
  assert.deepEqual(route.combo, { planner: { slug: "custom/planner", effort: "high" }, executor: { slug: "custom/executor" },
    review: "strict", instructions: "npm test", executorTranslate: "chat", inputModalities: ["text", "image"] });
  assert.equal(installer.planSaveCombo(manifest, settings, catalog, { ...input, instructions: undefined, criteria: "舊欄位" }).route.combo.instructions, "舊欄位");
  assert.throws(() => installer.planSaveCombo(manifest, settings, catalog, { ...input, instructions: "x".repeat(4001) }), /4000/);
  const entry = plan.catalog.models.find((model) => model.slug === route.pickerSlug);
  assert.equal(entry.display_name, "Opus 規劃 + Neon");
  assert.equal(entry.context_window, 400000);
  assert.deepEqual(entry.supported_reasoning_levels.map((level) => level.effort), executorRoute.efforts);
  assert.equal(entry.priority, 13);

  const edited = installer.planSaveCombo(manifest, plan.settings, plan.catalog, { ...input, slug: route.pickerSlug, review: "off" });
  assert.equal(edited.created, false);
  assert.equal(edited.route.pickerSlug, route.pickerSlug);
  assert.equal(edited.catalog.models.find((model) => model.slug === route.pickerSlug).priority, 13);
  assert.equal(edited.settings.routes.filter((item) => item.transport === "combo").length, 1);

  // Antigravity CLI 可以當大腦或雙手；推理強度跟著 agy 模型。
  const agyCombo = installer.planSaveCombo(manifest, settings, catalog, { ...input, name: "agy", planner: { slug: "custom/agy", effort: "high" }, executor: { slug: "custom/agy" } });
  assert.deepEqual(agyCombo.route.efforts, agyRoute.efforts);
  assert.equal(agyCombo.route.combo.planner.effort, "high");
  assert.throws(() => installer.planSaveCombo(manifest, settings, catalog, { ...input, planner: { slug: "custom/planner", effort: "xhigh" } }), /xhigh/);
  assert.throws(() => installer.planSaveCombo(manifest, plan.settings, plan.catalog, { ...input, planner: { slug: route.pickerSlug } }), /組合/);
  assert.throws(() => installer.planSaveCombo(manifest, plan.settings, plan.catalog, input), /已經有/);

  const removed = installer.planRemoveModels(manifest, plan.settings, plan.catalog, ["custom/planner"]);
  assert.deepEqual(removed.removed.map((item) => item.pickerSlug).sort(), ["custom/planner", route.pickerSlug].sort());
  assert.equal(removed.catalog.models.some((model) => model.slug === route.pickerSlug), false);
  assert.throws(() => installer.planEditModel(manifest, plan.settings, plan.catalog, route.pickerSlug, { displayName: "x" }), /組合模型/);
  assert.equal(installer.fastConfigurable(route), false);
  assert.equal(installer.effortsConfigurable(route), false);
});

// ---- 端到端：假上游 + 真路由器 ---------------------------------------------------
const comboRoute = { pickerSlug: "custom/combo-x", displayName: "Combo X", upstreamModel: "exec-model", providerId: "combo",
  providerHost: "組合模型", transport: "combo", efforts: ["low", "medium", "high"],
  combo: { planner: { slug: "custom/planner-e2e", effort: "high" }, executor: { slug: "custom/executor-e2e" }, review: "standard" } };
const plannerE2E = { pickerSlug: "custom/planner-e2e", upstreamModel: "planner-model", displayName: "api/planner-model",
  providerHost: "gateway.example", efforts: ["low", "medium", "high"], stripReasoning: false, contextWindow: null };
const executorE2E = { ...plannerE2E, pickerSlug: "custom/executor-e2e", upstreamModel: "exec-model", displayName: "api/exec-model" };

const sse = (events) => new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""),
  { headers: { "content-type": "text/event-stream" } });
const usage = { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 0 } };
function textReply(id, text) {
  const item = { id: "msg_" + id, type: "message", role: "assistant", content: [{ type: "output_text", text }] };
  return sse([{ type: "response.created", response: { id, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output: [item], usage } }]);
}
function callReply(id, name, args, callId) {
  const item = { id: "fc_" + id, type: "function_call", name, arguments: JSON.stringify(args), call_id: callId, status: "completed" };
  return sse([{ type: "response.created", response: { id, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output: [item], usage } }]);
}

async function readEvents(response) {
  const text = await response.text();
  return text.split(/\n\n/).map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter(Boolean).map((line) => JSON.parse(line.slice(6)));
}

test("端到端：規劃、詢問大腦、工具呼叫、驗收打回再通過，Codex 只看到一個連續的回應", async (t) => {
  const previousKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previousKey;
  });
  const instance = await loadRouterWith({ upstreamWebSocket: false, usageLog: false, routes: [plannerE2E, executorE2E, comboRoute] });
  instance.routerServer.listen(0, "127.0.0.1");
  await once(instance.routerServer, "listening");
  t.after(() => new Promise((resolve) => instance.routerServer.close(resolve)));
  const origin = "http://127.0.0.1:" + instance.routerServer.address().port;
  const realFetch = globalThis.fetch;
  const calls = [];
  const executorReplies = [
    () => callReply("e1", "ask_planner", { question: "要改哪個檔案？" }, "ask1"),
    () => callReply("e2", "shell", { cmd: "ls" }, "c1"),
    () => textReply("e3", "改好了"),
    () => textReply("e4", "補上測試，真的改好了"),
  ];
  const plannerReplies = [() => textReply("p1", "PLAN-1"), () => textReply("p2", "ANSWER-1"),
    () => textReply("p3", "REVISE\n補測試"), () => textReply("p4", "APPROVED")];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const href = String(url);
    if (href.startsWith("http://127.0.0.1")) return realFetch(url, options);
    if (href.endsWith("/models")) return Response.json({ models: [] });
    const body = JSON.parse(String(options.body));
    calls.push(body);
    return (body.model === "planner-model" ? plannerReplies : executorReplies).shift()();
  });
  const headers = { "content-type": "application/json", authorization: "Bearer fixture", "chatgpt-account-id": "acct", "session-id": "combo-e2e" };
  // Codex 的實際形狀：工具放在 input 的 additional_tools，頂層沒有 tools。
  const additional = { type: "additional_tools", role: "developer",
    tools: [{ type: "namespace", name: "functions", description: "Tools.", tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: {} } }] }] };
  const first = [additional, user("<environment_context>cwd</environment_context>"), user("修好登入")];
  const post = (input) => realFetch(origin + "/v1/responses", { method: "POST", headers,
    body: JSON.stringify({ model: comboRoute.pickerSlug, input, reasoning: { effort: "medium" }, stream: true, prompt_cache_key: "conv-1" }) });

  const events1 = await readEvents(await post(first));
  const done1 = events1.filter((event) => event.type === "response.output_item.done").map((event) => event.item);
  assert.deepEqual(done1.map((item) => item.type === "reasoning" ? item.summary[0].text.split("\n")[0] : item.name),
    ["**大腦規劃 · api/planner-model（high）**", "**詢問大腦 · api/planner-model（high）**", "shell"]);
  assert.match(done1[0].summary[0].text, /PLAN-1/);
  assert.match(done1[1].summary[0].text, /要改哪個檔案？[\s\S]*ANSWER-1/);
  assert.ok(!events1.some((event) => event.item?.name === "ask_planner"), "ask_planner 不能出現在 Codex 的串流");
  assert.deepEqual(events1.filter((event) => event.type === "response.output_item.added").map((event) => event.output_index), [0, 1, 2]);
  const completed1 = events1.at(-1);
  assert.equal(completed1.type, "response.completed");
  assert.equal(completed1.response.model, comboRoute.pickerSlug);
  assert.equal(events1.filter((event) => event.type === "response.created").length, 1);

  const [planCall, exec1, consultCall, exec2] = calls;
  assert.equal(planCall.model, "planner-model");
  assert.equal(planCall.reasoning.effort, "high");
  assert.equal(planCall.tools, undefined, "大腦收到的工具與 Codex 相同（只有 additional_tools）");
  assert.equal(planCall.input[0].type, "additional_tools");
  assert.match(userTexts(planCall.input).at(-1), /PLANNER[\s\S]*Write the plan/);
  assert.deepEqual(developerTexts(planCall.input), [], "給大腦的指令不用開發者訊息，Chat 轉譯才不會把它併進 system");
  assert.equal(exec1.model, "exec-model");
  assert.equal(exec1.reasoning.effort, "medium", "雙手的推理強度跟隨 Codex 選擇器");
  assert.deepEqual(exec1.tools.map((tool) => tool.name), ["ask_planner"]);
  assert.equal(exec1.input[3].role, "developer", "計畫緊接在使用者訊息之後");
  assert.match(exec1.input[3].content[0].text, /PLAN-1[\s\S]*EXECUTOR/);
  assert.match(userTexts(consultCall.input).at(-1), /要改哪個檔案？/);
  // 雙手的視角：ask_planner 的呼叫與大腦的回答照原樣放回，和它實際產生的歷史一致。
  const askIndex = exec2.input.findIndex((item) => item.type === "function_call" && item.name === "ask_planner");
  assert.ok(askIndex > 0);
  assert.deepEqual(exec2.input[askIndex + 1], { type: "function_call_output", call_id: "ask1", output: "ANSWER-1" });
  assert.ok(!exec2.input.some((item) => item.type === "reasoning"), "路由器的思考摘要不送給上游");

  // 第二次請求：Codex 帶回完整歷史與工具結果，雙手交出回答，驗收打回一次後通過。
  const second = [...first, ...completed1.response.output, { type: "function_call_output", call_id: "c1", output: "a.js" }];
  const events2 = await readEvents(await post(second));
  const done2 = events2.filter((event) => event.type === "response.output_item.done").map((event) => event.item);
  assert.deepEqual(done2.map((item) => item.type === "reasoning" ? item.summary[0].text.split("\n")[0] : item.content[0].text),
    ["改好了", "**大腦驗收（一般）· api/planner-model（high）**", "補上測試，真的改好了", "**大腦驗收（一般）· api/planner-model（high）**"]);
  assert.match(done2[1].summary[0].text, /REVISE[\s\S]*補測試/);
  assert.match(done2[3].summary[0].text, /APPROVED/);
  assert.equal(events2.at(-1).type, "response.completed");
  const exec3 = calls[4];
  const exec4 = calls[6];
  assert.deepEqual(developerTexts(exec3.input).length, 1, "第二次請求仍帶回同一份計畫");
  assert.equal(exec3.input[3].content[0].text, exec1.input[3].content[0].text);
  assert.deepEqual(exec3.input.slice(0, exec2.input.length).map((item) => JSON.stringify(item)),
    exec2.input.map((item) => JSON.stringify(item)), "雙手的請求只往後增加");
  assert.match(developerTexts(exec4.input).at(-1), /not accepted yet[\s\S]*補測試/);
  // 大腦的視角：每次都是上一次請求加上它的回答，再接新的對話與指示，只往後增加。
  const plannerCalls = calls.filter((call) => call.model === "planner-model");
  assert.equal(plannerCalls.length, 4);
  const answers = ["PLAN-1", "ANSWER-1", "REVISE\n補測試"];
  for (let index = 1; index < plannerCalls.length; index += 1) {
    const previous = plannerCalls[index - 1].input;
    const next = plannerCalls[index].input;
    assert.deepEqual(next.slice(0, previous.length).map((item) => JSON.stringify(item)), previous.map((item) => JSON.stringify(item)),
      `第 ${index + 1} 次問大腦要延續第 ${index} 次`);
    assert.equal(next[previous.length].role, "assistant");
    assert.equal(next[previous.length].content[0].text, answers[index - 1]);
    assert.equal(next[previous.length + 1].role, "user", "回答後面接分隔訊息");
  }
  // 轉成 Chat Completions 後（Antigravity CLI 與 Chat 路由看到的形狀）也必須是延續：前一次的訊息
  // 加上大腦的回答，是下一次的開頭。比對方式與 Antigravity CLI 判斷能否續接的規則相同。
  const chatRoute = { upstreamModel: "planner-model", translate: "chat", efforts: [] };
  const asChat = (body) => chat.toChatRequest(body, chatRoute).request.messages.map((message) => message.role === "assistant"
    ? { role: "assistant", calls: (message.tool_calls || []).map((call) => call.id) }
    : { role: message.role, content: JSON.stringify(message.content), id: message.tool_call_id ?? null });
  for (let index = 1; index < plannerCalls.length; index += 1) {
    const previous = [...asChat(plannerCalls[index - 1]), { role: "assistant", calls: [] }];
    const next = asChat(plannerCalls[index]);
    assert.ok(next.length > previous.length, `第 ${index + 1} 次 Chat 訊息要比上一次多`);
    assert.deepEqual(next.slice(0, previous.length), previous, `第 ${index + 1} 次轉成 Chat 後仍延續第 ${index} 次`);
  }
  assert.equal(plannerReplies.length, 0);
  assert.equal(executorReplies.length, 0);
  const health = await realFetch(origin + "/healthz").then((response) => response.json());
  assert.equal(health.stats.comboPlans, 1);
  assert.equal(health.stats.comboConsults, 1);
  assert.equal(health.stats.comboReviews, 2);
  assert.equal(health.stats.comboRevisions, 1);
});

test("背景任務直接交給雙手，不呼叫大腦", async (t) => {
  const previousKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previousKey;
  });
  const instance = await loadRouterWith({ upstreamWebSocket: false, usageLog: false, routes: [plannerE2E, executorE2E, comboRoute] });
  instance.routerServer.listen(0, "127.0.0.1");
  await once(instance.routerServer, "listening");
  t.after(() => new Promise((resolve) => instance.routerServer.close(resolve)));
  const realFetch = globalThis.fetch;
  const models = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const href = String(url);
    if (href.startsWith("http://127.0.0.1")) return realFetch(url, options);
    if (href.endsWith("/models")) return Response.json({ models: [] });
    models.push(JSON.parse(String(options.body)).model);
    return textReply("t1", "標題");
  });
  const title = "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task.";
  const response = await realFetch("http://127.0.0.1:" + instance.routerServer.address().port + "/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture", "chatgpt-account-id": "acct" },
    body: JSON.stringify({ model: comboRoute.pickerSlug, input: [user(title)], tools: [{ type: "function", name: "shell" }], stream: true }),
  });
  const events = await readEvents(response);
  assert.equal(events.at(-1).type, "response.completed");
  assert.deepEqual(models, ["exec-model"]);
});
