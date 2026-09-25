// 安裝器重新配置時會以固定欄位重寫 settings.json，沒列在 preservedSettingKeys 的
// 可調設定就會被靜默洗掉。這裡核對路由器讀取的每一個 settings 欄位：不是安裝器
// 自己管理的，就必須在保留清單裡。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();

// 由安裝器依安裝結果寫入的欄位，不是使用者的旋鈕。
const managedByInstaller = new Set([
  "apiRoot", "catalogPath", "credentialPath", "forceListedModels", "imageOutputDir",
  "keychainAccount", "keychainService", "logPath", "officialBaseUrl", "port", "routes", "version",
]);

test("路由器讀取的每個可調設定，重新配置時都會保留", () => {
  const source = readFileSync(new URL("../src/router.mjs", import.meta.url), "utf8");
  const used = new Set([...source.matchAll(/\bsettings\.([A-Za-z]+)\b/g)].map((match) => match[1]));
  used.delete("json"); // 註解與路徑裡的 settings.json
  const missing = [...used].filter((key) => !managedByInstaller.has(key) && !installer.preservedSettingKeys.includes(key));
  assert.deepEqual(missing, []);
});
