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

exec python -m uvicorn opsmind_agent.main:app \
  --app-dir /app/services/agent-service/src \
  --host 127.0.0.1 \
  --port 8000 \
  --no-access-log
