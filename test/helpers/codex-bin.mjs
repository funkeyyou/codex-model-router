// e2e 測試用的真實 Codex 執行檔。
//
// 優先使用 CODEX_MODEL_ROUTER_TEST_CODEX_BIN；沒設定時找 npm ci 裝好的 @openai/codex
// （devDependency，版本固定在 package-lock.json）。兩者都沒有就回傳 null，測試會略過。
// npm 套件的 bin/codex.js 只是個轉接腳本，這裡要的是平台套件裡的原生執行檔：
// Windows 上 execFile 不能直接執行 .cmd／.js 轉接層。

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function findCodexBin(root = repoRoot) {
  const scope = join(root, "node_modules", "@openai");
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  let packages;
  try {
    packages = readdirSync(scope).filter((name) => name.startsWith("codex-"));
  } catch {
    return null;
  }
  for (const name of packages) {
    const vendor = join(scope, name, "vendor");
    let targets;
    try { targets = readdirSync(vendor); } catch { continue; }
    for (const target of targets) {
      for (const candidate of [join(vendor, target, "bin", executable), join(vendor, target, "codex", executable)]) {
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

export const codexBin = process.env.CODEX_MODEL_ROUTER_TEST_CODEX_BIN || findCodexBin();

// node test/helpers/codex-bin.mjs：印出會用到的執行檔與版本，CI 用來確認真的裝到了。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!codexBin) {
    console.error("找不到 Codex 執行檔：請先執行 npm ci，或設定 CODEX_MODEL_ROUTER_TEST_CODEX_BIN。");
    process.exit(1);
  }
  const { execFileSync } = await import("node:child_process");
  console.log(`${codexBin}\n${execFileSync(codexBin, ["--version"], { encoding: "utf8" }).trim()}`);
}
