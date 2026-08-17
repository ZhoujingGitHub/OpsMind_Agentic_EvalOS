#!/usr/bin/env bash
set -euo pipefail

DOMAIN="121-40-223-202.sslip.io"
ACME_HOME="/var/lib/opsmind-acme"
CERT_DIR="/etc/nginx/ssl/opsmind-evalos"

restore_nginx() {
  systemctl start nginx
}
trap restore_nginx EXIT

systemctl stop nginx
/opt/acme-sh/acme.sh \
  --home "${ACME_HOME}" \
  --config-home "${ACME_HOME}" \
  --server letsencrypt \
  --cron

/opt/acme-sh/acme.sh \
  --home "${ACME_HOME}" \
  --config-home "${ACME_HOME}" \
  --install-cert \
  -d "${DOMAIN}" \
  --ecc \
  --key-file "${CERT_DIR}/privkey.pem" \
  --fullchain-file "${CERT_DIR}/fullchain.pem" \
  --reloadcmd true

nginx -t
