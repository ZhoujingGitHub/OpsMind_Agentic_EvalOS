#!/bin/bash
# Balance check for both Alibaba Cloud accounts. Read-only: QueryAccountBalance only.
# 2026-09-15 showed arrears has two faces, and the cheap one (instance alive, public
# network throttled, TLS handshake dropped) reads exactly like a flaky network. So this
# runs before any network debugging. Exits non-zero when an account is below threshold.
# Usage: ./check-balance.sh [threshold-cny]   (default 100)
AL="D:/AIPM/黄钊+张和AIPM训练营/5期/从0到1打造一个Agent落地产品/OpsMind/.tools/aliyuncli/aliyun.exe"
PY="D:/install/anaconda3/python.exe"
MIN="${1:-100}"
low=0

check() {
  local profile="$1" label="$2" uid="$3" expiry="$4" raw amount
  raw=$("$AL" --profile "$profile" bssopenapi QueryAccountBalance --version 2017-12-14 2>/dev/null)
  amount=$(printf %s "$raw" | "$PY" -c "
import sys,json
try: print(json.load(sys.stdin)['Data']['AvailableAmount'])
except Exception: print('')
" 2>/dev/null)
  if [ -z "$amount" ]; then
    echo "!! $label ($profile): 查询失败。OAuth 可能已过期，用户需在自己终端跑："
    echo "   aliyun.exe configure --profile $profile --mode OAuth --region cn-hangzhou"
    low=1
    return
  fi
  if "$PY" -c "import sys;sys.exit(0 if float('$amount')<float('$MIN') else 1)"; then
    echo "!! $label  UID $uid  余额 $amount 元  低于 $MIN 元  到期 $expiry"
    low=1
  else
    echo "OK $label  UID $uid  余额 $amount 元  到期 $expiry"
  fi
}

check opsmind-main-oauth "主账号 (产品机 + 5G 实验室)" 1275476353815639 2026-11-10
check opsmind-evallab    "evallab (EvalOS)          " 1832716768005950 2026-11-15

if [ "$low" != 0 ]; then
  echo
  echo "三台机器约 380 元/月。欠费的两种面貌见 RUNBOOK 第 5 节坑 11。"
  exit 1
fi
