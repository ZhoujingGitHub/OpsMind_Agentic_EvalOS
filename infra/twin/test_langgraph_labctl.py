"""Regressions for the LangGraph laboratory adapter now owned by this repository.

These lock the two facts that made chain 2 and chain 4 fail on 2026-09-11: the
adapter never installed the NAT bypass its own data path needs, and it reported
the scenario score as product health.
"""
from pathlib import Path
import json
import shutil
import sys
import types

import pytest

if sys.platform == "win32":
    from unittest.mock import patch
    # Control semantics use mocked external calls; do not fake Linux lock tests.
    with patch.dict(sys.modules, {"fcntl": types.SimpleNamespace(LOCK_EX=1, flock=lambda *_: None)}):
        import opsmind_langgraph_labctl as labctl
else:
    import opsmind_langgraph_labctl as labctl

import harness_probes

TWIN = Path(__file__).parent
LANGGRAPH_TOPOLOGY = TWIN / "opsmind-langgraph-lab-topology"
HARNESS_TOPOLOGY = TWIN / "opsmind-harness-lab-topology"
MANIFEST = json.loads((TWIN / "stack.manifest.json").read_text())


def snapshot_with(task_success, business, monkeypatch):
    monkeypatch.setattr(labctl, "base_call", lambda _: {"ok": True, "snapshot": {
        "trial_id": "lg-test", "recovery": {"task_success": task_success},
        "resource_scope": {"namespace": "lg-test"}}})
    monkeypatch.setattr(labctl, "topology_status", lambda: {})
    monkeypatch.setattr(labctl.harness_probes, "business_verification",
                        lambda *_: {"passed": business, "status": "x", "observed_at": "t"})
    return labctl.snapshot({"trial_id": "lg-test"})["snapshot"]


@pytest.mark.parametrize("task_success,business", [(True, False), (False, True), (True, None),
                                                   (False, False), (True, True)])
def test_langgraph_business_health_is_independent_of_scenario_score(monkeypatch, task_success, business):
    value = snapshot_with(task_success, business, monkeypatch)
    assert value["healthy"] is business
    assert value["business_verification"]["passed"] is business
    # The scenario score stays readable, but it is never product health again.
    assert value["task_success"] is task_success


def test_langgraph_snapshot_asks_the_shared_verifier_for_its_own_network(monkeypatch):
    calls = []
    monkeypatch.setattr(labctl, "base_call", lambda _: {"ok": True, "snapshot": {
        "recovery": {"task_success": True}, "resource_scope": {"namespace": "lg-test"}}})
    monkeypatch.setattr(labctl, "topology_status", lambda: {})

    def verify(scope, profile):
        calls.append((scope, profile))
        return {"passed": True, "observed_at": "t"}

    monkeypatch.setattr(labctl.harness_probes, "business_verification", verify)
    labctl.snapshot({"trial_id": "lg-test"})
    assert calls == [({"namespace": "lg-test"}, harness_probes.LANGGRAPH_NETWORK)]


def test_business_verify_reports_the_observed_verdict_without_inventing_one(monkeypatch):
    monkeypatch.setattr(labctl, "active_snapshot", lambda _: {"resource_scope": {"namespace": "lg-x"}})
    for passed, ok in [(True, True), (False, True), (None, False)]:
        monkeypatch.setattr(labctl.harness_probes, "business_verification",
                            lambda *_, _passed=passed: {"passed": _passed, "observed_at": "t"})
        result = labctl.business_verify({"trial_id": "lg-x"})
        assert result["ok"] is ok
        assert result["business_verification"]["passed"] is passed


def test_manager_business_verify_requires_an_owned_trial_identifier(monkeypatch):
    monkeypatch.setattr(labctl, "business_verify", lambda request: {"ok": True, **request})
    assert labctl.manage(["business-verify", "lg-test"])["trial_id"] == "lg-test"
    with pytest.raises(ValueError, match="must start with lg-"):
        labctl.manage(["business-verify", "ah-test"])


