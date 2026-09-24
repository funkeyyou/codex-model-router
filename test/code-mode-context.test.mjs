import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { bridge } = await loadPayloads();
const preamble = "Run JavaScript code to orchestrate/compose tool calls\n" +
  "- All nested tools are available on the global `tools` object.\n" +
  "- `ALL_TOOLS`: metadata for the enabled nested tools as `{ name, description }` entries.\n\n";
function entry(name, details = "Read the full rules before invoking.\n" + "Detailed parameter semantics. ".repeat(100)) {
  return `### \`${name}\`\n${details}\n\nexec tool declaration:\n\`\`\`ts\ndeclare const tools: { ${name}(args: { nested: { ids: string[] } }): Promise<unknown>; };\n\`\`\`\n\n`;
}
const sample = () => preamble + entry("exec_command") +
  "## mcp__fixture\nFixture namespace rules must remain.\n\n" +
  entry("mcp__fixture__read") + entry("mcp__fixture__write") +
  "## web\nWeb namespace rules must remain.\n\n" + entry("web__run") +
  "## image_gen\nImage namespace rules must remain.\n\n" + entry("image_gen__imagegen");

test("only external nested definitions become summaries; execution, web, image and namespace rules stay exact", () => {
  const original = sample();
  const result = bridge.compactCodeModeDescription(original);
  assert.equal(result.toolsDeferred, 2);
  assert.equal(result.charsSaved, original.length - result.description.length);
  assert.ok(result.charsSaved > 3000);
  for (const name of ["exec_command", "web__run", "image_gen__imagegen"]) assert.ok(result.description.includes(entry(name)));
  for (const name of ["mcp__fixture__read", "mcp__fixture__write"]) {
    assert.ok(result.description.includes(`### \`${name}\``));
    assert.ok(!result.description.includes(`declare const tools: { ${name}(`));
  }
  assert.ok(result.description.startsWith(preamble));
  assert.match(result.description, /Fixture namespace rules must remain/);
  assert.match(result.description, /parameter schema, usage rules, restrictions and approval requirements/);
  assert.match(result.description, /at most 5 candidate/);
  assert.match(result.description, /ALL_TOOLS.find/);
  assert.deepEqual(bridge.compactCodeModeDescription(result.description), {description: result.description, toolsDeferred: 0, charsSaved: 0});
});

test("unknown registry, malformed declaration, mismatched name and incomplete fences fall back intact", () => {
  const variants = [sample().replace("ALL_TOOLS", "SOMETHING_ELSE"),
    preamble + entry("mcp__fixture__read").replace("declare const tools:", "declare let tools:"),
    preamble + entry("mcp__fixture__read").replace("mcp__fixture__read(args:", "other(args:"),
    sample() + "```ts\nunclosed", "ordinary exec description", undefined];
  for (const description of variants) assert.deepEqual(bridge.compactCodeModeDescription(description), { description, toolsDeferred: 0, charsSaved: 0 });
});

test("headings inside fenced examples do not split tools; trailing text is preserved", () => {
  const description = preamble + entry("mcp__fixture__read", "Read fixture.\n```md\n### `fake__tool`\n```\n" + "Rules. ".repeat(800)) +
    "IMPORTANT trailing rules must remain.\n";
  const result = bridge.compactCodeModeDescription(description);
  assert.equal(result.toolsDeferred, 1);
  assert.ok(result.description.endsWith("IMPORTANT trailing rules must remain.\n"));
  assert.ok(!result.description.includes("fake__tool"));
});

test("small tools remain eager when discovery overhead would increase context", () => {
  const description = preamble + entry("mcp__fixture__read", "Read a fixture.");
  assert.equal(bridge.compactCodeModeDescription(description).description, description);
});

test("bridge compacts only real custom exec, without changing input history or other tool parameters", () => {
  const description = sample();
  const input = [{type: "additional_tools", tools: [{type: "namespace", name: "functions", tools: [
    {type: "custom", name: "exec", description},
    {type: "function", name: "normal", description, parameters: {type: "object", properties: {key: {type: "string"}}}},
  ]}]}, {type: "message", role: "user", content: "Use the fixture."}];
  const body = { input };
  const snapshot = JSON.stringify(body);
  const result = bridge.toAnthropicRequest(body, {upstreamModel: "claude-fixture"});
  assert.equal(JSON.stringify(body), snapshot);
  assert.equal(result.toolContext.toolsDeferred, 2);
  assert.equal(result.toolContext.originalChars, description.length);
  assert.equal(result.toolContext.charsSaved, result.toolContext.originalChars - result.toolContext.forwardedChars);
  assert.equal(result.request.tools.find(t=>t.name === "normal").description, description);
  assert.deepEqual(result.request.tools.find(t=>t.name === "normal").input_schema, input[0].tools[0].tools[1].parameters);
  assert.deepEqual(result.toolTargets.get("exec"), {name: "exec"});
  assert.ok(result.freeform.has("exec"));
  const foreign = bridge.toAnthropicRequest({input:"hi", tools:[{type:"namespace",name:"foreign",tools:[{type:"custom",name:"exec",description}]}]}, {upstreamModel:"claude-fixture"});
  assert.equal(foreign.toolContext.toolsDeferred, 0);
  assert.equal(foreign.request.tools[0].description, description);
});
