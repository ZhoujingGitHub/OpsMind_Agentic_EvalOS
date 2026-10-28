# 正式考试跑完之后的收尾（考场机，脱离会话跑）：
#   ① 等正式请求收口（COMPLETED / FAILED / CANCELLED）
#   ② 对没通过的场次逐场跑只读 AI 调查（28 甲；调查不改分）
#   ③ 把按大类的成绩单与 AI 调查归类封存成证据
#
#   REQ=<eval-request_…> EXP=<exp_…> OUT=<证据目录> setsid nohup sh evalos-after-formal.sh > log 2>&1 &
# 只读考试结果；不发版、不重启服务、不碰实验室。
set -u
: "${REQ:?REQ=<正式请求编号>}"
: "${EXP:?EXP=<正式实验编号>}"
: "${OUT:?OUT=<证据目录>}"
TOKEN=$(sed -n 's/^EVALOS_API_TOKEN=//p' /etc/opsmind-evalos/evalos.env | tr -d '"')
api() { curl -sf -H "authorization: Bearer $TOKEN" "http://127.0.0.1:8787$1"; }
echo "$(date -Is) 等 $REQ 收口"
while :; do
  status=$(api "/api/workbench/run-requests/$REQ" | python3 -c 'import json,sys;print(json.load(sys.stdin)["request"]["status"])' 2>/dev/null || echo unknown)
  case "$status" in COMPLETED|FAILED|CANCELLED) break ;; esac
  sleep 120
done
echo "$(date -Is) 请求状态 $status"
install -d -m 0755 "$OUT"
cd /opt/opsmind-evalos/current/evalos
EVALOS_API_TOKEN="$TOKEN" node scripts/investigate-failed-trials.mjs "$EXP" > "$OUT/formal-investigations.json" 2> "$OUT/formal-investigations.err"
echo "$(date -Is) AI 调查结束，退出码 $?"
api "/api/workbench/experiments/$EXP/report-card" > "$OUT/formal-report-card.json"
api "/api/workbench/experiments/$EXP" > "$OUT/formal-experiment.json"
( cd "$OUT" && sha256sum formal-*.json > formal-SHA256SUMS )
echo "$(date -Is) 成绩单已封存到 $OUT"