def test_langgraph_observe_uses_the_shared_device_bound_probes(monkeypatch):
    seen = []
    monkeypatch.setattr(labctl, "active_snapshot", lambda _: {"resource_scope": {"namespace": "lg-t"}})
    monkeypatch.setattr(labctl.harness_probes, "topology", lambda profile: {"profile": profile})

    def probe(kind, parameters, scope, *, network):
        seen.append((kind, scope, network))
        return {"reachable": True}

    monkeypatch.setattr(labctl.harness_probes, "probe", probe)
    for capability, kind in [("ip_reachability", "ip"), ("network_path", "trace"),
                             ("tcp_port", "tcp"), ("dns", "dns"), ("http_service", "http")]:
        labctl.observe({"trial_id": "lg-t", "capability": capability})
        assert seen[-1] == (kind, {"namespace": "lg-t"},
                            {"profile": harness_probes.LANGGRAPH_NETWORK})


def test_langgraph_network_facts_come_from_the_component_manifest():
    source = LANGGRAPH_TOPOLOGY.read_text()
    assert "[\"langgraph_network\"]" in source
    assert "read -r MEC_IP DNS_IP SERVICE_NET UE_NET" in source
    head, rest = source.split("restore_base_route()", 1)
    # 10.46.0.1 survives only inside restore_base_route; it is the shared base DN.
    assert "10.46.0." not in head + rest.split("\n}", 1)[1]
    assert "10.45.0.0/16" not in source
    labctl_source = (TWIN / "opsmind_langgraph_labctl.py").read_text()
    assert "10.46.0." not in labctl_source
    assert "NETWORK_PROFILE = harness_probes.LANGGRAPH_NETWORK" in labctl_source
    network = MANIFEST["langgraph_network"]
    assert network["service_network"] == "10.46.0.0/24"
    assert network["ue_network"] == MANIFEST["harness_network"]["ue_network"]


def test_langgraph_topology_installs_and_removes_the_same_nat_bypass_as_harness():
    install = "iptables -t nat -I POSTROUTING 1 -s \"$UE_NET\" -d \"$SERVICE_NET\" -o %s-host-a -j ACCEPT"
    remove = "delete_rule nat POSTROUTING -s \"$UE_NET\" -d \"$SERVICE_NET\" -o %s-host-a -j ACCEPT"
    verify = "iptables -t nat -C POSTROUTING -s \"$UE_NET\" -d \"$SERVICE_NET\" -o %s-host-a -j ACCEPT"
    for path, prefix in ((LANGGRAPH_TOPOLOGY, "lg"), (HARNESS_TOPOLOGY, "ah")):
        source = path.read_text()
        assert source.count(install % prefix) == 1, prefix
        assert source.count(remove % prefix) == 1, prefix
        # Teardown proves the exception is gone before the lease can be released.
        assert (verify % prefix) in source.split("reset_topology()", 1)[1], prefix


def test_langgraph_teardown_removes_every_rule_it_installed():
    if shutil.which("sh") is None:
        pytest.skip("POSIX shell required for the command contract regression")
    source = LANGGRAPH_TOPOLOGY.read_text()
    installed = [line.strip() for line in source.splitlines()
                 if line.strip().startswith("iptables ") and (" -I " in line or " -A " in line)]
    removed = [line.strip() for line in source.splitlines() if line.strip().startswith("delete_rule ")]
    assert len(installed) == 3 and len(removed) == 3

    def rule(text):
        """Normalize `iptables [-t table] -I chain N ...` and `delete_rule table chain ...`."""
        if text.startswith("delete_rule "):
            table, chain, *match = text.split()[1:]
        else:
            parts = text.split()[1:]
            table, parts = (parts[1], parts[2:]) if parts[0] == "-t" else ("filter", parts)
            chain, *match = parts[1:]
        return table, chain, tuple(item for item in match if not item.isdigit())

    assert sorted(rule(item) for item in installed) == sorted(rule(item) for item in removed)


