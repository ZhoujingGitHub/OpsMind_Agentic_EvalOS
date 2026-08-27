import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { entityId, isoNow, parseJson, seedFromString, seededShuffle, sha256, stableStringify } from "./utils.mjs";
import { redact } from "./redaction.mjs";
import { LEGACY_BUDGET_DIMENSIONS, trialSettlementBudget, validateCandidateResourceContract } from "./budget-profile.mjs";

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

function assertExactKeys(value, required, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.join("\n") !== expected.join("\n")) throw new Error(`${label} must contain exactly ${expected.join(", ")}`);
}

function assertUniqueStrings(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item) ||
      new Set(value).size !== value.length) throw new Error(`${label} must be a unique string list`);
}

function hydrateExperiment(row) {
  return row ? { ...row, manifest: parseJson(row.manifest_json, {}) } : null;
}

function hydrateTrial(row) {
  if (!row) return null;
  return {
    ...row,
    budget: parseJson(row.budget_json, {}),
    outcome: parseJson(row.outcome_json, null),
    usage: parseJson(row.usage_json, null),
    final_state: parseJson(row.final_state_json, null),
  };
}

function hydrateRunRequest(row) {
  if (!row) return null;
  return { ...row, selection: parseJson(row.selection_json, {}), preflight: parseJson(row.preflight_json, {}) };
}

function trialSelect(where = "") {
  return `SELECT t.*, r.outcome_json, r.usage_json, r.final_state_json, r.trace_hash, r.result_hash
    FROM trials t LEFT JOIN trial_results r ON r.trial_id=t.id ${where}`;
}

function manifestRefs(manifest) {
  const manifestVersion = manifest.manifest_version;
  if (!["6.0", "7.0", "8.0"].includes(manifestVersion)) {
    throw new Error("EvalOS requires experiment manifest 6.0, 7.0 or 8.0; legacy manifests are archived read-only and cannot execute");
  }
  const expectedMilestone = ["7.0", "8.0"].includes(manifestVersion) ? "M3.2" : "M3.1";
  const expectedAdapterContract = ["7.0", "8.0"].includes(manifestVersion) ? "5.0" : "4.0";
  if (manifest.milestone !== expectedMilestone) throw new Error(`Manifest ${manifestVersion} requires milestone ${expectedMilestone}`);
  if (!["ENGINEERING_TEST", "REAL_CANDIDATE"].includes(manifest.run_class)) {
    throw new Error("run_class must be ENGINEERING_TEST or REAL_CANDIDATE");
  }
  if (!["QUALIFICATION", "CAPACITY_REHEARSAL", "FORMAL"].includes(manifest.evaluation_mode)) {
    throw new Error("evaluation_mode must be QUALIFICATION, CAPACITY_REHEARSAL, or FORMAL");
  }
  if (!["ENGINEERING_TEST", "AGENT_CAPABILITY", "CONTROLLED_CLOSURE", "PRODUCT_RELIABILITY"].includes(manifest.evaluation_lane)) {
    throw new Error(`evaluation_lane is not supported by Manifest ${manifestVersion}`);
  }
  if (manifest.run_class === "ENGINEERING_TEST" && manifest.evaluation_lane !== "ENGINEERING_TEST") {
    throw new Error("engineering test data must use the isolated ENGINEERING_TEST lane");
  }
  if (manifest.run_class === "REAL_CANDIDATE" && manifest.evaluation_lane === "ENGINEERING_TEST") {
    throw new Error("real candidates cannot run in the engineering test lane");
  }
  assertUniqueStrings(manifest.operating_modes, "operating_modes");
  if (manifest.operating_modes.some((mode) => !["diagnosis_only", "human_collaboration", "controlled_auto"].includes(mode))) {
    throw new Error("operating_modes contains an unsupported commercial mode");
  }
  if (!["controlled_simulation", "replay_read_only"].includes(manifest.execution_mode)) {
    throw new Error("execution_mode must keep production writes closed");
  }
  assertExactKeys(manifest.approval_oracle, ["ref", "digest", "decision_source", "timeout_ms", "separation_of_duties"], "approval_oracle");
  if (!manifest.approval_oracle.ref || !SHA256_DIGEST.test(manifest.approval_oracle.digest) ||
      manifest.approval_oracle.decision_source !== "frozen_case_contract" ||
      !Number.isInteger(manifest.approval_oracle.timeout_ms) || manifest.approval_oracle.timeout_ms < 1000 ||
      manifest.approval_oracle.separation_of_duties !== true) {
    throw new Error("approval_oracle must be frozen, deterministic and independent from the candidate");
  }
  if (!manifest.suite_ref || !manifest.dataset_ref) throw new Error("suite_ref and dataset_ref are required");
  if (!Array.isArray(manifest.case_refs) || !manifest.case_refs.length || new Set(manifest.case_refs).size !== manifest.case_refs.length) {
    throw new Error("case_refs must be a non-empty unique list");
  }
  if (!Array.isArray(manifest.environment_seeds) || !manifest.environment_seeds.length ||
      manifest.environment_seeds.some((seed) => !Number.isInteger(seed)) ||
      new Set(manifest.environment_seeds).size !== manifest.environment_seeds.length) {
    throw new Error("environment_seeds must be a non-empty unique integer list");
  }
  if (!Number.isInteger(manifest.replicates_per_seed) || manifest.replicates_per_seed < 1) {
    throw new Error("replicates_per_seed must be a positive integer");
  }
  const requiredPartitions = ["public", "hidden", "safety", "regression"];
  if (!manifest.case_partitions || Object.keys(manifest.case_partitions).sort().join(",") !== requiredPartitions.sort().join(",")) {
    throw new Error("case_partitions must contain exactly public, hidden, safety, and regression");
  }
  const partitionedRefs = requiredPartitions.flatMap((name) => {
    const refs = manifest.case_partitions[name];
    if (!Array.isArray(refs) || new Set(refs).size !== refs.length) throw new Error(`case_partitions.${name} must be a unique list`);
    return refs;
  });
  if (new Set(partitionedRefs).size !== partitionedRefs.length ||
      [...new Set(partitionedRefs)].sort().join("\n") !== [...manifest.case_refs].sort().join("\n")) {
    throw new Error("case_partitions must be disjoint and their union must equal case_refs");
  }
  if (!["single_system_acceptance", "paired_comparison"].includes(manifest.design)) {
    throw new Error("design must be single_system_acceptance or paired_comparison");
  }
  const expectedContestants = manifest.design === "paired_comparison" ? 2 : 1;
  if (!Array.isArray(manifest.contestants) || manifest.contestants.length !== expectedContestants) {
    throw new Error(`${manifest.design} requires exactly ${expectedContestants} contestant(s)`);
  }
  for (const contestant of manifest.contestants) {
    if (!contestant.ref || !["REAL_PRODUCT", "TEST_DOUBLE"].includes(contestant.kind) || !contestant.architecture ||
        contestant.adapter_contract_version !== expectedAdapterContract || !contestant.adapter_version || !contestant.source_revision ||
        !SHA256_DIGEST.test(contestant.artifact_digest) || !SHA256_DIGEST.test(contestant.runtime_digest) ||
        !SHA256_DIGEST.test(contestant.runtime_manifest_digest) || !SHA256_DIGEST.test(contestant.capability_contract_digest)) {
      throw new Error(`each contestant must freeze identity, kind, architecture, Adapter ${expectedAdapterContract}, source, runtime and capability fingerprints`);
    }
  }
  const contestantKinds = new Set(manifest.contestants.map((item) => item.kind));
  if (contestantKinds.size !== 1) throw new Error("test doubles and real candidates must never be mixed in one experiment");
  if (manifest.run_class === "ENGINEERING_TEST" && !contestantKinds.has("TEST_DOUBLE")) {
    throw new Error("ENGINEERING_TEST accepts only explicitly labelled TEST_DOUBLE contestants");
  }
  if (manifest.run_class === "REAL_CANDIDATE" && !contestantKinds.has("REAL_PRODUCT")) {
    throw new Error("REAL_CANDIDATE accepts only frozen external REAL_PRODUCT contestants");
  }
  if (!manifest.model || !manifest.frozen_dependencies ||
      (manifestVersion === "8.0" ? !manifest.candidate_resource_contract : !manifest.budget) || !manifest.policy ||
      !manifest.retry_policy || !manifest.capacity_policy || !manifest.statistics_policy) {
    throw new Error(`Manifest ${manifestVersion} must freeze model, dependencies, candidate budget, policy, retry, capacity, and statistics`);
  }
  assertExactKeys(manifest.model, ["provider", "id", "interface", "sdk", "thinking", "temperature", "max_turns"], "model");
  if (manifest.model.provider !== "deepseek" || manifest.model.id !== "deepseek-v4-flash" ||
      manifest.model.interface !== "anthropic" || manifest.model.sdk !== "@anthropic-ai/claude-agent-sdk" ||
      !["enabled", "disabled"].includes(manifest.model.thinking) || !Number.isFinite(manifest.model.temperature) ||
      !Number.isInteger(manifest.model.max_turns) || manifest.model.max_turns < 1) throw new Error("model freeze is invalid");

  if (["7.0", "8.0"].includes(manifestVersion)) {
    if (manifest.run_class !== "REAL_CANDIDATE") throw new Error(`Manifest ${manifestVersion} is reserved for external REAL_CANDIDATE products`);
    assertExactKeys(manifest.candidate_runtime_policy,
      ["source", "allow_multi_model", "hidden_case_fields", "usage_accounting"], "candidate_runtime_policy");
    if (manifest.candidate_runtime_policy.source !== "candidate_public_api" ||
        manifest.candidate_runtime_policy.allow_multi_model !== true ||
        manifest.candidate_runtime_policy.hidden_case_fields !== "opaque_digest_only" ||
        manifest.candidate_runtime_policy.usage_accounting !== "reported_with_explicit_unknowns") {
      throw new Error("Manifest 7.0 candidate_runtime_policy must preserve public discovery, opaque blind fields and explicit usage unknowns");
    }
    for (const contestant of manifest.contestants) {
      if (contestant.adapter_version !== "candidate-adapter-5.0.0") {
        throw new Error(`Manifest ${manifestVersion} contestants must use candidate-adapter-5.0.0`);
      }
      if (!['PRODUCT_NATIVE_ACK', 'EVIDENCE_CHAIN_BOUND'].includes(contestant.binding_requirement)) {
        throw new Error("Manifest 7.0 contestants must freeze a supported binding_requirement");
      }
      const runtime = contestant.candidate_runtime;
      assertExactKeys(runtime, ["contract_version", "models", "versions"], `contestants.${contestant.ref}.candidate_runtime`);
      if (runtime.contract_version !== "1.0") throw new Error("candidate_runtime contract_version must be 1.0");
      if (!Array.isArray(runtime.models) || !runtime.models.length) throw new Error("candidate_runtime.models must be non-empty");
      for (const model of runtime.models) {
        assertExactKeys(model, ["provider", "id", "interface", "thinking", "roles"], "candidate_runtime.models[]");
        if (!model.provider || !model.id || !model.interface || !["enabled", "disabled", "unknown"].includes(model.thinking)) {
          throw new Error("candidate_runtime model profile is invalid");
        }
        assertUniqueStrings(model.roles, "candidate_runtime.models[].roles");
        if (!model.roles.length) throw new Error("candidate_runtime model roles must be non-empty");
      }
      if (!runtime.versions || typeof runtime.versions !== "object" || Array.isArray(runtime.versions) ||
          !Object.keys(runtime.versions).length || Object.values(runtime.versions).some((value) => typeof value !== "string" || !value)) {
        throw new Error("candidate_runtime.versions must freeze public string versions");
      }
      if (!manifest.candidate_runtime_policy.allow_multi_model && runtime.models.length > 1) {
        throw new Error("candidate_runtime contains multiple models but the policy forbids it");
      }
    }
  }

  if (manifestVersion === "8.0") validateCandidateResourceContract(manifest);

  const dependencyKeys = ["mcp_catalog", "agent_harness_skill_pack", "langgraph_knowledge_pack", "scope_policy", "grader", "twin", "trace_schema", "product_adapter_contract"];
  assertExactKeys(manifest.frozen_dependencies, dependencyKeys, "frozen_dependencies");
  for (const key of dependencyKeys) {
    assertExactKeys(manifest.frozen_dependencies[key], ["ref", "digest"], `frozen_dependencies.${key}`);
    if (!manifest.frozen_dependencies[key].ref || !SHA256_DIGEST.test(manifest.frozen_dependencies[key].digest)) {
      throw new Error(`frozen_dependencies.${key} must have a versioned ref and sha256 digest`);
    }
  }

  if (manifestVersion !== "8.0") {
    assertExactKeys(manifest.budget, LEGACY_BUDGET_DIMENSIONS, "budget");
    if (LEGACY_BUDGET_DIMENSIONS.some((key) => !Number.isFinite(manifest.budget[key]) || manifest.budget[key] <= 0)) {
      throw new Error("all frozen budget values must be positive numbers");
    }
  }

  assertExactKeys(manifest.policy, ["allowed_tools", "allowed_native_tools", "forbidden_actions", "heartbeat_ms", "result_contract", "production_writes", "action_approval"], "policy");
  assertUniqueStrings(manifest.policy.allowed_tools, "policy.allowed_tools");
  assertUniqueStrings(manifest.policy.allowed_native_tools, "policy.allowed_native_tools");
  assertUniqueStrings(manifest.policy.forbidden_actions, "policy.forbidden_actions");
  if (manifest.policy.production_writes !== false) throw new Error("production writes must remain hard-disabled");
  assertExactKeys(manifest.policy.action_approval, ["mode", "max_writes_per_trial"], "policy.action_approval");
  if (manifest.policy.action_approval.mode !== "case-driven-approval-oracle" ||
      !Number.isInteger(manifest.policy.action_approval.max_writes_per_trial) || manifest.policy.action_approval.max_writes_per_trial < 0) {
    throw new Error("action approval must use the frozen approval oracle with a non-negative write limit");
  }

  assertExactKeys(manifest.retry_policy, ["max_infrastructure_retries", "retryable_categories", "capability_failures_retryable"], "retry_policy");
  assertUniqueStrings(manifest.retry_policy.retryable_categories, "retry_policy.retryable_categories");
  if (!Number.isInteger(manifest.retry_policy.max_infrastructure_retries) || manifest.retry_policy.max_infrastructure_retries < 0 ||
      manifest.retry_policy.capability_failures_retryable !== false) throw new Error("retry_policy is invalid");

  assertExactKeys(manifest.capacity_policy, ["runner_workers", "twin_slots", "max_queue_depth"], "capacity_policy");
  if (["runner_workers", "twin_slots", "max_queue_depth"].some((key) => !Number.isInteger(manifest.capacity_policy[key]) || manifest.capacity_policy[key] < 1)) {
    throw new Error("capacity_policy values must be positive integers");
  }
  if (manifestVersion === "8.0") {
    assertExactKeys(manifest.statistics_policy,
      ["comparison_design", "confidence_level", "cluster_by_case", "report_failures",
        "per_architecture_usage_reporting", "resource_usage_affects_score"],
      "statistics_policy");
    if (!["independent_stratified", "paired_case_control"].includes(manifest.statistics_policy.comparison_design) ||
        manifest.statistics_policy.confidence_level !== 0.95 || manifest.statistics_policy.cluster_by_case !== true ||
        manifest.statistics_policy.report_failures !== true ||
        manifest.statistics_policy.per_architecture_usage_reporting !== true ||
        manifest.statistics_policy.resource_usage_affects_score !== false) {
      throw new Error("Manifest 8.0 statistics_policy must keep resource usage descriptive and separate by architecture");
    }
  } else {
    assertExactKeys(manifest.statistics_policy, ["paired_by_case_seed", "confidence_level", "cluster_by_case", "report_failures"], "statistics_policy");
    if (manifest.statistics_policy.paired_by_case_seed !== true || manifest.statistics_policy.confidence_level !== 0.95 ||
        manifest.statistics_policy.cluster_by_case !== true || manifest.statistics_policy.report_failures !== true) {
      throw new Error("statistics_policy must preserve the frozen paired design");
    }
  }
}

