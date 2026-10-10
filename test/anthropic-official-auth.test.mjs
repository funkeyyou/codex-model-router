// 官方 Anthropic API 以 x-api-key 認證並要求 anthropic-version；中轉站沿用 Bearer。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer, router } = await loadPayloads();

test("installer: official Anthropic uses x-api-key and anthropic-version, relays keep Bearer", () => {
  assert.deepEqual(installer.upstreamAuthHeaders("https://api.anthropic.com/v1/models", "k"),
    { "x-api-key": "k", "anthropic-version": "2023-06-01" });
  assert.deepEqual(installer.upstreamAuthHeaders("https://API.anthropic.com/v1", "k", true),
    { "x-api-key": "k", "anthropic-version": "2023-06-01" });
  assert.deepEqual(installer.upstreamAuthHeaders("https://relay.example/v1/models", "k"), { authorization: "Bearer k" });
  assert.deepEqual(installer.upstreamAuthHeaders("https://relay.example/v1", "k", true),
    { authorization: "Bearer k", "anthropic-version": "2023-06-01" });
  assert.deepEqual(installer.upstreamAuthHeaders("https://api.anthropic.com.evil.example/v1", "k"), { authorization: "Bearer k" });
});

test("router: /messages to official Anthropic never sends the key as Bearer", () => {
  const official = router.buildCustomHeaders({ authorization: "Bearer chatgpt-token", "user-agent": "codex" }, "k",
    new URL("https://api.anthropic.com/v1/messages"));
  assert.equal(official.get("x-api-key"), "k");
  assert.equal(official.get("anthropic-version"), "2023-06-01");
  assert.equal(official.get("authorization"), null);
  assert.equal(official.get("user-agent"), "codex");
  const relay = router.buildCustomHeaders({}, "k", new URL("https://relay.example/v1/messages"));
  assert.equal(relay.get("authorization"), "Bearer k");
  assert.equal(relay.get("x-api-key"), null);
  assert.equal(relay.get("anthropic-version"), "2023-06-01");
  const responses = router.buildCustomHeaders({}, "k", new URL("https://relay.example/v1/responses"));
  assert.equal(responses.get("authorization"), "Bearer k");
  assert.equal(responses.get("anthropic-version"), null);
});
