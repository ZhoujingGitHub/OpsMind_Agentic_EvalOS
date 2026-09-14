#!/usr/bin/env python3
# mypy: ignore-errors
"""Restricted LangGraph product gateway for the shared protocol lab.

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
TOPOLOGY = Path("/usr/local/sbin/opsmind-langgraph-lab-topology")
ROOT = Path("/var/lib/opsmind-langgraph-lab")
REQUEST_ROOT = ROOT / "requests"
LOCK = Path("/run/lock/opsmind-langgraph-lab.lock")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

CONSUMER_ID = "opsmind-langgraph"
SLOT_ID = "langgraph-slot-1"
PROFILE = "protocol-lab:1.0.0"
# Network facts come from the component manifest; this adapter names its profile.
NETWORK_PROFILE = harness_probes.LANGGRAPH_NETWORK

ROLE_BY_USER = {
    "opsmind_lg_control": "control",
    "opsmind_lg_observer": "observer",
    "opsmind_lg_action": "action",
    "opsmind_lg_verifier": "verifier",
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
RUNTIME_TARGETS = {
    "gnb-1": ("ueransim", "gnb", "ueransim-gnb", "ueransim-gnb"),
    "ue-1": ("ueransim", "ue", "ueransim-ue", "ueransim-ue"),
    "amf": ("services", "open5gs-amfd", "amf", "open5gs-amfd"),
    "smf": ("services", "open5gs-smfd", "smf", "open5gs-smfd"),
    "upf": ("services", "open5gs-upfd", "upf", "open5gs-upfd"),
    "nrf": ("services", "open5gs-nrfd", "nrf", "open5gs-nrfd"),
    "mongodb": ("services", "mongod", "mongodb", "mongod"),
}
READONLY_DIAGNOSTIC_PROFILES = {
    "process_summary",
    "service_status",
    "bounded_log_tail",
    "network_policy",
}
ACTION_CONTRACT_FILE = Path("/etc/opsmind-langgraph-lab/protocol-actions.json")


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
    response = base_call({"operation": "observe", "trial_id": trial_id, "capability": capability})
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
    if lease.get("candidate_ref") != "langgraph-v1":
        return {}
    return {
        "trial_id": lease.get("runtime_trial_id"),
        "evalos_trial_id": lease.get("trial_id"),
        "slot_lease_id": lease.get("lease_id"),
        "owner_mode": lease.get("owner_mode"),
        "status": lease.get("status"),
        "boot_id": lease.get("boot_id"),
    }


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


def validate_request(request: dict) -> None:
    operation = str(request.get("operation"))
    if operation != "health" and not ID_RE.fullmatch(str(request.get("trial_id", ""))):
        raise ValueError("invalid trial_id")
    if operation != "health" and not str(request.get("trial_id", "")).startswith("lg-"):
        raise ValueError("trial_id is outside the LangGraph namespace")
    if operation != "health":
        lease = load_active_lease()
        if lease.get("trial_id") != request.get("trial_id") or lease.get(
            "slot_lease_id"
        ) != request.get("slot_lease_id"):
            raise PermissionError("slot lease does not own this active Trial")
    if operation == "observe" and request.get("capability") not in CAPABILITIES:
        raise ValueError("unsupported diagnostic capability")
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
            "candidate_ref": "langgraph-v1",
            "evalos_trial_id": request.get("evalos_trial_id"),
            "lease_ttl_seconds": int(request.get("lease_ttl_seconds", 7200)),
        }
    )
    if not base.get("ok"):
        return base
    topology = run([str(TOPOLOGY), "prepare", str(request["scenario_id"])], timeout=90)
    if topology.returncode != 0:
        base_call({"operation": "reset", "trial_id": request["trial_id"]})
        return error("prepare", "MEC_TOPOLOGY_FAILED", (topology.stdout or "")[-400:])
    topology_view = topology_status()
    slot_lease_id = str(base.get("lease_id") or "")
    if not slot_lease_id:
        base_call({"operation": "reset", "trial_id": request["trial_id"]})
        return error(
            "prepare",
            "PHYSICAL_LEASE_MISSING",
            "base Twin did not issue the physical lease",
        )
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
    network = harness_probes.topology(NETWORK_PROFILE)
    records = {
        "ip_reachability": lambda: [harness_probes.probe("ip", parameters, resource_scope, network=network)],
        "network_path": lambda: [harness_probes.probe("trace", parameters, resource_scope, network=network)],
        "tcp_port": lambda: [harness_probes.probe("tcp", parameters, resource_scope, network=network)],
        "sctp_association": probe_sctp,
        "dns": lambda: [harness_probes.probe("dns", parameters, resource_scope, network=network)],
        "http_service": lambda: [harness_probes.probe("http", parameters, resource_scope, network=network)],
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
        "data": {
            "records": records,
            "partial": any(
                item.get("observation_available") is False
                or item.get("truncated") is True
                or item.get("resolution") in {"unknown", "unresolved"}
                for item in records
            ),
            "observation_context": {
                "contract_version": "opsmind-lg-protocol-observation/1.0",
                "trial_id": trial_id,
                "capability": capability,
                "production_network": False,
                "resource_scope": resource_scope,
            },
        },
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
        refs = [
            {
                "identifier_domain": "opsmind-twin",
                "namespace": parameters.get("namespace_id"),
                "resource_type": allowed.get(str(parameters.get("resource_id"))),
                "resource_id": parameters.get("resource_id"),
            }
        ]
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
        normalized.append(
            {
                "identifier_domain": "opsmind-twin",
                "namespace": trial_id,
                "resource_type": expected_type,
                "resource_id": resource_id,
            }
        )
    return normalized


def query_resource_observation(
    trial_id: str,
    parameters: dict,
    capability: str,
    resource_scope: dict,
) -> tuple[list[dict], list[str]]:
    refs = _resource_refs(trial_id, parameters, resource_scope)
    if "runtime_types" in parameters:
        raise ValueError("runtime_types is not supported by this process-backed lab source")
    if parameters.get("since_seconds") is not None:
        raise ValueError("retained log tails do not support since_seconds; use bounded line_limit")
    if (
        capability == "sandboxed_readonly_diagnostic"
        and parameters.get("diagnostic_profile") == "network_policy"
    ):
        return query_network_policy(trial_id, refs, parameters.get("service_id")), []
    process_response = base_observe(trial_id, "processes")
    process_data = dict(process_response.get("data") or {})
    diagnostic_profile = str(parameters.get("diagnostic_profile") or "process_summary")
    if (
        capability == "sandboxed_readonly_diagnostic"
        and diagnostic_profile not in READONLY_DIAGNOSTIC_PROFILES
    ):
        raise ValueError("unsupported readonly diagnostic profile")
    logs: dict = {}
    if capability == "sandboxed_readonly_diagnostic" and diagnostic_profile == "bounded_log_tail":
        logs = dict(base_observe(trial_id, "logs").get("data") or {})
    source_evidence_refs = {str(item) for item in process_response.get("evidence_refs") or []}
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
        raw_active = (
            None if target is None else dict(process_data.get(target[0]) or {}).get(target[1])
        )
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
                status=("running" if active else "stopped" if active is False else "unknown"),
            )
            if diagnostic_profile == "bounded_log_tail":
                line_limit = max(1, min(1000, int(parameters.get("line_limit", 80))))
                if ref["resource_id"] == "gnb-1":
                    selected = logs.get("gnb") or []
                elif ref["resource_id"] == "ue-1":
                    selected = logs.get("ue") or []
                else:
                    selected = dict(logs.get("open5gs") or {}).get(ref["resource_id"]) or []
                record["log_tail"] = [str(line)[:500] for line in list(selected)[-line_limit:]]
        records.append(record)
    return records, list(dict.fromkeys(matched_evidence_refs))


def probe_sctp() -> list[dict]:
    output = collected(["ss", "-H", "-n", "-A", "sctp"])
    lines = [line[:500] for line in output.splitlines() if line.strip()]
    return [{"association_count": len(lines), "associations": lines[:30]}]


def query_routes(parameters: dict) -> list[dict]:
    profile = parameters.get("node_profile", "ue")
    prefix = node_prefix(profile)
    output = collected([*prefix, "ip", "-j", "route", "show"])
    return [{"node_profile": profile, "routes": json.loads(output)}]


def query_interfaces(parameters: dict) -> list[dict]:
    profile = parameters.get("node_profile", "ue")
    prefix = node_prefix(profile)
    output = collected([*prefix, "ip", "-j", "address", "show"])
    return [{"node_profile": profile, "interfaces": json.loads(output)}]


def query_sockets(parameters: dict) -> list[dict]:
    profile = parameters.get("node_profile", "core")
    prefix = node_prefix(profile)
    output = collected([*prefix, "ss", "-H", "-a", "-n", "-p", "-A", "tcp,udp,sctp"])
    lines = [line[:500] for line in output.splitlines() if line.strip()]
    return [
        {
            "node_profile": profile,
            "protocols": ["tcp", "udp", "sctp"],
            "socket_count": len(lines),
            "sockets": lines[:80],
            "truncated": len(lines) > 80,
            "kernel_namespace": prefix[3] if prefix else "host",
        }
    ]


def network_diagnostics():
    """Load the single installed collector from the trusted controller release."""
    release = Path("/opt/opsmind-twin-controller/current").resolve(strict=True)
    identity = json.loads((release / "RELEASE.json").read_text())
    if identity.get("source_revision") != "8e859e82158479688f48efae0df04e353ffb5356":
        raise RuntimeError("LG requires the approved network-evidence controller release")
    source = release / "harness_diagnostics.py"
    loader = SourceFileLoader("lg_network_diagnostics", str(source))
    spec = spec_from_loader(loader.name, loader)
    module = module_from_spec(spec)
    exec(compile(source.read_bytes(), str(source), "exec"), module.__dict__)
    if module.CONTRACT != "opsmind-network-observation/1.0":
        raise RuntimeError("network observation contract mismatch")
    return module


def protocol_summary(trial_id: str, parameters: dict) -> list[dict]:
    collector = network_diagnostics()
    collector.capture_filter(parameters)
    module = load_base_module()
    state = module.load_state()
    if not state or state.get("trial_id") != trial_id:
        raise PermissionError("capture does not belong to the active Trial")
    expected = module.PCAP_ROOT.resolve() / trial_id
    directory = Path(state.get("pcap_dir", "")).resolve()
    if directory != expected or expected.is_symlink():
        raise PermissionError("capture directory is outside the active Trial")
    return [collector.capture_summary(trial_id, parameters, directory, observed_at=now())]


def query_network_policy(trial_id: str, refs: list[dict], service_id: str | None) -> list[dict]:
    collector = network_diagnostics()
    profiles = {
        **{name: "core" for name in RUNTIME_TARGETS},
        **{name: "core" for name in ("twin-t1", "n2", "n3", "n4", "n6")},
        "ue-1": "ue",
        "dns": "mec",
    }
    records, collected_namespaces = [], {}
    for ref in refs:
        target = RUNTIME_TARGETS.get(ref["resource_id"])
        if service_id and service_id != (target[2] if target else ref["resource_id"]):
            raise PermissionError("service_id does not match the leased lab resource")
        profile = profiles.get(ref["resource_id"])
        if profile is None:
            raise ValueError("network policy location is not declared for this resource")
        prefix = node_prefix(profile)
        namespace = prefix[3] if prefix else "host"
        if namespace not in collected_namespaces:
            collected_namespaces[namespace] = collector.network_policy(
                prefix, run=run, observed_at=now()
            )
        records.append(
            {
                **collected_namespaces[namespace],
                "diagnostic_profile": "network_policy",
                "resource_id": ref["resource_id"],
                "resource_type": ref["resource_type"],
                "namespace_id": trial_id,
                "resolution": "resolved",
                "source_ref": f"protocol-lab:{trial_id}:network_policy:{namespace}",
                "policy_scope": "kernel_namespace_only",
            }
        )
    return records


def collected(args: list[str]) -> str:
    response = run(args, timeout=8)
    if response.returncode != 0:
        raise RuntimeError("bounded diagnostic collection failed")
    return response.stdout or ""


def local_listener_health(resource_id: str, target: tuple | None, active: bool | None) -> dict:
    protocols = {"amf": "sctp", "smf": "udp", "upf": "udp", "nrf": "tcp", "mongodb": "tcp"}
    protocol = protocols.get(resource_id)
    details = {
        "active": active,
        "ready": False if active is False else None,
        "health_scope": "local_process_listener",
        "business_health": "not_measured",
        "checks": {"process_active": active, "owned_protocol_listener": None},
    }
    if active is True and target and protocol:
        pid = collected(["systemctl", "show", target[1], "--property=MainPID", "--value"]).strip()
        if not pid.isdigit() or int(pid) <= 0:
            raise RuntimeError("active service has no valid MainPID")
        output = collected(["ss", "-H", "-l", "-n", "-p", "-A", protocol])
        owned = [
            line[:500] for line in output.splitlines() if re.search(rf"\bpid={int(pid)},", line)
        ]
        details.update(
            process_id=int(pid), listener_protocol=protocol, listeners=owned[:30], ready=bool(owned)
        )
        details["checks"]["owned_protocol_listener"] = bool(owned)
    details["health"] = (
        "healthy"
        if details["ready"] is True
        else "unhealthy"
        if details["ready"] is False
        else "unknown"
    )
    return details


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
        name for name in checked_fields if not secrets.compare_digest(active[name], reference[name])
    ]
    return [
        {
            "subscriber_present": bool(subscriber.get("present")),
            "ue_profile_available": bool(active),
            "reference_profile_available": bool(reference),
            "checked_fields": checked_fields,
            "authentication_profile_consistent": bool(checked_fields) and not mismatched_fields,
            "mismatched_fields": mismatched_fields,
            "secret_values_exposed": False,
        }
    ]


def node_prefix(profile: str) -> list[str]:
    namespace = {
        "ue": "opsmind-ue",
        "transport": "opsmind-lg-b",
        "mec": "opsmind-lg-mec",
    }.get(profile)
    if namespace:
        return ["ip", "netns", "exec", namespace]
    if profile in {"gnb", "upf", "core"}:
        return []
    raise ValueError("invalid node_profile")


def act(request: dict) -> dict:
    external_request_id = str(request["external_request_id"])
    binding = digest({key: request.get(key) for key in ("trial_id", "action_type", "parameters")})
    existing = request_record(external_request_id)
    if existing is not None:
        if existing.get("request_binding_digest") != binding:
            raise PermissionError("action request binding does not match its stored receipt")
        return existing
    trial_id = str(request["trial_id"])
    snapshot = active_snapshot(trial_id)
    action_type = str(request.get("action_type"))
    if action_type == "rollback_action":
        response = rollback_fault(snapshot, request)
    else:
        try:
            parameters = action_parameters(action_type, request.get("parameters"), snapshot)
        except ValueError as exc:
            response = error("act", "ACTION_CONTRACT_REJECTED", str(exc))
            response["data"] = {"status": "failed", "changed_external_state": False}
            response["request_binding_digest"] = binding
            save_request_record(external_request_id, response)
            return response
        # Persist intent before the first possible external change. A process
        # crash, transport error or response loss must leave an UNKNOWN receipt,
        # never an invitation to run the same write again.
        save_request_record(
            external_request_id,
            {
                "ok": False,
                "operation": "act",
                "request_binding_digest": binding,
                "data": {"status": "unknown", "changed_external_state": True},
                "observed_at": now(),
            },
        )
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
            status="succeeded" if response.get("ok") else "unknown",
            changed_external_state=bool(data.get("applied")) if response.get("ok") else True,
            task_success=verification.get("task_success"),
        )
        response = {**response, "data": data}
    response["request_binding_digest"] = binding
    save_request_record(external_request_id, response)
    return response


def action_parameters(action_type: str, parameters: dict, snapshot: dict) -> dict:
    # Selection is derived exclusively from the approved target, never fault labels.
    if not isinstance(parameters, dict) or set(parameters) != {
        "target_profile",
        "product_action_type",
    }:
        raise ValueError("action requires the exact approved target contract")
    document = json.loads(ACTION_CONTRACT_FILE.read_text(encoding="utf-8"))
    if document.get("contract_version") != "opsmind-protocol-action-catalog/3.0":
        raise ValueError("unsupported protocol action catalog")
    definition = next(
        (
            item
            for item in document["actions"]
            if item["product_action_type"] == parameters["product_action_type"]
        ),
        None,
    )
    target = parameters["target_profile"]
    if (
        definition is None
        or definition["remote_action_type"] != action_type
        or target not in definition["target_parameters"]
    ):
        raise ValueError("action type or target is outside its registered contract")
    scope = snapshot.get("resource_scope") or {}
    trial_id = snapshot.get("trial_id")
    if (
        not trial_id
        or scope.get("namespace") != trial_id
        or not any(
            ref.get("resource_id") == target
            and ref.get("namespace") == trial_id
            and ref.get("identifier_domain") == "opsmind-twin"
            for ref in scope.get("resource_refs", ())
        )
    ):
        raise PermissionError("approved action target is outside the active Trial scope")
    return dict(definition["target_parameters"][target])


def rollback_fault(snapshot: dict, request: dict) -> dict:
    # Lab teardown belongs exclusively to the owner. Never reset the scene to
    # pretend that a particular product action has been undone.
    return error("act", "ROLLBACK_UNSUPPORTED", "no verified per-action inverse is registered")


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
    response = base_call({"operation": "snapshot", "trial_id": request["trial_id"]})
    if not response.get("ok"):
        return response
    value = dict(response.get("snapshot") or {})
    recovery = dict(value.get("recovery") or {})
    verification = harness_probes.business_verification(
        dict(value.get("resource_scope") or {}), NETWORK_PROFILE)
    value.update(
        topology=topology_status(),
        # The scenario score stays visible as a scenario signal only. Product
        # health is the independently sampled business verification below.
        task_success=recovery.get("task_success"),
        business_verification=verification,
        healthy=verification["passed"],
        production_network=False,
    )
    return {**response, "snapshot": value}


def business_verify(request: dict) -> dict:
    """Independent business truth for the active Trial, never a scenario score.

    ``ok`` says whether the laboratory could observe the data path at all.
    ``business_verification.passed`` is the business verdict: True, False, or
    None when the probes themselves were unavailable.
    """
    trial_id = str(request["trial_id"])
    snapshot_state = active_snapshot(trial_id)
    verification = harness_probes.business_verification(
        dict(snapshot_state.get("resource_scope") or {}), NETWORK_PROFILE)
    return {"ok": verification["passed"] is not None, "operation": "business-verify",
            "trial_id": trial_id, "business_verification": verification,
            "observed_at": verification["observed_at"]}


def reset(request: dict) -> dict:
    response = base_call({"operation": "reset", "trial_id": request["trial_id"]})
    topology = run([str(TOPOLOGY), "reset"], timeout=60)
    clean = bool(response.get("clean")) and topology.returncode == 0
    reset_hash = digest(
        {"base": response.get("reset_hash"), "topology_clean": topology.returncode == 0}
    )
    return {
        **response,
        "ok": bool(response.get("ok")) and clean,
        "clean": clean,
        "reset_hash": reset_hash,
    }


def health() -> dict:
    response = base_call({"operation": "health"})
    active_trial = str(response.get("active_trial") or "")
    owned_trial = active_trial if active_trial.startswith("lg-") else None
    physical_lease = dict(response.get("physical_lease") or {})
    lease = (
        {
            "trial_id": physical_lease.get("runtime_trial_id"),
            "slot_lease_id": physical_lease.get("lease_id"),
        }
        if physical_lease.get("candidate_ref") == "langgraph-v1"
        else {}
    )
    slot_lease_id = lease.get("slot_lease_id") if lease.get("trial_id") == owned_trial else None
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
    with temporary.open("w", encoding="utf-8") as output:
        os.chmod(temporary, 0o600)
        json.dump(response, output, ensure_ascii=False, sort_keys=True)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)
    if os.name == "posix":
        directory = os.open(REQUEST_ROOT, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


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
        parsed = json.loads(value or "[]")
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def error(operation: str, code: str, message: str) -> dict:
    return {"ok": False, "operation": operation, "error": {"code": code, "message": message[:500]}}


def dispatch(request: dict) -> dict:
    ensure_identity(request)
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
        if not ID_RE.fullmatch(trial_id) or not trial_id.startswith("lg-"):
            raise ValueError("manager trial_id must start with lg-")
        if not ID_RE.fullmatch(scenario_id):
            raise ValueError("invalid scenario_id")
        if owner_mode not in {"langgraph_direct", "evalos_trial"}:
            raise ValueError("invalid LangGraph physical lab owner mode")
        evalos_trial_id = arguments[5] if len(arguments) == 6 else None
        if owner_mode == "evalos_trial" and not evalos_trial_id:
            raise ValueError("evalos_trial requires evalos_trial_id")
        if owner_mode == "langgraph_direct" and evalos_trial_id:
            raise ValueError("direct mode must not claim evalos_trial_id")
        return prepare(
            {
                "trial_id": trial_id,
                "scenario_id": scenario_id,
                "seed": int(seed_text),
                "owner_mode": owner_mode,
                "evalos_trial_id": evalos_trial_id,
                "lease_ttl_seconds": 7200,
            }
        )
    if command == "manage-reset" and len(arguments) == 2:
        trial_id = arguments[1]
        if not ID_RE.fullmatch(trial_id) or not trial_id.startswith("lg-"):
            raise ValueError("manager trial_id must start with lg-")
        return reset({"trial_id": trial_id})
    if command == "business-verify" and len(arguments) == 2:
        trial_id = arguments[1]
        if not ID_RE.fullmatch(trial_id) or not trial_id.startswith("lg-"):
            raise ValueError("manager trial_id must start with lg-")
        return business_verify({"trial_id": trial_id})
    raise ValueError(
        "use manage-status, manage-prepare <lg-trial-id> <scenario-id> <seed> "
        "<langgraph_direct|evalos_trial> [evalos-trial-id], "
        "manage-reset <lg-trial-id>, or business-verify <lg-trial-id>"
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
