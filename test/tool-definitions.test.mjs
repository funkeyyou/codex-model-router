// 自訂模型沿用官方的工具延後載入（supports_search_tool）、一般函式工具模式的工具搜尋轉譯，
// 以及換模型時清掉舊工具定義。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPayloads, loadRouterWith } from "./helpers/payloads.mjs";

const { installer, router, chat, dir } = await loadPayloads();
const antigravity = await import(pathToFileURL(join(dir, "antigravity-cli.mjs")).href);
const prune = (body) => router.pruneSwitchedToolDefinitions(body);

const official = (slug, extra = {}) => ({ slug, display_name: slug, visibility: "list", priority: 1,
  context_window: 272000, supported_reasoning_levels: [], tool_mode: "code_mode_only", supports_search_tool: true, ...extra });
const templates = [official("gpt-5.6-sol"), official("gpt-6.2-sol"), official("gpt-6.1-terra", { supports_search_tool: false })];
const route = (upstreamModel, extra = {}) => ({ pickerSlug: "custom/" + upstreamModel, upstreamModel,
  displayName: upstreamModel, providerHost: "gateway.example", efforts: ["low", "high"], ...extra });
const neonRoute = route("gemini-4-neon", { translate: "chat", transport: "antigravity-cli", efforts: [] });

test("Code Mode 與 Antigravity CLI 的自訂模型沿用官方的延後載入；其他 Chat 轉譯與組合模型維持關閉", () => {
  const entry = (value) => installer.customCatalogEntry(templates, value, 0);
  assert.equal(entry(route("gpt-6.2-sol")).supports_search_tool, true);
  assert.equal(entry(route("claude-opus-5-5", { translate: "anthropic" })).supports_search_tool, true,
    "沒有同名模板時沿用 gpt-5.6-sol");
  assert.equal(entry(route("gpt-6.1-terra")).supports_search_tool, false, "官方模板沒開就不開");
  const neon = entry(neonRoute);
  assert.equal(neon.tool_mode, undefined);
  assert.equal(neon.supports_search_tool, true, "一般函式工具模式改由路由器轉譯 Codex 的 tool_search");
  assert.equal(entry(route("deepseek-chat", { translate: "chat" })).supports_search_tool, false);
  assert.equal(entry(route("gemini-4-hydrogen", { transport: "combo", combo: {} })).supports_search_tool, false);
  assert.equal(installer.customCatalogEntry([], route("gpt-6.2-sol"), 0).supports_search_tool, false, "獨立模式沒有模板");
});

test("安裝器與路由器的延後載入規則一致", () => {
  const routes = [route("gpt-6.2-sol"), route("claude-opus-5-5", { translate: "anthropic" }), neonRoute,
    route("combo", { transport: "combo" }), route("cli-opus", { transport: "claude-cli", translate: "anthropic" })];
  for (const value of routes) {
    for (const toolMode of ["code_mode_only", undefined]) {
      for (const search of [true, false, undefined]) {
        const entry = { tool_mode: toolMode };
        const template = { supports_search_tool: search };
        assert.equal(router.customToolSearch(value, entry, template), installer.customToolSearch(value, entry, template));
      }
    }
  }
});

test("更新路由器時把既有自訂模型的延後載入對齊官方模板，已對齊時不產生新目錄", () => {
  const gpt = route("gpt-6.2-sol");
  const catalog = { models: [...templates, { ...official(gpt.pickerSlug), supports_search_tool: false },
    { slug: neonRoute.pickerSlug, display_name: "neon", supports_search_tool: false }] };
  const updated = installer.refreshCustomCatalogCapabilities(catalog, [gpt, neonRoute]);
  assert.equal(updated.models.find((model) => model.slug === gpt.pickerSlug).supports_search_tool, true);
  assert.equal(updated.models.find((model) => model.slug === neonRoute.pickerSlug).supports_search_tool, true);
  assert.equal(installer.refreshCustomCatalogCapabilities(updated, [gpt, neonRoute]), updated);
  const turnedOff = { models: [official("gpt-5.6-sol"), official("gpt-6.2-sol", { supports_search_tool: false }),
    updated.models.find((model) => model.slug === gpt.pickerSlug)] };
  assert.equal(installer.refreshCustomCatalogCapabilities(turnedOff, [gpt]).models.at(-1).supports_search_tool, false);
});

