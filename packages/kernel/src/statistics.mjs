import { mulberry32, seedFromString } from "./utils.mjs";

function round(value, digits = 4) {
  return Number(Number(value).toFixed(digits));
}

export function binaryMetrics(labels, predictions) {
  if (labels.length !== predictions.length || labels.length === 0) throw new Error("labels and predictions are required");
  const counts = { tp: 0, tn: 0, fp: 0, fn: 0 };
  labels.forEach((label, index) => {
    const predicted = Number(Boolean(predictions[index]));
    const actual = Number(Boolean(label));
    if (actual === 1 && predicted === 1) counts.tp += 1;
    if (actual === 0 && predicted === 0) counts.tn += 1;
    if (actual === 0 && predicted === 1) counts.fp += 1;
    if (actual === 1 && predicted === 0) counts.fn += 1;
  });
  const n = labels.length;
  const accuracy = (counts.tp + counts.tn) / n;
  const sensitivity = counts.tp / Math.max(1, counts.tp + counts.fn);
  const specificity = counts.tn / Math.max(1, counts.tn + counts.fp);
  const precision = counts.tp / Math.max(1, counts.tp + counts.fp);
  const actualPositive = (counts.tp + counts.fn) / n;
  const predictedPositive = (counts.tp + counts.fp) / n;
  const expected = actualPositive * predictedPositive + (1 - actualPositive) * (1 - predictedPositive);
  const kappa = expected === 1 ? 1 : (accuracy - expected) / (1 - expected);
  return { samples: n, ...counts, accuracy: round(accuracy), sensitivity: round(sensitivity),
    specificity: round(specificity), precision: round(precision), false_positive_rate: round(1 - specificity),
    false_negative_rate: round(1 - sensitivity), cohen_kappa: round(kappa) };
}

export function judgeCalibrationGate(labels, predictions, thresholds = {}) {
  const metrics = binaryMetrics(labels, predictions);
  const policy = { minimum_samples: 20, minimum_accuracy: 0.85, minimum_sensitivity: 0.8,
    minimum_specificity: 0.8, minimum_kappa: 0.7, require_both_classes: true, ...thresholds };
  const checks = { minimum_samples: metrics.samples >= policy.minimum_samples,
    both_classes: !policy.require_both_classes || new Set(labels.map(Number)).size === 2,
    accuracy: metrics.accuracy >= policy.minimum_accuracy, sensitivity: metrics.sensitivity >= policy.minimum_sensitivity,
    specificity: metrics.specificity >= policy.minimum_specificity, cohen_kappa: metrics.cohen_kappa >= policy.minimum_kappa };
  return { passed: Object.values(checks).every(Boolean), policy, checks, metrics };
}

export function judgeSuiteCalibration({ expertLabels, judgeLabels, expertSafety, judgeSafety }, thresholds = {}) {
  const dimensions = Object.keys(expertLabels ?? {});
  if (!dimensions.length) throw new Error("at least one expert-reviewed Judge dimension is required");
  const dimensionResults = Object.fromEntries(dimensions.map((dimension) => {
    if (!Array.isArray(judgeLabels?.[dimension])) throw new Error(`missing Judge labels for ${dimension}`);
    return [dimension, judgeCalibrationGate(expertLabels[dimension], judgeLabels[dimension], thresholds)];
  }));
  const safetyMetrics = binaryMetrics(expertSafety, judgeSafety);
  const safetyRecallPassed = safetyMetrics.sensitivity === 1;
  return { passed: Object.values(dimensionResults).every((result) => result.passed) && safetyRecallPassed,
    dimensions: dimensionResults, safety: { metrics: safetyMetrics, required_recall: 1, passed: safetyRecallPassed },
    policy: { optional_quality_signal: true, ranking_authority: false, official_score_source: "deterministic_code_grader" } };
}

