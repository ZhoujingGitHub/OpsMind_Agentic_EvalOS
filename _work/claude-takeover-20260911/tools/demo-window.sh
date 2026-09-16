#!/bin/bash
# Demo-window switch for the three consoles. Default state is closed.
#
#   ./demo-window.sh status          查看三个入口当前开/关
#   ./demo-window.sh open  [which]   演示前开
#   ./demo-window.sh close [which]   演示后关
#
# which = evalos | lg | ah | all (默认 all)
#
# 关闭态是 nginx 的硬 403：`deny all;` 与 `auth_basic` 同时存在时，access 阶段
# 先于认证阶段生效，**即使带正确口令也拿不到内容**（2026-09-16 在 EvalOS 机上用
# 隔离回环 vhost 实测过 deny/auth/两者兼有 共 7 种组合）。
#
# 关闭页面入口不影响链路③④：`/api/candidate-relay/` 与 `/api/candidate-presence`
# 两个 location 不包含开关文件也没有认证（日志实证：42 万次认领全部来自产品机）。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ACTION="${1:-status}"
WHICH="${2:-all}"

EVALOS_INST=i-bp14ezltpnq8mxic1gsb
PRODUCT_INST=i-bp12nyanjsyue1vs5bu6

# 每个入口：实例 / 云助手脚本 / 开关文件 / 开放态备份 / 探测用 IP
run_evalos() { "$HERE/ca-eval.sh" "$EVALOS_INST" 90; }
run_product() { "$HERE/ca.sh" "$PRODUCT_INST" 90; }

remote_body() {
  # $1=switch file  $2=open-state backup  $3=probe url  $4=action
  cat <<EOF
set -u
SW="$1"; BAK="$2"; URL="$3"; ACT="$4"
if [ ! -f "\$SW" ]; then echo "  未配置（开关文件不存在）"; exit 0; fi
case "\$ACT" in
  open)
    if [ -f "\$BAK" ]; then install -m 644 "\$BAK" "\$SW"; else : > "\$SW"; fi
    nginx -t >/dev/null 2>&1 || { echo "  nginx -t 失败，未 reload"; exit 1; }
    systemctl reload nginx; sleep 3
    ;;
  close)
    printf '# Demo window closed. Open with demo-window.sh open.\ndeny all;\n' > "\$SW"
    nginx -t >/dev/null 2>&1 || { echo "  nginx -t 失败，未 reload"; exit 1; }
    systemctl reload nginx; sleep 3
    ;;
esac
if grep -qE '^[[:space:]]*deny all;' "\$SW"; then STATE="关闭"; else STATE="开放"; fi
CODE=\$(curl -s -o /dev/null -w '%{http_code}' -m 10 -k "\$URL" 2>/dev/null)
echo "  状态=\$STATE  探测 HTTP=\$CODE  （关闭应为 403；开放且未带口令应为 401）"
EOF
}

do_one() {
  case "$1" in
    evalos)
      echo "EvalOS  https://121-40-223-202.sslip.io/"
      remote_body /etc/nginx/opsmind-console-access.conf \
                  /etc/nginx/opsmind-console-access.conf.open-20260916 \
                  https://121.40.223.202/ "$ACTION" | run_evalos ;;
    lg)
      echo "LG      https://lg.114-55-40-170.sslip.io/"
      remote_body /etc/nginx/opsmind-lg-access.conf \
                  /etc/nginx/opsmind-lg-access.conf.open \
                  https://127.0.0.1/ "$ACTION" | run_product ;;
    ah)
      echo "AH      https://ah.114-55-40-170.sslip.io/"
      remote_body /etc/nginx/opsmind-ah-access.conf \
                  /etc/nginx/opsmind-ah-access.conf.open \
                  https://127.0.0.1/ "$ACTION" | run_product ;;
  esac
}

case "$ACTION" in
  status|open|close) ;;
  *) echo "用法: $0 {status|open|close} [evalos|lg|ah|all]"; exit 2 ;;
esac

case "$WHICH" in
  all) for w in evalos lg ah; do do_one "$w"; done ;;
  evalos|lg|ah) do_one "$WHICH" ;;
  *) echo "which 取值: evalos | lg | ah | all"; exit 2 ;;
esac

if [ "$ACTION" = open ]; then
  echo
  echo "演示前提醒：必须用 https://；先在浏览器里登录好 Basic 认证，别在共享屏幕时当场输。"
  echo "本机 curl 测不出可达性（TUN 代理，出口在东京），判断能不能打开一律用浏览器。"
fi
