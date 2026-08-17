#!/usr/bin/env sh
set -eu

prefix='sudo /usr/local/sbin/opsmind-twinctl request '
case "${SSH_ORIGINAL_COMMAND-}" in
  "$prefix"*) payload=${SSH_ORIGINAL_COMMAND#"$prefix"} ;;
  *) printf '%s\n' '{"ok":false,"error":"command denied by Twin SSH gateway"}'; exit 126 ;;
esac

case "$payload" in
  ''|*[!A-Za-z0-9_-]*) printf '%s\n' '{"ok":false,"error":"invalid Twin request encoding"}'; exit 126 ;;
esac

if [ "${#payload}" -gt 32768 ]; then
  printf '%s\n' '{"ok":false,"error":"Twin request too large"}'
  exit 126
fi

exec sudo /usr/local/sbin/opsmind-twinctl request "$payload"
