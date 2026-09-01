from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).with_name("opsmind_twinctl.py")
if "fcntl" not in sys.modules:
    sys.modules["fcntl"] = types.SimpleNamespace(LOCK_EX=2, flock=lambda *_: None)
SPEC = importlib.util.spec_from_file_location("opsmind_twinctl", MODULE_PATH)
assert SPEC and SPEC.loader
twinctl = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(twinctl)


class PhysicalLeaseTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.boot_file = self.root / "boot_id"
        self.boot_file.write_text("boot-one", encoding="ascii")
        self.patches = [
            mock.patch.object(twinctl, "ROOT", self.root),
            mock.patch.object(twinctl, "PHYSICAL_LEASE_FILE", self.root / "physical-lease.json"),
            mock.patch.object(twinctl, "STATE_FILE", self.root / "active.json"),
            mock.patch.object(twinctl, "BOOT_ID_FILE", self.boot_file),
            mock.patch.object(twinctl, "CONTROLLER_RELEASE_FILE", self.root / "RELEASE.json"),
        ]
        for patcher in self.patches:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in reversed(self.patches):
            patcher.stop()
        self.temporary.cleanup()

    @staticmethod
    def prepare_request(**overrides: object) -> dict:
        request = {
            "operation": "prepare",
            "trial_id": "lg-direct-check-1",
            "scenario_id": "amf-process-down",
            "seed": 0,
            "owner_mode": "langgraph_direct",
            "candidate_ref": "langgraph-v1",
            "evalos_trial_id": None,
            "lease_ttl_seconds": 7200,
        }
        request.update(overrides)
        return request

    def establish_idle(self) -> dict:
        with mock.patch.object(twinctl, "reset_baseline", return_value={
            "ok": True,
            "clean": True,
            "baseline_ref": "opsmind-m2-baseline-v1",
            "verification": {"clean": True},
        }):
            response = twinctl.recover({"operation": "recover"})
        self.assertTrue(response["clean"])
        return response["physical_lease"]

    def test_first_upgrade_requires_one_explicit_clean_recovery(self) -> None:
        lease = twinctl.load_physical_lease()
        self.assertEqual(lease["status"], "quarantined")
        self.assertEqual(lease["boot_id"], "boot-one")
        idle = self.establish_idle()
        self.assertEqual(idle["status"], "idle")

    def test_one_physical_lease_blocks_a_second_mode(self) -> None:
        self.establish_idle()
        lease = twinctl.acquire_physical_lease(self.prepare_request())
        self.assertEqual(lease["owner_mode"], "langgraph_direct")
        self.assertEqual(lease["candidate_ref"], "langgraph-v1")
        self.assertEqual(lease["runtime_trial_id"], "lg-direct-check-1")
        self.assertIsNone(lease["trial_id"])
        with self.assertRaisesRegex(PermissionError, "not idle"):
            twinctl.acquire_physical_lease(self.prepare_request(
                trial_id="ah-direct-check-1",
                owner_mode="agent_harness_direct",
                candidate_ref="agent-harness-v2",
            ))

    def test_host_reboot_quarantines_even_a_previously_idle_lease(self) -> None:
        self.establish_idle()
        self.boot_file.write_text("boot-two", encoding="ascii")
        lease = twinctl.load_physical_lease()
        self.assertEqual(lease["status"], "quarantined")
        self.assertEqual(lease["boot_id"], "boot-one")

    def test_evalos_lease_keeps_external_and_runtime_trial_ids(self) -> None:
        self.establish_idle()
        request = self.prepare_request(
            trial_id="ah-managed-1",
            owner_mode="evalos_trial",
            candidate_ref="agent-harness-v2",
            evalos_trial_id="trial-qualification-agent-1",
        )
        twinctl.validate_request(request)
        lease = twinctl.acquire_physical_lease(request)
        self.assertEqual(lease["trial_id"], "trial-qualification-agent-1")
        self.assertEqual(lease["runtime_trial_id"], "ah-managed-1")

    def test_invalid_mode_candidate_and_ttl_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "does not match"):
            twinctl.validate_request(self.prepare_request(candidate_ref="agent-harness-v2"))
        with self.assertRaisesRegex(ValueError, "must not claim"):
            twinctl.validate_request(self.prepare_request(evalos_trial_id="trial-wrong"))
        with self.assertRaisesRegex(ValueError, "between 60 and 7200"):
            twinctl.validate_request(self.prepare_request(lease_ttl_seconds=30))

    def test_public_resource_scope_is_complete_and_scenario_independent(self) -> None:
        first = twinctl.public_resource_scope("lg-direct-check-1")
        second = twinctl.public_resource_scope("ah-direct-check-2")
        self.assertEqual(first["contract_version"], "opsmind-lab-resource-scope/1.0")
        self.assertEqual(first["identifier_domain"], "opsmind-twin")
        self.assertEqual(first["namespace"], "lg-direct-check-1")
        self.assertEqual(second["namespace"], "ah-direct-check-2")
        self.assertEqual(
            {item["resource_id"]: item["resource_type"] for item in first["resource_refs"]},
            twinctl.PUBLIC_RESOURCE_TYPES,
        )
        self.assertEqual(
            {item["resource_id"]: item["resource_type"] for item in second["resource_refs"]},
            twinctl.PUBLIC_RESOURCE_TYPES,
        )
        self.assertIn("amf", first["service_ids"])
        self.assertEqual(first["permissions"], ["observations.read"])
        self.assertFalse(first["production"])

    def test_failed_recovery_remains_quarantined(self) -> None:
        twinctl.load_physical_lease()
        with mock.patch.object(twinctl, "reset_baseline", return_value={
            "ok": False,
            "clean": False,
            "baseline_ref": "opsmind-m2-baseline-v1",
            "verification": {"core": False},
        }):
            response = twinctl.recover({"operation": "recover"})
        self.assertFalse(response["ok"])
        self.assertEqual(response["physical_lease"]["status"], "quarantined")

    def test_lease_status_is_lightweight_and_does_not_probe_the_runtime(self) -> None:
        self.establish_idle()
        with mock.patch.object(twinctl, "run") as run:
            response = twinctl.dispatch({"operation": "lease_status"})
        self.assertEqual(response["physical_lease"]["status"], "idle")
        self.assertEqual(response["controller_release"]["status"], "legacy-unversioned")
        run.assert_not_called()

    def test_lease_status_reports_the_installed_controller_release(self) -> None:
        self.establish_idle()
        twinctl.CONTROLLER_RELEASE_FILE.write_text(json.dumps({
            "contract": "opsmind-twin-controller-release/1.0",
            "release_id": "twin-controller-20260901-0123456789",
            "source_revision": "a" * 40,
            "content_digest": "sha256:" + "b" * 64,
            "component_manifest_digest": "sha256:" + "c" * 64,
        }), encoding="utf-8")

        with mock.patch.object(twinctl, "run") as run:
            response = twinctl.dispatch({"operation": "lease_status"})

        self.assertTrue(response["controller_release"]["installed"])
        self.assertEqual(
            response["controller_release"]["release_id"],
            "twin-controller-20260901-0123456789",
        )
        run.assert_not_called()

    def test_legacy_lease_timestamp_is_canonicalized_once(self) -> None:
        lease = {
            **twinctl.idle_physical_lease("boot-one"),
            "updated_at": "2026-09-01T09:00:00.123456Z",
        }
        twinctl.save_physical_lease(lease)

        loaded = twinctl.load_physical_lease()

        self.assertEqual(loaded["updated_at"], "2026-09-01T09:00:00.123Z")
        self.assertEqual(
            twinctl.load_physical_lease()["updated_at"],
            "2026-09-01T09:00:00.123Z",
        )


if __name__ == "__main__":
    unittest.main()
