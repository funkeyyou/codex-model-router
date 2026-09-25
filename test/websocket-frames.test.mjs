// WebSocket 訊框的逐塊讀取。
//
// 以前每收到一塊 TCP 資料就把整個緩衝區 Buffer.concat 再從頭解析。Codex 送來的
// 一則 30 MB response.create 以 64 KiB 分塊到達時，累計要複製約 7 GiB（實測 1.3 秒）；
// 讀取器改成先讀標頭算出訊框長度，收齊才合併一次。

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadPayloads } from "./helpers/payloads.mjs";

const { router } = await loadPayloads();
const { createWebSocketFrameReader, parseWebSocketFrames, encodeWebSocketFrame,
        encodeMaskedWebSocketFrame, webSocketFrameLength } = router;

function feed(reader, buffer, sizes) {
  const frames = [];
  let offset = 0;
  let index = 0;
  while (offset < buffer.length) {
    const size = sizes[index++ % sizes.length];
    frames.push(...reader.push(buffer.subarray(offset, offset + size)));
    offset += size;
  }
  return frames;
}

const summarize = (frames) => frames.map((frame) => [frame.opcode, frame.fin, frame.payload.toString("base64")]);

test("任意切塊方式解析出的訊框，與一次解析整段完全相同", () => {
  const frames = [
    encodeWebSocketFrame(0x1, "short"),
    encodeMaskedWebSocketFrame(0x1, "x".repeat(300)),       // 16 位元長度
    encodeMaskedWebSocketFrame(0x2, randomBytes(70000)),    // 64 位元長度
    encodeWebSocketFrame(0x9, Buffer.alloc(0)),
    encodeMaskedWebSocketFrame(0x1, "尾巴"),
  ];
  const whole = Buffer.concat(frames);
  const expected = summarize(parseWebSocketFrames(whole).frames);
  for (const sizes of [[1], [2, 3], [7], [13, 1, 5000], [65536], [whole.length]]) {
    const reader = createWebSocketFrameReader();
    assert.deepEqual(summarize(feed(reader, whole, sizes)), expected, `切塊：${sizes.join(",")}`);
  }
});

test("大訊息的合併成本與訊息大小成正比，不再是平方成長", () => {
  const payload = randomBytes(8 * 1024 * 1024);
  const frame = encodeMaskedWebSocketFrame(0x1, payload);
  const reader = createWebSocketFrameReader();
  const frames = feed(reader, frame, [16 * 1024]);
  assert.equal(frames.length, 1);
  assert.ok(frames[0].payload.equals(payload));
  // 舊寫法：512 塊 × 平均 4 MiB ≈ 2 GiB。
  assert.ok(reader.copiedBytes <= 2 * frame.length, `累計複製 ${reader.copiedBytes} 位元組`);
});

test("標頭一到就拒絕超過上限的訊框，不必等資料收完", () => {
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(200 * 1024 * 1024), 2);
  const reader = createWebSocketFrameReader();
  assert.throws(() => reader.push(header), /超過路由器限制/);
  assert.throws(() => webSocketFrameLength(header, 1024), /超過路由器限制/);
});

test("握手回應後面緊跟的訊框（leftover）會在下一塊資料到達時一起解析", () => {
  const first = encodeWebSocketFrame(0x1, "leftover");
  const second = encodeWebSocketFrame(0x1, "next");
  const reader = createWebSocketFrameReader(first);
  const frames = reader.push(second);
  assert.deepEqual(frames.map((frame) => frame.payload.toString()), ["leftover", "next"]);
});

test("標頭不完整時回報至少還要多少位元組", () => {
  assert.equal(webSocketFrameLength(Buffer.alloc(0)), 2);
  assert.equal(webSocketFrameLength(Buffer.from([0x81, 126])), 4);
  assert.equal(webSocketFrameLength(Buffer.from([0x81, 127, 0])), 10);
  assert.equal(webSocketFrameLength(Buffer.from([0x81, 0x80 | 5])), 2 + 4 + 5);
});

test("握手後殘留的資料就算帶著超大標頭，也不會在建構時丟出例外", () => {
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(200 * 1024 * 1024), 2);
  const reader = createWebSocketFrameReader(header);
  assert.throws(() => reader.push(Buffer.from([0])), /超過路由器限制/, "由呼叫端的錯誤處理接住");
});
