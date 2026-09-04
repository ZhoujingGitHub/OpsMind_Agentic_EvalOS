import assert from "node:assert/strict";
import test from "node:test";
import { protocolServiceHealthReferences } from "../src/product-evidence-semantics.mjs";
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
        resolution: "resolved", read_only: true, active: true, ready: true, health: "healthy" }] } };
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

test("running, partial, stale, cross-trial and unready observations cannot prove health", () => {
  for (const mutate of [
    (x) => { delete x.raw_value_json.records[0].health; x.raw_value_json.records[0].runtime_state = "running"; },
    (x) => { x.raw_value_json.partial = true; },
    (x) => { x.freshness = "stale"; },
    (x) => { x.protocol_trial_id = "foreign"; },
    (x) => { x.raw_value_json.records[0].namespace_id = "foreign"; },
    (x) => { x.raw_value_json.records[0].resource_id = "foreign"; },
    (x) => { x.raw_value_json.records[0].ready = false; },
    (x) => { x.raw_value_json.records[0].health = "unknown"; },
  ]) {
    const item = evidence(); mutate(item);
    assert.deepEqual(protocolServiceHealthReferences(item), []);
  }
});
