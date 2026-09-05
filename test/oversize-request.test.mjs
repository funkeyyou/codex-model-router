// 送往上游前的尺寸檢查。
//
// 背景：一條長對話的完整歷史送不出去時，閘道只回一句通用的
// {"error":{"message":"Upstream request failed"}}，客戶端看不出原因，於是 Codex
// 每 8 秒重試一次——而每次重試都把整份歷史重新上傳一遍。實測那條對話：
// 622 個項目、37.6 MB，其中 166 筆工具輸出就佔了 34.3 MB（91%），最大單筆 3 MB；
// 轉譯成 Anthropic 請求後 35.5 MB，超過 Messages API 的 32 MB 上限。
// 重試 31 次 = 白傳 1.1 GB，而且不可能成功。
//
// 這一層的用意不是讓請求變得送得出去，是讓「送不出去」這件事講得清楚，
// 並且在送出前就停下來。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { router } = await loadPayloads();
const { upstreamRequestTooLarge, oversizeMessage } = router;

const MB = 1024 * 1024;

// --- 門檻 -------------------------------------------------------------------

test("超過上限才擋，剛好等於上限要放行", () => {
  assert.equal(upstreamRequestTooLarge(32 * MB, 32 * MB), false, "等於上限 -> 放行");
  assert.equal(upstreamRequestTooLarge(32 * MB + 1, 32 * MB), true, "多一個位元組 -> 擋");
  assert.equal(upstreamRequestTooLarge(1, 32 * MB), false);
});

test("實際踩到的那筆會被擋下來", () => {
  // 002-custom-http.anthropic-request.json 的實際大小。
  assert.equal(upstreamRequestTooLarge(37264963, 32 * MB), true);
});

test("量不到大小時不擋（寧可讓上游自己判斷，也不要憑空拒絕）", () => {
  for (const bytes of [NaN, Infinity, undefined, null, "37264963"]) {
    assert.equal(upstreamRequestTooLarge(bytes, 32 * MB), false, String(bytes));
  }
});

// --- 訊息 -------------------------------------------------------------------

test("訊息帶上實際大小與上限，使用者才知道差多少", () => {
  const message = oversizeMessage(37264963, 32 * MB);
  assert.match(message, /35\.5 MB/, "要講出實際大小");
  assert.match(message, /32\.0 MB/, "也要講出上限");
});

test("訊息要說明重試沒用，否則使用者只會一直按重試", () => {
  const message = oversizeMessage(37264963, 32 * MB);
  assert.match(message, /重試/);
  assert.match(message, /新對話/);
});
