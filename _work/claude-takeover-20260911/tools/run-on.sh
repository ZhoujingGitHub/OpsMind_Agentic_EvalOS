#!/bin/bash
# 统一启动器。这是这套工具此前缺的那块：ca.sh 从标准输入读脚本、不转发参数，
# 所以约定是"在脚本前面拼上环境变量赋值"。以前每轮会话都在手搓这段管道，
# RUNBOOK 却声称"直接照此驱动"。有了它那句话才成立。
#
#   ./run-on.sh <product|evalos|lab> <脚本文件> [VAR=值 ...]
#   ./run-on.sh <product|evalos|lab> - '<直接执行的 shell 命令>'
#
# 例：
#   ./run-on.sh product ah-progress.sh INV=inv-abc123def456
#   ./run-on.sh evalos  evalos-op.sh OP=preflight REF=agent-harness-v2 \
#               SRC_EXP=exp_xxxx EXPECT_REV=1a6eefc30c20475d61ed48dce0e361d9bcdf5180
#   ./run-on.sh lab     - 'opsmind-harness-labctl manage-status'
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
HOST="${1:?用法: run-on.sh <product|evalos|lab> <脚本|-> [VAR=值 ...]}"
SCRIPT="${2:?用法: run-on.sh <product|evalos|lab> <脚本|-> [VAR=值 ...]}"
shift 2

case "$HOST" in
  product) RUNNER="$HERE/ca.sh";      INST=i-bp12nyanjsyue1vs5bu6 ;;
  evalos)  RUNNER="$HERE/ca-eval.sh"; INST=i-bp14ezltpnq8mxic1gsb ;;
  lab)     RUNNER="$HERE/ca.sh";      INST=i-bp19u0lim79nhh4y7fkg ;;
  *) echo "host 取值: product | evalos | lab" >&2; exit 2 ;;
esac

TMO="${TIMEOUT:-300}"
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

if [ "$SCRIPT" = "-" ]; then
  printf 'set -eu\n%s\n' "${1:?- 模式需要一条命令}" > "$BODY"
else
  [ -r "$HERE/$SCRIPT" ] || { echo "找不到脚本 $HERE/$SCRIPT" >&2; exit 2; }
  # 环境变量必须拼在脚本之前：脚本里的 : "${VAR:?...}" 守卫会检查它们
  for kv in "$@"; do
    case "$kv" in *=*) printf '%s\n' "export $kv" >> "$BODY" ;;
      *) echo "参数要写成 VAR=值，收到: $kv" >&2; exit 2 ;;
    esac
  done
  cat "$HERE/$SCRIPT" >> "$BODY"
fi

echo "[run-on] $HOST <- $SCRIPT $*" >&2
"$RUNNER" "$INST" "$TMO" < "$BODY"
