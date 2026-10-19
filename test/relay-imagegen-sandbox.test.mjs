// 其他使用者在預設權限（沙盒）下生圖，健康檢查連不到 127.0.0.1，只看到一句「本機圖片路由不可用」，
// 不知道要切「完整存取權」或申請提升權限。這裡鎖住：失敗原因分開提示，技能說明教 AI 主動申請放行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayloads } from "./helpers/payloads.mjs";

const { imagegen, installer } = await loadPayloads();
const model = imagegen.GPT_IMAGE_MODELS[1];

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "router-image-sandbox-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  const settingsPath = join(dir, "settings.json");
  writeFileSync(configPath, JSON.stringify({ managedBy: "codex-model-router", models: [model], routerSettingsPath: settingsPath,
    upstreamModels: { [model]: model } }));
  writeFileSync(settingsPath, JSON.stringify({ port: 48953 }));
  const out = join(dir, "out.png");
  return { configPath, out, args: ["generate", "--prompt", "貓", "--out", out] };
}

const networkError = (code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

test("沙盒擋網路（EPERM）：提示申請提升權限、完整存取權或代我核准，且只打了健康檢查", async (t) => {
  const f = fixture(t);
  const calls = [];
  await assert.rejects(imagegen.runRelayImagegen(f.args, { configPath: f.configPath,
    fetchImpl: async (url) => { calls.push(String(url)); throw networkError("EPERM"); } }), (error) => {
    assert.match(error.message, /沙盒/);
    assert.match(error.message, /提升權限/);
    assert.match(error.message, /完整存取權/);
    assert.match(error.message, /代我核准/);
    assert.match(error.message, /沒有送出生圖請求/);
    return true;
  });
  assert.deepEqual(calls, ["http://127.0.0.1:48953/healthz"]);
  assert.equal(existsSync(f.out), false);
});

test("拒絕連線：先提示路由器沒在執行，再提沙盒；回應格式不對則提示更新", async (t) => {
  const f = fixture(t);
  await assert.rejects(imagegen.runRelayImagegen(f.args, { configPath: f.configPath,
    fetchImpl: async () => { throw networkError("ECONNREFUSED"); } }), /拒絕連線.*沒在執行.*完整存取權/s);
  await assert.rejects(imagegen.runRelayImagegen(f.args, { configPath: f.configPath,
    fetchImpl: async () => Response.json({ status: "ok", stats: {} }) }), /更新路由器/);
  // 沒有錯誤碼（例如逾時）也一律給沙盒提示，不留空白訊息。
  await assert.rejects(imagegen.runRelayImagegen(f.args, { configPath: f.configPath,
    fetchImpl: async () => { throw new DOMException("timeout", "TimeoutError"); } }), /沙盒.*完整存取權/s);
});

test("技能說明：generate／edit 在沙盒中直接申請提升權限，並告訴使用者可改完整存取權或代我核准", () => {
  for (const platform of ["win32", "darwin"]) {
    const text = installer.renderRelayImageSkill({ root: "/skills/router-imagegen", nodePath: "/node", models: [model], platform });
    assert.match(text, /## 權限/);
    assert.match(text, /以提升權限執行 generate／edit/);
    assert.match(text, /完整存取權/);
    assert.match(text, /代我核准/);
  }
});
