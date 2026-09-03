import { createPublicKey, verify } from "node:crypto";
import { stableStringify } from "./utils.mjs";

export const PHYSICAL_LAB_LEASE_CONTRACT = "opsmind-physical-lab-lease/1.0";
export const CANDIDATE_PRESENCE_CONTRACT = "opsmind-candidate-presence/1.0";
export const RELEASE_SWITCH_CONTRACT = "opsmind-release-switch/1.0";
export const CANDIDATE_PRESENCE_PATH = "/api/candidate-presence";
export const CANDIDATE_PRESENCE_TTL_MS = 180_000;
export const DEPLOYMENT_ATTESTATION_CONTRACT = "evalos-deployment-attestation/1.0";

export function trustedDeploymentAttestation(value) {
  if (value?.contract_version !== DEPLOYMENT_ATTESTATION_CONTRACT ||
      !/^[a-f0-9]{40}$/.test(String(value?.source_revision ?? "")) ||
      !/^sha256:[a-f0-9]{64}$/.test(String(value?.artifact_digest ?? "")) ||
      !["evalos_trusted_read_only_git_oci", "evalos_trusted_runtime_config"].includes(value?.verification_method) ||
      typeof value?.verified_evidence_ref !== "string" || !value.verified_evidence_ref) {
    throw new Error("candidate deployment identity requires an independent EvalOS deployment attestation");
  }
  return Object.freeze({ source_revision: value.source_revision, artifact_digest: value.artifact_digest });
}

export const USE_MODES = Object.freeze(["langgraph_direct", "agent_harness_direct", "evalos_trial"]);
export const CANDIDATE_REFS = Object.freeze(["langgraph-v1", "agent-harness-v2"]);

const USE_MODE_SET = new Set(USE_MODES);
const CANDIDATE_REF_SET = new Set(CANDIDATE_REFS);
const LEASE_STATUS_SET = new Set(["idle", "in_use", "quarantined"]);
const REPORT_STATUS_SET = new Set(["ready", "not_ready"]);
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$/;
const NONCE = /^[A-Za-z0-9_-]{22,128}$/;

const DEPLOYMENT_HELPERS = Object.freeze({
  "langgraph-v1": "/usr/local/sbin/opsmind-langgraph-release",
  "agent-harness-v2": "/usr/local/sbin/opsmind-agent-harness-release",
});

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort().join("\n");
  const expected = [...keys].sort().join("\n");
  if (actual !== expected) throw new Error(`${label} must contain exactly ${[...keys].sort().join(", ")}`);
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function nullableString(value, label) {
  if (value !== null) requiredString(value, label);
  return value;
}

function instant(value, label) {
  requiredString(value, label);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return parsed;
}

function expectedCandidateForMode(mode) {
  if (mode === "langgraph_direct") return "langgraph-v1";
  if (mode === "agent_harness_direct") return "agent-harness-v2";
  return null;
}

export function validatePhysicalLabLease(lease, { nowMs = null, expectedBootId = null } = {}) {
  exactKeys(lease, ["contract_version", "status", "owner_mode", "candidate_ref", "trial_id", "runtime_trial_id", "lease_id",
    "expires_at", "boot_id", "updated_at"], "physical lab lease");
  if (lease.contract_version !== PHYSICAL_LAB_LEASE_CONTRACT) {
    throw new Error(`physical lab lease must use ${PHYSICAL_LAB_LEASE_CONTRACT}`);
  }
  if (!LEASE_STATUS_SET.has(lease.status)) throw new Error("physical lab lease status is invalid");
  requiredString(lease.boot_id, "physical lab lease boot_id");
  instant(lease.updated_at, "physical lab lease updated_at");
  if (expectedBootId !== null && lease.boot_id !== expectedBootId) {
    throw new Error("physical lab boot changed; lease must be quarantined and reset");
  }
  for (const [name, value] of [["owner_mode", lease.owner_mode], ["candidate_ref", lease.candidate_ref],
    ["trial_id", lease.trial_id], ["runtime_trial_id", lease.runtime_trial_id],
    ["lease_id", lease.lease_id], ["expires_at", lease.expires_at]]) {
    nullableString(value, `physical lab lease ${name}`);
  }
  if (lease.status === "idle") {
    if ([lease.owner_mode, lease.candidate_ref, lease.trial_id, lease.runtime_trial_id, lease.lease_id, lease.expires_at]
      .some((value) => value !== null)) throw new Error("idle physical lab lease must not retain an owner or binding");
    return Object.freeze({ ...lease });
  }
  if (lease.status === "in_use") {
    if (!USE_MODE_SET.has(lease.owner_mode)) throw new Error("physical lab lease owner_mode is invalid");
    if (!CANDIDATE_REF_SET.has(lease.candidate_ref)) throw new Error("physical lab lease candidate_ref is invalid");
    requiredString(lease.lease_id, "physical lab lease lease_id");
    requiredString(lease.runtime_trial_id, "physical lab lease runtime_trial_id");
    const expiresAt = instant(lease.expires_at, "physical lab lease expires_at");
    if (nowMs !== null && expiresAt <= nowMs) throw new Error("physical lab lease expired; explicit reset is required");
    const fixedCandidate = expectedCandidateForMode(lease.owner_mode);
    if (fixedCandidate && lease.candidate_ref !== fixedCandidate) {
      throw new Error("physical lab lease mode and candidate do not match");
    }
    if (lease.owner_mode === "evalos_trial") requiredString(lease.trial_id, "EvalOS physical lab lease trial_id");
    else if (lease.trial_id !== null) throw new Error("direct physical lab lease must not claim an EvalOS trial_id");
  }
  return Object.freeze({ ...lease });
}

