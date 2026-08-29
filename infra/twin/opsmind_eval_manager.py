#!/usr/bin/env python3
"""Restricted EvalOS manager for externally prepared candidate Twin Trials.

The EvalOS SSH identity may ask this controller to prepare, inspect and reset
one frozen protocol-lab Trial.  It cannot select a command, path, user, host or
arbitrary argument.  Candidate products keep using their own least-privilege
observer/action/verifier identities after the Trial has been prepared.
"""

from __future__ import annotations

import base64
import binascii
import datetime as dt
import hashlib
import json
import os
import pwd
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
CANDIDATE_GATEWAY = Path("/usr/local/sbin/opsmind-candidate-observation-gateway")
OPERATIONS = {
    "status", "prepare", "snapshot", "reset", "candidate_health", "candidate_observe",
    "candidate_authorize",
}
OBSERVATION_PROFILES = {
    "public-baseline",
    "hidden-benign-noise",
    "safety-untrusted-instruction",
    "regression-first-observation-fails",
}
REGRESSION_FAILURE_MODES = {"source_unavailable", "timeout"}
CANDIDATE_OBSERVER_AUTHORIZED_KEYS = Path(
    "/home/opsmind_lg_candidate_observer/.ssh/authorized_keys"
)


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


def gateway_call(operation: str, request: dict[str, Any] | None = None,
                 contestant_ref: str | None = None) -> dict[str, Any]:
    if not CANDIDATE_GATEWAY.is_file():
        raise RuntimeError("candidate observation gateway is not installed")
    if operation == "health":
        return run_json([str(CANDIDATE_GATEWAY), "health", str(contestant_ref)], timeout=45)
    encoded = base64.urlsafe_b64encode(
        json.dumps(request or {}, ensure_ascii=False, separators=(",", ":")).encode()
    ).decode().rstrip("=")
    if operation == "request":
        return run_json([str(CANDIDATE_GATEWAY), "request", str(contestant_ref), encoded])
    return run_json([str(CANDIDATE_GATEWAY), operation, encoded], timeout=45)


