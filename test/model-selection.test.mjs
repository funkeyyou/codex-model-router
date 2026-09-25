// 安裝器挑選與探測模型。
//
// - 部分閘道的 /models 不完整，模型明明能用卻選不到；現在可以直接輸入清單沒有列出的 ID。
// - 以前逐一探測，每個模型最多五次請求，選十個模型就要等好幾分鐘；現在平行探測，
//   輸出仍依選擇順序整段印出，不會交錯。

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { loadPayloads } from "./helpers/payloads.mjs";

const { installer } = await loadPayloads();
const { parseModelSelection, probeModelsInParallel } = installer;
const models = ["claude-opus-5", "gpt-6", "gemini-3-pro", "deepseek-v4"];

test("編號、範圍與 all 照舊可用", () => {
  assert.deepEqual(parseModelSelection("1,3", models), ["claude-opus-5", "gemini-3-pro"]);
  assert.deepEqual(parseModelSelection("2 - 4", models), ["gpt-6", "gemini-3-pro", "deepseek-v4"]);
  assert.deepEqual(parseModelSelection("all", models), models);
  assert.throws(() => parseModelSelection("9", models), /超出範圍/);
});

test("可以直接輸入清單沒有列出的模型 ID，並與編號混用、去除重複", () => {
  assert.deepEqual(parseModelSelection("2, qwen3-max, 2，vendor/model-x", models), ["gpt-6", "qwen3-max", "vendor/model-x"]);
});

test("格式可疑的 ID 會被拒絕", () => {
  for (const bad of ["has space", "-leading-dash", "a\"quote", "x".repeat(201)]) {
    assert.throws(() => parseModelSelection(bad, models), /格式無效|超出範圍/, bad);
  }
  assert.throws(() => parseModelSelection(" , ", models), /沒有選擇任何模型/);
});

test("平行探測：同時進行的數量有上限，結果依原順序對應", async () => {
  let running = 0;
  let peak = 0;
  const durations = [40, 5, 25, 10, 15];
  const results = await probeModelsInParallel(["a", "b", "c", "d", "e"], async (model, log) => {
    running += 1;
    peak = Math.max(peak, running);
    log.line(`測試 ${model}`);
    await delay(durations["abcde".indexOf(model)]);
    running -= 1;
    return { route: model.toUpperCase() };
  }, { concurrency: 2, print: () => {} });
  assert.equal(peak, 2);
  assert.deepEqual(results.map((result) => result.route), ["A", "B", "C", "D", "E"]);
});

test("平行探測：輸出依選擇順序整段印出，不交錯", async () => {
  const printed = [];
  await probeModelsInParallel(["slow", "fast"], async (model, log) => {
    log.write(`${model}:開始 `);
    await delay(model === "slow" ? 30 : 1);
    log.line(`${model}:結束`);
  }, { concurrency: 2, print: (text) => printed.push(text) });
  assert.deepEqual(printed, ["slow:開始 slow:結束\n", "fast:開始 fast:結束\n"]);
});

test("平行探測：有一個丟出例外時，等全部結束後拋出", async () => {
  const finished = [];
  await assert.rejects(probeModelsInParallel(["ok", "boom", "late"], async (model) => {
    await delay(model === "late" ? 20 : 1);
    if (model === "boom") throw new Error("探測炸了");
    finished.push(model);
  }, { concurrency: 3, print: () => {} }), /探測炸了/);
  assert.deepEqual(finished.sort(), ["late", "ok"]);
});
