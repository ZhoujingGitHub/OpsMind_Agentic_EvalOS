#!/usr/bin/env python3
"""Restricted EvalOS manager for externally prepared candidate Twin Trials.

The EvalOS SSH identity may ask this controller to prepare, inspect and reset
one frozen protocol-lab Trial.  It cannot select a command, path, user, host or
arbitrary argument.  Candidate products keep using their own least-privilege
observer/action/verifier identities after the Trial has been prepared.
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
CONTROLLERS = {
    "agent-harness-v2": {
        "prefix": "ah-",
        "path": Path("/usr/local/sbin/opsmind-harness-labctl"),
    },
    "langgraph-v1": {
        "prefix": "lg-",
        "path": Path("/usr/local/sbin/opsmind-langgraph-labctl"),
    },
}
BASE = Path("/usr/local/sbin/opsmind-twinctl")
OPERATIONS = {"status", "prepare", "snapshot", "reset"}


def error(operation: str, code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "operation": operation, "error": {"code": code, "message": message}}


def run_json(args: list[str], timeout: int = 180) -> dict[str, Any]:
    result = subprocess.run(
        args,
        check=False,
        timeout=timeout,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    for line in reversed((result.stdout or "").splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise RuntimeError(f"controller returned no structured response (exit={result.returncode})")


def base_call(request: dict[str, Any]) -> dict[str, Any]:
    encoded = base64.urlsafe_b64encode(
        json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()
    ).decode().rstrip("=")
    return run_json([str(BASE), "request", encoded])


def validate(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise ValueError("request must be an object")
    operation = str(request.get("operation", ""))
    contestant_ref = str(request.get("contestant_ref", ""))
    if operation not in OPERATIONS:
        raise ValueError("unsupported manager operation")
    if contestant_ref not in CONTROLLERS:
        raise ValueError("unsupported contestant_ref")
    if operation != "status":
        trial_id = str(request.get("trial_id", ""))
        prefix = str(CONTROLLERS[contestant_ref]["prefix"])
        if not ID_RE.fullmatch(trial_id) or not trial_id.startswith(prefix):
            raise ValueError(f"trial_id must be in the {prefix} namespace")
    if operation == "prepare":
        scenario_id = str(request.get("scenario_id", ""))
        if not ID_RE.fullmatch(scenario_id):
            raise ValueError("invalid scenario_id")
        seed = request.get("seed", 0)
        if isinstance(seed, bool) or not isinstance(seed, int):
            raise ValueError("seed must be an integer")
    return request


def controller_status(contestant_ref: str) -> dict[str, Any]:
    controller = str(CONTROLLERS[contestant_ref]["path"])
    return run_json([controller, "manage-status"], timeout=45)


def public_status(contestant_ref: str, response: dict[str, Any]) -> dict[str, Any]:
    data = dict(response.get("data") or {})
    return {
        "ok": response.get("ok") is True,
        "operation": "status",
        "contestant_ref": contestant_ref,
        "active_trial": response.get("manager_active_trial"),
        "slot_available": data.get("slot_available") is True,
        "slot_lease_present": bool(data.get("slot_lease_id")),
        "controller_status": response.get("status") or data.get("base", {}).get("status"),
        "topology": data.get("topology"),
    }


def dispatch(raw_request: Any) -> dict[str, Any]:
    request = validate(raw_request)
    operation = str(request["operation"])
    contestant_ref = str(request["contestant_ref"])
    controller = str(CONTROLLERS[contestant_ref]["path"])
    if not Path(controller).is_file():
        return error(operation, "CONTROLLER_UNAVAILABLE", "candidate protocol-lab controller is not installed")

    if operation == "status":
        return public_status(contestant_ref, controller_status(contestant_ref))

    trial_id = str(request["trial_id"])
    if operation == "prepare":
        before = public_status(contestant_ref, controller_status(contestant_ref))
        active = before.get("active_trial")
        if active and active != trial_id:
            return error(operation, "TWIN_SLOT_BUSY", "another candidate Trial owns the protocol-lab slot")
        if active == trial_id and before.get("slot_lease_present"):
            return {**before, "operation": "prepare", "idempotent": True, "trial_id": trial_id}
        response = run_json([
            controller,
            "manage-prepare",
            trial_id,
            str(request["scenario_id"]),
            str(request.get("seed", 0)),
        ])
        if response.get("ok") is not True:
            return error(operation, "PREPARE_FAILED", str(response.get("error") or "candidate Twin prepare failed"))
        after = public_status(contestant_ref, controller_status(contestant_ref))
        if after.get("active_trial") != trial_id or not after.get("slot_lease_present"):
            return error(operation, "LEASE_NOT_ISSUED", "candidate Twin did not issue an isolated slot lease")
        return {
            "ok": True,
            "operation": "prepare",
            "contestant_ref": contestant_ref,
            "trial_id": trial_id,
            "scenario_id": str(request["scenario_id"]),
            "fingerprint": response.get("fingerprint"),
            "isolation": (response.get("data") or {}).get("isolation", "exclusive_trial"),
            "slot_lease_present": True,
            "topology": (response.get("data") or {}).get("topology"),
        }

    if operation == "snapshot":
        status = public_status(contestant_ref, controller_status(contestant_ref))
        if status.get("active_trial") is None and status.get("slot_available"):
            return {
                "ok": True,
                "operation": "snapshot",
                "contestant_ref": contestant_ref,
                "trial_id": trial_id,
                "already_reset": True,
                "snapshot": None,
            }
        if status.get("active_trial") != trial_id:
            return error(operation, "TRIAL_SCOPE_MISMATCH", "requested Trial does not own the active Twin slot")
        response = base_call({"operation": "snapshot", "trial_id": trial_id})
        if response.get("ok") is not True:
            return error(operation, "SNAPSHOT_FAILED", str(response.get("error") or "Twin snapshot failed"))
        return {
            "ok": True,
            "operation": "snapshot",
            "contestant_ref": contestant_ref,
            "trial_id": trial_id,
            "snapshot": response.get("snapshot") or {},
            "snapshot_hash": response.get("snapshot_hash"),
        }

    status = public_status(contestant_ref, controller_status(contestant_ref))
    if status.get("active_trial") is None and status.get("slot_available"):
        health = base_call({"operation": "health"})
        return {
            "ok": health.get("active_trial") is None,
            "operation": "reset",
            "contestant_ref": contestant_ref,
            "trial_id": trial_id,
            "clean": health.get("active_trial") is None,
            "idempotent": True,
            "baseline": health.get("baseline"),
        }
    if status.get("active_trial") != trial_id:
        return error(operation, "TRIAL_SCOPE_MISMATCH", "refusing to reset a different active Twin Trial")
    response = run_json([controller, "manage-reset", trial_id])
    after = public_status(contestant_ref, controller_status(contestant_ref))
    health = base_call({"operation": "health"})
    clean = (
        response.get("ok") is True
        and response.get("clean") is True
        and after.get("slot_available") is True
        and health.get("active_trial") is None
    )
    return {
        "ok": clean,
        "operation": "reset",
        "contestant_ref": contestant_ref,
        "trial_id": trial_id,
        "clean": clean,
        "reset_hash": response.get("reset_hash"),
        "baseline_ref": response.get("baseline_ref"),
        "slot_available": after.get("slot_available") is True,
    }


def main() -> int:
    if os.geteuid() != 0:
        print(json.dumps(error("unknown", "ROOT_REQUIRED", "manager must run as root")))
        return 1
    if len(sys.argv) != 3 or sys.argv[1] != "request":
        print(json.dumps(error("unknown", "USAGE", "use opsmind-eval-manager request <base64url-json>")))
        return 2
    request: dict[str, Any] = {}
    try:
        encoded = sys.argv[2] + "=" * (-len(sys.argv[2]) % 4)
        request = json.loads(base64.urlsafe_b64decode(encoded).decode("utf-8"))
        response = dispatch(request)
        print(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
        return 0 if response.get("ok") else 3
    except Exception as exc:
        operation = str(request.get("operation", "unknown"))
        print(json.dumps(error(operation, "EVAL_MANAGER_ERROR", str(exc)), ensure_ascii=False))
        return 5


if __name__ == "__main__":
    raise SystemExit(main())