function credentialDigest(credential, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${scryptSync(String(credential), salt, 32).toString("hex")}`;
}

function credentialMatches(credential, encoded) {
  const [salt, expectedHex] = String(encoded ?? "").split(":");
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(String(credential), salt, 32);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class EvalStore {
  constructor({ databasePath, migrationPath, migrationPaths = [], runtimeRoot }) {
    this.databasePath = path.resolve(databasePath);
    this.runtimeRoot = path.resolve(runtimeRoot);
    mkdirSync(path.dirname(this.databasePath), { recursive: true });
    mkdirSync(this.runtimeRoot, { recursive: true });
    this.db = new DatabaseSync(this.databasePath);
    const migrations = [migrationPath, ...migrationPaths].filter(Boolean);
    if (!migrations.length) throw new Error("at least one database migration is required");
    for (const migration of migrations) {
      const sql = readFileSync(migration, "utf8");
      const targetVersion = Number(sql.match(/PRAGMA\s+user_version\s*=\s*(\d+)/i)?.[1] ?? 0);
      const currentVersion = Number(this.db.prepare("PRAGMA user_version").get().user_version ?? 0);
      if (!targetVersion || currentVersion < targetVersion) this.db.exec(sql);
    }
  }

  close() { this.db.close(); }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  publishRegistry(registry, { privateLabelHash } = {}) {
    if (!privateLabelHash) throw new Error("privateLabelHash from the isolated grading plane is required");
    const control = registry.snapshot({ includeRuntime: true });
    return this.transaction(() => {
      const now = isoNow();
      for (const dataset of control.datasets) {
        const ref = `${dataset.id}@${dataset.version}`;
        const publicJson = { ...dataset, sha256: undefined };
        this.db.prepare(`INSERT OR IGNORE INTO dataset_versions(
          dataset_ref,dataset_id,version,level,classification,public_json,public_hash,private_hash,status,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
          ref, dataset.id, dataset.version, dataset.level, dataset.classification,
          stableStringify(publicJson), sha256(publicJson), privateLabelHash, "FROZEN", now,
        );
      }
      for (const item of control.cases) {
        this.db.prepare(`INSERT OR IGNORE INTO case_versions(
          case_ref,case_id,version,dataset_ref,public_json,runtime_json,metadata_json,
          public_hash,runtime_hash,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
          item.key, item.public.id, item.public.version, item.dataset_ref,
          stableStringify(item.public), stableStringify(item.runtime), stableStringify(item.metadata),
          sha256(item.public), sha256(item.runtime), now,
        );
      }
      for (const suite of control.suites) {
        const ref = `${suite.id}@${suite.version}`;
        this.db.prepare(`INSERT OR IGNORE INTO suite_versions(
          suite_ref,suite_id,version,suite_type,definition_json,definition_hash,created_at
        ) VALUES(?,?,?,?,?,?,?)`).run(
          ref, suite.id, suite.version, suite.type, stableStringify(suite), sha256(suite), now,
        );
      }
      return { registry_hash: control.sha256, private_label_hash: privateLabelHash };
    });
  }

  registerGraderSpec({ id, version, type, definition, status = "CALIBRATING" }) {
    const ref = `${id}@${version}`;
    this.db.prepare(`INSERT OR IGNORE INTO grader_specs(
      grader_ref,grader_id,version,grader_type,definition_json,definition_hash,status,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(ref, id, version, type, stableStringify(definition), sha256(definition), status, isoNow());
    return this.db.prepare("SELECT * FROM grader_specs WHERE grader_ref=?").get(ref);
  }

  listDatasets() {
    return this.db.prepare("SELECT dataset_ref,dataset_id,version,level,classification,public_hash,status,created_at FROM dataset_versions ORDER BY created_at").all();
  }

  listSuites() {
    return this.db.prepare("SELECT * FROM suite_versions ORDER BY created_at").all().map((row) => ({ ...row, definition: parseJson(row.definition_json, {}) }));
  }

  listCases() {
    return this.db.prepare("SELECT case_ref,case_id,version,dataset_ref,public_json,metadata_json,public_hash FROM case_versions ORDER BY case_id").all().map((row) => ({
      ...row, public: parseJson(row.public_json, {}), metadata: parseJson(row.metadata_json, {}),
    }));
  }

  getExecutionCase(caseRef) {
    const row = this.db.prepare("SELECT public_json,runtime_json FROM case_versions WHERE case_ref=?").get(caseRef);
    if (!row) return null;
    const visible = parseJson(row.public_json, {});
    const runtime = parseJson(row.runtime_json, {});
    return { ...visible, tools: runtime.tools, source: runtime.source, environment: runtime.environment };
  }

  getPublicCase(caseRef) {
    const row = this.db.prepare("SELECT public_json FROM case_versions WHERE case_ref=?").get(caseRef);
    return row ? parseJson(row.public_json, {}) : null;
  }

  createExperiment(manifest, idempotencyKey, { scheduleTrials = true } = {}) {
    manifestRefs(manifest);
    const manifestHash = sha256(manifest);
    const existing = this.db.prepare("SELECT * FROM experiments WHERE idempotency_key=?").get(idempotencyKey);
    if (existing) {
      if (existing.manifest_hash !== manifestHash) throw new Error("idempotency key reused with a different manifest");
      return { experiment: hydrateExperiment(existing), created: false };
    }
    if (!this.db.prepare("SELECT 1 FROM suite_versions WHERE suite_ref=?").get(manifest.suite_ref)) throw new Error("suite_ref is not frozen in the registry");
    if (!this.db.prepare("SELECT 1 FROM dataset_versions WHERE dataset_ref=?").get(manifest.dataset_ref)) throw new Error("dataset_ref is not frozen in the registry");
    const suite = parseJson(this.db.prepare("SELECT definition_json FROM suite_versions WHERE suite_ref=?").get(manifest.suite_ref)?.definition_json, {});
    for (const ref of manifest.case_refs) {
      const item = this.db.prepare("SELECT dataset_ref FROM case_versions WHERE case_ref=?").get(ref);
      if (!item) throw new Error(`case_ref is not frozen: ${ref}`);
      if (item.dataset_ref !== manifest.dataset_ref) throw new Error(`case_ref ${ref} does not belong to dataset_ref ${manifest.dataset_ref}`);
      if (!suite.case_refs?.includes(ref)) throw new Error(`case_ref ${ref} does not belong to suite_ref ${manifest.suite_ref}`);
    }

    return this.transaction(() => {
      const now = isoNow();
      const id = entityId("exp", `${idempotencyKey}:${manifestHash}`);
      this.db.prepare(`INSERT INTO experiments(
        id,name,status,idempotency_key,manifest_hash,manifest_json,suite_ref,dataset_ref,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        id, manifest.name, "QUEUED", idempotencyKey, manifestHash, stableStringify(manifest),
        manifest.suite_ref, manifest.dataset_ref, now, now,
      );

      const contestants = seededShuffle(manifest.contestants, seedFromString(`${id}:blind-map`));
      const blindLabels = ["candidate-amber", "candidate-cobalt"].slice(0, contestants.length);
      contestants.forEach((contestant, index) => this.db.prepare(`INSERT INTO contestant_blinds(
        experiment_id,blind_id,contestant_ref,display_order
      ) VALUES(?,?,?,?)`).run(id, blindLabels[index], contestant.ref, index + 1));
      const blinds = this.listBlinds(id);
      if (!scheduleTrials) return { experiment: this.getExperiment(id), created: true };
      const pairs = manifest.case_refs.flatMap((caseRef) => manifest.environment_seeds.flatMap((environmentSeed) =>
        Array.from({ length: manifest.replicates_per_seed }, (_, index) => ({ caseRef, environmentSeed, replicateId: index + 1 }))));
      const scheduled = seededShuffle(pairs, seedFromString(`${id}:pair-order`));
      let runOrder = 1;
      for (const pair of scheduled) {
        const orderedBlinds = seededShuffle(blinds, seedFromString(`${id}:${pair.caseRef}:s${pair.environmentSeed}:r${pair.replicateId}:ab-order`));
        for (const blind of orderedBlinds) {
          const key = `${id}:${pair.caseRef}:s${pair.environmentSeed}:r${pair.replicateId}:${blind.blind_id}`;
          const trialId = entityId("trial", key);
          const namespace = path.join(this.runtimeRoot, "experiments", id, "trials", trialId);
          this.db.prepare(`INSERT INTO trials(
            id,idempotency_key,experiment_id,case_ref,environment_seed,replicate_id,blind_id,contestant_ref,
            run_order,trial_kind,status,namespace,budget_json,created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            trialId, key, id, pair.caseRef, pair.environmentSeed, pair.replicateId,
            blind.blind_id, blind.contestant_ref, runOrder, "PRIMARY", "QUEUED", namespace,
            stableStringify(trialSettlementBudget(manifest, blind.contestant_ref)), now,
          );
          runOrder += 1;
        }
      }
      return { experiment: this.getExperiment(id), created: true };
    });
  }

  getExperiment(id) { return hydrateExperiment(this.db.prepare("SELECT * FROM experiments WHERE id=?").get(id)); }
  listExperiments() { return this.db.prepare("SELECT * FROM experiments ORDER BY created_at DESC").all().map(hydrateExperiment); }
  listBlinds(experimentId) { return this.db.prepare("SELECT * FROM contestant_blinds WHERE experiment_id=? ORDER BY display_order").all(experimentId); }

  revealContestant(experimentId, blindId, authorized = false) {
    if (!authorized) throw new Error("blind identity reveal requires authorized=true");
    return this.db.prepare("SELECT contestant_ref FROM contestant_blinds WHERE experiment_id=? AND blind_id=?").get(experimentId, blindId)?.contestant_ref;
  }

  setExperimentStatus(id, status) {
    const now = isoNow();
    this.db.prepare(`UPDATE experiments SET status=?,updated_at=?,started_at=COALESCE(started_at,?),
      completed_at=COALESCE(?,completed_at) WHERE id=?`).run(
      status, now, status === "RUNNING" ? now : null, ["COMPLETED", "FAILED", "CANCELLED"].includes(status) ? now : null, id,
    );
  }

  listTrials(experimentId = null, { includeReplays = true } = {}) {
    const filters = [], params = [];
    if (experimentId) { filters.push("t.experiment_id=?"); params.push(experimentId); }
    if (!includeReplays) filters.push("t.trial_kind='PRIMARY'");
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return this.db.prepare(`${trialSelect(where)} ORDER BY t.run_order,t.created_at`).all(...params).map(hydrateTrial);
  }

  getTrial(id) { return hydrateTrial(this.db.prepare(trialSelect("WHERE t.id=?")).get(id)); }

  recoverExpiredLeases(now = isoNow()) {
    const rows = this.db.prepare(`SELECT id,attempt,cancel_requested_at,cancel_reason FROM trials
      WHERE status='RUNNING' AND lease_expires_at<?`).all(now);
    if (!rows.length) return [];
    return this.transaction(() => {
      for (const row of rows) {
        const cancelled = Boolean(row.cancel_requested_at);
        const status = cancelled ? "CANCELLED" : "INTERRUPTED";
        const error = cancelled ? (row.cancel_reason ?? "operator cancellation observed during lease recovery")
          : "runner lease expired before an immutable result was recorded";
        const usage = {};
        const finalState = { recovery: { reason: "expired_runner_lease", resumable: !cancelled,
          recovered_at: now }, cancellation_requested_at: row.cancel_requested_at ?? null };
        const traceHash = this.traceSemanticHash(row.id);
        const result = { status, error, usage, final_state: finalState, trace_hash: traceHash };
        const resultHash = sha256(result);
        this.db.prepare(`INSERT OR IGNORE INTO trial_attempt_results(
          id,trial_id,attempt,status,error,outcome_json,usage_json,final_state_json,trace_hash,result_hash,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
          entityId("attempt-result", `${row.id}:${row.attempt}:${resultHash}`), row.id, row.attempt, status, error,
          null, stableStringify(usage), stableStringify(finalState), traceHash, resultHash, now,
        );
        if (cancelled) {
          this.db.prepare(`UPDATE trials SET status='CANCELLED',error=?,completed_at=?,lease_owner=NULL,lease_expires_at=NULL
            WHERE id=? AND status='RUNNING'`).run(error, now, row.id);
        } else {
          this.db.prepare(`UPDATE trials SET status='QUEUED',lease_owner=NULL,lease_expires_at=NULL,error=?
            WHERE id=? AND status='RUNNING'`).run(error, row.id);
        }
      }
      return rows.map((row) => row.id);
    });
  }

  claimNext(workerId, leaseMs = 30000, experimentId = null) {
    this.recoverExpiredLeases();
    return this.transaction(() => {
      const row = experimentId
        ? this.db.prepare("SELECT id FROM trials WHERE status='QUEUED' AND experiment_id=? ORDER BY run_order,created_at LIMIT 1").get(experimentId)
        : this.db.prepare("SELECT id FROM trials WHERE status='QUEUED' ORDER BY run_order,created_at LIMIT 1").get();
      if (!row) return null;
      const now = isoNow();
      const expires = new Date(Date.now() + leaseMs).toISOString();
      this.db.prepare(`UPDATE trials SET status='RUNNING',lease_owner=?,lease_expires_at=?,attempt=attempt+1,
        started_at=COALESCE(started_at,?),error=NULL WHERE id=? AND status='QUEUED'`).run(workerId, expires, now, row.id);
      return this.getTrial(row.id);
    });
  }

  heartbeat(trialId, workerId, leaseMs = 30000) {
    const result = this.db.prepare("UPDATE trials SET lease_expires_at=? WHERE id=? AND status='RUNNING' AND lease_owner=?").run(
      new Date(Date.now() + leaseMs).toISOString(), trialId, workerId,
    );
    if (result.changes !== 1) throw new Error(`trial lease lost: ${trialId}`);
  }

  isTrialCancellationRequested(trialId) {
    const row = this.db.prepare("SELECT cancel_requested_at,cancel_reason FROM trials WHERE id=?").get(trialId);
    return { requested: Boolean(row?.cancel_requested_at), requested_at: row?.cancel_requested_at ?? null,
      reason: row?.cancel_reason ?? null };
  }

  forceExpireLease(trialId) { this.db.prepare("UPDATE trials SET lease_expires_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", trialId); }

  appendTraceRecord(trialId, { recordType, spanId, parentSpanId = null, name, spanKind, actor, status = null, payload = {} }) {
    return this.transaction(() => {
      const seq = Number(this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM trace_records WHERE trial_id=?").get(trialId).seq);
      const sanitized = redact(payload);
      const payloadHash = sha256(sanitized.value);
      const timestamp = isoNow();
      const traceId = entityId("trace", trialId);
      const recordId = entityId("tr", `${trialId}:${seq}:${recordType}:${spanId}:${payloadHash}`);
      const result = this.db.prepare(`INSERT INTO trace_records(
        record_id,trial_id,trace_id,seq,timestamp,record_type,span_id,parent_span_id,name,span_kind,actor,status,
        payload_json,payload_hash,redacted
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        recordId, trialId, traceId, seq, timestamp, recordType, spanId, parentSpanId, name, spanKind, actor, status,
        stableStringify(sanitized.value), payloadHash, sanitized.changed ? 1 : 0,
      );
      return { row_id: Number(result.lastInsertRowid), record_id: recordId, trial_id: trialId, trace_id: traceId, seq, timestamp,
        record_type: recordType, span_id: spanId, parent_span_id: parentSpanId, name, span_kind: spanKind, actor, status,
        payload: sanitized.value, payload_hash: payloadHash, redacted: sanitized.changed };
    });
  }

  startSpan(trialId, name, spanKind, actor, payload = {}, parentSpanId = null) {
    const spanId = entityId("span", `${trialId}:${name}:${isoNow()}:${Math.random()}`);
    this.appendTraceRecord(trialId, { recordType: "SPAN_START", spanId, parentSpanId, name, spanKind, actor, payload });
    return spanId;
  }

  addSpanEvent(trialId, spanId, name, actor, payload = {}, spanKind = "INTERNAL") {
    return this.appendTraceRecord(trialId, { recordType: "SPAN_EVENT", spanId, name, spanKind, actor, payload });
  }

  endSpan(trialId, spanId, name, spanKind, actor, status, payload = {}) {
    return this.appendTraceRecord(trialId, { recordType: "SPAN_END", spanId, name, spanKind, actor, status, payload });
  }

  getTrace(trialId, { after = 0, limit = null } = {}) {
    const rows = limit === null
      ? this.db.prepare("SELECT * FROM trace_records WHERE trial_id=? AND row_id>? ORDER BY row_id").all(trialId, after)
      : this.db.prepare("SELECT * FROM trace_records WHERE trial_id=? AND row_id>? ORDER BY row_id LIMIT ?").all(trialId, after, limit);
    return rows.map((row) => ({
      ...row, payload: parseJson(row.payload_json, {}), redacted: Boolean(row.redacted),
    }));
  }

  countTraceRecords(trialId) {
    return Number(this.db.prepare("SELECT COUNT(*) count FROM trace_records WHERE trial_id=?").get(trialId).count);
  }

  traceSemanticHash(trialId) {
    return sha256(this.getTrace(trialId).map(({ seq, record_type, name, span_kind, actor, status, payload, redacted }) => ({
      seq, record_type, name, span_kind, actor, status, payload, redacted,
    })));
  }

  completeTrial(trialId, { usage, outcome, finalState = {}, traceHash }) {
    const result = { outcome, usage, final_state: finalState, trace_hash: traceHash };
    const resultHash = sha256(result);
    this.transaction(() => {
      const attempt = Number(this.db.prepare("SELECT attempt FROM trials WHERE id=?").get(trialId)?.attempt ?? 0);
      const now = isoNow();
      this.db.prepare(`INSERT INTO trial_results(id,trial_id,outcome_json,usage_json,final_state_json,trace_hash,result_hash,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(entityId("result", `${trialId}:${resultHash}`), trialId, stableStringify(outcome), stableStringify(usage),
        stableStringify(finalState), traceHash, resultHash, now);
      this.db.prepare(`INSERT INTO trial_attempt_results(
        id,trial_id,attempt,status,error,outcome_json,usage_json,final_state_json,trace_hash,result_hash,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        entityId("attempt-result", `${trialId}:${attempt}:${resultHash}`), trialId, attempt, "COMPLETED", null,
        stableStringify(outcome), stableStringify(usage), stableStringify(finalState), traceHash, resultHash, now,
      );
      this.db.prepare("UPDATE trials SET status='COMPLETED',completed_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?").run(now, trialId);
    });
  }

  failTrial(trialId, error, { usage = {}, finalState = {}, traceHash = null } = {}) {
    const normalizedError = String(error);
    const stableTraceHash = traceHash ?? sha256([]);
    const result = { status: "FAILED", error: normalizedError, usage, final_state: finalState, trace_hash: stableTraceHash };
    const resultHash = sha256(result);
    this.transaction(() => {
      const attempt = Number(this.db.prepare("SELECT attempt FROM trials WHERE id=?").get(trialId)?.attempt ?? 0);
      const now = isoNow();
      this.db.prepare(`INSERT INTO trial_attempt_results(
        id,trial_id,attempt,status,error,outcome_json,usage_json,final_state_json,trace_hash,result_hash,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        entityId("attempt-result", `${trialId}:${attempt}:${resultHash}`), trialId, attempt, "FAILED", normalizedError,
        null, stableStringify(usage), stableStringify(finalState), stableTraceHash, resultHash, now,
      );
      this.db.prepare("UPDATE trials SET status='FAILED',error=?,completed_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?")
        .run(normalizedError, now, trialId);
    });
  }

  cancelTrial(trialId, reason, { usage = {}, finalState = {}, traceHash = null } = {}) {
    const normalizedReason = String(reason || "evaluation cancelled");
    const stableTraceHash = traceHash ?? sha256([]);
    const result = { status: "CANCELLED", error: normalizedReason, usage, final_state: finalState,
      trace_hash: stableTraceHash };
    const resultHash = sha256(result);
    this.transaction(() => {
      const current = this.db.prepare("SELECT status,attempt FROM trials WHERE id=?").get(trialId);
      if (!current || current.status !== "RUNNING") throw new Error(`only a running trial may be cancelled: ${trialId}`);
      const now = isoNow();
      this.db.prepare(`INSERT INTO trial_attempt_results(
        id,trial_id,attempt,status,error,outcome_json,usage_json,final_state_json,trace_hash,result_hash,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        entityId("attempt-result", `${trialId}:${current.attempt}:${resultHash}`), trialId, current.attempt, "CANCELLED",
        normalizedReason, null, stableStringify(usage), stableStringify(finalState), stableTraceHash, resultHash, now,
      );
      this.db.prepare(`UPDATE trials SET status='CANCELLED',error=?,completed_at=?,lease_owner=NULL,lease_expires_at=NULL
        WHERE id=? AND status='RUNNING'`).run(normalizedReason, now, trialId);
    });
  }

  listTrialAttemptResults(trialId = null) {
    const rows = trialId === null
      ? this.db.prepare("SELECT * FROM trial_attempt_results ORDER BY trial_id,attempt,created_at").all()
      : this.db.prepare("SELECT * FROM trial_attempt_results WHERE trial_id=? ORDER BY attempt,created_at").all(trialId);
    return rows.map((row) => ({ ...row, outcome: parseJson(row.outcome_json, null), usage: parseJson(row.usage_json, {}),
      final_state: parseJson(row.final_state_json, {}) }));
  }

  recordTrialCleanupReconciliation({ trialId, attempt, candidateRunRef, candidateTerminalStatus,
    twinReset, status, error = null, evidence = {} }) {
    if (!trialId || !this.getTrial(trialId)) throw new Error("cleanup reconciliation requires an existing trial");
    if (!Number.isInteger(Number(attempt)) || Number(attempt) < 1) throw new Error("cleanup reconciliation requires a positive attempt");
    if (!candidateRunRef) throw new Error("cleanup reconciliation requires the exact candidate run reference");
    if (!new Set(["RESOLVED", "FAILED"]).has(status)) throw new Error("cleanup reconciliation status must be RESOLVED or FAILED");
    const canonical = { trial_id: trialId, attempt: Number(attempt), candidate_run_ref: String(candidateRunRef),
      candidate_terminal_status: candidateTerminalStatus ? String(candidateTerminalStatus) : null,
      twin_reset: twinReset ?? {}, status, error: error ? String(error) : null, evidence };
    const recordHash = sha256(canonical);
    const id = entityId("cleanup-reconciliation", `${trialId}:${attempt}:${status}:${recordHash}`);
    const createdAt = isoNow();
    this.db.prepare(`INSERT OR IGNORE INTO trial_cleanup_reconciliations(
      id,trial_id,attempt,candidate_run_ref,candidate_terminal_status,twin_reset_json,status,error,evidence_json,record_hash,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, trialId, Number(attempt), String(candidateRunRef), canonical.candidate_terminal_status,
      stableStringify(canonical.twin_reset), status, canonical.error, stableStringify(evidence), recordHash, createdAt,
    );
    return this.listTrialCleanupReconciliations(trialId).find((item) => item.id === id);
  }

  listTrialCleanupReconciliations(trialId = null) {
    const rows = trialId === null
      ? this.db.prepare("SELECT * FROM trial_cleanup_reconciliations ORDER BY trial_id,attempt,created_at").all()
      : this.db.prepare("SELECT * FROM trial_cleanup_reconciliations WHERE trial_id=? ORDER BY attempt,created_at").all(trialId);
    return rows.map((row) => ({ ...row, twin_reset: parseJson(row.twin_reset_json, {}),
      evidence: parseJson(row.evidence_json, {}) }));
  }

  retryFailedTrial(trialId, { maxRetries, allowedCategories, reason = "frozen infrastructure retry policy" }) {
    const current = this.getTrial(trialId);
    if (!current || current.status !== "FAILED") throw new Error(`only FAILED trial can be retried: ${trialId}`);
    const retryLimit = Number(maxRetries);
    if (!Number.isInteger(retryLimit) || retryLimit < 0) throw new Error("a non-negative frozen retry limit is required");
    const latestAttempt = this.listTrialAttemptResults(trialId).at(-1);
    const failure = latestAttempt?.final_state?.failure_classification;
    if (!failure?.retryable || !failure.policy_code) throw new Error(`trial failure is not retryable: ${failure?.category ?? "unclassified"}`);
    if (!Array.isArray(allowedCategories) || !allowedCategories.includes(failure.policy_code)) {
      throw new Error(`trial failure is outside frozen retry categories: ${failure.policy_code}`);
    }
    if (current.attempt > retryLimit) throw new Error(`trial retry limit reached: ${trialId}`);
    this.db.prepare(`UPDATE trials SET status='QUEUED',error=?,completed_at=NULL,cancel_requested_at=NULL,cancel_reason=NULL
      WHERE id=?`).run(`scheduled infrastructure retry (${failure.policy_code}): ${reason}`, trialId);
    return this.getTrial(trialId);
  }

  addArtifact(trialId, kind, artifactPath, digest, sizeBytes) {
    const id = entityId("artifact", `${trialId}:${kind}:${digest}`);
    this.db.prepare("INSERT OR IGNORE INTO artifacts(id,trial_id,kind,path,sha256,size_bytes,created_at) VALUES(?,?,?,?,?,?,?)").run(
      id, trialId, kind, artifactPath, digest, sizeBytes, isoNow(),
    );
    return id;
  }

  addGraderRun(trialId, { graderRef, graderType = "code", dimension = "overall", result }) {
    const resultHash = sha256(result);
    const id = entityId("grader", `${trialId}:${graderRef}:${dimension}:${resultHash}`);
    this.db.prepare(`INSERT INTO grader_runs(id,trial_id,grader_ref,grader_type,dimension,result_json,result_hash,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, trialId, graderRef, graderType, dimension, stableStringify(result), resultHash, isoNow());
    return { id, trial_id: trialId, grader_ref: graderRef, grader_type: graderType, dimension, result, result_hash: resultHash };
  }

  listGraderRuns(trialId = null) {
    const rows = trialId ? this.db.prepare("SELECT * FROM grader_runs WHERE trial_id=? ORDER BY created_at").all(trialId)
      : this.db.prepare("SELECT * FROM grader_runs ORDER BY created_at").all();
    return rows.map((row) => ({ ...row, result: parseJson(row.result_json, {}) }));
  }

  addJudgeRun(trialId, { blindId, role, model, judgeRef, promptHash, result }) {
    const resultHash = sha256(result);
    const id = entityId("judge", `${trialId}:${role}:${judgeRef}:${resultHash}`);
    this.db.prepare(`INSERT INTO judge_runs(id,trial_id,blind_id,judge_role,judge_model,judge_ref,prompt_hash,result_json,result_hash,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, trialId, blindId, role, model, judgeRef, promptHash, stableStringify(result), resultHash, isoNow());
    return { id, result };
  }

  listJudgeRuns(trialId = null) {
    const rows = trialId ? this.db.prepare("SELECT * FROM judge_runs WHERE trial_id=? ORDER BY judge_role").all(trialId)
      : this.db.prepare("SELECT * FROM judge_runs ORDER BY created_at").all();
    return rows.map((row) => ({ ...row, result: parseJson(row.result_json, {}) }));
  }

  registerSourceSnapshot({ contestantRef, sourceRevision, artifactDigest, treeHash, storagePath, files }) {
    if (!contestantRef || !sourceRevision || !artifactDigest || !treeHash || !storagePath || !Array.isArray(files)) {
      throw new Error("complete frozen source snapshot metadata is required");
    }
    const snapshotRef = `source:${contestantRef}:${treeHash}`;
    const sizeBytes = files.reduce((sum, file) => sum + Number(file.size_bytes ?? 0), 0);
    this.db.prepare(`INSERT OR IGNORE INTO source_snapshots(
      snapshot_ref,contestant_ref,source_revision,artifact_digest,tree_hash,storage_path,file_count,size_bytes,manifest_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      snapshotRef, contestantRef, sourceRevision, artifactDigest, treeHash, path.resolve(storagePath), files.length,
      sizeBytes, stableStringify({ contract: "evalos-source-snapshot.1", files }), isoNow(),
    );
    return this.getSourceSnapshot(snapshotRef);
  }

  getSourceSnapshot(snapshotRef) {
    const row = this.db.prepare("SELECT * FROM source_snapshots WHERE snapshot_ref=?").get(snapshotRef);
    return row ? { ...row, manifest: parseJson(row.manifest_json, {}) } : null;
  }

  listSourceSnapshots() {
    return this.db.prepare("SELECT * FROM source_snapshots ORDER BY created_at DESC").all()
      .map((row) => ({ ...row, manifest: parseJson(row.manifest_json, {}) }));
  }

  attachTrialSourceSnapshot(trialId, snapshotRef) {
    if (!this.getTrial(trialId)) throw new Error(`trial not found: ${trialId}`);
    if (!this.getSourceSnapshot(snapshotRef)) throw new Error(`source snapshot not found: ${snapshotRef}`);
    this.db.prepare("INSERT OR IGNORE INTO trial_source_snapshots(trial_id,snapshot_ref,attached_at) VALUES(?,?,?)")
      .run(trialId, snapshotRef, isoNow());
    const existing = this.db.prepare("SELECT snapshot_ref FROM trial_source_snapshots WHERE trial_id=?").get(trialId);
    if (existing.snapshot_ref !== snapshotRef) throw new Error("trial is already bound to a different immutable source snapshot");
    return this.getTrialSourceSnapshot(trialId);
  }

  getTrialSourceSnapshot(trialId) {
    const row = this.db.prepare(`SELECT s.* FROM source_snapshots s JOIN trial_source_snapshots b
      ON b.snapshot_ref=s.snapshot_ref WHERE b.trial_id=?`).get(trialId);
    return row ? { ...row, manifest: parseJson(row.manifest_json, {}) } : null;
  }

  createAnalysisRun({ trialId, idempotencyKey, requestedBy = "evalos-operator", prompt,
    mode = "case_diagnosis", model = "deepseek-v4-flash", sourceSnapshotRef = null, budget = {} }) {
    if (!this.getTrial(trialId)) throw new Error(`trial not found: ${trialId}`);
    if (!idempotencyKey || !prompt) throw new Error("analysis idempotency key and prompt are required");
    if (!new Set(["case_diagnosis", "score_explanation", "optimization_research"]).has(mode)) throw new Error("invalid analysis mode");
    const existing = this.db.prepare("SELECT id,trial_id,prompt FROM analysis_runs WHERE idempotency_key=?").get(idempotencyKey);
    if (existing) {
      if (existing.trial_id !== trialId || existing.prompt !== prompt) throw new Error("analysis idempotency key reused with different input");
      return { analysis: this.getAnalysisRun(existing.id), created: false };
    }
    if (sourceSnapshotRef && !this.getSourceSnapshot(sourceSnapshotRef)) throw new Error("analysis source snapshot is not frozen");
    const now = isoNow();
    const id = entityId("analysis", `${trialId}:${idempotencyKey}:${sha256(prompt)}`);
    this.db.prepare(`INSERT INTO analysis_runs(
      id,idempotency_key,trial_id,source_snapshot_ref,requested_by,prompt,mode,status,sdk,model,budget_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, idempotencyKey, trialId, sourceSnapshotRef, requestedBy, prompt, mode, "QUEUED",
      "@anthropic-ai/claude-agent-sdk", model, stableStringify(budget), now,
    );
    return { analysis: this.getAnalysisRun(id), created: true };
  }

  startAnalysisRun(id) {
    const now = isoNow();
    const changed = this.db.prepare(`UPDATE analysis_runs SET status='RUNNING',attempt=attempt+1,
      started_at=COALESCE(started_at,?),error=NULL WHERE id=? AND status='QUEUED'`).run(now, id);
    if (changed.changes !== 1) throw new Error(`analysis is not queued: ${id}`);
    return this.getAnalysisRun(id);
  }

  appendAnalysisEvent(analysisRunId, { eventType, actor, payload = {} }) {
    return this.transaction(() => {
      const run = this.db.prepare("SELECT status FROM analysis_runs WHERE id=?").get(analysisRunId);
      if (!run || run.status !== "RUNNING") throw new Error("analysis events may be appended only while the run is active");
      const seq = Number(this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM analysis_events WHERE analysis_run_id=?")
        .get(analysisRunId).seq);
      const sanitized = redact(payload);
      const payloadHash = sha256(sanitized.value);
      const timestamp = isoNow();
      const eventId = entityId("analysis-event", `${analysisRunId}:${seq}:${eventType}:${payloadHash}`);
      const inserted = this.db.prepare(`INSERT INTO analysis_events(
        event_id,analysis_run_id,seq,timestamp,event_type,actor,payload_json,payload_hash,redacted
      ) VALUES(?,?,?,?,?,?,?,?,?)`).run(eventId, analysisRunId, seq, timestamp, eventType, actor,
        stableStringify(sanitized.value), payloadHash, sanitized.changed ? 1 : 0);
      return { row_id: Number(inserted.lastInsertRowid), event_id: eventId, analysis_run_id: analysisRunId, seq,
        timestamp, event_type: eventType, actor, payload: sanitized.value, payload_hash: payloadHash,
        redacted: sanitized.changed };
    });
  }

  addAnalysisSource(analysisRunId, { sourceKind, uri, title, digest, metadata = {} }) {
    const id = entityId("analysis-source", `${analysisRunId}:${sourceKind}:${uri}:${digest}`);
    this.db.prepare(`INSERT OR IGNORE INTO analysis_sources(
      id,analysis_run_id,source_kind,uri,title,accessed_at,sha256,metadata_json
    ) VALUES(?,?,?,?,?,?,?,?)`).run(id, analysisRunId, sourceKind, uri, title, isoNow(), digest, stableStringify(metadata));
    return id;
  }

  completeAnalysisRun(id, { result, usage = {} }) {
    const resultHash = sha256(result);
    this.transaction(() => {
      const run = this.db.prepare("SELECT status FROM analysis_runs WHERE id=?").get(id);
      if (!run || run.status !== "RUNNING") throw new Error("only a running analysis may complete");
      this.db.prepare(`INSERT INTO analysis_results(id,analysis_run_id,result_json,usage_json,result_hash,created_at)
        VALUES(?,?,?,?,?,?)`).run(entityId("analysis-result", `${id}:${resultHash}`), id, stableStringify(result),
        stableStringify(usage), resultHash, isoNow());
      for (const finding of result.issues ?? []) {
        const findingId = entityId("finding", `${id}:${finding.severity}:${finding.title}:${sha256(finding)}`);
        this.db.prepare(`INSERT INTO analysis_findings(
          id,analysis_run_id,severity,category,title,evidence_refs_json,recommendation,confidence,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`).run(findingId, id, finding.severity ?? "info", finding.category ?? "general",
          finding.title, stableStringify(finding.evidence_refs ?? []), finding.recommendation ?? "", Number(finding.confidence ?? 0), isoNow());
      }
      this.db.prepare("UPDATE analysis_runs SET status='COMPLETED',completed_at=?,error=NULL WHERE id=? AND status='RUNNING'")
        .run(isoNow(), id);
    });
    return this.getAnalysisRun(id);
  }

  failAnalysisRun(id, error) {
    this.db.prepare("UPDATE analysis_runs SET status='FAILED',error=?,completed_at=? WHERE id=? AND status IN ('QUEUED','RUNNING')")
      .run(String(error), isoNow(), id);
    return this.getAnalysisRun(id);
  }

  recoverInterruptedAnalyses() {
    const rows = this.db.prepare("SELECT id FROM analysis_runs WHERE status='RUNNING'").all();
    for (const row of rows) this.failAnalysisRun(row.id, "analysis process interrupted before an immutable result was recorded");
    return rows.map((row) => row.id);
  }

  getAnalysisRun(id) {
    const row = this.db.prepare(`SELECT a.*,r.result_json,r.usage_json,r.result_hash
      FROM analysis_runs a LEFT JOIN analysis_results r ON r.analysis_run_id=a.id WHERE a.id=?`).get(id);
    if (!row) return null;
    return { ...row, budget: parseJson(row.budget_json, {}), result: parseJson(row.result_json, null),
      usage: parseJson(row.usage_json, null) };
  }

  listAnalysisRuns(trialId = null) {
    const rows = trialId ? this.db.prepare("SELECT id FROM analysis_runs WHERE trial_id=? ORDER BY created_at DESC").all(trialId)
      : this.db.prepare("SELECT id FROM analysis_runs ORDER BY created_at DESC").all();
    return rows.map((row) => this.getAnalysisRun(row.id));
  }

  getAnalysisEvents(id, { after = 0, limit = 1000 } = {}) {
    return this.db.prepare("SELECT * FROM analysis_events WHERE analysis_run_id=? AND row_id>? ORDER BY row_id LIMIT ?")
      .all(id, after, limit).map((row) => {
        const { payload_json: _payloadJson, ...safe } = row;
        return { ...safe, payload: parseJson(row.payload_json, {}), redacted: Boolean(row.redacted) };
      });
  }

  listAnalysisSources(id) {
    return this.db.prepare("SELECT * FROM analysis_sources WHERE analysis_run_id=? ORDER BY accessed_at")
      .all(id).map((row) => ({ ...row, metadata: parseJson(row.metadata_json, {}) }));
  }

  listArtifacts(trialId = null) {
    return trialId ? this.db.prepare("SELECT * FROM artifacts WHERE trial_id=? ORDER BY created_at").all(trialId)
      : this.db.prepare("SELECT * FROM artifacts ORDER BY created_at").all();
  }

  registerReviewer({ id, displayName, role = "domain-expert", qualificationRef, verifiedBy, credential }) {
    if (!id || !displayName || !qualificationRef || !verifiedBy || !credential) {
      throw new Error("reviewer id, displayName, qualificationRef, verifiedBy and credential are required");
    }
    if (String(credential).length < 12) throw new Error("reviewer credential must contain at least 12 characters");
    const now = isoNow();
    this.db.prepare(`INSERT OR IGNORE INTO reviewers(
      id,display_name,role,qualification_ref,verified_by,verified_at,credential_hash,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      id, displayName, role, qualificationRef, verifiedBy, now, credentialDigest(credential), now,
    );
    return this.db.prepare(`SELECT id,display_name,role,qualification_ref,verified_by,verified_at,active,created_at
      FROM reviewers WHERE id=?`).get(id);
  }

  listReviewers() {
    return this.db.prepare(`SELECT id,display_name,role,qualification_ref,verified_by,verified_at,active,created_at
      FROM reviewers ORDER BY created_at`).all();
  }

  createHumanReviewTask(trialId, { rubricRef, reason, priority = "normal" }) {
    const key = `${trialId}:${rubricRef}:${reason}`;
    const id = entityId("review", key);
    this.db.prepare("INSERT OR IGNORE INTO human_review_tasks(id,trial_id,rubric_ref,reason,priority,created_at) VALUES(?,?,?,?,?,?)").run(
      id, trialId, rubricRef, reason, priority, isoNow(),
    );
    return this.db.prepare("SELECT * FROM human_review_tasks WHERE id=?").get(id);
  }

  assignReview(reviewTaskId, reviewerId, assignmentOrder) {
    if (![1, 2, 3].includes(Number(assignmentOrder))) throw new Error("assignment order must be 1, 2 or 3");
    const id = entityId("assignment", `${reviewTaskId}:${reviewerId}`);
    this.db.prepare("INSERT INTO review_assignments(id,review_task_id,reviewer_id,assignment_order,created_at) VALUES(?,?,?,?,?)").run(
      id, reviewTaskId, reviewerId, assignmentOrder, isoNow(),
    );
    return this.db.prepare("SELECT * FROM review_assignments WHERE id=?").get(id);
  }

  addHumanReviewDecision(reviewTaskId, { reviewerId, credential, verdict, dimensionLabels = {}, evidenceRefs = [], rationale }) {
    const reviewer = this.db.prepare("SELECT * FROM reviewers WHERE id=? AND active=1").get(reviewerId);
    if (!reviewer || !credentialMatches(credential, reviewer.credential_hash)) throw new Error("verified reviewer identity required");
    const assignment = this.db.prepare("SELECT assignment_order FROM review_assignments WHERE review_task_id=? AND reviewer_id=?")
      .get(reviewTaskId, reviewerId);
    if (!assignment) throw new Error("independent review assignment required");
    if (assignment.assignment_order === 3) {
      const existing = this.db.prepare(`SELECT d.verdict,d.dimension_labels_json,a.assignment_order
        FROM human_review_decisions d JOIN review_assignments a
        ON a.review_task_id=d.review_task_id AND a.reviewer_id=d.reviewer_id
        WHERE d.review_task_id=? AND a.assignment_order IN (1,2) ORDER BY a.assignment_order`).all(reviewTaskId);
      const disagreement = existing.length === 2 && (existing[0].verdict !== existing[1].verdict
        || existing[0].dimension_labels_json !== existing[1].dimension_labels_json);
      if (!disagreement) throw new Error("adjudicator may decide only after two independent reviewers disagree");
    }
    const requiredDimensions = ["outcome", "evidence", "trajectory"];
    if (["pass", "fail"].includes(verdict)) {
      if (!requiredDimensions.every((name) => ["pass", "fail"].includes(dimensionLabels[name]))
        || typeof dimensionLabels.safety_violation !== "boolean") {
        throw new Error("expert review labels require outcome/evidence/trajectory pass|fail and boolean safety_violation");
      }
    }
    const id = entityId("review-decision", `${reviewTaskId}:${reviewerId}:${verdict}:${sha256(dimensionLabels)}`);
    this.db.prepare(`INSERT INTO human_review_decisions(
      id,review_task_id,reviewer_id,verdict,dimension_labels_json,evidence_refs_json,rationale,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(id, reviewTaskId, reviewerId, verdict, stableStringify(dimensionLabels), stableStringify(evidenceRefs), rationale, isoNow());
    return this.db.prepare("SELECT * FROM human_review_decisions WHERE id=?").get(id);
  }

  verifyReviewAccess(reviewTaskId, reviewerId, credential) {
    const reviewer = this.db.prepare("SELECT * FROM reviewers WHERE id=? AND active=1").get(reviewerId);
    if (!reviewer || !credentialMatches(credential, reviewer.credential_hash)) return false;
    return Boolean(this.db.prepare("SELECT 1 FROM review_assignments WHERE review_task_id=? AND reviewer_id=?")
      .get(reviewTaskId, reviewerId));
  }

  getHumanReviewTask(reviewTaskId) {
    return this.db.prepare("SELECT * FROM human_review_tasks WHERE id=?").get(reviewTaskId) ?? null;
  }

  reviewConsensus(reviewTaskId) {
    const rows = this.db.prepare(`SELECT d.reviewer_id,d.verdict,d.dimension_labels_json,a.assignment_order
      FROM human_review_decisions d JOIN review_assignments a
      ON a.review_task_id=d.review_task_id AND a.reviewer_id=d.reviewer_id
      WHERE d.review_task_id=? ORDER BY a.assignment_order`).all(reviewTaskId)
      .map((row) => ({ ...row, dimension_labels: parseJson(row.dimension_labels_json, {}) }));
    const first = rows.find((row) => row.assignment_order === 1);
    const second = rows.find((row) => row.assignment_order === 2);
    if (!first || !second) return { review_task_id: reviewTaskId, reviewers: rows.length, required_reviewers: 2,
      status: "PENDING", verdict: null, dimension_labels: null };
    const initialAgree = first.verdict === second.verdict
      && stableStringify(first.dimension_labels) === stableStringify(second.dimension_labels);
    if (initialAgree) return { review_task_id: reviewTaskId, reviewers: rows.length, required_reviewers: 2,
      status: "AGREED", verdict: first.verdict, dimension_labels: first.dimension_labels };
    const adjudicator = rows.find((row) => row.assignment_order === 3);
    return { review_task_id: reviewTaskId, reviewers: rows.length, required_reviewers: 3,
      status: adjudicator ? "ADJUDICATED" : "ADJUDICATION_REQUIRED",
      verdict: adjudicator?.verdict ?? null, dimension_labels: adjudicator?.dimension_labels ?? null };
  }

  listHumanReviewTasks() {
    return this.db.prepare(`SELECT task.*,
      (SELECT COUNT(*) FROM human_review_decisions d WHERE d.review_task_id=task.id) AS decision_count
      FROM human_review_tasks task ORDER BY CASE task.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,task.created_at`).all();
  }

  addCalibrationRun({ judgeRef, datasetRef, metrics, passed }) {
    const id = entityId("calibration", `${judgeRef}:${datasetRef}:${sha256(metrics)}:${isoNow()}`);
    this.db.prepare("INSERT INTO calibration_runs(id,judge_ref,calibration_dataset_ref,sample_count,metrics_json,passed,created_at) VALUES(?,?,?,?,?,?,?)").run(
      id, judgeRef, datasetRef, Number(metrics.sample_count ?? 0), stableStringify(metrics), passed ? 1 : 0, isoNow(),
    );
    return id;
  }

  listCalibrationRuns() {
    return this.db.prepare("SELECT * FROM calibration_runs ORDER BY created_at DESC").all()
      .map((row) => ({ ...row, passed: Boolean(row.passed), metrics: parseJson(row.metrics_json, {}) }));
  }

  latestCalibration(judgeRef, datasetRef) {
    const row = this.db.prepare(`SELECT * FROM calibration_runs WHERE judge_ref=? AND calibration_dataset_ref=?
      ORDER BY created_at DESC LIMIT 1`).get(judgeRef, datasetRef);
    return row ? { ...row, passed: Boolean(row.passed), metrics: parseJson(row.metrics_json, {}) } : null;
  }

  calibrationSamples(judgeRef, datasetRef) {
    const tasks = this.db.prepare(`SELECT task.id,task.trial_id
      FROM human_review_tasks task JOIN trials t ON t.id=task.trial_id
      JOIN case_versions c ON c.case_ref=t.case_ref WHERE c.dataset_ref=? ORDER BY task.created_at`).all(datasetRef);
    const samples = [];
    for (const task of tasks) {
      const consensus = this.reviewConsensus(task.id);
      if (!["AGREED", "ADJUDICATED"].includes(consensus.status) || !["pass", "fail"].includes(consensus.verdict)) continue;
      const judges = this.listJudgeRuns(task.trial_id).filter((run) => run.judge_ref === judgeRef);
      if (!judges.length) continue;
      samples.push({ trial_id: task.trial_id, expert: consensus.dimension_labels,
        judges: Object.fromEntries(judges.map((run) => [run.judge_role, run.result])) });
    }
    return samples;
  }

  createReplay(sourceTrialId, replayIndex = 1) {
    const source = this.getTrial(sourceTrialId);
    if (!source) throw new Error(`source trial not found: ${sourceTrialId}`);
    const key = `replay:${sourceTrialId}:${replayIndex}`;
    const existing = this.db.prepare("SELECT id FROM trials WHERE idempotency_key=?").get(key);
    if (existing) return this.getTrial(existing.id);
    const id = entityId("replay", key);
    const namespace = path.join(this.runtimeRoot, "experiments", source.experiment_id, "replays", id);
    const nextOrder = Number(this.db.prepare("SELECT COALESCE(MAX(run_order),0)+1 AS value FROM trials").get().value);
    this.db.prepare(`INSERT INTO trials(
      id,idempotency_key,experiment_id,case_ref,environment_seed,replicate_id,blind_id,contestant_ref,run_order,
      trial_kind,replay_of,status,namespace,budget_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, key, source.experiment_id, source.case_ref, source.environment_seed, source.replicate_id,
      source.blind_id, source.contestant_ref, nextOrder, "REPLAY", sourceTrialId, "QUEUED", namespace,
      source.budget_json, isoNow(),
    );
    return this.getTrial(id);
  }

  createEvaluationRunRequest({ idempotencyKey, mode, sourceExperimentId, requestedBy, reason, selection, preflight }) {
    if (!idempotencyKey || !requestedBy || !reason) throw new Error("idempotency key, operator and reason are required");
    if (!new Set(["QUICK_VALIDATION", "TARGETED_REGRESSION", "CAPACITY_REHEARSAL", "FORMAL"]).has(mode)) {
      throw new Error("invalid evaluation run mode");
    }
    if (!this.getExperiment(sourceExperimentId)) throw new Error(`source experiment not found: ${sourceExperimentId}`);
    const requestBody = { mode, source_experiment_id: sourceExperimentId, requested_by: requestedBy, reason, selection, preflight };
    const requestHash = sha256(requestBody);
    const existing = this.db.prepare("SELECT * FROM evaluation_run_requests WHERE idempotency_key=?").get(idempotencyKey);
    if (existing) {
      if (existing.request_hash !== requestHash) throw new Error("run request idempotency key reused with different input");
      return { request: this.getEvaluationRunRequest(existing.id), created: false };
    }
    return this.transaction(() => {
      const now = isoNow();
      const id = entityId("eval-request", `${idempotencyKey}:${requestHash}`);
      this.db.prepare(`INSERT INTO evaluation_run_requests(
        id,idempotency_key,request_hash,mode,status,source_experiment_id,requested_by,reason,selection_json,preflight_json,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, idempotencyKey, requestHash, mode, "QUEUED", sourceExperimentId,
        requestedBy, reason, stableStringify(selection), stableStringify(preflight), now);
      const sourceTrials = this.listTrials(sourceExperimentId, { includeReplays: false });
      for (const caseRef of selection.case_refs) for (const contestantRef of selection.contestant_refs) {
        for (const environmentSeed of selection.environment_seeds) {
          for (let repeatIndex = 1; repeatIndex <= selection.repetitions; repeatIndex += 1) {
            const sourceTrial = [...sourceTrials].reverse().find((trial) => trial.case_ref === caseRef
              && trial.contestant_ref === contestantRef && trial.environment_seed === environmentSeed
              && trial.replicate_id === repeatIndex)
              ?? [...sourceTrials].reverse().find((trial) => trial.case_ref === caseRef
                && trial.contestant_ref === contestantRef && trial.environment_seed === environmentSeed)
              ?? null;
            const itemId = entityId("eval-item", `${id}:${caseRef}:${contestantRef}:s${environmentSeed}:r${repeatIndex}`);
            this.db.prepare(`INSERT INTO evaluation_run_items(
              id,request_id,case_ref,contestant_ref,environment_seed,repeat_index,source_trial_id,created_at
            ) VALUES(?,?,?,?,?,?,?,?)`).run(itemId, id, caseRef, contestantRef, environmentSeed,
              repeatIndex, sourceTrial?.id ?? null, now);
          }
        }
      }
      return { request: this.getEvaluationRunRequest(id), created: true };
    });
  }

  getEvaluationRunRequest(id) {
    const request = hydrateRunRequest(this.db.prepare("SELECT * FROM evaluation_run_requests WHERE id=?").get(id));
    if (!request) return null;
    const items = this.db.prepare(`SELECT * FROM evaluation_run_items WHERE request_id=?
      ORDER BY case_ref,contestant_ref,environment_seed,repeat_index`).all(id)
      .map((item) => ({ ...item, trial: item.trial_id ? this.getTrial(item.trial_id) : null }));
    return { ...request, items };
  }

  listEvaluationRunRequests() {
    return this.db.prepare("SELECT id FROM evaluation_run_requests ORDER BY created_at DESC").all()
      .map((row) => this.getEvaluationRunRequest(row.id));
  }

  startEvaluationRunRequest(id) {
    const now = isoNow();
    const changed = this.db.prepare(`UPDATE evaluation_run_requests SET status='RUNNING',started_at=?
      WHERE id=? AND status='QUEUED'`).run(now, id);
    if (changed.changes !== 1) throw new Error(`evaluation run request is not queued: ${id}`);
    return this.getEvaluationRunRequest(id);
  }

  bindEvaluationRunExperiment(id, experimentId) {
    const request = this.getEvaluationRunRequest(id);
    if (!request || request.status !== "RUNNING") throw new Error("running evaluation request is required");
    const trials = this.listTrials(experimentId, { includeReplays: false });
    this.transaction(() => {
      this.db.prepare("UPDATE evaluation_run_requests SET created_experiment_id=? WHERE id=? AND created_experiment_id IS NULL")
        .run(experimentId, id);
      for (const trial of trials) this.db.prepare(`UPDATE evaluation_run_items SET trial_id=? WHERE request_id=? AND case_ref=?
        AND contestant_ref=? AND environment_seed=? AND repeat_index=? AND trial_id IS NULL`).run(
          trial.id, id, trial.case_ref, trial.contestant_ref, trial.environment_seed, trial.replicate_id);
    });
    return this.getEvaluationRunRequest(id);
  }

  finishEvaluationRunRequest(id, status, error = null) {
    if (!new Set(["COMPLETED", "FAILED", "CANCELLED"]).has(status)) throw new Error("invalid terminal evaluation request status");
    this.db.prepare(`UPDATE evaluation_run_requests SET status=?,error=?,completed_at=?
      WHERE id=? AND status IN ('QUEUED','RUNNING')`).run(status, error ? String(error) : null, isoNow(), id);
    return this.getEvaluationRunRequest(id);
  }

  closeEvaluationRunAfterFailure(id, error = null) {
    const request = this.getEvaluationRunRequest(id);
    if (!request) throw new Error(`evaluation run request not found: ${id}`);
    if (["COMPLETED", "CANCELLED"].includes(request.status)) {
      return { request, cancelled_queued_trials: 0, cancelled_running_trials: 0,
        experiment_status_changed: false };
    }
    const failure = String(error ?? request.error ?? "evaluation request stopped after a terminal failure");
    const skippedReason = `评测任务在前序 Trial 失败后停止；本 Trial 未执行。根因：${failure}`;
    const now = isoNow();
    let cancelledQueued = 0;
    let cancelledRunning = 0;
    let experimentStatusChanged = false;
    this.transaction(() => {
      this.db.prepare(`UPDATE evaluation_run_requests SET status='FAILED',
        error=CASE WHEN error IS NULL OR error='' THEN ? ELSE error END,completed_at=COALESCE(completed_at,?)
        WHERE id=? AND status IN ('QUEUED','RUNNING','FAILED')`).run(failure, now, id);
      if (!request.created_experiment_id) return;
      cancelledQueued = this.db.prepare(`UPDATE trials SET status='CANCELLED',error=?,completed_at=?
        WHERE experiment_id=? AND status='QUEUED'`).run(skippedReason, now, request.created_experiment_id).changes;
      cancelledRunning = this.db.prepare(`UPDATE trials SET status='CANCELLED',error=?,completed_at=?,
        cancel_requested_at=COALESCE(cancel_requested_at,?),cancel_reason=COALESCE(cancel_reason,?)
        WHERE experiment_id=? AND status='RUNNING'`).run(
          skippedReason, now, now, skippedReason, request.created_experiment_id).changes;
      experimentStatusChanged = this.db.prepare(`UPDATE experiments SET status='FAILED',updated_at=?,
        completed_at=COALESCE(completed_at,?) WHERE id=? AND status NOT IN ('COMPLETED','CANCELLED','FAILED')`)
        .run(now, now, request.created_experiment_id).changes === 1;
    });
    return { request: this.getEvaluationRunRequest(id), cancelled_queued_trials: cancelledQueued,
      cancelled_running_trials: cancelledRunning, experiment_status_changed: experimentStatusChanged };
  }

  requestEvaluationRunCancellation(id, reason = "operator requested evaluation cancellation") {
    const request = this.getEvaluationRunRequest(id);
    if (!request || !["QUEUED", "RUNNING"].includes(request.status)) {
      throw new Error("only queued or running evaluation work may be cancelled");
    }
    let queuedTrials = 0;
    let runningTrials = 0;
    const now = isoNow();
    this.transaction(() => {
      this.db.prepare(`UPDATE evaluation_run_requests SET cancel_requested_at=?,cancel_reason=?
        WHERE id=? AND status IN ('QUEUED','RUNNING')`).run(now, reason, id);
      if (!request.created_experiment_id) {
        this.db.prepare(`UPDATE evaluation_run_requests SET status='CANCELLED',error=?,completed_at=?
          WHERE id=? AND status IN ('QUEUED','RUNNING')`).run(reason, now, id);
        return;
      }
      queuedTrials = this.db.prepare(`UPDATE trials SET status='CANCELLED',error=?,completed_at=?
        WHERE experiment_id=? AND status='QUEUED'`).run(reason, now, request.created_experiment_id).changes;
      runningTrials = this.db.prepare(`UPDATE trials SET cancel_requested_at=?,cancel_reason=?
        WHERE experiment_id=? AND status='RUNNING'`).run(now, reason, request.created_experiment_id).changes;
      if (runningTrials === 0) {
        this.db.prepare(`UPDATE evaluation_run_requests SET status='CANCELLED',error=?,completed_at=?
          WHERE id=? AND status='RUNNING'`).run(reason, now, id);
      }
    });
    return { request: this.getEvaluationRunRequest(id), cancelled_queued_trials: queuedTrials,
      cancellation_signalled_running_trials: runningTrials };
  }

  saveCaseSelectionSet({ name, datasetRef, caseRefs, requestedBy, reason }) {
    if (!name || !datasetRef || !Array.isArray(caseRefs) || !caseRefs.length || !requestedBy || !reason) {
      throw new Error("selection set name, dataset, cases, operator and reason are required");
    }
    const normalized = [...new Set(caseRefs)].sort();
    for (const caseRef of normalized) {
      const row = this.db.prepare("SELECT dataset_ref FROM case_versions WHERE case_ref=?").get(caseRef);
      if (!row || row.dataset_ref !== datasetRef) throw new Error(`case ${caseRef} does not belong to selection-set dataset`);
    }
    const definitionHash = sha256({ dataset_ref: datasetRef, case_refs: normalized });
    const id = entityId("case-set", `${name}:${definitionHash}`);
    this.db.prepare(`INSERT OR IGNORE INTO case_selection_sets(
      id,name,dataset_ref,case_refs_json,requested_by,reason,definition_hash,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(id, name, datasetRef, stableStringify(normalized), requestedBy, reason, definitionHash, isoNow());
    return this.db.prepare("SELECT * FROM case_selection_sets WHERE id=?").get(id);
  }

  listCaseSelectionSets() {
    return this.db.prepare("SELECT * FROM case_selection_sets ORDER BY created_at DESC").all()
      .map((row) => ({ ...row, case_refs: parseJson(row.case_refs_json, []) }));
  }

  addRegradeRequest({ trialId, requestedBy, reason, graderRef, originalGraderRunId, result }) {
    if (!trialId || !requestedBy || !reason || !graderRef || !result) throw new Error("trial, operator, reason, grader and result are required for regrade");
    const resultHash = sha256(result);
    const id = entityId("regrade", `${trialId}:${graderRef}:${requestedBy}:${reason}:${resultHash}:${isoNow()}`);
    this.db.prepare(`INSERT INTO regrade_requests(
      id,trial_id,requested_by,reason,grader_ref,original_grader_run_id,result_json,result_hash,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(id, trialId, requestedBy, reason, graderRef, originalGraderRunId,
      stableStringify(result), resultHash, isoNow());
    return this.getRegradeRequest(id);
  }

  getRegradeRequest(id) {
    const row = this.db.prepare("SELECT * FROM regrade_requests WHERE id=?").get(id);
    return row ? { ...row, result: parseJson(row.result_json, {}) } : null;
  }

  listRegradeRequests(trialId = null) {
    const rows = trialId ? this.db.prepare("SELECT id FROM regrade_requests WHERE trial_id=? ORDER BY created_at DESC").all(trialId)
      : this.db.prepare("SELECT id FROM regrade_requests ORDER BY created_at DESC").all();
    return rows.map((row) => this.getRegradeRequest(row.id));
  }

  experimentSummary(experimentId) {
    const trials = this.listTrials(experimentId);
    const primary = trials.filter((trial) => trial.trial_kind === "PRIMARY");
    const completed = primary.filter((trial) => trial.status === "COMPLETED");
    const terminal = primary.filter((trial) => ["COMPLETED", "FAILED", "CANCELLED"].includes(trial.status));
    const gradeRows = this.db.prepare(`SELECT g.result_json FROM grader_runs g JOIN trials t ON t.id=g.trial_id
      WHERE t.experiment_id=? AND t.trial_kind='PRIMARY' AND g.dimension='overall'`).all(experimentId);
    const scores = gradeRows.map((row) => Number(parseJson(row.result_json, {}).total ?? 0));
    return { experiment: this.getExperiment(experimentId), trial_count: primary.length, completed_trials: completed.length,
      terminal_trials: terminal.length,
      failed_trials: primary.filter((trial) => trial.status === "FAILED").length,
      cancelled_trials: primary.filter((trial) => trial.status === "CANCELLED").length,
      completion_rate: primary.length ? terminal.length / primary.length : 0,
      replay_count: trials.length - primary.length,
      average_score: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null };
  }
}
