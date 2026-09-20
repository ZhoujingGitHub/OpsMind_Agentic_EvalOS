#!/usr/bin/env bash
# 串行跑一串考场链路，跑完一道再提下一道。**在考场那台机上跑，用 nohup。**
#
# 为什么要它：实验室同时只有一个物理租约，八道题必须排队。一道 AH 约 5 分钟、
# 一道 LG 约 20-30 分钟，全程两个多小时——不能靠本地会话一道一道盯，
# 会话断了队列就断了。
#
# 2026-09-21 踩过的坑（第一版就是这么废的）：
#   上一道还在跑时提交下一道，开考检查会直接以 ready:false 挡回；
#   而第一版"提交失败就跳过下一道"，于是六道题二十秒全部空跑完、一道没跑。
#   **提交前必须等场地空出来，提交失败必须退避重试，不能跳过。**
#
# 每道跑完立刻把判分摘要追加到结果文件，中途看得见、断了也不丢。
#
# 用法：
#   EXPECT_REV=<EvalOS 线上提交> SRC_EXP=<冻结源> TAG=<本轮标记> \
#     setsid nohup bash run-chain-queue.sh <ref>:<case> [<ref>:<case> ...] > queue.log 2>&1 &
set -u
: "${EXPECT_REV:?必须指明 EvalOS 线上提交}"
: "${SRC_EXP:?必须指明本轮冻结源}"
: "${TAG:?必须指明本轮标记，用于幂等键}"
OUT="${OUT:-/srv/opsmind-evidence/root-cause-state-claim-20260920/chain-results.txt}"
OP_SCRIPT="${OP_SCRIPT:-/root/evalos-op.sh.unix}"
SUMMARIZER="${SUMMARIZER:-/root/sum.js}"
mkdir -p "$(dirname "$OUT")"

api() { curl -s "http://127.0.0.1:3000$1"; }

# 场地是不是空的。
#
# 只认 RUNNING。**不要把 QUEUED 也算进去**：历史冻结设计里有 499 条
# 从未排程的 Trial 永远停在排队态（创建时就是 scheduleTrials:false），
# 把它们当成"场地占用"的话，这个循环永远等不到空。
# 也不要用 /api/workbench/overview——那个响应里根本没有请求列表。
lab_free() {
  (cd /opt/opsmind-evalos/current/evalos && node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/var/lib/opsmind-evalos/control/control.sqlite", { readOnly: true });
const running = db.prepare("SELECT COUNT(*) AS n FROM trials WHERE status=?").get("RUNNING").n;
console.log(running > 0 ? "no" : "yes");
') 2>/dev/null
}

request_id_of() {
  python3 -c '
import sys, json
try:
    print(json.load(sys.stdin)["result"]["request"]["id"])
except Exception:
    print("")
' 2>/dev/null
}

request_field() { # stdin=body  $1=字段名
  python3 -c '
import sys, json
try:
    print(json.load(sys.stdin)["request"].get(sys.argv[1]) or "")
except Exception:
    print("")
' "$1" 2>/dev/null
}

trial_id_of() {
  python3 -c '
import sys, json
try:
    items = json.load(sys.stdin)["request"].get("items") or []
    print(items[0].get("trial_id") or "")
except Exception:
    print("")
' 2>/dev/null
}

for spec in "$@"; do
  ref="${spec%%:*}"
  case_ref="${spec##*:}"
  idem="${TAG}-$(printf '%s' "$ref$case_ref" | tr -cd 'a-zA-Z0-9' | tail -c 24)"
  {
    echo ""
    echo "================================================================"
    echo "$(date -Is)  $ref  $case_ref"
  } >> "$OUT"

  # ---- 等场地 ----
  waited=0
  while [ "$(lab_free)" = "no" ] && [ "$waited" -lt 240 ]; do
    [ "$waited" = "0" ] && echo "  场地被上一道占着，等它跑完" >> "$OUT"
    waited=$((waited + 1))
    sleep 30
  done

  # ---- 提交，失败就退避重试 ----
  rid=""
  sub=""
  for attempt in $(seq 1 120); do
    sub=$(OP=submit REF="$ref" EXPECT_REV="$EXPECT_REV" SRC_EXP="$SRC_EXP" CASES="$case_ref" \
          IDEM="$idem" REASON="根因判据换成指认状态改动后的端到端复验：$ref $case_ref" \
          bash "$OP_SCRIPT" 2>&1)
    rid=$(printf '%s' "$sub" | request_id_of)
    [ -n "$rid" ] && break
    [ "$attempt" = "1" ] && echo "  第一次提交被挡回，退避重试中" >> "$OUT"
    sleep 45
  done
  if [ -z "$rid" ]; then
    echo "  提交始终没成功，跳过这一道。最后一次回执尾部：" >> "$OUT"
    printf '%s\n' "$sub" | tail -c 300 >> "$OUT"
    continue
  fi
  echo "  请求 $rid" >> "$OUT"

  # ---- 等这一道跑完 ----
  tid=""
  status=""
  for _ in $(seq 1 240); do
    body=$(api "/api/workbench/run-requests/$rid")
    status=$(printf '%s' "$body" | request_field status)
    tid=$(printf '%s' "$body" | trial_id_of)
    case "$status" in COMPLETED|FAILED|CANCELLED) break ;; esac
    sleep 20
  done
  echo "  请求状态 $status  trial $tid" >> "$OUT"
  if [ -n "$tid" ]; then
    (cd /opt/opsmind-evalos/current/evalos && node "$SUMMARIZER" x "$tid") >> "$OUT" 2>&1
  fi
done

{
  echo ""
  echo "$(date -Is)  队列跑完"
} >> "$OUT"
