// 路由器裡兩組容易靜默出錯的純邏輯：
//   1. 從 Claude 路由切出去前，剝除轉譯層自鑄的內容（漏掉就切不回官方模型）
//   2. WebSocket 訊框的編解碼（RFC 6455）

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { router, bridge } = await loadPayloads();
const { isBridgeMintedId, stripBridgeReasoning, stripBridgeItemIds,
        rewriteBridgeCompaction, historyKeyFor,
        parseWebSocketFrames, encodeWebSocketFrame, encodeMaskedWebSocketFrame } = router;

// --- 自鑄 item id 的辨識 -----------------------------------------------------
// 上游發的 id 一律小寫十六進位；轉譯層合成的帶大寫。認錯會誤刪上游的真 id。

test("帶大寫後綴的 id 判定為自鑄", () => {
  for (const id of ["msg_AbCdEfGhIjKlMnOpQrSt", "fc_ZZxxYYwwVVuuTTssRRqq", "rs_aaaaaaaaaaaaaaaaaaaB"]) {
    assert.equal(isBridgeMintedId(id), true, id);
  }
});

test("上游的小寫十六進位 id 不會被誤判", () => {
  for (const id of ["msg_0123456789abcdef0123", "fc_deadbeefdeadbeefdead", "rs_00112233445566778899"]) {
    assert.equal(isBridgeMintedId(id), false, id);
  }
});

test("前綴或長度不符的一律不動", () => {
  for (const id of ["", "msg_Short", "unknown_AbCdEfGhIjKlMnOpQrSt", "AbCdEfGhIjKlMnOpQrSt", null, undefined, 42]) {
    assert.equal(isBridgeMintedId(id), false, String(id));
  }
});

test("剝除 id 時保留整個項目，只拿掉 id 欄位", () => {
  const input = [
    { id: "fc_AbCdEfGhIjKlMnOpQrSt", type: "function_call", call_id: "call_1", name: "grep", arguments: "{}" },
    { id: "msg_0123456789abcdef0123", type: "message", role: "user", content: [] },
  ];
  const result = stripBridgeItemIds(input);
  assert.equal(result.removed, 1);
  // 工具配對靠 call_id，內容不能被動到。
  assert.deepEqual(result.input[0], { type: "function_call", call_id: "call_1", name: "grep", arguments: "{}" });
  assert.equal(result.input[1].id, "msg_0123456789abcdef0123");
});

test("沒有自鑄 id 時原樣回傳同一個陣列", () => {
  const input = [{ id: "msg_0123456789abcdef0123", type: "message" }];
  const result = stripBridgeItemIds(input);
  assert.equal(result.removed, 0);
  assert.equal(result.input, input);
});

// --- 轉譯層 reasoning 的剝除 -------------------------------------------------
// 官方後端驗不過本機編的 encrypted_content，留著就整輪被拒。

test("只剝掉轉譯層編的 reasoning，上游的原樣留著", () => {
  const input = [
    { type: "reasoning", encrypted_content: bridge.encodeReasoning("想", "sig") },
    { type: "reasoning", encrypted_content: "b3JpZ2luYWwtdXBzdHJlYW0tYmxvYg==" },
    { type: "message", role: "user", content: [] },
  ];
  const result = stripBridgeReasoning(input);
  assert.equal(result.removed, 1);
  assert.equal(result.input.length, 2);
  assert.equal(result.input[0].encrypted_content, "b3JpZ2luYWwtdXBzdHJlYW0tYmxvYg==");
});

test("沒有 encrypted_content 的 reasoning 不算轉譯層的", () => {
  const input = [{ type: "reasoning" }, { type: "reasoning", encrypted_content: "" }];
  assert.equal(stripBridgeReasoning(input).removed, 0);
});

// --- compaction 還原 ---------------------------------------------------------

test("轉譯層的 compaction 還原成一般 user 訊息", () => {
  const input = [{ type: "compaction", encrypted_content: bridge.encodeCompaction("摘要") }];
  const result = rewriteBridgeCompaction(input);
  assert.equal(result.removed, 1);
  assert.equal(result.input[0].type, "message");
  assert.equal(result.input[0].role, "user");
  assert.match(result.input[0].content[0].text, /摘要$/);
});

test("解不開的 compaction 原樣留著（可能是上游自己的）", () => {
  const input = [{ type: "compaction", encrypted_content: "不是我們編的" }];
  const result = rewriteBridgeCompaction(input);
  assert.equal(result.removed, 0);
  assert.equal(result.input[0].type, "compaction");
});

