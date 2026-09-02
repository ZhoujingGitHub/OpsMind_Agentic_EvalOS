#!/usr/bin/env bash
set -Eeuo pipefail
set -f

raw_command="${1:-status}"
read -r -a argv <<< "$raw_command"
command_name="${argv[0]:-status}"

release_pattern='^m31-[0-9]{8}-[a-f0-9]{10}$'
sha_pattern='^[a-f0-9]{64}$'
incoming_root=/var/lib/opsmind-evalos/incoming
current_link=/opt/opsmind-evalos/current
previous_link=/opt/opsmind-evalos/previous
nginx_config=/etc/nginx/sites-available/opsmind-evalos

require_release_id() {
  [[ "${1:-}" =~ $release_pattern ]] || { echo 'invalid release id' >&2; exit 2; }
}

require_sha256() {
  [[ "${1:-}" =~ $sha_pattern ]] || { echo 'invalid sha256' >&2; exit 2; }
}

service_state() {
  systemctl is-active "$1" 2>/dev/null || printf '%s\n' 'inactive'
}

valid_release_path() {
  local candidate="${1:-}"
  [[ "$candidate" =~ ^/opt/opsmind-evalos/releases/m31-[0-9]{8}-[a-f0-9]{10}$ ]]
  [[ -d "$candidate" && -f "$candidate/evalos/RELEASE.json" ]]
  [[ -f "$candidate/evalos/infra/systemd/opsmind-evalos.service" ]]
  [[ -f "$candidate/evalos/infra/systemd/opsmind-evalos-console.service" ]]
  [[ -f "$candidate/evalos/infra/nginx/opsmind-evalos.conf" ]]
  [[ -f "$candidate/evalos/scripts/smoke-m31-deployment.mjs" ]]
}

install_release_config() {
  local target="$1"
  install -m 0644 "$target/evalos/infra/systemd/opsmind-evalos.service" /etc/systemd/system/opsmind-evalos.service
  install -m 0644 "$target/evalos/infra/systemd/opsmind-evalos-console.service" /etc/systemd/system/opsmind-evalos-console.service
  install -m 0644 "$target/evalos/infra/nginx/opsmind-evalos.conf" "$nginx_config"
}

wait_release_ready() {
  local target="$1"
  for attempt in $(seq 1 30); do
    if curl --silent --fail --max-time 5 http://127.0.0.1:8787/ready >/dev/null \
      && curl --silent --fail --max-time 3 http://127.0.0.1:3000/ >/dev/null; then
      EVALOS_SMOKE_ORIGIN=http://127.0.0.1:3000 node "$target/evalos/scripts/smoke-m31-deployment.mjs"
      return
    fi
    [[ "$attempt" -lt 30 ]] || return 1
    sleep 1
  done
}

restore_failed_application_rollback() {
  local exit_code=$?
  if [[ $exit_code -eq 0 ]]; then return; fi
  trap - EXIT
  set +e
  echo 'application rollback failed; restoring the original application release' >&2
  systemctl stop opsmind-evalos-console opsmind-evalos 2>/dev/null || true
  install_release_config "$rollback_original_current" 2>/dev/null || true
  ln -sfn "$rollback_original_current" "${current_link}.restore"
  mv -Tf "${current_link}.restore" "$current_link"
  ln -sfn "$rollback_target" "${previous_link}.restore"
  mv -Tf "${previous_link}.restore" "$previous_link"
  systemctl daemon-reload 2>/dev/null || true
  systemctl start opsmind-evalos opsmind-evalos-console 2>/dev/null || true
  nginx -t >/dev/null 2>&1 && systemctl reload nginx 2>/dev/null || true
  exit "$exit_code"
}

