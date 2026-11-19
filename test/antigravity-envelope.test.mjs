import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { antigravityFailureKind, envelopeText, parseAntigravityEnvelope } from "../src/antigravity-cli.mjs";
import { loadPayloads, loadRouterInDir } from "./helpers/payloads.mjs";
import { codexBin } from "./helpers/codex-bin.mjs";

const fence = raw => "```json\n" + raw + "\n```";
const bareQuote = '{"text":"範例：read("label","value")。後續說明。","calls":[]}';
const answer = '範例：read("label","value")。後續說明。';
const quotedCode = String.raw`{"text":"Existing \"quote\" and \u4f60. Match ^\s* then \u12z.\n", "calls" : [ ] }`;
const argument = String.raw`^\s*"label"$`;
const validTool = JSON.stringify({ text: "先檢查這個模式。", calls: [{ name: "lookup", arguments: { pattern: argument } }] });
const brokenTool = String.raw`{"text":"Looking up","calls":[{"name":"lookup","arguments":{"pattern":"^\s* PRIVATE_FIXTURE"}}]}`;
const repeated = fence(validTool) + "\n" + fence(validTool);
const contextFailure = "\n⚠ agent executor error: generating and executing: serializing trajectory: no messages fit within the context token budget\n";
const zeroBudgetFailure = "\n⚠ agent executor error: generating and executing: serializing trajectory: maxMessageTokens must be positive, got 0\n";
const executorFailure = "\n⚠ agent executor error: unknown failure PRIVATE_FIXTURE\n";

function rejectsAs(raw, kind) {
  assert.throws(() => parseAntigravityEnvelope(raw), error =>
    error instanceof SyntaxError && antigravityFailureKind(error, { stage: "parse_response" }) === kind);
}

test("valid Antigravity envelopes keep all escapes and tool arguments unchanged", () => {
  const validText = '文字 "hello"\\folder\n下一行\t🙂';
  for (const raw of [JSON.stringify({ text: validText, calls: [] }), fence(validTool)]) {
    const parsed = parseAntigravityEnvelope(raw);
    assert.equal(parsed.recovered, false);
    assert.equal(parsed.reply.text, envelopeText(raw));
    if (parsed.reply.calls.length) assert.equal(parsed.reply.calls[0].arguments.pattern, argument);
    else assert.equal(parsed.reply.text, validText);
  }
});

test("Antigravity repairs only invalid text escaping while preserving the streamed prefix", () => {
  for (const [raw, expected] of [
    [bareQuote, answer],
    [fence(bareQuote), answer],
    [quotedCode, 'Existing "quote" and 你. Match ^\\s* then \\u12z.\n'],
    ['{"text":"first\nsecond\tline","calls":[]}', "first\nsecond\tline"],
    [String.raw`{"text":"Write ("x") and (\"y\") after a slash \\.","calls":[]}`, 'Write ("x") and ("y") after a slash \\.'],
  ]) {
    const { reply, recovered } = parseAntigravityEnvelope(raw);
    assert.equal(recovered, true);
    assert.deepEqual(reply, { text: expected, calls: [] });
    assert.ok(reply.text.startsWith(envelopeText(raw)));
  }
});

test("Antigravity refuses to repair tool arguments, competing boundaries or extra envelopes", () => {
  rejectsAs(brokenTool, "invalid_tool_call_json");
  rejectsAs(repeated, "extra_response_content");
  rejectsAs(validTool + bareQuote, "extra_response_content");
  rejectsAs('{"text":"done","calls":[]} trailing bytes', "extra_response_content");
  for (const raw of [
    bareQuote.replace("[]", '[{"name":"lookup","arguments":{}}]'),
    bareQuote.replace("[]", '[],"other":0'),
    bareQuote.slice(0, -1),
    '{"text":"Broken "quote""}' + bareQuote,
    bareQuote + '{"text":"another reply","calls":[]}',
    '{"text":"example: ","calls":[] then trailing text","calls":[]}',
    '{"text":"other: ","other":true and a fake ending","calls":[]}',
    '{"text":"missing ' + 'x'.repeat(1024 * 1024) + ' "quote"","calls":[]}',
  ]) rejectsAs(raw, "invalid_response_json");
});

test("Antigravity CLI executor error banners distinguish context budget failures from JSON", () => {
  assert.equal(contextFailure.length, 123, "matches the observed failed turn length");
  assert.equal(zeroBudgetFailure.length, 116, "matches the isolated real CLI capacity probe");
  for (const [raw, code] of [
    [contextFailure, "context_length_exceeded"], [zeroBudgetFailure, "context_length_exceeded"],
    [contextFailure.replace("⚠", "⚠️"), "context_length_exceeded"],
    [executorFailure, "cli_execution_error"],
  ]) {
    assert.equal(envelopeText(raw), "", "CLI errors are not answer text");
    assert.throws(() => parseAntigravityEnvelope(raw), error => {
      assert.equal(antigravityFailureKind(error, { stage: "parse_response" }), code);
      assert.doesNotMatch(error.message, /PRIVATE_FIXTURE|serializing trajectory/);
      return true;
    });
  }
  const valid = JSON.stringify({ text: contextFailure, calls: [] });
  assert.deepEqual(parseAntigravityEnvelope(valid), { reply: { text: contextFailure, calls: [] }, recovered: false });
  rejectsAs(valid.slice(0, -1), "invalid_response_json");
  rejectsAs(contextFailure + validTool, "invalid_response_json");
  rejectsAs("Quoted warning: " + contextFailure, "invalid_response_json");
});