export function assertPhysicalLabLeaseAcquirable(lease, { bootId, nowMs = Date.now() } = {}) {
  validatePhysicalLabLease(lease, { nowMs: null });
  if (lease.boot_id !== bootId) throw new Error("physical lab boot changed; quarantine and reset before acquisition");
  if (lease.status !== "idle") throw new Error(`physical lab is not idle: ${lease.status}`);
  return true;
}

function validateBinding(binding) {
  exactKeys(binding, ["status", "owner_mode", "trial_id", "lease_id", "environment_ref", "lab_boot_id"],
    "candidate presence binding");
  if (!new Set(["unbound", "bound"]).has(binding.status)) throw new Error("candidate presence binding status is invalid");
  for (const [name, value] of [["owner_mode", binding.owner_mode], ["trial_id", binding.trial_id],
    ["lease_id", binding.lease_id], ["environment_ref", binding.environment_ref], ["lab_boot_id", binding.lab_boot_id]]) {
    nullableString(value, `candidate presence binding ${name}`);
  }
  if (binding.status === "unbound") {
    if ([binding.owner_mode, binding.trial_id, binding.lease_id, binding.environment_ref, binding.lab_boot_id]
      .some((value) => value !== null)) throw new Error("unbound candidate presence must not retain a Trial binding");
  } else {
    if (binding.owner_mode !== "evalos_trial") throw new Error("bound candidate presence must belong to evalos_trial");
    for (const name of ["trial_id", "lease_id", "environment_ref", "lab_boot_id"]) {
      requiredString(binding[name], `bound candidate presence ${name}`);
    }
  }
  return binding;
}

export function validateCandidatePresenceReport(report, { nowMs = Date.now(), signatureWindowMs = 90_000 } = {}) {
  exactKeys(report, ["contract_version", "candidate_ref", "release_id", "product_boot_id", "status", "capabilities",
    "database_revision", "binding", "observed_at", "expires_at", "nonce"], "candidate presence report");
  if (report.contract_version !== CANDIDATE_PRESENCE_CONTRACT) {
    throw new Error(`candidate presence report must use ${CANDIDATE_PRESENCE_CONTRACT}`);
  }
  if (!CANDIDATE_REF_SET.has(report.candidate_ref)) throw new Error("candidate presence candidate_ref is invalid");
  if (!RELEASE_ID.test(requiredString(report.release_id, "candidate presence release_id"))) {
    throw new Error("candidate presence release_id is invalid");
  }
  requiredString(report.product_boot_id, "candidate presence product_boot_id");
  requiredString(report.database_revision, "candidate presence database_revision");
  if (!REPORT_STATUS_SET.has(report.status)) throw new Error("candidate presence status is invalid");
  if (!Array.isArray(report.capabilities) || report.capabilities.length === 0 ||
      report.capabilities.some((item) => typeof item !== "string" || !item.trim()) ||
      new Set(report.capabilities).size !== report.capabilities.length) {
    throw new Error("candidate presence capabilities must be non-empty unique strings");
  }
  validateBinding(report.binding);
  if (!NONCE.test(report.nonce)) throw new Error("candidate presence nonce is invalid");
  const observedAt = instant(report.observed_at, "candidate presence observed_at");
  const expiresAt = instant(report.expires_at, "candidate presence expires_at");
  if (expiresAt <= observedAt || expiresAt - observedAt > CANDIDATE_PRESENCE_TTL_MS) {
    throw new Error("candidate presence lifetime must be greater than zero and at most 180 seconds");
  }
  if (observedAt > nowMs + 30_000 || nowMs - observedAt > signatureWindowMs) {
    throw new Error("candidate presence report is outside the accepted clock window");
  }
  if (expiresAt <= nowMs) throw new Error("candidate presence report expired");
  return Object.freeze({ ...report, capabilities: Object.freeze([...report.capabilities]),
    binding: Object.freeze({ ...report.binding }) });
}

