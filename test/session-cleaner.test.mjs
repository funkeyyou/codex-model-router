import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadPayloads } from "./helpers/payloads.mjs";
import { codexBin } from "./helpers/codex-bin.mjs";

const { installer, dir } = await loadPayloads();

const message = (role, id, text) => ({
  type: "response_item",
  payload: { type: "message", role, id, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] },
});
const completed = (id, text) => ({
  type: "event_msg",
  payload: { type: "item_completed", item: { type: "AgentMessage", id, content: [{ type: "Text", text }] } },
});
const reasoning = (id) => ({ type: "response_item", payload: { type: "reasoning", id, summary: [{ type: "summary_text", text: "hidden" }] } });

function jsonl(lines) {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

test("two-level refusal detector catches strong and opening weak phrases without matching ordinary text", () => {
  assert.equal(installer.sessionRefusalReason("I can't assist with that request."), "strong");
  assert.equal(installer.sessionRefusalReason("抱歉，我無法協助執行這項要求。"), "strong");
  assert.equal(installer.sessionRefusalReason("Sorry, this is outside the scope I can cover."), "weak");
  assert.equal(installer.sessionRefusalReason("Sorry, the build failed before tests started."), null);
  assert.equal(installer.sessionRefusalReason("The build cannot continue because the compiler failed."), null);
});

test("parser groups response_item and desktop item_completed projections and supports event-only refusals", () => {
  const lines = [
    message("user", "u1", "continue"),
    completed("a1", "I can't assist with that request."),
    message("assistant", "a1", "I can't assist with that request."),
    completed("a2", "抱歉，我無法協助執行這項要求。"),
  ];
  const parsed = installer.parseSessionCleanerText(jsonl(lines), "rollout-2026-01-01T00-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl");
  assert.equal(parsed.groups.length, 2);
  assert.deepEqual(parsed.groups[0].lineIndexes, [1, 2]);
  assert.equal(parsed.groups[1].key, "id:a2");
  assert.equal(parsed.groups.every((group) => group.refusal), true);
});

test("apply replaces every projection copy and removes standalone and embedded reasoning", () => {
  const lines = [
    message("user", "u1", "continue"),
    completed("a1", "I can't assist with that request."),
    message("assistant", "a1", "I can't assist with that request."),
    reasoning("r1"),
    { type: "response_item", payload: { type: "message", role: "assistant", id: "a2",
      content: [{ type: "thinking", thinking: "secret" }, { type: "output_text", text: "ordinary answer" }] } },
  ];
  const parsed = installer.parseSessionCleanerText(jsonl(lines));
  const plan = installer.applySessionCleanerPlan(parsed, [{ key: "id:a1", text: "Continue with the next verified step." }], true);
  const output = plan.text.trim().split("\n").map(JSON.parse);
  assert.equal(output.length, 4);
  assert.equal(output.some((line) => line.payload?.type === "reasoning"), false);
  const projected = output.filter((line) => installer.parseSessionCleanerText(jsonl([line])).groups.length);
  assert.match(JSON.stringify(projected.slice(0, 2)), /Continue with the next verified step/);
  assert.doesNotMatch(JSON.stringify(output), /secret|thinking/);
  assert.equal(plan.replaced, 1);
  assert.equal(plan.removedReasoning, 1);
  assert.equal(plan.removedThinkingBlocks, 1);
});

test("apply can remove reasoning without changing assistant replies", () => {
  const source = jsonl([message("assistant", "a1", "ordinary answer"), reasoning("r1")]);
  const parsed = installer.parseSessionCleanerText(source);
  const plan = installer.applySessionCleanerPlan(parsed, [], true);
  assert.match(plan.text, /ordinary answer/);
  assert.doesNotMatch(plan.text, /reasoning/);
});

test("invalid replacement keys and oversized replacement text are rejected", () => {
  const parsed = installer.parseSessionCleanerText(jsonl([message("assistant", "a1", "I can't assist with that request.")]));
  assert.throws(() => installer.applySessionCleanerPlan(parsed, [{ key: "id:missing", text: "x" }], false), /找不到/);
  assert.throws(() => installer.applySessionCleanerPlan(parsed, [{ key: "id:a1", text: "x".repeat(17000) }], false), /過長/);
});

test("AI preview uses the configured provider and falls back on question-mark mojibake", { skip: !codexBin }, async t => {
  let calls = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      assert.equal(request.url, "/v1/responses");
      assert.match(request.headers.authorization || "", /test-key/);
      assert.match(body, /Refusal to replace/);
      calls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output_text: calls === 1 ? "Continue with the next verified local step." : "????" }));
    });
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  t.after(() => server.close());

  const home = mkdtempSync(join(tmpdir(), "router-session-cleaner-ai-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "model-router");
  const sessionDir = join(home, "sessions", "2026", "10", "21");
  mkdirSync(root, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const apiRoot = `http://127.0.0.1:${server.address().port}/v1`;
  writeFileSync(join(root, "install.json"), JSON.stringify({ version: "1.37.0" }));
  writeFileSync(join(root, "settings.json"), JSON.stringify({ providers: [{ id: "default", baseUrl: apiRoot, apiRoot,
    keychainService: "test", keychainAccount: "codex" }], routes: [{ pickerSlug: "custom/test", upstreamModel: "test",
    displayName: "Test", providerId: "default", translate: "responses" }] }));
  const relativePath = "2026/10/21/rollout-2026-10-21T00-00-00-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl";
  writeFileSync(join(home, "sessions", relativePath), jsonl([
    message("user", "u1", "continue locally"),
    message("assistant", "a1", "I can't assist with that request."),
    message("assistant", "a2", "I must decline this request."),
  ]));

  const moduleUrl = pathToFileURL(join(dir, "installer.mjs")).href;
  const code = `
    const mod = await import(${JSON.stringify(moduleUrl)});
    const detail = await mod.managerSessionCleaner({session:${JSON.stringify(relativePath)}});
    const result = await mod.managerSessionCleanerPreview({session:${JSON.stringify(relativePath)}, expectedHash:detail.session.hash,
      keys:['id:a1','id:a2'], modelSlug:'custom/test'});
    console.log('RESULT '+JSON.stringify(result));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8",
    env: { ...process.env, CODEX_HOME: home, CODEX_MODEL_ROUTER_HOME: root, CODEX_MODEL_ROUTER_CODEX_BIN: codexBin,
      CODEX_MODEL_ROUTER_TEST_API_KEY: "test-key", CODEX_MODEL_ROUTER_IMPORT_ONLY: "1" } });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise((resolvePromise) => child.on("close", resolvePromise));
  assert.equal(status, 0, stdout + stderr);
  const result = JSON.parse(stdout.match(/RESULT (\{.*\})/)[1]);
  assert.equal(result.replacements[0].fallback, false);
  assert.match(result.replacements[0].text, /verified local step/);
  assert.equal(result.replacements[1].fallback, true);
  assert.match(result.replacements[1].text, /本機專案/);
  assert.equal(calls, 2);
});

test("apply and restore keep JSONL and desktop projection in sync with complete backups", { skip: !codexBin }, t => {
  const home = mkdtempSync(join(tmpdir(), "router-session-cleaner-e2e-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "model-router");
  const sessionDir = join(home, "sessions", "2026", "10", "21");
  mkdirSync(root, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(root, "install.json"), JSON.stringify({ version: "1.37.0" }));
  const threadId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const relativePath = `2026/10/21/rollout-2026-10-21T00-00-00-${threadId}.jsonl`;
  const sessionPath = join(home, "sessions", relativePath);
  const originalText = jsonl([
    completed("a1", "I can't assist with that request."),
    message("assistant", "a1", "I can't assist with that request."),
    reasoning("r1"),
  ]);
  writeFileSync(sessionPath, originalText);
  const past = new Date(Date.now() - 20000);
  utimesSync(sessionPath, past, past);

  const dbPath = join(home, "thread_history_1.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE thread_items (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
      rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL,
      item_type TEXT NOT NULL DEFAULT '', updated_at_ordinal INTEGER NOT NULL DEFAULT 0,
      started_at_ms INTEGER, completed_at_ms INTEGER, PRIMARY KEY(thread_id, turn_id, item_id));
    CREATE TABLE thread_realtime_items (thread_id TEXT NOT NULL, item_id TEXT NOT NULL,
      rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, item_type TEXT NOT NULL,
      item_json TEXT NOT NULL, PRIMARY KEY(thread_id, item_id));
    CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY,
      next_rollout_byte_offset INTEGER NOT NULL, next_rollout_ordinal INTEGER NOT NULL);
    CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL,
      status TEXT NOT NULL, error_json TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER,
      first_user_item_id TEXT, final_agent_item_id TEXT, rollout_byte_offset INTEGER,
      rollout_end_ordinal INTEGER, rollout_end_byte_offset INTEGER, root_turn_id TEXT,
      PRIMARY KEY(thread_id, turn_id));
  `);
  const agent = JSON.stringify({ type: "agentMessage", id: "a1", text: "I can't assist with that request." });
  const thought = JSON.stringify({ type: "reasoning", id: "r1", summary: ["hidden"] });
  const insert = db.prepare("INSERT INTO thread_items VALUES (?,?,?,?,?,?,?,?,?,?)");
  insert.run(threadId, "t1", "a1", 1, 1, agent, "agentMessage", 1, 1, 2);
  insert.run(threadId, "t1", "r1", 2, 1, thought, "reasoning", 2, 1, 2);
  db.prepare("INSERT INTO thread_realtime_items VALUES (?,?,?,?,?,?)").run(threadId, "a1", 1, 1, "agentMessage", agent);
  db.prepare("INSERT INTO thread_history_projection_state VALUES (?,?,?)").run(threadId, Buffer.byteLength(originalText), 3);
  db.prepare("INSERT INTO thread_turns (thread_id,turn_id,rollout_ordinal,status,completed_at) VALUES (?,?,?,?,?)")
    .run(threadId, "t1", 1, "completed", 2);
  db.close();

  const moduleUrl = pathToFileURL(join(dir, "installer.mjs")).href;
  const run = (source) => spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: home, CODEX_MODEL_ROUTER_HOME: root,
      CODEX_MODEL_ROUTER_CODEX_BIN: codexBin, CODEX_MODEL_ROUTER_IMPORT_ONLY: "1" },
  });
  const apply = run(`
    const mod = await import(${JSON.stringify(moduleUrl)});
    const detail = await mod.managerSessionCleaner({session:${JSON.stringify(relativePath)}});
    const result = await mod.managerSessionCleanerApply({session:${JSON.stringify(relativePath)},
      expectedHash:detail.session.hash,replacements:[{key:'id:a1',text:'Continue with the verified local step.'}],removeReasoning:true});
    console.log('RESULT '+JSON.stringify(result));
  `);
  assert.equal(apply.status, 0, apply.stdout + apply.stderr);
  const backupId = JSON.parse(apply.stdout.match(/RESULT (\{.*\})/)[1]).backupId;
  assert.match(readFileSync(sessionPath, "utf8"), /Continue with the verified local step/);
  assert.doesNotMatch(readFileSync(sessionPath, "utf8"), /"type":"reasoning"/);
  const appliedDb = new DatabaseSync(dbPath, { readOnly: true });
  assert.match(appliedDb.prepare("SELECT item_json FROM thread_items WHERE item_id='a1'").get().item_json, /Continue with the verified local step/);
  assert.equal(appliedDb.prepare("SELECT count(*) AS count FROM thread_items WHERE item_id='r1'").get().count, 0);
  appliedDb.close();

  const restore = run(`
    const mod = await import(${JSON.stringify(moduleUrl)});
    const result = await mod.managerSessionCleanerRestore({backupId:${JSON.stringify(backupId)}});
    console.log('RESULT '+JSON.stringify(result));
  `);
  assert.equal(restore.status, 0, restore.stdout + restore.stderr);
  assert.equal(readFileSync(sessionPath, "utf8"), originalText);
  const restoredDb = new DatabaseSync(dbPath, { readOnly: true });
  assert.match(restoredDb.prepare("SELECT item_json FROM thread_items WHERE item_id='a1'").get().item_json, /can't assist/);
  assert.equal(restoredDb.prepare("SELECT count(*) AS count FROM thread_items WHERE item_id='r1'").get().count, 1);
  restoredDb.close();
});
