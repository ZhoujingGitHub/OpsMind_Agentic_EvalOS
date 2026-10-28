#!/bin/bash
# 把 AH 仓的一个提交部署成一个新 release，并切过去。
#
# 新增于 2026-09-18。此前只有 lg-deploy.sh，AH 侧每轮都是现场手搓。
# AH 的发布控制器比 LG 严得多：apply 要过 7 道断言（approved-releases 唯一命中、
# 镜像标签合法、**镜像 ID 逐字节相符**、revision 标签以 release 开头、
# 运行身份 opsmind:opsmind 且 uid/gid 相符、密钥文件权限精确、
# schema_migrations 里那一行的 content_sha256 相符）。所以这个脚本必须把
# 镜像 ID 算出来写进白名单，不能像 LG 那样只写一个 release id。
#
# 做法与 lg-deploy.sh 一致：从线上当前 release 的源码树 cp -a，
# **只覆盖本次提交改动的文件**，每个文件经 SSH 送达后在远端逐个校验
# sha256。这样线上新旧的差异恰好是这次的改动，实验结果才能归因。
#
#   REPO         AH 仓路径（含 .git）
#   REV          要部署的完整提交号
#   EXPECT_BASE  期望的线上当前 release id（12 位）。守卫：线上不是它就停
#   APPLY=0      只 staging 与建镜像，不切换（默认 1，切换）
#
# 迁移：本脚本**不跑数据库迁移**。控制器校验的是 approved-releases 里记的那一行
# 迁移及其哈希，而那两个字段是从现有白名单行照抄的——所以迁移必须在跑本脚本
# **之前**单独应用好。只加可空列的迁移对老镜像无害，可以先迁移后发布。
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/remote-hosts.sh"
: "${REPO:?用法: REPO=<AH 仓路径> REV=<完整提交号> EXPECT_BASE=<线上当前 release id>}"
: "${REV:?必须指明要部署的完整提交号}"
: "${EXPECT_BASE:?必须指明期望的线上当前 release id（12 位），守卫用}"
APPLY="${APPLY:-1}"

REL=$(printf '%s' "$REV" | cut -c1-12)
B=/srv/opsmind-agent-harness
# 线上镜像是在这个冻结的运行时基础上覆盖构建的。基础镜像提供 OS 与 Python 依赖、
# 以及那个从 /run/secrets/* 读密钥再 export 的 entrypoint 脚本——应用镜像自己不带它。
RUNTIME_BASE=opsmind-agent-harness:runtime-base
OVERLAY_DOCKERFILE=deploy/docker/agent-service-offline-overlay.Dockerfile

# run-on.sh 带回的就是远端退出码。绝不要把 run 放进管道：管道退出码取右侧，守卫会白写。
run() {
  local out rc=0
  out=$("$HERE/run-on.sh" product - "$1" 2>/dev/null) || rc=$?
  printf '%s\n' "$out"
  [ "$rc" = "0" ] || { echo "[ah-deploy] 远端退出码 $rc（255 = SSH 连不上）" >&2; return 1; }
}

echo "[ah-deploy] REV=$REV  release=$REL  base=$EXPECT_BASE" >&2

# ---- 1. 守卫：线上基线、基线源码树，以及【构建配方与线上产物对齐】----
# 最后一项是 2026-09-18 补的，代价是一次失败的激活：当时凭"看起来对应"挑了
# deploy/docker/agent-service.Dockerfile，而线上其实是 overlay 覆盖构建。
# 症状是三个（构建联网下载 48 分钟、Entrypoint 为 null、密钥读不到），根因是一个。
# 判据一开始就在线上镜像的标签里：**只有 overlay 会写 image.base.digest**。
# 所以这里先反推线上产物是怎么来的，再决定怎么建——不再靠挑文件名。
echo "[ah-deploy] 1/6 核对线上基线与构建配方" >&2
BASE_FULL=$(cd "$REPO" && git rev-parse "$EXPECT_BASE")
BASEOUT=$(run "set +e
/usr/local/sbin/opsmind-agent-harness-release status | sed -n 's/.*\"current_release\":\"\([0-9a-f]*\)\".*/current=\1/p'
[ -d $B/builds/$BASE_FULL ] && echo 'base_tree=yes' || echo 'base_tree=no'
[ -d $B/builds/$REV ] && echo 'target_tree=yes' || echo 'target_tree=no'
docker image inspect opsmind-agent-harness:$REL >/dev/null 2>&1 && echo 'target_image=yes' || echo 'target_image=no'
echo live_base_digest=\$(docker image inspect opsmind-agent-harness:$EXPECT_BASE --format '{{index .Config.Labels \"org.opencontainers.image.base.digest\"}}' 2>/dev/null)
echo runtime_base_id=\$(docker image inspect $RUNTIME_BASE --format '{{.Id}}' 2>/dev/null)
echo live_entrypoint=\$(docker image inspect opsmind-agent-harness:$EXPECT_BASE --format '{{json .Config.Entrypoint}}' 2>/dev/null)")
printf '%s\n' "$BASEOUT" | grep -E "^(current|base_tree|target_tree|target_image|live_base_digest|runtime_base_id|live_entrypoint)=" >&2
printf '%s\n' "$BASEOUT" | grep -q "^current=$EXPECT_BASE$" \
  || { echo "线上当前 release 不是 $EXPECT_BASE，停。不要在不认识的基线上做增量覆盖。" >&2; exit 2; }
printf '%s\n' "$BASEOUT" | grep -q "^base_tree=yes$" \
  || { echo "基线源码树 $B/builds/$BASE_FULL 不在，无法做增量。" >&2; exit 2; }

BASE_DIGEST=$(printf '%s\n' "$BASEOUT" | sed -n 's/^live_base_digest=//p' | tail -1)
RUNTIME_ID=$(printf '%s\n' "$BASEOUT" | sed -n 's/^runtime_base_id=//p' | tail -1)
LIVE_ENTRYPOINT=$(printf '%s\n' "$BASEOUT" | sed -n 's/^live_entrypoint=//p' | tail -1)
case "$BASE_DIGEST" in
  sha256:*) ;;
  *) echo "线上镜像没有 image.base.digest 标签。本脚本只会做 overlay 覆盖构建；" >&2
     echo "线上若不是这么来的，先查清它的真实配方，不要在这里猜。" >&2; exit 2 ;;
