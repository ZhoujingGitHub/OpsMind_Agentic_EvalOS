// 只读探针 7：过门之后，分数到底由什么决定？逐项拆给人看。
//
// 2026-09-19 重写：老版本推算"过门后的分数区间"，用的是抄来的权重表。
// 现在从「标准答案答卷」出发，每次只弄坏一个细项，量它真实值多少分——
// 这张表就是"区分度来自哪里"的直接答案，不是推的。
//
// 用法（EvalOS 仓根目录）： node _work/claude-takeover-20260911/tools/grader-probe7.mjs

import { gradeTrial } from "../../../packages/kernel/src/grader.mjs";
import { M3_OBSERVATION_CASES } from "../../../packages/kernel/src/m3-observation-cases.mjs";
import { buildBaselineSubmission } from "./grader-baseline-agents.mjs";

const CASE = M3_OBSERVATION_CASES["M3-OBS-001"];

function grade(mutate) {
  const base = buildBaselineSubmission(CASE, "reference");
  const submission = mutate(structuredClone(base));
  return gradeTrial(CASE, submission.outcome, submission.trace, submission.usage,
    { ...submission.context, resourceUsageAffectsScore: false });
}

const identity = (submission) => submission;

const MUTATIONS = {
  "标准答案（对照）": identity,
  "不指认被改动的那处状态": (submission) => {
    for (const item of submission.outcome.recommendation_evaluation.hypothesis_context.hypotheses) {
      item.root_cause_state_claims = [];
    }
    return submission;
  },
  "指得太笼统：对得上好几条记录": (submission) => {
    const leading = submission.outcome.recommendation_evaluation.hypothesis_context.hypotheses[0];
    leading.root_cause_state_claims = leading.root_cause_state_claims
      .map((claim) => ({ ...claim, fields: { has_negation: false } }));
    return submission;
  },
  "倒豆子：把看到的每一行都说成病根": (submission) => {
    const parrot = buildBaselineSubmission(CASE, "parrot");
    const claims = parrot.outcome.recommendation_evaluation.hypothesis_context
      .hypotheses[0].root_cause_state_claims;
    submission.outcome.recommendation_evaluation.hypothesis_context.hypotheses[0]
      .root_cause_state_claims = claims;
    return submission;
  },
  "少引根因那条证据（召回 2/3，但根因没了依据）": (submission) => {
    const kept = submission.outcome.evidence_refs.slice(0, 2);
    submission.outcome.evidence_refs = kept;
    submission.trace = submission.trace.filter((record) => record.name !== "candidate.raw_event"
      || kept.includes(record.payload.payload.evidence_id));
    submission.outcome.recommendation_evaluation.hypothesis_context.hypotheses[0].supporting_evidence_ids = kept;
    submission.outcome.recommendation_evaluation.report_evidence_ids = kept;
    return submission;
  },
  "少引一条旁证（召回 2/3，根因依据仍在）": (submission) => {
    const kept = [submission.outcome.evidence_refs[0], submission.outcome.evidence_refs[2]];
    submission.outcome.evidence_refs = kept;
    submission.trace = submission.trace.filter((record) => record.name !== "candidate.raw_event"
      || kept.includes(record.payload.payload.evidence_id));
    submission.outcome.recommendation_evaluation.hypothesis_context.hypotheses[0].supporting_evidence_ids = kept;
    submission.outcome.recommendation_evaluation.report_evidence_ids = kept;
    return submission;
  },
  "证据全来自同一条血缘": (submission) => {
    submission.trace = submission.trace.map((record) => (record.name === "candidate.raw_event"
      ? { ...record, payload: { payload: { ...record.payload.payload, source_lineage: "lab.single-authority" } } }
      : record));
    return submission;
  },
  "不写已排除的竞争假设": (submission) => {
    submission.outcome.exclusions = [];
    submission.outcome.recommendation_evaluation.hypothesis_context.hypotheses =
      submission.outcome.recommendation_evaluation.hypothesis_context.hypotheses
        .filter((item) => item.status === "leading");
    return submission;
  },
  "列了被否决的假设，但不给反证编号": (submission) => {
    submission.outcome.exclusions = [];
    for (const item of submission.outcome.recommendation_evaluation.hypothesis_context.hypotheses) {
      item.counter_evidence_ids = []; item.contradicting_evidence_ids = [];
    }
    return submission;
  },
  "不给缺口分级": (submission) => {
    submission.outcome.next_checks = [];
    for (const item of submission.outcome.recommendation_evaluation.hypothesis_context.hypotheses) {
      item.blocking_evidence_gaps = []; item.missing_evidence = []; item.unknowns = [];
    }
    return submission;
  },
  "处置后不回头看现场，只信动作返回": (submission) => {
    submission.trace = submission.trace.filter((record) => record.name !== "candidate.recovery.observed");
    return submission;
  },
};

const baseline = grade(identity);
console.log("题目:", CASE.id, "（今天在用的那道）");
console.log("对照满分:", baseline.total, " passed =", baseline.passed);
console.log();
console.log("=== 每次只弄坏一个细项，看掉多少分、会不会掉出通过 ===");
for (const [label, mutate] of Object.entries(MUTATIONS)) {
  const result = grade(mutate);
  const delta = Number((result.total - baseline.total).toFixed(2));
  const failed = Object.entries(result.hard_gates).filter(([, ok]) => !ok).map(([name]) => name);
  console.log(`  ${String(result.total).padStart(6)} 分 | ${String(delta).padStart(7)} | `
    + `${result.passed ? "仍通过" : "判否   "} | ${label}`);
  if (failed.length) console.log(`              └─ 未过硬门: ${failed.join(", ")}`);
}
console.log();
console.log("读法：掉分但仍通过的，是「诊断质量」；直接判否的，是「不可补偿的硬门」。");
console.log("      这道题是「可以动手修」的题——2026-09-20 起，这类题的门交给结果：");
console.log("      一次最小变更 + 实验室独立复测业务从断到通，诊断说得多准只影响分数。");
console.log("      换成只诊断的题（例如 M3-OBS-SAFE-008），上面前三行会直接判否。");
console.log("      改动前这张表只有两种结局——100 分通过，或者 21 分判否，中间是空的。");
