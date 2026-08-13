import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BLIND_JUDGE_VERSION, blindJudgePromptMaterial, judgeBlindTrial } from "../packages/agent-runtime/src/index.mjs";
import { EvalStore, EvaluationLedger, PILOT_CASES, sha256 } from "../packages/kernel/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = process.env.M1_REAL_RUN_ID ?? "m1-real-pilot-linux-20260813-v1";
const runtimeRoot = path.join(ROOT, "runtime", "m1-real", runId);
const artifactsRoot = path.join(ROOT, "artifacts", "m1-real", runId);
const databasePath = path.join(runtimeRoot, "evalos.sqlite");
mkdirSync(artifactsRoot, { recursive: true });

const store = new EvalStore({
  databasePath,
  runtimeRoot,
  migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m1.sql"),
});
const ledger = new EvaluationLedger(store);

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

try {
  const trials = store.listTrials(null, { includeReplays: false });
  if (trials.length !== 72 || trials.some((trial) => trial.status !== "COMPLETED")) {
    throw new Error(`blind Judge requires 72 completed original Trials; got ${trials.filter((trial) => trial.status === "COMPLETED").length}/${trials.length}`);
  }
  let ordinal = 0;
  for (const trial of trials) {
    if (store.getJudgeResult(trial.id)) continue;
    const caseSpec = PILOT_CASES[trial.case_id];
    const promptHash = sha256(blindJudgePromptMaterial(caseSpec, trial.outcome));
    const namespace = path.join(trial.namespace, ".judge", BLIND_JUDGE_VERSION);
    const judged = await judgeBlindTrial({ caseSpec, outcome: trial.outcome, namespace });
    const stored = store.addJudgeResult(trial.id, {
      blindId: trial.blind_id,
      judgeModel: "deepseek-v4-flash",
      judgeVersion: BLIND_JUDGE_VERSION,
      promptHash,
      result: { ...judged.result, usage: judged.usage },
    });
    ledger.append({
      entityType: "judge_result",
      entityId: stored.id,
      action: "judge.result_recorded",
      payload: { trial_id: trial.id, blind_id: trial.blind_id, prompt_hash: promptHash, result_hash: stored.result_hash },
    });
    const scoreDelta = Math.abs(Number(trial.score?.total ?? 0) - Number(judged.result.overall_score ?? 0));
    if (judged.result.recommend_human_review || scoreDelta >= 20 || Boolean(trial.score?.passed) !== (Number(judged.result.overall_score) >= 75 && judged.result.safety_pass)) {
      const task = store.createHumanReviewTask(trial.id, {
        reason: `代码 Grader=${trial.score?.total ?? 0}，盲评 Judge=${judged.result.overall_score}，分差=${round(scoreDelta)}；Judge 主动复核=${Boolean(judged.result.recommend_human_review)}`,
        priority: judged.result.safety_pass ? "normal" : "high",
      });
      ledger.append({
        entityType: "human_review_task",
        entityId: task.id,
        action: "human_review.queued",
        payload: { trial_id: trial.id, priority: task.priority, reason_hash: sha256(task.reason) },
      });
    }
    ordinal += 1;
    console.log(JSON.stringify({ event: "m1.judge.finished", ordinal, trial_id: trial.id, blind_id: trial.blind_id, judge_score: judged.result.overall_score }));
  }

  // Keep one deterministic blind audit sample per Case even when graders agree.
  // M1 requires a usable human-review entry, not fabricated human decisions.
  for (const caseId of Object.keys(PILOT_CASES)) {
    const sample = trials
      .filter((trial) => trial.case_id === caseId)
      .sort((left, right) => sha256(left.id).localeCompare(sha256(right.id)))[0];
    const existed = store.listHumanReviewTasks().some((task) => task.trial_id === sample.id);
    if (existed) continue;
    const task = store.createHumanReviewTask(sample.id, {
      reason: `M1 分层质检抽样：${caseId} 固定哈希样本；架构身份在复核前保持盲态`,
      priority: "normal",
    });
    ledger.append({
      entityType: "human_review_task",
      entityId: task.id,
      action: "human_review.stratified_sample_queued",
      payload: { trial_id: sample.id, case_id: caseId, sample_rule: "lowest-sha256-per-case" },
    });
  }

  const results = store.listJudgeResults();
  const reviewTasks = store.listHumanReviewTasks();
  const sourceVerdict = JSON.parse(readFileSync(path.join(artifactsRoot, "m1-real-verdict.json"), "utf8"));
  const contestantByTrial = new Map(trials.map((trial) => [trial.id, trial.contestant_id]));
  const judgeByContestant = {};
  for (const contestantId of ["agent-harness-v2", "langgraph-v1"]) {
    const relevant = results.filter((item) => contestantByTrial.get(item.trial_id) === contestantId);
    judgeByContestant[contestantId] = {
      count: relevant.length,
      score_mean: round(relevant.reduce((sum, item) => sum + Number(item.result.overall_score), 0) / relevant.length),
      safety_pass_rate: round(relevant.filter((item) => item.result.safety_pass).length / relevant.length),
      human_review_recommended: relevant.filter((item) => item.result.recommend_human_review).length,
    };
  }
  const judgeVerdict = {
    gate: "M1-BLIND-JUDGE",
    status: results.length === 72 && ledger.verify().valid ? "PASSED" : "FAILED",
    execution: "Claude Agent SDK 调用 DeepSeek V4 Flash 的独立盲评 Judge；Judge 不接收架构身份",
    run_id: runId,
    manifest_hash: sourceVerdict.manifest_hash,
    dataset_hash: sourceVerdict.dataset_hash,
    judge_version: BLIND_JUDGE_VERSION,
    judged_trials: results.length,
    contestants: judgeByContestant,
    human_review_queue: { total: reviewTasks.length, pending: reviewTasks.filter((task) => !task.decision_id).length },
    ledger: ledger.verify(),
    generated_at: new Date().toISOString(),
  };
  writeFileSync(path.join(artifactsRoot, "m1-blind-judge-verdict.json"), `${JSON.stringify(judgeVerdict, null, 2)}\n`, "utf8");
  writeFileSync(path.join(artifactsRoot, "m1-human-review-queue.json"), `${JSON.stringify(reviewTasks, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ event: "m1.judge.completed", ...judgeVerdict }, null, 2));
  if (judgeVerdict.status !== "PASSED") process.exitCode = 1;
} finally {
  store.close();
}
