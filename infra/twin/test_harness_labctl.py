from pathlib import Path
import sys
import types

import pytest

if sys.platform == "win32":
    from unittest.mock import patch
    # Control semantics use mocked external calls; do not fake Linux lock tests.
    with patch.dict(sys.modules, {"fcntl": types.SimpleNamespace(LOCK_EX=1, flock=lambda *_: None)}):
        import opsmind_harness_labctl as labctl
else:
    import opsmind_harness_labctl as labctl


def test_leased_lab_runtime_observation_resolves_amf_without_cross_scope_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        labctl,
        "base_observe",
        lambda _trial_id, capability: {
            "ok": True,
            "data": {
                "services": {"open5gs-amfd": False, "open5gs-smfd": True},
                "ueransim": {"gnb": True, "ue": False},
            },
            "evidence_refs": ["process:open5gs-amfd-inactive"],
        }
        if capability == "processes"
        else {"ok": True, "data": {}, "evidence_refs": []},
    )
    records, evidence_refs = labctl.query_resource_observation(
        "ah-direct-test-1",
        {
            "resource_refs": [{
                "identifier_domain": "opsmind-twin",
                "namespace": "ah-direct-test-1",
                "resource_type": "service",
                "resource_id": "amf",
            }]
        },
        "runtime_state",
        {
            "identifier_domain": "opsmind-twin",
            "namespace": "ah-direct-test-1",
            "resource_refs": [{
                "identifier_domain": "opsmind-twin",
                "namespace": "ah-direct-test-1",
                "resource_type": "service",
                "resource_id": "amf",
            }],
        },
    )

    assert records == [{
        "resource_id": "amf",
        "namespace_id": "ah-direct-test-1",
        "resource_type": "service",
        "service_id": "amf",
        "resolution": "resolved",
        "read_only": True,
        "runtime_state": "stopped",
        "active": False,
    }]
    assert evidence_refs == ["process:open5gs-amfd-inactive"]

    service_records, service_refs = labctl.query_resource_observation(
        "ah-direct-test-1",
        {
            "resource_id": "smf",
            "namespace_id": "ah-direct-test-1",
            "service_id": "smf",
        },
        "service_health",
        {
            "identifier_domain": "opsmind-twin",
            "namespace": "ah-direct-test-1",
            "resource_refs": [{
                "identifier_domain": "opsmind-twin",
                "namespace": "ah-direct-test-1",
                "resource_type": "service",
                "resource_id": "smf",
            }],
        },
    )
    assert service_records[0]["active"] is True
    assert service_records[0]["health"] == "healthy"
    assert service_refs == []

    with pytest.raises(PermissionError, match="outside the active lab lease"):
        labctl.query_resource_observation(
            "ah-direct-test-1",
            {
                "resource_refs": [{
                    "identifier_domain": "opsmind-twin",
                    "namespace": "another-trial",
                    "resource_type": "service",
                    "resource_id": "amf",
                }]
            },
            "runtime_state",
            {
                "identifier_domain": "opsmind-twin",
                "namespace": "ah-direct-test-1",
                "resource_refs": [{
                    "identifier_domain": "opsmind-twin",
                    "namespace": "ah-direct-test-1",
                    "resource_type": "service",
                    "resource_id": "amf",
                }],
            },
        )

def test_real_lab_lease_is_claimed_by_one_signed_tenant_and_investigation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(labctl, "ROOT", tmp_path)
    monkeypatch.setattr(labctl, "ACTIVE_BINDING", tmp_path / "active-binding.json")
    monkeypatch.setattr(labctl, "load_active_lease", lambda: {
        "trial_id": "ah-trial-a", "slot_lease_id": "physical-lease-a",
    })
    slot_lease_id = "physical-lease-a"
    snapshot_request = {
        "operation": "snapshot",
        "trial_id": "ah-trial-a",
        "slot_lease_id": slot_lease_id,
        "tenant_binding": {
            "tenant_id": "tenant-a",
            "investigation_id": "inv-a",
            "scope_hash": "a" * 64,
        },
    }

    labctl.validate_request(snapshot_request)
    labctl.claim_active_lease(snapshot_request)
    labctl.validate_request(snapshot_request)

    cross_tenant = {
        **snapshot_request,
        "tenant_binding": {
            "tenant_id": "tenant-b",
            "investigation_id": "inv-b",
            "scope_hash": "b" * 64,
        },
    }
    with pytest.raises(PermissionError, match="another tenant"):
        labctl.validate_request(cross_tenant)

