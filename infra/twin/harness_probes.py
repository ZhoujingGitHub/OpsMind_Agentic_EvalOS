"""Bounded probes for the currently leased laboratory UE; no routing mutations."""
from __future__ import annotations

import datetime as dt
import errno
import ipaddress
import json
from pathlib import Path
import re
import socket
import subprocess
import sys
import time

MANIFEST = Path("/etc/opsmind-twin/stack.manifest.json")


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def run(args, *, timeout=10):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)


def topology():
    return json.loads(MANIFEST.read_text())["harness_network"]


def ue_source(scope, network, runner=run):
    """Resolve one current TUN in the authorized single-UE lab, never a cached IP."""
    namespace = scope.get("namespace")
    refs = [r for r in scope.get("resource_refs", [])
            if r.get("identifier_domain") == "opsmind-twin" and r.get("namespace") == namespace
            and r.get("resource_id") == network["ue_resource_id"]]
    if scope.get("identifier_domain") != "opsmind-twin" or not namespace or len(refs) != 1:
        raise PermissionError("UE resource is outside the active Trial")
    result = runner(["ip", "-n", network["ue_namespace"], "-j", "-d", "address", "show"])
    if result.returncode:
        raise OSError(errno.ENODEV, "UE namespace is unavailable")
    interfaces = json.loads(result.stdout)
    subnet = ipaddress.ip_network(network["ue_network"])
    candidates = []
    for interface in interfaces:
        # TUN metadata identifies the data path; the management veth is excluded.
        if interface.get("linkinfo", {}).get("info_kind") != "tun" or "UP" not in interface.get("flags", []):
            continue
        for address in interface.get("addr_info", []):
            if address.get("family") == "inet" and ipaddress.ip_address(address["local"]) in subnet:
                candidates.append((interface["ifname"], address["local"]))
    if len(candidates) != 1:
        raise ValueError("UE data session is missing or ambiguous")
    device, address = candidates[0]
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", device):
        raise ValueError("invalid UE interface")
    return {"resource_ref": refs[0], "network_namespace": network["ue_namespace"],
            "interface": device, "address": address}


def failure(error, stage):
    if isinstance(error, (TimeoutError, subprocess.TimeoutExpired)):
        code = "TIMEOUT"
    elif isinstance(error, PermissionError):
        code = "PERMISSION_DENIED"
    elif isinstance(error, OSError):
        code = errno.errorcode.get(error.errno, "IO_ERROR")
    else:
        code = "INVALID_SOURCE" if stage == "source_resolution" else "INVALID_RESPONSE"
    return {"code": code, "stage": stage, "message": str(error)[:240]}


def bound_socket(kind, source):
    sock = socket.socket(socket.AF_INET, kind)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, source["interface"].encode() + b"\0")
        sock.bind((source["address"], 0))
        sock.settimeout(4)
        return sock
    except BaseException:
        sock.close()
        raise


def socket_probe(request):
    """Runs inside the selected network namespace. DNS parsing uses dnspython."""
    source, target = request["source"], request["target"]
    started = time.monotonic()
    try:
        if request["kind"] == "tcp":
            with bound_socket(socket.SOCK_STREAM, source) as sock:
                sock.connect((target["address"], target["port"]))
            return {"connected": True, "elapsed_ms": round((time.monotonic() - started) * 1000, 3)}
        import dns.exception
        import dns.message
        import dns.query
        import dns.rcode
        import dns.rdatatype
        with bound_socket(socket.SOCK_DGRAM, source) as sock:
            sock.setblocking(False)
            query = dns.message.make_query(target["name"], "A")
            reply = dns.query.udp(query, target["address"], timeout=4,
                                  port=target["port"], sock=sock)
        answers = [str(record.address) for group in reply.answer
                   if group.rdtype == dns.rdatatype.A for record in group]
        return {"resolved": reply.rcode() == dns.rcode.NOERROR and bool(answers),
                "answers": answers, "rcode": dns.rcode.to_text(reply.rcode()),
                "elapsed_ms": round((time.monotonic() - started) * 1000, 3)}
    except ImportError:
        return {"error": {"code": "DEPENDENCY_UNAVAILABLE", "stage": "collector",
                          "message": "dnspython is not installed"}}
    except Exception as exc:
        # dnspython has its own Timeout class, independent of socket.timeout.
        if type(exc).__module__.startswith("dns.") and type(exc).__name__ == "Timeout":
            exc = TimeoutError("DNS response timed out")
        return {"error": failure(exc, "network_probe")}


def trace_result(result, target):
    hops = []
    for line in result.stdout.splitlines():
        match = re.match(r"^\s*(\d+)\s+(.*)$", line)
        if match:
            hops.append({"hop": int(match[1]), "detail": match[2][:240]})
    reached = any(re.search(r"(?<![\d.])" + re.escape(target) + r"(?![\d.])", h["detail"])
                  and not re.search(r"![A-Z]", h["detail"]) for h in hops)
    return {"complete": result.returncode == 0 and reached, "hops": hops,
            "hop_count": len(hops), "exit_code": result.returncode,
            "diagnostic": result.stderr[-400:]}


