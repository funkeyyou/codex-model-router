// 內建 image_gen 工具打的路徑。
//
// 路由器原本只認 /healthz、/models、/responses，其餘硬回 404 —— 使用者看到的
// 「內建圖片生成服務回傳 404」就是這裡擋掉的，不是上游回的。
// 官方後端沒有這條路徑（officialBase 是 .../backend-api/codex），自訂閘道有。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { router } = await loadPayloads();
const { IMAGE_PATH_PATTERN } = router;

test("認得內建工具實際使用的路徑", () => {
  for (const path of ["/v1/images/generations", "/images/generations"]) {
    assert.equal(IMAGE_PATH_PATTERN.test(path), true, path);
  }
});

test("編輯與變體端點一併涵蓋", () => {
  for (const path of ["/v1/images/edits", "/images/edits",
                      "/v1/images/variations", "/images/variations"]) {
    assert.equal(IMAGE_PATH_PATTERN.test(path), true, path);
  }
});

test("不會誤攔其他路徑", () => {
  for (const path of ["/v1/responses", "/responses", "/healthz", "/v1/models",
                      "/images", "/v1/images", "/v1/images/generations/extra",
                      "/v2/images/generations", "/xx/v1/images/generations"]) {
    assert.equal(IMAGE_PATH_PATTERN.test(path), false, path);
  }
});
