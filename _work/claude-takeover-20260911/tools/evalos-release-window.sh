# EvalOS 发版维护窗口：装新安装器 → 停服务 → 归档旧中继存证并收缩库 → 用新安装器发版。
# 远端 POSIX sh。冻结设计里未开考的 QUEUED Trial 不算进行中，只看 RUNNING 与排队/运行中的评测请求。
# 用法：
#   ./run-on.sh evalos evalos-release-window.sh REL=<release_id> SHA=<archive sha256> \
#       [ARCHIVE_BEFORE=2026-09-14] [ARCHIVE_DIR=/srv/opsmind-evidence/relay-archive-pre-20260914]
# 发版包须已在 /var/tmp/<release_id>.tar.gz（send-file.sh 送达并核对过 sha256）。
#
# 任何一步失败就停：安装器之前失败时服务保持停止并提示怎么起回来；安装器自己失败会
# 自动把应用回滚到上一版（数据库不回滚——归档已经写了账本，按设计不可逆）。
set -eu
: "${REL:?REL=<release_id>}"
: "${SHA:?SHA=<archive sha256>}"
ARCHIVE_BEFORE="${ARCHIVE_BEFORE:-2026-09-14}"
ARCHIVE_DIR="${ARCHIVE_DIR:-/srv/opsmind-evidence/relay-archive-pre-20260914}"
PKG=/var/tmp/$REL.tar.gz
DB=/var/lib/opsmind-evalos/control/control.sqlite
INSTALLER=/usr/local/sbin/opsmind-evalos-install-release
echo "== 0 前置"
[ "$(sha256sum "$PKG" | cut -d' ' -f1)" = "$SHA" ] || { echo "发版包 sha256 不符"; exit 2; }
STAGE=$(mktemp -d /var/tmp/evalos-stage-XXXXXX)
tar -xzf "$PKG" -C "$STAGE"
grep -q "\"release_id\": \"$REL\"" "$STAGE/evalos/RELEASE.json"
grep -q '"formal_exam_auto_enabled": false' "$STAGE/evalos/RELEASE.json"

echo "== 1 装新安装器（旧的留 .pre-$REL）"
[ -f "$INSTALLER.pre-$REL" ] || cp -a "$INSTALLER" "$INSTALLER.pre-$REL"
install -m 0755 "$STAGE/evalos/infra/deploy/install-m31-release.sh" "$INSTALLER"
grep -q formal_exam_auto_enabled "$INSTALLER"

echo "== 2 停服务，确认没有进行中的考试"
systemctl stop opsmind-evalos-console opsmind-evalos
RUNNING=$(node --experimental-sqlite --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const t = db.prepare("SELECT COUNT(*) n FROM trials WHERE status = ?").get("RUNNING").n;
const r = db.prepare("SELECT COUNT(*) n FROM evaluation_run_requests WHERE status IN (?, ?)").get("QUEUED", "RUNNING").n;
console.log(t + r);' "$DB")
if [ "$RUNNING" != 0 ]; then
  echo "还有 $RUNNING 个进行中的 Trial/评测请求，不做维护；服务起回来"
  systemctl start opsmind-evalos opsmind-evalos-console; exit 3
fi
echo "   无进行中考试；库 $(du -h "$DB" | cut -f1)"

echo "== 3 归档 $ARCHIVE_BEFORE 之前的中继存证并收缩库"
if ! node --experimental-sqlite --no-warnings "$STAGE/evalos/scripts/archive-relay-evidence.mjs" \
     --before "$ARCHIVE_BEFORE" --out "$ARCHIVE_DIR" --apply --vacuum; then
  echo "归档失败：服务仍停着。确认后用 systemctl start opsmind-evalos opsmind-evalos-console 起回旧版"; exit 4
fi
chmod 0444 "$ARCHIVE_DIR"/*
( cd "$ARCHIVE_DIR" && sha256sum * > SHA256SUMS )
echo "   库收缩后 $(du -h "$DB" | cut -f1)；归档 $(du -sh "$ARCHIVE_DIR" | cut -f1) 在 $ARCHIVE_DIR"

echo "== 4 发版"
"$INSTALLER" "$PKG" "$REL" "$SHA"
rm -rf "$STAGE"
echo "== 完成：current=$(readlink -f /opt/opsmind-evalos/current)"
