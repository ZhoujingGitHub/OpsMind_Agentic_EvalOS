import assert from "node:assert/strict";
import test from "node:test";
import { assertProductResourceEvidence } from "../src/product-resource-evidence.mjs";

const ref = { identifier_domain: "opsmind-twin", namespace: "ah-trial-current",
  resource_type: "service", resource_id: "amf" };
const context = { tenantId: "tenant-current", runRef: "inv-current",
  allowed: { namespace: ref.namespace, resource_refs: [ref] } };
const failed = () => ({
  evidence_id: "failed-diagnostic", tenant_id: context.tenantId, investigation_id: context.runRef,
  source_type: "protocol_lab_resource_observation", source_ref: "mcp:run_sandboxed_readonly_diagnostic",
  scope_json: { tenant_id: context.tenantId, namespace: ref.namespace, resource_refs: [ref] },
  protocol_trial_id: null, substantive: 0, quality: "unknown", freshness: "unknown",
  completeness: "partial", raw_value_json: {}, derived_value_json: { error: {
    code: "PROTOCOL_LAB_OBSERVATION_FAILED", message: "unsupported readonly diagnostic profile" } },
});
test("failed diagnostic is a bound request, not a fabricated laboratory observation", () => {
  for (const substantive of [false, 0]) {
    const evidence = { ...failed(), substantive };
    const original = structuredClone(evidence);
    assert.doesNotThrow(() => assertProductResourceEvidence(evidence, context));
    assert.deepEqual(evidence, original);
  }
});
test("failure cannot bypass tenant, investigation, namespace or exact resource binding", () => {
  const mutations = [
    (e) => { e.tenant_id = "other"; }, (e) => { e.investigation_id = "other"; },
    (e) => { e.scope_json.tenant_id = "other"; }, (e) => { e.scope_json.namespace = "other"; },
    (e) => { e.scope_json.resource_refs = []; }, (e) => { delete e.scope_json; },
    ...["identifier_domain", "namespace", "resource_type", "resource_id"].map((key) =>
      (e) => { e.scope_json.resource_refs[0][key] = "other"; }),
    (e) => { e.scope_json.resource_refs = [null]; },
  ];
  for (const mutate of mutations) {
    const evidence = structuredClone(failed()); mutate(evidence);
    assert.throws(() => assertProductResourceEvidence(evidence, context), /request scope/);
  }
});
test("failure markers cannot disguise successful or foreign observations", () => {
  const mutations = [
    (e) => { e.substantive = true; }, (e) => { e.substantive = "0"; },
    (e) => { delete e.substantive; }, (e) => { e.protocol_trial_id = "other"; },
    (e) => { e.protocol_trial_id = ref.namespace; }, (e) => { delete e.protocol_trial_id; },
    (e) => { e.raw_value_json = { records: [{ status: "healthy" }] }; },
    (e) => { e.raw_value_json = []; }, (e) => { delete e.raw_value_json; },
    (e) => { e.quality = "verified"; }, (e) => { e.freshness = "live"; },
    (e) => { e.completeness = "complete"; }, (e) => { e.derived_value_json.error.code = "OTHER"; },
    (e) => { e.derived_value_json.error = null; },
    (e) => { e.derived_value_json.records = [{ healthy: true }]; },
  ];
  for (const mutate of mutations) {
    const evidence = structuredClone(failed()); mutate(evidence);
    assert.throws(() => assertProductResourceEvidence(evidence, context), /invalid failed attempt/);
  }
});
test("successful and empty observations both require the actual Trial binding", () => {
  for (const substantive of [true, false, 1, 0]) {
    const evidence = { ...failed(), substantive, derived_value_json: {},
      protocol_trial_id: ref.namespace, quality: "verified", freshness: "live",
      completeness: "complete", raw_value_json: { records: [] } };
    assert.doesNotThrow(() => assertProductResourceEvidence(evidence, context));
    for (const protocol_trial_id of [null, undefined, "foreign"]) {
      assert.throws(() => assertProductResourceEvidence({ ...evidence, protocol_trial_id }, context),
        /observation Trial/);
    }
  }
});