export function candidatePresenceSignaturePayload(report) {
  return `POST\n${CANDIDATE_PRESENCE_PATH}\n${stableStringify(report)}`;
}

function header(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1] ?? null;
}

export class CandidatePresenceRegistry {
  constructor({ candidates, clock = () => Date.now(), signatureWindowMs = 90_000 } = {}) {
    if (!candidates || typeof candidates !== "object" || Array.isArray(candidates)) {
      throw new Error("candidate presence registry requires candidate keys");
    }
    this.clock = clock;
    this.signatureWindowMs = signatureWindowMs;
    this.candidates = Object.fromEntries(Object.entries(candidates).map(([candidateRef, item]) => {
      if (!CANDIDATE_REF_SET.has(candidateRef)) throw new Error(`unsupported candidate presence identity: ${candidateRef}`);
      requiredString(item?.key_id, `candidate presence ${candidateRef} key_id`);
      return [candidateRef, { keyId: item.key_id, publicKey: createPublicKey(item.public_key_pem) }];
    }));
    const keyIds = Object.values(this.candidates).map((item) => item.keyId);
    if (new Set(keyIds).size !== keyIds.length) throw new Error("candidate presence key_id must be distinct per product");
    this.reports = new Map();
    this.nonces = new Map();
  }

  accept({ report, headers }) {
    const nowMs = this.clock();
    const validated = validateCandidatePresenceReport(report, { nowMs, signatureWindowMs: this.signatureWindowMs });
    const identity = this.candidates[validated.candidate_ref];
    if (!identity) throw new Error("candidate presence identity is not registered");
    const keyId = header(headers, "x-opsmind-key-id");
    const signature = header(headers, "x-opsmind-signature");
    if (keyId !== identity.keyId) throw new Error("candidate presence key does not match candidate_ref");
    if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) {
      throw new Error("candidate presence signature is missing or invalid");
    }
    const signatureBytes = Buffer.from(signature, "base64url");
    if (signatureBytes.length !== 64 || !verify(null, Buffer.from(candidatePresenceSignaturePayload(validated)),
      identity.publicKey, signatureBytes)) throw new Error("candidate presence signature verification failed");
    for (const [nonceKey, expiresAt] of this.nonces) if (expiresAt <= nowMs) this.nonces.delete(nonceKey);
    const nonceKey = `${validated.candidate_ref}:${validated.nonce}`;
    if (this.nonces.has(nonceKey)) throw new Error("candidate presence nonce was replayed");
    const previous = this.reports.get(validated.candidate_ref);
    if (previous && Date.parse(validated.observed_at) <= Date.parse(previous.observed_at)) {
      throw new Error("candidate presence report is older than the current report");
    }
    this.nonces.set(nonceKey, Date.parse(validated.expires_at));
    this.reports.set(validated.candidate_ref, validated);
    return validated;
  }

  current(candidateRef) {
    const report = this.reports.get(candidateRef) ?? null;
    if (!report) return null;
    if (Date.parse(report.expires_at) <= this.clock()) {
      this.reports.delete(candidateRef);
      return null;
    }
    return report;
  }
}

function assertExpectedCandidate(report, { candidateRef, releaseId, databaseRevision, requiredCapabilities = [] }) {
  if (!report) throw new Error("candidate has not reported ready since EvalOS started");
  if (report.candidate_ref !== candidateRef) throw new Error("candidate presence belongs to another product");
  if (report.status !== "ready") throw new Error("candidate explicitly reported not_ready");
  if (releaseId && report.release_id !== releaseId) throw new Error("candidate release does not match the frozen version");
  if (databaseRevision && report.database_revision !== databaseRevision) {
    throw new Error("candidate database revision is incompatible with the frozen release");
  }
  const missing = requiredCapabilities.filter((item) => !report.capabilities.includes(item));
  if (missing.length) throw new Error(`candidate capabilities are missing: ${missing.join(",")}`);
}