// Run the *embedded* router and a fixture ACP process, including on Windows (no shebang or
// .cmd needed). `node acp` treats `acp` in the isolated CLI cwd as the fixture entry point.
test("Antigravity ACP recovery and error codes reach Codex Responses events, logs and usage", { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "agy-envelope-test-"));
  const env = Object.fromEntries(["TEMP", "TMP", "TMPDIR"].map(name => [name, process.env[name]]));
  Object.keys(env).forEach(name => { process.env[name] = root; });
  let server, agy;
  t.after(async () => {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    agy?.closeAntigravitySessions();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    // Windows can keep the killed fixture's working directory locked until process exit.
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const workspace = join(root, "codex-model-router-agy");
  await mkdir(workspace);
  const replies = { recover: bareQuote, bad_calls: brokenTool, repeated, valid: validTool, bad_json: '{"text":"PRIVATE_FIXTURE',
    context: contextFailure, zero_budget: zeroBudgetFailure, executor: executorFailure };
  await writeFile(join(workspace, "acp"), `
const replies = ${JSON.stringify(replies)};
const send = event => process.stdout.write(JSON.stringify({jsonrpc: "2.0", ...event}) + "\\n");
require("node:readline").createInterface({input: process.stdin}).on("line", line => {
  const {id, method, params} = JSON.parse(line);
  const result = value => send({id, result: value});
  if (method === "initialize") return result({agentCapabilities: {_meta: {antigravity: {systemPrompt: {append: true}}}}});
  if (method === "session/new") return result({sessionId: "fixture"});
  if (method === "session/set_model") return result({});
  if (method !== "session/prompt") return;
  const input = params.prompt[0].text;
  const update = value => send({method: "session/update", params: {sessionId: "fixture", update: value}});
  if (input.includes("FIXTURE_LOCAL")) return update({sessionUpdate: "tool_call"});
  if (input.includes("FIXTURE_TIMEOUT")) return;
  if (input.includes("FIXTURE_RATE")) return send({id, error: {code: -32603, message: "HTTP 429 PRIVATE_FIXTURE"}});
  const raw = replies[/FIXTURE_REPLY_([a-z_]+)/.exec(input)?.[1]];
  if (typeof raw !== "string") return send({id, error: {code: -32603, message: "unknown fixture input"}});
  update({sessionUpdate: "agent_thought_chunk", content: {type: "text", text: "checking fixture"}});
  const chunk = text => update({sessionUpdate: "agent_message_chunk", content: {type: "text", text}});
  chunk(raw.slice(0, 15));
  setTimeout(() => { chunk(raw.slice(15)); result({stopReason: "end_turn", usage: {outputTokens: 5}}); }, 10);
});
`);
  const slug = "custom/agy-fixture";
  const { dir, router } = await loadRouterInDir({ antigravityCli: { binary: process.execPath }, upstreamWebSocket: false,
    routes: [{ pickerSlug: slug, upstreamModel: "fixture", providerId: "antigravity-cli", providerHost: "Antigravity CLI",
      translate: "chat", transport: "antigravity-cli", efforts: [], defaultCliModel: "fixture" }] });
  agy = await import(pathToFileURL(join(dir, "antigravity-cli.mjs")).href);
  const { installer } = await loadPayloads();
  const stderr = [], write = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, "write", (data, ...args) => {
    if (String(data).startsWith("model-router-")) { stderr.push(String(data)); return true; }
    return write(data, ...args);
  });
  const localFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(String(url), "https://chatgpt.example/backend-api/codex/models", "no real upstream calls");
    return new Response("missing client_version", { status: 400 });
  });
  const timer = globalThis.setTimeout;
  let speedUpTurnTimeout = false;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timer(fn, speedUpTurnTimeout && ms === 300000 ? 100 : ms, ...args));
  server = router.routerServer;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/responses`;
  const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: { pattern: { type: "string" } } } }];
  let counter = 0;
  async function ask(fixture, extra = {}) {
    const response = await localFetch(endpoint, {
      method: "POST", signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/json", authorization: "Bearer fixture", "chatgpt-account-id": "fixture-account",
        "session-id": `agy-fixture-${++counter}` },
      body: JSON.stringify({ model: slug, input: fixture, tools, stream: true, ...extra }),
    });
    assert.equal(response.status, 200);
    return (await response.text()).split(/\r?\n/).filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  }

  const recovered = await ask("FIXTURE_REPLY_recover");
  const terminal = recovered.at(-1);
  assert.equal(terminal.type, "response.completed");
  assert.ok(recovered.some(event => event.type === "response.reasoning_summary_text.delta"));
  const deltas = recovered.filter(event => event.type === "response.output_text.delta").map(event => event.delta);
  assert.ok(deltas.length >= 2, "the prefix streams and the repaired suffix does not repeat it");
  assert.equal(deltas.join(""), answer);
  assert.doesNotMatch(JSON.stringify(terminal), /function_call/);
  assert.match(stderr.join(""), /model-router-antigravity:envelope-recovered .*"emittedChars":[1-9]/);
  const valid = (await ask("FIXTURE_REPLY_valid")).at(-1);
  assert.equal(valid.type, "response.completed");
  assert.equal(valid.response.output.find(item => item.type === "message").phase, "commentary");
  assert.deepEqual(JSON.parse(valid.response.output.find(item => item.type === "function_call").arguments), { pattern: argument });

  const rejected = [
    ["FIXTURE_REPLY_bad_calls", "invalid_tool_call_json"], ["FIXTURE_REPLY_repeated", "extra_response_content"],
    ["FIXTURE_REPLY_bad_json", "invalid_response_json"], ["FIXTURE_LOCAL", "local_tool_attempt"],
    ["FIXTURE_RATE", "rate_limit_exceeded"], ["FIXTURE_REPLY_recover", "invalid_response_format", { tool_choice: "required" }],
    ["FIXTURE_REPLY_context", "context_length_exceeded"], ["FIXTURE_REPLY_zero_budget", "context_length_exceeded"],
    ["FIXTURE_REPLY_executor", "cli_execution_error"],
    ["FIXTURE_TIMEOUT", "turn_timeout"],
  ];
  for (const [input, code, extra] of rejected) {
    speedUpTurnTimeout = code === "turn_timeout";
    const events = await ask(input, extra);
    assert.equal(events.at(-1).type, "response.failed");
    assert.equal(events.at(-1).response.error.code, code);
    assert.doesNotMatch(JSON.stringify(events.at(-1)), /PRIVATE_FIXTURE/);
    assert.ok(events.every(event => !event.type.includes("function_call") && event.item?.type !== "function_call"));
  }
  const diagnostic = stderr.join("");
  assert.doesNotMatch(diagnostic, /PRIVATE_FIXTURE|範例：|checking fixture/);
  const expected = rejected.map(([, code]) => code);
  const recentErrors = installer.parseRouterLog(diagnostic).filter(row => row.kind === "error");
  assert.deepEqual(recentErrors.map(row => row.code).sort(), expected.toSorted());
  const usage = (await readFile(join(dir, "usage.jsonl"), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(usage.filter(row => row.status === "failed").map(row => row.error), expected);

  await t.test("real Codex stops after an Antigravity context budget error instead of retrying", { skip: !codexBin }, async () => {
    speedUpTurnTimeout = false;
    const home = join(root, "codex-home");
    await mkdir(home);
    const env = { ...process.env, CODEX_HOME: home };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_MODEL_ROUTER_IMPORT_ONLY;
    const bundled = JSON.parse(execFileSync(codexBin, ["debug", "models", "--bundled"], { cwd: home, env, encoding: "utf8" }));
    const model = installer.customCatalogEntry(bundled.models, { pickerSlug: slug, upstreamModel: "fixture", efforts: [],
      transport: "antigravity-cli", translate: "chat", contextWindow: 1000000 }, 0);
    await writeFile(join(home, "models.json"), JSON.stringify({ models: [model] }));
    await writeFile(join(home, "config.toml"), `model = "${slug}"
