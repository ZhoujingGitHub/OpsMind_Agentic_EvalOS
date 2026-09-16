#!/bin/bash
# Read certificate state on both hosts. Read-only.
#
# Why this exists: the renewal timer can legitimately fail. sslip.io is not on
# the Public Suffix List, so every *.sslip.io holder shares one Let's Encrypt
# registered-domain quota. A timer that fails silently is no better than no
# timer, so the timer leaves a RENEW_FAILED marker and this script surfaces it.
#
# Do NOT try to judge reachability from this machine with curl -- it runs behind
# a TUN-mode proxy whose exit is in Tokyo, and curl fails on names that a browser
# opens fine (RUNBOOK pit 12). This script asks the hosts themselves.
#
# Usage: ./check-certs.sh [warn-days]        默认 30 天
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WARN="${1:-30}"
SECS=$((WARN * 86400))
bad=0

probe() {
  cat <<EOF
set -u
. /etc/opsmind-cert-renew.conf 2>/dev/null || { echo "  未配置续期（/etc/opsmind-cert-renew.conf 不存在）"; exit 0; }
echo "  域名: \$DOMAINS"
C="\$CERT_DIR/fullchain.pem"
if [ ! -r "\$C" ]; then echo "  !! 证书文件不存在: \$C"; exit 1; fi
echo "  到期: \$(openssl x509 -in "\$C" -noout -enddate | cut -d= -f2)"
echo "  签发: \$(openssl x509 -in "\$C" -noout -issuer | sed 's/.*CN *= *//')"
if openssl x509 -in "\$C" -noout -checkend $SECS >/dev/null 2>&1; then
  echo "  剩余期限: 超过 $WARN 天 —— OK"
else
  echo "  !! 剩余期限不足 $WARN 天"; RC=1
fi
if [ -f /var/lib/opsmind-acme/RENEW_FAILED ]; then
  echo "  !! 上次续期失败，标记时间 \$(cat /var/lib/opsmind-acme/RENEW_FAILED)"
  echo "     journalctl -u opsmind-cert-renew.service -n 30 看原因"
  RC=1
fi
echo "  续期状态: \$(cat /var/lib/opsmind-acme/renew-status.json 2>/dev/null || echo 无)"
echo "  定时器: \$(systemctl is-active opsmind-cert-renew.timer 2>/dev/null) / \$(systemctl is-enabled opsmind-cert-renew.timer 2>/dev/null)"
echo "  下次触发: \$(systemctl list-timers opsmind-cert-renew.timer --all --no-pager 2>/dev/null | sed -n 2p | awk '{print \$1, \$2, \$3, \$4}')"
exit \${RC:-0}
EOF
}

echo "EvalOS 机 121.40.223.202"
probe | "$HERE/ca-eval.sh" i-bp14ezltpnq8mxic1gsb 90 2>/dev/null | grep -v "^InvokeId" | sed 's/^### exit=\(.*\) status=.*/  （远端退出码 \1）/'
echo
echo "产品机 114.55.40.170"
probe | "$HERE/ca.sh" i-bp12nyanjsyue1vs5bu6 90 2>/dev/null | grep -v "^InvokeId" | sed 's/^### exit=\(.*\) status=.*/  （远端退出码 \1）/'
echo
echo "提示：远端退出码非 0 表示该机有证书问题，按上面的 !! 行处理。"
echo "余额检查是另一个脚本：./check-balance.sh"
