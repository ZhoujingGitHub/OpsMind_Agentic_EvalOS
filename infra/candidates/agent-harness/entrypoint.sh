#!/bin/sh
set -eu

read_secret() {
  variable="$1"
  path="$2"
  if [ ! -s "$path" ]; then
    echo "required secret is unavailable: $path" >&2
    exit 78
  fi
  value="$(cat "$path")"
  export "$variable=$value"
  unset value
}

read_secret ANTHROPIC_AUTH_TOKEN /run/secrets/deepseek_api_key
read_secret OPSMIND_MYSQL_PASSWORD /run/secrets/mysql_password
read_secret OPSMIND_REDIS_PASSWORD /run/secrets/redis_password
read_secret OPSMIND_ACTION_CONTROL_SECRET /run/secrets/action_control_secret
read_secret OPSMIND_PROTOCOL_LAB_BINDING_SECRET /run/secrets/protocol_lab_binding_secret

claude_state_dir="${CLAUDE_CONFIG_DIR:-/home/opsmind/.claude}"
mkdir -p "$claude_state_dir"
if [ ! -w "$claude_state_dir" ]; then
  echo "Claude Agent SDK resumable session directory is not writable: $claude_state_dir" >&2
  exit 78
fi
export CLAUDE_CONFIG_DIR="$claude_state_dir"
unset claude_state_dir

case "${OPSMIND_PROTOCOL_LAB_ENABLED:-false}" in
  1|true|TRUE|yes|YES|on|ON)
    command -v ssh >/dev/null 2>&1 || {
      echo "protocol-lab transport is unavailable: ssh client is missing" >&2
      exit 78
    }
    for path in \
      /run/secrets/protocol_lab_known_hosts \
      /run/secrets/protocol_lab_control_key \
      /run/secrets/protocol_lab_observer_key \
      /run/secrets/protocol_lab_action_key \
      /run/secrets/protocol_lab_verifier_key
    do
      if [ ! -r "$path" ] || [ ! -s "$path" ]; then
        echo "protocol-lab identity is unavailable: $path" >&2
        exit 78
      fi
    done
    ;;
esac

exec python -m uvicorn opsmind_agent.main:app \
  --app-dir /app/services/agent-service/src \
  --host 127.0.0.1 \
  --port 8000 \
  --no-access-log
