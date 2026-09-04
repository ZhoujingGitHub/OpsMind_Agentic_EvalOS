from pathlib import Path
import sys
import types

import pytest

if sys.platform == "win32":
    sys.modules.setdefault("fcntl", types.SimpleNamespace(LOCK_EX=1, flock=lambda *_args: None))

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
