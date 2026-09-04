"""Behavioral regressions for shared forwarding ownership, without a live lab."""
from types import SimpleNamespace

import sys
from unittest.mock import patch

if sys.platform == "win32":
    # These tests exercise rule ordering only, never Linux locking.
    with patch.dict(sys.modules, {"fcntl": SimpleNamespace(LOCK_EX=1, flock=lambda *_: None)}):
        import opsmind_twinctl as base
else:
    import opsmind_twinctl as base


class Firewall:
    def __init__(self):
        self.chains = {
            "FORWARD": [("-i", "ogstun", "-o", "ah-host-a", "-j", "ACCEPT"),
                        ("-j", "OPSMIND_TWIN_BASE"), ("-j", "OPSMIND_TWIN_FWD"),
                        ("-j", "OPSMIND_TWIN_FWD")],
            "INPUT": [], "OUTPUT": [],
            "OPSMIND_TWIN_FWD": [("-p", "udp", "--dport", "53", "-j", "DROP")],
            "OPSMIND_TWIN_BASE": [],
        }

    def run(self, args, **_):
        operation, chain = args[1:3]
        tail = tuple(args[3:])
        present = chain in self.chains
        code = 0
        if operation == "-L":
            code = 0 if present else 1
        elif operation == "-N":
            self.chains[chain] = []
        elif operation == "-C":
            code = 0 if tail in self.chains.get(chain, []) else 1
        elif operation == "-D":
            self.chains[chain].remove(tail)
        elif operation == "-I":
            position = int(tail[0]) - 1
            self.chains[chain].insert(position, tail[1:])
        elif operation == "-F":
            self.chains[chain] = []
        elif operation == "-A":
            self.chains[chain].append(tail)
        else:
            raise AssertionError(args)
        return SimpleNamespace(returncode=code, stdout="")


def test_fault_gate_precedes_normal_forwarding_and_preserves_injected_fault(monkeypatch):
    firewall = Firewall()
    injected = list(firewall.chains["OPSMIND_TWIN_FWD"])
    monkeypatch.setattr(base, "run", firewall.run)
    base.ensure_forwarding()
    base.ensure_forwarding()
    forward = firewall.chains["FORWARD"]
    assert forward[:2] == [("-j", "OPSMIND_TWIN_FWD"), ("-j", "OPSMIND_TWIN_BASE")]
    assert forward.count(("-j", "OPSMIND_TWIN_FWD")) == 1
    assert forward.count(("-j", "OPSMIND_TWIN_BASE")) == 1
    assert firewall.chains["OPSMIND_TWIN_FWD"] == injected


def test_reset_removes_faults_and_duplicate_hooks_without_accumulating_rules(monkeypatch):
    firewall = Firewall()
    monkeypatch.setattr(base, "run", firewall.run)
    for _ in range(3):
        base.ensure_fault_chains()
        base.ensure_forwarding()
    assert firewall.chains["OPSMIND_TWIN_FWD"] == []
    assert firewall.chains["INPUT"] == [("-j", "OPSMIND_TWIN_IN")]
    assert firewall.chains["OUTPUT"] == [("-j", "OPSMIND_TWIN_OUT")]
    assert firewall.chains["FORWARD"][:2] == [("-j", "OPSMIND_TWIN_FWD"), ("-j", "OPSMIND_TWIN_BASE")]


def test_topology_cleanup_uses_the_requested_table_and_removes_duplicates():
    """Execute the shipped shell helper against the iptables argument contract."""
    from pathlib import Path
    import shutil
    import subprocess
    import pytest

    shell = shutil.which("sh")
    if shell is None:
        pytest.skip("POSIX shell required for the command contract regression")
    source = Path(__file__).with_name("opsmind-harness-lab-topology").read_text()
    helper = "delete_rule() {" + source.split("delete_rule() {", 1)[1].split("\n}", 1)[0] + "\n}"
    # Checks/deletes are table-specific, and -C/-D must immediately precede
    # a chain. Incorrect syntax returns 2, as the real Linux command does.
    contract = r'''
set -eu
nat_rules=2
filter_rules=1
iptables() {
  [ "$1" = "-t" ] || return 2
  selected_table="$2"; operation="$3"; chain="$4"
  shift 4
  [ "$*" = "-s 10.45.0.0/16 -j ACCEPT" ] || return 2
  case "$selected_table:$chain" in
    nat:POSTROUTING) count="$nat_rules" ;;
    filter:FORWARD) count="$filter_rules" ;;
    *) return 2 ;;
  esac
  case "$operation" in
    -C) [ "$count" -gt 0 ] ;;
    -D)
      [ "$count" -gt 0 ] || return 1
      case "$selected_table" in
        nat) nat_rules=$((nat_rules - 1)) ;;
        filter) filter_rules=$((filter_rules - 1)) ;;
      esac ;;
    *) return 2 ;;
  esac
}
'''
    exercise = r'''
delete_rule nat POSTROUTING -s 10.45.0.0/16 -j ACCEPT
[ "$nat_rules" -eq 0 ]
[ "$filter_rules" -eq 1 ]
delete_rule nat POSTROUTING -s 10.45.0.0/16 -j ACCEPT
delete_rule filter FORWARD -s 10.45.0.0/16 -j ACCEPT
delete_rule filter FORWARD -s 10.45.0.0/16 -j ACCEPT
[ "$nat_rules" -eq 0 ] && [ "$filter_rules" -eq 0 ]
'''
    result = subprocess.run([shell, "-c", contract + helper + "\n" + exercise],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
