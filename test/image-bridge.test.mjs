// 生圖結果的轉譯。
//
// 背景：部分閘道自己啟用了 image_generation，回應帶著整張圖的 base64。
// Codex 收得到、存進歷史、還會原樣送回來（實測那張圖 2,112,230 bytes 完整無缺），
// 但它只在自己主動要求生圖時才有顯示路徑，所以圖就沉在歷史裡看不到。
//
// 轉譯成 view_image（Codex 的內建用戶端工具，features list 顯示 stable/true）。
// 連鎖問題：Codex 執行完會把 function_call_output 送回來，而上游從沒宣告過這個
// 工具，原樣轉發會讓下一輪被拒——所以合成的呼叫用可辨識的 call_id 前綴，
// 送往上游前連同輸出一起剝掉。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayloads } from "./helpers/payloads.mjs";

const { router } = await loadPayloads();
const { saveGeneratedImage, isRouterImageCallId, stripRouterImageCalls } = router;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// --- 落地存檔 ---------------------------------------------------------------

test("完成的生圖結果會被寫成檔案", () => {
  const dir = mkdtempSync(join(tmpdir(), "img-"));
  const path = saveGeneratedImage({ result: PNG.toString("base64") }, dir);
  assert.ok(path, "應該回傳路徑");
  assert.ok(readFileSync(path).equals(PNG), "內容要逐位元組相同");
  assert.match(path, /\.png$/);
});

test("依內容判斷副檔名，不是一律 .png", () => {
  const dir = mkdtempSync(join(tmpdir(), "img-"));
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)]);
  assert.match(saveGeneratedImage({ result: jpg.toString("base64") }, dir), /\.jpg$/);
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64)]);
  assert.match(saveGeneratedImage({ result: gif.toString("base64") }, dir), /\.gif$/);
});

test("同一輪多張圖不會互相覆蓋", () => {
  const dir = mkdtempSync(join(tmpdir(), "img-"));
  const a = saveGeneratedImage({ result: PNG.toString("base64") }, dir);
  const b = saveGeneratedImage({ result: PNG.toString("base64") }, dir);
  assert.notEqual(a, b);
  assert.equal(readdirSync(dir).length, 2);
});

test("沒有結果、空字串、爛資料都不會寫出檔案", () => {
  const dir = mkdtempSync(join(tmpdir(), "img-"));
  for (const item of [{}, { result: "" }, { result: "x" }, { result: null }, null, undefined]) {
    assert.equal(saveGeneratedImage(item, dir), null, JSON.stringify(item));
  }
  assert.equal(readdirSync(dir).length, 0);
});

test("目錄建不出來時回傳 null，不會讓整輪炸掉", () => {
  // 不能用 /dev/null/nope：那在 Windows 上是個普通相對路徑，mkdir 會成功，
  // 於是這個測試不但驗不到東西，還會在系統磁碟根目錄寫出 \dev\null\nope\。
  // 改成把目標掛在一個普通檔案底下——兩個平台都會拿到 ENOTDIR。
  const dir = mkdtempSync(join(tmpdir(), "img-"));
  const notADirectory = join(dir, "occupied");
  writeFileSync(notADirectory, "x");
  const target = join(notADirectory, "nope");
  assert.equal(saveGeneratedImage({ result: PNG.toString("base64") }, target), null);
  assert.equal(readdirSync(dir).length, 1, "不該在別處留下檔案");
});

// --- call_id 的辨識 ---------------------------------------------------------

test("只認本機合成的 call_id 前綴", () => {
  assert.equal(isRouterImageCallId("call_rtrimg_0123456789abcdef"), true);
  for (const id of ["call_abc123", "fc_rtrimg_x", "", null, undefined, 42]) {
    assert.equal(isRouterImageCallId(id), false, String(id));
  }
});

// --- 送往上游前的剝除 -------------------------------------------------------

test("合成的呼叫與它的輸出都會被剝掉", () => {
  const callId = "call_rtrimg_deadbeefdeadbeef";
  const input = [
    { type: "message", role: "user", content: [] },
    { type: "function_call", call_id: callId, name: "view_image", arguments: '{"path":"/x.png"}' },
    { type: "function_call_output", call_id: callId, output: "ok" },
    { type: "message", role: "assistant", content: [] },
  ];
  const result = stripRouterImageCalls(input);
  assert.equal(result.removed, 2);
  assert.deepEqual(result.input.map((i) => i.type), ["message", "message"]);
});

test("上游自己的工具呼叫一個都不能動", () => {
  const input = [
    { type: "function_call", call_id: "call_upstream_1", name: "exec", arguments: "{}" },
    { type: "function_call_output", call_id: "call_upstream_1", output: "done" },
  ];
  const result = stripRouterImageCalls(input);
  assert.equal(result.removed, 0);
  assert.equal(result.input, input, "沒有要剝的東西時應回傳同一個陣列");
});

test("image_generation_call 本身保留（它是上游的項目，剝掉會破壞歷史）", () => {
  const input = [{ type: "image_generation_call", id: "ig_1", status: "completed", result: "AAAA" }];
  assert.equal(stripRouterImageCalls(input).removed, 0);
});

test("input 不是陣列時安全通過", () => {
  for (const v of [undefined, null, "文字", 42, {}]) {
    assert.equal(stripRouterImageCalls(v).removed, 0);
  }
});

test("多輪累積的多次合成呼叫會被全部剝掉", () => {
  const input = [];
  for (let i = 0; i < 3; i++) {
    const id = `call_rtrimg_${i}${"0".repeat(15)}`;
    input.push({ type: "function_call", call_id: id, name: "view_image", arguments: "{}" });
    input.push({ type: "function_call_output", call_id: id, output: "ok" });
    input.push({ type: "message", role: "assistant", content: [] });
  }
  const result = stripRouterImageCalls(input);
  assert.equal(result.removed, 6);
  assert.equal(result.input.length, 3);
  assert.ok(result.input.every((i) => i.type === "message"));
});
