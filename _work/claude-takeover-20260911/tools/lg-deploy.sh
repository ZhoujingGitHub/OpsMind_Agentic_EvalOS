#!/bin/bash
# 把 LG 仓的一个提交部署成一个新 release，并切过去。
#
# 新增于 2026-09-16。此前没有可复用的 staging 脚本——主机上 incoming/parts-<release>
# 那一堆目录说明每轮都是现场切块拼装的。这个脚本把那套流程固定下来，且不写死任何 ID。
#
# 做法：从线上当前 release 做 cp -a，**只覆盖本次提交改动的文件**，每个文件
# gzip+base64 分块经云助手送达后逐个校验 sha256。这样线上新旧的差异恰好是这次的改动，
# 后续实验结果才能归因；也顺带保留了线上与 Git 之间既有的行尾漂移（见坑：CRLF 部署漂移）。
#
#   REPO         LG 仓路径（含 .git）
#   REV          要部署的完整提交号
#   EXPECT_BASE  期望的线上当前 release id（12 位）。守卫：线上不是它就停，
#                防止在不认识的基线上做增量覆盖
#   ALLOW_MIGRATION=1  仅当本次改动确实动了 migrations/ 或 alembic.ini 时显式打开
#   APPLY=0      只 staging 与建镜像，不切换（默认 1，切换）
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${REPO:?用法: REPO=<LG 仓路径> REV=<完整提交号> EXPECT_BASE=<线上当前 release id>}"
: "${REV:?必须指明要部署的完整提交号}"
: "${EXPECT_BASE:?必须指明期望的线上当前 release id（12 位），守卫用}"
ALLOW_MIGRATION="${ALLOW_MIGRATION:-0}"
APPLY="${APPLY:-1}"
CHUNK="${CHUNK:-9000}"   # 每次云助手调用携带的 base64 字节数；RunCommand 限 18KB base64

REL=$(printf '%s' "$REV" | cut -c1-12)

# ca.sh 不管远端成功失败都 exit 0（只把 "### exit=N" 打在输出里），所以这里必须自己
# 解析退出码。不这么做，一个校验不符的分块会被 set -eu 放过去——正是坑 13 那一类。
run() {
  local out rc
  out=$("$HERE/run-on.sh" product - "$1" 2>/dev/null) || {
    echo "[deploy] 云助手调用本身失败" >&2; return 1; }
  printf '%s\n' "$out"
  rc=$(printf '%s\n' "$out" | sed -n 's/^### exit=\([0-9]*\) .*/\1/p' | tail -1)
  [ -n "$rc" ] || { echo "[deploy] 拿不到远端退出码，按失败处理" >&2; return 1; }
  [ "$rc" = "0" ] || { echo "[deploy] 远端脚本退出码 $rc" >&2; return 1; }
}

echo "[deploy] REV=$REV  release=$REL  base=$EXPECT_BASE" >&2

