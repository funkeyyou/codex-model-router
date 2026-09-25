#!/bin/bash
set -euo pipefail

# router.mjs 用 node:zlib 的 zstd 解壓 Codex 送來的請求主體，需要 Node v22.15 起。
# 版本不夠時路由器一載入就崩潰，使用者只會看到「健康檢查失敗」，因此在這裡先擋。
# 寫法要相容 macOS 內建的 bash 3.2。
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=15

node_version() {
  "$1" -p 'process.versions.node' 2>/dev/null
}

node_version_ok() {
  local version major minor
  version="$(node_version "$1")" || return 1
  IFS=. read -r major minor _ <<<"${version}"
  [[ "${major}" =~ ^[0-9]+$ && "${minor}" =~ ^[0-9]+$ ]] || return 1
  (( major > MIN_NODE_MAJOR || (major == MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR) ))
}

find_node() {
  local candidate too_old=""
  for candidate in \
    "${CODEX_MODEL_ROUTER_NODE_BIN:-}" \
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
    "$(command -v node 2>/dev/null || true)"; do
    [[ -n "${candidate}" && -x "${candidate}" ]] || continue
    if node_version_ok "${candidate}"; then
      printf '%s\n' "${candidate}"
      return 0
    fi
    too_old="${too_old}  ${candidate}（v$(node_version "${candidate}" || echo '?')）"$'\n'
  done
  if [[ -n "${too_old}" ]]; then
    printf '找到的 Node.js 版本過低，需要 v%s.%s 及以上：\n%s' "${MIN_NODE_MAJOR}" "${MIN_NODE_MINOR}" "${too_old}" >&2
  fi
  return 1
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "此安裝器僅支援 macOS。Windows 請改用 codex-model-router.ps1。" >&2
  exit 1
fi

NODE_BIN="$(find_node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "未找到可用的 Node.js（需要 v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} 及以上），請先安裝或更新 ChatGPT Desktop 或 Node.js。" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-model-router.XXXXXX")"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT INT TERM

INSTALLER_JS="${TMP_DIR}/installer.mjs"
awk '
  /^__CODEX_MODEL_ROUTER_INSTALLER_JS__$/ { capture = 1; next }
  /^__CODEX_MODEL_ROUTER_ROUTER_JS__$/ { capture = 0 }
  capture { print }
' "$0" > "${INSTALLER_JS}"

export CODEX_MODEL_ROUTER_SCRIPT_PATH="$0"
export CODEX_MODEL_ROUTER_NODE_BIN="${NODE_BIN}"
ARG_COUNT=$#
set +e
"${NODE_BIN}" "${INSTALLER_JS}" "$@"
EXIT_STATUS=$?
set -e
if [[ ${ARG_COUNT} -eq 0 && -t 0 ]]; then
  echo
  read -r -p "按 Enter 鍵結束（視窗是否關閉取決於終端設定）..." _
fi
exit ${EXIT_STATUS}

