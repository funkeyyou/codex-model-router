import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer, dir: payloadDir } = await loadPayloads();
const current = { binary: "/fixture/claude", version: installer.CLAUDE_CLI_MIN_VERSION };

function scenario(states, answer = true) {
  const calls = [];
  let i = 0;
  return { calls, options: {
    inspect: async () => states[Math.min(i++, states.length - 1)],
    consent: async (question) => { calls.push(["consent", question]); return answer; },
    install: async () => { calls.push(["install"]); },
    update: async (binary) => { calls.push(["update", binary]); },
  } };
}

test("missing CLI: decline means no install; consent installs and re-discovers binary", async () => {
  const declined = scenario([null], false);
  assert.equal(await installer.ensureClaudeCliReady(declined.options), null);
  assert.deepEqual(declined.calls.map(([type]) => type), ["consent"]);
  const accepted = scenario([null, current]);
  assert.deepEqual(await installer.ensureClaudeCliReady(accepted.options), current);
  assert.deepEqual(accepted.calls.map(([type]) => type), ["consent", "install"]);
});

test("old CLI: update requires consent and version is rechecked afterward", async () => {
  const old = { ...current, version: "2.1.231" };
  const declined = scenario([old], false);
  assert.equal(await installer.ensureClaudeCliReady(declined.options), null);
  assert.deepEqual(declined.calls.map(([type]) => type), ["consent"]);
  const accepted = scenario([old, current]);
  assert.deepEqual(await installer.ensureClaudeCliReady(accepted.options), current);
  assert.deepEqual(accepted.calls.map(([type]) => type), ["consent", "update"]);
  const unchanged = scenario([old, old]);
  await assert.rejects(installer.ensureClaudeCliReady(unchanged.options), /更新後仍未達/);
});

test("ready/read-only CLI checks never install, update or prompt", async () => {
  const ready = scenario([current]);
  assert.deepEqual(await installer.ensureClaudeCliReady(ready.options), current);
  assert.deepEqual(ready.calls, []);
  for (const value of [null, { ...current, version: "2.0.0" }]) {
    const readOnly = scenario([value]);
    assert.deepEqual(await installer.ensureClaudeCliReady({ ...readOnly.options, readOnly: true }), value);
    assert.deepEqual(readOnly.calls, []);
  }
});

test("failed or ineffective install stops before login/configuration", async () => {
  const missing = scenario([null, null]);
  await assert.rejects(installer.ensureClaudeCliReady(missing.options), /仍找不到/);
  const rejected = scenario([null]);
  await assert.rejects(installer.ensureClaudeCliReady({ ...rejected.options,
    install: async () => { throw new Error("download failed"); } }), /download failed/);
  assert.deepEqual(rejected.calls.map(([type]) => type), ["consent"]);
});

test("only fixed official installers are used, without interpolating paths into shell code", () => {
  const directory = join("fixture with spaces", "scripts");
  const mac = installer.claudeCliInstallCommand("darwin", directory);
  assert.equal(mac.url, "https://claude.ai/install.sh");
  assert.deepEqual(mac.args, [join(directory, "install.sh"), "latest"]);
  assert.equal(mac.binary, "bash");
  const windows = installer.claudeCliInstallCommand("win32", directory);
  assert.equal(windows.url, "https://claude.ai/install.ps1");
  assert.deepEqual(windows.args, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(directory, "install.ps1"), "latest"]);
  assert.equal(windows.binary, "powershell.exe");
});

test("missing or API-only authentication runs official login and confirms the resulting subscription", async () => {
  for (const initial of [{ loggedIn: false }, { loggedIn: true, authMethod: "api_key" }]) {
    const calls = [];
    let status = initial;
    const ready = await installer.ensureClaudeCliLogin(current.binary, {
      auth: async () => { calls.push("auth"); return status; },
      login: async (binary) => { assert.equal(binary, current.binary); calls.push("login"); status = { loggedIn: true, authMethod: "claude.ai" }; },
      notify: () => calls.push("notify"),
    });
    assert.equal(ready.authMethod, "claude.ai");
    assert.deepEqual(calls, ["auth", "notify", "login", "auth"]);
  }
});

test("existing subscription login is reused; cancelled/unsuccessful login does not proceed", async () => {
  const auth = async () => ({ loggedIn: true, authMethod: "claude.ai" });
  await installer.ensureClaudeCliLogin(current.binary, { auth,
    login: async () => assert.fail("must not log in again"), notify: () => assert.fail("must not prompt") });
  await assert.rejects(installer.ensureClaudeCliLogin(current.binary, {
    auth: async () => ({ loggedIn: false }), login: async () => {}, notify: () => {},
  }), /未登入 Claude 訂閱帳號/);
  await assert.rejects(installer.ensureClaudeCliLogin(current.binary, {
    auth: async () => ({ loggedIn: false }), login: async () => { throw new Error("cancelled"); }, notify: () => {},
  }), /cancelled/);
});

test("command-level noninteractive YES cannot authorize a missing CLI install or change router files", (t) => {
  const home = mkdtempSync(join(tmpdir(), "router-cli-consent-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "model-router");
  mkdirSync(root);
  const files = {
    "install.json": { version: "1.0.0", port: 12345 },
    "settings.json": { routes: [], providers: [{ id: "default", apiRoot: "https://fixture.example/v1" }] },
    "models.json": { models: [] },
  };
  for (const [name, data] of Object.entries(files)) writeFileSync(join(root, name), JSON.stringify(data));
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: join(home, "no-executables"),
    CODEX_HOME: home, CODEX_MODEL_ROUTER_HOME: root, CODEX_MODEL_ROUTER_CLAUDE_BIN: join(home, "missing"),
    CODEX_MODEL_ROUTER_CODEX_BIN: process.execPath, CODEX_MODEL_ROUTER_YES: "1",
    CODEX_MODEL_ROUTER_SCRIPT_PATH: fileURLToPath(new URL("../codex-model-router.sh", import.meta.url)),
    CODEX_MODEL_ROUTER_RELEASES_JSON: JSON.stringify({ latest: "1.26.0", releases: [{ version: "1.26.0", changes: ["fixture"] }] }),
  };
  delete env.CODEX_MODEL_ROUTER_IMPORT_ONLY;
  const result = spawnSync(process.execPath, [join(payloadDir, "installer.mjs"), "claude-cli"],
    { env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /需要在互動終端機明確確認/);
  for (const [name, data] of Object.entries(files)) assert.equal(readFileSync(join(root, name), "utf8"), JSON.stringify(data));
  assert.equal(existsSync(join(home, "backups")), false);
});
