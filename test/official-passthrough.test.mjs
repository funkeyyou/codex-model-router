// 不認得的路徑要原樣轉送官方後端。
//
// 網路查詢是 POST {base_url}/alpha/search，筆記與歷史是 /alpha/notes/v2/* 與
// /alpha/history/v2/*。這些都不在路由器自己處理的清單裡，原本一律回 404，
// 等於把整組功能打掉；而且 openai_base_url 是全域的，官方模型一樣不能用。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPayloads } from "./helpers/payloads.mjs";

const { router } = await loadPayloads();
const { targetUrl } = router;

const official = (path) => targetUrl(false, new URL("http://127.0.0.1:48953" + path)).href;

test("/v1 前綴會被剝掉，接到官方後端底下", () => {
  assert.equal(official("/v1/alpha/search"),
    "https://chatgpt.example/backend-api/codex/alpha/search");
  assert.equal(official("/v1/alpha/notes/v2/read_file"),
    "https://chatgpt.example/backend-api/codex/alpha/notes/v2/read_file");
  assert.equal(official("/v1/alpha/history/v2/list_items"),
    "https://chatgpt.example/backend-api/codex/alpha/history/v2/list_items");
});

test("沒有 /v1 前綴的路徑原樣接上", () => {
  assert.equal(official("/alpha/search"),
    "https://chatgpt.example/backend-api/codex/alpha/search");
});

test("query string 會保留", () => {
  assert.equal(official("/v1/alpha/search?q=abc&n=3"),
    "https://chatgpt.example/backend-api/codex/alpha/search?q=abc&n=3");
});