def test_langgraph_adapter_is_released_and_installed_by_the_single_controller_entry():
    builder = (TWIN / "build-controller-release.py").read_text()
    installer = (TWIN / "install-controller.sh").read_text()
    for name in ("opsmind_langgraph_labctl.py", "opsmind-langgraph-lab-topology",
                 "opsmind-langgraph-ssh-shim", "opsmind-langgraph-mec-http.py"):
        assert name in builder, name
        assert name in installer, name
    assert "langgraph-source-lineage.json" in builder
    # The retired product-side installer must not come back as a second entry.
    assert "install-protocol-lab" not in builder + installer


def test_langgraph_manage_still_refuses_product_ssh_identities(monkeypatch):
    monkeypatch.setenv("SUDO_USER", "opsmind_lg_observer")
    with pytest.raises(PermissionError):
        labctl.manage(["business-verify", "lg-test"])


# --- Migrated from OpsMind-LangGraph tests/protocol_lab, which follow the source ---
# Contract enforcement by the gateway is tested here; the content of the product
# action catalog stays under test in the LangGraph repository.

CONTRACT = {
    "contract_version": "opsmind-protocol-action-catalog/3.0",
    "actions": [{
        "product_action_type": "service.ensure_running",
        "remote_action_type": "service_state",
        "target_parameters": {"smf": {"component": "smf", "desired_state": "running"},
                              "amf": {"component": "amf", "desired_state": "running"}},
    }],
}


def scope_snapshot(target, trial="lg-target-test"):
    return {"trial_id": trial, "resource_scope": {"namespace": trial, "resource_refs": [
        {"namespace": trial, "identifier_domain": "opsmind-twin", "resource_id": target}]}}


@pytest.fixture()
def installed_contract(monkeypatch, tmp_path):
    path = tmp_path / "protocol-actions.json"
    path.write_text(json.dumps(CONTRACT))
    monkeypatch.setattr(labctl, "ACTION_CONTRACT_FILE", path)
    return path


@pytest.mark.parametrize("change", ["target", "product", "extra", "namespace", "domain",
                                    "missing_scope"])
def test_action_contract_rejects_target_or_scope_mismatch(installed_contract, change):
    parameters = {"product_action_type": "service.ensure_running", "target_profile": "amf"}
    state = scope_snapshot("amf")
    if change == "target":
        parameters["target_profile"] = "n2"
        state = scope_snapshot("n2")
    elif change == "product":
        parameters["product_action_type"] = "network.restore_policy"
    elif change == "extra":
        parameters["command"] = "not-allowed"
    elif change == "namespace":
        state["resource_scope"]["resource_refs"][0]["namespace"] = "another-trial"
    elif change == "domain":
        state["resource_scope"]["resource_refs"][0]["identifier_domain"] = "external"
    else:
        state.pop("resource_scope")
    with pytest.raises((ValueError, PermissionError)):
        labctl.action_parameters("service_state", parameters, state)


def test_same_approved_target_is_forwarded_once_and_cannot_be_rebound(
        installed_contract, monkeypatch, tmp_path):
    monkeypatch.setattr(labctl, "REQUEST_ROOT", tmp_path / "requests")
    monkeypatch.setattr(labctl, "active_snapshot", lambda _: scope_snapshot("smf"))
    calls = []
    monkeypatch.setattr(labctl, "base_call", lambda request: calls.append(dict(request))
                        or {"ok": True, "operation": "act", "data": {"applied": True}})
    request = {"trial_id": "lg-target-test", "external_request_id": "approved-action-1",
               "action_type": "service_state",
               "parameters": {"product_action_type": "service.ensure_running",
                              "target_profile": "smf"}}
    first = labctl.act(request)
    assert labctl.act(request) == first
    assert calls == [{"operation": "act", "trial_id": "lg-target-test",
                      "action_type": "service_state",
                      "parameters": {"component": "smf", "desired_state": "running"}}]
    request["parameters"]["target_profile"] = "amf"
    with pytest.raises(PermissionError, match="binding"):
        labctl.act(request)
    assert len(calls) == 1


