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
