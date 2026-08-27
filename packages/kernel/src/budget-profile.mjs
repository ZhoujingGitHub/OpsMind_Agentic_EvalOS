export const LEGACY_BUDGET_DIMENSIONS = Object.freeze([
  "input_tokens", "output_tokens", "model_calls", "tool_calls",
  "wallclock_ms", "compute_ms", "storage_bytes", "cost_usd",
]);

export const CANDIDATE_NATIVE_BUDGET_DIMENSIONS = Object.freeze([
  "max_duration_seconds", "max_model_calls", "max_tool_calls",
  "max_tokens", "max_cost_microunits", "max_result_bytes",
]);

export const CANDIDATE_OPEN_RESOURCE_CONTRACT = "evalos-candidate-open-resource/1.0";

const ENFORCEMENT_MODES = new Set(["enforced", "observed_only", "not_observable"]);
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort().join("\n");
  const expected = [...keys].sort().join("\n");
  if (actual !== expected) throw new Error(`${label} must contain exactly ${[...keys].sort().join(", ")}`);
}

function positiveBudget(value, dimensions, label, { integers = false } = {}) {
  exactKeys(value, dimensions, label);
  for (const name of dimensions) {
    if (!Number.isFinite(value[name]) || value[name] <= 0 || integers && !Number.isSafeInteger(value[name])) {
      throw new Error(`${label}.${name} must be a positive ${integers ? "integer" : "number"}`);
    }
  }
}

function settlementCoversCandidate(candidate, settlement, contestantRef) {
  const checks = {
    max_duration_seconds: settlement.wallclock_ms >= candidate.max_duration_seconds * 1000,
    max_model_calls: settlement.model_calls >= candidate.max_model_calls,
    max_tool_calls: settlement.tool_calls >= candidate.max_tool_calls,
    max_tokens: settlement.input_tokens >= candidate.max_tokens && settlement.output_tokens >= candidate.max_tokens,
    max_cost_microunits: settlement.cost_usd * 1_000_000 >= candidate.max_cost_microunits,
    max_result_bytes: settlement.storage_bytes >= candidate.max_result_bytes,
  };
  const missing = Object.entries(checks).filter(([, covered]) => !covered).map(([name]) => name);
  if (missing.length) {
    throw new Error(`settlement reserve cannot be lower than candidate public maximum: ${contestantRef}.${missing.join(",")}`);
  }
}

function profileFor(manifest, contestantRef) {
  if (manifest?.manifest_version !== "8.0") return null;
  return manifest.candidate_resource_contract?.profiles?.find((item) => item.contestant_ref === contestantRef) ?? null;
}

export function validateCandidateResourceContract(manifest) {
  const contract = manifest?.candidate_resource_contract;
  exactKeys(contract, ["contract_version", "mode", "policy", "profiles"], "candidate_resource_contract");
  if (contract.contract_version !== CANDIDATE_OPEN_RESOURCE_CONTRACT) {
    throw new Error(`candidate_resource_contract must use ${CANDIDATE_OPEN_RESOURCE_CONTRACT}`);
  }
  if (contract.mode !== "OPEN") throw new Error("candidate_resource_contract mode must be OPEN");
  exactKeys(contract.policy, ["candidate_limit_source", "limits_are_safety_fuses_only", "usage_affects_score",
    "efficiency_reporting_only", "case_specific_limits_forbidden", "cross_architecture_equal_limits_required"],
  "candidate_resource_contract.policy");
  if (contract.policy.candidate_limit_source !== "product_public_maximum" ||
      contract.policy.limits_are_safety_fuses_only !== true || contract.policy.usage_affects_score !== false ||
      contract.policy.efficiency_reporting_only !== true || contract.policy.case_specific_limits_forbidden !== true ||
      contract.policy.cross_architecture_equal_limits_required !== false) {
    throw new Error("candidate open-resource policy is invalid");
  }
  if (!Array.isArray(contract.profiles) || contract.profiles.length !== manifest.contestants.length) {
    throw new Error("candidate resource profiles must match the frozen contestants one-for-one");
  }
  const refs = contract.profiles.map((item) => item?.contestant_ref);
  const expectedRefs = manifest.contestants.map((item) => item.ref);
  if (new Set(refs).size !== refs.length || [...refs].sort().join("\n") !== [...expectedRefs].sort().join("\n")) {
    throw new Error("candidate resource profiles must cover each frozen contestant exactly once");
  }
  for (const profile of contract.profiles) {
    exactKeys(profile, ["contestant_ref", "candidate_resources", "settlement_reserve", "enforcement", "provenance"],
      `candidate_resource_contract.profiles.${profile.contestant_ref}`);
    positiveBudget(profile.candidate_resources, CANDIDATE_NATIVE_BUDGET_DIMENSIONS,
      `candidate resources ${profile.contestant_ref}`, { integers: true });
    positiveBudget(profile.settlement_reserve, LEGACY_BUDGET_DIMENSIONS,
      `settlement reserve ${profile.contestant_ref}`);
    settlementCoversCandidate(profile.candidate_resources, profile.settlement_reserve, profile.contestant_ref);
    exactKeys(profile.enforcement, CANDIDATE_NATIVE_BUDGET_DIMENSIONS,
      `resource enforcement ${profile.contestant_ref}`);
    for (const dimension of CANDIDATE_NATIVE_BUDGET_DIMENSIONS) {
      if (!ENFORCEMENT_MODES.has(profile.enforcement[dimension])) {
        throw new Error(`resource enforcement mode is invalid: ${profile.contestant_ref}.${dimension}`);
      }
    }
    exactKeys(profile.provenance, ["status", "method", "source_revision", "artifact_digest", "evidence_ref"],
      `resource provenance ${profile.contestant_ref}`);
    if (profile.provenance.status !== "product_public_maximum" ||
        profile.provenance.method !== "candidate_public_runtime_contract" || !profile.provenance.evidence_ref) {
      throw new Error(`resource provenance is invalid: ${profile.contestant_ref}`);
    }
    const contestant = manifest.contestants.find((item) => item.ref === profile.contestant_ref);
    if (profile.provenance.source_revision !== contestant.source_revision ||
        profile.provenance.artifact_digest !== contestant.artifact_digest ||
        !SHA256_DIGEST.test(profile.provenance.artifact_digest)) {
      throw new Error(`resource provenance must bind the frozen contestant: ${profile.contestant_ref}`);
    }
  }
  return contract;
}

export function candidateResourceProfile(manifest, contestantRef) {
  if (manifest?.manifest_version !== "8.0") return null;
  validateCandidateResourceContract(manifest);
  const profile = profileFor(manifest, contestantRef);
  if (!profile) throw new Error(`candidate resource profile is missing: ${contestantRef}`);
  return profile;
}

export function candidateExecutionBudget(manifest, contestantRef) {
  return candidateResourceProfile(manifest, contestantRef)?.candidate_resources ?? manifest?.budget ?? null;
}

export function trialSettlementBudget(manifest, contestantRef) {
  return candidateResourceProfile(manifest, contestantRef)?.settlement_reserve ?? manifest?.budget ?? null;
}
