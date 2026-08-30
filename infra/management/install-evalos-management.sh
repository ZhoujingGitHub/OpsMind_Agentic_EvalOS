#!/usr/bin/env bash
set -Eeuo pipefail

public_key="${1:?public key is required}"
source_address="${2:-10.77.240.2/32}"
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_root/../.." && pwd)"

[[ "$public_key" =~ ^ssh-ed25519[[:space:]][A-Za-z0-9+/=]+[[:space:]][A-Za-z0-9._-]+$ ]] || {
  echo 'invalid Ed25519 public key' >&2
  exit 2
}
[[ "$source_address" == '10.77.240.2/32' ]] || { echo 'unexpected management source' >&2; exit 2; }

if ! id opsmind-maint >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/opsmind-maint --shell /bin/sh opsmind-maint
fi

install -o root -g root -m 0755 "$script_root/opsmind-maint-entry.sh" /usr/local/bin/opsmind-maint-entry
install -o root -g root -m 0755 "$script_root/opsmind-evalos-maint.sh" /usr/local/sbin/opsmind-evalos-maint
install -o root -g root -m 0755 "$repo_root/infra/deploy/install-m31-release.sh" /usr/local/sbin/opsmind-evalos-install-release

home_dir="$(getent passwd opsmind-maint | cut -d: -f6)"
install -d -o opsmind-maint -g opsmind-maint -m 0700 "$home_dir/.ssh"
printf 'restrict,from="%s",command="/usr/local/bin/opsmind-maint-entry" %s\n' "$source_address" "$public_key" \
  > "$home_dir/.ssh/authorized_keys"
chown opsmind-maint:opsmind-maint "$home_dir/.ssh/authorized_keys"
chmod 0600 "$home_dir/.ssh/authorized_keys"

printf '%s\n' 'opsmind-maint ALL=(root) NOPASSWD: /usr/local/sbin/opsmind-evalos-maint *' \
  > /etc/sudoers.d/opsmind-evalos-maint
chown root:root /etc/sudoers.d/opsmind-evalos-maint
chmod 0440 /etc/sudoers.d/opsmind-evalos-maint
visudo -cf /etc/sudoers.d/opsmind-evalos-maint >/dev/null

sshd -t
systemctl reload ssh.service

printf '%s\n' 'management_contract=opsmind-fixed-management/1.0'
printf '%s\n' 'management_user=opsmind-maint'
printf '%s\n' 'source_restriction=10.77.240.2/32'