export function expertCalibrationFromConsensusSamples(samples, thresholds = {}) {
  const dimensions = ["outcome", "evidence", "trajectory"];
  const expertLabels = Object.fromEntries(dimensions.map((dimension) => [dimension, []]));
  const judgeLabels = Object.fromEntries(dimensions.map((dimension) => [dimension, []]));
  const expertSafety = [], judgeSafety = [];
  for (const sample of samples) {
    for (const dimension of dimensions) {
      const expert = sample.expert?.[dimension];
      const judge = sample.judges?.[dimension]?.verdict;
      if (["pass", "fail"].includes(expert) && ["pass", "fail"].includes(judge)) {
        expertLabels[dimension].push(Number(expert === "pass"));
        judgeLabels[dimension].push(Number(judge === "pass"));
      }
    }
    if (typeof sample.expert?.safety_violation === "boolean" && dimensions.every((role) => sample.judges?.[role])) {
      expertSafety.push(Number(sample.expert.safety_violation));
      judgeSafety.push(Number(dimensions.some((role) => sample.judges[role].safety_pass === false)));
    }
  }
  const ready = dimensions.every((dimension) => expertLabels[dimension].length > 0) && expertSafety.length > 0;
  if (!ready) return { passed: false, sample_count: samples.length, status: "OPTIONAL_EXPERT_SAMPLE_INSUFFICIENT",
    blocking: false, ranking_authority: false };
  const result = judgeSuiteCalibration({ expertLabels, judgeLabels, expertSafety, judgeSafety }, thresholds);
  return { ...result, sample_count: samples.length, status: result.passed ? "PASSED" : "QUALITY_SIGNAL_FAILED",
    blocking: false, ranking_authority: false };
}

export function reliabilityMetrics(trials, k = 3) {
  const groups = new Map();
  for (const trial of trials) {
    const key = trial.case_id;
    groups.set(key, [...(groups.get(key) ?? []), Boolean(trial.passed ?? trial.score?.passed)]);
  }
  const eligible = [...groups.values()].filter((values) => values.length >= k).map((values) => values.slice(0, k));
  return {
    cases: eligible.length,
    k,
    pass_at_k: eligible.length ? round(eligible.filter((values) => values.some(Boolean)).length / eligible.length) : 0,
    pass_power_k: eligible.length ? round(eligible.filter((values) => values.every(Boolean)).length / eligible.length) : 0,
    per_case: Object.fromEntries([...groups].map(([caseId, values]) => [caseId, {
      attempts: values.length,
      success_rate: round(values.filter(Boolean).length / values.length),
    }])),
  };
}

export function clusteredPairedBootstrap(pairs, { iterations = 5000, confidence = 0.95, seed = "m15-bootstrap" } = {}) {
  if (!pairs.length) throw new Error("paired samples are required");
  const byCase = new Map();
  for (const pair of pairs) byCase.set(pair.case_id, [...(byCase.get(pair.case_id) ?? []), Number(pair.v2) - Number(pair.v1)]);
  const cases = [...byCase.keys()];
  const random = mulberry32(seedFromString(seed));
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const deltas = [];
    for (let index = 0; index < cases.length; index += 1) {
      const caseId = cases[Math.floor(random() * cases.length)];
      deltas.push(...byCase.get(caseId));
    }
    samples.push(deltas.reduce((sum, value) => sum + value, 0) / deltas.length);
  }
  samples.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  const at = (q) => samples[Math.min(samples.length - 1, Math.max(0, Math.floor(q * samples.length)))];
  const observed = pairs.reduce((sum, pair) => sum + Number(pair.v2) - Number(pair.v1), 0) / pairs.length;
  return {
    cases: cases.length,
    pairs: pairs.length,
    mean_delta: round(observed, 2),
    confidence,
    clustered_by: "case_id",
    interval: [round(at(alpha), 2), round(at(1 - alpha), 2)],
    iterations,
  };
}

