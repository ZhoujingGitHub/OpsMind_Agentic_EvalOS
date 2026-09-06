from pathlib import Path
import hashlib
import shutil
import struct
from types import SimpleNamespace

import pytest
import harness_diagnostics as diagnostic

AT = "2026-09-06T09:00:00Z"


def pcap(*packets):
    header = struct.pack("<IHHIIII", 0xa1b2c3d4, 2, 4, 0, 0, 65535, 1)
    return header + b"".join(struct.pack("<IIII", 100 + index, 0, len(packet), len(packet)) + packet
                              for index, packet in enumerate(packets))


@pytest.mark.parametrize("parameters", [
    {"duration_seconds": 10}, {"protocol": None}, {"protocol": "sctp; rm"},
    {"start_at": "2026-09-06"}, {"start_at": AT, "end_at": "2025-01-01T00:00:00Z"},
    {"source_ip": "127.0.0.1 || tcp"}, {"source_ip": 123}, {"destination_ip": "::1"},
    {"frame_limit": True}, {"frame_limit": 1001}, {"destination_port": 0}, {"source_port": "53"},
])
def test_filter_rejects_unsupported_or_untyped_inputs(parameters):
    with pytest.raises((ValueError, TypeError)):
        diagnostic.capture_filter(parameters)


def test_filter_is_typed_and_applied_before_detail_limit():
    result = diagnostic.capture_filter({"protocol": "sctp", "source_ip": "127.0.0.1",
        "destination_port": 38412, "start_at": AT, "frame_limit": 1})
    assert "(sctp)" in result and "ip.src == 127.0.0.1" in result
    assert "sctp.dstport == 38412" in result and "frame.time_epoch >=" in result
    assert "frame.number" not in result


def test_policy_preserves_rule_boundaries_and_counters_without_guessing_root_cause():
    output = """*filter
:INPUT ACCEPT [10:800]
:POLICY - [0:0]
[4:200] -A INPUT -j POLICY
[2:100] -A POLICY -p sctp -m sctp --dport 38412 -j ACCEPT
[3:150] -A POLICY ! -s 10.0.0.0/8 -p udp --dport 53 -j DROP
COMMIT
"""
    rules = diagnostic.parse_policy(output)["tables"][0]["rules"]
    assert rules[1]["protocol"] == "sctp" and rules[1]["target"] == "ACCEPT"
    assert rules[2]["protocol"] == "udp" and rules[2]["target"] == "DROP"
    assert rules[2]["has_negation"] is True and rules[2]["position"] == 2
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=0, stdout=output if args[-1] == "filter" else "*nat\n:OUTPUT ACCEPT [0:0]\nCOMMIT\n")
    value = diagnostic.network_policy([], run=run, observed_at=AT)
    assert calls == [["iptables-save", "-c", "-t", "filter"], ["iptables-save", "-c", "-t", "nat"]]
    assert value["causal_conclusion"] == "not_computed"
    assert value["coverage"]["kernel_namespace_shared_by_resources"] is True


@pytest.mark.parametrize("text", ["", "*filter\n:INPUT ACCEPT [0:0]", "*filter\n-A INPUT -j DROP\nCOMMIT"])
def test_incomplete_policy_is_not_a_successful_empty_result(text):
    with pytest.raises(ValueError):
        diagnostic.parse_policy(text)


def test_policy_failure_is_explicit():
    with pytest.raises(RuntimeError, match="collection failed"):
        diagnostic.network_policy([], run=lambda *a, **k: SimpleNamespace(returncode=1, stdout=""), observed_at=AT)


