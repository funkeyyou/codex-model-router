#!/usr/bin/env node
// 把 assets/provider-icons/*.svg 內嵌進 src/manager.html 的 provider-icons 區塊。
//
//   node tools/provider-icons.mjs           # 改寫 manager.html
//   node tools/provider-icons.mjs --check   # 只比對，有落差就以非零狀態結束
//
// 圖示以 base64 data: 圖片內嵌：<img> 載入的 SVG 不能執行腳本，SVG 內部的 style 也不受管理頁的
// CSP 限制。單色圖示（currentColor 或沒有指定顏色）改成淺色，深色背景上才看得到；彩色圖示保留原色。

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconDir = join(repoRoot, "assets", "provider-icons");
const pagePath = join(repoRoot, "src", "manager.html");
const LIGHT = "#dbe4f3";
const OPEN = '<script type="application/json" id="provider-icons">';
const CLOSE = "</script>";

export function prepareIcon(name, source) {
  let svg = String(source).replace(/<\?xml[^>]*>/g, "").replace(/<title>[\s\S]*?<\/title>/g, "").trim();
  if (!/^<svg[\s>]/.test(svg)) throw new Error(`${name}: 不是 SVG`);
  if (/<script|<foreignObject|\son[a-z]+\s*=|(?:href|src)\s*=\s*["'](?!#)/i.test(svg)) {
    throw new Error(`${name}: 含有腳本、事件或外部參照`);
  }
  const colored = /fill\s*=\s*["'](?:#|rgb|url\()|stop-color/i.test(svg);
  svg = svg.replaceAll("currentColor", LIGHT);
  if (!colored && !/^<svg[^>]*\sfill=/.test(svg)) svg = svg.replace(/^<svg/, `<svg fill="${LIGHT}"`);
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

export function buildIconBlock(directory = iconDir) {
  const icons = {};
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".svg")).sort()) {
    const name = file.slice(0, -4);
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`圖示檔名只能用小寫英文、數字與連字號：${file}`);
    icons[name] = prepareIcon(name, readFileSync(join(directory, file), "utf8"));
  }
  return `${OPEN}\n${JSON.stringify(icons, null, 0).replaceAll('","', '",\n"')}\n${CLOSE}`;
}

export function embedIcons(page, block) {
  const start = page.indexOf(OPEN);
  if (start < 0) throw new Error("manager.html 缺少 provider-icons 區塊");
  const end = page.indexOf(CLOSE, start);
  return page.slice(0, start) + block + page.slice(end + CLOSE.length);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const page = readFileSync(pagePath, "utf8");
  const next = embedIcons(page, buildIconBlock());
  if (process.argv.includes("--check")) {
    if (next !== page) {
      console.error("manager.html 的圖示與 assets/provider-icons 不一致，請執行 node tools/provider-icons.mjs");
      process.exit(1);
    }
    console.log("provider icons in sync");
  } else if (next !== page) {
    writeFileSync(pagePath, next);
    console.log("已更新 manager.html 的供應商圖示");
  } else {
    console.log("provider icons in sync");
  }
}
