// Explicit, paid/subscription smoke probe. Never run from npm test or CI.
// CODEX_MODEL_ROUTER_CLAUDE_BIN=/absolute/path node tools/probe-claude-cli.mjs --live [model]
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchClaudeCli, claudeCliAuth } from "../src/claude-cli.mjs";

if (process.argv[2] !== "--live" || !process.env.CODEX_MODEL_ROUTER_CLAUDE_BIN) {
  throw new Error("This probe uses subscription quota. Supply --live and CODEX_MODEL_ROUTER_CLAUDE_BIN explicitly.");
}
// The bridge stores opaque replay signatures next to its module. Keep probe
// artifacts in a private temporary directory, never in the source checkout.
const probeDirectory = mkdtempSync(join(tmpdir(), "router-cli-live-probe-"));
process.on("exit", () => rmSync(probeDirectory, { recursive: true, force: true }));
copyFileSync(new URL("../src/claude-bridge.mjs", import.meta.url), join(probeDirectory, "claude-bridge.mjs"));
const { toAnthropicRequest, bridgeAnthropicStream } = await import(pathToFileURL(join(probeDirectory, "claude-bridge.mjs")));
const binary = process.env.CODEX_MODEL_ROUTER_CLAUDE_BIN;
const auth = await claudeCliAuth(binary);
assert.equal(auth.loggedIn && auth.authMethod === "claude.ai", true, "Claude subscription login required");
const route = { upstreamModel: process.argv[3] || "opus", translate: "anthropic", transport: "claude-cli",
  maxOutputTokens: 2048, effortControl: "output_config" };
const base = { model: "custom/claude-cli-probe", stream: true, reasoning: { effort: "medium" },
  instructions: "Follow the user's instructions exactly. Tools are executed externally; never invent their results.",
  tools: [{ type: "function", name: "get_counter", description: "Read the current numeric counter from the external test service.",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false } }],
};
async function turn(body) {
  const translated = toAnthropicRequest(body, route);
  const response = await fetchClaudeCli(translated.request, { binary, effort: "medium", timeoutMs: 60000 }, null,
    { onDiagnostic: process.env.CLAUDE_CLI_PROBE_TRACE ? (event) => console.log(JSON.stringify(event)) : undefined });
  assert.equal(response.ok, true, response.ok ? "" : await response.text());
  const events = [];
  await bridgeAnthropicStream(response.body, (event) => events.push(event), { ...translated, model: body.model, requestBody: body });
  const failure = events.find((event) => event.type === "response.failed");
  assert.equal(failure, undefined, JSON.stringify(failure));
  const completed = events.find((event) => event.type === "response.completed")?.response;
  assert.ok(completed, "Expected a completed response");
  console.log(JSON.stringify({ model: route.upstreamModel, usage: completed.usage, outputTypes: completed.output.map((item) => item.type) }));
  return completed;
}
const input = [{ role: "user", content: "Read the fixture counter using get_counter with key 'fixture'. Tell me what its value would be after adding one." }];
const first = await turn({ ...base, input, tool_choice: { type: "function", name: "get_counter" } });
const call = first.output.find((item) => item.type === "function_call");
assert.equal(call?.name, "get_counter");
assert.equal(JSON.parse(call.arguments).key, "fixture");
const value = randomInt(100, 900);
const second = await turn({ ...base, tool_choice: "none", input: [...input, ...first.output,
  { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ value }) }] });
const text = second.output.flatMap((item) => item.content || []).map((part) => part.text || "").join("");
assert.ok(text.includes(String(value + 1)), "The model must use the actual external tool result");
console.log("PASS: live subscription tool call, reasoning/history replay, external result and final answer.");
