import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CASES, EvalStore, PrivateLabelStore, buildEvaluationContract, createM15Registry } from "../src/index.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const v6 = JSON.parse(readFileSync(path.join(ROOT, "config", "m15-smoke.manifest.json"), "utf8"));

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-manifest-v7-"));
  const store = new EvalStore({ databasePath: path.join(root, "control.sqlite"), runtimeRoot: root,
    migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m15.sql"),
    migrationPaths: ["002_m25_workbench.sql", "003_m26_run_control.sql", "004_m31_candidate_relay.sql",
      "005_m31_seed_identity.sql", "006_m31_trial_attempt_audit.sql", "007_m32_run_resilience.sql",
      "008_m32_cleanup_reconciliation.sql"].map((name) => path.join(ROOT, "infra", "migrations", "sqlite", name)) });
  const labels = new PrivateLabelStore({ databasePath: path.join(root, "private", "labels.sqlite"),
    migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_private_labels.sql") });
  const registry = createM15Registry(CASES);
  store.publishRegistry(registry, { privateLabelHash: labels.publishRegistry(registry) });
  return { store, labels };
}

function manifestV7() {
  const item = structuredClone(v6);
  const caseRef = item.case_refs[0];
  item.manifest_version = "7.0";
  item.milestone = "M3.2";
  item.run_class = "REAL_CANDIDATE";
  item.evaluation_lane = "PRODUCT_RELIABILITY";
  item.design = "single_system_acceptance";
  item.case_refs = [caseRef];
  item.case_partitions = { public: [caseRef], hidden: [], safety: [], regression: [] };
  item.environment_seeds = [2026082501];
  item.replicates_per_seed = 1;
  item.contestants = [{ ...item.contestants[0], ref: "langgraph-v1", kind: "REAL_PRODUCT",
    architecture: "LANGGRAPH_PRODUCT", adapter_contract_version: "5.0",
    adapter_version: "candidate-adapter-5.0.0", binding_requirement: "PRODUCT_NATIVE_ACK",
    candidate_runtime: { contract_version: "1.0", models: [
      { provider: "deepseek", id: "deepseek-v4-flash", interface: "anthropic", thinking: "disabled",
        roles: ["reason", "tool_selection"] },
      { provider: "deepseek", id: "deepseek-v4-pro", interface: "openai-chat", thinking: "enabled",
        roles: ["revise", "adjudicate"] }], versions: { graph_version: "opsmind-langgraph:5.0.0",
      state_schema_version: "graph-state:5.0.0", model_version: "deepseek-v4-flash+deepseek-v4-pro" } } }];
  item.candidate_runtime_policy = { source: "candidate_public_api", allow_multi_model: true,
    hidden_case_fields: "opaque_digest_only", usage_accounting: "reported_with_explicit_unknowns" };
  item.frozen_dependencies.product_adapter_contract.ref = "evalos-candidate-adapter@5.0.0";
  return item;
}

function manifestV8() {
  const item = manifestV7();
  item.manifest_version = "8.0";
  const legacy = structuredClone(item.budget);
  delete item.budget;
  item.candidate_resource_contract = {
    contract_version: "evalos-candidate-open-resource/1.0",
    mode: "OPEN",
    policy: { candidate_limit_source: "product_public_maximum", limits_are_safety_fuses_only: true,
      usage_affects_score: false, efficiency_reporting_only: true, case_specific_limits_forbidden: true,
      cross_architecture_equal_limits_required: false },
    profiles: [{
      contestant_ref: item.contestants[0].ref,
      candidate_resources: { max_duration_seconds: legacy.wallclock_ms / 1000,
        max_model_calls: legacy.model_calls, max_tool_calls: legacy.tool_calls,
        max_tokens: legacy.input_tokens + legacy.output_tokens,
        max_cost_microunits: legacy.cost_usd * 1_000_000,
        max_result_bytes: legacy.storage_bytes },
      settlement_reserve: { ...legacy,
        input_tokens: legacy.input_tokens + legacy.output_tokens,
        output_tokens: legacy.input_tokens + legacy.output_tokens,
        wallclock_ms: legacy.wallclock_ms + 120000, cost_usd: legacy.cost_usd + 1 },
      enforcement: { max_duration_seconds: "enforced", max_model_calls: "enforced", max_tool_calls: "enforced",
        max_tokens: "enforced", max_cost_microunits: "observed_only", max_result_bytes: "enforced" },
      provenance: { status: "product_public_maximum", method: "candidate_public_runtime_contract",
        source_revision: item.contestants[0].source_revision,
        artifact_digest: item.contestants[0].artifact_digest,
        evidence_ref: "public-readiness:fixture" },
    }],
  };
  item.statistics_policy = { comparison_design: "independent_stratified", confidence_level: 0.95,
    cluster_by_case: true, report_failures: true, per_architecture_usage_reporting: true,
    resource_usage_affects_score: false };
  return item;
}

test("Manifest 7.0旁路接受多模型外部产品，同时Manifest 6.0历史合同仍可执行", () => {
  const { store, labels } = fixture();
  try {
    const oldExperiment = store.createExperiment(v6, "manifest-v6-still-executable", { scheduleTrials: false });
    assert.equal(oldExperiment.experiment.manifest.manifest_version, "6.0");
    const next = manifestV7();
    const created = store.createExperiment(next, "manifest-v7", { scheduleTrials: true });
    const trial = store.listTrials(created.experiment.id)[0];
    assert.equal(trial.contestant_ref, "langgraph-v1");
    const adapter = { id: "langgraph-v1", adapterVersion: "candidate-adapter-5.0.0",
      adapterContractVersion: "5.0", supportedEvaluationLanes: ["PRODUCT_RELIABILITY"] };
    const caseSpec = store.getExecutionCase(trial.case_ref);
    const contract = buildEvaluationContract({ experiment: created.experiment, trial, caseSpec, adapter });
    assert.equal(contract.adapter_contract_version, "5.0");
    assert.equal(contract.model.sdk, "@anthropic-ai/claude-agent-sdk");
    assert.deepEqual(contract.contestant.candidate_runtime.models.map((item) => item.id),
      ["deepseek-v4-flash", "deepseek-v4-pro"]);
    assert.equal(contract.contestant.binding_requirement, "PRODUCT_NATIVE_ACK");
  } finally { labels.close(); store.close(); }
});

test("Manifest 7.0拒绝把隐藏Case字段直传策略或Adapter 4.0伪装成新版", () => {
  const { store, labels } = fixture();
  try {
    const unsafe = manifestV7();
    unsafe.candidate_runtime_policy.hidden_case_fields = "raw";
    assert.throws(() => store.createExperiment(unsafe, "unsafe-v7"), /opaque blind fields/);
    const downgraded = manifestV7();
    downgraded.contestants[0].adapter_contract_version = "4.0";
    assert.throws(() => store.createExperiment(downgraded, "downgraded-v7"), /Adapter 5.0/);
  } finally { labels.close(); store.close(); }
});

test("Manifest 8.0为每套架构开放产品最大资源，并把安全熔断来源绑定到镜像", () => {
  const { store, labels } = fixture();
  try {
    const manifest = manifestV8();
    const created = store.createExperiment(manifest, "manifest-v8", { scheduleTrials: true });
    const trial = store.listTrials(created.experiment.id)[0];
    const profile = manifest.candidate_resource_contract.profiles[0];
    assert.deepEqual(trial.budget, profile.settlement_reserve);
    const adapter = { id: "langgraph-v1", adapterVersion: "candidate-adapter-5.0.0",
      adapterContractVersion: "5.0", supportedEvaluationLanes: ["PRODUCT_RELIABILITY"] };
    const contract = buildEvaluationContract({ experiment: created.experiment, trial,
      caseSpec: store.getExecutionCase(trial.case_ref), adapter });
    assert.deepEqual(contract.budget, profile.candidate_resources);
    assert.deepEqual(contract.settlement_budget, profile.settlement_reserve);
    assert.equal(contract.candidate_resource_contract.mode, "OPEN");
    assert.equal(contract.candidate_resource_contract.policy.usage_affects_score, false);
    assert.equal(contract.candidate_resource_contract.profile.provenance.status, "product_public_maximum");
  } finally { labels.close(); store.close(); }
});

test("Manifest 8.0拒绝平台收尾量低于产品最大资源、伪造来源或把用量用于评分", () => {
  const { store, labels } = fixture();
  try {
    const lowerSettlement = manifestV8();
    lowerSettlement.candidate_resource_contract.profiles[0].settlement_reserve.tool_calls =
      lowerSettlement.candidate_resource_contract.profiles[0].candidate_resources.max_tool_calls - 1;
    assert.throws(() => store.createExperiment(lowerSettlement, "v8-lower-settlement"),
      /settlement reserve cannot be lower/);
    const drift = manifestV8();
    drift.candidate_resource_contract.profiles[0].provenance.source_revision = "different-revision";
    assert.throws(() => store.createExperiment(drift, "v8-provenance-drift"), /bind the frozen contestant/);
    const scoreByUsage = manifestV8();
    scoreByUsage.candidate_resource_contract.policy.usage_affects_score = true;
    assert.throws(() => store.createExperiment(scoreByUsage, "v8-score-by-usage"),
      /open-resource policy is invalid/);
  } finally { labels.close(); store.close(); }
});