# ---- 1. 守卫：线上当前 release 必须是声明的基线，且这个 release 还不存在 ----
echo "[deploy] 1/6 核对线上基线" >&2
# 不要把 run 放进管道：管道的退出码是右侧命令的，守卫会白写（本轮踩过两次）。
BASEOUT=$(run "set +e
cur=\$(basename \"\$(readlink -f /srv/opsmind-langgraph/current)\")
echo \"current=\$cur\"
[ -d /srv/opsmind-langgraph/releases/$REL ] && echo 'target_exists=yes' || echo 'target_exists=no'
docker image inspect opsmind-langgraph-v1:$REL >/dev/null 2>&1 && echo 'target_image=yes' || echo 'target_image=no'")
printf '%s\n' "$BASEOUT" | grep -E "^(current|target_exists|target_image)=" >&2
printf '%s\n' "$BASEOUT" | grep -q "^current=$EXPECT_BASE$" \
  || { echo "线上当前 release 不是 $EXPECT_BASE，停。不要在不认识的基线上做增量覆盖。" >&2; exit 2; }

# ---- 2. 算出本次改动的文件，并挡住迁移 ----
FILES=$(cd "$REPO" && git diff --name-only "$EXPECT_BASE".."$REV")
[ -n "$FILES" ] || { echo "$EXPECT_BASE..$REV 没有文件改动" >&2; exit 2; }
echo "[deploy] 2/6 本次改动 $(printf '%s\n' "$FILES" | wc -l) 个文件：" >&2
printf '  %s\n' $FILES >&2
if printf '%s\n' "$FILES" | grep -qE "^(migrations/|alembic\.ini$)"; then
  [ "$ALLOW_MIGRATION" = "1" ] || {
    echo "本次改动涉及数据库迁移。切换会先跑 assert_database_compatible，" >&2
    echo "需要先想清楚迁移与回滚方案，然后显式 ALLOW_MIGRATION=1。" >&2
    exit 2; }
fi

# ---- 3. 从基线复制出新 release 目录（幂等）----
echo "[deploy] 3/6 从 $EXPECT_BASE 复制出 $REL" >&2
run "B=/srv/opsmind-langgraph
[ -d \$B/releases/$REL ] || cp -a \$B/releases/$EXPECT_BASE \$B/releases/$REL
rm -rf \$B/incoming/parts-$REL
install -d -m 0700 \$B/incoming/parts-$REL
echo staged=\$(ls -d \$B/releases/$REL)"

# ---- 4. 逐文件分块送达并校验 sha256 ----
i=0
for f in $FILES; do
  i=$((i + 1))
  sha=$(cd "$REPO" && git cat-file blob "$REV:$f" | sha256sum | cut -d' ' -f1)
  b64=$(cd "$REPO" && git cat-file blob "$REV:$f" | gzip -9 | base64 -w0)
  slug=$(printf '%s' "$f" | tr '/.' '__')
  n=0
  echo "[deploy] 4/6 送 $f（${#b64} B base64，sha=${sha:0:12}）" >&2
  # split 掉的是 base64 文本，所以可以任意位置切；拼回来再解码
  while [ -n "$b64" ]; do
    n=$((n + 1))
    part=$(printf '%s' "$b64" | cut -c1-$CHUNK)
    b64=$(printf '%s' "$b64" | cut -c$((CHUNK + 1))-)
    run "printf '%s' '$part' >> /srv/opsmind-langgraph/incoming/parts-$REL/$slug.b64
echo part=$n bytes=\$(wc -c < /srv/opsmind-langgraph/incoming/parts-$REL/$slug.b64)" >/dev/null
  done
  run "set -eu
P=/srv/opsmind-langgraph/incoming/parts-$REL/$slug.b64
T=/srv/opsmind-langgraph/releases/$REL/$f
install -d \"\$(dirname \"\$T\")\"
base64 -d \"\$P\" | gunzip > \"\$T.new\"
got=\$(sha256sum \"\$T.new\" | cut -d' ' -f1)
[ \"\$got\" = \"$sha\" ] || { echo \"sha256 不符 file=$f expected=$sha got=\$got\"; rm -f \"\$T.new\"; exit 1; }
chown --reference=\"\$(dirname \"\$T\")\" \"\$T.new\" 2>/dev/null || true
mv \"\$T.new\" \"\$T\"
echo \"ok $f sha=\$got\""
done

# ---- 5. 建镜像，沿用线上同一套 label ----
# 构建要 6-8 分钟，超过云助手单次调用的 Timeout（300s，实测会 status=Timeout、
# exit=None 把脚本壳杀掉）。所以用 setsid 脱离会话后台跑，再另起轮询等它。
echo "[deploy] 5/6 建镜像 opsmind-langgraph-v1:$REL（后台，轮询等待）" >&2
SRC=$(cd "$REPO" && git config --get remote.origin.url 2>/dev/null || echo "")
run "set -eu
L=/srv/opsmind-langgraph/incoming/parts-$REL/build.log
if docker image inspect opsmind-langgraph-v1:$REL >/dev/null 2>&1; then
  echo 'image_already_present'; exit 0
fi
if ps -ef | grep -q '[d]ocker build -t opsmind-langgraph-v1:$REL'; then
  echo 'build_already_running'; exit 0
fi
cd /srv/opsmind-langgraph/releases/$REL
setsid nohup docker build -t opsmind-langgraph-v1:$REL \
  --label org.opencontainers.image.revision=$REV \
  --label org.opencontainers.image.source=${SRC:-unset} \
  --label org.opencontainers.image.version=$REL \
  -f deploy/api/Dockerfile . > \"\$L\" 2>&1 < /dev/null &
echo build_started"

echo "[deploy] 5/6 等构建完成" >&2
built=0
for _ in $(seq 1 60); do
  st=$(run "set +e
if docker image inspect opsmind-langgraph-v1:$REL >/dev/null 2>&1; then echo STATE=DONE
elif ps -ef | grep -q '[d]ocker build -t opsmind-langgraph-v1:$REL'; then echo STATE=BUILDING
else echo STATE=GONE; tail -15 /srv/opsmind-langgraph/incoming/parts-$REL/build.log 2>/dev/null; fi" \
    | sed -n 's/^STATE=//p' | tail -1)
  echo "[deploy]   构建状态 $st" >&2
  [ "$st" = "DONE" ] && { built=1; break; }
  [ "$st" = "GONE" ] && { echo "[deploy] 构建进程没了且镜像不存在——构建失败，日志见上" >&2; exit 1; }
  "D:/install/anaconda3/python.exe" -c "import time;time.sleep(20)" 2>/dev/null || sleep 20
done
[ "$built" = "1" ] || { echo "[deploy] 等构建超时" >&2; exit 1; }

# 预检：镜像里能 import、alembic 单 head，且与线上数据库 revision 一致。
# 不做这步就只能靠切换时的健康门发现问题，白触发一次失败激活。
run "set -eu
docker run --rm opsmind-langgraph-v1:$REL python -c 'import opsmind_langgraph.api.production; print(\"import ok\")'
head=\$(docker run --rm opsmind-langgraph-v1:$REL python -m alembic -c alembic.ini heads | sed -n 's/ (head)\$//p')
db=\$(docker exec opsmind-mysql sh -ec 'exec mysql -N -uroot -p\"\$MYSQL_ROOT_PASSWORD\" opsmind_langgraph -e \"SELECT version_num FROM alembic_version\"' 2>/dev/null)
echo \"image_head=\$head db_revision=\$db\"
[ \"\$head\" = \"\$db\" ] || { echo '镜像 alembic head 与线上数据库 revision 不一致'; exit 1; }
docker image inspect opsmind-langgraph-v1:$REL --format '{{json .Config.Labels}}'"

# ---- 6. 加白名单并切换 ----
if [ "$APPLY" != "1" ]; then
  echo "[deploy] APPLY=0，到此为止：release 与镜像已就绪，未切换" >&2
  exit 0
fi
echo "[deploy] 6/6 加白名单并切换" >&2
run "set -eu
A=/etc/opsmind-langgraph/approved-releases
grep -Fxq '$REL' \"\$A\" || printf '%s\n' '$REL' >> \"\$A\"
/usr/local/sbin/opsmind-langgraph-release apply $REL"
echo "[deploy] 完成。回滚：run-on.sh product - '/usr/local/sbin/opsmind-langgraph-release rollback'" >&2
