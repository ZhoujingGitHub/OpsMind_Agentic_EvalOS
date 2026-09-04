from pathlib import Path
from types import SimpleNamespace
import json
import subprocess

import pytest

import harness_probes as probes

NETWORK = json.loads(Path(probes.__file__).with_name("stack.manifest.json").read_text())["harness_network"]


def scope(trial="ah-probe-test"):
    return {"identifier_domain": "opsmind-twin", "namespace": trial,
            "resource_refs": [{"identifier_domain": "opsmind-twin", "namespace": trial,
                              "resource_id": "ue-1", "resource_type": "terminal"}]}


def interface(name="uesimtun3", address="10.45.0.7", kind="tun"):
    return {"ifname": name, "flags": ["UP"], "linkinfo": {"info_kind": kind},
            "addr_info": [{"family": "inet", "local": address}]}


def runner_with(interfaces, output=None):
    calls = []
    def runner(args, **_):
        calls.append(args)
        if args[:3] == ["ip", "-n", "opsmind-ue"]:
            return subprocess.CompletedProcess(args, 0, json.dumps(interfaces), "")
        return output or subprocess.CompletedProcess(args, 0, "", "")
    return runner, calls


def test_current_interface_and_address_are_resolved_each_time():
    run, _ = runner_with([interface(), interface("ue0", "10.47.0.2", "veth")])
    assert probes.ue_source(scope(), NETWORK, run)["address"] == "10.45.0.7"
    run, _ = runner_with([interface("uesimtun1", "10.45.0.19")])
    result = probes.ue_source(scope("ah-new-trial"), NETWORK, run)
    assert result["interface"] == "uesimtun1"
    assert result["resource_ref"]["namespace"] == "ah-new-trial"


@pytest.mark.parametrize("interfaces", [[], [interface(), interface("uesimtun2", "10.45.0.8")],
                                      [interface("ue0", "10.47.0.2", "veth")]])
def test_missing_or_ambiguous_source_never_falls_back_to_management_network(interfaces):
    run, calls = runner_with(interfaces)
    result = probes.probe("http", {}, scope(), runner=run, network=NETWORK)
    assert result["status"] == "unavailable"
    assert result["healthy"] is False
    assert len(calls) == 1


def test_cross_trial_source_is_rejected_before_reading_interfaces():
    wrong = scope()
    wrong["resource_refs"][0]["namespace"] = "ah-other"
    run, calls = runner_with([interface()])
    result = probes.probe("ip", {}, wrong, runner=run, network=NETWORK)
    assert result["error"]["code"] == "PERMISSION_DENIED"
    assert calls == []


@pytest.mark.parametrize("kind", ["ip", "trace", "tcp", "dns", "http"])
def test_every_active_probe_uses_the_current_ue_interface(kind):
    socket_result = '{"connected":true,"resolved":true,"answers":["10.47.0.80"]}'
    run, calls = runner_with([interface()], subprocess.CompletedProcess([], 0, socket_result, ""))
    probes.probe(kind, {}, scope(), runner=run, network=NETWORK)
    invocation = calls[-1]
    assert invocation[:4] == ["ip", "netns", "exec", "opsmind-ue"]
    assert "uesimtun3" in " ".join(invocation)
    assert not any("route" in command or "iptables" in command for command in calls)


def test_trace_errors_and_summary_lines_are_not_hops_or_completion():
    result = probes.trace_result(subprocess.CompletedProcess([], 0,
        "1: send failed\nResume: pmtu 65535\n", ""), NETWORK["mec_address"])
    assert result["complete"] is False
    assert result["hops"] == []
    result = probes.trace_result(subprocess.CompletedProcess([], 0,
        " 1  10.61.0.2  0.2 ms\n 2  *\n", ""), NETWORK["mec_address"])
    assert result["complete"] is False
    assert result["hop_count"] == 2


def test_http_must_return_the_expected_business_payload():
    for stdout, rc in [('{"status":"healthy"}\n200', 0), ('{}\n500', 0),
                       ('{"service":"opsmind-protocol-lab-mec","status":"healthy"}\n200', 7)]:
        run, _ = runner_with([interface()], subprocess.CompletedProcess([], rc, stdout, ""))
        result = probes.probe("http", {}, scope(), runner=run, network=NETWORK)
        assert result["healthy"] is False
    run, _ = runner_with([interface()], subprocess.CompletedProcess([], 0,
        '{"service":"opsmind-protocol-lab-mec","status":"healthy"}\n200', ""))
    assert probes.probe("http", {}, scope(), runner=run, network=NETWORK)["healthy"] is True


def test_dns_error_is_separate_from_answer_records():
    run, _ = runner_with([interface()], subprocess.CompletedProcess([], 0,
        '{"error":{"code":"ENETUNREACH","stage":"network_probe","message":"no route"}}', ""))
    result = probes.probe("dns", {}, scope(), runner=run, network=NETWORK)
    assert result["resolved"] is False
    assert result["answers"] == []
    assert result["error"]["code"] == "ENETUNREACH"


def test_fresh_business_verification_requires_both_services_and_same_source(monkeypatch):
    calls = []
    outputs = {}
    monkeypatch.setattr(probes, "topology", lambda: NETWORK)
    def sample(kind, parameters, source_scope, **_):
        calls.append(kind)
        return outputs[kind]
    monkeypatch.setattr(probes, "probe", sample)
    outputs.update(dns={"resolved": True, "answers": [NETWORK["mec_address"]],
                        "source": {"interface": "uesimtun1"}},
                   http={"healthy": False, "source": {"interface": "uesimtun1"}})
    assert probes.business_verification(scope())["passed"] is False
    outputs["http"]["healthy"] = True
    assert probes.business_verification(scope())["passed"] is True
    outputs["http"]["source"] = {"interface": "uesimtun2"}
    assert probes.business_verification(scope())["passed"] is False
    assert calls == ["dns", "http"] * 3
