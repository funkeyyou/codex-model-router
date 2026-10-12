// 常用供應商預設與廠商圖示：網址、圖示對得上，終端與網頁看到同一份清單。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildIconBlock, embedIcons, prepareIcon } from "../tools/provider-icons.mjs";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
// Windows 簽出可能是 CRLF；比對前統一換行。
const page = readFileSync(new URL("../src/manager.html", import.meta.url), "utf8").replaceAll("\r\n", "\n");

test("每個預設都有唯一 key、有效 ID、https 網址與內嵌圖示", () => {
  const icons = JSON.parse(/id="provider-icons">([\s\S]*?)<\/script>/.exec(page)[1]);
  const keys = new Set();
  const urls = new Set();
  for (const preset of installer.PROVIDER_PRESETS) {
    assert.ok(!keys.has(preset.key), preset.key);
    keys.add(preset.key);
    assert.ok(!urls.has(preset.baseUrl), preset.baseUrl);
    urls.add(preset.baseUrl);
    assert.equal(installer.providerIdError(preset.id, []), null, preset.id);
    assert.match(preset.baseUrl, /^https:\/\/[^/]+(?:\/[^?#]*)?$/);
    assert.doesNotMatch(preset.baseUrl, /\/$/);
    assert.match(preset.keyUrl, /^https:\/\//);
    assert.doesNotMatch(preset.keyUrl, /[?&](?:aff|ref|invite|ic|utm_[a-z]+|track_id)=/i, "不放推廣或追蹤參數");
    assert.ok(["global", "cn"].includes(preset.region));
    assert.ok(Object.hasOwn(icons, preset.icon), `缺少圖示：${preset.icon}`);
    assert.match(icons[preset.icon], /^data:image\/svg\+xml;base64,/);
  }
  assert.ok(Object.hasOwn(icons, "claude"));
});

test("預設網址會帶出對應的供應商 ID，其他網址照舊由主機名稱推導", () => {
  assert.equal(installer.presetForBaseUrl("https://api.deepseek.com/").key, "deepseek");
  assert.equal(installer.suggestProviderId("https://api.deepseek.com"), "deepseek");
  assert.equal(installer.suggestProviderId("https://api.moonshot.cn/v1", ["kimi"]), "kimi-2");
  assert.equal(installer.suggestProviderId("https://dashscope.aliyuncs.com/compatible-mode/v1"), "qwen");
  assert.equal(installer.presetForBaseUrl("https://relay.example/v1"), null);
  assert.equal(installer.suggestProviderId("https://relay.example/v1"), "relay");
});

test("圖示內嵌：拒絕腳本與外部參照，單色圖示改成淺色，manager.html 與素材同步", () => {
  assert.throws(() => prepareIcon("bad", '<svg><script>alert(1)</script></svg>'));
  assert.throws(() => prepareIcon("bad", '<svg><image href="https://evil.example/x.png"/></svg>'));
  assert.throws(() => prepareIcon("bad", '<svg onload="x()"></svg>'));
  const mono = Buffer.from(prepareIcon("mono", '<svg viewBox="0 0 24 24"><title>X</title><path d="M0 0h1"/></svg>').split(",")[1], "base64").toString();
  assert.match(mono, /^<svg fill="#dbe4f3"/);
  assert.doesNotMatch(mono, /<title>/);
  const colored = Buffer.from(prepareIcon("c", '<svg><path fill="#123456" d="M0 0"/></svg>').split(",")[1], "base64").toString();
  assert.doesNotMatch(colored, /#dbe4f3/);
  assert.equal(embedIcons(page, buildIconBlock()), page, "請執行 node tools/provider-icons.mjs");
});
