import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
const { storeMacosApiKey } = installer;

test("macOS key is supplied only via stdin; failed verification does not expose secrets", () => {
  const secret = 'test-key-"\\$;\nsecond-line';
  const calls = [];
  storeMacosApiKey("test.service", "Test label", secret, (bin, args, options) => {
    calls.push({ bin, args, options });
    return { status: 0, stdout: args[0] === "-i" ? "" : `${secret}\n` };
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["-i"]);
  assert.ok(calls[0].options.input.includes(Buffer.from(secret).toString("hex")));
  assert.equal(calls[0].options.input.split("\n").length, 2);
  assert.throws(() => storeMacosApiKey("test.service", "Test", secret,
    () => ({ status: 0, stdout: "old-key\n", stderr: secret })),
  (error) => error.message === "API Key 未能儲存到鑰匙圈。");
});

test("macOS native keychain: one supplied key is saved and replaced without interactive confirmation", {
  skip: process.platform !== "darwin",
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "router-keychain-test-"));
  const keychain = join(dir, "test.keychain-db");
  const run = (args) => spawnSync("/usr/bin/security", args, { encoding: "utf8", timeout: 10000 });
  try {
    assert.equal(run(["create-keychain", "-p", "test-only-password", keychain]).status, 0);
    assert.equal(run(["unlock-keychain", "-p", "test-only-password", keychain]).status, 0);
    const timedRun = (bin, args, options) => spawnSync(bin, args, { ...options, timeout: 10000 });
    for (const secret of ['test-"quotes"-\\slashes-$dollar', "test-replacement-0123456789"]) {
      storeMacosApiKey("test.router.single-entry", "路由測試", secret, timedRun, keychain);
      assert.equal(run(["find-generic-password", "-a", "codex", "-s", "test.router.single-entry", "-w", keychain]).stdout.trim(), secret);
    }
  } finally {
    run(["delete-keychain", keychain]);
    rmSync(dir, { recursive: true, force: true });
  }
});
