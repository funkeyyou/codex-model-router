// macOS 安裝器外殼挑選 Node 的規則。
//
// router.mjs 需要 Node v22.15 起才有的 zstdDecompressSync。以前 .sh 只檢查檔案能不能
// 執行（.ps1 有檢查版本），PATH 上若是舊版 Node，路由器一載入就崩潰，使用者只看到
// 「健康檢查失敗」。這裡把外殼裡的函式取出來，用假的 node 執行檔在 bash 裡跑。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const skip = process.platform === "win32" ? "bash 與可執行檔權限只在 POSIX 系統上驗證" : false;
const wrapper = readFileSync(new URL("../src/wrapper.sh", import.meta.url), "utf8");
const functions = /^MIN_NODE_MAJOR=[\s\S]*?^find_node\(\) \{[\s\S]*?^\}\n/m.exec(wrapper)?.[0];

function fakeNode(directory, version) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "node");
  writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
  chmodSync(path, 0o755);
  return path;
}

function findNode({ override = null, onPath = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wrapper-node-"));
  const pathDirectory = join(root, "bin");
  mkdirSync(pathDirectory);
  const overridePath = override ? fakeNode(join(root, "override"), override) : "";
  if (onPath) fakeNode(pathDirectory, onPath);
  const result = spawnSync("bash", ["-c", `set -euo pipefail\n${functions}\nfind_node`], {
    encoding: "utf8",
    env: { PATH: `${pathDirectory}:/usr/bin:/bin`, CODEX_MODEL_ROUTER_NODE_BIN: overridePath },
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr, overridePath, pathDirectory };
}

test("外殼裡找得到版本檢查函式", { skip }, () => {
  assert.ok(functions, "src/wrapper.sh 的 node_version_ok／find_node 結構改了，請同步更新這個測試");
});

test("v22.15 以上才採用；22.14 與 20.x 都不算", { skip }, () => {
  for (const [version, ok] of [["22.15.0", true], ["22.20.1", true], ["24.3.0", true], ["22.14.9", false], ["20.11.0", false]]) {
    const result = findNode({ onPath: version });
    assert.equal(result.status === 0, ok, `${version}：${result.stderr}`);
  }
});

test("指定的 Node 太舊時改用 PATH 上夠新的那個", { skip }, () => {
  const result = findNode({ override: "20.11.0", onPath: "24.1.0" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, join(result.pathDirectory, "node"));
});

test("全都太舊時說明需要的版本並列出找到的執行檔", { skip }, () => {
  const result = findNode({ override: "18.19.0", onPath: "20.11.0" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /版本過低，需要 v22\.15 及以上/);
  assert.match(result.stderr, /v18\.19\.0/);
  assert.match(result.stderr, /v20\.11\.0/);
});
