#!/bin/bash
set -euo pipefail

find_node() {
  if [[ -n "${CODEX_MODEL_ROUTER_NODE_BIN:-}" && -x "${CODEX_MODEL_ROUTER_NODE_BIN}" ]]; then
    printf '%s\n' "${CODEX_MODEL_ROUTER_NODE_BIN}"
    return
  fi

  local candidate
  for candidate in \
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
    "$(command -v node 2>/dev/null || true)"; do
    if [[ -n "${candidate}" && -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return
    fi
  done

  return 1
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "此安裝器僅支援 macOS。Windows 請改用 codex-model-router.ps1。" >&2
  exit 1
fi

NODE_BIN="$(find_node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "未找到 Node.js，請先安裝 ChatGPT Desktop 或 Node.js。" >&2
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