def probe(kind, parameters, scope, *, runner=None, network=None):
    runner = runner or run
    network = network or topology()
    started_at, started = now(), time.monotonic()
    success_key = {"ip": "reachable", "trace": "complete", "tcp": "connected",
                   "dns": "resolved", "http": "healthy"}[kind]
    record = {success_key: False, "started_at": started_at, "source": None}
    try:
        source = ue_source(scope, network, runner)
        record["source"] = source
    except Exception as exc:
        return {**record, "status": "unavailable", "error": failure(exc, "source_resolution"),
                "completed_at": now(),
                "duration_ms": round((time.monotonic() - started) * 1000, 3)}
    try:
        prefix = ["ip", "netns", "exec", source["network_namespace"]]
        device = source["interface"]
        if kind in {"ip", "trace"}:
            profile = parameters.get("target_profile", "mec")
            target = {"mec": network["mec_address"], "dns": network["dns_address"],
                      "core": network["ue_gateway"]}.get(profile)
            if target is None or (kind == "trace" and profile == "core"):
                raise ValueError("invalid target_profile")
            record.update(target_profile=profile, target=target)
            if kind == "ip":
                result = runner([*prefix, "ping", "-I", device, "-c", "3", "-W", "2", target], timeout=10)
                record.update(reachable=result.returncode == 0, exit_code=result.returncode,
                              diagnostic=(result.stdout + result.stderr)[-800:])
            else:
                result = runner([*prefix, "traceroute", "-n", "-i", device, "-s", source["address"],
                                 "-m", "10", "-q", "1", "-w", "1", target], timeout=13)
                record.update(trace_result(result, target))
        elif kind in {"tcp", "dns"}:
            if kind == "dns":
                profile = parameters.get("query_profile", "mec-service")
                if profile != "mec-service":
                    raise ValueError("invalid query_profile")
                target = {"address": network["dns_address"], "port": 53, "name": network["dns_name"]}
                record.update(query_profile=profile, answers=[])
            else:
                profile = parameters.get("service_profile", "mec-http")
                target = {"mec-http": {"address": network["mec_address"], "port": network["http_port"]},
                          "mec-mqtt": {"address": network["mec_address"], "port": network["mqtt_port"]},
                          "dns-tcp": {"address": network["dns_address"], "port": 53}}.get(profile)
                if target is None:
                    raise ValueError("invalid service_profile")
                record.update(service_profile=profile)
            record["target"] = target
            request = {"kind": kind, "source": source, "target": target}
            result = runner([*prefix, "python3", str(Path(__file__).resolve()),
                             json.dumps(request, separators=(",", ":"))], timeout=7)
            if result.returncode:
                raise RuntimeError("socket collector failed: " + result.stderr[-200:])
            record.update(json.loads(result.stdout))
        else:
            profile = parameters.get("service_profile", "mec-http")
            if profile != "mec-http":
                raise ValueError("invalid service_profile")
            target = f'http://{network["mec_address"]}:{network["http_port"]}/health'
            record.update(service_profile=profile, target=target)
            result = runner([*prefix, "curl", "--silent", "--show-error", "--noproxy", "*",
                             "--interface", "if!" + device, "--connect-timeout", "3",
                             "--max-time", "5", "--max-filesize", "4096", "--proto", "=http",
                             "--write-out", "\n%{http_code}", target], timeout=7)
            body, _, status = result.stdout.rpartition("\n")
            try:
                payload = json.loads(body)
            except ValueError:
                payload = {}
            record.update(exit_code=result.returncode,
                          http_status=int(status) if status.isdigit() else None,
                          response=body[:1000], diagnostic=result.stderr[-400:],
                          healthy=result.returncode == 0 and status == "200"
                          and payload.get("service") == "opsmind-protocol-lab-mec"
                          and payload.get("status") == "healthy")
        record["status"] = "success" if record[success_key] else "failed"
    except Exception as exc:
        record.update(status="failed", error=failure(exc, "network_probe"))
    return {**record, "completed_at": now(),
            "duration_ms": round((time.monotonic() - started) * 1000, 3)}


def business_verification(scope):
    """Fresh sampling by the verifier; no model results or cached booleans."""
    network = topology()
    dns = probe("dns", {}, scope, network=network)
    http = probe("http", {}, scope, network=network)
    expected_address = network["mec_address"]
    passed = (dns.get("resolved") is True and expected_address in dns.get("answers", [])
              and http.get("healthy") is True
              and dns.get("source") == http.get("source"))
    unavailable = any(x.get("status") == "unavailable" or
                      x.get("error", {}).get("code") == "DEPENDENCY_UNAVAILABLE" for x in (dns, http))
    return {"contract_version": "opsmind-mec-business-verification/1.0",
            "required_checks": ["mec_dns_answer", "mec_http_health"],
            "status": "passed" if passed else "inconclusive" if unavailable else "failed",
            "passed": True if passed else None if unavailable else False,
            "checks": {"dns": dns, "http": http}, "observed_at": now()}


if __name__ == "__main__":
    print(json.dumps(socket_probe(json.loads(sys.argv[1])), separators=(",", ":")))
