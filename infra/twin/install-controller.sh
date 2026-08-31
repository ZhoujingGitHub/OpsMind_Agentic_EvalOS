#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT=${1:?usage: install-controller.sh <repository-infra-twin-path>}
DATA_ROOT=/srv/opsmind-twin

install -d -m 0750 -o root -g root /etc/opsmind-twin
install -d -m 0755 -o root -g root /usr/local/libexec
install -d -m 0750 -o root -g root "${DATA_ROOT}/config/baseline" "${DATA_ROOT}/config/active"
install -d -m 0750 -o root -g root "${DATA_ROOT}/trials" "${DATA_ROOT}/pcap" "${DATA_ROOT}/artifacts"
install -m 0750 -o root -g root "${SOURCE_ROOT}/opsmind_twinctl.py" /usr/local/sbin/opsmind-twinctl
install -m 0750 -o root -g root "${SOURCE_ROOT}/opsmind_eval_manager.py" /usr/local/sbin/opsmind-eval-manager
install -m 0755 -o root -g root "${SOURCE_ROOT}/ssh_gateway.sh" /usr/local/sbin/opsmind-twin-ssh-gateway
install -m 0750 -o root -g root "${SOURCE_ROOT}/dns_responder.py" /usr/local/libexec/opsmind-twin-dns.py
install -m 0750 -o root -g root "${SOURCE_ROOT}/dns_probe.py" /usr/local/libexec/opsmind-twin-dns-probe.py
install -m 0640 -o root -g root "${SOURCE_ROOT}/stack.manifest.json" /etc/opsmind-twin/stack.manifest.json
install -m 0640 -o root -g root "${SOURCE_ROOT}/config/gnb.yaml" "${DATA_ROOT}/config/baseline/gnb.yaml"
install -m 0640 -o root -g root "${SOURCE_ROOT}/config/ue.yaml" "${DATA_ROOT}/config/baseline/ue.yaml"

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

echo OPSMIND_TWIN_CONTROLLER_INSTALLED
