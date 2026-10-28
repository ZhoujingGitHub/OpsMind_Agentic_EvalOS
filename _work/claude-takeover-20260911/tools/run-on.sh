#!/bin/bash
# 统一远端执行器：把本地一个脚本（或一条命令）交给三台机之一执行，退出码原样带回。
#
#   ./run-on.sh <product|evalos|lab> <脚本文件> [VAR=值 ...]
#   ./run-on.sh <product|evalos|lab> - '<直接执行的 shell 命令>'
#
# 例：
#   ./run-on.sh product ah-progress.sh INV=inv-abc123def456
#   ./run-on.sh evalos  evalos-op.sh OP=preflight REF=agent-harness-v2 \
#               SRC_EXP=exp_xxxx EXPECT_REV=1a6eefc30c20475d61ed48dce0e361d9bcdf5180
#   ./run-on.sh lab     - 'opsmind-harness-labctl manage-status'
#
# 2026-10-29 起走 SSH（入口见 remote-hosts.sh），不再走云助手。三处行为变化：
#   · 退出码就是远端脚本的退出码（云助手时代永远 exit 0、要解析 "### exit=N"）；
#     255 是 ssh 自己连不上，会另外打一行提示
#   · 没有 300 秒上限；要限时显式给 TIMEOUT=秒
#   · 输出不截断
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/remote-hosts.sh"
HOST="${1:?用法: run-on.sh <product|evalos|lab> <脚本|-> [VAR=值 ...]}"
SCRIPT="${2:?用法: run-on.sh <product|evalos|lab> <脚本|-> [VAR=值 ...]}"
shift 2
remote_ssh_args "$HOST" || exit 2

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
rc=0
if [ -n "${TIMEOUT:-}" ]; then
  timeout "$TIMEOUT" "${REMOTE_SSH[@]}" "${REMOTE_SUDO}sh -s" < "$BODY" || rc=$?
else
  "${REMOTE_SSH[@]}" "${REMOTE_SUDO}sh -s" < "$BODY" || rc=$?
fi
[ "$rc" = 255 ] && remote_unreachable_hint
exit "$rc"
