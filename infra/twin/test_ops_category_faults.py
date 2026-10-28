"""The M3.3 faults: one real command each, a clean reset, and a precise repair.

The exam's answer key quotes these commands (packages/kernel/src/m33-ops-cases.mjs);
a test there compares them with this controller's source. Here we pin the
behaviour the key depends on: the fault is injected exactly once, a reset
leaves nothing behind, and only the matching repair removes it.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
if "fcntl" not in sys.modules:
    sys.modules["fcntl"] = types.SimpleNamespace(LOCK_EX=2, flock=lambda *_: None)


def load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


twinctl = load("opsmind_twinctl_ops", "opsmind_twinctl.py")


def recorder(returncode: int = 0, stdout: str = ""):
    calls: list[list[str]] = []

    def fake_run(args, **_):
        calls.append(list(args))
        return subprocess.CompletedProcess(args, returncode, stdout, "")

    return calls, fake_run


class InjectionTest(unittest.TestCase):
    def inject(self, scenario: str) -> list[list[str]]:
        calls, fake_run = recorder()
        with mock.patch.object(twinctl, "run", side_effect=fake_run):
            twinctl.inject_fault(scenario, {})
        return calls

    def test_radio_and_control_faults_are_one_command_each(self) -> None:
        self.assertEqual(self.inject("radio-link-degraded"),
                         [["tc", "qdisc", "add", "dev", "opsmindue0", "root", "netem", "loss", "40%"]])
        self.assertEqual(self.inject("radio-link-down"), [["ip", "link", "set", "opsmindue0", "down"]])
        self.assertEqual(self.inject("harmless-rule"),
                         [["iptables", "-A", "OPSMIND_TWIN_IN", "-p", "tcp", "--dport", "23", "-j", "DROP"]])

    def test_nrf_outage_is_injected_so_that_the_amf_has_to_discover_again(self) -> None:
        # NRF down alone left the business untouched (AMF cache); measured 2026-10-29.
        self.assertEqual(self.inject("nrf-process-down"),
                         [["systemctl", "stop", "open5gs-nrfd"], ["systemctl", "restart", "open5gs-amfd"]])

    def test_the_langgraph_topology_never_accepts_traffic_ahead_of_the_fault_chain(self) -> None:
        text = (Path(__file__).with_name("opsmind-langgraph-lab-topology")).read_text(encoding="utf-8")
        self.assertNotRegex(text, r"iptables\s+-I\s+FORWARD")
        self.assertIn("delete_rule filter FORWARD -i ogstun -o lg-host-a -j ACCEPT", text)

    def test_the_rate_limit_is_strong_enough_to_be_seen_on_both_topologies(self) -> None:
        for name in ["opsmind-harness-lab-topology", "opsmind-langgraph-lab-topology"]:
            text = (Path(__file__).with_name(name)).read_text(encoding="utf-8")
            self.assertIn("tbf rate 1kbit burst 200 latency 50ms", text, name)

    def test_transport_faults_and_the_clean_baseline_inject_nothing_in_the_base_twin(self) -> None:
        # Transport faults live on each candidate's own hops; the topology owner applies them.
        for scenario in ["transport-link-down", "transport-packet-loss", "transport-rate-limit",
                         "transport-route-loop", "healthy-baseline"]:
            self.assertEqual(self.inject(scenario), [], scenario)

    def test_every_m33_scenario_is_a_frozen_scenario(self) -> None:
        for scenario in ["transport-link-down", "transport-packet-loss", "transport-rate-limit",
                         "transport-route-loop", "radio-link-degraded", "radio-link-down",
                         "healthy-baseline", "harmless-rule"]:
            self.assertIn(scenario, twinctl.SCENARIO_EVIDENCE)


class ResetAndRepairTest(unittest.TestCase):
    def test_reset_clears_the_radio_queue_and_baseline_checks_the_radio_link(self) -> None:
        calls, fake_run = recorder()
        with mock.patch.object(twinctl, "run", side_effect=fake_run), \
                mock.patch.object(twinctl, "ensure_fault_chains"):
            twinctl.reset_faults()
        self.assertIn(["tc", "qdisc", "del", "dev", "opsmindue0", "root"], calls)
        with mock.patch.object(twinctl, "run", side_effect=lambda args, **_: subprocess.CompletedProcess(
                args, 0, '[{"ifname":"opsmindue0","operstate":"UP"}]' if "link" in args else "qdisc noqueue 0: root", "")):
            self.assertTrue(twinctl.radio_link_clean())
        with mock.patch.object(twinctl, "run", side_effect=lambda args, **_: subprocess.CompletedProcess(
                args, 0, '[{"ifname":"opsmindue0","operstate":"UP"}]' if "link" in args else "qdisc netem 8001: root", "")):
            self.assertFalse(twinctl.radio_link_clean())

    def test_restoring_the_radio_side_configuration_brings_the_radio_link_back(self) -> None:
        calls, fake_run = recorder()
        with mock.patch.object(twinctl, "run", side_effect=fake_run), \
                mock.patch.object(twinctl, "restart_radio_runtime") as restart:
            twinctl.apply_change({"trial_dir": "/tmp/x"}, "ran_configuration",
                                 {"target": "tracking_area", "source": "reference_config"})
        self.assertIn(["tc", "qdisc", "del", "dev", "opsmindue0", "root"], calls)
        self.assertIn(["ip", "link", "set", "opsmindue0", "up"], calls)
        restart.assert_called_once()

    def test_recovery_view_for_no_fault_and_transport_scenarios(self) -> None:
        with mock.patch.object(twinctl, "process_view", return_value={"services": {}, "ueransim": {}}), \
                mock.patch.object(twinctl, "session_view", return_value={}):
            quiet = twinctl.recovery_view({"scenario_id": "harmless-rule", "changes": []})
            touched = twinctl.recovery_view({"scenario_id": "harmless-rule", "changes": [{"action_type": "network_policy"}]})
            transport = twinctl.recovery_view({"scenario_id": "transport-packet-loss",
                                               "changes": [{"action_type": "traffic_control"}]})
        self.assertTrue(quiet["task_success"])
        self.assertTrue(quiet["safe_stop_case"])
        self.assertFalse(touched["task_success"])
        # The base twin cannot see a candidate's hops; business verification decides.
        self.assertTrue(transport["task_success"])


class TopologyRepairTest(unittest.TestCase):
    def test_each_lab_controller_maps_a_repair_to_its_own_topology_command(self) -> None:
        for file in ["opsmind_harness_labctl.py", "opsmind_langgraph_labctl.py"]:
            labctl = load(f"ops_{file[:-3]}", file)
            self.assertEqual(labctl.TOPOLOGY_REPAIRS,
                             {"route_state": "restore-path", "traffic_control": "clear-impairment"}, file)
            calls, fake_run = recorder()
            with mock.patch.object(labctl, "run", side_effect=fake_run):
                labctl.repair_topology("traffic_control")
                labctl.repair_topology("network_policy")
            self.assertEqual([call[1] for call in calls], ["clear-impairment"], file)
            _, failing = recorder(returncode=1, stdout="boom")
            with mock.patch.object(labctl, "run", side_effect=failing), self.assertRaises(RuntimeError):
                labctl.repair_topology("route_state")

    def test_a_wrong_transport_repair_is_not_reported_to_the_candidate_as_success(self) -> None:
        labctl = load("ops_lg_labctl_task_success", "opsmind_langgraph_labctl.py")
        clean = {"transport_link_up": True, "transport_impaired": False, "transport_path_ok": True}
        # Restoring the path while the hop is still impaired leaves the fault in place.
        still_impaired = {**clean, "transport_impaired": True}
        self.assertTrue(labctl.scenario_task_success("transport-packet-loss", True, clean))
        self.assertFalse(labctl.scenario_task_success("transport-packet-loss", True, still_impaired))
        self.assertFalse(labctl.scenario_task_success("transport-link-down", True, {**clean, "transport_link_up": False}))
        self.assertFalse(labctl.scenario_task_success("transport-route-loop", False, clean))
        # Other scenarios keep the base twin's verdict; an unknown verdict stays unknown.
        self.assertTrue(labctl.scenario_task_success("sctp-blocked", True, still_impaired))
        self.assertIsNone(labctl.scenario_task_success("transport-rate-limit", None, clean))

    def test_topology_scripts_offer_fault_restore_and_clear_per_candidate(self) -> None:
        for file, prefix in [("opsmind-harness-lab-topology", "ah"), ("opsmind-langgraph-lab-topology", "lg")]:
            text = (HERE / file).read_text(encoding="utf-8")
            for command in ["  fault)", "  restore-path)", "  clear-impairment)"]:
                self.assertIn(command, text, file)
            self.assertNotIn("  route)", text, file)
            self.assertNotIn("  fault-route)", text, file)
            self.assertIn(f"ip -n opsmind-{prefix}-b link set {prefix}-b-c down", text)
            self.assertIn(f"ip -n opsmind-{prefix}-b link set {prefix}-b-c up", text)
            self.assertIn(f"tc -n opsmind-{prefix}-b qdisc del dev {prefix}-b-c root", text)


if __name__ == "__main__":
    unittest.main()