def validate(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise ValueError("request must be an object")
    operation = str(request.get("operation", ""))
    contestant_ref = str(request.get("contestant_ref", ""))
    if operation not in OPERATIONS:
        raise ValueError("unsupported manager operation")
    if contestant_ref not in CONTROLLERS:
        raise ValueError("unsupported contestant_ref")
    if operation not in {"status", "candidate_health", "candidate_observe", "candidate_authorize"}:
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
        profile = request.get("observation_profile")
        if profile not in OBSERVATION_PROFILES:
            raise ValueError("invalid observation_profile")
        if profile == "regression-first-observation-fails" and request.get("regression_failure_mode") not in REGRESSION_FAILURE_MODES:
            raise ValueError("invalid regression_failure_mode")
        evalos_trial_id = str(request.get("evalos_trial_id", ""))
        context_digest = str(request.get("context_digest", ""))
        environment_ref = str(request.get("environment_ref", ""))
        if not ID_RE.fullmatch(evalos_trial_id):
            raise ValueError("invalid evalos_trial_id")
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", context_digest):
            raise ValueError("invalid context_digest")
        if not ID_RE.fullmatch(environment_ref):
            raise ValueError("invalid environment_ref")
        if not isinstance(request.get("resource_refs"), list) or not request["resource_refs"]:
            raise ValueError("candidate resource_refs are required")
        if not isinstance(request.get("service_ids"), list) or not request["service_ids"]:
            raise ValueError("candidate service_ids are required")
    if operation == "candidate_observe":
        if not isinstance(request.get("candidate_request"), dict):
            raise ValueError("candidate_request must be an object")
    if operation == "candidate_authorize":
        if contestant_ref != "langgraph-v1":
            raise ValueError("candidate_authorize is only available for the independent SSH candidate")
        validate_candidate_authorization(request)
    return request


def validate_candidate_authorization(request: dict[str, Any]) -> tuple[str, str, str]:
    parts = str(request.get("public_key") or "").strip().split()
    if len(parts) < 2 or parts[0] != "ssh-ed25519":
        raise ValueError("candidate observer public key must be Ed25519")
    try:
        blob = base64.b64decode(parts[1], validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("candidate observer public key encoding is invalid") from exc
    algorithm = b"ssh-ed25519"
    expected = len(algorithm).to_bytes(4, "big") + algorithm
    if not blob.startswith(expected) or len(blob) != len(expected) + 4 + 32:
        raise ValueError("candidate observer public key payload is invalid")
    key_length = int.from_bytes(blob[len(expected):len(expected) + 4], "big")
    if key_length != 32:
        raise ValueError("candidate observer public key payload is invalid")
    expires_text = str(request.get("expires_at") or "")
    try:
        parsed_expiry = dt.datetime.fromisoformat(expires_text.replace("Z", "+00:00"))
        if parsed_expiry.tzinfo is None or parsed_expiry.utcoffset() != dt.timedelta(0):
            raise ValueError("UTC timezone required")
        expires = parsed_expiry.astimezone(dt.timezone.utc)
    except ValueError as exc:
        raise ValueError("candidate observer expiry must be RFC3339 UTC") from exc
    remaining = (expires - dt.datetime.now(dt.timezone.utc)).total_seconds()
    if remaining < 300 or remaining > 86_400:
        raise ValueError("candidate observer authorization must expire in 5 minutes to 24 hours")
    openssh_expiry = format_openssh_expiry(expires)
    fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")
    return parts[1], openssh_expiry, fingerprint


def format_openssh_expiry(
    expires: dt.datetime,
    local_timezone: dt.tzinfo | None = None,
) -> str:
    """Format an expiry accepted by the Twin host's OpenSSH 8.9 build.

    The public manager contract remains RFC3339 UTC.  Only the authorized_keys
    representation is converted to the SSH server's local civil time.  The
    Ubuntu OpenSSH 8.9 build on the Twin accepts the documented local form but
    rejects the otherwise equivalent trailing-``Z`` form.
    """

    local_expiry = expires.astimezone(local_timezone) if local_timezone else expires.astimezone()
    return local_expiry.strftime("%Y%m%d%H%M%S")


def install_candidate_authorization(request: dict[str, Any]) -> dict[str, Any]:
    encoded_key, openssh_expiry, fingerprint = validate_candidate_authorization(request)
    account = pwd.getpwnam("opsmind_lg_candidate_observer")
    directory = CANDIDATE_OBSERVER_AUTHORIZED_KEYS.parent
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chown(directory, account.pw_uid, account.pw_gid)
    os.chmod(directory, 0o700)
    options = (
        'restrict,command="/usr/local/sbin/opsmind-candidate-observation-ssh-gateway",'
        f'expiry-time="{openssh_expiry}"'
    )
    content = f"{options} ssh-ed25519 {encoded_key} evalos-langgraph-candidate-observer\n"
    temporary = CANDIDATE_OBSERVER_AUTHORIZED_KEYS.with_suffix(".tmp")
    temporary.write_text(content, encoding="utf-8")
    os.chown(temporary, account.pw_uid, account.pw_gid)
    os.chmod(temporary, 0o600)
    temporary.replace(CANDIDATE_OBSERVER_AUTHORIZED_KEYS)
    return {
        "ok": True,
        "operation": "candidate_authorize",
        "contestant_ref": "langgraph-v1",
        "identity_role": "candidate_observer",
        "public_key_fingerprint": fingerprint,
        "expires_at": str(request["expires_at"]),
        "management_identity_reused": False,
    }


def controller_status(contestant_ref: str) -> dict[str, Any]:
    controller = str(CONTROLLERS[contestant_ref]["path"])
    return run_json([controller, "manage-status"], timeout=45)


def rollback_prepared_trial(contestant_ref: str, controller: str, trial_id: str) -> bool:
    """Best-effort exact-Trial rollback after a partial prepare."""

    try:
        before = public_status(contestant_ref, controller_status(contestant_ref))
        if before.get("active_trial") not in {None, trial_id}:
            return False
        if before.get("active_trial") == trial_id:
            response = run_json([controller, "manage-reset", trial_id])
            reset_clean = response.get("ok") is True and response.get("clean") is True
        else:
            reset_clean = before.get("slot_available") is True
        status = public_status(contestant_ref, controller_status(contestant_ref))
        cleared = gateway_call("clear", {
            "contestant_ref": contestant_ref,
            "managed_trial_id": trial_id,
        })
        return (
            reset_clean
            and status.get("slot_available") is True
            and cleared.get("ok") is True
        )
    except Exception:
        return False


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

    if operation == "candidate_health":
        return gateway_call("health", contestant_ref=contestant_ref)

    if operation == "candidate_observe":
        return gateway_call("request", request=dict(request["candidate_request"]), contestant_ref=contestant_ref)

    if operation == "candidate_authorize":
        status = public_status(contestant_ref, controller_status(contestant_ref))
        if status.get("active_trial") is not None or status.get("slot_available") is not True:
            return error(operation, "TWIN_SLOT_BUSY", "candidate identity cannot rotate during an active Trial")
        return install_candidate_authorization(request)

    trial_id = str(request["trial_id"])
    if operation == "prepare":
        before = public_status(contestant_ref, controller_status(contestant_ref))
        active = before.get("active_trial")
        if active and active != trial_id:
            return error(operation, "TWIN_SLOT_BUSY", "another candidate Trial owns the protocol-lab slot")
        idempotent = active == trial_id and before.get("slot_lease_present")
        response: dict[str, Any] = {}
        if not idempotent:
            response = run_json([
                controller,
                "manage-prepare",
                trial_id,
                str(request["scenario_id"]),
                str(request.get("seed", 0)),
            ])
            if response.get("ok") is not True:
                return error(operation, "PREPARE_FAILED", str(response.get("error") or "candidate Twin prepare failed"))
        profile_response = base_call({
            "operation": "configure_profile",
            "trial_id": trial_id,
            "observation_profile": request["observation_profile"],
            "regression_failure_mode": request.get("regression_failure_mode"),
            "overlay_contract_version": request.get("overlay_contract_version") or "1.0.0",
            "baseline_ref": request.get("baseline_ref") or "opsmind-m2-baseline-v1",
        })
        if profile_response.get("ok") is not True:
            rolled_back = rollback_prepared_trial(contestant_ref, controller, trial_id)
            if not rolled_back:
                return error(operation, "PREPARE_ROLLBACK_FAILED",
                             "candidate Twin profile failed and the exact Trial rollback did not prove clean")
            detail = profile_response.get("error") or "candidate Twin profile configuration failed"
            return error(operation, "PROFILE_CONFIG_FAILED", str(detail))
        after = public_status(contestant_ref, controller_status(contestant_ref))
        if after.get("active_trial") != trial_id or not after.get("slot_lease_present"):
            rolled_back = rollback_prepared_trial(contestant_ref, controller, trial_id)
            if not rolled_back:
                return error(operation, "PREPARE_ROLLBACK_FAILED",
                             "candidate Twin lease verification failed and rollback did not prove clean")
            return error(operation, "LEASE_NOT_ISSUED", "candidate Twin did not issue an isolated slot lease")
        binding_response = gateway_call("bind", {
            "contestant_ref": contestant_ref,
            "evalos_trial_id": request["evalos_trial_id"],
            "managed_trial_id": trial_id,
            "context_digest": request["context_digest"],
            "environment_ref": request["environment_ref"],
            "resource_refs": request["resource_refs"],
            "service_ids": request["service_ids"],
        })
        if binding_response.get("ok") is not True:
            rolled_back = rollback_prepared_trial(contestant_ref, controller, trial_id)
            if not rolled_back:
                return error(operation, "PREPARE_ROLLBACK_FAILED",
                             "candidate observation binding failed and the exact Trial rollback did not prove clean")
            return error(operation, "CANDIDATE_BINDING_FAILED", str(
                binding_response.get("error") or "candidate observation binding failed"
            ))
        return {
            "ok": True,
            "operation": "prepare",
            "contestant_ref": contestant_ref,
            "trial_id": trial_id,
            "scenario_id": str(request["scenario_id"]),
            "observation_profile": profile_response.get("observation_profile"),
            "regression_failure_mode": profile_response.get("regression_failure_mode"),
            "profile_digest": profile_response.get("profile_digest"),
            "scenario_clock": profile_response.get("scenario_clock"),
            "fingerprint": profile_response.get("fingerprint") or response.get("fingerprint"),
            "isolation": (response.get("data") or {}).get("isolation", "exclusive_trial"),
            "slot_lease_present": True,
            "candidate_observation_bound": True,
            "candidate_binding_digest": binding_response.get("binding_digest"),
            "idempotent": bool(idempotent or profile_response.get("idempotent")),
            "topology": (response.get("data") or {}).get("topology") or after.get("topology"),
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
        binding_clear = gateway_call("clear", {
            "contestant_ref": contestant_ref,
            "managed_trial_id": trial_id,
        })
        health = base_call({"operation": "health"})
        clean = health.get("active_trial") is None and binding_clear.get("ok") is True
        return {
            "ok": clean,
            "operation": "reset",
            "contestant_ref": contestant_ref,
            "trial_id": trial_id,
            "clean": clean,
            "idempotent": True,
            "baseline": health.get("baseline"),
            "candidate_binding_cleared": binding_clear.get("ok") is True,
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
    binding_clear = gateway_call("clear", {"contestant_ref": contestant_ref, "managed_trial_id": trial_id})
    clean = clean and binding_clear.get("ok") is True
    return {
        "ok": clean,
        "operation": "reset",
        "contestant_ref": contestant_ref,
        "trial_id": trial_id,
        "clean": clean,
        "reset_hash": response.get("reset_hash"),
        "baseline_ref": response.get("baseline_ref"),
        "slot_available": after.get("slot_available") is True,
        "candidate_binding_cleared": binding_clear.get("ok") is True,
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
