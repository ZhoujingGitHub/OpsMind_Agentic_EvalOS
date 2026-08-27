export const LEGACY_BUDGET_DIMENSIONS = Object.freeze([
  "input_tokens", "output_tokens", "model_calls", "tool_calls",
  "wallclock_ms", "compute_ms", "storage_bytes", "cost_usd",
]);

export const CANDIDATE_NATIVE_BUDGET_DIMENSIONS = Object.freeze([
  "max_duration_seconds", "max_model_calls", "max_tool_calls",
  "max_tokens", "max_cost_microunits", "max_result_bytes",
]);

export const CANDIDATE_BUDGET_PROFILE_CONTRACT = "evalos-candidate-budget-profile/1.0";

const PROFILE_PHASES = new Set(["CALIBRATION", "QUALIFICATION", "CAPACITY", "FORMAL"]);
const ENFORCEMENT_MODES = new Set(["enforced", "observed_only", "not_observable"]);
const PROVENANCE_STATES = new Set(["product_native_baseline", "empirical_calibrated"]);
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
    throw new Error(`settlement budget cannot be lower than candidate native budget: ${contestantRef}.${missing.join(",")}`);
  }
}

function profileFor(manifest, contestantRef) {
  if (manifest?.manifest_version !== "8.0") return null;
  return manifest.candidate_budget_contract?.profiles?.find((item) => item.contestant_ref === contestantRef) ?? null;
}

export function validateCandidateBudgetContract(manifest) {
  const contract = manifest?.candidate_budget_contract;
  exactKeys(contract, ["contract_version", "phase", "joint_envelope_policy", "profiles"], "candidate_budget_contract");
  if (contract.contract_version !== CANDIDATE_BUDGET_PROFILE_CONTRACT) {
    throw new Error(`candidate_budget_contract must use ${CANDIDATE_BUDGET_PROFILE_CONTRACT}`);
  }
  if (!PROFILE_PHASES.has(contract.phase)) throw new Error("candidate_budget_contract phase is invalid");
  const expectedPhase = manifest.evaluation_mode === "CAPACITY_REHEARSAL" ? "CAPACITY"
    : manifest.evaluation_mode === "FORMAL" ? "FORMAL" : null;
  if (expectedPhase && contract.phase !== expectedPhase) {
    throw new Error(`candidate_budget_contract phase must be ${expectedPhase} for ${manifest.evaluation_mode}`);
  }
  if (manifest.evaluation_mode === "QUALIFICATION" && !["CALIBRATION", "QUALIFICATION"].includes(contract.phase)) {
    throw new Error("qualification manifests may use only CALIBRATION or QUALIFICATION budget phases");
  }
  exactKeys(contract.joint_envelope_policy,
    ["method", "target_coverage", "holdout_required", "case_specific_limits_forbidden"],
    "candidate_budget_contract.joint_envelope_policy");
  if (contract.joint_envelope_policy.method !== "whole_trial_multidimensional_envelope" ||
      !Number.isFinite(contract.joint_envelope_policy.target_coverage) ||
      contract.joint_envelope_policy.target_coverage <= 0 || contract.joint_envelope_policy.target_coverage >= 1 ||
      contract.joint_envelope_policy.holdout_required !== true ||
      contract.joint_envelope_policy.case_specific_limits_forbidden !== true) {
    throw new Error("candidate budget joint envelope policy is invalid");
  }
  if (!Array.isArray(contract.profiles) || contract.profiles.length !== manifest.contestants.length) {
    throw new Error("candidate budget profiles must match the frozen contestants one-for-one");
  }
  const refs = contract.profiles.map((item) => item?.contestant_ref);
  const expectedRefs = manifest.contestants.map((item) => item.ref);
  if (new Set(refs).size !== refs.length || [...refs].sort().join("\n") !== [...expectedRefs].sort().join("\n")) {
    throw new Error("candidate budget profiles must cover each frozen contestant exactly once");
  }
  for (const profile of contract.profiles) {
    exactKeys(profile, ["contestant_ref", "candidate_limits", "settlement_limits", "enforcement", "provenance"],
      `candidate_budget_contract.profiles.${profile.contestant_ref}`);
    positiveBudget(profile.candidate_limits, CANDIDATE_NATIVE_BUDGET_DIMENSIONS,
      `candidate budget ${profile.contestant_ref}`, { integers: true });
    positiveBudget(profile.settlement_limits, LEGACY_BUDGET_DIMENSIONS,
      `settlement budget ${profile.contestant_ref}`);
    settlementCoversCandidate(profile.candidate_limits, profile.settlement_limits, profile.contestant_ref);
    exactKeys(profile.enforcement, CANDIDATE_NATIVE_BUDGET_DIMENSIONS,
      `budget enforcement ${profile.contestant_ref}`);
    for (const dimension of CANDIDATE_NATIVE_BUDGET_DIMENSIONS) {
      if (!ENFORCEMENT_MODES.has(profile.enforcement[dimension])) {
        throw new Error(`budget enforcement mode is invalid: ${profile.contestant_ref}.${dimension}`);
      }
    }
    exactKeys(profile.provenance,
      ["status", "method", "source_revision", "artifact_digest", "sample_trial_ids", "evidence_ref"],
      `budget provenance ${profile.contestant_ref}`);
    if (!PROVENANCE_STATES.has(profile.provenance.status) || !profile.provenance.method ||
        !profile.provenance.evidence_ref || !Array.isArray(profile.provenance.sample_trial_ids) ||
        new Set(profile.provenance.sample_trial_ids).size !== profile.provenance.sample_trial_ids.length ||
        profile.provenance.sample_trial_ids.some((item) => typeof item !== "string" || !item)) {
      throw new Error(`budget provenance is invalid: ${profile.contestant_ref}`);
    }
    const contestant = manifest.contestants.find((item) => item.ref === profile.contestant_ref);
    if (profile.provenance.source_revision !== contestant.source_revision ||
        profile.provenance.artifact_digest !== contestant.artifact_digest ||
        !SHA256_DIGEST.test(profile.provenance.artifact_digest)) {
      throw new Error(`budget provenance must bind the frozen contestant: ${profile.contestant_ref}`);
    }
    const empiricalRequired = ["QUALIFICATION", "CAPACITY", "FORMAL"].includes(contract.phase);
    if (empiricalRequired && (profile.provenance.status !== "empirical_calibrated" ||
        profile.provenance.sample_trial_ids.length === 0 ||
        Object.values(profile.enforcement).some((value) => value !== "enforced"))) {
      throw new Error(`non-calibration budget requires empirical samples and full enforcement: ${profile.contestant_ref}`);
    }
  }
  return contract;
}

export function candidateBudgetProfile(manifest, contestantRef) {
  if (manifest?.manifest_version !== "8.0") return null;
  validateCandidateBudgetContract(manifest);
  const profile = profileFor(manifest, contestantRef);
  if (!profile) throw new Error(`candidate budget profile is missing: ${contestantRef}`);
  return profile;
}

export function candidateExecutionBudget(manifest, contestantRef) {
  return candidateBudgetProfile(manifest, contestantRef)?.candidate_limits ?? manifest?.budget ?? null;
}

export function trialSettlementBudget(manifest, contestantRef) {
  return candidateBudgetProfile(manifest, contestantRef)?.settlement_limits ?? manifest?.budget ?? null;
}
