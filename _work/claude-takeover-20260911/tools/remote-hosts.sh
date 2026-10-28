#!/bin/bash
# 三台机的 SSH 入口。run-on.sh / send-file.sh / ah-deploy.sh / lg-deploy.sh 共用，
# 只在这里写一次（被 source，不单独执行）。
#
# 2026-10-27 实测三台全通，全程不碰阿里云凭据：
#
#   本机 ──WireGuard(UDP)──► 考场 EvalOS 10.77.240.1   root，直连
#                              ├─► 产品机 10.77.240.4   root，经考场转发
#                              └─► 实验室 10.77.240.3   ecs-user + sudo -n（root 被禁）
#
# 钥匙留在本机，考场只做 -W 转发。远端 /bin/sh 是 dash，脚本按 POSIX sh 写。
# 云助手（ca.sh / ca-eval.sh）只剩阿里云账号层面的事：查到期日、改安全组。
KEY_EVALOS="${KEY_EVALOS:-$HOME/.ssh/opsmind-evallab-ed25519}"
KEY_ALIYUN="${KEY_ALIYUN:-$HOME/.ssh/opsmind-aliyun}"

# 设置 REMOTE_SSH（ssh 命令数组）与 REMOTE_SUDO（以 root 执行时要加的前缀）
remote_ssh_args() {
  local common=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30
                -o ServerAliveCountMax=6 -o StrictHostKeyChecking=accept-new)
  local jump="ProxyCommand=ssh -o BatchMode=yes -o ConnectTimeout=15 -i $KEY_EVALOS -W %h:%p root@10.77.240.1"
  case "$1" in
    evalos)  REMOTE_SSH=(ssh "${common[@]}" -i "$KEY_EVALOS" root@10.77.240.1); REMOTE_SUDO="" ;;
    product) REMOTE_SSH=(ssh "${common[@]}" -o "$jump" -i "$KEY_ALIYUN" root@10.77.240.4); REMOTE_SUDO="" ;;
    lab)     REMOTE_SSH=(ssh "${common[@]}" -o "$jump" -i "$KEY_ALIYUN" ecs-user@10.77.240.3); REMOTE_SUDO="sudo -n " ;;
    *) echo "host 取值: product | evalos | lab" >&2; return 2 ;;
  esac
}

# ssh 自己连不上时退出码是 255；那是「网络到不了」，不是远端脚本失败
remote_unreachable_hint() {
  echo "[remote] SSH 连不上（退出码 255）。先查两件事：本机 Clash 是否被切成全局模式；" >&2
  echo "         当前网络是否封 UDP（WireGuard 只走 UDP，换手机热点可验证）。" >&2
}

# 标准输入 → 远端文件 $2，落地前在远端核对 sha256 $3；不符则不留半截文件
#   remote_put <host> <远端完整路径> <sha256>
remote_put() {
  remote_ssh_args "$1" || return 2
  local rc=0
  "${REMOTE_SSH[@]}" "${REMOTE_SUDO}sh -c 'set -eu; d=\$1; want=\$2
install -d \"\$(dirname \"\$d\")\"
cat > \"\$d.partial\"
got=\$(sha256sum \"\$d.partial\" | cut -d\" \" -f1)
if [ \"\$got\" != \"\$want\" ]; then rm -f \"\$d.partial\"; echo \"sha256 不符 \$d expected=\$want got=\$got\" >&2; exit 1; fi
chown --reference=\"\$(dirname \"\$d\")\" \"\$d.partial\" 2>/dev/null || true
mv -f \"\$d.partial\" \"\$d\"' remote_put '$2' '$3'" || rc=$?
  [ "$rc" = 255 ] && remote_unreachable_hint
  return "$rc"
}
