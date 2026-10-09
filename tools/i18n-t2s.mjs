#!/usr/bin/env node
// 重新產生網頁管理介面的繁轉簡字表：src/manager.html 裡 i18n-data 的 t2s.from／t2s.to，
// 以及 test/fixtures/t2s-identity.txt（繁簡寫法相同、不必轉換的字）。
//
//   node tools/i18n-t2s.mjs           # 寫入
//   node tools/i18n-t2s.mjs --check   # 只比對，需要更新時以非零狀態結束
//
// 字表只收原始碼與更新說明實際用到的字，逐字交給 OpenCC（t2s）轉換；有變化的放進字表，
// 沒變化的記進 identity 清單。test/manager-i18n.test.mjs 據此確認新加的中文字都已涵蓋，
// 簡體介面才不會混進繁體字。大陸慣用詞（預設→默认）另外維護在 t2s.phrases，這支工具不動它。
// 需要 python3 與 OpenCC（pip install opencc）；只有維護者更新字表時才用得到。

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pagePath = join(repoRoot, "src", "manager.html");
const identityPath = join(repoRoot, "test", "fixtures", "t2s-identity.txt");
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u;
const DATA_BLOCK = /(<script type="application\/json" id="i18n-data">\n)([\s\S]*?)(\n<\/script>)/;

// 需要涵蓋的文字：所有原始碼與更新說明；管理頁本身扣掉翻譯資料（裡面本來就有簡體字）。
export function sourceCharacters(root = repoRoot) {
  const texts = [];
  for (const name of readdirSync(join(root, "src")).sort()) {
    const text = readFileSync(join(root, "src", name), "utf8");
    texts.push(name === "manager.html" ? text.replace(DATA_BLOCK, "$1$3") : text);
  }
  texts.push(readFileSync(join(root, "releases.json"), "utf8"));
  return [...new Set([...texts.join("")].filter((char) => CJK.test(char)))].sort();
}

export function readPageData(page = readFileSync(pagePath, "utf8")) {
  const match = DATA_BLOCK.exec(page);
  if (!match) throw new Error("src/manager.html 缺少 i18n-data 區塊");
  return JSON.parse(match[2]);
}

function convertWithOpenCC(chars) {
  const script = "import json,sys,opencc\nc=opencc.OpenCC('t2s')\nprint(json.dumps([c.convert(x) for x in json.load(sys.stdin)],ensure_ascii=False))";
  const result = spawnSync("python3", ["-c", script], { input: JSON.stringify(chars), encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("需要 python3 與 OpenCC（pip install opencc）才能重新產生字表：" + (result.stderr || result.error?.message || "").trim());
  }
  return JSON.parse(result.stdout);
}

function main() {
  const check = process.argv.includes("--check");
  const chars = sourceCharacters();
  const converted = convertWithOpenCC(chars);
  const pairs = chars.map((char, index) => [char, converted[index]]).filter(([char, to]) => to !== char && [...to].length === 1);
  const identity = chars.filter((char, index) => converted[index] === char).join("");
  const from = pairs.map(([char]) => char).join("");
  const to = pairs.map(([, char]) => char).join("");
  const page = readFileSync(pagePath, "utf8");
  const data = readPageData(page);
  const nextPage = page.replace(/^"from": ".*",$/m, '"from": ' + JSON.stringify(from) + ",").replace(/^"to": ".*",$/m, '"to": ' + JSON.stringify(to) + ",");
  const stale = data.t2s.from !== from || data.t2s.to !== to || readFileSync(identityPath, "utf8") !== identity + "\n";
  if (check) {
    console.log(stale ? "繁轉簡字表需要更新：執行 node tools/i18n-t2s.mjs" : "繁轉簡字表已是最新");
    process.exitCode = stale ? 1 : 0;
    return;
  }
  writeFileSync(pagePath, nextPage);
  writeFileSync(identityPath, identity + "\n");
  console.log("字表 " + pairs.length + " 字、不需轉換 " + [...identity].length + " 字");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