esac
[ "$BASE_DIGEST" = "$RUNTIME_ID" ] \
  || { echo "运行时基础镜像 $RUNTIME_BASE（$RUNTIME_ID）与线上镜像声明的" >&2
       echo "base.digest（$BASE_DIGEST）不一致。基础镜像漂了，停。" >&2; exit 2; }
[ -f "$REPO/$OVERLAY_DOCKERFILE" ] \
  || { echo "仓里没有 $OVERLAY_DOCKERFILE" >&2; exit 2; }
echo "[ah-deploy]   配方已对齐：overlay 覆盖构建于 $RUNTIME_BASE" >&2

# ---- 2. 算出本次改动的文件 ----
# 构建树只含 deploy/ docs/ services/ shared/，其余路径（例如仓根的文档）不参与构建。
FILES=$(cd "$REPO" && git diff --name-only --diff-filter=d "$BASE_FULL".."$REV" \
        | grep -E '^(deploy|docs|services|shared)/' || true)
DELETED=$(cd "$REPO" && git diff --name-only --diff-filter=D "$BASE_FULL".."$REV" \
        | grep -E '^(deploy|docs|services|shared)/' || true)
[ -n "$FILES$DELETED" ] || { echo "$EXPECT_BASE..$REV 在构建树范围内没有文件改动" >&2; exit 2; }
echo "[ah-deploy] 2/6 本次改动 $(printf '%s\n' "$FILES" | wc -l) 个文件：" >&2
printf '  %s\n' $FILES >&2

# ---- 3. 从基线复制出新源码树（幂等）----
echo "[ah-deploy] 3/6 从 $BASE_FULL 复制出 $REV" >&2
run "[ -d $B/builds/$REV ] || cp -a $B/builds/$BASE_FULL $B/builds/$REV
rm -rf $B/builds/parts-$REL
install -d -m 0700 $B/builds/parts-$REL
echo staged=\$(ls -d $B/builds/$REV)"

# ---- 4. 逐文件送达并在远端校验 sha256；基线里有、本次删掉的文件一并删掉 ----
for f in $FILES; do
  sha=$(cd "$REPO" && git cat-file blob "$REV:$f" | sha256sum | cut -d' ' -f1)
  echo "[ah-deploy] 4/6 送 $f（sha=${sha:0:12}）" >&2
  (cd "$REPO" && git cat-file blob "$REV:$f") | remote_put product "$B/builds/$REV/$f" "$sha"
done
for f in $DELETED; do
  echo "[ah-deploy] 4/6 删 $f" >&2
  run "rm -f '$B/builds/$REV/$f'" >/dev/null
done

# ---- 5. 建镜像（后台 + 轮询：构建不依附于这条 SSH 连接，断线也不会半途被杀；坑 19）----
# overlay 的标签是 ARG→LABEL，所以身份必须用 --build-arg 传，不能用 --label；
# image.source 由基础镜像提供，这里不重复设置。依赖走 --no-index 的离线锁，
# 所以这一步不联网下载（用错 Dockerfile 那次，同一台机下了 48 分钟）。
echo "[ah-deploy] 5/6 建镜像 opsmind-agent-harness:$REL（overlay，后台，轮询等待）" >&2
run "set -eu
L=$B/builds/parts-$REL/build.log
if docker image inspect opsmind-agent-harness:$REL >/dev/null 2>&1; then
  echo 'image_already_present'; exit 0
fi
if ps -ef | grep -q '[d]ocker build -t opsmind-agent-harness:$REL'; then
  echo 'build_already_running'; exit 0
