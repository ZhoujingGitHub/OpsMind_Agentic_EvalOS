from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("opsmind_eval_manager.py")
SPEC = importlib.util.spec_from_file_location("opsmind_eval_manager_tested", MODULE_PATH)
assert SPEC and SPEC.loader
manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manager)


def physical_lease(active_trial: str | None) -> dict:
    return {
        "contract_version": "opsmind-physical-lab-lease/1.0",
        "status": "in_use" if active_trial else "idle",
        "owner_mode": "evalos_trial" if active_trial else None,
        "candidate_ref": "langgraph-v1" if active_trial else None,
        "trial_id": "trial-qualification-1" if active_trial else None,
        "runtime_trial_id": active_trial,
        "lease_id": "physical-lease" if active_trial else None,
        "expires_at": "2026-09-01T10:00:00.000Z" if active_trial else None,
        "boot_id": "lab-boot-1",
        "updated_at": "2026-09-01T09:00:00.000Z",
    }


def controller_status(active_trial: str | None, *, available: bool) -> dict:
    return {
        "ok": True,
        "manager_active_trial": active_trial,
        "data": {
            "slot_available": available,
            "slot_lease_id": "private-lease" if active_trial else None,
            "physical_lease": physical_lease(active_trial),
        },
    }


class EvalManagerTests(unittest.TestCase):
    def test_partial_prepare_rolls_back_only_the_exact_trial(self) -> None:
        statuses = [
            controller_status("ah-trial-1", available=False),
            controller_status(None, available=True),
        ]
        with (
            patch.object(manager, "controller_status", side_effect=statuses),
            patch.object(
                manager, "run_json", return_value={"ok": True, "clean": True}
            ) as run_json,
        ):
            self.assertTrue(
                manager.rollback_prepared_trial(
                    "agent-harness-v2",
                    "/usr/local/sbin/opsmind-harness-labctl",
                    "ah-trial-1",
                )
            )
        run_json.assert_called_once_with(
            [
                "/usr/local/sbin/opsmind-harness-labctl",
                "manage-reset",
                "ah-trial-1",
            ]
        )

    def test_partial_prepare_never_resets_a_foreign_active_trial(self) -> None:
        with (
            patch.object(
                manager,
                "controller_status",
                return_value=controller_status("ah-foreign", available=False),
            ),
            patch.object(manager, "run_json") as run_json,
        ):
            self.assertFalse(
                manager.rollback_prepared_trial(
                    "agent-harness-v2",
                    "/usr/local/sbin/opsmind-harness-labctl",
                    "ah-trial-1",
                )
            )
        run_json.assert_not_called()

    def test_evalos_prepare_returns_the_public_physical_lease(self) -> None:
        request = {
            "operation": "prepare",
            "contestant_ref": "langgraph-v1",
            "trial_id": "lg-managed-1",
            "scenario_id": "amf-process-down",
            "seed": 0,
            "observation_profile": "public-baseline",
            "evalos_trial_id": "trial-qualification-1",
            "context_digest": "sha256:" + "a" * 64,
            "environment_ref": "evalos-twin:trial-qualification-1",
            "resource_refs": [
                {
                    "identifier_domain": "opsmind-twin",
                    "namespace": "lg-managed-1",
                    "resource_type": "workload",
                    "resource_id": "ue-1",
                }
            ],
            "service_ids": ["ueransim-ue"],
        }
        statuses = [
            controller_status(None, available=True),
            controller_status("lg-managed-1", available=False),
        ]
        with (
            patch.object(manager.Path, "is_file", return_value=True),
            patch.object(manager, "controller_status", side_effect=statuses),
            patch.object(
                manager,
                "run_json",
                return_value={
                    "ok": True,
                    "fingerprint": "fingerprint",
                    "data": {"slot_lease_id": "private-lease"},
                },
            ) as run_json,
            patch.object(
                manager,
                "base_call",
                return_value={
                    "ok": True,
                    "observation_profile": "public-baseline",
                    "profile_digest": "profile",
                    "scenario_clock": "clock",
                },
            ),
        ):
            response = manager.dispatch(request)
        self.assertTrue(response["ok"])
        self.assertTrue(response["candidate_runtime_lease_bound"])
        self.assertEqual(response["physical_lease"]["lease_id"], "physical-lease")
        run_json.assert_called_once_with(
            [
                str(manager.CONTROLLERS["langgraph-v1"]["path"]),
                "manage-prepare",
                "lg-managed-1",
                "amf-process-down",
                "0",
                "evalos_trial",
                "trial-qualification-1",
            ]
        )

    def test_idempotent_reset_is_clean_only_when_lab_health_is_idle(self) -> None:
        request = {
            "operation": "reset",
            "contestant_ref": "agent-harness-v2",
            "trial_id": "ah-trial-1",
        }
        with (
            patch.object(manager.Path, "is_file", return_value=True),
            patch.object(
                manager,
                "controller_status",
                return_value=controller_status(None, available=True),
            ),
            patch.object(
                manager,
                "base_call",
                return_value={
                    "ok": True,
                    "active_trial": None,
                    "baseline": {"clean": True},
                },
            ),
        ):
            response = manager.dispatch(request)
        self.assertTrue(response["ok"])
        self.assertTrue(response["clean"])

    def test_removed_candidate_supervision_operations_are_rejected(self) -> None:
        for operation in (
            "candidate_authorize",
            "candidate_health",
            "candidate_observe",
        ):
            with self.assertRaisesRegex(ValueError, "unsupported manager operation"):
                manager.validate(
                    {"operation": operation, "contestant_ref": "langgraph-v1"}
                )


if __name__ == "__main__":
    unittest.main()
