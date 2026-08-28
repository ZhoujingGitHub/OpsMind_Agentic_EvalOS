#!/usr/bin/env sh
set -eu

# LangGraph sends its configured protocol-lab command, but this forced-command
# boundary always routes the encoded request to the candidate-only gateway.
prefix='/usr/local/sbin/opsmind-twinctl request '
case "${SSH_ORIGINAL_COMMAND-}" in
  "$prefix"*) payload=${SSH_ORIGINAL_COMMAND#"$prefix"} ;;
  *) printf '%s\n' '{"ok":false,"operation":"unknown","error":{"code":"IDENTITY_DENIED","message":"candidate observation command denied"}}'; exit 126 ;;
esac

case "$payload" in
  ''|*[!A-Za-z0-9_-]*) printf '%s\n' '{"ok":false,"operation":"unknown","error":{"code":"REQUEST_INVALID","message":"candidate observation encoding invalid"}}'; exit 126 ;;
esac
if [ "${#payload}" -gt 32768 ]; then
  printf '%s\n' '{"ok":false,"operation":"unknown","error":{"code":"REQUEST_TOO_LARGE","message":"candidate observation request too large"}}'
  exit 126
fi

exec sudo /usr/local/sbin/opsmind-candidate-observation-gateway request langgraph-v1 "$payload"
