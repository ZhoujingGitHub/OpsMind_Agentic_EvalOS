#!/usr/bin/env python3
# mypy: ignore-errors
"""Restricted Agent+Harness product gateway for the shared protocol lab.

This controller accepts only a frozen JSON contract.  It delegates the existing
Open5GS/UERANSIM scenario lifecycle to ``opsmind-twinctl`` and adds product-owned
diagnostic probes, idempotency and a real virtual transport/MEC path.  It never
accepts a shell command, filesystem path, arbitrary IP address or arbitrary port.
"""

from __future__ import annotations

import base64
import datetime as dt
import fcntl
import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import sys
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

# Resolve the immutable release directory when invoked via the fixed symlink.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import harness_probes

BASE = Path("/usr/local/sbin/opsmind-twinctl")
BASE_MODULE = Path("/usr/local/sbin/opsmind-twinctl")
TOPOLOGY = Path("/usr/local/sbin/opsmind-harness-lab-topology")
ROOT = Path("/var/lib/opsmind-harness-lab")
REQUEST_ROOT = ROOT / "requests"
ACTIVE_BINDING = ROOT / "active-binding.json"
LOCK = Path("/run/lock/opsmind-harness-lab.lock")
BINDING_SECRET_PATH = Path("/etc/opsmind-harness-lab/binding-secret")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

CONSUMER_ID = "opsmind-harness"
SLOT_ID = "harness-slot-1"
PROFILE = "protocol-lab:1.0.0"
MEC_IP = "10.47.0.80"
DNS_IP = "10.47.0.53"

ROLE_BY_USER = {
    "opsmind_ah_control": "control",
    "opsmind_ah_observer": "observer",
    "opsmind_ah_action": "action",
    "opsmind_ah_verifier": "verifier",
}
ALLOWED = {
    "control": {"health", "snapshot", "reset"},
    "observer": {"health", "observe", "snapshot"},
    "action": {"health", "act", "status"},
    "verifier": {"health", "observe", "snapshot"},
}
CAPABILITIES = {
    "ip_reachability",
    "network_path",
    "tcp_port",
    "sctp_association",
    "dns",
    "http_service",
    "routes",
    "interfaces",
    "sockets",
    "protocol_summary",
    "subscriber_auth_consistency",
    "runtime_state",
    "service_health",
    "sandboxed_readonly_diagnostic",
}
DIAGNOSTIC_PARAMETERS = {
    "ip_reachability": {"target_profile": ["mec", "dns", "core"]},
    "network_path": {"target_profile": ["mec", "dns"]},
    "tcp_port": {"service_profile": ["mec-http", "mec-mqtt", "dns-tcp"]},
    "sctp_association": {},
    "dns": {"query_profile": ["mec-service"]},
    "http_service": {"service_profile": ["mec-http"]},
    "routes": {"node_profile": ["ue", "gnb", "upf", "transport", "mec"]},
    "interfaces": {"node_profile": ["ue", "gnb", "upf", "transport", "mec"]},
    "sockets": {"node_profile": ["gnb", "core", "mec"]},
    "protocol_summary": {},
    "subscriber_auth_consistency": {},
}
RUNTIME_TARGETS = {
    "gnb-1": ("ueransim", "gnb", "ueransim-gnb", "ueransim-gnb"),
    "ue-1": ("ueransim", "ue", "ueransim-ue", "ueransim-ue"),
    "amf": ("services", "open5gs-amfd", "amf", "open5gs-amfd"),
    "smf": ("services", "open5gs-smfd", "smf", "open5gs-smfd"),
    "upf": ("services", "open5gs-upfd", "upf", "open5gs-upfd"),
    "nrf": ("services", "open5gs-nrfd", "nrf", "open5gs-nrfd"),
    "mongodb": ("services", "mongod", "mongodb", "mongod"),
}
# Local listener readiness only; this never certifies end-to-end service health.
SERVICE_LISTENER_PROTOCOLS = {
    "amf": "sctp", "smf": "udp", "upf": "udp", "nrf": "tcp", "mongodb": "tcp",
}
READONLY_DIAGNOSTIC_PROFILES = {
    "process_summary",
    "service_status",
    "bounded_log_tail",
}
BASE_ACTION_PARAMETERS = {
    "subscriber_profile": {"source": "reference_profile"},
    "ran_configuration": {"target": "tracking_area", "source": "reference_config"},
    "network_policy": {"interface": "n2", "desired_state": "allow"},
    "route_state": {"route": "n6", "desired_state": "present"},
    "traffic_control": {"interface": "user_plane", "delay_ms": 0},
    "component_restart": {"component": "gnb"},
    "alert_state": {"alert": "amf-down", "desired_state": "cleared"},
    "capture_policy": {"policy": "bounded-retention", "desired_state": "enabled"},
}


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")  # noqa: UP017


