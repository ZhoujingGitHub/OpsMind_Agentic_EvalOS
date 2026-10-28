#!/bin/bash
# 把本地一个文件送到三台机之一，远端核对 sha256 后才落到目标路径。
#
#   HOST      product | evalos | lab
#   SRC       本地文件路径
#   DEST      主机上的目标文件完整路径
#
# 2026-10-29 起走 SSH 一次流式送达（入口见 remote-hosts.sh）。云助手时代这里要切
# 18 KB 一块、并行 SendFile、再逐块核对是否落地（2.8 MB 要 157 块往返）；
# 现在同样的文件一条连接 2~3 秒。核对 sha256 这一步保留：传输层再可靠，
# 落地的是不是那份字节，仍然只有比对才知道。
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/remote-hosts.sh"
: "${HOST:?用法: HOST=<product|evalos|lab> SRC=<本地文件> DEST=<主机目标路径>}"
: "${SRC:?必须指明本地文件}"
: "${DEST:?必须指明主机上的目标完整路径}"
[ -r "$SRC" ] || { echo "读不到 $SRC" >&2; exit 2; }
# 从标准输入算：Git-Bash 的 sha256sum 遇到带反斜杠的 Windows 路径会给结果加前缀 "\"
SHA=$(sha256sum < "$SRC" | cut -d' ' -f1)
BYTES=$(wc -c < "$SRC" | tr -d ' ')
echo "[send] $(basename "$SRC")  $BYTES B  sha=${SHA:0:12}  -> $HOST:$DEST" >&2
remote_put "$HOST" "$DEST" "$SHA" < "$SRC"
echo "ok $DEST bytes=$BYTES sha256=$SHA"
