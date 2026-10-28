import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CASES, EvalStore, HARD_GATE_FUNNEL, createM15Registry, examReportCard } from "../src/index.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

function grade({ category, variant = "main", passed, failedGate = null, exact = passed, recovered = passed }) {
  const funnel = HARD_GATE_FUNNEL.map((item) => ({ ...item, applicable: true, passed: true }));
  if (failedGate) {
    const index = funnel.findIndex((item) => item.gate === failedGate);
    for (const item of funnel.slice(index)) item.passed = item.gate !== failedGate;
    funnel[index].passed = false;
  }
  return { grader_contract_version: "7.0", passed, total: passed ? 100 : 40,
    case_profile: { category, variant, scenario_id: `${category}-x` },
    report_card: { root_cause_exact: exact, root_cause_verdict: exact ? "exact_state_match" : "state_miss",
      business_recovered: recovered },
    funnel, first_failed_gate: failedGate ? { gate: failedGate } : null };
}

test("成绩单按大类出、不算总分，业务恢复率与根因精确率分开列", () => {
  const items = [
    { trial: { id: "t1", contestant_ref: "agent-harness-v2", case_ref: "M33-MAIN-01@3.3.0", status: "COMPLETED" },
      grade: grade({ category: "transport", passed: true }) },
    // Business back, cause not pointed at: fails since 31 甲, and the card says why.
    { trial: { id: "t2", contestant_ref: "agent-harness-v2", case_ref: "M33-MAIN-02@3.3.0", status: "COMPLETED" },
      grade: grade({ category: "transport", passed: false, failedGate: "root_cause_exact", exact: false, recovered: true }) },
    { trial: { id: "t3", contestant_ref: "langgraph-v1", case_ref: "M33-MAIN-01@3.3.0", status: "COMPLETED" },
      grade: grade({ category: "transport", passed: false, failedGate: "required_observations", exact: false, recovered: false }) },
    // Never finished: counted, never graded as a wrong answer.
    { trial: { id: "t4", contestant_ref: "langgraph-v1", case_ref: "M33-MAIN-02@3.3.0", status: "FAILED" }, grade: null,
      case_profile: { category: "transport", variant: "main", scenario_id: "transport-x" } },
  ];
  const card = examReportCard(items);
  assert.equal("total" in card, false);
  const transport = card.by_category.find((row) => row.key === "transport");
  assert.equal(transport.label, "承载 / 传输故障");
  assert.deepEqual({ ...transport.candidates["agent-harness-v2"], first_failures: undefined },
    { trials: 2, graded: 2, passed: 1, root_cause_exact: 1, root_cause_applicable: 2,
      business_recovered: 2, business_applicable: 2, first_failures: undefined, not_completed: 0 });
  assert.equal(transport.candidates["langgraph-v1"].not_completed, 1);
  assert.deepEqual(transport.candidates["agent-harness-v2"].first_failures, { root_cause_exact: 1 });
  // Same question, both candidates, side by side.
  const first = card.same_case.find((row) => row.case_ref === "M33-MAIN-01@3.3.0");
  assert.equal(first.candidates["agent-harness-v2"].passed, true);
  assert.equal(first.candidates["langgraph-v1"].first_failed_gate.gate, "required_observations");
  // The funnel counts who reached each gate and who stopped there.
  const ahFunnel = card.funnel["agent-harness-v2"];
  assert.equal(ahFunnel.find((item) => item.gate === "root_cause_exact").reached, 2);
  assert.equal(ahFunnel.find((item) => item.gate === "root_cause_exact").failed_here, 1);
  assert.equal(ahFunnel.find((item) => item.gate === "expected_status").reached, 1);
});

test("讲评标注只追加：同一标注人后写的覆盖先写的，原记录不改不删", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-annotations-"));
  const migrations = ["001_m15.sql", "002_m25_workbench.sql", "003_m26_run_control.sql", "004_m31_candidate_relay.sql",
    "005_m31_seed_identity.sql", "006_m31_trial_attempt_audit.sql", "007_m32_run_resilience.sql",
    "008_m32_cleanup_reconciliation.sql", "009_m32_capacity_rehearsal.sql", "010_m32_relay_transport_buffer.sql",
    "011_m32_relay_nonce_retention.sql", "012_m33_trial_annotations.sql"]
    .map((name) => path.join(ROOT, "infra", "migrations", "sqlite", name));
  const store = new EvalStore({ databasePath: path.join(root, "control.sqlite"), runtimeRoot: root,
    migrationPath: migrations[0], migrationPaths: migrations.slice(1) });
  const registry = createM15Registry(CASES);
  store.publishRegistry(registry, { privateLabelHash: "sha256:test" });
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "config", "m15-smoke.manifest.json"), "utf8"));
  const { experiment } = store.createExperiment(manifest, "annotations");
  const trialId = store.listTrials(experiment.id)[0].id;
  try {
    store.addTrialAnnotation({ trialId: trialId, annotator: "claude", annotatorKind: "ai_first_pass", verdict: "fail",
      firstFailureGate: "root_cause_exact", tags: ["指认太笼统", "指认太笼统"], note: "把干扰规则也交了" });
    store.addTrialAnnotation({ trialId: trialId, annotator: "claude", annotatorKind: "ai_first_pass", verdict: "pass",
      tags: [], note: "复核后确认指中" });
    store.addTrialAnnotation({ trialId: trialId, annotator: "pm", annotatorKind: "human", verdict: "pass" });
    assert.equal(store.listTrialAnnotations(trialId).length, 3);
    const latest = store.listTrialAnnotations(trialId, { latestPerAnnotator: true });
    assert.deepEqual(latest.map((item) => [item.annotator, item.verdict]), [["claude", "pass"], ["pm", "pass"]]);
    assert.deepEqual(store.listTrialAnnotations(trialId)[0].tags, ["指认太笼统"]);
    assert.throws(() => store.db.exec("UPDATE trial_annotations SET verdict='fail'"), /append-only/);
    assert.throws(() => store.db.exec("DELETE FROM trial_annotations"), /append-only/);
    assert.throws(() => store.addTrialAnnotation({ trialId: trialId, annotator: "pm", verdict: "maybe" }), /verdict/);
  } finally { store.close(); }
});
