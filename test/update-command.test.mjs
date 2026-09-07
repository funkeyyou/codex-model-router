// update 命令的決策邏輯。
//
// 這個命令存在的理由就是「升級不必重新設定模型」，所以這裡盯的不是它有沒有跑完，
// 而是更新後的設定除了版本號以外一模一樣：路由、憑證位置、連接埠與使用者自己調過
// 的旋鈕都不能在升級中被洗掉。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
const { planUpdate } = installer;

const routes = [
  { pickerSlug: "custom/claude-a", upstreamModel: "claude-a", displayName: "claude-a", translate: "anthropic" },
  { pickerSlug: "custom/gpt-b", upstreamModel: "gpt-b", displayName: "gpt-b" },
];

const settings = () => ({
  version: "1.16.0",
  apiRoot: "https://gateway.example/v1",
  baseUrl: "https://gateway.example/v1",
  keychainService: "com.example.router",
  credentialPath: "C:\\creds\\credential.dat",
  port: 48953,
  forceListedModels: ["gpt-5.5"],
  maxLogBytes: 1234567,
  viewImageBridge: false,
  routes: structuredClone(routes),
});

const manifest = () => ({
  version: "1.16.0",
  installedAt: "2026-09-05T17:26:09.545Z",
  port: 48953,
  keychainService: "com.example.router",
  routes: structuredClone(routes),
});

test("更新只改版本號，其餘設定逐欄位保持不變", () => {
  const before = settings();
  const plan = planUpdate(manifest(), before, "1.17.0");
  assert.equal(plan.ok, true);
  assert.equal(plan.settings.version, "1.17.0");
  for (const key of Object.keys(before)) {
    if (key === "version") continue;
    assert.deepEqual(plan.settings[key], before[key], `${key} 不該被更新改動`);
  }
  assert.deepEqual(Object.keys(plan.settings).sort(), Object.keys(before).sort());
});

test("自訂模型原封不動地留下來，不需要重新探測", () => {
  const plan = planUpdate(manifest(), settings(), "1.17.0");
  assert.deepEqual(plan.settings.routes, routes);
  assert.deepEqual(plan.routes, routes);
  assert.equal(plan.manifest.version, "1.17.0");
  assert.deepEqual(plan.manifest.routes, routes);
});

test("不就地改動傳進來的 settings 與 manifest", () => {
  const currentSettings = settings();
  const currentManifest = manifest();
  planUpdate(currentManifest, currentSettings, "1.17.0");
  assert.equal(currentSettings.version, "1.16.0");
  assert.equal(currentManifest.version, "1.16.0");
});

test("連接埠沿用 settings；settings 沒有時退回 manifest", () => {
  const withoutPort = settings();
  delete withoutPort.port;
  assert.equal(planUpdate(manifest(), settings(), "1.17.0").port, 48953);
  assert.equal(planUpdate(manifest(), withoutPort, "1.17.0").port, 48953);
});

test("版本相同仍可執行，並標記為重寫而非升級", () => {
  const plan = planUpdate(manifest(), settings(), "1.16.0");
  assert.equal(plan.ok, true);
  assert.equal(plan.alreadyCurrent, true);
});

test("安裝器比已安裝版本舊時拒絕，避免降級", () => {
  const plan = planUpdate(manifest(), settings(), "1.15.0");
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "installer-older");
  assert.equal(plan.installed, "1.16.0");
});

test("尚未安裝、設定遺失、沒有模型、連接埠無效都不會盲目往下走", () => {
  assert.equal(planUpdate(null, settings(), "1.17.0").reason, "not-installed");
  assert.equal(planUpdate(manifest(), null, "1.17.0").reason, "missing-settings");

  const noRoutes = settings();
  noRoutes.routes = [];
  assert.equal(planUpdate(manifest(), noRoutes, "1.17.0").reason, "no-routes");

  const badPort = settings();
  badPort.port = 0;
  const badManifest = manifest();
  delete badManifest.port;
  assert.equal(planUpdate(badManifest, badPort, "1.17.0").reason, "bad-port");
});

test("版本號無法解析時不當成降級，仍允許更新", () => {
  const oddManifest = manifest();
  oddManifest.version = "nightly";
  const plan = planUpdate(oddManifest, settings(), "1.17.0");
  assert.equal(plan.ok, true);
  assert.equal(plan.alreadyCurrent, false);
});
