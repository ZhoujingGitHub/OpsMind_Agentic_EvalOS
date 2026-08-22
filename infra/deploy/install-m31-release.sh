#!/usr/bin/env bash
set -Eeuo pipefail

archive="${1:?archive path is required}"
release_id="${2:?release id is required}"
expected_sha256="${3:?archive sha256 is required}"

[[ "$release_id" =~ ^m31-[0-9]{8}-[a-f0-9]{10}$ ]] || { echo "invalid release id" >&2; exit 2; }
[[ -f "$archive" ]] || { echo "archive not found" >&2; exit 2; }
actual_sha256="$(sha256sum "$archive" | awk '{print $1}')"
[[ "$actual_sha256" == "$expected_sha256" ]] || { echo "archive checksum mismatch" >&2; exit 2; }

release_root="/opt/opsmind-evalos/releases/$release_id"
current_link="/opt/opsmind-evalos/current"
previous_release="$(readlink -f "$current_link" || true)"
backup_root="/var/lib/opsmind-evalos/backups/$release_id"
unit_backup="/var/lib/opsmind-evalos/backups/$release_id/systemd"
rollback() {
  local exit_code=$?
  if [[ $exit_code -eq 0 ]]; then return; fi
  trap - EXIT
  set +e
  echo "deployment failed; restoring previous EvalOS release" >&2
  systemctl stop opsmind-evalos-console opsmind-evalos 2>/dev/null || true
  if [[ -n "$previous_release" && -d "$previous_release" ]]; then
    ln -sfn "$previous_release" "${current_link}.rollback"
    mv -Tf "${current_link}.rollback" "$current_link"
  fi
  if [[ -d "$unit_backup" ]]; then
    cp -f "$unit_backup/opsmind-evalos.service" /etc/systemd/system/opsmind-evalos.service 2>/dev/null || true
    cp -f "$unit_backup/opsmind-evalos-console.service" /etc/systemd/system/opsmind-evalos-console.service 2>/dev/null || true
  fi
  systemctl daemon-reload 2>/dev/null || true
  systemctl start opsmind-evalos opsmind-evalos-console 2>/dev/null || true
  exit "$exit_code"
}
trap rollback EXIT

[[ ! -e "$release_root" ]] || { echo "release already exists: $release_root" >&2; exit 2; }
mkdir -p "$release_root"
tar -xzf "$archive" -C "$release_root"
test -f "$release_root/evalos/RELEASE.json"
grep -q '"includes_external_candidate_source": false' "$release_root/evalos/RELEASE.json"
grep -q '"formal_480_enabled": false' "$release_root/evalos/RELEASE.json"

npm --prefix "$release_root/evalos/packages/agent-runtime" ci --omit=dev --ignore-scripts
chown -R root:root "$release_root"
chmod -R a+rX "$release_root"

mkdir -p "$backup_root/control" "$backup_root/private" "$unit_backup"
cp -f /etc/systemd/system/opsmind-evalos.service "$unit_backup/opsmind-evalos.service"
cp -f /etc/systemd/system/opsmind-evalos-console.service "$unit_backup/opsmind-evalos-console.service"

systemctl stop opsmind-evalos-console opsmind-evalos
for file in /var/lib/opsmind-evalos/control/control.sqlite*; do [[ -e "$file" ]] && cp -a "$file" "$backup_root/control/"; done
for file in /var/lib/opsmind-evalos/private/labels.sqlite*; do [[ -e "$file" ]] && cp -a "$file" "$backup_root/private/"; done

install -m 0644 "$release_root/evalos/infra/systemd/opsmind-evalos.service" /etc/systemd/system/opsmind-evalos.service
install -m 0644 "$release_root/evalos/infra/systemd/opsmind-evalos-console.service" /etc/systemd/system/opsmind-evalos-console.service
ln -sfn "$release_root" "${current_link}.next"
mv -Tf "${current_link}.next" "$current_link"
systemctl daemon-reload
systemctl start opsmind-evalos opsmind-evalos-console
for attempt in $(seq 1 30); do
  if curl --silent --fail --max-time 3 http://127.0.0.1:8787/health >/dev/null \
    && curl --silent --fail --max-time 3 http://127.0.0.1:3000/ >/dev/null; then break; fi
  [[ "$attempt" -lt 30 ]] || { journalctl -u opsmind-evalos -u opsmind-evalos-console -n 120 --no-pager >&2; exit 1; }
  sleep 1
done

EVALOS_SMOKE_ORIGIN=http://127.0.0.1:3000 node "$release_root/evalos/scripts/smoke-m31-deployment.mjs"
systemctl is-active --quiet opsmind-evalos opsmind-evalos-console nginx
trap - EXIT
echo "EvalOS $release_id deployed successfully"
