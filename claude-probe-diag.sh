#!/bin/bash
# Claude 原生端點診斷 —— 找出安裝器為何跳過 Claude 模型
# 用法： bash claude-probe-diag.sh <API_ROOT> <API_KEY> [模型名]
#   例： bash claude-probe-diag.sh https://your-gateway.example.com/v1 sk-xxx claude-opus-5

ROOT="${1:?請提供 API root，例如 https://your-gateway.example.com/v1}"
KEY="${2:?請提供 API key}"
MODEL="${3:-claude-opus-5}"
ROOT="${ROOT%/}"

echo "API Root : $ROOT"
echo "模型     : $MODEL"
echo

echo "── 1. /models 是否列得出這個模型 ──"
curl -s --max-time 30 -H "authorization: Bearer $KEY" "$ROOT/models" \
  | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception as e: print('  解析失敗:',e); raise SystemExit
ids=[m.get('id') for m in d.get('data',[])]
print(f'  共 {len(ids)} 個模型')
t='$MODEL'
print(f'  {t} 在清單中: {t in ids}')
cl=[i for i in ids if 'claude' in str(i).lower()]
print('  可用的 Claude 模型:', cl or '（無）')"
echo

echo "── 2. /messages 原生端點（安裝器實際探測的那支）──"
BODY=$(printf '{"model":"%s","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"Reply with exactly OK."}]}' "$MODEL")
curl -s --max-time 60 -o /tmp/_probe_body -w "  HTTP %{http_code}   耗時 %{time_total}s\n" \
  -X POST "$ROOT/messages" \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" -d "$BODY"
echo "  回應前 400 字："
head -c 400 /tmp/_probe_body | sed 's/^/    /'
echo; echo

echo "── 3. 對照組：/responses（若這支通、/messages 不通，代表閘道沒開原生端點）──"
curl -s --max-time 60 -o /tmp/_probe_body2 -w "  HTTP %{http_code}\n" \
  -X POST "$ROOT/responses" \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d "$(printf '{"model":"%s","input":"Reply with exactly OK.","stream":false}' "$MODEL")"
echo "  回應前 300 字："
head -c 300 /tmp/_probe_body2 | sed 's/^/    /'
echo
rm -f /tmp/_probe_body /tmp/_probe_body2
