#!/usr/bin/env bash
set -euo pipefail

CONTROLLER_ROOT=/opt/opsmind-twin-controller
RELEASES_ROOT=${CONTROLLER_ROOT}/releases
CURRENT_LINK=${CONTROLLER_ROOT}/current
PREVIOUS_LINK=${CONTROLLER_ROOT}/previous
DATA_ROOT=/srv/opsmind-twin
LEASE_FILE=${DATA_ROOT}/physical-lease.json

fail() {
  echo "OPSMIND_TWIN_CONTROLLER_ERROR: $*" >&2
  exit 2
}

require_root() {
  [[ "$(id -u)" == "0" ]] || fail "controller version management must run as root"
}

release_id_from_link() {
  local link_path="$1"
  [[ -L "$link_path" ]] || return 0
  basename "$(readlink -f "$link_path")"
}

show_status() {
  python3 - "$CURRENT_LINK" "$PREVIOUS_LINK" <<'PY'
import json
from pathlib import Path
import sys

def release(link_name):
    link = Path(link_name)
    if not link.is_symlink():
        return None
    metadata_file = link.resolve() / "RELEASE.json"
    if not metadata_file.is_file():
        return {"release_id": link.resolve().name, "valid": False}
    metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
    return {key: metadata.get(key) for key in (
        "release_id", "source_revision", "content_digest", "component_manifest_digest"
    )} | {"valid": True}

print(json.dumps({"current": release(sys.argv[1]), "previous": release(sys.argv[2])}, separators=(",", ":")))
PY
}

require_idle_lab() {
  [[ -f "$LEASE_FILE" ]] || fail "physical lab lease is missing; recover the lab before changing controller versions"
  python3 - "$LEASE_FILE" <<'PY' || fail "physical lab is not idle; controller version was not changed"
import json
from pathlib import Path
import sys

try:
    lease = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
except (OSError, ValueError):
    raise SystemExit(1)
raise SystemExit(0 if lease.get("status") == "idle" else 1)
PY
}

atomic_link() {
  local target="$1"
  local link_path="$2"
  local temporary_link="${link_path}.new.$$"
  ln -s "$target" "$temporary_link"
  mv -Tf "$temporary_link" "$link_path"
}

ensure_host_prerequisites() {
  install -d -m 0755 -o root -g root "$CONTROLLER_ROOT" "$RELEASES_ROOT"
  install -d -m 0750 -o root -g root /etc/opsmind-twin
  install -d -m 0755 -o root -g root /usr/local/libexec
  install -d -m 0750 -o root -g root "${DATA_ROOT}/config/baseline" "${DATA_ROOT}/config/active"
  install -d -m 0750 -o root -g root "${DATA_ROOT}/trials" "${DATA_ROOT}/pcap" "${DATA_ROOT}/artifacts"

  if ! id -u evalos-twin >/dev/null 2>&1; then
    useradd --system --create-home --shell /bin/bash evalos-twin
  fi
  cat >/etc/sudoers.d/opsmind-twinctl <<'EOF'
evalos-twin ALL=(root) NOPASSWD: /usr/local/sbin/opsmind-twinctl
evalos-twin ALL=(root) NOPASSWD: /usr/local/sbin/opsmind-eval-manager
EOF
  chmod 0440 /etc/sudoers.d/opsmind-twinctl
  visudo -cf /etc/sudoers.d/opsmind-twinctl >/dev/null

  cat >/etc/modules-load.d/opsmind-twin.conf <<'EOF'
tun
sctp
EOF
  modprobe tun
  modprobe sctp

  cat >/etc/sysctl.d/90-opsmind-twin.conf <<'EOF'
net.ipv4.ip_forward=1
EOF
  sysctl --system >/dev/null
}

ensure_live_links() {
  ln -sfnT "${CURRENT_LINK}/opsmind_twinctl.py" /usr/local/sbin/opsmind-twinctl
  ln -sfnT "${CURRENT_LINK}/opsmind_eval_manager.py" /usr/local/sbin/opsmind-eval-manager
  ln -sfnT "${CURRENT_LINK}/ssh_gateway.sh" /usr/local/sbin/opsmind-twin-ssh-gateway
  ln -sfnT "${CURRENT_LINK}/dns_responder.py" /usr/local/libexec/opsmind-twin-dns.py
  ln -sfnT "${CURRENT_LINK}/dns_probe.py" /usr/local/libexec/opsmind-twin-dns-probe.py
  ln -sfnT "${CURRENT_LINK}/stack.manifest.json" /etc/opsmind-twin/stack.manifest.json
  ln -sfnT "${CURRENT_LINK}/config/gnb.yaml" "${DATA_ROOT}/config/baseline/gnb.yaml"
  ln -sfnT "${CURRENT_LINK}/config/ue.yaml" "${DATA_ROOT}/config/baseline/ue.yaml"
  ln -sfnT "${CURRENT_LINK}/install-controller.sh" /usr/local/sbin/opsmind-twin-install-release
}

validate_release() {
  local release_root="$1"
  local expected_release_id="$2"
  python3 - "$release_root" "$expected_release_id" <<'PY'
import hashlib
import json
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])
expected_release_id = sys.argv[2]
metadata = json.loads((root / "RELEASE.json").read_text(encoding="utf-8"))
required = {
    "install-controller.sh", "opsmind_twinctl.py", "opsmind_eval_manager.py",
    "ssh_gateway.sh", "dns_responder.py", "dns_probe.py", "stack.manifest.json",
    "config/gnb.yaml", "config/ue.yaml",
}
if metadata.get("contract") != "opsmind-twin-controller-release/1.0":
    raise SystemExit("unsupported controller release contract")
