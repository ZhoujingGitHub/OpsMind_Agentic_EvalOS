from __future__ import annotations

import base64
import importlib.util
from pathlib import Path
import stat
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("opsmind_eval_manager.py")
if sys.platform == "win32":
    sys.modules.setdefault("pwd", types.SimpleNamespace())
SPEC = importlib.util.spec_from_file_location("opsmind_eval_manager_tested", MODULE_PATH)
assert SPEC and SPEC.loader
manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manager)


def controller_status(active_trial: str | None, *, available: bool) -> dict:
    return {
        "ok": True,
        "manager_active_trial": active_trial,
        "data": {
            "slot_available": available,
            "slot_lease_id": "private-lease" if active_trial else None,
        },
    }


class EvalManagerRollbackTests(unittest.TestCase):
    @staticmethod
    def candidate_authorization() -> dict:
        algorithm = b"ssh-ed25519"
        blob = len(algorithm).to_bytes(4, "big") + algorithm + (32).to_bytes(4, "big") + bytes(range(32))
        public_key = "ssh-ed25519 " + base64.b64encode(blob).decode() + " product-generated"
        return {"operation": "candidate_authorize", "contestant_ref": "langgraph-v1",
                "public_key": public_key,
                "identity_contract_version": manager.PERSISTENT_CANDIDATE_IDENTITY,
                "identity_lifetime": "persistent"}

    def test_partial_prepare_rolls_back_only_the_exact_trial_and_clears_binding(self) -> None:
        statuses = [
            controller_status("ah-trial-1", available=False),
            controller_status(None, available=True),
        ]
        with (
            patch.object(manager, "controller_status", side_effect=statuses),
            patch.object(manager, "run_json", return_value={"ok": True, "clean": True}) as run_json,
            patch.object(manager, "gateway_call", return_value={"ok": True}) as gateway_call,
        ):
            self.assertTrue(manager.rollback_prepared_trial(
                "agent-harness-v2", "/usr/local/sbin/opsmind-harness-labctl", "ah-trial-1"
            ))
        run_json.assert_called_once_with([
            "/usr/local/sbin/opsmind-harness-labctl", "manage-reset", "ah-trial-1",
        ])
        gateway_call.assert_called_once_with("clear", {
            "contestant_ref": "agent-harness-v2", "managed_trial_id": "ah-trial-1",
        })

    def test_partial_prepare_never_resets_or_clears_a_foreign_active_trial(self) -> None:
        with (
            patch.object(manager, "controller_status",
                         return_value=controller_status("ah-foreign", available=False)),
            patch.object(manager, "run_json") as run_json,
            patch.object(manager, "gateway_call") as gateway_call,
        ):
            self.assertFalse(manager.rollback_prepared_trial(
                "agent-harness-v2", "/usr/local/sbin/opsmind-harness-labctl", "ah-trial-1"
            ))
        run_json.assert_not_called()
        gateway_call.assert_not_called()

    def test_idempotent_reset_is_not_clean_when_candidate_binding_remains(self) -> None:
        request = {
            "operation": "reset", "contestant_ref": "agent-harness-v2", "trial_id": "ah-trial-1",
        }
        with (
            patch.object(manager.Path, "is_file", return_value=True),
            patch.object(manager, "controller_status",
                         return_value=controller_status(None, available=True)),
            patch.object(manager, "gateway_call", return_value={"ok": False}),
            patch.object(manager, "base_call", return_value={"ok": True, "active_trial": None,
                                                               "baseline": {"clean": True}}),
        ):
            response = manager.dispatch(request)
        self.assertFalse(response["ok"])
        self.assertFalse(response["clean"])
        self.assertFalse(response["candidate_binding_cleared"])

    def test_candidate_authorization_installs_only_a_persistent_restricted_public_key(self) -> None:
        request = self.candidate_authorization()
        with tempfile.TemporaryDirectory() as temporary:
            authorized_keys = Path(temporary) / ".ssh" / "authorized_keys"
            account = types.SimpleNamespace(pw_uid=1001, pw_gid=1001)
            with (
                patch.object(manager, "CANDIDATE_OBSERVER_AUTHORIZED_KEYS", authorized_keys),
                patch.object(manager.pwd, "getpwnam", return_value=account, create=True),
                patch.object(manager.os, "chown", create=True),
            ):
                response = manager.install_candidate_authorization(request)
            content = authorized_keys.read_text(encoding="utf-8")
            self.assertTrue(content.startswith(
                'restrict,command="/usr/local/sbin/opsmind-candidate-observation-ssh-gateway" '
            ))
            self.assertNotIn("expiry-time", content)
            self.assertIn(" ssh-ed25519 ", content)
            self.assertNotIn("PRIVATE", content)
            if sys.platform != "win32":
                self.assertEqual(stat.S_IMODE(authorized_keys.stat().st_mode), 0o600)
            self.assertEqual(response["identity_role"], "candidate_observer")
            self.assertEqual(response["identity_lifetime"], "persistent")
            self.assertTrue(response["public_key_fingerprint"].startswith("SHA256:"))

    def test_candidate_authorization_rejects_the_removed_expiring_contract(self) -> None:
        request = {**self.candidate_authorization(), "expires_at": "2026-08-30T00:00:00Z"}
        with self.assertRaisesRegex(ValueError, "persistent restricted SSH identity"):
            manager.validate_candidate_authorization(request)

    def test_candidate_authorization_is_refused_while_a_trial_is_active(self) -> None:
        with (
            patch.object(manager.Path, "is_file", return_value=True),
            patch.object(manager, "controller_status",
                         return_value=controller_status("lg-trial-1", available=False)),
            patch.object(manager, "install_candidate_authorization") as install,
        ):
            response = manager.dispatch(self.candidate_authorization())
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "TWIN_SLOT_BUSY")
        install.assert_not_called()


if __name__ == "__main__":
    unittest.main()