@pytest.mark.parametrize("tail", [b"", b"partial", struct.pack("<IIII", 200, 0, 5, 5) + b"xx"])
def test_snapshot_trims_only_incomplete_final_packet_and_keeps_source_intact(tmp_path, tail):
    original = pcap(b"abcd")
    source, target = tmp_path / "capture.pcap", tmp_path / "copy.pcap"
    source.write_bytes(original + tail)
    digest = diagnostic._freeze(source, target, source.stat())
    framing = diagnostic._complete_packets(target)
    assert source.read_bytes() == original + tail and target.read_bytes() == original
    assert digest == hashlib.sha256(original + tail).hexdigest()
    assert framing == {"analysed_bytes": len(original), "incomplete_tail_bytes": len(tail)}


def test_rotation_or_corrupt_record_is_not_silently_accepted(tmp_path):
    source, target = tmp_path / "capture.pcap", tmp_path / "copy.pcap"
    source.write_bytes(pcap(b"abc")); boundary = source.stat()
    source.write_bytes(b"")
    with pytest.raises(RuntimeError, match="rotated"):
        diagnostic._freeze(source, target, boundary)
    target.write_bytes(pcap() + struct.pack("<IIII", 100, 0, 65536, 65536))
    with pytest.raises(RuntimeError, match="record length"):
        diagnostic._complete_packets(target)


def test_query_reads_every_retained_file_and_reports_one_source(monkeypatch, tmp_path):
    for index in range(4):
        (tmp_path / f"capture.pcap{index}").write_bytes(pcap(b"x"))
    calls = []
    def analyse(source, output, display_filter, **kwargs):
        calls.append(display_filter)
        # A retained rotation can be newer than a lexically later file.
        at = 200 - int(source.stem)
        fields = [str(at), "1", "eth:ip:sctp", "127.0.0.1", "127.0.0.5",
                  "10000", "38412", "1", "", "", "", "", ""]
        output.write_text("\t".join(fields) + "\n", encoding="utf-8")
    monkeypatch.setattr(diagnostic, "_analyse", analyse)
    result = diagnostic.capture_summary("ah-a", {"protocol": "sctp", "frame_limit": 2}, tmp_path, observed_at=AT)
    assert len(calls) == 4 and len(result["capture_inventory"]) == 4
    assert result["matched_frames"] == 4 and len(result["frames"]) == 2
    assert result["frame_detail_truncated"] is True
    assert result["frames"][-1]["file"] == "capture.pcap0"
    assert result["capture_point"]["separate_link_endpoints"] is False
    assert result["capture_summary"]["protocol_frames"] == {"sctp": 4}
    assert not list(tmp_path.glob(".query-*"))


def test_unwritten_capture_is_unavailable_not_empty_success(tmp_path):
    (tmp_path / "capture.pcap0").touch()
    result = diagnostic.capture_summary("ah-a", {}, tmp_path, observed_at=AT)
    assert result["observation_available"] is False
    assert result["coverage"]["status"] == "unavailable"


@pytest.mark.skipif(not shutil.which("tshark"), reason="requires Linux/Tshark engineering host")
def test_real_tshark_decodes_retained_protocol_and_applies_filters(tmp_path):
    ethernet = bytes.fromhex("0000000000010000000000020800")
    # IPv4/SCTP INIT, metadata only; no subscriber or application payload.
    ipv4 = bytes.fromhex("4500003400000000408400007f0000017f000005")
    sctp = struct.pack("!HHII", 10000, 38412, 0, 0) + bytes.fromhex("0100001400000001000010000001000100000001")
    (tmp_path / "capture.pcap0").write_bytes(pcap(ethernet + ipv4 + sctp))
    result = diagnostic.capture_summary("ah-a", {"protocol": "sctp", "destination_port": 38412}, tmp_path, observed_at=AT)
    assert result["matched_frames"] == 1 and result["frames"][0]["sctp_chunk_type"] == "1"
    assert result["frames"][0]["destination_ip"] == "127.0.0.5"
    empty = diagnostic.capture_summary("ah-a", {"protocol": "sctp", "destination_port": 53}, tmp_path, observed_at=AT)
    assert empty["matched_frames"] == 0 and empty["observation_available"] is True
