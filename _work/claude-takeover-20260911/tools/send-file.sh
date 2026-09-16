#!/bin/bash
# 经云助手 SendFile 把本地文件分块传到主机，并在主机侧核对与拼装。
#
# 新增于 2026-09-16。仓库里那份 scripts/send-cloud-assistant-file.ps1 用了
# ForEach-Object -Parallel，需要 PowerShell 7；这台机只有 5.1，跑不了。
# 这个是等价的 bash 版本，并且补了它没做的一件关键事：
# **SendFile 提交成功不等于送达**（它是异步的，PS 版只打印 "SUBMITTED" 就结束）。
# 所以这里传完一定要在主机侧核对分块数与 sha256，缺块自动补传。
#
#   HOST      product | evalos | lab
#   SRC       本地文件路径
#   DEST      主机上的目标文件完整路径
#   [TMPDIR]  主机上放分块的目录（默认 /var/tmp/send-file-<basename>）
#   [JOBS]    并行数（默认 8）
#   [CHUNK]   每块字节数（默认 18000；SendFile 的 Content 上限决定）
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
AL="D:/AIPM/黄钊+张和AIPM训练营/5期/从0到1打造一个Agent落地产品/OpsMind/.tools/aliyuncli/aliyun.exe"
: "${HOST:?用法: HOST=<product|evalos|lab> SRC=<本地文件> DEST=<主机目标路径>}"
: "${SRC:?必须指明本地文件}"
: "${DEST:?必须指明主机上的目标完整路径}"
JOBS="${JOBS:-8}"
CHUNK="${CHUNK:-18000}"

case "$HOST" in
  product) PROFILE=opsmind-main-oauth; INST=i-bp12nyanjsyue1vs5bu6 ;;
  evalos)  PROFILE=opsmind-evallab;    INST=i-bp14ezltpnq8mxic1gsb ;;
  lab)     PROFILE=opsmind-main-oauth; INST=i-bp19u0lim79nhh4y7fkg ;;
  *) echo "host 取值: product | evalos | lab" >&2; exit 2 ;;
esac

[ -r "$SRC" ] || { echo "读不到 $SRC" >&2; exit 2; }
BASE=$(basename "$SRC")
TMPDIR_REMOTE="${TMPDIR_REMOTE:-/var/tmp/send-file-$BASE}"
BYTES=$(stat -c %s "$SRC")
SHA=$(sha256sum "$SRC" | cut -d' ' -f1)
NPARTS=$(( (BYTES + CHUNK - 1) / CHUNK ))
echo "[send] $BASE  $BYTES B  sha=${SHA:0:12}  分 $NPARTS 块  并行 $JOBS" >&2

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
split -b "$CHUNK" -d -a 5 "$SRC" "$WORK/part."
ACTUAL=$(ls "$WORK" | wc -l)
[ "$ACTUAL" -eq "$NPARTS" ] || { echo "分块数不符: 期望 $NPARTS 实得 $ACTUAL" >&2; exit 1; }

# MSYS_NO_PATHCONV=1 是必须的：Git-Bash 会把看起来像 POSIX 路径的参数
# （这里是 --TargetDir 的 /var/tmp/...）转成 Windows 路径再交给 aliyun.exe，
# 于是 agent 在 Linux 主机上创建出字面目录 /D:/install/Git/var/tmp/...。
# 2026-09-16 实测：157 块全部"提交成功"、sha256 也对，只是落在了 /D: 底下，
# 而 SendFile 的 DescribeSendFileResults 一路报 Success，完全看不出问题。
send_one() {
  local f="$1" name
  name="$(basename "$f")"
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' \
  "$AL" --profile "$PROFILE" ecs SendFile \
    --RegionId cn-hangzhou --InstanceId.1 "$INST" \
    --Name "$name" --TargetDir "$TMPDIR_REMOTE" \
    --Content "$(base64 -w0 < "$f")" --ContentType Base64 \
    --FileMode 0600 --Overwrite true --Timeout 120 >/dev/null 2>&1 \
    || { echo "SendFile 失败: $name" >&2; return 1; }
}

# 主机侧先备好目录（SendFile 的 TargetDir 不存在时会失败）
"$HERE/run-on.sh" "$HOST" - "install -d -m 0700 '$TMPDIR_REMOTE'" >/dev/null

round() {
  local -a todo=("$@")
  local n=0
  for f in "${todo[@]}"; do
    send_one "$f" &
    n=$((n + 1))
    if [ "$((n % JOBS))" -eq 0 ]; then wait; echo "[send]   已提交 $n/${#todo[@]}" >&2; fi
  done
  wait
}

MISSING=("$WORK"/part.*)
for attempt in 1 2 3; do
  echo "[send] 第 $attempt 轮，待传 ${#MISSING[@]} 块" >&2
  round "${MISSING[@]}"
  # 核对：SendFile 是异步的，提交成功不代表落地。按文件名与字节数逐块核。
  REMOTE=$("$HERE/run-on.sh" "$HOST" - "cd '$TMPDIR_REMOTE' 2>/dev/null && for f in part.*; do [ -f \"\$f\" ] && echo \"\$f \$(stat -c %s \"\$f\")\"; done" 2>/dev/null \
    | grep -E '^part\.[0-9]+ [0-9]+$' || true)
  NEW=()
  for f in "$WORK"/part.*; do
    name=$(basename "$f"); want=$(stat -c %s "$f")
    printf '%s\n' "$REMOTE" | grep -qx "$name $want" || NEW+=("$f")
  done
  MISSING=("${NEW[@]+"${NEW[@]}"}")
  [ "${#MISSING[@]}" -eq 0 ] && break
done
[ "${#MISSING[@]}" -eq 0 ] || { echo "仍有 ${#MISSING[@]} 块没落地，停。" >&2; exit 1; }
echo "[send] 全部 $NPARTS 块已落地，主机侧拼装并校验 sha256" >&2

# ca.sh 不管远端成功失败都 exit 0（只把 "### exit=N" 打在输出里），所以这一步
# 必须自己解析退出码——否则 sha256 校验不符会被 set -eu 放过去（坑 18）。
OUT=$("$HERE/run-on.sh" "$HOST" - "set -eu
install -d \"\$(dirname '$DEST')\"
cat '$TMPDIR_REMOTE'/part.* > '$DEST.partial'
got=\$(sha256sum '$DEST.partial' | cut -d' ' -f1)
[ \"\$got\" = '$SHA' ] || { echo \"sha256 不符 expected=$SHA got=\$got\"; rm -f '$DEST.partial'; exit 1; }
n=\$(stat -c %s '$DEST.partial')
[ \"\$n\" = '$BYTES' ] || { echo \"字节数不符 expected=$BYTES got=\$n\"; rm -f '$DEST.partial'; exit 1; }
mv -f '$DEST.partial' '$DEST'
rm -rf '$TMPDIR_REMOTE'
echo \"ok $DEST bytes=\$n sha256=\$got\"" 2>/dev/null)
printf '%s\n' "$OUT"
RC=$(printf '%s\n' "$OUT" | sed -n 's/^### exit=\([0-9]*\) .*/\1/p' | tail -1)
[ "$RC" = "0" ] || { echo "[send] 主机侧拼装/校验失败（远端退出码 ${RC:-未知}）" >&2; exit 1; }
