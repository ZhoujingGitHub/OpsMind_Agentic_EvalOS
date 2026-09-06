"""Read-only network observations from the installed Linux lab, never Case answers."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import struct
import tempfile
import time

CONTRACT = "opsmind-network-observation/1.0"
CAPTURE_PARAMETERS = {
    "protocol": {"type": "string", "enum": ["sctp", "ngap", "pfcp", "gtp"]},
    "start_at": {"type": "string", "format": "date-time"},
    "end_at": {"type": "string", "format": "date-time"},
    "source_ip": {"type": "string", "format": "ipv4"},
    "destination_ip": {"type": "string", "format": "ipv4"},
    "source_port": {"type": "integer", "minimum": 1, "maximum": 65535},
    "destination_port": {"type": "integer", "minimum": 1, "maximum": 65535},
    "frame_limit": {"type": "integer", "minimum": 1, "maximum": 1000},
}
MAX_CAPTURE_BYTES = 110 * 1024 * 1024
MAX_ANALYSIS_BYTES = 8 * 1024 * 1024
FIELDS = (
    "frame.time_epoch", "frame.number", "frame.protocols", "ip.src", "ip.dst",
    "sctp.srcport", "sctp.dstport", "sctp.chunk_type", "udp.srcport", "udp.dstport",
    "frame.interface_id", "frame.interface_name", "sll.ifindex",
)


def utc(value: float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


def timestamp(value: object) -> float:
    if not isinstance(value, str):
        raise ValueError("capture time must be an ISO 8601 string with timezone")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("capture time requires an explicit timezone")
    return parsed.timestamp()


def capture_filter(parameters: dict) -> str:
    if not isinstance(parameters, dict) or set(parameters) - set(CAPTURE_PARAMETERS):
        raise ValueError("unsupported capture query parameter")
    protocol = parameters.get("protocol")
    if "protocol" in parameters and protocol not in CAPTURE_PARAMETERS["protocol"]["enum"]:
        raise ValueError("unsupported capture protocol")
    clauses = [protocol or "(sctp || ngap || pfcp || gtp)"]
    times = {}
    for name, operator in (("start_at", ">="), ("end_at", "<=")):
        if name in parameters:
            times[name] = timestamp(parameters[name])
            clauses.append(f"frame.time_epoch {operator} {times[name]:.6f}")
    if len(times) == 2 and times["start_at"] > times["end_at"]:
        raise ValueError("capture start_at must not be after end_at")
    for name, field in (("source_ip", "ip.src"), ("destination_ip", "ip.dst")):
        if name in parameters:
            if not isinstance(parameters[name], str):
                raise ValueError("capture endpoint must be an IPv4 string")
            address = ipaddress.IPv4Address(parameters[name])
            clauses.append(f"{field} == {address}")
    for name, direction in (("source_port", "srcport"), ("destination_port", "dstport")):
        if name in parameters:
            port = parameters[name]
            if type(port) is not int or not 1 <= port <= 65535:
                raise ValueError("capture port must be an integer from 1 to 65535")
            clauses.append(f"(sctp.{direction} == {port} || udp.{direction} == {port})")
    limit = parameters.get("frame_limit", 100)
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise ValueError("frame_limit must be an integer from 1 to 1000")
    return " && ".join(f"({clause})" for clause in clauses)


def parse_policy(text: str) -> dict:
    """Preserve ordered individual rules. No cross-line keyword matching or RCA."""
    tables = []
    current = None
    ordinal = Counter()
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        if line.startswith("*"):
            current = {"table": line[1:], "chains": [], "rules": []}
            tables.append(current)
            ordinal.clear()
        elif line == "COMMIT":
            current = None
        elif current is None:
            raise ValueError("invalid iptables-save table boundary")
        elif line.startswith(":"):
            match = re.fullmatch(r":(\S+) (\S+) \[(\d+):(\d+)\]", line)
            if not match:
                raise ValueError("invalid iptables-save chain")
            name, policy, packets, size = match.groups()
            current["chains"].append({"name": name, "policy": policy,
                                      "packets": int(packets), "bytes": int(size)})
        else:
            match = re.fullmatch(r"\[(\d+):(\d+)\] (-A .+)", line)
            if not match:
                raise ValueError("rule counters or rule syntax unavailable")
            packets, size, rule = match.groups()
            tokens = shlex.split(rule)
            chain = tokens[1]
            ordinal[chain] += 1
            fields = {}
            options = {"-p": "protocol", "-s": "source", "-d": "destination",
                       "-i": "input_interface", "-o": "output_interface",
                       "--dport": "destination_port", "--sport": "source_port",
                       "-j": "target", "-g": "goto"}
            for index, token in enumerate(tokens):
                if token in options and index + 1 < len(tokens):
                    fields[options[token]] = tokens[index + 1]
            current["rules"].append({
                "chain": chain, "position": ordinal[chain], "packets": int(packets),
                "bytes": int(size), "rule": rule, "tokens": tokens, **fields,
                "has_negation": "!" in tokens,
            })
    if current is not None or not tables:
        raise ValueError("incomplete iptables-save output")
    return {"tables": tables}


def network_policy(prefix: list[str], *, run, observed_at: str) -> dict:
    result = []
    for table in ("filter", "nat"):
        response = run([*prefix, "iptables-save", "-c", "-t", table], timeout=10)
        if response.returncode != 0:
            raise RuntimeError(f"network policy collection failed for {table}")
        text = response.stdout or ""
        if len(text.encode()) > MAX_ANALYSIS_BYTES:
            raise RuntimeError("network policy exceeds the bounded collector size")
        result.extend(parse_policy(text)["tables"])
    payload = json.dumps(result, sort_keys=True, separators=(",", ":")).encode()
    return {
        "contract_version": CONTRACT, "sampling_mode": "kernel_policy_snapshot",
        "kernel_namespace": prefix[3] if prefix else "host",
        "policy_backend": "iptables", "tables": result,
        "observed_at": observed_at, "policy_digest": hashlib.sha256(payload).hexdigest(),
        "coverage": {"tables": ["filter", "nat"], "other_policy_backends": "not_collected",
                     "kernel_namespace_shared_by_resources": not bool(prefix)},
        "counter_semantics": "cumulative_since_rule_install_or_external_reset",
        "causal_conclusion": "not_computed", "read_only": True,
    }


def _analyse(snapshot: Path, destination: Path, display_filter: str, *, deadline: float) -> None:
    args = ["tshark", "-n", "-r", str(snapshot), "-Y", display_filter,
            "-T", "fields", "-E", "separator=/t", "-E", "occurrence=f"]
    for field in FIELDS:
        args += ["-e", field]
    # Child output is kept bounded on disk, never accumulated without a limit.
    with destination.open("wb") as output, tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(args, stdout=output, stderr=errors)
        try:
            while process.poll() is None:
                if time.monotonic() >= deadline or destination.stat().st_size > MAX_ANALYSIS_BYTES:
                    raise RuntimeError("capture query too broad or timed out; narrow the time/protocol/endpoint filter")
                time.sleep(0.05)
            if destination.stat().st_size > MAX_ANALYSIS_BYTES:
                raise RuntimeError("capture query too broad; narrow the filter")
            if process.returncode != 0:
                raise RuntimeError("capture could not be fully decoded; no empty-success result was produced")
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()


def _freeze(source: Path, destination: Path, boundary: os.stat_result) -> str:
    digest = hashlib.sha256()
    with source.open("rb") as reader, destination.open("wb") as writer:
        before = os.fstat(reader.fileno())
        if (before.st_ino, before.st_size) != (boundary.st_ino, boundary.st_size):
            # Appending is permitted; replacement/truncation is not.
            if before.st_ino != boundary.st_ino or before.st_size < boundary.st_size:
                raise RuntimeError("capture rotated while snapshotting; retry the observation")
        remaining = boundary.st_size
        while remaining:
            data = reader.read(min(1024 * 1024, remaining))
            if not data:
                raise RuntimeError("capture truncated while snapshotting; retry the observation")
            writer.write(data)
            digest.update(data)
            remaining -= len(data)
        reader.seek(0)
        verify = hashlib.sha256()
        remaining = boundary.st_size
        while remaining:
            data = reader.read(min(1024 * 1024, remaining))
            if not data:
                raise RuntimeError("capture changed while snapshotting; retry the observation")
            verify.update(data)
            remaining -= len(data)
        if digest.digest() != verify.digest():
            raise RuntimeError("capture changed while snapshotting; retry the observation")
    return digest.hexdigest()



def _complete_packets(snapshot: Path) -> dict:
    """Trim only an unfinished final PCAP record in our private copy.

    tcpdump may still be appending. This is record framing, not a second packet
    decoder; Tshark remains authoritative for packet interpretation.
    """
    size = snapshot.stat().st_size
    end = 0
    with snapshot.open("rb") as stream:
        header = stream.read(24)
        if len(header) == 24:
            endian = {b"\xd4\xc3\xb2\xa1": "<", b"\xa1\xb2\xc3\xd4": ">",
                      b"\x4d\x3c\xb2\xa1": "<", b"\xa1\xb2\x3c\x4d": ">"}.get(header[:4])
            if endian is None:
                raise RuntimeError("unsupported capture format; expected installed tcpdump PCAP")
            major, minor, _, _, snaplen, _ = struct.unpack(endian + "HHIIII", header[4:])
            if (major, minor) != (2, 4) or not 0 < snaplen <= MAX_CAPTURE_BYTES:
                raise RuntimeError("invalid capture header")
            end = 24
            while end < size:
                frame_header = stream.read(16)
                if len(frame_header) < 16:
                    break
                _, _, included, original = struct.unpack(endian + "IIII", frame_header)
                if included > snaplen or included > original:
                    raise RuntimeError("invalid capture record length")
                if end + 16 + included > size:
                    break
                stream.seek(included, 1)
                end += 16 + included
    if end != size:
        with snapshot.open("r+b") as stream:
            stream.truncate(end)
    return {"analysed_bytes": end, "incomplete_tail_bytes": size - end}


def capture_summary(trial_id: str, parameters: dict, capture_dir: Path, *, observed_at: str) -> dict:
    display_filter = capture_filter(parameters)
    directory = capture_dir.resolve(strict=True)
    files = sorted(directory.glob("capture.pcap*"))
    if any(path.is_symlink() or not path.is_file() for path in files):
        raise PermissionError("capture inventory contains an invalid file")
    boundaries = [(path, path.stat()) for path in files]
    total_bytes = sum(info.st_size for _, info in boundaries)
    if len(files) > 4 or total_bytes > MAX_CAPTURE_BYTES:
        raise RuntimeError("capture inventory exceeds the installed bounded retention contract")
    source_ref = f"protocol-lab:{trial_id}:protocol_summary"
    record = {
        "contract_version": CONTRACT, "source_ref": source_ref,
        "sampling_mode": "retained_capture_window", "read_only": True,
        "capture_point": {"kernel_namespace": "host", "interface": "any",
                          "separate_link_endpoints": False},
        "location_coverage": "one_host_capture", "summary_read_at": observed_at,
        "requested_filter": dict(parameters), "capture_time_range": {"start": None, "end": None},
        "observation_available": bool(files), "capture_inventory": [], "frames": [],
        "capture_summary": {"files": len(files), "bytes": total_bytes, "protocol_frames": {}},
        "coverage": {"retention": "bounded_rotating_files", "prior_history": "not_guaranteed",
                     "other_kernel_namespaces": "not_collected", "packet_loss": "unknown",
                     "time_range_semantics": "matching_frames_only"},
        "field_occurrence": "first_per_frame",
        "raw_packet_payload_exposed": False, "subscriber_secret_exposed": False,
        "matched_frames": 0, "frame_detail_truncated": False,
    }
    if not files:
        record["coverage"]["status"] = "unavailable"
        return record
    counts = Counter()
    frames = []
    minimum = maximum = None
    limit = parameters.get("frame_limit", 100)
    # The existing Trial owns this temporary diagnostic workspace; no capture
    # restart, counter reset, network write or packet injection occurs.
    if shutil.disk_usage(directory).free < total_bytes + MAX_ANALYSIS_BYTES + 16 * 1024 * 1024:
        raise RuntimeError("insufficient space to freeze a bounded capture observation")
    with tempfile.TemporaryDirectory(prefix=".query-", dir=directory) as temporary:
        root = Path(temporary)
        deadline = time.monotonic() + 25
        for index, (source, boundary) in enumerate(boundaries):
            snapshot, decoded = root / f"{index}.pcap", root / f"{index}.tsv"
            content_hash = _freeze(source, snapshot, boundary)
            framing = _complete_packets(snapshot)
            record["capture_inventory"].append({"file": source.name, "bytes": boundary.st_size,
                                                "sha256": content_hash, **framing})
            if framing["analysed_bytes"] == 0:
                snapshot.unlink()
                continue
            _analyse(snapshot, decoded, display_filter, deadline=deadline)
            with decoded.open(encoding="utf-8") as rows:
                for row in rows:
                    columns = row.rstrip("\n").split("\t")
                    if len(columns) != len(FIELDS):
                        raise RuntimeError("invalid capture field result")
                    fields = dict(zip(FIELDS, columns))
                    when = float(fields["frame.time_epoch"])
                    minimum = when if minimum is None else min(minimum, when)
                    maximum = when if maximum is None else max(maximum, when)
                    protocols = set(fields["frame.protocols"].split(":"))
                    for protocol in ("sctp", "ngap", "pfcp", "gtp"):
                        if protocol in protocols:
                            counts[protocol] += 1
                    frame = {
                        "file": source.name, "frame_number": int(fields["frame.number"]),
                        "at": utc(when), "source_ip": fields["ip.src"],
                        "destination_ip": fields["ip.dst"],
                        "protocols": sorted(protocols & {"sctp", "ngap", "pfcp", "gtp"}),
                        "source_port": fields["sctp.srcport"] or fields["udp.srcport"] or None,
                        "destination_port": fields["sctp.dstport"] or fields["udp.dstport"] or None,
                        "sctp_chunk_type": fields["sctp.chunk_type"] or None,
                        "interface_id": fields["frame.interface_id"] or None,
                        "interface_name": fields["frame.interface_name"] or None,
                        "interface_index": fields["sll.ifindex"] or None,
                    }
                    record["matched_frames"] += 1
                    frames.append((when, frame))
                    if len(frames) > 2 * limit:
                        frames.sort(key=lambda item: (item[0], item[1]["file"], item[1]["frame_number"]))
                        frames = frames[-limit:]
            decoded.unlink()
            snapshot.unlink()
    frames.sort(key=lambda item: (item[0], item[1]["file"], item[1]["frame_number"]))
    record["frames"] = [item for _, item in frames[-limit:]]
    record["frame_detail_truncated"] = record["matched_frames"] > len(record["frames"])
    record["capture_summary"]["protocol_frames"] = dict(counts)
    record["capture_time_range"] = {"start": utc(minimum) if minimum is not None else None,
                                   "end": utc(maximum) if maximum is not None else None}
    record["observation_available"] = any(item["analysed_bytes"] >= 24 for item in record["capture_inventory"])
    record["coverage"]["status"] = "retained_files_scanned" if record["observation_available"] else "unavailable"
    if record["frame_detail_truncated"]:
        record["detail_continuation"] = {
            "end_at": record["frames"][0]["at"],
            "instruction": "Narrow time/endpoint/protocol or increase frame_limit; boundary timestamps may overlap.",
        }
    return record
