import assert from "node:assert/strict";
import test from "node:test";

import { BLIND_JUDGE_VERSION, judgeRecordAndSummarize } from "../src/index.mjs";

function result(verdict = "pass") {
  return { verdict, score: 0.9, confidence: 0.9, safety_pass: true,
    evidence_refs: ["evidence:1"], flags: [], needs_attention: false, audit_rationale: "测试" };
}

function fixtureStore() {
  const judgeRuns = [];
  return {
    judgeRuns,
    listGraderRuns: () => [{ grader_type: "code", dimension: "overall", result: { passed: true } }],
    listJudgeRuns: () => judgeRuns,
    getTrace: () => [],
    addJudgeRun(trialId, item) {
      if (judgeRuns.some((run) => run.trial_id === trialId && run.judge_role === item.role
        && run.judge_ref === item.judgeRef)) return;
      judgeRuns.push({ trial_id: trialId, judge_role: item.role, judge_ref: item.judgeRef,
        result: item.result, prompt_hash: item.promptHash });
    },
  };
}

test("三路 Judge 每完成一路立即保存，重试只补缺失角色", async () => {
  const store = fixtureStore();
  const trial = { id: "trial-judge-resume", blind_id: "blind-a", outcome: {}, final_state: {} };
  const gradingCase = { id: "case", goal: "test", visible: { success_criteria: {}, task_contract: {
    recommendation_required: true } }, ground_truth: { root_causes: [], required_evidence: [] }, tools: {} };

  await assert.rejects(judgeRecordAndSummarize({ store, gradingCase, trial, namespace: ".runtime-test",
    judgeTrial: async ({ roles, onRunCompleted }) => {
      assert.deepEqual(roles, ["outcome", "evidence", "trajectory"]);
      await onRunCompleted({ role: "outcome", result: result(), usage: {}, prompt_material: { role: "outcome" } });
      throw new Error("evidence Judge timeout");
    } }), /evidence Judge timeout/);
  assert.deepEqual(store.judgeRuns.map((run) => run.judge_role), ["outcome"]);
  assert.equal(store.judgeRuns[0].judge_ref, BLIND_JUDGE_VERSION);

  const resumed = await judgeRecordAndSummarize({ store, gradingCase, trial, namespace: ".runtime-test",
    judgeTrial: async ({ roles, onRunCompleted }) => {
      assert.deepEqual(roles, ["evidence", "trajectory"]);
      for (const role of roles) await onRunCompleted({ role, result: result(), usage: {}, prompt_material: { role } });
    } });

  assert.deepEqual(resumed.bundle.runs.map((run) => run.role), ["outcome", "evidence", "trajectory"]);
  assert.deepEqual(resumed.bundle.missing_roles, []);
  assert.equal(resumed.bundle.consensus, "pass");
  assert.equal(store.judgeRuns.length, 3);
});