export function assertCandidatePreflight({ registry, candidateRef, lease, releaseId = null,
  databaseRevision = null, requiredCapabilities = [], labBootId }) {
  assertPhysicalLabLeaseAcquirable(lease, { bootId: labBootId });
  const report = registry.current(candidateRef);
  assertExpectedCandidate(report, { candidateRef, releaseId, databaseRevision, requiredCapabilities });
  if (report.binding.status !== "unbound") throw new Error("candidate still carries an old Trial binding");
  return Object.freeze({ stage: "preflight", candidate_ref: candidateRef, release_id: report.release_id,
    database_revision: report.database_revision });
}

export function assertCandidateBound({ registry, candidateRef, lease, trialId, leaseId, environmentRef,
  releaseId = null, databaseRevision = null, requiredCapabilities = [], labBootId, nowMs = Date.now() }) {
  const validatedLease = validatePhysicalLabLease(lease, { nowMs, expectedBootId: labBootId });
  if (validatedLease.status !== "in_use" || validatedLease.owner_mode !== "evalos_trial" ||
      validatedLease.candidate_ref !== candidateRef || validatedLease.trial_id !== trialId ||
      validatedLease.lease_id !== leaseId) throw new Error("physical lab lease does not match the EvalOS Trial");
  const report = registry.current(candidateRef);
  assertExpectedCandidate(report, { candidateRef, releaseId, databaseRevision, requiredCapabilities });
  const binding = report.binding;
  if (binding.status !== "bound" || binding.owner_mode !== "evalos_trial" || binding.trial_id !== trialId ||
      binding.lease_id !== leaseId || binding.environment_ref !== environmentRef || binding.lab_boot_id !== labBootId) {
    throw new Error("candidate report does not confirm the exact EvalOS Trial binding");
  }
  return Object.freeze({ stage: "bound", candidate_ref: candidateRef, trial_id: trialId, lease_id: leaseId,
    environment_ref: environmentRef });
}

export function validateRestrictedDeploymentCommand(candidateRef, argv) {
  const helper = DEPLOYMENT_HELPERS[candidateRef];
  if (!helper) throw new Error("deployment command candidate is invalid");
  if (!Array.isArray(argv) || argv[0] !== helper) throw new Error("deployment command must use the fixed product helper");
  if (argv.length === 2 && new Set(["status", "rollback"]).has(argv[1])) return Object.freeze([...argv]);
  if (argv.length === 3 && argv[1] === "apply" && RELEASE_ID.test(argv[2])) return Object.freeze([...argv]);
  throw new Error("deployment command is outside the fixed status/apply/rollback allowlist");
}

export function validateReleaseSwitchPlan(plan) {
  exactKeys(plan, ["contract_version", "candidate_ref", "action", "current_release", "previous_release",
    "target_release", "current_database_revision", "target_database_revision", "database_action",
    "other_product_action", "argv"], "release switch plan");
  if (plan.contract_version !== RELEASE_SWITCH_CONTRACT) {
    throw new Error(`release switch plan must use ${RELEASE_SWITCH_CONTRACT}`);
  }
  if (!CANDIDATE_REF_SET.has(plan.candidate_ref)) throw new Error("release switch candidate_ref is invalid");
  for (const name of ["current_release", "previous_release", "target_release"]) {
    if (!RELEASE_ID.test(requiredString(plan[name], `release switch ${name}`))) {
      throw new Error(`release switch ${name} is invalid`);
    }
  }
  if (!new Set(["apply", "rollback"]).has(plan.action)) throw new Error("release switch action is invalid");
  if (plan.action === "apply" && plan.target_release === plan.current_release) {
    throw new Error("release apply target must differ from current");
  }
  if (plan.action === "rollback" && plan.target_release !== plan.previous_release) {
    throw new Error("release rollback target must be the recorded previous release");
  }
  requiredString(plan.current_database_revision, "release switch current_database_revision");
  requiredString(plan.target_database_revision, "release switch target_database_revision");
  if (plan.current_database_revision !== plan.target_database_revision || plan.database_action !== "none") {
    throw new Error("application release switch must not migrate or roll back the database");
  }
  if (plan.other_product_action !== "none") throw new Error("release switch must not touch the other product");
  validateRestrictedDeploymentCommand(plan.candidate_ref, plan.argv);
  if (plan.action === "apply" && plan.argv[2] !== plan.target_release) {
    throw new Error("release apply command target does not match the plan");
  }
  if (plan.action === "rollback" && plan.argv.length !== 2) {
    throw new Error("release rollback must use the fixed previous pointer");
  }
  return Object.freeze({ ...plan, argv: Object.freeze([...plan.argv]) });
}