test("路由器同步官方清單時，延後載入跟著官方模板開關", () => {
  const gpt = route("gpt-6.2-sol");
  const catalog = { models: [...templates, { ...official(gpt.pickerSlug), supports_search_tool: false }] };
  const synced = router.syncCustomInstructions(catalog, [gpt]);
  assert.equal(synced.models.at(-1).supports_search_tool, true);
  assert.equal(router.syncCustomInstructions(synced, [gpt]), synced, "已同步時不再產生新物件");
  const turnedOff = { models: [official("gpt-5.6-sol"), official("gpt-6.2-sol", { supports_search_tool: false }), synced.models.at(-1)] };
  assert.equal(router.syncCustomInstructions(turnedOff, [gpt]).models.at(-1).supports_search_tool, false);
});

// --- 換模型時清掉舊工具定義 ---
const fn = (name, description = name + " tool") => ({ type: "function", name, description, parameters: { type: "object", properties: {} } });
const custom = (name, description = name + " tool") => ({ type: "custom", name, description });
const ns = (name, tools) => ({ type: "namespace", name, description: name + " tools", tools });
const toolList = (...tools) => ({ type: "additional_tools", role: "developer", tools });
const dev = (text) => ({ type: "message", role: "developer", content: [{ type: "input_text", text }] });
const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistant = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const call = (name, namespace) => ({ type: "function_call", call_id: "call_" + name, name, arguments: "{}",
  ...(namespace ? { namespace } : {}) });
const output = (name) => ({ type: "function_call_output", call_id: "call_" + name, output: "ok" });
const UPDATE = "This is an incremental tools update. Previously declared tools remain available for direct calls " +
  "unless explicitly marked unavailable. If a tool is redefined here, its latest definition replaces the earlier one.";
const switchTo = (model) => dev("<model_instructions>\nThe current model is " + model +
  ".\nThe following instructions replace the previous base instructions:\n\nYou are Codex.");
const unavailable = (namespaces, tools) => dev([
  "The following namespaces are no longer available. Do not call tools in them unless those tools are declared in a later update:",
  ...namespaces.map((name) => "- " + name), "",
  "The following tools are no longer available. Do not call them:",
  ...tools.map((name) => "- " + name)].join("\n"));
const env = user("<environment_context>\n  <current_date>2026-11-27</current_date>\n</environment_context>");

const directTools = toolList(
  ns("functions", [fn("exec_command"), custom("apply_patch"), fn("request_user_input")]),
  ns("web", [fn("run")]),
  ns("mcp__github", [fn("get_profile"), fn("list_repos")]),
);
const history = [directTools, dev("You are Codex."), user("在嗎"), call("exec_command"), output("exec_command"),
  call("run", "web"), output("run"), assistant("在")];
const codeTools = toolList(ns("functions", [custom("exec", "Run JavaScript"), fn("wait")]));
const switchBlock = [dev(UPDATE), codeTools,
  unavailable(["web", "mcp__github"], ["functions.exec_command", "functions.apply_patch"]), switchTo("custom/opus"), env, user("繼續")];

test("換模型時清掉宣告不可用的舊工具，保留歷史裡呼叫過的工具", () => {
  const body = { model: "custom/opus", input: [...history, ...switchBlock] };
  const original = structuredClone(body);
  const result = prune(body);
  assert.equal(result.removed, 3);
  assert.ok(result.chars > 0);
  assert.deepEqual(result.body.input[0].tools.map((tool) => [tool.name, tool.tools.map((child) => child.name)]),
    [["functions", ["exec_command", "request_user_input"]], ["web", ["run"]]]);
  assert.deepEqual(result.body.input.slice(1), body.input.slice(1), "其他項目原封不動");
  assert.deepEqual(body, original, "不改動傳入的請求");
  assert.equal(prune(result.body).removed, 0, "重跑結果相同，之後每一輪送出的內容一致");
});

