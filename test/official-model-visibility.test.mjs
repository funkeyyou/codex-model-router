// 顯示偏好只作用於 /models，不覆寫官方原始目錄、不改登入，也不擋推理路由。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPayloads, loadRouterInDir } from "./helpers/payloads.mjs";

const { router, installer } = await loadPayloads();
const model = (slug, visibility = "list") => ({ slug, display_name: slug, visibility,
  supported_reasoning_levels: [{ effort: "high", description: "High" }], context_window: 1000000 });
const catalog = { schema: 1, models: [model("gpt-official"), model("gpt-hidden", "hide"), model("custom/test")] };

test("官方選項隱藏優先於強制顯示，模型能力、自訂項目與來源不變", () => {
  const fresh = router.mergeOfficialCatalog(catalogWithoutCustom(), catalog, ["gpt-hidden"]);
  const snapshot = structuredClone(fresh);
  const shown = router.applyOfficialModelVisibility(fresh);
  assert.equal(shown, fresh);
  const hidden = router.applyOfficialModelVisibility(fresh, true);
  assert.deepEqual(hidden.models.map(item => item.visibility), ["hide", "hide", "list"]);
  assert.equal(hidden.models[0].context_window, 1000000);
  assert.equal(hidden.models[2], fresh.models[2]);
  assert.deepEqual(fresh, snapshot);
  assert.equal(router.applyOfficialModelVisibility(fresh, false).models[1].visibility, "list");
});

test("沒有可選自訂模型時保留官方選項，避免刪除最後一個模型後清單全空", () => {
  const empty = { models: [] };
  assert.equal(router.applyOfficialModelVisibility(empty, true), empty);
  const hiddenCustom = { models: [model("gpt-official"), model("custom/test", "hide")] };
  assert.equal(router.applyOfficialModelVisibility(hiddenCustom, true), hiddenCustom);
  const onlyOfficial = catalogWithoutCustom();
  assert.equal(router.applyOfficialModelVisibility(onlyOfficial, true), onlyOfficial);
});

test("API Key 模式移除官方項目而非只標成隱藏，來源與自訂能力不變", () => {
  const hiddenCustom = { ...catalog, models: [...catalog.models, model("custom/hidden", "hide")] };
  for (const source of [catalog, hiddenCustom]) {
    const snapshot = structuredClone(source);
    const hidden = installer.apiKeyCatalog(source);
    assert.deepEqual(hidden, router.applyOfficialModelVisibility(source, false, true));
    assert.deepEqual(hidden.models, source.models.filter(model => model.slug.startsWith("custom/")));
    assert.deepEqual(source, snapshot);
  }
});

test("尚無自訂模型時保留全隱藏的非空靜態目錄，避免 Codex 拒絕啟動", () => {
  const source = catalogWithoutCustom();
  const snapshot = structuredClone(source);
  const result = installer.apiKeyCatalog(source);
  assert.equal(result.models.length, source.models.length);
  assert.ok(result.models.every(model => model.visibility === "hide"));
  assert.deepEqual(router.applyOfficialModelVisibility(source, false, true).models, []);
  assert.deepEqual(source, snapshot);
});

function catalogWithoutCustom() {
  return { models: catalog.models.filter(item => !item.slug.startsWith("custom/")) };
}

for (const mode of ["online", "offline", "sync-disabled"]) {
  test(`${mode}：兩種 /models 入口熱切換，隱藏不寫入快取，關閉可還原`, async t => {
    const catalogRoot = mkdtempSync(join(tmpdir(), "router-model-visibility-"));
    t.after(() => rmSync(catalogRoot, { recursive: true, force: true }));
    const path = join(catalogRoot, "models.json");
    writeFileSync(path, JSON.stringify(catalog));
    const { dir, router: running } = await loadRouterInDir({ catalogPath: path,
      hideOfficialModels: true, catalogRefresh: mode !== "sync-disabled" });
    const settingsPath = join(dir, "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const update = hidden => writeFileSync(settingsPath, JSON.stringify({ ...settings, hideOfficialModels: hidden }));
    running.routerServer.listen(0, "127.0.0.1");
    await once(running.routerServer, "listening");
    t.after(() => new Promise(resolve => running.routerServer.close(resolve)));
    const realFetch = globalThis.fetch;
    let fetches = 0;
    t.mock.method(globalThis, "fetch", async () => {
      fetches++;
      return mode === "offline" ? new Response("unavailable", { status: 503 })
        : new Response(JSON.stringify({ models: [...catalogWithoutCustom().models, model("gpt-new")] }));
    });
    const origin = `http://127.0.0.1:${running.routerServer.address().port}`;
    const get = async path => {
      const response = await realFetch(origin + path, { headers: { authorization: "Bearer fixture-account-token" } });
      assert.equal(response.status, 200);
      return response.json();
    };
    for (const endpoint of ["/models?client_version=0.157.0", "/v1/models?client_version=0.157.0"]) {
      const hidden = await get(endpoint);
      assert.ok(hidden.models.filter(item => !item.slug.startsWith("custom/")).every(item => item.visibility === "hide"));
      assert.equal(hidden.models.find(item => item.slug === "custom/test").visibility, "list");
    }
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(saved.models.find(item => item.slug === "gpt-official").visibility, "list");
    assert.equal(saved.models.some(item => item.slug === "gpt-new"), mode === "online", "新增官方模型仍會同步");
    const offlineBackup = readFileSync(path, "utf8");
    update(false);
    const restored = await get("/models"); // 缺 client_version，純離線還原。
    assert.deepEqual(restored, saved);
    assert.equal(readFileSync(path, "utf8"), offlineBackup);
    assert.equal(fetches, mode === "sync-disabled" ? 0 : 2);

    // API Key 模式強制隱藏官方項目，保留原目錄；本機 Key 絕不發給官方。
    const localKey = "fixture-local-quota-key";
    writeFileSync(join(dir, "quota-mode.json"), JSON.stringify({ enabled: true,
      keySha256: createHash("sha256").update(localKey).digest("hex") }));
    update(true);
    for (const endpoint of ["/models?client_version=0.157.0", "/v1/models?client_version=0.157.0"]) {
      const response = await realFetch(origin + endpoint, { headers: { authorization: `Bearer ${localKey}` } });
      const result = await response.json();
      assert.deepEqual(result, running.applyOfficialModelVisibility(saved, true, true));
      assert.deepEqual(result.models.map(model => model.slug), ["custom/test"]);
    }
    assert.equal(readFileSync(path, "utf8"), offlineBackup);
    assert.equal(fetches, mode === "sync-disabled" ? 0 : 2);
  });
}