// --- 歷史鍵 -----------------------------------------------------------------
// 背景任務可能與目前 task 共用 session_id；WebSocket 路徑必須用連線 namespace 隔離。

test("WebSocket 路徑以連線 namespace 隔離相同的 session_id", () => {
  const body = { client_metadata: { session_id: "s-1" } };
  const a = historyKeyFor(body, {}, "conn-a");
  const b = historyKeyFor(body, {}, "conn-b");
  assert.notEqual(a, b);
  assert.equal(historyKeyFor(body, {}, "conn-a"), a);
});

test("沒有 session_id 時退回連線 namespace 本身", () => {
  assert.equal(historyKeyFor({}, {}, "conn-a"), "conn-a");
});

test("HTTP 路徑沿用 session_id，其次才看 header", () => {
  assert.equal(historyKeyFor({ client_metadata: { session_id: "s-1" } }, { "thread-id": "t-1" }), "s-1");
  assert.equal(historyKeyFor({}, { "thread-id": "t-1" }), "t-1");
  assert.equal(historyKeyFor({}, { "session-id": "x-1" }), "x-1");
  assert.equal(historyKeyFor({}, {}), null);
});

// --- WebSocket 訊框 ---------------------------------------------------------

const roundTrip = (payload) => {
  const { frames, remainder } = parseWebSocketFrames(encodeMaskedWebSocketFrame(0x1, payload));
  assert.equal(remainder.length, 0);
  assert.equal(frames.length, 1);
  return frames[0];
};

test("三種長度分支都能往返（<=125 / 16 位元 / 64 位元）", () => {
  for (const size of [0, 1, 125, 126, 200, 0xffff, 0x10000]) {
    const payload = Buffer.alloc(size, 0x61);
    const frame = roundTrip(payload);
    assert.equal(frame.payload.length, size, `size=${size}`);
    assert.ok(frame.payload.equals(payload), `size=${size}`);
  }
});

test("客戶端訊框一定要加遮罩，伺服器訊框一定不加（RFC 6455）", () => {
  assert.equal((encodeMaskedWebSocketFrame(0x1, "hi")[1] & 0x80) !== 0, true);
  assert.equal((encodeWebSocketFrame(0x1, "hi")[1] & 0x80) !== 0, false);
});

test("遮罩過的內容在線路上不是明文", () => {
  const text = "aaaaaaaaaaaaaaaaaaaaaaaa";
  assert.equal(encodeMaskedWebSocketFrame(0x1, text).includes(Buffer.from(text)), false);
  assert.equal(roundTrip(Buffer.from(text)).payload.toString(), text);
});

test("UTF-8 內容不會被截斷或走樣", () => {
  const text = "路由器：中文與 emoji 🚀 都要完整";
  assert.equal(roundTrip(Buffer.from(text, "utf8")).payload.toString("utf8"), text);
});

test("fin 與 opcode 正確解出", () => {
  const frame = roundTrip(Buffer.from("x"));
  assert.equal(frame.fin, true);
  assert.equal(frame.opcode, 0x1);
  assert.equal(parseWebSocketFrames(encodeWebSocketFrame(0x8)).frames[0].opcode, 0x8);
});

test("一個 buffer 裡的連續訊框會全部解出", () => {
  const buffer = Buffer.concat([
    encodeMaskedWebSocketFrame(0x1, "一"),
    encodeMaskedWebSocketFrame(0x1, "二"),
    encodeMaskedWebSocketFrame(0x9),
  ]);
  const { frames, remainder } = parseWebSocketFrames(buffer);
  assert.equal(frames.length, 3);
  assert.equal(remainder.length, 0);
  assert.deepEqual(frames.map((f) => f.opcode), [0x1, 0x1, 0x9]);
});

test("不完整的訊框整段留在 remainder，等下一塊資料", () => {
  const full = encodeMaskedWebSocketFrame(0x1, "需要更多資料");
  for (const cut of [1, 2, 5, full.length - 1]) {
    const { frames, remainder } = parseWebSocketFrames(full.subarray(0, cut));
    assert.equal(frames.length, 0, `cut=${cut}`);
    assert.equal(remainder.length, cut, `cut=${cut}`);
  }
});

test("超過上限的訊框長度會擋下來，不會照著配置記憶體", () => {
  // 64 位元長度分支宣告 64 MB，超過 32 MB 上限。
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(64n * 1024n * 1024n, 2);
  assert.throws(() => parseWebSocketFrames(header), /超過路由器限制/);
});