case "$command_name" in
  status)
    [[ "${#argv[@]}" -eq 1 ]] || { echo 'status takes no arguments' >&2; exit 2; }
    printf '%s\n' 'management_contract=opsmind-fixed-management/1.1'
    printf 'wireguard=%s\n' "$(service_state wg-quick@wg-opsmind.service)"
    printf 'evalos_api=%s\n' "$(service_state opsmind-evalos.service)"
    printf 'evalos_console=%s\n' "$(service_state opsmind-evalos-console.service)"
    if curl --silent --fail --max-time 3 http://127.0.0.1:8787/ready >/dev/null; then
      printf '%s\n' 'evalos_ready=true'
    else
      printf '%s\n' 'evalos_ready=false'
    fi
    if curl --silent --fail --max-time 3 http://127.0.0.1:3000/ >/dev/null; then
      printf '%s\n' 'console_ready=true'
    else
      printf '%s\n' 'console_ready=false'
    fi
    current_release=""
    previous_release=""
    [[ -L "$current_link" ]] && current_release="$(readlink -f "$current_link")"
    [[ -L "$previous_link" ]] && previous_release="$(readlink -f "$previous_link")"
    printf 'current_release=%s\n' "${current_release##*/}"
    printf 'previous_release=%s\n' "${previous_release##*/}"
    printf 'available_bytes='; df -PB1 /opt/opsmind-evalos | awk 'NR == 2 { print $4 }'
    ;;
  upload)
    [[ "${#argv[@]}" -eq 5 ]] || { echo 'usage: upload RELEASE SHA256 BYTES BASE64_BYTES' >&2; exit 2; }
    release_id="${argv[1]}"
    expected_sha256="${argv[2]}"
    expected_bytes="${argv[3]}"
    expected_base64_bytes="${argv[4]}"
    require_release_id "$release_id"
    require_sha256 "$expected_sha256"
    [[ "$expected_bytes" =~ ^[1-9][0-9]{0,8}$ ]] || { echo 'invalid byte count' >&2; exit 2; }
    (( expected_bytes <= 536870912 )) || { echo 'archive exceeds 512 MiB safety limit' >&2; exit 2; }
    [[ "$expected_base64_bytes" =~ ^[1-9][0-9]{0,9}$ ]] || { echo 'invalid base64 byte count' >&2; exit 2; }
    calculated_base64_bytes=$(( ((expected_bytes + 2) / 3) * 4 ))
    [[ "$expected_base64_bytes" -eq "$calculated_base64_bytes" ]] || {
      echo 'base64 byte count does not match archive byte count' >&2
      exit 2
    }
    install -d -o root -g root -m 0700 "$incoming_root"
    tmp_file="$(mktemp "$incoming_root/.${release_id}.XXXXXX")"
    tmp_base64="$(mktemp "$incoming_root/.${release_id}.base64.XXXXXX")"
    trap 'rm -f -- "$tmp_file" "$tmp_base64"' EXIT
    timeout --signal=TERM 600s head -c "$expected_base64_bytes" > "$tmp_base64"
    actual_base64_bytes="$(stat -c '%s' "$tmp_base64")"
    [[ "$actual_base64_bytes" == "$expected_base64_bytes" ]] || {
      echo 'base64 byte count mismatch' >&2
      exit 2
    }
    base64 --decode "$tmp_base64" > "$tmp_file"
    actual_bytes="$(stat -c '%s' "$tmp_file")"
    [[ "$actual_bytes" == "$expected_bytes" ]] || { echo 'archive byte count mismatch' >&2; exit 2; }
    actual_sha256="$(sha256sum "$tmp_file" | awk '{print $1}')"
    [[ "$actual_sha256" == "$expected_sha256" ]] || { echo 'archive checksum mismatch' >&2; exit 2; }
    chmod 0600 "$tmp_file"
    mv -f "$tmp_file" "$incoming_root/$release_id.tar.gz"
    rm -f -- "$tmp_base64"
    trap - EXIT
    printf 'uploaded_release=%s\n' "$release_id"
    printf 'sha256=%s\n' "$actual_sha256"
    ;;
  deploy)
    [[ "${#argv[@]}" -eq 3 ]] || { echo 'usage: deploy RELEASE SHA256' >&2; exit 2; }
    release_id="${argv[1]}"
    expected_sha256="${argv[2]}"
    require_release_id "$release_id"
    require_sha256 "$expected_sha256"
    archive="$incoming_root/$release_id.tar.gz"
    [[ -f "$archive" ]] || { echo 'uploaded archive not found' >&2; exit 2; }
    actual_sha256="$(sha256sum "$archive" | awk '{print $1}')"
    [[ "$actual_sha256" == "$expected_sha256" ]] || { echo 'archive checksum mismatch' >&2; exit 2; }
    exec /usr/local/sbin/opsmind-evalos-install-release "$archive" "$release_id" "$expected_sha256"
    ;;
  rollback)
    [[ "${#argv[@]}" -eq 1 ]] || { echo 'rollback takes no arguments' >&2; exit 2; }
    [[ -L "$current_link" ]] || { echo 'current release pointer is missing' >&2; exit 2; }
    [[ -L "$previous_link" ]] || { echo 'previous release pointer is missing' >&2; exit 2; }
    rollback_original_current="$(readlink -f "$current_link")"
    rollback_target="$(readlink -f "$previous_link")"
    valid_release_path "$rollback_original_current" || { echo 'current release is not valid' >&2; exit 2; }
    valid_release_path "$rollback_target" || { echo 'previous release is not valid' >&2; exit 2; }
    [[ "$rollback_original_current" != "$rollback_target" ]] || { echo 'current and previous releases are identical' >&2; exit 2; }
    trap restore_failed_application_rollback EXIT
    systemctl stop opsmind-evalos-console opsmind-evalos
    install_release_config "$rollback_target"
    nginx -t
    ln -sfn "$rollback_target" "${current_link}.next"
    mv -Tf "${current_link}.next" "$current_link"
    ln -sfn "$rollback_original_current" "${previous_link}.next"
    mv -Tf "${previous_link}.next" "$previous_link"
    systemctl daemon-reload
    systemctl start opsmind-evalos opsmind-evalos-console
    systemctl reload nginx
    wait_release_ready "$rollback_target"
    systemctl is-active --quiet opsmind-evalos opsmind-evalos-console nginx
    trap - EXIT
    printf 'current_release=%s\n' "${rollback_target##*/}"
    printf 'previous_release=%s\n' "${rollback_original_current##*/}"
    printf '%s\n' 'database_action=none'
    ;;
  *)
    echo 'command not allowed' >&2
    exit 126
    ;;
esac