test("被重新定義的工具只留最新一份；整份清單清空時移除該項目", () => {
  const newCode = toolList(ns("functions", [custom("exec", "new")]));
  const execCall = [{ type: "custom_tool_call", call_id: "c1", name: "exec", input: "text(1)" },
    { type: "custom_tool_call_output", call_id: "c1", output: "1" }];
  const body = { input: [toolList(ns("functions", [custom("exec", "old"), fn("wait")])), user("hi"), ...execCall,
    dev(UPDATE), newCode, switchTo("custom/gpt"), env, user("next")] };
  const result = prune(body);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.body.input[0].tools[0].tools.map((tool) => tool.name), ["wait"]);
  const onlyExec = { input: [toolList(ns("functions", [custom("exec", "old")])), user("hi"), dev(UPDATE), newCode,
    switchTo("custom/gpt"), user("next")] };
  const dropped = prune(onlyExec);
  assert.equal(dropped.body.input.length, onlyExec.input.length - 1);
  assert.deepEqual(dropped.body.input.filter((item) => item.type === "additional_tools"), [newCode]);
});

test("同一個模型補送清單或只更新系統提示詞時不動，避免打斷快取", () => {
  const sameModel = { input: [...history, dev(UPDATE), codeTools, unavailable(["web", "mcp__github"], []), user("繼續")] };
  assert.equal(prune(sameModel).body, sameModel);
  const replaceOnly = dev("<model_instructions>\nThe following instructions replace the previous base instructions:\n\nYou are Codex.");
  const instructionsOnly = { input: [...history, dev(UPDATE), codeTools, unavailable(["web", "mcp__github"], []), replaceOnly, user("繼續")] };
  assert.equal(prune(instructionsOnly).body, instructionsOnly);
  // 換模型之後才補送的清單不會回頭清掉換模型時送的那份。
  const later = { input: [...history, ...switchBlock, assistant("好"), dev(UPDATE),
    toolList(ns("functions", [custom("exec", "newer")])), user("再一次")] };
  const result = prune(later);
  assert.equal(result.removed, 3);
  assert.equal(result.body.input[history.length + 1], codeTools);
});

test("對話開頭的換模型標記與無法辨識的格式原樣保留", () => {
  const start = { input: [codeTools, switchTo("custom/gpt"), user("hi")] };
  assert.equal(prune(start).body, start);
  const nested = toolList(ns("outer", [ns("inner", [fn("x")]), fn("y")]), { type: "web_search" });
  const body = { input: [nested, user("hi"), dev(UPDATE), unavailable(["outer"], []), switchTo("custom/gpt"), user("next")] };
  const result = prune(body);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.body.input[0].tools, [ns("outer", [ns("inner", [fn("x")])]), { type: "web_search" }]);
  const header = "The following tools are no longer available.";
  assert.deepEqual(router.listedUnavailableNames(header + " Do not call them:\n- a.b\n- bad name\n- c.d", header), ["a.b"]);
  assert.deepEqual(router.listedUnavailableNames("unrelated", header), []);
});

