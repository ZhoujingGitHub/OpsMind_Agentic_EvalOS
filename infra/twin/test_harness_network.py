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
