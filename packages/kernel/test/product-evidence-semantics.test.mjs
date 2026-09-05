import assert from "node:assert/strict";
import test from "node:test";
import { protocolServiceHealthReferences, protocolEvidenceReferences } from "../src/product-evidence-semantics.mjs";
import { gradeObservableOutcome } from "../src/grader.mjs";

function evidence(service = "service-z") {
  return { evidence_id: "ev-live", source_type: "protocol_lab_resource_observation",
    source_lineage: "lab.resource_observation.service_health", quality: "verified", freshness: "live",
    completeness: "complete", substantive: 1, protocol_trial_id: "trial-test",
    scope_json: { namespace: "trial-test", resource_refs: [
      { identifier_domain: "opsmind-twin", namespace: "trial-test", resource_type: "service", resource_id: service }] },
    raw_value_json: { trial_id: "trial-test", partial: false, production_network: false,
      source_lineage: "lab.resource_observation.service_health",
      records: [{ namespace_id: "trial-test", resource_type: "service", resource_id: service,
        resolution: "resolved", read_only: true, active: true, ready: true, health: "healthy",
        health_scope: "local_process_listener", business_health: "not_measured",
        checks: { process_active: true, owned_protocol_listener: true },
        process_id: 125, listener_protocol: "sctp", listeners: ['LISTEN 0 5 127.0.0.5:38412 users:(("service-z",pid=125,fd=4))'] }] } };
}

test("health semantics are generic, traceable and credited only when cited", () => {
  const item = evidence();
  assert.deepEqual(protocolServiceHealthReferences(item), ["process:service-z-healthy"]);
  const spec = { ground_truth: { root_causes: ["route missing"], required_evidence: ["process:service-z-healthy"] }, tools: {} };
  const trace = [{ name: "candidate.raw_event", payload: { payload: item } }];
  const outcome = { status: "resolved", root_cause: "route missing", evidence_refs: ["ev-live"] };
  assert.equal(gradeObservableOutcome(spec, outcome, trace).evidenceRecall, 1);
  assert.equal(gradeObservableOutcome(spec, { ...outcome, evidence_refs: [] }, trace).evidenceRecall, 0);
  assert.equal(JSON.stringify(item).includes("process:service-z-healthy"), false);
});

test("a partial batch preserves complete healthy objects without crediting unknown neighbours", () => {
  const item = evidence("service-a");
  item.completeness = "partial";
  item.raw_value_json.partial = true;
  item.scope_json.resource_refs.push({ identifier_domain: "opsmind-twin", namespace: "trial-test",
    resource_type: "workload", resource_id: "workload-b" });
  item.raw_value_json.records.push({ namespace_id: "trial-test", resource_type: "workload",
    resource_id: "workload-b", resolution: "resolved", read_only: true, active: true,
    ready: null, health: "unknown", health_scope: "local_process_listener",
    checks: { process_active: true, owned_protocol_listener: null } });
  const before = JSON.stringify(item);
  assert.deepEqual(protocolServiceHealthReferences(item), ["process:service-a-healthy"]);
  item.raw_value_json.records[0].checks.owned_protocol_listener = null;
  assert.deepEqual(protocolServiceHealthReferences(item), []);
  item.raw_value_json.records[0].checks.owned_protocol_listener = true;
  assert.equal(JSON.stringify(item), before);
});

test("running, partial, stale, cross-trial and unready observations cannot prove health", () => {
  for (const mutate of [
    (x) => { delete x.raw_value_json.records[0].health; x.raw_value_json.records[0].runtime_state = "running"; },
    (x) => { x.raw_value_json.partial = true; },
    (x) => { x.freshness = "stale"; },
    (x) => { x.protocol_trial_id = "foreign"; },
    (x) => { x.raw_value_json.records[0].namespace_id = "foreign"; },
    (x) => { x.raw_value_json.records[0].resource_id = "foreign"; },
    (x) => { x.raw_value_json.records[0].ready = false; },
    (x) => { delete x.raw_value_json.records[0].checks; },
    (x) => { x.raw_value_json.records[0].checks.owned_protocol_listener = null; },
    (x) => { x.raw_value_json.records[0].listeners = []; },
    (x) => { x.raw_value_json.records[0].process_id = 12; },
    (x) => { x.raw_value_json.records[0].health_scope = "process_only"; },
    (x) => { x.raw_value_json.records[0].health = "unknown"; },
  ]) {
    const item = evidence(); mutate(item);
    assert.deepEqual(protocolServiceHealthReferences(item), []);
  }
});


