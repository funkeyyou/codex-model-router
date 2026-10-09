// 網頁管理介面的多語系：繁體中文（原文）、簡體中文（繁簡轉換＋大陸慣用詞）與英文（字典）。
//
// 這裡確認：畫面上每一段文字都有英文翻譯、沒有漏掉 t() 的中文字串、簡體字表涵蓋原始碼用到的
// 每個字，以及語言判斷、單複數、伺服器訊息翻譯在瀏覽器裡的實際行為。

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayloads } from "./helpers/payloads.mjs";
import { readPageData, sourceCharacters } from "../tools/i18n-t2s.mjs";

const { managerPage } = await loadPayloads();
const data = readPageData(managerPage);
const script = /<script>([\s\S]*?)<\/script>/.exec(managerPage)[1];
const sources = readdirSync(new URL("../src/", import.meta.url)).filter((name) => name.endsWith(".mjs"))
  .map((name) => readFileSync(new URL("../src/" + name, import.meta.url), "utf8")).join("\n");
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u;
// 英文裡刻意保留的中文：Codex 介面與終端選單上實際顯示的名稱，使用者要照著找。
const QUOTED_NAMES = /自訂模型管理|Codex 模型路由器|安裝或重新配置|回退配置/g;
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
const unquote = (raw) => JSON.parse('"' + raw + '"');
const keysOf = (name) => new Set([...script.matchAll(new RegExp("(?<![\\w.])" + name + '\\("((?:[^"\\\\]|\\\\.)*)"', "g"))].map((match) => unquote(match[1])));
const uiKeys = new Set([...keysOf("t"), ...[...managerPage.matchAll(/data-i18n(?:-aria-label)?="([^"]*)"/g)].map((match) => match[1])]);
const sectionKeys = keysOf("sectionTitle");

// 粗略的 JavaScript 字串切分：跳過註解與正規表示式，取出所有字串常值的內容與位置。
function stringLiterals(code) {
  const literals = [];
  for (let index = 0; index < code.length;) {
    const char = code[index];
    const next = code[index + 1];
    if (char === "/" && next === "/") { index = code.indexOf("\n", index); if (index < 0) break; continue; }
    if (char === "/" && next === "*") { index = code.indexOf("*/", index) + 2; continue; }
    if (char === '"' || char === "'" || char === "\u0060") {
      let end = index + 1;
      while (end < code.length && code[end] !== char) end += code[end] === "\\" ? 2 : 1;
      literals.push({ start: index, value: code.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    if (char === "/") {
      let before = index - 1;
      while (before >= 0 && /\s/.test(code[before])) before -= 1;
      if (before < 0 || /[(,=:[!&|?{};]/.test(code[before]) || code.slice(Math.max(0, before - 5), before + 1).endsWith("return")) {
        let end = index + 1;
        let inClass = false;
        while (end < code.length) {
          if (code[end] === "\\") { end += 2; continue; }
          if (code[end] === "[") inClass = true;
          else if (code[end] === "]") inClass = false;
          else if (code[end] === "/" && !inClass) break;
          end += 1;
        }
        index = end + 1;
        continue;
      }
    }
    index += 1;
  }
  return literals;
}

test("畫面文字都經過 t()：沒有直接寫在程式裡的中文字串", () => {
  // 語言名稱照各自的語言顯示；「Windows 排程工作」是比對安裝器回傳的值，不是畫面文字。
  const allowed = new Set(["繁體中文", "简体中文", "Windows 排程工作"]);
  const stray = stringLiterals(script).filter(({ start, value }) => CJK.test(value) && !allowed.has(value) &&
    !/(?<![\w.])(?:t|sectionTitle)\($/.test(script.slice(Math.max(0, start - 14), start)));
  assert.deepEqual(stray.map(({ start, value }) => script.slice(0, start).split("\n").length + ": " + value), []);
});

test("英文字典涵蓋所有畫面文字，佔位符一致；沒有多餘或過時的項目", () => {
  assert.ok(uiKeys.size > 400, String(uiKeys.size));
  const missing = [...uiKeys].filter((key) => !Object.hasOwn(data.en, key));
  assert.deepEqual(missing, []);
  for (const [key, value] of Object.entries(data.en)) {
    const base = key.endsWith("#one") ? key.slice(0, -4) : key;
    assert.ok(uiKeys.has(base), "字典裡有沒用到的項目：" + key);
    assert.ok(value.trim(), key);
    if (key === base) assert.deepEqual(placeholders(value), placeholders(key), key);
    else assert.ok(placeholders(value).every((name) => placeholders(base).includes(name)), key);
    assert.doesNotMatch(value.replace(QUOTED_NAMES, ""), CJK, "英文翻譯裡還有中文：" + key);
  }
  assert.deepEqual([...sectionKeys].sort(), Object.keys(data.enSections).sort());
  for (const key of Object.keys(data.hans)) assert.ok(uiKeys.has(key), "hans 覆寫了沒用到的項目：" + key);
  for (const [key, value] of Object.entries(data.hans)) assert.deepEqual(placeholders(value), placeholders(key), key);
});

test("英文的伺服器訊息與錯誤代碼仍對得上原始碼，避免訊息改了翻譯卻靜默失效", () => {
  for (const [pattern, replacement] of data.enServer) {
    assert.doesNotThrow(() => new RegExp(pattern), pattern);
    assert.doesNotMatch(replacement.replace(QUOTED_NAMES, ""), CJK, "英文翻譯裡還有中文：" + replacement);
    const literals = pattern.replace(/^\^|\$$/g, "").replace(/\((?:\?:)?[^)]*\)\??|\.\*|\.\+/g, "\u0000").replace(/\\(.)/g, "$1")
      .split("\u0000").filter((part) => CJK.test(part));
    assert.ok(literals.length, pattern);
    for (const literal of literals) assert.ok(sources.includes(literal), "原始碼已找不到這段訊息：" + literal);
  }
  for (const code of Object.keys(data.enErrors)) assert.ok(sources.includes('"' + code + '"'), "路由器已沒有這個錯誤代碼：" + code);
});

test("繁轉簡字表涵蓋原始碼與更新說明用到的每個字（新增中文後執行 node tools/i18n-t2s.mjs）", () => {
  const from = [...data.t2s.from];
  const to = [...data.t2s.to];
  assert.equal(from.length, to.length);
  assert.equal(new Set(from).size, from.length);
  const identity = new Set(readFileSync(new URL("./fixtures/t2s-identity.txt", import.meta.url), "utf8").trim());
  const known = new Set([...from, ...identity]);
  assert.deepEqual(sourceCharacters().filter((char) => !known.has(char)), [],
    "有新的中文字沒有涵蓋：執行 node tools/i18n-t2s.mjs 重新產生字表");
  for (const [phrase, simplified] of Object.entries(data.t2s.phrases)) {
    assert.ok(phrase && simplified, phrase);
  }
});

test("Windows 簽出成 CRLF 時，字表掃描仍排除管理頁的翻譯資料", () => {
  const root = mkdtempSync(join(tmpdir(), "router-t2s-crlf-"));
  try {
    mkdirSync(join(root, "src"));
    const srcDir = new URL("../src/", import.meta.url);
    for (const name of readdirSync(srcDir)) {
      writeFileSync(join(root, "src", name), readFileSync(new URL(name, srcDir), "utf8").replaceAll("\n", "\r\n"));
    }
    const releases = readFileSync(new URL("../releases.json", import.meta.url), "utf8");
    writeFileSync(join(root, "releases.json"), releases.replaceAll("\n", "\r\n"));
    assert.deepEqual(sourceCharacters(root), sourceCharacters());
    assert.deepEqual(readPageData(readFileSync(join(root, "src", "manager.html"), "utf8")).t2s, data.t2s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 在沙盒裡執行頁面的語言區塊，模擬不同的瀏覽器語言與已儲存的偏好。
function languageModule({ languages = ["en-US"], language = languages[0], preference = "auto" } = {}) {
  const start = script.indexOf("// ---- 語言");
  const end = script.indexOf("\nconst token = readToken();");
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    navigator: { languages, language },
    document: {
      getElementById: (id) => (id === "i18n-data" ? { textContent: JSON.stringify(data) } : null),
      documentElement: { dataset: { languagePreference: preference } },
    },
  });
  return vm.runInContext(script.slice(start, end) +
    "\n({ matchLanguage, browserLanguage, t, toSimplified, serverText, logText, joinList, sectionTitle, locale })", context);
}

test("依瀏覽器語言的偏好順序選語言：繁中、簡中、英文，其他語言預設英文", () => {
  const { matchLanguage } = languageModule();
  const cases = {
    "zh-TW": "zh-Hant", "zh-HK": "zh-Hant", "zh-MO": "zh-Hant", "zh-Hant": "zh-Hant", "zh-Hant-SG": "zh-Hant", "ZH-tw": "zh-Hant",
    "zh-CN": "zh-Hans", "zh-SG": "zh-Hans", zh: "zh-Hans", "zh-Hans": "zh-Hans", "zh-Hans-TW": "zh-Hans",
    en: "en", "en-GB": "en", ja: null, "": null, "zhx": null,
  };
  for (const [tag, expected] of Object.entries(cases)) assert.equal(matchLanguage(tag), expected, tag);
  assert.equal(languageModule({ languages: ["ja-JP", "zh-TW", "en"] }).locale, "zh-Hant", "第一個支援的語言");
  assert.equal(languageModule({ languages: ["ja", "en-US", "zh-CN"] }).locale, "en");
  assert.equal(languageModule({ languages: ["fr", "de"] }).locale, "en", "都不符合時用英文");
  assert.equal(languageModule({ languages: [], language: "zh-CN" }).locale, "zh-Hans");
  assert.equal(languageModule({ languages: ["en-US"], preference: "zh-Hans" }).locale, "zh-Hans", "已儲存的偏好優先");
  assert.equal(languageModule({ languages: ["zh-TW"], preference: "xx" }).locale, "zh-Hant", "無效的偏好當作自動");
});

test("英文：字典、單複數、導覽標題與伺服器訊息", () => {
  const { t, sectionTitle, serverText, logText, joinList } = languageModule({ languages: ["fr"] });
  assert.equal(t("新增模型"), "Add models");
  assert.equal(t("{count} 個模型", { count: 1 }), "1 model");
  assert.equal(t("{count} 個模型", { count: 3 }), "3 models");
  assert.equal(t("官方模型 {count} 個", { count: "1" }), "1 official model");
  assert.equal(sectionTitle("供應商"), "Providers");
  assert.equal(t("供應商"), "Provider");
  assert.equal(t("沒有這個鍵 {x}", { x: 1 }), "沒有這個鍵 1", "缺翻譯時退回原文，不會顯示空白");
  assert.equal(serverText("找不到供應商：owo"), "Provider not found: owo");
  assert.equal(serverText("這個 Base URL 已經是供應商「Acme」；要添加它的模型請到「模型」頁新增。"), "This Base URL already belongs to provider “Acme”.");
  assert.equal(serverText("偏重速度，適合一般生圖與快速迭代。"), "Focused on speed, for general generation and fast iteration.");
  assert.equal(serverText("沒有對應翻譯的訊息"), "沒有對應翻譯的訊息");
  assert.equal(logText("正在寫入設定"), "正在寫入設定", "操作記錄不翻譯");
  assert.equal(joinList(["a", "b"]), "a, b");
});

test("簡體：大陸慣用詞、覆寫、保留 Codex 介面上的名稱，記錄與錯誤同樣轉換", () => {
  const { t, toSimplified, serverText, logText, joinList, sectionTitle } = languageModule({ languages: ["zh-CN"] });
  assert.equal(t("重新整理"), "刷新");
  assert.equal(t("儲存順序"), "保存顺序");
  assert.equal(t("介面語言"), "界面语言");
  assert.equal(sectionTitle("總覽"), "概览");
  assert.equal(t("Key 只會以 Windows 憑證保護（DPAPI）加密儲存，不會寫進設定檔，也不會再顯示在頁面上。"),
    data.hans["Key 只會以 Windows 憑證保護（DPAPI）加密儲存，不會寫進設定檔，也不會再顯示在頁面上。"]);
  assert.equal(toSimplified("請從 Codex 的「自訂模型管理」開啟"), "请从 Codex 的「自訂模型管理」打开", "Codex 裡實際顯示的名稱不轉換");
  assert.equal(toSimplified("英文字母與預設程式碼"), "英文字母与默认代码", "較長的詞優先，不會被拆開");
  assert.equal(serverText("網路連線逾時"), "网络连接超时");
  assert.equal(logText("背景程序已結束"), "后台进程已结束");
  assert.equal(joinList(["a", "b"]), "a、b");
  for (const key of uiKeys) {
    const converted = t(key);
    const leftovers = [...converted].filter((char) => [...data.t2s.from].includes(char));
    assert.deepEqual(leftovers.filter((char) => !"自訂模型管理".includes(char)), [], key);
  }
});

test("繁體：直接顯示原文", () => {
  const { t, serverText, sectionTitle } = languageModule({ languages: ["zh-TW"] });
  assert.equal(t("重新整理"), "重新整理");
  assert.equal(t("已選 {count} 個模型", { count: 2 }), "已選 2 個模型");
  assert.equal(sectionTitle("供應商"), "供應商");
  assert.equal(serverText("網路連線逾時"), "網路連線逾時");
});
