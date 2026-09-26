// update 命令的決策邏輯。
//
// 這個命令存在的理由就是「升級不必重新設定模型」，所以這裡盯的不是它有沒有跑完，
// 而是已完成預設名稱遷移後，設定除了版本號以外一模一樣：路由、憑證位置、連接埠與
// 使用者旋鈕不能在升級中被洗掉。首次 api/ 名稱遷移另由 model-prefix.test.mjs 驗證；
// 舊版放在頂層的單一供應商欄位，第一次更新時會搬進 providers（內容不變）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
const { planUpdate } = installer;

const routes = [
  { pickerSlug: "custom/claude-a", upstreamModel: "claude-a", displayName: "api/claude-a", translate: "anthropic" },
  { pickerSlug: "custom/gpt-b", upstreamModel: "gpt-b", displayName: "api/gpt-b" },
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

const LEGACY_PROVIDER_FIELDS = ["apiRoot", "baseUrl", "keychainService", "keychainAccount", "credentialPath"];

test("舊版單一供應商的欄位搬進 providers，其餘設定逐欄位保持不變", () => {
  const before = settings();
  const plan = planUpdate(manifest(), before, "1.17.0");
  assert.equal(plan.ok, true);
  assert.equal(plan.settings.version, "1.17.0");
  assert.deepEqual(plan.settings.providers, [{
    id: "default",
    baseUrl: before.baseUrl,
    apiRoot: before.apiRoot,
    keychainService: before.keychainService,
    keychainAccount: "codex",
    credentialPath: before.credentialPath,
  }]);
  for (const key of Object.keys(before)) {
    if (key === "version" || LEGACY_PROVIDER_FIELDS.includes(key)) continue;
    assert.deepEqual(plan.settings[key], before[key], `${key} 不該被更新改動`);
  }
  const expectedKeys = [...Object.keys(before).filter((key) => !LEGACY_PROVIDER_FIELDS.includes(key)), "providers"];
  assert.deepEqual(Object.keys(plan.settings).sort(), expectedKeys.sort());
  assert.deepEqual(plan.manifest.providers, plan.settings.providers);
  // 舊版安裝器的 rollback 不檢查版本，靠 manifest 的 keychainService 刪 Key。
  for (const field of LEGACY_PROVIDER_FIELDS) {
    assert.equal(plan.manifest[field], plan.settings.providers[0][field], `manifest 保留主要供應商的 ${field}`);
  }
});

test("已是新格式時，更新只改版本號，其餘設定逐欄位保持不變", () => {
  const migrated = planUpdate(manifest(), settings(), "1.17.0");
  const plan = planUpdate(migrated.manifest, migrated.settings, "1.18.0");
  assert.equal(plan.ok, true);
  assert.deepEqual({ ...plan.settings, version: migrated.settings.version }, migrated.settings);
  assert.deepEqual({ ...plan.manifest, version: migrated.manifest.version }, migrated.manifest);
});

test("找不到供應商設定，或有模型指向不存在的供應商時拒絕更新", () => {
  const bare = settings();
  for (const field of LEGACY_PROVIDER_FIELDS) delete bare[field];
  const bareManifest = manifest();
  delete bareManifest.keychainService;
  assert.equal(planUpdate(bareManifest, bare, "1.17.0").reason, "no-providers");

  const orphan = settings();
  orphan.routes = [...orphan.routes, { pickerSlug: "custom/gone-x", upstreamModel: "x", providerId: "gone" }];
  assert.equal(planUpdate(manifest(), orphan, "1.17.0").reason, "unknown-provider");
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

test("尚未安裝、設定遺失、路由清單缺失、連接埠無效都不會盲目往下走", () => {
  assert.equal(planUpdate(null, settings(), "1.17.0").reason, "not-installed");
  assert.equal(planUpdate(manifest(), null, "1.17.0").reason, "missing-settings");

  const noRoutes = settings();
  delete noRoutes.routes;
  assert.equal(planUpdate(manifest(), noRoutes, "1.17.0").reason, "no-routes");

  const emptyRoutes = settings();
  emptyRoutes.routes = [];
  assert.equal(planUpdate(manifest(), emptyRoutes, "1.17.0").ok, true);
  assert.deepEqual(planUpdate(manifest(), emptyRoutes, "1.17.0").settings.routes, []);

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