test("自訂路由送出時清掉舊定義，官方路由原樣轉送，健康檢查記錄清掉的數量", async (t) => {
  const previousKey = process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = "fixture-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
    else process.env.CODEX_MODEL_ROUTER_TEST_API_KEY = previousKey;
  });
  const gpt = route("gpt-6.2-sol", { pickerSlug: "custom/relay-gpt", stripReasoning: false });
  const instance = await loadRouterWith({ routes: [gpt], upstreamWebSocket: false });
  instance.routerServer.listen(0, "127.0.0.1");
  await once(instance.routerServer, "listening");
  t.after(() => new Promise((resolve) => instance.routerServer.close(resolve)));
  const originalFetch = globalThis.fetch;
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const href = String(url);
    if (href.endsWith("/responses") && options.body) sent.push({ href, body: JSON.parse(String(options.body)) });
    if (href.endsWith("/models")) return Response.json({ models: [] });
    const done = { type: "response.completed", response: { id: "resp", status: "completed", output: [] } };
    return new Response("data: " + JSON.stringify(done) + "\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const headers = { authorization: "Bearer fixture", "chatgpt-account-id": "fixture", "session-id": "switch-prune" };
  const url = new URL("http://127.0.0.1/v1/responses");
  for (const model of [gpt.pickerSlug, "gpt-official"]) {
    const body = { model, input: [...history, ...switchBlock], stream: true };
    const upstream = await instance.fetchModelUpstream({ ...headers, "session-id": "switch-prune-" + model }, url, body,
      Buffer.from(JSON.stringify(body)), undefined, {});
    await upstream.text();
    assert.equal(body.input[0], directTools, "不改動傳入的請求");
  }
  const relay = sent.find((entry) => entry.href === "https://gateway.example/v1/responses").body;
  assert.equal(relay.model, "gpt-6.2-sol");
  assert.deepEqual(relay.input[0].tools.map((tool) => tool.name), ["functions", "web"]);
  const officialBody = sent.find((entry) => entry.href.startsWith("https://chatgpt.example/")).body;
  assert.deepEqual(officialBody.input[0].tools.map((tool) => tool.name), ["functions", "web", "mcp__github"]);
  const health = await originalFetch("http://127.0.0.1:" + instance.routerServer.address().port + "/healthz")
    .then((response) => response.json());
  assert.equal(health.stats.switchToolDefinitionsPruned, 3);
  assert.equal(health.stats.lastSwitchToolPrune.model, gpt.pickerSlug);
  assert.ok(health.stats.switchToolDefinitionCharsPruned > 0);
});

// --- 一般函式工具模式的工具搜尋（Codex 本機執行，路由器只轉譯）---
const searchTool = { type: "tool_search", execution: "client", description: "# Tool discovery\nSearch deferred tools.",
  parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } },
    required: ["query"], additionalProperties: false } };
const directWithSearch = toolList(ns("functions", [fn("exec_command")]), searchTool);
const chatRoute = { upstreamModel: "gemini-4-neon", translate: "chat", transport: "antigravity-cli", efforts: [] };
const searchCall = { type: "tool_search_call", id: "tsc_1", call_id: "call_search", execution: "client", status: "completed",
  arguments: { query: "github login", limit: 3 } };
const searchOutput = { type: "tool_search_output", id: "tso_1", call_id: "call_search", execution: "client", status: "completed",
  tools: [ns("mcp__codex_apps__github", [fn("_get_user_login")])] };

test("Codex 本機執行的工具搜尋轉成同名函式，不列為不支援的平台工具", () => {
  const { request, toolTargets } = chat.toChatRequest({ input: [directWithSearch, user("找 GitHub 工具")] }, chatRoute);
  assert.deepEqual(request.tools.map((tool) => tool.function.name), ["exec_command", "tool_search"]);
  assert.deepEqual(request.tools[1].function.parameters.required, ["query"]);
  assert.equal(toolTargets.get("tool_search").toolSearch, true);
  assert.doesNotMatch(JSON.stringify(request.messages), /tool_search/);
  const hosted = chat.toChatRequest({ input: [toolList(ns("functions", [fn("exec_command")]),
    { ...searchTool, execution: "server" }), user("hi")] }, chatRoute);
  assert.deepEqual(hosted.request.tools.map((tool) => tool.function.name), ["exec_command"]);
  assert.match(JSON.stringify(hosted.request.messages), /tool_search/, "伺服器端搜尋沒有執行器，照舊告知不可用");
});

