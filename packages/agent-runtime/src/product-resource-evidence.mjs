const RESOURCE_KEYS = ["identifier_domain", "namespace", "resource_type", "resource_id"];
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Product-owned request scope also binds failed attempts. A failed collector has
// no laboratory response to attest; never manufacture one from its request.
export function assertProductResourceEvidence(evidence, { tenantId, runRef, allowed }) {
  const scope = evidence.scope_json;
  const refs = scope?.resource_refs;
  if (evidence.tenant_id !== tenantId || evidence.investigation_id !== runRef ||
      scope?.tenant_id !== tenantId || scope?.namespace !== allowed.namespace ||
      !Array.isArray(refs) || refs.length === 0 || !refs.every((ref) => object(ref) &&
        allowed.resource_refs.some((target) => RESOURCE_KEYS.every((key) => target[key] === ref[key])))) {
    throw new Error("Product evidence binding mismatch: request scope");
  }
  const error = evidence.derived_value_json?.error;
  if (error !== undefined) {
    const raw = evidence.raw_value_json;
    if (error?.code !== "PROTOCOL_LAB_OBSERVATION_FAILED" ||
        typeof error.message !== "string" || error.message.length === 0 ||
        ![false, 0].includes(evidence.substantive) || evidence.protocol_trial_id !== null ||
        evidence.quality !== "unknown" || evidence.freshness !== "unknown" ||
        evidence.completeness !== "partial" || !object(raw) || Object.keys(raw).length !== 0 ||
        Object.keys(evidence.derived_value_json).some((key) => key !== "error")) {
      throw new Error("Product evidence binding mismatch: invalid failed attempt");
    }
    return;
  }
  // Empty but successful observations still require an actual response binding.
  if (evidence.protocol_trial_id !== allowed.namespace) {
    throw new Error("Product evidence binding mismatch: observation Trial");
  }
}