def digest(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def run(args: list[str], *, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=False,
        timeout=timeout,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def base_call(request: dict) -> dict:
    encoded = (
        base64.urlsafe_b64encode(
            json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()
        )
        .decode()
        .rstrip("=")
    )
    result = run([str(BASE), "request", encoded], timeout=150)
    for line in reversed((result.stdout or "").splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise RuntimeError("base Twin returned no structured response")


def base_observe(trial_id: str, capability: str) -> dict:
    response = base_call(
        {"operation": "observe", "trial_id": trial_id, "capability": capability}
    )
    if not response.get("ok"):
        raise RuntimeError(f"base Twin {capability} observation failed")
    return response


def active_snapshot(trial_id: str) -> dict:
    response = base_call({"operation": "snapshot", "trial_id": trial_id})
    if not response.get("ok"):
        raise PermissionError("trial is not active")
    return dict(response.get("snapshot") or {})


def load_active_lease() -> dict:
    response = base_call({"operation": "lease_status"})
    lease = dict(response.get("physical_lease") or {})
    if lease.get("candidate_ref") != "agent-harness-v2":
        return {}
    return {
        "trial_id": lease.get("runtime_trial_id"),
        "evalos_trial_id": lease.get("trial_id"),
        "slot_lease_id": lease.get("lease_id"),
        "owner_mode": lease.get("owner_mode"),
        "status": lease.get("status"),
        "boot_id": lease.get("boot_id"),
    }


def load_active_binding() -> dict:
    if not ACTIVE_BINDING.exists():
        return {}
    try:
        value = json.loads(ACTIVE_BINDING.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    return value if isinstance(value, dict) else {}


def persist_active_binding(value: dict) -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    temporary = ACTIVE_BINDING.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(ACTIVE_BINDING)


def claim_active_lease(request: dict) -> None:
    """Bind a prepared Trial to the first signed tenant/investigation snapshot."""

    lease = load_active_lease()
    binding = dict(request["tenant_binding"])
    record = load_active_binding()
    same_lease = record.get("trial_id") == lease.get("trial_id") and \
        record.get("slot_lease_id") == lease.get("slot_lease_id")
    claimed = record.get("tenant_binding") if same_lease else None
    if isinstance(claimed, dict) and claimed != binding:
        raise PermissionError("active Trial is already bound to another tenant or investigation")
    if not isinstance(claimed, dict):
        persist_active_binding({"trial_id": lease.get("trial_id"),
                                "slot_lease_id": lease.get("slot_lease_id"),
                                "tenant_binding": binding, "claimed_at": now()})


def clear_active_binding(trial_id: str) -> None:
    binding = load_active_binding()
    if not binding or binding.get("trial_id") == trial_id:
        ACTIVE_BINDING.unlink(missing_ok=True)


def ensure_identity(request: dict) -> str:
    sudo_user = os.environ.get("SUDO_USER", "")
    role = ROLE_BY_USER.get(sudo_user)
    if role is None:
        raise PermissionError("unknown product lab identity")
    if request.get("consumer_id") != CONSUMER_ID or request.get("slot_id") != SLOT_ID:
        raise PermissionError("consumer or slot mismatch")
    if request.get("connector_profile") != PROFILE:
        raise PermissionError("connector profile mismatch")
    if request.get("identity_role") != role:
        raise PermissionError("claimed role does not match SSH identity")
    operation = str(request.get("operation"))
    if operation not in ALLOWED[role]:
        raise PermissionError("operation is not allowed for this identity")
    return role



def ensure_tenant_binding(request: dict) -> None:
    binding = request.get("tenant_binding")
    signature = str(request.get("binding_hmac") or "")
    if not isinstance(binding, dict) or set(binding) != {
        "tenant_id", "investigation_id", "scope_hash"
    }:
        raise PermissionError("tenant and scope binding is missing")
    if not all(ID_RE.fullmatch(str(binding.get(key, ""))) for key in (
        "tenant_id", "investigation_id", "scope_hash"
    )):
        raise PermissionError("tenant and scope binding is invalid")
    try:
        secret = BINDING_SECRET_PATH.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise PermissionError("tenant binding secret is unavailable") from exc
    if len(secret) < 32:
        raise PermissionError("tenant binding secret is invalid")
    encoded = json.dumps(
        binding, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    expected = hmac.new(secret.encode(), encoded, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise PermissionError("tenant and scope binding signature mismatch")

def validate_request(request: dict) -> None:
    operation = str(request.get("operation"))
    if operation != "health" and not ID_RE.fullmatch(str(request.get("trial_id", ""))):
        raise ValueError("invalid trial_id")
    if operation != "health" and not str(request.get("trial_id", "")).startswith("ah-"):
        raise ValueError("trial_id is outside the Agent+Harness namespace")
    if operation != "health":
        lease = load_active_lease()
        if (
            lease.get("trial_id") != request.get("trial_id")
            or lease.get("slot_lease_id") != request.get("slot_lease_id")
        ):
            raise PermissionError("slot lease does not own this active Trial")
        binding_record = load_active_binding()
        claimed = binding_record.get("tenant_binding") if (
            binding_record.get("trial_id") == lease.get("trial_id") and
            binding_record.get("slot_lease_id") == lease.get("slot_lease_id")
        ) else None
        requested = request.get("tenant_binding")
        if isinstance(claimed, dict) and claimed != requested:
            raise PermissionError("active Trial belongs to another tenant or investigation")
        if operation != "snapshot" and not isinstance(claimed, dict):
            raise PermissionError("active Trial must be bound by a signed snapshot first")
    if request.get("purpose") is not None:
        if operation != "snapshot" or request.get("identity_role") != "verifier":
            raise PermissionError("verification purpose requires the verifier identity")
        if request["purpose"] not in {"pre_action_snapshot", "post_action_verification",
                                     "post_rollback_verification"}:
            raise ValueError("invalid verification purpose")
    if operation == "observe":
        capability = request.get("capability")
        if capability not in CAPABILITIES:
            raise ValueError("unsupported diagnostic capability")
        if capability in DIAGNOSTIC_PARAMETERS:
            allowed = DIAGNOSTIC_PARAMETERS[capability]
            for key, value in (request.get("parameters") or {}).items():
                if key not in allowed or value not in allowed[key]:
                    raise ValueError(f"unsupported {capability} parameter: {key}")
    if operation in {"act", "status"} and not ID_RE.fullmatch(
        str(request.get("external_request_id", ""))
    ):
        raise ValueError("invalid external_request_id")


def prepare(request: dict) -> dict:
    base = base_call(
        {
            "operation": "prepare",
            "trial_id": request["trial_id"],
            "scenario_id": request["scenario_id"],
            "seed": int(request.get("seed", 0)),
            "owner_mode": request["owner_mode"],
            "candidate_ref": "agent-harness-v2",
            "evalos_trial_id": request.get("evalos_trial_id"),
            "lease_ttl_seconds": int(request.get("lease_ttl_seconds", 7200)),
        }
    )
    if not base.get("ok"):
        return base
    slot_lease_id = str(base.get("lease_id") or "")
    if not slot_lease_id:
        base_call({"operation": "reset", "trial_id": request["trial_id"]})
        return error("prepare", "PHYSICAL_LEASE_MISSING", "base Twin did not issue the physical lease")
    try:
        topology = run([str(TOPOLOGY), "prepare", str(request["scenario_id"])], timeout=90)
    except (OSError, subprocess.TimeoutExpired) as exc:
        cleanup = reset(request)
        return {**error("prepare", "MEC_TOPOLOGY_FAILED", str(exc)), "cleanup": cleanup}
    if topology.returncode != 0:
        cleanup = reset(request)
        return {**error("prepare", "MEC_TOPOLOGY_FAILED", (topology.stdout or "")[-400:]),
                "cleanup": cleanup}
    topology_view = topology_status()
    clear_active_binding(str(request["trial_id"]))
    fingerprint = digest(
        {
            "base": base.get("fingerprint"),
            "topology": topology_view,
            "consumer": CONSUMER_ID,
            "slot": SLOT_ID,
        }
    )
    return {
        **base,
        "fingerprint": fingerprint,
        "data": {
            **dict(base.get("data") or {}),
            "topology": topology_view,
            "isolation": "exclusive_trial",
            "slot_lease_id": slot_lease_id,
            "resource_scope": base.get("resource_scope"),
        },
    }


def observe(request: dict) -> dict:
    trial_id = str(request["trial_id"])
    snapshot = active_snapshot(trial_id)
    resource_scope = dict(snapshot.get("resource_scope") or {})
    capability = str(request["capability"])
    parameters = dict(request.get("parameters") or {})
    evidence_refs: list[str] = []
    records = {
        "ip_reachability": lambda: [harness_probes.probe("ip", parameters, resource_scope)],
        "network_path": lambda: [harness_probes.probe("trace", parameters, resource_scope)],
        "tcp_port": lambda: [harness_probes.probe("tcp", parameters, resource_scope)],
        "sctp_association": probe_sctp,
        "dns": lambda: [harness_probes.probe("dns", parameters, resource_scope)],
        "http_service": lambda: [harness_probes.probe("http", parameters, resource_scope)],
        "routes": lambda: query_routes(parameters),
        "interfaces": lambda: query_interfaces(parameters),
        "sockets": lambda: query_sockets(parameters),
        "protocol_summary": lambda: protocol_summary(trial_id, parameters),
        "subscriber_auth_consistency": lambda: subscriber_auth_consistency(trial_id),
        "runtime_state": lambda: query_resource_observation(
            trial_id, parameters, "runtime_state", resource_scope
        ),
        "service_health": lambda: query_resource_observation(
            trial_id, parameters, "service_health", resource_scope
        ),
        "sandboxed_readonly_diagnostic": lambda: query_resource_observation(
            trial_id, parameters, "sandboxed_readonly_diagnostic", resource_scope
        ),
    }[capability]()
    if capability in {"runtime_state", "service_health", "sandboxed_readonly_diagnostic"}:
        records, evidence_refs = records
    evidence_refs.append(f"protocol-lab:{capability}:{digest(records)[:20]}")
    return {
        "ok": True,
        "operation": "observe",
        "data": {"records": records,
                 "partial": any(record.get("resolution") == "unknown"
                                or record.get("health") == "unknown" for record in records),
                 "freshness": "snapshot" if capability == "protocol_summary" or (
                     capability == "sandboxed_readonly_diagnostic"
                     and parameters.get("diagnostic_profile") == "bounded_log_tail") else "live"},
        "evidence_refs": list(dict.fromkeys(evidence_refs)),
        "observed_at": now(),
    }


def _resource_refs(
    trial_id: str,
    parameters: dict,
    resource_scope: dict,
) -> list[dict[str, str]]:
    if (
        resource_scope.get("identifier_domain") != "opsmind-twin"
        or resource_scope.get("namespace") != trial_id
    ):
        raise PermissionError("active lab resource scope is missing or invalid")
    allowed = {
        str(item.get("resource_id")): str(item.get("resource_type"))
        for item in resource_scope.get("resource_refs") or []
        if isinstance(item, dict)
        and item.get("identifier_domain") == "opsmind-twin"
        and item.get("namespace") == trial_id
    }
    if not allowed:
        raise PermissionError("active lab resource scope contains no resources")
    raw = parameters.get("resource_refs")
    if isinstance(raw, list) and raw:
        refs = raw
    else:
        refs = [{
            "identifier_domain": "opsmind-twin",
            "namespace": parameters.get("namespace_id"),
            "resource_type": allowed.get(str(parameters.get("resource_id"))),
            "resource_id": parameters.get("resource_id"),
        }]
    normalized: list[dict[str, str]] = []
    for item in refs:
        if not isinstance(item, dict):
            raise TypeError("resource reference must be an object")
        resource_id = str(item.get("resource_id") or "")
        expected_type = allowed.get(resource_id)
        if (
            item.get("identifier_domain") != "opsmind-twin"
            or item.get("namespace") != trial_id
            or expected_type is None
            or item.get("resource_type") != expected_type
        ):
            raise PermissionError("resource reference is outside the active lab lease")
        normalized.append({
            "identifier_domain": "opsmind-twin",
            "namespace": trial_id,
            "resource_type": expected_type,
            "resource_id": resource_id,
        })
    return normalized


def query_resource_observation(
    trial_id: str,
    parameters: dict,
    capability: str,
    resource_scope: dict,
) -> tuple[list[dict], list[str]]:
    refs = _resource_refs(trial_id, parameters, resource_scope)
    options = parameters.get("parameters") or {}
    if not isinstance(options, dict) or set(options) - {"line_limit"}:
        raise ValueError("unsupported resource observation parameters")
    diagnostic_profile = str(parameters.get("diagnostic_profile") or "process_summary")
    if (
        capability == "sandboxed_readonly_diagnostic"
        and diagnostic_profile not in READONLY_DIAGNOSTIC_PROFILES
    ):
        raise ValueError(
            "unsupported readonly diagnostic profile; supported profiles: "
            + ", ".join(sorted(READONLY_DIAGNOSTIC_PROFILES))
            + ". No diagnostic was executed."
        )
    if "line_limit" in options and (
        capability != "sandboxed_readonly_diagnostic" or diagnostic_profile != "bounded_log_tail"
        or type(options["line_limit"]) is not int or not 1 <= options["line_limit"] <= 1000
    ):
        raise ValueError("line_limit requires bounded_log_tail and an integer from 1 to 1000")
    process_response = base_observe(trial_id, "processes")
    process_data = dict(process_response.get("data") or {})
    logs: dict = {}
    if capability == "sandboxed_readonly_diagnostic" and diagnostic_profile == "bounded_log_tail":
        logs = dict(base_observe(trial_id, "logs").get("data") or {})
    source_evidence_refs = {
        str(item) for item in process_response.get("evidence_refs") or []
    }
    matched_evidence_refs: list[str] = []
    records: list[dict] = []
    for ref in refs:
        target = RUNTIME_TARGETS.get(ref["resource_id"])
        if (
            parameters.get("service_id")
            and target is not None
            and parameters["service_id"] != target[2]
        ):
            raise PermissionError("service_id does not match the leased lab resource")
        raw_active = None if target is None else dict(
            process_data.get(target[0]) or {}
        ).get(target[1])
        active = raw_active if isinstance(raw_active, bool) else None
        service_id = target[2] if target is not None else ref["resource_id"]
        if target is not None and active is False:
            inactive_ref = f"process:{target[3]}-inactive"
            if inactive_ref in source_evidence_refs:
                matched_evidence_refs.append(inactive_ref)
        record = {
            "resource_id": ref["resource_id"],
            "namespace_id": trial_id,
            "resource_type": ref["resource_type"],
            "service_id": service_id,
            "resolution": "resolved" if active is not None else "unknown",
            "read_only": True,
        }
        if capability == "runtime_state":
            record.update(
                runtime_state=(
                    "running" if active else "stopped" if active is False else "unknown"
                ),
                active=active,
            )
        elif capability == "service_health":
            record.update(local_listener_health(ref["resource_id"], target, active))
        else:
            record.update(
                diagnostic_profile=diagnostic_profile,
                active=active,
                status=(
                    "running" if active else "stopped" if active is False else "unknown"
                ),
            )
            if diagnostic_profile == "bounded_log_tail":
                line_limit = options.get("line_limit", 80)
                if ref["resource_id"] == "gnb-1":
                    selected = logs.get("gnb") or []
                elif ref["resource_id"] == "ue-1":
                    selected = logs.get("ue") or []
                else:
                    selected = dict(logs.get("open5gs") or {}).get(ref["resource_id"]) or []
                record["log_tail"] = [str(line)[:500] for line in list(selected)[-line_limit:]]
                record["sampling_mode"] = "existing_log_tail"
                record["log_time_range"] = {"start": None, "end": None}
                record["time_coverage"] = "unknown"
        records.append(record)
    return records, list(dict.fromkeys(matched_evidence_refs))


def collected(args: list[str]) -> str:
    """Collection failures are not successful empty observations."""
    result = run(args, timeout=8)
    if result.returncode != 0:
        raise RuntimeError(f"diagnostic collection failed: {args[-1]} (exit {result.returncode})")
    return result.stdout or ""


def local_listener_health(resource_id: str, target: tuple | None, active: bool | None) -> dict:
    protocol = SERVICE_LISTENER_PROTOCOLS.get(resource_id)
    checks = {"process_active": active, "owned_protocol_listener": None}
    details = {
        "health_scope": "local_process_listener",
        "business_health": "not_measured",
        "checks": checks,
    }
    ready = False if active is False else None
    if active is True and target is not None and protocol:
        pid_text = collected(["systemctl", "show", target[1], "--property=MainPID", "--value"]).strip()
        if not pid_text.isdigit():
            raise RuntimeError("diagnostic collection returned an invalid MainPID")
        pid = int(pid_text)
        if pid > 0:
            output = collected(["ss", "-H", "-l", "-n", "-p", "-A", protocol])
            owned = [
                line[:500] for line in output.splitlines()
                if re.search(rf"\bpid={pid},", line)
            ]
            ready = bool(owned)
            checks["owned_protocol_listener"] = ready
            details.update(process_id=pid, listener_protocol=protocol, listeners=owned[:30])
    return {
        **details, "active": active, "ready": ready,
        "health": "healthy" if ready is True else "unhealthy" if ready is False else "unknown",
    }


def probe_sctp() -> list[dict]:
    output = collected(["ss", "-H", "-n", "-A", "sctp"])
    lines = [line[:500] for line in output.splitlines() if line.strip()]
    return [{"association_count": len(lines), "associations": lines[:30]}]


def query_routes(parameters: dict) -> list[dict]:
    profile = parameters.get("node_profile", "ue")
    prefix = node_prefix(profile)
    output = collected([*prefix, "ip", "-j", "route", "show"])
    return [{"node_profile": profile, "routes": parse_json_list(output)}]


def query_interfaces(parameters: dict) -> list[dict]:
    profile = parameters.get("node_profile", "ue")
    prefix = node_prefix(profile)
    output = collected([*prefix, "ip", "-j", "address", "show"])
    return [{"node_profile": profile, "interfaces": parse_json_list(output)}]


def query_sockets(parameters: dict) -> list[dict]:
    profile = parameters.get("node_profile", "core")
    prefix = node_prefix(profile)
    output = collected([*prefix, "ss", "-H", "-lntup"])
    lines = [line[:500] for line in output.splitlines() if line.strip()]
    return [{"node_profile": profile, "socket_count": len(lines), "sockets": lines[:80]}]


def _nested_text(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [line for item in value.values() for line in _nested_text(item)]
    if isinstance(value, list):
        return [line for item in value for line in _nested_text(item)]
    return []


def protocol_summary(trial_id: str, parameters: dict) -> list[dict]:
    if parameters:
        raise ValueError("existing capture summary does not support sampling options")
    response = base_observe(trial_id, "pcap_summary")
    summary = dict(response.get("data") or {})
    # The existing collector is cumulative, not four separately sampled locations.
    # Do not mix current sessions or scenario-conditioned evidence into this source.
    return [{
        "source_ref": f"protocol-lab:{trial_id}:protocol_summary",
        "sampling_mode": "existing_capture_summary",
        "location_coverage": "not_separated",
        "capture_time_range": {"start": None, "end": None},
        "summary_read_at": response.get("observed_at"),
        "protocol_counts_file_scope": "first_capture_file",
        "observation_available": bool(summary.get("files", 0)),
        "capture_summary": summary,
        "bounded": True,
        "raw_packet_payload_exposed": False,
        "subscriber_secret_exposed": False,
    }]


def _read_profile_fields(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    text = path.read_text(encoding="utf-8")
    fields: dict[str, str] = {}
    for name in ("supi", "key", "op", "amf"):
        match = re.search(
            rf"(?m)^\s*{name}\s*:\s*['\"]?([A-Za-z0-9-]+)['\"]?\s*$",
            text,
        )
        if match:
            fields[name] = match.group(1).upper()
    return fields


def subscriber_auth_consistency(trial_id: str) -> list[dict]:
    active_snapshot(trial_id)
    active = _read_profile_fields(Path("/srv/opsmind-twin/config/active/ue.yaml"))
    reference = _read_profile_fields(Path("/srv/opsmind-twin/config/baseline/ue.yaml"))
    subscriber = base_observe(trial_id, "subscriber").get("data", {})
    checked_fields = sorted(set(active).intersection(reference))
    mismatched_fields = [
        name
        for name in checked_fields
        if not secrets.compare_digest(active[name], reference[name])
    ]
    return [
        {
            "subscriber_present": bool(subscriber.get("present")),
            "ue_profile_available": bool(active),
            "reference_profile_available": bool(reference),
            "checked_fields": checked_fields,
            "authentication_profile_consistent": bool(checked_fields)
            and not mismatched_fields,
            "mismatched_fields": mismatched_fields,
            "secret_values_exposed": False,
        }
    ]


def node_prefix(profile: str) -> list[str]:
    namespace = {
        "ue": "opsmind-ue",
        "transport": "opsmind-ah-b",
        "mec": "opsmind-ah-mec",
    }.get(profile)
    if namespace:
        return ["ip", "netns", "exec", namespace]
    if profile in {"gnb", "upf", "core"}:
        return []
    raise ValueError("invalid node_profile")


def act(request: dict) -> dict:
    external_request_id = str(request["external_request_id"])
    existing = request_record(external_request_id)
    if existing is not None:
        return existing
    trial_id = str(request["trial_id"])
    snapshot = active_snapshot(trial_id)
    action_type = str(request.get("action_type"))
    if action_type == "rollback_action":
        response = rollback_fault(snapshot, request)
    else:
        parameters = action_parameters(action_type, snapshot)
        response = base_call(
            {
                "operation": "act",
                "trial_id": trial_id,
                "action_type": action_type,
                "parameters": parameters,
            }
        )
        if response.get("ok") and action_type == "route_state":
            run([str(TOPOLOGY), "route"], timeout=30)
        data = dict(response.get("data") or {})
        verification = dict(data.get("terminal_verification") or {})
        data.update(
            status="succeeded" if response.get("ok") else "failed",
            changed_external_state=bool(response.get("ok") and data.get("applied")),
            task_success=verification.get("task_success"),
        )
        response = {**response, "data": data}
    save_request_record(external_request_id, response)
    return response


def action_parameters(action_type: str, snapshot: dict) -> dict:
    if action_type == "service_state":
        scenario = str(snapshot.get("scenario_id", ""))
        component = {
            "amf-process-down": "amf",
            "smf-process-down": "smf",
            "upf-process-down": "upf",
            "nrf-process-down": "nrf",
            "mongodb-process-down": "mongodb",
        }.get(scenario)
        if component is None:
            raise ValueError("service action does not match this scenario")
        return {"component": component, "desired_state": "running"}
    parameters = BASE_ACTION_PARAMETERS.get(action_type)
    if parameters is None:
        raise ValueError("action is not in the frozen protocol-lab catalog")
    return dict(parameters)


def rollback_fault(snapshot: dict, request: dict) -> dict:
    original = str((request.get("parameters") or {}).get("original_external_request_id", ""))
    if not ID_RE.fullmatch(original) or request_record(original) is None:
        return error("act", "ROLLBACK_SOURCE_MISSING", "original action is unavailable")
    module = load_base_module()
    state = module.load_state()
    if not state or state.get("trial_id") != snapshot.get("trial_id"):
        return error("act", "TRIAL_SCOPE_MISMATCH", "active Trial changed")
    baseline = module.reset_baseline(state)
    if not baseline.get("ok"):
        return error("act", "ROLLBACK_BASELINE_FAILED", "baseline could not be restored")
    state["changes"] = []
    module.inject_fault(state["scenario_id"], state)
    module.save_state(state)
    if state["scenario_id"] == "n6-route-missing":
        run([str(TOPOLOGY), "fault-route"], timeout=30)
    return {
        "ok": True,
        "operation": "act",
        "data": {"status": "succeeded", "changed_external_state": True, "rollback": True},
        "observed_at": now(),
    }


def status(request: dict) -> dict:
    record = request_record(str(request["external_request_id"]))
    if record is None:
        return error("status", "ACTION_UNKNOWN", "external request is not recorded")
    data = dict(record.get("data") or {})
    return {
        "ok": True,
        "operation": "status",
        "data": {
            "status": data.get("status", "unknown"),
            "changed_external_state": bool(data.get("changed_external_state", False)),
        },
        "observed_at": now(),
    }


def snapshot(request: dict) -> dict:
    claim_active_lease(request)
    response = base_call({"operation": "snapshot", "trial_id": request["trial_id"]})
    if not response.get("ok"):
        return response
    value = dict(response.get("snapshot") or {})
    value.update(topology=topology_status(), production_network=False)
    if request.get("purpose") in {"pre_action_snapshot", "post_action_verification",
                                  "post_rollback_verification"}:
        verification = harness_probes.business_verification(dict(value.get("resource_scope") or {}))
        value["business_verification"] = verification
        # Keep the unchanged scenario grade under recovery. Product health is
        # independently sampled business availability, not the grader's change count.
        value["healthy"] = verification["passed"]
    return {**response, "snapshot": value}


def reset(request: dict) -> dict:
    # Check ownership before touching MEC; release the base lease only after cleanup.
    active_snapshot(str(request["trial_id"]))
    topology = run([str(TOPOLOGY), "reset"], timeout=60)
    if topology.returncode != 0:
        return error("reset", "MEC_CLEANUP_FAILED", "MEC resources remain; physical lease was not released")
    response = base_call({"operation": "reset", "trial_id": request["trial_id"]})
    clean = bool(response.get("clean"))
    reset_hash = digest(
        {"base": response.get("reset_hash"), "topology_clean": topology.returncode == 0}
    )
    if clean:
        clear_active_binding(str(request["trial_id"]))
    return {
        **response,
        "ok": bool(response.get("ok")) and clean,
        "clean": clean,
        "reset_hash": reset_hash,
    }


def health() -> dict:
    response = base_call({"operation": "health"})
    active_trial = str(response.get("active_trial") or "")
    owned_trial = active_trial if active_trial.startswith("ah-") else None
    physical_lease = dict(response.get("physical_lease") or {})
    lease = {
        "trial_id": physical_lease.get("runtime_trial_id"),
        "slot_lease_id": physical_lease.get("lease_id"),
    } if physical_lease.get("candidate_ref") == "agent-harness-v2" else {}
    slot_lease_id = (
        lease.get("slot_lease_id") if lease.get("trial_id") == owned_trial else None
    )
    return {
        **{key: value for key, value in response.items() if key != "active_trial"},
        "data": {
            "base": {"status": response.get("status"), "capacity": response.get("capacity")},
            "active_trial": owned_trial,
            "slot_lease_id": slot_lease_id,
            "slot_available": physical_lease.get("status") == "idle" and not active_trial,
            "physical_lease": physical_lease,
            "topology": topology_status(),
            "consumer_id": CONSUMER_ID,
            "slot_id": SLOT_ID,
            "resource_scope": response.get("resource_scope"),
            "diagnostics": {
                "contract_version": "opsmind-lab-diagnostics/1.0",
                "capabilities": sorted(CAPABILITIES),
                "parameters": DIAGNOSTIC_PARAMETERS,
                "readonly_profiles": sorted(READONLY_DIAGNOSTIC_PROFILES),
                "runtime_resources": sorted(RUNTIME_TARGETS),
                "health_scope": "local_process_listener",
            },
        },
    }


def topology_status() -> dict:
    result = run([str(TOPOLOGY), "status"], timeout=15)
    try:
        value = json.loads((result.stdout or "").splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        value = {"ready": False, "error": "topology status unavailable"}
    return value


def request_record(external_request_id: str) -> dict | None:
    path = REQUEST_ROOT / f"{external_request_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def save_request_record(external_request_id: str, response: dict) -> None:
    REQUEST_ROOT.mkdir(parents=True, exist_ok=True)
    path = REQUEST_ROOT / f"{external_request_id}.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(response, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def load_base_module():
    loader = SourceFileLoader("opsmind_base_twinctl", str(BASE_MODULE))
    spec = spec_from_loader(loader.name, loader)
    if spec is None or spec.loader is None:
        raise RuntimeError("base controller module is unavailable")
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_json_list(value: str) -> list:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise RuntimeError("diagnostic collection returned invalid JSON") from exc
    if not isinstance(parsed, list):
        raise RuntimeError("diagnostic collection did not return an array")
    return parsed


def last_lines(value: str, count: int) -> list[str]:
    return [line[:500] for line in (value or "").splitlines()[-count:]]


def error(operation: str, code: str, message: str) -> dict:
    return {"ok": False, "operation": operation, "error": {"code": code, "message": message[:500]}}


def dispatch(request: dict) -> dict:
    ensure_identity(request)
    ensure_tenant_binding(request)
    validate_request(request)
    return {
        "health": lambda _: health(),
        "observe": observe,
        "act": act,
        "status": status,
        "snapshot": snapshot,
        "reset": reset,
    }[request["operation"]](request)


def manage(arguments: list[str]) -> dict:
    """Admin-only scenario lifecycle; product SSH identities remain excluded."""
    if os.environ.get("SUDO_USER", "") in ROLE_BY_USER:
        raise PermissionError("product SSH identities cannot manage lab scenarios")
    command = arguments[0] if arguments else ""
    if command == "manage-status" and len(arguments) == 1:
        response = health()
        base = base_call({"operation": "health"})
        return {**response, "manager_active_trial": base.get("active_trial")}
    if command == "manage-prepare" and len(arguments) in {5, 6}:
        trial_id, scenario_id, seed_text, owner_mode = arguments[1:5]
        if not ID_RE.fullmatch(trial_id) or not trial_id.startswith("ah-"):
            raise ValueError("manager trial_id must start with ah-")
        if not ID_RE.fullmatch(scenario_id):
            raise ValueError("invalid scenario_id")
        if owner_mode not in {"agent_harness_direct", "evalos_trial"}:
            raise ValueError("invalid Agent+Harness physical lab owner mode")
        evalos_trial_id = arguments[5] if len(arguments) == 6 else None
        if owner_mode == "evalos_trial" and not evalos_trial_id:
            raise ValueError("evalos_trial requires evalos_trial_id")
        if owner_mode == "agent_harness_direct" and evalos_trial_id:
            raise ValueError("direct mode must not claim evalos_trial_id")
        return prepare({"trial_id": trial_id, "scenario_id": scenario_id, "seed": int(seed_text),
                        "owner_mode": owner_mode, "evalos_trial_id": evalos_trial_id,
                        "lease_ttl_seconds": 7200})
    if command == "manage-reset" and len(arguments) == 2:
        trial_id = arguments[1]
        if not ID_RE.fullmatch(trial_id) or not trial_id.startswith("ah-"):
            raise ValueError("manager trial_id must start with ah-")
        return reset({"trial_id": trial_id})
    raise ValueError(
        "use manage-status, manage-prepare <ah-trial-id> <scenario-id> <seed> "
        "<agent_harness_direct|evalos_trial> [evalos-trial-id], "
        "or manage-reset <ah-trial-id>"
    )


def main() -> int:
    if os.geteuid() != 0:
        print(json.dumps(error("unknown", "ROOT_REQUIRED", "controller must run as root")))
        return 1
    request: dict = {}
    try:
        ROOT.mkdir(parents=True, exist_ok=True)
        LOCK.parent.mkdir(parents=True, exist_ok=True)
        with LOCK.open("a+") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            if len(sys.argv) == 3 and sys.argv[1] == "request":
                encoded = sys.argv[2] + "=" * (-len(sys.argv[2]) % 4)
                request = json.loads(base64.urlsafe_b64decode(encoded).decode())
                response = dispatch(request)
            else:
                response = manage(sys.argv[1:])
        print(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
        return 0 if response.get("ok") else 3
    except PermissionError as exc:
        print(
            json.dumps(error(str(request.get("operation", "unknown")), "IDENTITY_DENIED", str(exc)))
        )
        return 4
    except Exception as exc:
        print(
            json.dumps(
                error(str(request.get("operation", "unknown")), "LAB_CONTROLLER_ERROR", str(exc))
            )
        )
        return 5


if __name__ == "__main__":
    raise SystemExit(main())
