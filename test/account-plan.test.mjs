import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer, dir } = await loadPayloads();
const token = (claims) => "e30." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": claims })).toString("base64url") + ".sig";

test("從 Codex 登入檔讀出帳號方案，只回傳方案與訂閱時間，不含任何 token", () => {
  const info = installer.codexPlanFromAuth({ auth_mode: "chatgpt", tokens: { id_token: token({
    chatgpt_plan_type: "Free", chatgpt_subscription_active_until: "2026-12-01T00:00:00Z", chatgpt_user_id: "user-secret" }) } });
  assert.deepEqual(info, { plan: "free", free: true, activeUntil: "2026-12-01T00:00:00.000Z", lastChecked: null });
  assert.equal(installer.codexPlanFromAuth({ tokens: { id_token: token({ chatgpt_plan_type: "prolite" }) } }).free, false);
});

test("沒有登入、API Key 登入、損壞或不合理的方案值都回傳 null", () => {
  for (const auth of [null, {}, { auth_mode: "apikey", OPENAI_API_KEY: "sk-x", tokens: null },
    { tokens: { id_token: "not-a-jwt" } }, { tokens: { id_token: "e30.@@@.x" } },
    { tokens: { id_token: token({ chatgpt_plan_type: "free plan; rm -rf" }) } }, { tokens: { id_token: token({}) } }]) {
    assert.equal(installer.codexPlanFromAuth(auth), null);
  }
});

// 在獨立行程以暫存 CODEX_HOME 執行，免費方案的預設處理不會碰到本機真正的設定。
function runFreePlanDefaults(t, plan, { imagegen = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "router-free-plan-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runtime = join(home, "model-router");
  mkdirSync(runtime);
  writeFileSync(join(runtime, "settings.json"), JSON.stringify({ routes: [] }));
  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: token({ chatgpt_plan_type: plan }), refresh_token: "r" } }));
  if (imagegen) {
    mkdirSync(join(home, "skills", "router-imagegen"), { recursive: true });
    writeFileSync(join(home, "skills", "router-imagegen", "config.json"), JSON.stringify({ managedBy: "codex-model-router", routerSettingsPath: join(runtime, "settings.json") }));
  }
  const script = `const m = await import(${JSON.stringify(pathToFileURL(join(dir, "installer.mjs")).href)});
    console.log("RESULT" + JSON.stringify(await m.applyFreePlanDefaults()));`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8",
    env: { ...process.env, CODEX_HOME: home, CODEX_MODEL_ROUTER_HOME: runtime, CODEX_MODEL_ROUTER_IMPORT_ONLY: "1", CODEX_MODEL_ROUTER_TEST_NO_CODEX: "1" } });
  return { output, result: JSON.parse(output.split("RESULT")[1]), settings: JSON.parse(readFileSync(join(runtime, "settings.json"), "utf8")) };
}

test("免費方案：添加模型後提示啟用中轉生圖；付費方案或已啟用中轉生圖時不提示", (t) => {
  const free = runFreePlanDefaults(t, "free");
  assert.equal(free.result.plan, "free");
  assert.equal(free.result.imagegenHint, true);
  assert.match(free.output, /內建 image_gen 不可用，建議到「生圖」頁啟用中轉生圖/);
  assert.equal(free.result.hiddenOfficial, false, "沒有接入 Codex 時不改官方模型設定");
  assert.equal(free.settings.hideOfficialModels, undefined);
  assert.equal(runFreePlanDefaults(t, "plus").result, null);
  const withImagegen = runFreePlanDefaults(t, "free", { imagegen: true });
  assert.equal(withImagegen.result.imagegenHint, false);
  assert.doesNotMatch(withImagegen.output, /image_gen 不可用/);
});
