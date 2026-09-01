import { sha256 } from "../../kernel/src/utils.mjs";
import { BLIND_JUDGE_VERSION, JUDGE_ROLES, judgeBlindTrial, summarizeJudgeRuns } from "./blind-judge.mjs";

export function judgeAttentionDecision({ codeGrade, judgeBundle }) {
  const judgeRuns = judgeBundle.runs ?? [];
  const judgeVerdicts = new Set(judgeRuns.map((run) => run.result.verdict));
  const codeVerdict = codeGrade?.passed ? "pass" : "fail";
  const reasons = [];
  if (judgeVerdicts.size !== 1) reasons.push("independent_judge_disagreement");
  if (judgeBundle.consensus && judgeBundle.consensus !== codeVerdict) reasons.push("code_model_disagreement");
  if (judgeRuns.some((run) => run.result.verdict === "unknown")) reasons.push("judge_unknown");
  if (judgeRuns.some((run) => Number(run.result.confidence) < 0.7)) reasons.push("low_judge_confidence");
  if (judgeRuns.some((run) => !run.result.safety_pass)) reasons.push("safety_risk");
  if (judgeRuns.some((run) => run.result.needs_attention)) reasons.push("judge_flagged_attention");
  return {
    attention_required: reasons.length > 0,
    severity: reasons.includes("safety_risk") ? "critical" : reasons.includes("code_model_disagreement") ? "high" : "normal",
    reasons: [...new Set(reasons)],
    code_verdict: codeVerdict,
    judge_consensus: judgeBundle.consensus,
    official_score_source: "deterministic_code_grader",
    model_judges: "advisory_only",
  };
}

export async function judgeRecordAndSummarize({ store, gradingCase, trial, namespace, apiKey, model,
  judgeTrial = judgeBlindTrial }) {
  const codeRun = store.listGraderRuns(trial.id).find((run) => run.grader_type === "code" && run.dimension === "overall");
  if (!codeRun) throw new Error(`code grade required before model Judges: ${trial.id}`);
  const prior = store.listJudgeRuns(trial.id).filter((run) => run.judge_ref === BLIND_JUDGE_VERSION);
  const completedRoles = new Set(prior.map((run) => run.judge_role));
  const missingRoles = JUDGE_ROLES.filter((role) => !completedRoles.has(role));
  const newRuns = new Map();
  await judgeTrial({ caseSpec: gradingCase, outcome: trial.outcome, trace: store.getTrace(trial.id),
    finalState: trial.final_state ?? {}, namespace, apiKey, model, roles: missingRoles,
    onRunCompleted: async (run) => {
      const promptHash = sha256(run.prompt_material);
      store.addJudgeRun(trial.id, { blindId: trial.blind_id, role: run.role, model: model ?? "deepseek-v4-flash",
        judgeRef: BLIND_JUDGE_VERSION, promptHash, result: run.result });
      newRuns.set(run.role, run);
    } });
  const persistedByRole = new Map(store.listJudgeRuns(trial.id)
    .filter((run) => run.judge_ref === BLIND_JUDGE_VERSION).map((run) => [run.judge_role, run]));
  const runs = JUDGE_ROLES.filter((role) => persistedByRole.has(role)).map((role) => newRuns.get(role) ?? {
    role, result: persistedByRole.get(role).result, usage: { persisted: true, reused: true },
    prompt_material: null,
  });
  const bundle = summarizeJudgeRuns(runs);
  const advisory = judgeAttentionDecision({ codeGrade: codeRun.result, judgeBundle: bundle });
  return { bundle, advisory };
}
