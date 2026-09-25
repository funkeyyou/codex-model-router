#!/usr/bin/env node
// 發佈前的檢查與素材，供 .github/workflows/release.yml 使用：
//
//   node tools/release.mjs notes <tag>     # 印出該版的更新說明（Markdown），並確認版本一致
//   node tools/release.mjs checksums <dir>  # 在 <dir> 寫出 SHA256SUMS，列出要上傳的檔案
//
// tag 必須是 v<INSTALLER_VERSION>，且 releases.json 的 latest 與該版說明都要對得上；
// 否則使用者從 Release 下載到的安裝器，版本會與它自稱的不一致。

import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RELEASE_FILES = [
  "codex-model-router.sh",
  "codex-model-router.ps1",
  "claude-probe-diag.sh",
  "claude-probe-diag.ps1",
];

export function installerVersion(root = repoRoot) {
  const source = readFileSync(join(root, "src", "installer.mjs"), "utf8");
  const version = /const INSTALLER_VERSION = "([^"]+)";/.exec(source)?.[1];
  if (!version) throw new Error("src/installer.mjs 缺少 INSTALLER_VERSION");
  return version;
}

export function releaseNotes(tag, root = repoRoot) {
  const version = installerVersion(root);
  if (tag !== `v${version}`) throw new Error(`tag ${tag} 與 INSTALLER_VERSION ${version} 不一致，應為 v${version}`);
  const releases = JSON.parse(readFileSync(join(root, "releases.json"), "utf8"));
  if (releases.latest !== version) throw new Error(`releases.json 的 latest 是 ${releases.latest}，不是 ${version}`);
  const entry = releases.releases.find((release) => release.version === version);
  if (!entry?.changes?.length) throw new Error(`releases.json 缺少 ${version} 的更新說明`);
  return entry.changes.map((change) => `- ${change}`).join("\n") + "\n";
}

export function writeChecksums(directory, root = repoRoot) {
  const lines = RELEASE_FILES.map((name) => {
    const target = join(directory, name);
    copyFileSync(join(root, name), target);
    const digest = createHash("sha256").update(readFileSync(target)).digest("hex");
    return `${digest}  ${basename(name)}`;
  });
  writeFileSync(join(directory, "SHA256SUMS"), lines.join("\n") + "\n");
  return [...RELEASE_FILES, "SHA256SUMS"].map((name) => join(directory, name));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, argument] = process.argv.slice(2);
  if (command === "notes" && argument) process.stdout.write(releaseNotes(argument));
  else if (command === "checksums" && argument) console.log(writeChecksums(resolve(argument)).join("\n"));
  else {
    console.error("用法：node tools/release.mjs notes <tag> | checksums <dir>");
    process.exit(2);
  }
}
