#!/usr/bin/env python3
"""Trial-scoped read-only observation gateway for real candidate products.

This is an evaluation infrastructure boundary, not an Agent workflow.  It
accepts three semantic observation capabilities, exact frozen resource
references and fixed diagnostic profiles.  It never accepts a shell command,
filesystem path, host, address, port or service name from a candidate.
"""

from __future__ import annotations

import base64
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any


BASE = Path("/usr/local/sbin/opsmind-twinctl")
ROOT = Path("/var/lib/opsmind-candidate-observation")
BINDING_ROOT = ROOT / "bindings"
LOCK = Path("/run/lock/opsmind-candidate-observation.lock")
TRIAL_ROOT = Path("/srv/opsmind-twin/trials")
CONTRACT = "opsmind-candidate-observation-gateway/1.0"
BINDING = "candidate_scoped_trial"
SCOPE_CONTRACT = "opsmind-resource-scope/1.0"
LANGGRAPH_IDENTITY_CONTRACT = "candidate-persistent-ssh-observer/1.0"
LANGGRAPH_SCOPE_CONTRACT = "candidate-trial-scope:1.0"
LANGGRAPH_AUDIT_CONTRACT = "candidate-observation-audit/1.0"
LANGGRAPH_CONNECTOR_PROFILE = "candidate-observation-gateway:1.0"
CAPABILITIES = {"runtime_state", "service_health", "sandboxed_readonly_diagnostic"}
DIAGNOSTIC_PROFILES = {
    "process_summary", "service_status", "container_state", "workload_state", "bounded_log_tail",
}
VALUE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")
DIGEST_RE = re.compile(r"^(?:sha256:)?[a-f0-9]{64}$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

CONTESTANTS = {
    "agent-harness-v2": {
        "prefix": "ah-",
        "consumer_id": "opsmind-harness",
        "slot_id": "harness-slot-1",
        "lease": Path("/var/lib/opsmind-harness-lab/active-lease.json"),
    },
    "langgraph-v1": {
        "prefix": "lg-",
        "consumer_id": "opsmind-langgraph",
        "slot_id": "langgraph-slot-1",
        "lease": Path("/var/lib/opsmind-langgraph-lab/active-lease.json"),
    },
}

SERVICE_NAMES = {
    "amf": "open5gs-amfd",
    "smf": "open5gs-smfd",
    "upf": "open5gs-upfd",
    "nrf": "open5gs-nrfd",
    "mongodb": "mongod",
}
RUNTIME_NAMES = {"gnb-1": "gnb", "ue-1": "ue"}


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def digest(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def error(operation: str, code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "operation": operation, "error": {"code": code, "message": message[:500]}}


def run_json(args: list[str], timeout: int = 180) -> dict[str, Any]:
    result = subprocess.run(
        args, check=False, timeout=timeout, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
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


def base_observe(trial_id: str, capability: str) -> dict[str, Any]:
    response = base_call({"operation": "observe", "trial_id": trial_id, "capability": capability})
    if response.get("ok") is not True:
        detail = response.get("error") or "base observation failed"
        raise RuntimeError(str(detail))
    return dict(response.get("data") or {})


def canonical_digest(value: Any) -> str:
    text = str(value or "").lower()
    if not DIGEST_RE.fullmatch(text):
        raise ValueError("invalid context_digest")
    return text.removeprefix("sha256:")


def canonical_ref(value: Any) -> dict[str, str]:
    expected = {"identifier_domain", "namespace", "resource_type", "resource_id"}
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError("resource reference must contain the exact four-field contract")
    result = {name: str(value[name]).strip() for name in expected}
    if any(not VALUE_RE.fullmatch(item) for item in result.values()):
        raise ValueError("resource reference contains an invalid value")
    return result


def canonical_refs(values: Any) -> list[dict[str, str]]:
    if not isinstance(values, list) or not values:
        raise ValueError("at least one resource reference is required")
    result: list[dict[str, str]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for raw in values:
        item = canonical_ref(raw)
        identity = tuple(item[name] for name in (
            "identifier_domain", "namespace", "resource_type", "resource_id"
        ))
        if identity not in seen:
            seen.add(identity)
            result.append(item)
    return result


def canonical_service_ids(values: Any) -> list[str]:
    if not isinstance(values, list) or not values:
        raise ValueError("at least one service identifier is required")
    result: list[str] = []
    for raw in values:
        value = str(raw).strip()
        if not VALUE_RE.fullmatch(value):
            raise ValueError("service identifier contains an invalid value")
        if value not in result:
            result.append(value)
    return result


def binding_path(contestant_ref: str) -> Path:
    if contestant_ref not in CONTESTANTS:
        raise ValueError("unsupported contestant_ref")
    return BINDING_ROOT / f"{contestant_ref}.json"


def load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def active_lease(contestant_ref: str) -> dict[str, Any]:
    return load_json(Path(CONTESTANTS[contestant_ref]["lease"]))


def load_binding(contestant_ref: str) -> dict[str, Any]:
    return load_json(binding_path(contestant_ref))


def persist_binding(contestant_ref: str, value: dict[str, Any]) -> None:
    BINDING_ROOT.mkdir(parents=True, exist_ok=True)
    path = binding_path(contestant_ref)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def public_health(contestant_ref: str) -> dict[str, Any]:
    config = CONTESTANTS[contestant_ref]
    lease = active_lease(contestant_ref)
    binding_value = load_binding(contestant_ref)
    active_consistent = bool(lease) == bool(binding_value) and (
        not lease or lease.get("trial_id") == binding_value.get("managed_trial_id")
    )
    return {
        "ok": True,
        "operation": "candidate_health",
        "contract_version": CONTRACT,
        "binding": BINDING,
        "identity_role": "candidate_observer",
        "read_only": True,
        "trial_scope_enforced": True,
        "cross_trial_access": False,
        "management_identity_reused": False,
        "hidden_evaluation_data_exposed": False,
        "root_or_privileged_required": False,
        "audited": True,
        "limits_are_safety_fuses_only": True,
        "semantic_capabilities": sorted(CAPABILITIES),
        "contestant_ref": contestant_ref,
        "consumer_id": config["consumer_id"],
        "binding_store_consistent": active_consistent,
    }


def bind(request: dict[str, Any]) -> dict[str, Any]:
    contestant_ref = str(request.get("contestant_ref") or "")
    config = CONTESTANTS.get(contestant_ref)
    if config is None:
        raise ValueError("unsupported contestant_ref")
    evalos_trial_id = str(request.get("evalos_trial_id") or "")
    managed_trial_id = str(request.get("managed_trial_id") or "")
    if not REQUEST_ID_RE.fullmatch(evalos_trial_id):
        raise ValueError("invalid evalos_trial_id")
    if not REQUEST_ID_RE.fullmatch(managed_trial_id) or not managed_trial_id.startswith(str(config["prefix"])):
        raise ValueError("managed_trial_id is outside the contestant namespace")
    context_digest = canonical_digest(request.get("context_digest"))
    environment_ref = str(request.get("environment_ref") or "")
    if not VALUE_RE.fullmatch(environment_ref):
        raise ValueError("invalid environment_ref")
    refs = canonical_refs(request.get("resource_refs"))
    service_ids = canonical_service_ids(request.get("service_ids"))
    if any(item["identifier_domain"] != "opsmind-twin" or item["namespace"] != managed_trial_id for item in refs):
        raise ValueError("resource references are outside the managed Twin namespace")
    lease = active_lease(contestant_ref)
    if lease.get("trial_id") != managed_trial_id or not lease.get("slot_lease_id"):
        raise PermissionError("candidate observation cannot bind without the active product lease")
    material = {
        "contract_version": CONTRACT,
        "binding": BINDING,
        "contestant_ref": contestant_ref,
        "evalos_trial_id": evalos_trial_id,
        "managed_trial_id": managed_trial_id,
        "context_digest": context_digest,
        "environment_ref": environment_ref,
        "scope_contract_version": SCOPE_CONTRACT,
        "resource_refs": refs,
        "service_ids": service_ids,
    }
    existing = load_binding(contestant_ref)
    if existing:
        comparable = {name: existing.get(name) for name in material}
        if comparable != material:
            raise PermissionError("candidate observation is already bound to another Trial context")
        return {"ok": True, "operation": "candidate_bind", "idempotent": True,
                "binding_digest": existing.get("binding_digest")}
    value = {**material, "bound_at": now(), "binding_digest": digest(material)}
    persist_binding(contestant_ref, value)
    return {"ok": True, "operation": "candidate_bind", "idempotent": False,
            "binding_digest": value["binding_digest"]}


def clear(request: dict[str, Any]) -> dict[str, Any]:
    contestant_ref = str(request.get("contestant_ref") or "")
    managed_trial_id = str(request.get("managed_trial_id") or "")
    current = load_binding(contestant_ref)
    if current and current.get("managed_trial_id") != managed_trial_id:
        # A stale binding may only be reconciled after the contestant has no
        # active lease.  Never clear another live Trial's binding.
        if active_lease(contestant_ref):
            raise PermissionError("refusing to clear another active Trial binding")
    path = binding_path(contestant_ref)
    existed = path.exists()
    path.unlink(missing_ok=True)
    return {"ok": True, "operation": "candidate_clear", "cleared": existed, "idempotent": not existed}


def requested_refs_from_langgraph(binding_value: dict[str, Any], parameters: dict[str, Any]) -> list[dict[str, str]]:
    resource_id = str(parameters.get("resource_id") or "")
    namespace_id = str(parameters.get("namespace_id") or "")
    matches = [item for item in binding_value["resource_refs"]
               if item["resource_id"] == resource_id and item["namespace"] == namespace_id]
    if len(matches) != 1:
        raise PermissionError("requested resource is outside the frozen Trial scope")
    return matches


def requested_service_from_langgraph(binding_value: dict[str, Any], parameters: dict[str, Any]) -> str | None:
    if "service_id" not in parameters:
        return None
    service_id = str(parameters.get("service_id") or "")
    if service_id not in binding_value["service_ids"]:
        raise PermissionError("requested service is outside the frozen Trial scope")
    return service_id


def validate_lease(contestant_ref: str, managed_trial_id: str, slot_lease_id: Any = None) -> None:
    lease = active_lease(contestant_ref)
    if lease.get("trial_id") != managed_trial_id:
        raise PermissionError("candidate observation Trial does not own the active product lease")
    if slot_lease_id is not None and lease.get("slot_lease_id") != slot_lease_id:
        raise PermissionError("candidate observation slot lease mismatch")


def process_record(resource: dict[str, str], processes: dict[str, Any]) -> dict[str, Any]:
    resource_id = resource["resource_id"]
    resolution = "resolved"
    if resource_id in SERVICE_NAMES:
        runtime_kind = "service"
        runtime_name = SERVICE_NAMES[resource_id]
        active = dict(processes.get("services") or {}).get(runtime_name)
    elif resource_id in RUNTIME_NAMES:
        runtime_kind = "workload"
        runtime_name = RUNTIME_NAMES[resource_id]
        active = dict(processes.get("ueransim") or {}).get(runtime_name)
    elif resource_id == "twin-t1":
        runtime_kind = "runtime"
        runtime_name = "opsmind-twin"
        values = [*dict(processes.get("services") or {}).values(), *dict(processes.get("ueransim") or {}).values()]
        active = bool(values) and all(value is True for value in values)
    else:
        runtime_kind = resource["resource_type"]
        runtime_name = resource_id
        active = None
        resolution = "unknown"
    return {"resource_id": resource_id, "namespace_id": resource["namespace"],
            "resource_type": resource["resource_type"], "runtime_kind": runtime_kind,
            "runtime_name": runtime_name, "active": active, "resolution": resolution}


def service_record(resource: dict[str, str], health: dict[str, Any]) -> dict[str, Any]:
    record = process_record(resource, dict(health.get("processes") or {}))
    resource_id = resource["resource_id"]
    sessions = dict(health.get("sessions") or {})
    record.update({"service_id": resource_id, "healthy": record["active"],
                   "ready": record["active"], "dependency_state": "unknown"})
    if resource_id in {"n2", "n3", "n4", "n6", "dns"}:
        record.update({"active": None, "healthy": None, "ready": None, "resolution": "unknown"})
    elif resource_id in {"gnb-1", "ue-1"}:
        record["dependency_state"] = "registered" if sessions.get("ue_registered") else "not_registered"
    return record


def bounded_log_records(resource: dict[str, str], logs: dict[str, Any], parameters: dict[str, Any]) -> list[dict[str, Any]]:
    line_limit = min(1000, max(1, int(parameters.get("line_limit", 100))))
    resource_id = resource["resource_id"]
    if resource_id in SERVICE_NAMES:
        key = {"amf": "amf", "smf": "smf", "upf": "upf", "nrf": "nrf",
               "mongodb": ""}[resource_id]
        values = list(dict(logs.get("open5gs") or {}).get(key, [])) if key else []
    elif resource_id == "gnb-1":
        values = list(logs.get("gnb") or [])
    elif resource_id == "ue-1":
        values = list(logs.get("ue") or [])
    else:
        values = []
    time_filter_applied = "since_seconds" not in parameters
    return [{"resource_id": resource_id, "namespace_id": resource["namespace"],
             "service_id": resource_id, "resolution": "resolved" if values else "unknown",
             "line_count": min(len(values), line_limit), "lines": [str(item)[:1000] for item in values[-line_limit:]],
             "requested_since_seconds": parameters.get("since_seconds"),
             "time_filter_applied": time_filter_applied}]


def collect(capability: str, refs: list[dict[str, str]], profile: str | None,
            parameters: dict[str, Any], managed_trial_id: str) -> tuple[list[dict[str, Any]], bool]:
    validate_observation_parameters(capability, profile, parameters)
    if capability == "runtime_state":
        processes = base_observe(managed_trial_id, "processes")
        records = [process_record(item, processes) for item in refs]
    elif capability == "service_health":
        health = base_observe(managed_trial_id, "health")
        records = [service_record(item, health) for item in refs]
    else:
        if profile not in DIAGNOSTIC_PROFILES:
            raise ValueError("diagnostic_profile is not a registered read-only profile")
        if profile == "bounded_log_tail":
            logs = base_observe(managed_trial_id, "logs")
            records = [record for item in refs for record in bounded_log_records(item, logs, parameters)]
        elif profile in {"process_summary", "container_state", "workload_state"}:
            processes = base_observe(managed_trial_id, "processes")
            records = [process_record(item, processes) for item in refs]
        else:
            health = base_observe(managed_trial_id, "health")
            records = [service_record(item, health) for item in refs]
    partial = any(item.get("resolution") != "resolved" or item.get("time_filter_applied") is False
                  for item in records)
    return records, partial


def validate_observation_parameters(capability: str, profile: str | None,
                                    parameters: dict[str, Any]) -> None:
    allowed = {
        "runtime_state": {"resource_id", "namespace_id", "runtime_types"},
        "service_health": {"resource_id", "namespace_id", "service_id"},
        "sandboxed_readonly_diagnostic": {
            "resource_id", "namespace_id", "diagnostic_profile", "line_limit", "since_seconds",
        },
    }[capability]
    if not set(parameters).issubset(allowed):
        raise ValueError("candidate observation parameters contain an unsupported field")
    if "runtime_types" in parameters:
        runtime_types = parameters["runtime_types"]
        allowed_runtime_types = {
            "runtime", "process", "service", "container", "workload", "network_function",
        }
        if (not isinstance(runtime_types, list) or len(runtime_types) > 4
                or any(not isinstance(item, str) or item not in allowed_runtime_types
                       for item in runtime_types)):
            raise ValueError("runtime_types are invalid")
    if "line_limit" in parameters:
        line_limit = parameters["line_limit"]
        if isinstance(line_limit, bool) or not isinstance(line_limit, int) or not 1 <= line_limit <= 1000:
            raise ValueError("line_limit is invalid")
    if "since_seconds" in parameters:
        since_seconds = parameters["since_seconds"]
        if isinstance(since_seconds, bool) or not isinstance(since_seconds, int) or not 1 <= since_seconds <= 3600:
            raise ValueError("since_seconds is invalid")
    if capability == "sandboxed_readonly_diagnostic" and profile not in DIAGNOSTIC_PROFILES:
        raise ValueError("diagnostic_profile is not a registered read-only profile")


def audit(binding_value: dict[str, Any], request: dict[str, Any], response: dict[str, Any]) -> None:
    trial_dir = (TRIAL_ROOT / str(binding_value["managed_trial_id"])).resolve()
    if not trial_dir.is_relative_to(TRIAL_ROOT.resolve()) or not trial_dir.is_dir():
        raise RuntimeError("candidate observation audit Trial directory is unavailable")
    record = {
        "contract_version": "opsmind-candidate-observation-audit/1.0",
        "recorded_at": now(),
        "contestant_ref": binding_value["contestant_ref"],
        "managed_trial_id": binding_value["managed_trial_id"],
        "request_id": request.get("request_id") or request.get("external_request_id"),
        "capability": request.get("capability"),
        "request_digest": digest(request),
        "response_digest": digest(response),
        "read_only": True,
    }
    encoded = (json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd = os.open(trial_dir / "candidate-observation-audit.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, encoded)
        os.fsync(fd)
    finally:
        os.close(fd)


def observe_agent_harness(request: dict[str, Any]) -> dict[str, Any]:
    binding_value = load_binding("agent-harness-v2")
    if not binding_value:
        raise PermissionError("candidate observation Trial binding is unavailable")
    required = {
        "contract_version": CONTRACT,
        "mode": "open_with_safety_boundary",
        "binding": BINDING,
        "identity_role": "candidate_observer",
        "scope_contract_version": SCOPE_CONTRACT,
    }
    if any(request.get(name) != value for name, value in required.items()):
        raise PermissionError("candidate observation request contract mismatch")
    request_id = str(request.get("request_id") or "")
    if not REQUEST_ID_RE.fullmatch(request_id):
        raise ValueError("invalid request_id")
    if request.get("trial_id") != binding_value["evalos_trial_id"]:
        raise PermissionError("candidate observation request escaped the EvalOS Trial")
    if canonical_digest(request.get("context_digest")) != binding_value["context_digest"]:
        raise PermissionError("candidate observation context digest mismatch")
    if request.get("environment_ref") != binding_value["environment_ref"]:
        raise PermissionError("candidate observation environment_ref mismatch")
    capability = str(request.get("capability") or "")
    if capability not in CAPABILITIES:
        raise ValueError("unsupported candidate observation capability")
    refs = canonical_refs(request.get("resource_refs"))
    allowed = {digest(item) for item in binding_value["resource_refs"]}
    if any(digest(item) not in allowed for item in refs):
        raise PermissionError("candidate observation requested a resource outside the frozen scope")
    validate_lease("agent-harness-v2", binding_value["managed_trial_id"])
    parameters = request.get("parameters") or {}
    if not isinstance(parameters, dict) or len(parameters) > 32:
        raise ValueError("candidate observation parameters are invalid")
    profile = request.get("diagnostic_profile")
    records, partial = collect(capability, refs, str(profile) if profile else None,
                               parameters, binding_value["managed_trial_id"])
    response = {"ok": True, "operation": "candidate_observe", "request_id": request_id,
                "trial_id": binding_value["evalos_trial_id"], "context_digest": binding_value["context_digest"],
                "capability": capability, "resource_refs": refs, "records": records, "partial": partial,
                "read_only": True, "cross_trial_access": False, "observed_at": now()}
    audit(binding_value, request, response)
    return response


def observe_langgraph(request: dict[str, Any]) -> dict[str, Any]:
    binding_value = load_binding("langgraph-v1")
    if not binding_value:
        raise PermissionError("candidate observation Trial binding is unavailable")
    expected = CONTESTANTS["langgraph-v1"]
    if request.get("operation") != "observe" or request.get("identity_role") != "observer":
        raise PermissionError("candidate observation identity or operation mismatch")
    if request.get("consumer_id") != expected["consumer_id"] or request.get("slot_id") != expected["slot_id"]:
        raise PermissionError("candidate observation consumer or slot mismatch")
    if request.get("connector_profile") != "candidate-observation-gateway:1.0":
        raise PermissionError("candidate observation connector profile mismatch")
    managed_trial_id = str(request.get("trial_id") or "")
    if managed_trial_id != binding_value["managed_trial_id"]:
        raise PermissionError("candidate observation request escaped the managed Trial")
    validate_lease("langgraph-v1", managed_trial_id, request.get("slot_lease_id"))
    ttl = int(request.get("identity_ttl_seconds") or 0)
    if ttl < 60 or ttl > 21_600:
        raise ValueError("candidate observer identity TTL is outside the short-session contract")
    capability = str(request.get("capability") or "")
    if capability not in CAPABILITIES:
        raise ValueError("unsupported candidate observation capability")
    parameters = request.get("parameters") or {}
    if not isinstance(parameters, dict):
        raise ValueError("candidate observation parameters are invalid")
    refs = requested_refs_from_langgraph(binding_value, parameters)
    requested_service = requested_service_from_langgraph(binding_value, parameters)
    profile = parameters.get("diagnostic_profile") if capability == "sandboxed_readonly_diagnostic" else None
    records, partial = collect(capability, refs, str(profile) if profile else None, parameters, managed_trial_id)
    if requested_service is not None:
        for record in records:
            record["service_id"] = requested_service
    response = {"ok": True, "operation": "observe", "data": {"records": records, "partial": partial},
                "evidence_refs": [f"candidate-observation:{capability}:{digest(records)[7:27]}"],
                "observed_at": now()}
    audit(binding_value, request, response)
    return response


def candidate_request(contestant_ref: str, request: dict[str, Any]) -> dict[str, Any]:
    if contestant_ref not in CONTESTANTS:
        raise ValueError("unsupported contestant_ref")
    if contestant_ref == "langgraph-v1" and request.get("operation") == "health":
        health = public_health(contestant_ref)
        return {
            "ok": True,
            "operation": "health",
            "data": {
                "contract_version": health["contract_version"],
                "binding": health["binding"],
                "identity_contract_version": LANGGRAPH_IDENTITY_CONTRACT,
                "identity_role": "observer",
                "connector_profile": LANGGRAPH_CONNECTOR_PROFILE,
                "scope_contract_version": LANGGRAPH_SCOPE_CONTRACT,
                "audit_contract_version": LANGGRAPH_AUDIT_CONTRACT,
                "capabilities": health["semantic_capabilities"],
                "namespace_scope_supported": True,
                "read_only": health["read_only"],
                "trial_scope_enforced": health["trial_scope_enforced"],
                "cross_trial_access": health["cross_trial_access"],
                "management_identity_reused": health["management_identity_reused"],
                "hidden_evaluation_data_exposed": health["hidden_evaluation_data_exposed"],
                "root_or_privileged_required": health["root_or_privileged_required"],
                "audited": health["audited"],
                "forced_command": True,
                "limits_are_safety_fuses_only": health["limits_are_safety_fuses_only"],
                "identity_persistent": True,
            },
        }
    try:
        response = (observe_agent_harness(request) if contestant_ref == "agent-harness-v2"
                    else observe_langgraph(request))
    except (PermissionError, ValueError, RuntimeError) as exc:
        code = "CANDIDATE_OBSERVATION_SCOPE_DENIED" if isinstance(exc, PermissionError) \
            else "CANDIDATE_OBSERVATION_REQUEST_INVALID" if isinstance(exc, ValueError) \
            else "CANDIDATE_OBSERVATION_BACKEND_FAILURE"
        response = error("candidate_observe" if contestant_ref == "agent-harness-v2" else "observe",
                         code, str(exc))
        binding_value = load_binding(contestant_ref)
        if binding_value:
            audit(binding_value, request, response)
    return response


def decode(value: str) -> dict[str, Any]:
    encoded = value + "=" * (-len(value) % 4)
    decoded = json.loads(base64.urlsafe_b64decode(encoded).decode("utf-8"))
    if not isinstance(decoded, dict):
        raise ValueError("request must be an object")
    return decoded


def main() -> int:
    if os.geteuid() != 0:
        print(json.dumps(error("unknown", "ROOT_REQUIRED", "candidate observation gateway must run as root")))
        return 1
    operation = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    try:
        LOCK.parent.mkdir(parents=True, exist_ok=True)
        with LOCK.open("a+") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            if operation == "health" and len(sys.argv) == 3:
                response = public_health(sys.argv[2])
            elif operation == "bind" and len(sys.argv) == 3:
                response = bind(decode(sys.argv[2]))
            elif operation == "clear" and len(sys.argv) == 3:
                response = clear(decode(sys.argv[2]))
            elif operation == "request" and len(sys.argv) == 4:
                response = candidate_request(sys.argv[2], decode(sys.argv[3]))
            else:
                raise ValueError("unsupported candidate observation gateway invocation")
        print(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
        return 0 if response.get("ok") else 3
    except PermissionError as exc:
        print(json.dumps(error(operation, "CANDIDATE_OBSERVATION_DENIED", str(exc)), ensure_ascii=False))
        return 4
    except Exception as exc:
        print(json.dumps(error(operation, "CANDIDATE_OBSERVATION_ERROR", str(exc)), ensure_ascii=False))
        return 5


if __name__ == "__main__":
    raise SystemExit(main())