fi
cd $B/builds/$REV
setsid nohup docker build -t opsmind-agent-harness:$REL \
  --build-arg BASE_IMAGE=$RUNTIME_BASE \
  --build-arg OCI_REVISION=$REV \
  --build-arg OCI_VERSION=$REL \
  --build-arg RUNTIME_BASE_DIGEST=$BASE_DIGEST \
  -f $OVERLAY_DOCKERFILE . > \"\$L\" 2>&1 < /dev/null &
echo build_started"

echo "[ah-deploy] 5/6 等构建完成" >&2
built=0
for _ in $(seq 1 90); do
  st=$(run "set +e
if docker image inspect opsmind-agent-harness:$REL >/dev/null 2>&1; then echo STATE=DONE
elif ps -ef | grep -q '[d]ocker build -t opsmind-agent-harness:$REL'; then echo STATE=BUILDING
else echo STATE=GONE; tail -20 $B/builds/parts-$REL/build.log 2>/dev/null; fi" \
    | sed -n 's/^STATE=//p' | tail -1)
  echo "[ah-deploy]   构建状态 $st" >&2
  [ "$st" = "DONE" ] && { built=1; break; }
  [ "$st" = "GONE" ] && { echo "[ah-deploy] 构建进程没了且镜像不存在——构建失败，日志见上" >&2; exit 1; }
  "D:/install/anaconda3/python.exe" -c "import time;time.sleep(20)" 2>/dev/null || sleep 20
done
[ "$built" = "1" ] || { echo "[ah-deploy] 等构建超时" >&2; exit 1; }

# 预检。控制器会断言其中一部分，但它**不查 entrypoint**——而 entrypoint 缺失恰好是
# 用错 Dockerfile 那次唯一会致命的后果（密钥是 entrypoint 从 /run/secrets 读的）。
# 所以这里拿新镜像和线上镜像逐项比形状：任一不一致就说明配方还是不对，早停。
echo "[ah-deploy] 预检：与线上镜像逐项比形状" >&2
run "set -eu
T=opsmind-agent-harness:$REL
L=opsmind-agent-harness:$EXPECT_BASE
docker image inspect \$T --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' | grep -q '^$REL' \
  || { echo 'revision 标签不以 release 开头'; exit 1; }
[ \"\$(docker image inspect \$T --format '{{.Config.User}}')\" = 'opsmind:opsmind' ] \
  || { echo '运行身份不是 opsmind:opsmind'; exit 1; }
nb=\$(docker image inspect \$T --format '{{index .Config.Labels \"org.opencontainers.image.base.digest\"}}')
[ \"\$nb\" = '$BASE_DIGEST' ] \
  || { echo \"base.digest 不是 $BASE_DIGEST（拿到 '\$nb'）——配方仍不对\"; exit 1; }
ne=\$(docker image inspect \$T --format '{{json .Config.Entrypoint}}')
le=\$(docker image inspect \$L --format '{{json .Config.Entrypoint}}')
[ \"\$ne\" = \"\$le\" ] \
  || { echo \"entrypoint 与线上不一致：新=\$ne 线上=\$le\"; exit 1; }
docker run --rm --entrypoint /usr/local/bin/python \$T -c 'import opsmind_agent.main' \
  || { echo '新镜像里 import main 失败'; exit 1; }
echo \"ok image_id=\$(docker image inspect \$T --format '{{.Id}}') entrypoint=\$ne base=\$nb\""

# ---- 6. 加白名单（含镜像 ID）并切换 ----
if [ "$APPLY" != "1" ]; then
  echo "[ah-deploy] APPLY=0，到此为止：源码树与镜像已就绪，未加白名单、未切换" >&2
  exit 0
fi
echo "[ah-deploy] 6/6 加白名单并切换" >&2
# 迁移号与其哈希从现有白名单行照抄：控制器把 REQUIRED_MIGRATION 写死在自己脚本里，
# 我们不改它，也不该在这里另起一个来源。
run "set -eu
A=/etc/opsmind-agent-harness/approved-releases
IMG=\$(docker image inspect opsmind-agent-harness:$REL --format '{{.Id}}')
MIG=\$(tail -1 \"\$A\" | cut -d'|' -f4)
MIGH=\$(tail -1 \"\$A\" | cut -d'|' -f5)
[ -n \"\$MIG\" ] && [ -n \"\$MIGH\" ] || { echo '从白名单末行取不到迁移字段'; exit 1; }
if grep -q \"^$REL|\" \"\$A\"; then
  echo 'already_approved'
else
  cp -a \"\$A\" \"\$A.bak-pre-$REL\"
  printf '%s|opsmind-agent-harness:%s|%s|%s|%s\n' '$REL' '$REL' \"\$IMG\" \"\$MIG\" \"\$MIGH\" >> \"\$A\"
  echo approved=\$(tail -1 \"\$A\")
fi
/usr/local/sbin/opsmind-agent-harness-release apply $REL"
echo "[ah-deploy] 完成。回滚：run-on.sh product - '/usr/local/sbin/opsmind-agent-harness-release rollback'" >&2