def test_missing_or_unknown_action_contract_fails_closed(monkeypatch, tmp_path):
    path = tmp_path / "protocol-actions.json"
    monkeypatch.setattr(labctl, "ACTION_CONTRACT_FILE", path)
    parameters = {"product_action_type": "service.ensure_running", "target_profile": "amf"}
    with pytest.raises(FileNotFoundError):
        labctl.action_parameters("service_state", parameters, scope_snapshot("amf"))
    path.write_text(json.dumps({"contract_version": "unknown", "actions": []}))
    with pytest.raises(ValueError, match="unsupported"):
        labctl.action_parameters("service_state", parameters, scope_snapshot("amf"))


def test_crash_after_external_write_leaves_unknown_receipt_and_does_not_replay(
        installed_contract, monkeypatch, tmp_path):
    monkeypatch.setattr(labctl, "REQUEST_ROOT", tmp_path / "requests")
    monkeypatch.setattr(labctl, "active_snapshot", lambda _: scope_snapshot("smf"))
    calls = []

    def lost_response(request):
        calls.append(request)
        raise ConnectionError("response lost after a possible write")

    monkeypatch.setattr(labctl, "base_call", lost_response)
    request = {"trial_id": "lg-target-test", "external_request_id": "uncertain-1",
               "action_type": "service_state",
               "parameters": {"product_action_type": "service.ensure_running",
                              "target_profile": "smf"}}
    with pytest.raises(ConnectionError):
        labctl.act(request)
    receipt = labctl.act(request)
    assert len(calls) == 1
    assert receipt["data"] == {"status": "unknown", "changed_external_state": True}
    assert labctl.status(request)["data"]["status"] == "unknown"


def test_product_rollback_cannot_load_or_reset_the_shared_lab(monkeypatch):
    monkeypatch.setattr(
        labctl, "load_base_module",
        lambda: pytest.fail("product rollback must never load the scene controller"))
    result = labctl.rollback_fault(scope_snapshot("amf"), {"parameters": {}})
    assert result["error"]["code"] == "ROLLBACK_UNSUPPORTED"


def test_leased_lab_runtime_observation_uses_the_twin_issued_scope(monkeypatch):
    monkeypatch.setattr(labctl, "base_observe", lambda _trial_id, capability: (
        {"ok": True, "data": {"services": {"open5gs-amfd": False, "open5gs-smfd": True},
                              "ueransim": {"gnb": True, "ue": False}},
         "evidence_refs": ["process:open5gs-amfd-inactive"]}
        if capability == "processes" else {"ok": True, "data": {}, "evidence_refs": []}))
    resource_scope = {"identifier_domain": "opsmind-twin", "namespace": "lg-direct-test-1",
                      "resource_refs": [{"identifier_domain": "opsmind-twin",
                                         "namespace": "lg-direct-test-1",
                                         "resource_type": "service", "resource_id": "amf"}]}
    records, evidence_refs = labctl.query_resource_observation(
        "lg-direct-test-1",
        {"resource_id": "amf", "namespace_id": "lg-direct-test-1"},
        "runtime_state", resource_scope)
    assert records[0]["runtime_state"] == "stopped"
    assert records[0]["active"] is False
    assert evidence_refs == ["process:open5gs-amfd-inactive"]
    with pytest.raises(PermissionError, match="outside the active lab lease"):
        labctl.query_resource_observation(
            "lg-direct-test-1", {"resource_id": "smf", "namespace_id": "lg-direct-test-1"},
            "runtime_state", resource_scope)


def test_langgraph_controller_uses_the_single_base_physical_lease():
    controller = (TWIN / "opsmind_langgraph_labctl.py").read_text()
    assert "response.get(\"physical_lease\")" in controller
    assert "\"owner_mode\": request[\"owner_mode\"]" in controller
    assert "\"candidate_ref\": \"langgraph-v1\"" in controller
    assert "ACTIVE_LEASE" not in controller
    assert "save_active_lease" not in controller


