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
  ], tools: [{ name: "Codex_tool", description: "Codex", parameters: {} }] };
  const before = structuredClone(request);
  const prompt = antigravityPrompt(request);
  const adapted = JSON.parse(prompt.slice(prompt.indexOf("{")));
  assert.doesNotMatch(JSON.stringify(adapted.messages.slice(0, 2)), /codex/i);
  assert.match(adapted.messages[0].content, /^You are a coding agent\./);
  assert.deepEqual(adapted.messages.slice(2), request.messages.slice(2));
  assert.deepEqual(adapted.tools, request.tools);
  assert.deepEqual(request, before);
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