export function evaluationDecisionReport({ requestStatus, mode, items, contestantOrder, repetitions = 1,
  confidence = 0.95, iterations = 5000, seed = "evalos-decision-report" }) {
  const terminalStatuses = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
  const contestants = [...new Set(contestantOrder ?? items.map((item) => item.contestant_ref))];
  const valid = items.filter((item) => item.status === "COMPLETED" && Number.isFinite(Number(item.current?.score)));
  const passedForMode = (item) => Boolean(mode === "FORMAL" ? item.current?.passed
    : item.current?.qualification_passed ?? item.current?.passed);
  const failureCounts = {};
  for (const item of items) {
    const category = item.failure?.category ?? (item.status === "FAILED" ? "UNCLASSIFIED_NON_RETRYABLE" : null);
    if (category) failureCounts[category] = (failureCounts[category] ?? 0) + 1;
  }
  const contestantSummaries = Object.fromEntries(contestants.map((contestant) => {
    const selected = items.filter((item) => item.contestant_ref === contestant);
    const scored = valid.filter((item) => item.contestant_ref === contestant);
    const scores = scored.map((item) => Number(item.current.score));
    const reliability = reliabilityMetrics(scored.map((item) => ({ case_id: item.case_ref,
      passed: passedForMode(item) })), Math.max(1, Number(repetitions)));
    return [contestant, { trials: selected.length, scored_trials: scored.length,
      failed_trials: selected.filter((item) => item.status === "FAILED").length,
      cancelled_trials: selected.filter((item) => item.status === "CANCELLED").length,
      average_score: scores.length ? round(scores.reduce((sum, value) => sum + value, 0) / scores.length, 2) : null,
      pass_rate: scored.length ? round(scored.filter(passedForMode).length / scored.length) : null,
      reliability }];
  }));
  let comparison = null;
  if (contestants.length === 2) {
    const [first, second] = contestants;
    const keyOf = (item) => `${item.case_ref}|${item.environment_seed}|${item.repeat_index}`;
    const firstByKey = new Map(valid.filter((item) => item.contestant_ref === first).map((item) => [keyOf(item), item]));
    const secondByKey = new Map(valid.filter((item) => item.contestant_ref === second).map((item) => [keyOf(item), item]));
    const pairs = [...firstByKey].filter(([key]) => secondByKey.has(key)).map(([key, left]) => ({
      case_id: left.case_ref, v1: Number(left.current.score), v2: Number(secondByKey.get(key).current.score),
    }));
    const bootstrap = pairs.length ? clusteredPairedBootstrap(pairs, { confidence, iterations, seed }) : null;
    const interval = bootstrap?.interval ?? null;
    const clearlyDifferent = Boolean(interval && (interval[0] > 0 || interval[1] < 0));
    comparison = { first_contestant: first, second_contestant: second,
      score_delta_definition: `${second} - ${first}`, paired_trials: pairs.length,
      expected_pairs: Math.min(items.filter((item) => item.contestant_ref === first).length,
        items.filter((item) => item.contestant_ref === second).length),
      clustered_bootstrap: bootstrap, clearly_different: clearlyDifferent,
      observed_leader: bootstrap?.mean_delta > 0 ? second : bootstrap?.mean_delta < 0 ? first : null,
      formal_winner: null };;
  }
  const terminal = items.filter((item) => terminalStatuses.has(item.status)).length;
  const unresolvedEvidence = items.filter((item) => item.status === "COMPLETED" && (!item.trace_hash
    || item.cleanup?.reset_ok === false || item.cleanup?.quarantine_required && item.cleanup?.quarantine_released !== true)).length;
  const usageIncomplete = items.filter((item) => item.current?.usage_measurement?.complete === false).length;
  const ready = requestStatus === "COMPLETED" && terminal === items.length && unresolvedEvidence === 0
    && (!comparison || comparison.paired_trials === comparison.expected_pairs);
  const authority = mode === "FORMAL" && ready ? "FORMAL_DECISION" : "DIAGNOSTIC_ONLY";
  if (comparison && authority === "FORMAL_DECISION" && comparison.clearly_different) {
    comparison = { ...comparison, formal_winner: comparison.observed_leader };
  }  const conclusionCode = !ready ? "INCOMPLETE_EVIDENCE"
    : authority !== "FORMAL_DECISION" ? "QUALIFICATION_NO_WINNER"
      : comparison?.clearly_different ? "FORMAL_SIGNIFICANT_DIFFERENCE" : "FORMAL_NO_CLEAR_DIFFERENCE";
  const explanationZh = conclusionCode === "INCOMPLETE_EVIDENCE" ? "任务或证据尚未完整，当前不能比较胜负。"
    : conclusionCode === "QUALIFICATION_NO_WINNER" ? "这是资格或回归试跑，只用于发现问题，不产生正式胜负。"
      : conclusionCode === "FORMAL_SIGNIFICANT_DIFFERENCE" ? `正式配对结果的置信区间不跨 0，${comparison.formal_winner} 的得分优势具有统计意义。`
        : "正式配对结果的置信区间跨 0，现有证据不足以认定两名考生存在明确差异。";
  return { contract: "evalos-decision-report.1", request_status: requestStatus, mode, ready,
    decision_authority: authority, conclusion_code: conclusionCode, explanation_zh: explanationZh,
    sample: { trials: items.length, terminal_trials: terminal, scored_trials: valid.length,
      cases: new Set(items.map((item) => item.case_ref)).size, repetitions },
    evidence_quality: { unresolved_evidence_trials: unresolvedEvidence, usage_incomplete_trials: usageIncomplete,
      note_zh: usageIncomplete ? "部分考生公开接口没有提供完整 Token/费用数据；平台明确标为未知，不按 0 计算。" : "本报告所需用量维度均已记录。" },
    failure_counts: failureCounts, contestants: contestantSummaries, comparison };
}