def test_observation_is_denied_until_snapshot_claims_the_real_trial(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(labctl, "ROOT", tmp_path)
    monkeypatch.setattr(labctl, "ACTIVE_BINDING", tmp_path / "active-binding.json")
    monkeypatch.setattr(labctl, "load_active_lease", lambda: {
        "trial_id": "ah-trial-unclaimed", "slot_lease_id": "physical-lease-unclaimed",
    })
    lease_id = "physical-lease-unclaimed"

    with pytest.raises(PermissionError, match="signed snapshot"):
        labctl.validate_request({
            "operation": "observe",
            "trial_id": "ah-trial-unclaimed",
            "slot_lease_id": lease_id,
            "tenant_binding": {
                "tenant_id": "tenant-a",
                "investigation_id": "inv-a",
                "scope_hash": "a" * 64,
            },
            "capability": "ip_reachability",
        })

def test_protocol_lab_controller_uses_the_single_base_physical_lease() -> None:
    controller = Path(labctl.__file__).read_text()

    assert 'response.get("physical_lease")' in controller
    assert '"owner_mode": request["owner_mode"]' in controller
    assert '"candidate_ref": "agent-harness-v2"' in controller
    assert "ACTIVE_LEASE" not in controller
    assert "save_active_lease" not in controller


def test_regular_snapshot_does_not_claim_business_recovery_or_run_probes(monkeypatch):
    monkeypatch.setattr(labctl, "claim_active_lease", lambda _: None)
    monkeypatch.setattr(labctl, "base_call", lambda _: {"ok": True, "snapshot": {
        "recovery": {"task_success": True}, "resource_scope": {}}})
    monkeypatch.setattr(labctl, "topology_status", lambda: {})
    monkeypatch.setattr(labctl.harness_probes, "business_verification",
                        lambda _: pytest.fail("ordinary snapshot must not probe business"))
    result = labctl.snapshot({"trial_id": "ah-test"})["snapshot"]
    assert "healthy" not in result and "task_success" not in result


@pytest.mark.parametrize("business,base,expected", [(False, True, False), (True, True, True),
                                                  (None, True, None), (True, False, True),
                                                  (None, False, None), (True, None, True)])
@pytest.mark.parametrize("purpose", ["pre_action_snapshot", "post_action_verification",
                                    "post_rollback_verification"])
def test_verifier_cannot_expand_registration_success_into_business_recovery(monkeypatch, business, base, expected, purpose):
    monkeypatch.setattr(labctl, "claim_active_lease", lambda _: None)
    monkeypatch.setattr(labctl, "base_call", lambda _: {"ok": True, "snapshot": {
        "recovery": {"task_success": base}, "resource_scope": {"namespace": "ah-test"}}})
    monkeypatch.setattr(labctl, "topology_status", lambda: {})
    calls = []
    def verify(scope):
        calls.append(scope)
        return {"passed": business}
    monkeypatch.setattr(labctl.harness_probes, "business_verification", verify)
    result = labctl.snapshot({"trial_id": "ah-test", "purpose": purpose})["snapshot"]
    assert result["healthy"] is expected
    assert result["business_verification"]["passed"] is business
    assert calls == [{"namespace": "ah-test"}]


def test_failed_mec_cleanup_does_not_release_the_base_lease(monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr(labctl, "active_snapshot", lambda _: {})
    monkeypatch.setattr(labctl, "run", lambda *a, **k: SimpleNamespace(returncode=1))
    monkeypatch.setattr(labctl, "base_call", lambda _: pytest.fail("lease must remain owned"))
    assert labctl.reset({"trial_id": "ah-test"})["error"]["code"] == "MEC_CLEANUP_FAILED"


def test_cleanup_checks_trial_ownership_before_mutating_topology(monkeypatch):
    def changed_trial(_):
        raise PermissionError("another Trial owns the lease")
    monkeypatch.setattr(labctl, "active_snapshot", changed_trial)
    monkeypatch.setattr(labctl, "run", lambda *a, **k: pytest.fail("no topology mutations allowed"))
    with pytest.raises(PermissionError):
        labctl.reset({"trial_id": "ah-old"})


def test_cleanup_precedes_base_lease_release(monkeypatch):
    from types import SimpleNamespace
    calls = []
    monkeypatch.setattr(labctl, "active_snapshot", lambda _: calls.append("check"))
    monkeypatch.setattr(labctl, "run", lambda *a, **k: calls.append("cleanup") or SimpleNamespace(returncode=0))
    monkeypatch.setattr(labctl, "base_call", lambda _: calls.append("release") or {"ok": True, "clean": True})
    monkeypatch.setattr(labctl, "clear_active_binding", lambda _: calls.append("unbind"))
    assert labctl.reset({"trial_id": "ah-test"})["clean"] is True
    assert calls == ["check", "cleanup", "release", "unbind"]

def test_prepare_checks_physical_lease_before_creating_mec_resources(monkeypatch):
    calls = []
    monkeypatch.setattr(labctl, "base_call", lambda r: calls.append(r["operation"]) or {"ok": True})
    monkeypatch.setattr(labctl, "run", lambda *a, **k: pytest.fail("no MEC creation without a lease"))
    result = labctl.prepare({"trial_id": "ah-test", "scenario_id": "sctp-blocked", "owner_mode": "agent_harness_direct"})
    assert result["error"]["code"] == "PHYSICAL_LEASE_MISSING"
    assert calls == ["prepare", "reset"]


def test_prepare_timeout_uses_the_same_owned_cleanup_path(monkeypatch):
    import subprocess
    monkeypatch.setattr(labctl, "base_call", lambda _: {"ok": True, "lease_id": "lease-test"})
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired("topology prepare", 90)
    monkeypatch.setattr(labctl, "run", timeout)
    cleaned = []
    monkeypatch.setattr(labctl, "reset", lambda request: cleaned.append(request["trial_id"]) or {"clean": True})
    result = labctl.prepare({"trial_id": "ah-test", "scenario_id": "sctp-blocked", "owner_mode": "agent_harness_direct"})
    assert result["error"]["code"] == "MEC_TOPOLOGY_FAILED"
    assert result["cleanup"]["clean"] is True
    assert cleaned == ["ah-test"]


@pytest.mark.parametrize("business,score", [(True, False), (False, True), (None, False)])
def test_business_health_is_independent_of_scenario_score(monkeypatch, business, score):
    monkeypatch.setattr(labctl, "claim_active_lease", lambda _: None)
    monkeypatch.setattr(labctl, "base_call", lambda _: {"ok": True, "snapshot": {
        "recovery": {"task_success": score, "minimal_change": score}, "resource_scope": {}}})
    monkeypatch.setattr(labctl, "topology_status", lambda: {})
    monkeypatch.setattr(labctl.harness_probes, "business_verification", lambda _: {"passed": business})
    value = labctl.snapshot({"trial_id": "ah-test", "purpose": "post_action_verification"})["snapshot"]
    assert value["healthy"] is business
    assert value["recovery"]["task_success"] is score
    assert "task_success" not in value


def test_capture_summary_exposes_one_source_and_never_imports_scenario_hints(monkeypatch):
    calls = []
    def base(trial, capability):
        calls.append((trial, capability))
        return {"data": {"files": 1, "bytes": 42, "protocol_frames": {"sctp": 2}},
                "observed_at": "2026-09-05T04:00:00Z",
                "evidence_refs": ["state:firewall-sctp-drop"]}
    monkeypatch.setattr(labctl, "base_observe", base)
    first, = labctl.protocol_summary("ah-a", {})
    second, = labctl.protocol_summary("ah-a", {})
    other, = labctl.protocol_summary("ah-b", {})
    assert calls == [("ah-a", "pcap_summary"), ("ah-a", "pcap_summary"), ("ah-b", "pcap_summary")]
    assert first["source_ref"] == second["source_ref"]
    assert first["source_ref"] != other["source_ref"]
    assert first["sampling_mode"] == "existing_capture_summary"
    assert first["capture_time_range"] == {"start": None, "end": None}
    assert first["location_coverage"] == "not_separated"
    assert "firewall-sctp-drop" not in str(first)
    assert "registration_and_session_state" not in first


@pytest.mark.parametrize("parameters", [
    {"capture_profile": "n3"}, {"duration_seconds": 3}, {"packet_limit": 50},
])
def test_capture_summary_rejects_sampling_options_it_cannot_honor(monkeypatch, parameters):
    monkeypatch.setattr(labctl, "base_observe", lambda *a: pytest.fail("reject before reading"))
    with pytest.raises(ValueError, match="does not support"):
        labctl.protocol_summary("ah-a", parameters)