if metadata.get("release_id") != expected_release_id:
    raise SystemExit("controller release id mismatch")
if not re.fullmatch(r"[a-f0-9]{40}", str(metadata.get("source_revision", ""))):
    raise SystemExit("invalid controller source revision")
if not re.fullmatch(r"sha256:[a-f0-9]{64}", str(metadata.get("content_digest", ""))):
    raise SystemExit("invalid controller content digest")
inventory = metadata.get("files", [])
if not isinstance(inventory, list) or {item.get("path") for item in inventory if isinstance(item, dict)} != required:
    raise SystemExit("controller release file list mismatch")
for item in inventory:
    relative = item.get("path", "")
    if not relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise SystemExit("invalid controller release path")
    payload = root / relative
    if not payload.is_file():
        raise SystemExit(f"controller release file missing: {relative}")
    actual = hashlib.sha256(payload.read_bytes()).hexdigest()
    if actual != item.get("sha256"):
        raise SystemExit(f"controller release file digest mismatch: {relative}")
canonical = json.dumps(inventory, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
if metadata.get("content_digest") != "sha256:" + hashlib.sha256(canonical).hexdigest():
    raise SystemExit("controller release content digest mismatch")
manifest_digest = "sha256:" + hashlib.sha256((root / "stack.manifest.json").read_bytes()).hexdigest()
if metadata.get("component_manifest_digest") != manifest_digest:
    raise SystemExit("controller component manifest digest mismatch")
PY
}

install_release() {
  local archive="${1:?archive path is required}"
  local expected_release_id="${2:?release id is required}"
  local expected_archive_sha256="${3:?archive sha256 is required}"
  [[ "$expected_release_id" =~ ^twin-controller-[0-9]{8}-[a-f0-9]{10}$ ]] || fail "invalid release id"
  [[ "$expected_archive_sha256" =~ ^[a-f0-9]{64}$ ]] || fail "invalid archive sha256"
  [[ -f "$archive" ]] || fail "release archive not found"
  [[ "$(sha256sum "$archive" | awk '{print $1}')" == "$expected_archive_sha256" ]] || fail "release archive checksum mismatch"
  require_idle_lab
  ensure_host_prerequisites

  local staging
  staging="$(mktemp -d "${CONTROLLER_ROOT}/staging.XXXXXX")"
  tar -xzf "$archive" -C "$staging" --no-same-owner
  [[ -d "$staging/controller" ]] || fail "controller payload is missing"
  validate_release "$staging/controller" "$expected_release_id"

  local release_root="${RELEASES_ROOT}/${expected_release_id}"
  if [[ -e "$release_root" ]]; then
    validate_release "$release_root" "$expected_release_id"
  else
    mv "$staging/controller" "$release_root"
  fi
  rm -rf -- "$staging"
  chmod 0750 "$release_root/opsmind_twinctl.py" "$release_root/opsmind_eval_manager.py"
  chmod 0755 "$release_root/ssh_gateway.sh" "$release_root/install-controller.sh"
  chmod 0750 "$release_root/dns_responder.py" "$release_root/dns_probe.py"
  chmod 0640 "$release_root/stack.manifest.json" "$release_root/config/gnb.yaml" "$release_root/config/ue.yaml"

  local old_current
  old_current="$(release_id_from_link "$CURRENT_LINK")"
  if [[ -n "$old_current" && "$old_current" != "$expected_release_id" ]]; then
    atomic_link "${RELEASES_ROOT}/${old_current}" "$PREVIOUS_LINK"
  fi
  atomic_link "$release_root" "$CURRENT_LINK"
  ensure_live_links
  echo "OPSMIND_TWIN_CONTROLLER_INSTALLED ${expected_release_id}"
  show_status
}

rollback_release() {
  require_idle_lab
  [[ -L "$CURRENT_LINK" && -L "$PREVIOUS_LINK" ]] || fail "both current and previous controller versions are required"
  local old_current old_previous
  old_current="$(readlink -f "$CURRENT_LINK")"
  old_previous="$(readlink -f "$PREVIOUS_LINK")"
  [[ -f "$old_current/RELEASE.json" && -f "$old_previous/RELEASE.json" ]] || fail "controller rollback metadata is incomplete"
  atomic_link "$old_current" "$PREVIOUS_LINK"
  if ! atomic_link "$old_previous" "$CURRENT_LINK"; then
    atomic_link "$old_previous" "$PREVIOUS_LINK"
    fail "controller rollback could not switch current version"
  fi
  ensure_live_links
  echo "OPSMIND_TWIN_CONTROLLER_ROLLED_BACK $(basename "$old_previous")"
  show_status
}

require_root
case "${1:-}" in
  status)
    show_status
    ;;
  install)
    [[ "$#" == 4 ]] || fail "usage: $0 install <archive> <release-id> <archive-sha256>"
    install_release "$2" "$3" "$4"
    ;;
  rollback)
    [[ "$#" == 1 ]] || fail "usage: $0 rollback"
    rollback_release
    ;;
  *)
    fail "usage: $0 status | install <archive> <release-id> <archive-sha256> | rollback"
    ;;
esac
