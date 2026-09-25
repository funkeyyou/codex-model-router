// tools/release.mjs：Release 的更新說明、版本一致性與 SHA256SUMS。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_FILES, installerVersion, releaseNotes, writeChecksums } from "../tools/release.mjs";

const releases = JSON.parse(readFileSync(new URL("../releases.json", import.meta.url), "utf8"));

test("更新說明取自 releases.json 的同一版", () => {
  const version = installerVersion();
  const entry = releases.releases.find((release) => release.version === version);
  assert.equal(releaseNotes(`v${version}`), entry.changes.map((change) => `- ${change}`).join("\n") + "\n");
});

test("tag 與安裝器版本不一致時拒絕發佈", () => {
  assert.throws(() => releaseNotes("v0.0.1"), /不一致/);
  assert.throws(() => releaseNotes(installerVersion()), /不一致/, "少了 v 前綴");
});

test("SHA256SUMS 涵蓋每個上傳檔案，雜湊與內容相符", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-assets-"));
  const files = writeChecksums(directory);
  assert.deepEqual(files.map((file) => file.split(/[\\/]/).at(-1)), [...RELEASE_FILES, "SHA256SUMS"]);
  const lines = readFileSync(join(directory, "SHA256SUMS"), "utf8").trim().split("\n");
  assert.equal(lines.length, RELEASE_FILES.length);
  for (const line of lines) {
    const [digest, name] = line.split(/ {2}/);
    const actual = createHash("sha256").update(readFileSync(join(directory, name))).digest("hex");
    assert.equal(digest, actual, name);
  }
});
