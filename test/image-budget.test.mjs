// 圖片預算。
//
// 背景：單次請求的圖片數量一旦超過 20 張，Anthropic 會把每張圖的尺寸上限從
// 8000 收緊到 2000 像素，超過就整輪 400：
//   At least one of the image dimensions exceed max allowed size
//   for many-image requests: 2000 pixels
// 實測（同一張合成 PNG，只改高度與張數）：20 張 2048px 通過、21 張同尺寸被拒、
// 21 張 1800px 通過。iPhone 截圖是 942 x 2048，只超出 48 個像素。
//
// 路由器沒有影像解碼器可以縮圖，所以改為控制張數：保留最新的 20 張，更舊的換
// 成佔位文字。張數回到上限以內之後，尺寸限制自動放寬回 8000 像素。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { bridge } = await loadPayloads();
const { toAnthropicRequest } = bridge;

// 只有檔頭是真的——尺寸判斷只讀檔頭，不需要能解碼的完整圖。
const png = (width, height) => {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return "data:image/png;base64," + buf.toString("base64");
};

const imageMessage = (url) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_image", image_url: url }],
});

const build = (input) =>
  toAnthropicRequest({ input }, { upstreamModel: "claude-x" });

const countImages = (request) => {
  let n = 0;
  const walk = (blocks) => {
    for (const block of blocks || []) {
      if (block.type === "image") n += 1;
      else if (Array.isArray(block.content)) walk(block.content);
    }
  };
  for (const message of request.messages) walk(message.content);
  return n;
};

test("剛好 20 張圖不會被動到", () => {
  const input = Array.from({ length: 20 }, () => imageMessage(png(942, 2048)));
  const { request, imagesOmitted } = build(input);
  assert.equal(countImages(request), 20);
  assert.equal(imagesOmitted, 0);
});

test("21 張圖時丟掉最舊的一張，換成佔位文字", () => {
  const input = Array.from({ length: 21 }, (_, i) => imageMessage(png(100 + i, 200)));
  const { request, imagesOmitted } = build(input);
  assert.equal(countImages(request), 20);
  assert.equal(imagesOmitted, 1);
  const first = request.messages[0].content[0];
  assert.equal(first.type, "text");
  assert.match(first.text, /圖片已省略/);
});

test("被留下的是最新的那些，不是最舊的", () => {
  const input = Array.from({ length: 25 }, (_, i) => imageMessage(png(1000 + i, 200)));
  const { request } = build(input);
  const widths = [];
  const walk = (blocks) => {
    for (const block of blocks || []) {
      if (block.type === "image") {
        widths.push(Buffer.from(block.source.data, "base64").readUInt32BE(16));
      } else if (Array.isArray(block.content)) walk(block.content);
    }
  };
  for (const message of request.messages) walk(message.content);
  assert.deepEqual(widths, Array.from({ length: 20 }, (_, i) => 1005 + i));
});

test("單張超過 8000 像素一律換掉，就算總數只有一張", () => {
  const { request, imagesOmitted } = build([imageMessage(png(900, 12000))]);
  assert.equal(countImages(request), 0);
  assert.equal(imagesOmitted, 1);
  assert.match(request.messages[0].content[0].text, /尺寸超過/);
});

test("工具結果裡的圖也算進預算，換掉之後 content 不會變空", () => {
  const input = [];
  for (let i = 0; i < 21; i += 1) {
    input.push({ type: "custom_tool_call", call_id: "c" + i, name: "exec", input: "x" });
    input.push({
      type: "custom_tool_call_output",
      call_id: "c" + i,
      output: [{ type: "input_image", image_url: png(942, 2048) }],
    });
  }
  const { request, imagesOmitted } = build(input);
  assert.equal(countImages(request), 20);
  assert.equal(imagesOmitted, 1);
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      assert.ok(block.content.length > 0, "tool_result 不能是空的");
    }
  }
});

test("認不出格式的圖不會被誤判成超標而刪掉", () => {
  const junk = "data:image/webp;base64," + Buffer.from("not a real image").toString("base64");
  const { request, imagesOmitted } = build([imageMessage(junk)]);
  assert.equal(countImages(request), 1);
  assert.equal(imagesOmitted, 0);
});
