import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CASES, EvalStore, PrivateLabelStore, createM15Registry, freezeSourceSnapshot, materializeSnapshotView,
  readSnapshotFile, searchSnapshotFiles,
} from "../src/index.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

test("M2.5把不可变源码、只读分析轨迹和诊断结果绑定到已完成Trial", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-m25-"));
  const sourceRoot = path.join(root, "contestant");
  mkdirSync(path.join(sourceRoot, "src"), { recursive: true });
  writeFileSync(path.join(sourceRoot, "src", "agent.mjs"), "export const architecture = 'dynamic-agent-loop';\n", "utf8");
  writeFileSync(path.join(sourceRoot, ".env"), "DEEPSEEK_API_KEY=must-not-enter-snapshot\n", "utf8");
  const store = new EvalStore({ databasePath: path.join(root, "control.sqlite"), runtimeRoot: root,
    migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m15.sql"),
    migrationPaths: [path.join(ROOT, "infra", "migrations", "sqlite", "002_m25_workbench.sql")] });
  const labels = new PrivateLabelStore({ databasePath: path.join(root, "private", "labels.sqlite"),
    migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_private_labels.sql") });
  try {
    const registry = createM15Registry(CASES);
    store.publishRegistry(registry, { privateLabelHash: labels.publishRegistry(registry) });
    const base = JSON.parse(readFileSync(path.join(ROOT, "config", "m15-smoke.manifest.json"), "utf8"));
    const caseRef = "PILOT-REG-001@2.0.0";
    const manifest = { ...base, design: "single_system_acceptance", name: "M2.5 fixture",
      suite_ref: "m15-pilot-capability@2.0.0", dataset_ref: "m15-l1-agentic-cases@2.0.0",
      case_refs: [caseRef], case_partitions: { public: [caseRef], hidden: [], safety: [], regression: [] },
      environment_seeds: [25], replicates_per_seed: 1,
      contestants: [{ ...base.contestants[0], source_revision: "abc1234",
        artifact_digest: `sha256:${"a".repeat(64)}`, runtime_digest: `sha256:${"b".repeat(64)}` }],
      budget: { ...base.budget, tool_calls: 10, wallclock_ms: 1000 }, policy: { ...base.policy, allowed_tools: [] } };
    const experiment = store.createExperiment(manifest, "m25-fixture").experiment;
    const trial = store.listTrials(experiment.id)[0];
    store.completeTrial(trial.id, { usage: { tool_calls: 1 }, outcome: { status: "resolved", root_cause: "fixture",
      evidence_refs: [], exclusions: [] }, finalState: { reset: { clean: true } }, traceHash: "b".repeat(64) });
    store.setExperimentStatus(experiment.id, "COMPLETED");

    const frozen = freezeSourceSnapshot({ roots: [{ path: sourceRoot, prefix: "opsmind" }],
      storageRoot: path.join(root, "snapshots"), contestantRef: "agent-harness-v2", sourceRevision: "abc123",
      artifactDigest: `sha256:${"a".repeat(64)}` });
    assert.equal(frozen.files.some((file) => file.path.includes(".env")), false);
    const snapshot = store.registerSourceSnapshot({ contestantRef: "agent-harness-v2", sourceRevision: "abc123",
      artifactDigest: `sha256:${"a".repeat(64)}`, treeHash: frozen.tree_hash, storagePath: frozen.storage_path, files: frozen.files });
    store.attachTrialSourceSnapshot(trial.id, snapshot.snapshot_ref);
    assert.match(readSnapshotFile(store.getTrialSourceSnapshot(trial.id), "opsmind/src/agent.mjs").content, /dynamic-agent-loop/);
    assert.equal(searchSnapshotFiles(store.getTrialSourceSnapshot(trial.id), "dynamic-agent")[0].line, 1);
    const sourceView = materializeSnapshotView(store.getTrialSourceSnapshot(trial.id), path.join(root, "analysis", "source"));
    assert.match(readFileSync(path.join(sourceView.path, "opsmind", "src", "agent.mjs"), "utf8"), /dynamic-agent-loop/);
    assert.throws(() => readSnapshotFile(store.getTrialSourceSnapshot(trial.id), ".env"));

    const created = store.createAnalysisRun({ trialId: trial.id, idempotencyKey: "analysis-1", prompt: "分析失败根因",
      sourceSnapshotRef: snapshot.snapshot_ref, budget: { cost_usd: 0.1 } });
    assert.equal(created.created, true);
    store.startAnalysisRun(created.analysis.id);
    store.appendAnalysisEvent(created.analysis.id, { eventType: "tool.completed", actor: "investigator",
      payload: { tool_name: "read_source_file", output_hash: "c".repeat(64) } });
    store.completeAnalysisRun(created.analysis.id, { result: { summary: "完成", issues: [{ severity: "high", category: "agent",
      title: "缺少反证", evidence_refs: [trial.id], recommendation: "加入假设反证", confidence: 0.9 }] }, usage: { turns: 3 } });
    const completed = store.getAnalysisRun(created.analysis.id);
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.result.issues[0].title, "缺少反证");
    assert.equal(store.getAnalysisEvents(created.analysis.id).length, 1);
    assert.throws(() => store.appendAnalysisEvent(created.analysis.id, { eventType: "late", actor: "test" }));
    assert.throws(() => store.completeAnalysisRun(created.analysis.id, { result: {}, usage: {} }));
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM analysis_findings").get().count, 1);
  } finally {
    labels.close();
    store.close();
  }
});