model_catalog_json = ${JSON.stringify(join(home, "models.json"))}
openai_base_url = "http://127.0.0.1:${server.address().port}/v1"
[features]
apps = false
plugins = false
`);
    const jwt = "e30." + Buffer.from(JSON.stringify({ sub: "fixture", email: "fixture@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "fixture", chatgpt_plan_type: "plus", chatgpt_user_id: "fixture" } })).toString("base64url") + ".fake";
    await writeFile(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", last_refresh: new Date().toISOString(),
      tokens: { access_token: jwt, id_token: jwt, refresh_token: "fake", account_id: "fixture" } }));
    const child = spawn(codexBin, ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "FIXTURE_REPLY_context"],
      { cwd: home, env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], signal: AbortSignal.timeout(25000) });
    let output = "", spawnError = null;
    child.on("error", error => { spawnError = error; });
    child.stdout.setEncoding("utf8").on("data", data => { output += data; });
    const exit = await new Promise(resolve => child.once("close", resolve));
    assert.equal(spawnError, null);
    assert.equal(exit, 1);
    const events = output.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    assert.ok(events.some(event => event.type === "turn.failed"));
    assert.doesNotMatch(output, /Reconnecting|invalid JSON reply/);
    const current = (await readFile(join(dir, "usage.jsonl"), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    const additional = current.slice(usage.length);
    assert.equal(additional.length, 1, "no identical or generic-error retries");
    assert.equal(additional[0].error, "context_length_exceeded");
  });
});
