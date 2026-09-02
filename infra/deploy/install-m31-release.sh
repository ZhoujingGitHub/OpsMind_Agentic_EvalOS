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
previous_link="/opt/opsmind-evalos/previous"
previous_release="$(readlink -f "$current_link" || true)"
backups_root="/var/lib/opsmind-evalos/backups"
backup_root="$backups_root/$release_id"
unit_backup="/var/lib/opsmind-evalos/backups/$release_id/systemd"
nginx_config=/etc/nginx/sites-available/opsmind-evalos
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
    if [[ -f "$unit_backup/opsmind-evalos.conf" ]]; then
      cp -f "$unit_backup/opsmind-evalos.conf" "$nginx_config" 2>/dev/null || true
    fi
  fi
  if [[ -f "$backup_root/control/control.sqlite" ]]; then
    rm -f /var/lib/opsmind-evalos/control/control.sqlite*
    cp -a "$backup_root/control/." /var/lib/opsmind-evalos/control/
    chown -R opsmindeval:opsmindeval /var/lib/opsmind-evalos/control
  fi
  if [[ -f "$backup_root/private/labels.sqlite" ]]; then
    rm -f /var/lib/opsmind-evalos/private/labels.sqlite*
    cp -a "$backup_root/private/." /var/lib/opsmind-evalos/private/
    chown -R opsmindeval:opsmindeval /var/lib/opsmind-evalos/private
  fi
  systemctl daemon-reload 2>/dev/null || true
  systemctl start opsmind-evalos opsmind-evalos-console 2>/dev/null || true
  nginx -t >/dev/null 2>&1 && systemctl reload nginx 2>/dev/null || true
  exit "$exit_code"
}
trap rollback EXIT

[[ ! -e "$release_root" ]] || { echo "release already exists: $release_root" >&2; exit 2; }

# 全量 SQLite 备份只保留最近一代；本次成功后合计两代。防止连续发布把系统盘写满。
mkdir -p "$backups_root"
mapfile -t previous_backups < <(find "$backups_root" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -rn | cut -d' ' -f2-)
for ((index = 1; index < ${#previous_backups[@]}; index += 1)); do
  stale_backup="${previous_backups[$index]}"
  [[ "$stale_backup" == "$backups_root/"* ]] || { echo "refusing unsafe backup removal: $stale_backup" >&2; exit 2; }
  rm -rf -- "$stale_backup"
done

database_bytes="$(du -sb /var/lib/opsmind-evalos/control /var/lib/opsmind-evalos/private 2>/dev/null \
  | awk '{ total += $1 } END { print total + 0 }')"
available_bytes="$(df -PB1 /var/lib/opsmind-evalos | awk 'NR == 2 { print $4 }')"
reserve_bytes=$((1024 * 1024 * 1024))
required_bytes=$((database_bytes + reserve_bytes))
[[ "$available_bytes" -ge "$required_bytes" ]] || {
  echo "insufficient disk space for an atomic database backup: available=$available_bytes required=$required_bytes" >&2
  exit 2
}

mkdir -p "$release_root"
tar -xzf "$archive" -C "$release_root"
test -f "$release_root/evalos/RELEASE.json"
test -f "$release_root/evalos/config/candidate-presence-public-keys.json"
grep -q '"contract": "evalos-release.2"' "$release_root/evalos/RELEASE.json"
grep -q "\"release_id\": \"$release_id\"" "$release_root/evalos/RELEASE.json"
grep -Eq '"source_revision": "[a-f0-9]{40}"' "$release_root/evalos/RELEASE.json"
grep -Eq '"content_digest": "sha256:[a-f0-9]{64}"' "$release_root/evalos/RELEASE.json"
grep -q '"includes_external_candidate_source": false' "$release_root/evalos/RELEASE.json"
grep -q '"formal_480_enabled": false' "$release_root/evalos/RELEASE.json"

# 发布安装只解析冻结 lockfile，不在切换窗口做联网审计或募资查询。
# prefer-offline 会优先复用服务器已有 npm 缓存；硬超时确保云助手超时后
# 不会遗留脱离控制面的 npm 进程。
timeout --kill-after=15s 180s npm --prefix "$release_root/evalos/packages/agent-runtime" ci \
  --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline \
  --fetch-timeout=60000 --fetch-retries=2
chown -R root:root "$release_root"
chmod -R a+rX "$release_root"

mkdir -p "$backup_root/control" "$backup_root/private" "$unit_backup"
cp -f /etc/systemd/system/opsmind-evalos.service "$unit_backup/opsmind-evalos.service"
cp -f /etc/systemd/system/opsmind-evalos-console.service "$unit_backup/opsmind-evalos-console.service"
cp -f "$nginx_config" "$unit_backup/opsmind-evalos.conf"

systemctl stop opsmind-evalos-console opsmind-evalos
for file in /var/lib/opsmind-evalos/control/control.sqlite*; do [[ -e "$file" ]] && cp -a "$file" "$backup_root/control/"; done
for file in /var/lib/opsmind-evalos/private/labels.sqlite*; do [[ -e "$file" ]] && cp -a "$file" "$backup_root/private/"; done

install -m 0644 "$release_root/evalos/infra/systemd/opsmind-evalos.service" /etc/systemd/system/opsmind-evalos.service
install -m 0644 "$release_root/evalos/infra/systemd/opsmind-evalos-console.service" /etc/systemd/system/opsmind-evalos-console.service
install -m 0644 "$release_root/evalos/infra/nginx/opsmind-evalos.conf" "$nginx_config"
nginx -t
ln -sfn "$release_root" "${current_link}.next"
mv -Tf "${current_link}.next" "$current_link"
systemctl daemon-reload
systemctl start opsmind-evalos opsmind-evalos-console
systemctl reload nginx
for attempt in $(seq 1 30); do
  if curl --silent --fail --max-time 5 http://127.0.0.1:8787/ready >/dev/null \
    && curl --silent --fail --max-time 3 http://127.0.0.1:3000/ >/dev/null; then break; fi
  [[ "$attempt" -lt 30 ]] || { journalctl -u opsmind-evalos -u opsmind-evalos-console -n 120 --no-pager >&2; exit 1; }
  sleep 1
done

EVALOS_SMOKE_ORIGIN=http://127.0.0.1:3000 node "$release_root/evalos/scripts/smoke-m31-deployment.mjs"
systemctl is-active --quiet opsmind-evalos opsmind-evalos-console nginx
if [[ -n "$previous_release" && -d "$previous_release" && "$previous_release" != "$release_root" ]]; then
  ln -sfn "$previous_release" "${previous_link}.next"
  mv -Tf "${previous_link}.next" "$previous_link"
fi
trap - EXIT
echo "EvalOS $release_id deployed successfully"
