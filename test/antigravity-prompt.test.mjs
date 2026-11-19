import assert from "node:assert/strict";
import { test } from "node:test";
import { antigravityPrompt, writeAntigravityPolicy } from "../src/antigravity-cli.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayloads } from "./helpers/payloads.mjs";

test("Antigravity changes instruction prose while preserving user input and host tool data", () => {
  const request = { messages: [
    { role: "system", content: "You are Codex. As Codex, obey the user." },
    { role: "developer", content: [{ type: "text", text: "CODEX tools are available." }] },
    { role: "user", content: "Read Codex.txt" },
    { role: "tool", content: "Codex", tool_call_id: "Codex_call" },
  ], tools: [{ name: "Codex_tool", description: "Codex", parameters: {} }], model: "ignored", stream: true };
  const before = structuredClone(request);
  const { system, prompt } = antigravityPrompt(request);
  const section = (text, title) => JSON.parse(text.split("\n" + title + "\n")[1].split("\n")[0]);
  const settings = section(system, "Host settings and tools:");
  const standing = section(system, "Earlier chat messages (standing instructions and context; earlier requests were already answered):");
  assert.match(prompt, /^Answer the coding agent request[\s\S]*in the system context\.\nNew chat messages/);
  const messages = JSON.parse(prompt.split("New chat messages (respond to these):\n")[1]);
  assert.doesNotMatch(JSON.stringify(standing), /codex/i);
  assert.match(standing[0].content, /^You are a coding agent\./);
  assert.deepEqual(messages, request.messages.slice(2));
  assert.deepEqual(settings, { tools: request.tools });
  assert.doesNotMatch(prompt, /Codex_tool"\s*,\s*"description/);
  assert.deepEqual(request, before);
});

test("Antigravity full replay marks handled history apart from the newest request", () => {
  const images = [];
  const { system, prompt } = antigravityPrompt({ messages: [
    { role: "system", content: "rules" }, { role: "user", content: "compare A and B" },
    { role: "assistant", content: "A wins", reasoning_content: "long thoughts" },
    { role: "user", content: [{ type: "text", text: "is high close to xhigh?" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/AA==" } }] },
  ] }, images);
  const earlier = system.split(/\nEarlier chat messages[^\n]*\n/)[1];
  const latest = prompt.split("New chat messages (respond to these):\n")[1];
  assert.match(earlier, /rules.*compare A and B.*A wins/);
  assert.doesNotMatch(earlier, /long thoughts|xhigh/);
  assert.deepEqual(JSON.parse(latest)[0].content, [{ type: "text", text: "is high close to xhigh?" },
    { type: "text", text: "[Image 1: attached to the latest user prompt]" }]);
  assert.deepEqual(images, [{ type: "image", mimeType: "image/jpeg", data: "/9j/AA==" }]);
  const huge = antigravityPrompt({ messages: [{ role: "user", content: "x".repeat(200000) }] });
  assert.match(huge.system, /New chat messages \(respond to these\)/);
  assert.ok(huge.prompt.length < 1000);
});

test("Antigravity workspace agent and tool guard use neutral names", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agy-policy-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeAntigravityPolicy(directory);
  for (const file of ["agents/coding-host.md", "deny.cjs", "hooks.json"]) {
    assert.doesNotMatch(await readFile(join(directory, ".agents", file), "utf8"), /codex/i);
  }
});

test("custom catalog identity follows upstream model for new entries and upgrades", async () => {
  const { installer } = await loadPayloads();
  const template = { slug: "official", visibility: "list", base_instructions:
    "You are Codex, an agent based on GPT-5. You and the user share one workspace." };
  for (const upstreamModel of ["ark/gpt-6.2-sol", "gemini-3.8-flash", "claude-opus-5-5"]) {
    const route = { pickerSlug: "custom/test", upstreamModel, efforts: [], providerHost: "fixture" };
    const expected = "You are Codex, an agent based on " + upstreamModel.split("/").at(-1) + ". You and the user share one workspace.";
    assert.equal(installer.customCatalogEntry([template], route, 0).base_instructions, expected);
    const migrated = installer.refreshCustomCatalogCapabilities({ models: [{ ...template, slug: route.pickerSlug }] }, [route]);
    assert.equal(migrated.models[0].base_instructions, expected);
    assert.equal(installer.refreshCustomCatalogCapabilities(migrated, [route]), migrated);
  }
});
