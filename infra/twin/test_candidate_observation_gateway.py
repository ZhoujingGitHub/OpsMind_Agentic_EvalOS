from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


if sys.platform == "win32":
    sys.modules.setdefault("fcntl", types.SimpleNamespace())

MODULE_PATH = Path(__file__).with_name("opsmind_candidate_observation_gateway.py")
SPEC = importlib.util.spec_from_file_location("opsmind_candidate_observation_gateway", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
gateway = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gateway)


class CandidateObservationGatewayTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.binding_root = self.root / "bindings"
        self.trial_root = self.root / "trials"
        self.trial_root.mkdir()
        self.leases: dict[str, dict] = {}
        self.patchers = [
            patch.object(gateway, "ROOT", self.root),
            patch.object(gateway, "BINDING_ROOT", self.binding_root),
            patch.object(gateway, "TRIAL_ROOT", self.trial_root),
            patch.object(gateway, "active_lease", side_effect=lambda contestant_ref: self.leases.get(contestant_ref, {})),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temporary.cleanup()

    def prepare_binding(self, contestant_ref: str) -> tuple[str, str]:
        managed_trial_id = ("ah-" if contestant_ref == "agent-harness-v2" else "lg-") + "trial-1"
        slot_lease_id = "lease-test-1"
        self.leases[contestant_ref] = {
            "trial_id": managed_trial_id,
            "evalos_trial_id": "trial-1",
            "slot_lease_id": slot_lease_id,
            "owner_mode": "evalos_trial",
        }
        (self.trial_root / managed_trial_id).mkdir()
        response = gateway.bind({
            "contestant_ref": contestant_ref,
            "evalos_trial_id": "trial-1",
            "managed_trial_id": managed_trial_id,
            "context_digest": "a" * 64,
            "environment_ref": "evalos-twin:trial-1",
            "resource_refs": [{
                "identifier_domain": "opsmind-twin",
                "namespace": managed_trial_id,
                "resource_type": "workload",
                "resource_id": "ue-1",
            }],
            "service_ids": ["ueransim-ue"],
        })
        self.assertTrue(response["ok"])
        return managed_trial_id, slot_lease_id

    def test_agent_harness_is_trial_scoped_and_audits_once(self) -> None:
        managed_trial_id, _ = self.prepare_binding("agent-harness-v2")
        request = {
            "contract_version": gateway.CONTRACT,
            "mode": "open_with_safety_boundary",
            "binding": gateway.BINDING,
            "identity_role": "candidate_observer",
            "scope_contract_version": gateway.SCOPE_CONTRACT,
            "request_id": "observe-1",
            "trial_id": "trial-1",
            "context_digest": "a" * 64,
            "environment_ref": "evalos-twin:trial-1",
            "capability": "runtime_state",
            "resource_refs": [{
                "identifier_domain": "opsmind-twin",
                "namespace": managed_trial_id,
                "resource_type": "workload",
                "resource_id": "ue-1",
            }],
            "parameters": {},
        }
        with patch.object(gateway, "base_observe", return_value={"ueransim": {"ue": True}}):
            response = gateway.observe_agent_harness(request)
        self.assertTrue(response["ok"])
        self.assertTrue(response["records"][0]["active"])
        audit_lines = (self.trial_root / managed_trial_id / "candidate-observation-audit.jsonl") \
            .read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(audit_lines), 1)
        escaped = {**request, "resource_refs": [{**request["resource_refs"][0], "resource_id": "amf"}]}
        rejected = gateway.candidate_request("agent-harness-v2", escaped)
        self.assertFalse(rejected["ok"])
        self.assertEqual(rejected["error"]["code"], "CANDIDATE_OBSERVATION_SCOPE_DENIED")
        audit_lines = (self.trial_root / managed_trial_id / "candidate-observation-audit.jsonl") \
            .read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(audit_lines), 2)

    def test_langgraph_health_and_service_scope_match_product_contract(self) -> None:
        managed_trial_id, slot_lease_id = self.prepare_binding("langgraph-v1")
        health = gateway.candidate_request("langgraph-v1", {
            "operation": "health",
            "consumer_id": "opsmind-langgraph",
            "slot_id": "langgraph-slot-1",
            "identity_role": "observer",
            "connector_profile": "candidate-observation-gateway:1.0",
        })
        self.assertTrue(health["ok"])
        self.assertEqual(health["operation"], "health")
        self.assertEqual(health["data"], {
            "contract_version": gateway.CONTRACT,
            "binding": gateway.BINDING,
            "identity_contract_version": gateway.LANGGRAPH_IDENTITY_CONTRACT,
            "identity_role": "observer",
            "connector_profile": gateway.LANGGRAPH_CONNECTOR_PROFILE,
            "scope_contract_version": gateway.LANGGRAPH_SCOPE_CONTRACT,
            "audit_contract_version": gateway.LANGGRAPH_AUDIT_CONTRACT,
            "capabilities": sorted(gateway.CAPABILITIES),
            "namespace_scope_supported": True,
            "read_only": True,
            "trial_scope_enforced": True,
            "cross_trial_access": False,
            "management_identity_reused": False,
            "hidden_evaluation_data_exposed": False,
            "root_or_privileged_required": False,
            "audited": True,
            "forced_command": True,
            "limits_are_safety_fuses_only": True,
            "identity_persistent": True,
        })
        request = {
            "operation": "observe",
            "trial_id": managed_trial_id,
            "slot_lease_id": slot_lease_id,
            "consumer_id": "opsmind-langgraph",
            "slot_id": "langgraph-slot-1",
            "identity_role": "observer",
            "connector_profile": "candidate-observation-gateway:1.0",
            "identity_ttl_seconds": 3600,
            "capability": "service_health",
            "parameters": {
                "resource_id": "ue-1",
                "namespace_id": managed_trial_id,
                "service_id": "ueransim-ue",
            },
        }
        with patch.object(gateway, "base_observe", return_value={
            "processes": {"ueransim": {"ue": True}}, "sessions": {"ue_registered": True},
        }):
            response = gateway.observe_langgraph(request)
        self.assertEqual(response["operation"], "observe")
        self.assertEqual(response["data"]["records"][0]["service_id"], "ueransim-ue")
        escaped = {**request, "parameters": {**request["parameters"], "service_id": "other-service"}}
        rejected = gateway.candidate_request("langgraph-v1", escaped)
        self.assertFalse(rejected["ok"])
        self.assertEqual(rejected["error"]["code"], "CANDIDATE_OBSERVATION_SCOPE_DENIED")

    def test_arbitrary_diagnostic_profile_is_not_a_shell_escape(self) -> None:
        managed_trial_id, _ = self.prepare_binding("agent-harness-v2")
        request = {
            "contract_version": gateway.CONTRACT,
            "mode": "open_with_safety_boundary",
            "binding": gateway.BINDING,
            "identity_role": "candidate_observer",
            "scope_contract_version": gateway.SCOPE_CONTRACT,
            "request_id": "observe-2",
            "trial_id": "trial-1",
            "context_digest": "a" * 64,
            "environment_ref": "evalos-twin:trial-1",
            "capability": "sandboxed_readonly_diagnostic",
            "diagnostic_profile": "shell",
            "resource_refs": [{
                "identifier_domain": "opsmind-twin",
                "namespace": managed_trial_id,
                "resource_type": "workload",
                "resource_id": "ue-1",
            }],
            "parameters": {"command": "id"},
        }
        rejected = gateway.candidate_request("agent-harness-v2", request)
        self.assertFalse(rejected["ok"])
        self.assertEqual(rejected["error"]["code"], "CANDIDATE_OBSERVATION_REQUEST_INVALID")


if __name__ == "__main__":
    unittest.main()
