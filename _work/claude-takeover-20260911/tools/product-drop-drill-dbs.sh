# 备份后删除产品机 MySQL 里的 13 个演练库（2026-10-29，评测重设计发版前的清理）。
# 远端 POSIX sh。用法：./run-on.sh product product-drop-drill-dbs.sh [APPLY=1]
#
# 演练库 = 恢复演练留下的 opsmind_langgraph_restore_<时间戳> 12 个 + 一次升级演练
# opsmind_lg_upgrade_82611f1a。它们不被任何运行中的服务引用（下面第 1 步核对），
# 只占空间、并让「哪个库是真的」变得需要解释。
#
# 顺序固定：核对无引用 → 逐库 mysqldump 并 gzip -t 校验 → 记清单与 sha256 → 才 DROP。
# 不给 APPLY=1 时只做前三步，不删。备份留在 /srv/opsmind-evidence/，与其他存证同处。
set -eu
APPLY="${APPLY:-0}"
OUT=/srv/opsmind-evidence/mysql-drill-dbs-20261029
SQL='SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE "opsmind\_langgraph\_restore\_%" OR schema_name = "opsmind_lg_upgrade_82611f1a" ORDER BY 1'
my() { docker exec -i opsmind-mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$@"' mysql "$@" 2>/dev/null; }
dump() { docker exec opsmind-mysql sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers --databases "$1"' mysqldump "$1" 2>/dev/null; }

DBS=$(my -N -e "$SQL")
N=$(printf '%s\n' "$DBS" | grep -c . || true)
echo "演练库 $N 个"
[ "$N" -eq 13 ] || { echo "不是预期的 13 个，停"; printf '%s\n' "$DBS"; exit 2; }

echo "1/4 核对：运行中服务的配置与容器环境不引用它们"
for db in $DBS; do
  if grep -rqs -- "$db" /srv/opsmind-langgraph/current/*.env /srv/opsmind-langgraph/*.env \
       /srv/opsmind-agent-harness/*.env /srv/opsmind-agent-harness/current/*.env /etc/opsmind* 2>/dev/null; then
    echo "  $db 被配置引用，停"; exit 3
  fi
  for c in $(docker ps --format '{{.Names}}'); do
    if docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" | grep -q -- "$db"; then
      echo "  $db 被容器 $c 的环境引用，停"; exit 3
    fi
  done
  conns=$(my -N -e "SELECT COUNT(*) FROM information_schema.processlist WHERE db='$db'")
  [ "$conns" = 0 ] || { echo "  $db 当前有 $conns 个连接，停"; exit 3; }
done
echo "  无引用、无连接"

echo "2/4 逐库备份并校验"
install -d -m 0700 "$OUT"
for db in $DBS; do
  f="$OUT/$db.sql.gz"
  [ -s "$f" ] && gzip -t "$f" && { echo "  $db 已有备份，跳过"; continue; }
  dump "$db" | gzip -9 > "$f.partial"
  gzip -t "$f.partial"
  zcat "$f.partial" | tail -1 | grep -q "Dump completed" || { echo "  $db 备份不完整，停"; exit 4; }
  mv "$f.partial" "$f"
  echo "  $db  $(stat -c %s "$f") B"
done

echo "3/4 记清单"
( cd "$OUT" && sha256sum *.sql.gz > SHA256SUMS && cat SHA256SUMS | awk '{print "  " substr($1,1,12) "  " $2}' )

if [ "$APPLY" != 1 ]; then echo "4/4 未给 APPLY=1，不删除"; exit 0; fi
echo "4/4 删除"
for db in $DBS; do my -e "DROP DATABASE \`$db\`"; echo "  dropped $db"; done
LEFT=$(my -N -e "$SQL" | grep -c . || true)
echo "剩余演练库 $LEFT 个；备份在 $OUT"
[ "$LEFT" -eq 0 ]
