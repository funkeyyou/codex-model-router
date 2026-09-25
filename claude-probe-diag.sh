#!/bin/bash
# Claude 原生端點診斷 —— 找出安裝器為何跳過 Claude 模型
# 用法： bash claude-probe-diag.sh <API_ROOT> [模型名]
#   例： bash claude-probe-diag.sh https://your-gateway.example.com/v1 claude-opus-5
#
# API Key 以隱藏輸入的方式詢問，不會留在命令歷史，也不會出現在 ps 看得到的命令列。
# 非互動執行時可改用環境變數 CODEX_ROUTER_API_KEY 提供。
# 診斷要盡量跑完每一步，所以不用 set -e；各步驟自行處理失敗。
set -uo pipefail

ROOT="${1:?請提供 API root，例如 https://your-gateway.example.com/v1}"
MODEL="${2:-claude-opus-5}"
ROOT="${ROOT%/}"

# 舊版用法是 <API_ROOT> <API_KEY> [模型名]；把 Key 當成模型名送出去更糟，直接說明。
if [[ "${MODEL}" == sk-* ]]; then
  echo "第二個參數看起來是 API Key。新版不再從命令列接收 Key（會留在命令歷史）；" >&2
  echo "請改用：bash claude-probe-diag.sh <API_ROOT> [模型名]，執行後再貼上 Key。" >&2
  exit 2
fi

KEY="${CODEX_ROUTER_API_KEY:-}"
if [[ -z "${KEY}" ]]; then
  read -r -s -p "API Key（輸入不會顯示）: " KEY
  echo
fi
if [[ -z "${KEY}" ]]; then
  echo "API Key 不能為空。" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/claude-probe.XXXXXX")" || exit 1
trap 'rm -rf "${WORK}"' EXIT
# 標頭寫進只有自己讀得到的檔案再交給 curl（-H @檔案），Key 不進任何命令列。
(umask 077 && printf 'authorization: Bearer %s\ncontent-type: application/json\n' "${KEY}" > "${WORK}/headers")
unset KEY

# 顯示回應檔的開頭；請求失敗時檔案可能不存在。
show() {
  if [[ -s "$1" ]]; then head -c "$2" "$1" | sed 's/^/    /'; else echo "    （沒有回應內容）"; fi
}

# 用 Node 解析模型清單：安裝器本來就需要它，macOS 未必有可用的 python3。
NODE=""
for candidate in "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" "$(command -v node 2>/dev/null || true)"; do
  if [[ -n "${candidate}" && -x "${candidate}" ]]; then NODE="${candidate}"; break; fi
done

echo "API Root : ${ROOT}"
echo "模型     : ${MODEL}"
echo

echo "── 1. /models 是否列得出這個模型 ──"
curl -s --max-time 30 -H @"${WORK}/headers" -o "${WORK}/models.json" "${ROOT}/models"
if [[ -n "${NODE}" && -s "${WORK}/models.json" ]]; then
  MODEL="${MODEL}" "${NODE}" -e '
    const fs = require("fs");
    let data;
    try { data = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
    catch (error) { console.log("  解析失敗:", error.message); process.exit(0); }
    const ids = (Array.isArray(data.data) ? data.data : []).map((m) => m && m.id).filter(Boolean);
    const target = process.env.MODEL;
    console.log(`  共 ${ids.length} 個模型`);
    console.log(`  ${target} 在清單中: ${ids.includes(target)}`);
    const claude = ids.filter((id) => String(id).toLowerCase().includes("claude"));
    console.log("  可用的 Claude 模型:", claude.length ? claude.join(", ") : "（無）");
  ' "${WORK}/models.json"
else
  show "${WORK}/models.json" 600
  echo
fi
echo

echo "── 2. /messages 原生端點（安裝器實際探測的那支）──"
BODY="$(printf '{"model":"%s","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"Reply with exactly OK."}]}' "${MODEL}")"
curl -s --max-time 60 -o "${WORK}/messages" -w "  HTTP %{http_code}   耗時 %{time_total}s\n" \
  -X POST "${ROOT}/messages" -H @"${WORK}/headers" -d "${BODY}"
echo "  回應前 400 字："
show "${WORK}/messages" 400
echo; echo

echo "── 3. 對照組：/responses（若這支通、/messages 不通，代表閘道沒開原生端點）──"
curl -s --max-time 60 -o "${WORK}/responses" -w "  HTTP %{http_code}\n" \
  -X POST "${ROOT}/responses" -H @"${WORK}/headers" \
  -d "$(printf '{"model":"%s","input":"Reply with exactly OK.","stream":false}' "${MODEL}")"
echo "  回應前 300 字："
show "${WORK}/responses" 300
echo
