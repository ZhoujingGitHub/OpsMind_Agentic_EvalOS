#!/usr/bin/env bash
# Renew an OpsMind console certificate with acme.sh over TLS-ALPN-01.
# One script, both machines. Per-host settings live in /etc/opsmind-cert-renew.conf:
#
#   DOMAINS="lg.114-55-40-170.sslip.io ah.114-55-40-170.sslip.io"
#   CERT_DIR=/etc/nginx/ssl/opsmind-product
#
# Two things the original per-release script did not do, and why they matter:
#
#   1. It stopped nginx on every run. A daily timer would then take the console
#      -- and on the EvalOS host the relay that carries chains 3 and 4 -- down
#      once a day for nothing. This version reads acme.sh's own next-renewal
#      time and leaves nginx alone until a renewal is actually due.
#
#   2. It had no failure signal. sslip.io is NOT on the Public Suffix List
#      (checked against publicsuffix.org: 16477 lines, no "sslip"), so every
#      *.sslip.io holder in the world shares one Let's Encrypt registered-domain
#      quota and a renewal can legitimately fail. A timer that fails silently is
#      no better than no timer: it just moves the surprise to the expiry date.
#      So a failure leaves a marker file, a loud journal line, and a non-zero
#      exit that systemd records.
#
# Idempotent. Safe to run any number of times. `--force` renews regardless.
set -uo pipefail

CONF=/etc/opsmind-cert-renew.conf
ACME_HOME=/var/lib/opsmind-acme
ACME=/opt/acme-sh/acme.sh
FORCE="${1:-}"

[ -r "$CONF" ] || { echo "opsmind-cert-renew: missing $CONF" >&2; exit 78; }
# shellcheck source=/dev/null
. "$CONF"
: "${DOMAINS:?DOMAINS not set in $CONF}"
: "${CERT_DIR:?CERT_DIR not set in $CONF}"

PRIMARY=${DOMAINS%% *}
STATUS="${ACME_HOME}/renew-status.json"
FAILED="${ACME_HOME}/RENEW_FAILED"

log() { echo "opsmind-cert-renew: $*"; }

write_status() {
  local code="$1" action="$2" not_after
  not_after=$(openssl x509 -in "${CERT_DIR}/fullchain.pem" -noout -enddate 2>/dev/null | cut -d= -f2)
  printf '{"checked_at":"%s","exit_code":%s,"action":"%s","not_after":"%s","primary_domain":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" "$action" "${not_after:-unknown}" "$PRIMARY" > "$STATUS"
}

renewal_due() {
  local conf next now
  conf="${ACME_HOME}/${PRIMARY}_ecc/${PRIMARY}.conf"
  [ -r "$conf" ] || return 0            # unknown state: let acme.sh decide
  next=$(sed -n "s/^Le_NextRenewTime='\([0-9]*\)'.*/\1/p" "$conf" | head -1)
  [ -n "$next" ] || return 0
  now=$(date -u +%s)
  [ "$now" -ge "$next" ]
}

if [ "$FORCE" != "--force" ] && ! renewal_due; then
  log "not due yet; nginx untouched"
  write_status 0 "skipped-not-due"
  rm -f "$FAILED"
  exit 0
fi

log "renewal due for ${DOMAINS}; taking nginx down so acme.sh can own 443"
restore_nginx() { systemctl start nginx >/dev/null 2>&1 || true; }
trap restore_nginx EXIT

rc=0
systemctl stop nginx || rc=$?
if [ "$rc" -eq 0 ]; then
  "$ACME" --home "$ACME_HOME" --config-home "$ACME_HOME" --server letsencrypt --cron || rc=$?
fi
if [ "$rc" -eq 0 ]; then
  "$ACME" --home "$ACME_HOME" --config-home "$ACME_HOME" --install-cert -d "$PRIMARY" --ecc \
    --key-file "${CERT_DIR}/privkey.pem" --fullchain-file "${CERT_DIR}/fullchain.pem" \
    --reloadcmd true || rc=$?
fi

trap - EXIT
restore_nginx
nginx -t >/dev/null 2>&1 || rc=${rc:-1}

if [ "$rc" -ne 0 ]; then
  log "RENEWAL FAILED rc=$rc for ${DOMAINS}. Certificate expires $(openssl x509 -in "${CERT_DIR}/fullchain.pem" -noout -enddate 2>/dev/null | cut -d= -f2). On the EvalOS host the relay verifies this certificate, so expiry breaks chains 3 and 4. sslip.io shares one Let's Encrypt quota globally -- check rate limits, then consider --server zerossl or buypass."
  date -u +%Y-%m-%dT%H:%M:%SZ > "$FAILED"
  write_status "$rc" "failed"
  exit "$rc"
fi

log "renewal ok for ${DOMAINS}"
rm -f "$FAILED"
write_status 0 "renewed"
