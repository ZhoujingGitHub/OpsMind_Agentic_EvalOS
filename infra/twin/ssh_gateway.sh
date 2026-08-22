#!/usr/bin/env sh
set -eu

base_prefix='sudo /usr/local/sbin/opsmind-twinctl request '
manager_prefix='sudo /usr/local/sbin/opsmind-eval-manager request '
case "${SSH_ORIGINAL_COMMAND-}" in
  "$base_prefix"*)
    payload=${SSH_ORIGINAL_COMMAND#"$base_prefix"}
    target=/usr/local/sbin/opsmind-twinctl
    ;;
  "$manager_prefix"*)
    payload=${SSH_ORIGINAL_COMMAND#"$manager_prefix"}
    target=/usr/local/sbin/opsmind-eval-manager
    ;;
  *) printf '%s\n' '{"ok":false,"error":"command denied by Twin SSH gateway"}'; exit 126 ;;
esac

case "$payload" in
  ''|*[!A-Za-z0-9_-]*) printf '%s\n' '{"ok":false,"error":"invalid Twin request encoding"}'; exit 126 ;;
esac

if [ "${#payload}" -gt 32768 ]; then
  printf '%s\n' '{"ok":false,"error":"Twin request too large"}'
  exit 126
fi

exec sudo "$target" request "$payload"