test("工具搜尋的歷史轉成工具呼叫與結果，載入的工具併進清單並對回原本的命名空間", () => {
  const { request, toolTargets } = chat.toChatRequest(
    { input: [directWithSearch, user("我的 GitHub 帳號？"), searchCall, searchOutput] }, chatRoute);
  const assistantMessage = request.messages.find((message) => message.role === "assistant");
  assert.deepEqual(assistantMessage.tool_calls.map((entry) => [entry.id, entry.function.name, JSON.parse(entry.function.arguments)]),
    [["call_search", "tool_search", { query: "github login", limit: 3 }]]);
  const loaded = request.tools.find((tool) => !["exec_command", "tool_search"].includes(tool.function.name));
  assert.ok(loaded, "載入的工具出現在工具清單");
  assert.deepEqual(toolTargets.get(loaded.function.name), { name: "_get_user_login", namespace: "mcp__codex_apps__github" });
  const toolMessage = request.messages.find((message) => message.role === "tool");
  assert.equal(toolMessage.tool_call_id, "call_search");
  assert.ok(toolMessage.content.includes(loaded.function.name));
  const empty = chat.toChatRequest({ input: [directWithSearch, user("hi"), searchCall, { ...searchOutput, tools: [] }] }, chatRoute);
  assert.match(empty.request.messages.find((message) => message.role === "tool").content, /No matching tools/);
});

const sse = (chunks) => [...chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n"), "data: [DONE]\n\n"];
const delta = (value, finish = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] });
async function runChat(pieces, context) {
  const events = [];
  async function* body() { for (const piece of pieces) yield Buffer.from(piece); }
  await chat.bridgeChatStream(body(), (event) => events.push(event), context);
  return events;
}

test("模型呼叫 tool_search 時回報 tool_search_call，交給 Codex 執行搜尋", async () => {
  const { toolTargets, freeform } = chat.toChatRequest({ input: [directWithSearch, user("hi")] }, chatRoute);
  const events = await runChat(sse([delta({ tool_calls: [{ index: 0, id: "call_ts",
    function: { name: "tool_search", arguments: "{\"query\":\"github login\",\"limit\":3}" } }] }, "tool_calls")]),
  { model: "custom/neon", requestBody: {}, freeform, toolTargets });
  assert.ok(events.some((event) => event.type === "response.output_item.added" && event.item.type === "tool_search_call"));
  const done = events.find((event) => event.type === "response.output_item.done" && event.item.type === "tool_search_call");
  const { id, ...item } = done.item;
  assert.match(id, /^tsc_/);
  assert.deepEqual(item, { type: "tool_search_call", status: "completed", call_id: "call_ts", execution: "client",
    arguments: { query: "github login", limit: 3 } });
  assert.equal(events.some((event) => event.item?.type === "function_call" || event.type.startsWith("response.function_call")), false);
  assert.equal(events.find((event) => event.type === "response.completed").response.output[0].type, "tool_search_call");
});

test("Antigravity CLI 的提示列出 tool_search，搜到的工具在後續回合補進清單", () => {
  const first = chat.toChatRequest({ input: [directWithSearch, user("我的 GitHub 帳號？")] }, chatRoute).request;
  assert.match(antigravity.antigravityPrompt(first).system, /"name":"tool_search"/);
  const later = chat.toChatRequest({ input: [directWithSearch, user("我的 GitHub 帳號？"), searchCall, searchOutput] }, chatRoute).request;
  assert.match(antigravity.antigravityPrompt(later).system, /_get_user_login/);
});

test("轉譯層替工具搜尋鑄的 id 在送往其他上游前拿掉，Codex 自己的 id 保留", () => {
  const minted = { ...searchCall, id: "tsc_ihk9xOf9CojEklLLSYjgjIQyy2A4MafToZFWO6WblSJl1aNnIH" };
  const codexOutput = { ...searchOutput, id: "tso_01a21c6b-30cc-7de0-8274-eb5715c04a58" };
  assert.equal(router.isBridgeMintedId(minted.id), true);
  assert.equal(router.isBridgeMintedId(codexOutput.id), false);
  const { input, removed } = router.stripBridgeItemIds([minted, codexOutput]);
  assert.equal(removed, 1);
  assert.equal("id" in input[0], false);
  assert.equal(input[0].call_id, "call_search");
  assert.equal(input[1], codexOutput);
});
