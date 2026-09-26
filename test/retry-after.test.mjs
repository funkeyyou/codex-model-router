// Retry-After 換算成秒數（RFC 9110 §10.2.3）。
//
// 值可以是秒數或 HTTP 日期，日期有三種格式，接收端都要認得。以前直接 Number()，
// 日期一律得到 NaN，轉成 WebSocket 錯誤時就少了「try again in Ns」，Codex 只能用
// 自己的退避時間，不會照上游要求的時間等。
//
// asctime 格式不寫時區，但 HTTP 日期一律是 GMT；Date.parse 會把它當成本機時間，
// 在西半球時區就會多等好幾個小時。CI 跑在 UTC 看不出這個差別，所以整個檔案固定
// 用洛杉磯時區（node --test 每個測試檔各自一個行程，不會影響其他檔案）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

process.env.TZ = "America/Los_Angeles";

const { router } = await loadPayloads();
const now = Date.parse("2026-09-26T08:00:00Z");

test("秒數：小數無條件進位，前後空白不影響", () => {
  assert.equal(router.parseRetryAfter("12", now), 12);
  assert.equal(router.parseRetryAfter(" 1.5 ", now), 2);
});

test("三種 HTTP 日期格式都換算成距離現在的秒數", () => {
  assert.equal(router.parseRetryAfter("Sat, 26 Sep 2026 08:00:30 GMT", now), 30);
  assert.equal(router.parseRetryAfter("Saturday, 26-Sep-26 08:00:30 GMT", now), 30);
  assert.equal(router.parseRetryAfter("Sat Sep 26 08:00:30 2026", now), 30, "asctime 沒寫時區也是 GMT");
});

test("沒有值、零、已經過去的時間或看不懂的內容，都不給等待秒數", () => {
  for (const value of [null, undefined, "", "0", "Sat, 26 Sep 2026 07:59:00 GMT", "soon"]) {
    assert.equal(router.parseRetryAfter(value, now), null, String(value));
  }
});
