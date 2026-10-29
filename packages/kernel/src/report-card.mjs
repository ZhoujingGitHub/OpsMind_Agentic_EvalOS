import { isCandidateOwnedFailure } from "./failure-policy.mjs";
import { HARD_GATE_FUNNEL } from "./grader.mjs";
import { OPS_CATEGORIES, OPS_VARIANTS } from "./m33-ops-cases.mjs";

// The exam's report card (24 甲): one row per fault category, never a total.
//
// A total would mix "can it read a process table" with "can it find a lossy
// transport hop" into one number that says neither. Each row reports, per
// candidate, how many of its trials passed every gate, and — split apart, per
// 31 甲 — how often the business really came back and how often the changed
// state was pointed at exactly. The funnel says where the failures stopped.

function bump(map, key, by = 1) { map[key] = (map[key] ?? 0) + by; }

// The candidate's own failure to finish counts as not passed and stays in the
// denominator (product manager, 2026-10-29). It has no grade, so it enters only
// the pass ratio and the first-failure tally, not the business/root-cause rates.
export const DID_NOT_FINISH_GATE = "did_not_finish";

function didNotFinish(item) {
  return !item.grade && item.trial?.status === "FAILED" && isCandidateOwnedFailure(item.failure);
}

function emptyCell() {
  return { trials: 0, graded: 0, passed: 0, root_cause_exact: 0, root_cause_applicable: 0,
    business_recovered: 0, business_applicable: 0, first_failures: {}, not_completed: 0, did_not_finish: 0 };
}

function addToCell(cell, item) {
  cell.trials += 1;
  if (didNotFinish(item)) {
    cell.graded += 1;
    cell.did_not_finish += 1;
    bump(cell.first_failures, DID_NOT_FINISH_GATE);
    return;
  }
  if (!item.grade) { cell.not_completed += 1; return; }
  cell.graded += 1;
  if (item.grade.passed) cell.passed += 1;
  const card = item.grade.report_card ?? {};
  if (card.root_cause_exact !== null && card.root_cause_exact !== undefined) {
    cell.root_cause_applicable += 1;
    if (card.root_cause_exact) cell.root_cause_exact += 1;
  }
  if (card.business_recovered !== null && card.business_recovered !== undefined) {
    cell.business_applicable += 1;
    if (card.business_recovered) cell.business_recovered += 1;
  }
  if (item.grade.first_failed_gate) bump(cell.first_failures, item.grade.first_failed_gate.gate);
}

function rows(items, keyOf, catalog, candidates) {
  const byKey = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    const row = byKey.get(key) ?? { key, label: catalog[key]?.label ?? key, order: catalog[key]?.order ?? 99,
      candidates: Object.fromEntries(candidates.map((ref) => [ref, emptyCell()])) };
    addToCell(row.candidates[item.trial.contestant_ref] ?? (row.candidates[item.trial.contestant_ref] = emptyCell()), item);
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
}

function funnelFor(items) {
  const graded = items.filter((item) => item.grade?.funnel);
  const unfinished = items.filter(didNotFinish).length;
  const finishStep = unfinished ? [{ gate: DID_NOT_FINISH_GATE, stage: "finish", label: "考生自己把题答完",
    reached: graded.length + unfinished, failed_here: unfinished }] : [];
  return [...finishStep, ...HARD_GATE_FUNNEL.map(({ gate, stage, label }, index) => {
    let reached = 0;
    let failedHere = 0;
    for (const item of graded) {
      const before = item.grade.funnel.slice(0, index);
      if (before.every((step) => step.passed)) {
        const step = item.grade.funnel[index];
        if (step?.applicable === false) continue;
        reached += 1;
        if (step && !step.passed) failedHere += 1;
      }
    }
    return { gate, stage, label, reached, failed_here: failedHere };
  })];
}

/**
 * @param items  [{ trial, grade, analyses = [], annotations = [] }]
 *   trial   { id, contestant_ref, case_ref, status }
 *   grade   a Grader 7.0 result (case_profile, report_card, funnel, first_failed_gate, passed)
 */
export function examReportCard(items, { candidates = null } = {}) {
  const refs = candidates ?? [...new Set(items.map((item) => item.trial.contestant_ref))].sort();
  const profile = (item) => item.grade?.case_profile ?? item.case_profile ?? {};
  const sameCase = new Map();
  for (const item of items) {
    const key = item.trial.case_ref;
    const entry = sameCase.get(key) ?? { case_ref: key, scenario_id: profile(item).scenario_id ?? null,
      category: profile(item).category ?? null, variant: profile(item).variant ?? null, candidates: {} };
    entry.candidates[item.trial.contestant_ref] = item.grade ? {
      trial_id: item.trial.id, passed: item.grade.passed, total: item.grade.total,
      first_failed_gate: item.grade.first_failed_gate, root_cause_verdict: item.grade.report_card?.root_cause_verdict ?? null,
      business_recovered: item.grade.report_card?.business_recovered ?? null,
    } : didNotFinish(item) ? { trial_id: item.trial.id, passed: false, total: 0, did_not_finish: true,
      first_failed_gate: { gate: DID_NOT_FINISH_GATE }, failure_category: item.failure.category, status: item.trial.status,
    } : { trial_id: item.trial.id, passed: null, status: item.trial.status };
    sameCase.set(key, entry);
  }
  const investigatorIssues = {};
  const annotationTags = {};
  const annotationGates = {};
  let annotatedTrials = 0;
  let humanAnnotated = 0;
  for (const item of items) {
    for (const analysis of item.analyses ?? []) {
      for (const issue of analysis.result?.issues ?? []) bump(investigatorIssues, issue.category ?? "general");
    }
    const notes = item.annotations ?? [];
    if (notes.length) annotatedTrials += 1;
    if (notes.some((note) => note.annotator_kind === "human")) humanAnnotated += 1;
    for (const note of notes) {
      for (const tag of note.tags ?? []) bump(annotationTags, tag);
      if (note.first_failure_gate) bump(annotationGates, note.first_failure_gate);
    }
  }
  const sorted = (map) => Object.entries(map).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  return {
    contract: "evalos-exam-report-card/1.0",
    notice: "按大类出，不算总分：每个格子是「通过 / 有效场次」，考生自己没答完的场次按不通过计入，另列业务恢复率与根因精确率",
    candidates: refs,
    by_category: rows(items, (item) => profile(item).category, OPS_CATEGORIES, refs),
    by_variant: rows(items, (item) => profile(item).variant, Object.fromEntries(Object.entries(OPS_VARIANTS)
      .map(([key, value], index) => [key, { label: value.label, order: index + 1 }])), refs),
    same_case: [...sameCase.values()].sort((left, right) => left.case_ref.localeCompare(right.case_ref)),
    funnel: Object.fromEntries(refs.map((ref) => [ref, funnelFor(items.filter((item) => item.trial.contestant_ref === ref))])),
    taxonomy: { investigator_issue_categories: sorted(investigatorIssues), annotation_tags: sorted(annotationTags),
      annotation_first_failures: sorted(annotationGates),
      annotation_progress: { trials: items.length, annotated: annotatedTrials, human_reviewed: humanAnnotated } },
  };
}