def test_langgraph_controller_stays_compatible_with_twin_python_310():
    controller = (TWIN / "opsmind_langgraph_labctl.py").read_text()
    assert "dt.timezone.utc" in controller
    assert "dt.UTC" not in controller


def test_protocol_summary_reuses_frozen_trial_evidence_and_never_exposes_secrets():
    controller = (TWIN / "opsmind_langgraph_labctl.py").read_text()
    assert "collector.capture_filter(parameters)" in controller
    assert "collector.capture_summary(trial_id, parameters, directory" in controller
    assert "state.get(\"trial_id\") != trial_id" in controller
    assert "directory != expected or expected.is_symlink()" in controller
    assert "\"authentication_profile_consistent\": bool(checked_fields)" in controller
    assert "\"secret_values_exposed\": False" in controller


def test_ssh_forced_command_preserves_request_before_privilege_elevation():
    shim = (TWIN / "opsmind-langgraph-ssh-shim").read_text()
    assert "exec sudo -n /usr/local/sbin/opsmind-langgraph-labctl request" in shim


def test_local_health_requires_owned_protocol_listener(monkeypatch):
    commands = []

    def collect(args):
        commands.append(args)
        return "42" if args[0] == "systemctl" else "sctp users:((\"other\",pid=99,fd=4))"

    monkeypatch.setattr(labctl, "collected", collect)
    health = labctl.local_listener_health("amf", labctl.RUNTIME_TARGETS["amf"], True)
    assert health["ready"] is False
    assert health["business_health"] == "not_measured"
    assert commands[-1][-1] == "sctp"


def test_failed_socket_route_and_sctp_reads_never_report_empty_success(monkeypatch):
    monkeypatch.setattr(labctl, "run", lambda *a, **k: types.SimpleNamespace(
        returncode=1, stdout="", stderr="unavailable"))
    for query in (labctl.probe_sctp, lambda: labctl.query_routes({}),
                  lambda: labctl.query_interfaces({}), lambda: labctl.query_sockets({})):
        with pytest.raises(RuntimeError, match="collection failed"):
            query()


def test_capture_passes_exact_filters_and_rejects_foreign_trial(monkeypatch, tmp_path):
    root = tmp_path / "capture"
    directory = root / "trial-a"
    directory.mkdir(parents=True)
    calls = []
    monkeypatch.setattr(labctl, "network_diagnostics", lambda: types.SimpleNamespace(
        capture_filter=lambda args: calls.append(dict(args)),
        capture_summary=lambda trial, args, path, **kw: {"trial": trial, "filter": args}))
    monkeypatch.setattr(labctl, "load_base_module", lambda: types.SimpleNamespace(
        PCAP_ROOT=root,
        load_state=lambda: {"trial_id": "trial-a", "pcap_dir": str(directory)}))
    args = {"protocol": "sctp", "source_ip": "10.0.0.1", "frame_limit": 7,
            "start_at": "2026-09-09T00:00:00Z"}
    result = labctl.protocol_summary("trial-a", args)
    assert calls == [args] and result[0]["filter"] == args
    with pytest.raises(PermissionError, match="active Trial"):
        labctl.protocol_summary("trial-b", args)


@pytest.mark.parametrize("arguments", [{"runtime_types": ["container"]},
                                       {"diagnostic_profile": "network_policy", "since_seconds": 5},
                                       {"diagnostic_profile": "container_state"}])
def test_unimplemented_source_filters_never_become_success(monkeypatch, arguments):
    ref = {"identifier_domain": "opsmind-twin", "namespace": "trial-a",
           "resource_type": "service", "resource_id": "amf"}
    scope = {"identifier_domain": "opsmind-twin", "namespace": "trial-a", "resource_refs": [ref]}
    monkeypatch.setattr(labctl, "base_observe", lambda *_args: {"data": {}})
    with pytest.raises(ValueError):
        labctl.query_resource_observation(
            "trial-a", {"resource_refs": [ref], **arguments},
            "sandboxed_readonly_diagnostic", scope)
