import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
const route = (pickerSlug, providerId = "ark", upstreamModel = "demo") =>
  ({ pickerSlug, providerId, upstreamModel, displayName: `${providerId}/${upstreamModel}` });

test("失效預設只遷移同供應商、同上游的唯一模型；缺少證據或歧義時清除", () => {
  const old = route("custom/old");
  const next = route("custom/new");
  const config = { model: old.pickerSlug };
  assert.deepEqual(installer.planDefaultModelRepair(config, [next], [old]), { previous: old.pickerSlug, value: next.pickerSlug });
  for (const routes of [[], [route("custom/pri", "pri")], [next, route("custom/duplicate")],
    [route("custom/new", "ark", "ark/demo")], [{ ...next, transport: "claude-cli" }]]) {
    assert.equal(installer.planDefaultModelRepair(config, routes, [old]).value, null);
  }
  assert.equal(installer.planDefaultModelRepair(config, [next]).value, null);
  assert.equal(installer.planDefaultModelRepair(config, [old]), null);
  assert.equal(installer.planDefaultModelRepair({ model: "gpt-official" }, []), null);
  assert.equal(installer.planDefaultModelRepair({}, []), null);
});

test("驗證清單拒絕同 ID 舊名稱、隱藏模型及殘留已刪模型", () => {
  const wanted = route("custom/new");
  const item = { id: wanted.pickerSlug, displayName: wanted.displayName, hidden: false };
  const valid = data => installer.hasExpectedModels({ data }, [wanted], ["custom/old"]);
  assert.equal(valid([item]), true);
  assert.equal(valid([{ ...item, displayName: "api/demo" }]), false);
  assert.equal(valid([{ ...item, hidden: true }]), false);
  assert.equal(valid([item, { id: "custom/old" }]), false);
});

test("快取失效只封存可重建清單，保留憑證、設定及其他檔案", () => {
  const root = mkdtempSync(join(tmpdir(), "picker-cache-test-"));
  const backup = join(root, "backup");
  mkdirSync(backup);
  writeFileSync(join(root, "models_cache.json"), "old-cache");
  writeFileSync(join(root, "auth.json"), "fixture-auth");
  writeFileSync(join(root, "config.toml"), "fixture-config");
  assert.equal(installer.invalidatePickerCache(root, backup), true);
  assert.equal(existsSync(join(root, "models_cache.json")), false);
  assert.equal(readFileSync(join(backup, "models_cache.json"), "utf8"), "old-cache");
  assert.equal(readFileSync(join(root, "auth.json"), "utf8"), "fixture-auth");
  assert.equal(readFileSync(join(root, "config.toml"), "utf8"), "fixture-config");
  assert.equal(installer.invalidatePickerCache(root, backup), false);
});