function captureEvidence() {
  const source = "protocol-lab:trial-test:protocol_summary";
  return { evidence_id: "ev-capture", source_type: "protocol_lab",
    source_lineage: "lab.packet_capture", quality: "verified", freshness: "snapshot",
    completeness: "complete", substantive: 1, protocol_trial_id: "trial-test", source_ref: source,
    scope_json: { namespace: "trial-test", resource_refs: [
      { identifier_domain: "opsmind-twin", namespace: "trial-test", resource_type: "runtime", resource_id: "runtime-z" }] },
    raw_value_json: { trial_id: "trial-test", source_lineage: "lab.packet_capture",
      source_ref: source, protocol_lab_call_id: "lab-call-z", partial: false, production_network: false,
      records: [{ source_ref: source, observation_available: true,
        sampling_mode: "existing_capture_summary", protocol_counts_file_scope: "first_capture_file",
        location_coverage: "not_separated", capture_time_range: { start: null, end: null },
        capture_summary: { files: 1, bytes: 4096, protocol_frames: { sctp: 201, ngap: 2, tcp: 0 } } }] } };
}

test("capture counts prove cited protocol presence without rewriting source evidence", () => {
  const item = captureEvidence();
  const before = JSON.stringify(item);
  assert.deepEqual(protocolEvidenceReferences(item), ["pcap:sctp-observed", "pcap:ngap-observed"]);
  const spec = { ground_truth: { root_causes: ["link blocked"],
    required_evidence: ["process:service-z-healthy", "pcap:sctp-observed", "state:firewall-sctp-drop"] }, tools: {} };
  const trace = [evidence(), item].map((payload) => ({ name: "candidate.raw_event", payload: { payload } }));
  const outcome = { status: "resolved", root_cause: "link blocked", evidence_refs: ["ev-live", "ev-capture"] };
  const grade = gradeObservableOutcome(spec, outcome, trace);
  assert.deepEqual(grade.evidenceHits, ["process:service-z-healthy", "pcap:sctp-observed"]);
  assert.equal(grade.evidenceRecall, 2 / 3);
  assert.equal(grade.pass, true);
  assert.equal(gradeObservableOutcome(spec, { ...outcome, evidence_refs: ["ev-live"] }, trace).pass, false);
  assert.equal(JSON.stringify(item), before);
  assert.deepEqual(protocolEvidenceReferences(evidence()), ["process:service-z-healthy"]);
});

test("capture projection rejects unbound, unavailable and fabricated capture metadata", () => {
  for (const mutate of [
    (x) => { x.source_type = "model_report"; },
    (x) => { x.source_lineage = "lab.active_probe"; },
    (x) => { x.protocol_trial_id = "foreign"; },
    (x) => { x.scope_json.namespace = "foreign"; },
    (x) => { x.scope_json.resource_refs[0].namespace = "foreign"; },
    (x) => { x.raw_value_json.trial_id = "foreign"; },
    (x) => { x.raw_value_json.source_lineage = "another"; },
    (x) => { x.source_ref = "protocol-lab:foreign:protocol_summary"; },
    (x) => { x.raw_value_json.source_ref = "foreign"; },
    (x) => { x.raw_value_json.records[0].source_ref = "foreign"; },
    (x) => { delete x.raw_value_json.protocol_lab_call_id; },
    (x) => { x.raw_value_json.production_network = true; },
    (x) => { x.raw_value_json.partial = true; },
    (x) => { x.substantive = 0; },
    (x) => { x.quality = "unknown"; },
    (x) => { x.freshness = "unknown"; },
    (x) => { x.completeness = "partial"; },
    (x) => { x.raw_value_json.records[0].observation_available = false; },
    (x) => { x.raw_value_json.records[0].sampling_mode = "unknown"; },
    (x) => { x.raw_value_json.records[0].protocol_counts_file_scope = "unknown"; },
    (x) => { x.raw_value_json.records[0].capture_summary.files = 0; },
    (x) => { x.raw_value_json.records[0].capture_summary.bytes = 0; },
  ]) {
    const item = captureEvidence(); mutate(item);
    assert.deepEqual(protocolEvidenceReferences(item), []);
  }
});

test("zero, unknown and invalid protocol counts are not positive observations", () => {
  const item = captureEvidence();
  item.raw_value_json.records[0].capture_summary.protocol_frames = {
    sctp: 0, ngap: -1, tcp: "4", udp: null, icmp: true, pfcp: 0.5, gtp: Number.MAX_SAFE_INTEGER + 1,
    "sctp-observed": 8, "firewall-drop": 3, other_protocol: 2,
  };
  assert.deepEqual(protocolEvidenceReferences(item), ["pcap:other_protocol-observed"]);
  item.raw_value_json.records.push(structuredClone(item.raw_value_json.records[0]));
  assert.deepEqual(protocolEvidenceReferences(item), ["pcap:other_protocol-observed"]);
});
