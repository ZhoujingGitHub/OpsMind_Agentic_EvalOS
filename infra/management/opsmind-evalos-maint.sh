#!/usr/bin/env bash
set -Eeuo pipefail
set -f

raw_command="${1:-status}"
read -r -a argv <<< "$raw_command"
command_name="${argv[0]:-status}"

release_pattern='^m31-[0-9]{8}-[a-f0-9]{10}$'
sha_pattern='^[a-f0-9]{64}$'
incoming_root=/var/lib/opsmind-evalos/incoming

require_release_id() {
  [[ "${1:-}" =~ $release_pattern ]] || { echo 'invalid release id' >&2; exit 2; }
}

require_sha256() {
  [[ "${1:-}" =~ $sha_pattern ]] || { echo 'invalid sha256' >&2; exit 2; }
}

service_state() {
  systemctl is-active "$1" 2>/dev/null || printf '%s\n' 'inactive'
}

case "$command_name" in
  status)
    [[ "${#argv[@]}" -eq 1 ]] || { echo 'status takes no arguments' >&2; exit 2; }
    printf '%s\n' 'management_contract=opsmind-fixed-management/1.0'
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
    current_release="$(readlink -f /opt/opsmind-evalos/current 2>/dev/null || true)"
    printf 'current_release=%s\n' "${current_release##*/}"
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
  *)
    echo 'command not allowed' >&2
    exit 126
    ;;
esac
