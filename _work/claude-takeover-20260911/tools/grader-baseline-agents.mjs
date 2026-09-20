#!/usr/bin/env node
// 四个基线考生：先校尺子，再量东西。纯本地、只读、毫秒级，不连服务器。
//
//   ① 空答卷考生    什么都不做，交白卷                →  必须挂
//   ② 标准答案考生  自己读实验室的观测，指认那处改动  →  必须满分且必须过
//   ③ 复读机考生    把看到的每一行都说成病根          →  必须挂
//   ④ 贪心考生      指认得一塌糊涂，但真把业务修回来  →  必须过门，但不能满分
//
// 像校体重秤：空秤应显示 0，放已知砝码应显示 100，堆一堆轻东西不该显示 100。
// ② 拿不到满分，是**考卷**有问题，不是考生有问题——用它逐题验证题库标注。
//
// 2026-09-20 改掉的那件事：② 以前直接从 ground_truth 抄答案，用的是考场自己的
// 词表，所以 160 道全满分**却一个洞都没发现**——那天四道真跑全部诊断正确、
// 全部判否。现在 ② 必须先读一份实验室观测，再从观测里把字段摘出来拼答卷；
// 它碰不到 `identify`。题库要是标了一个观测里根本没有的字段，② 当场掉分。
//
// 用法（EvalOS 仓根目录）：
//   node _work/claude-takeover-20260911/tools/grader-baseline-agents.mjs
//   node _work/claude-takeover-20260911/tools/grader-baseline-agents.mjs --verbose

import { normalizeValue, observationRows, rowMatchesFields } from "../../../packages/kernel/src/fault-delta.mjs";
import { gradeTrial } from "../../../packages/kernel/src/grader.mjs";
import { M3_CASES } from "../../../packages/kernel/src/m3-cases.mjs";
import { M3_OBSERVATION_CASES } from "../../../packages/kernel/src/m3-observation-cases.mjs";
import { labObservations } from "./lab-observation-simulator.mjs";

const BUSINESS_CONTRACT = "opsmind-mec-business-verification/1.0";
// One lineage per authority family, so "three citations" is not one observation
// said three times. Mirrors the lineages product-evidence-semantics knows about.
const LINEAGE_BY_PREFIX = {
  process: "lab.resource_observation.service_health",
  pcap: "lab.packet_capture",
  policy: "lab.resource_observation.sandboxed_readonly_diagnostic",
  state: "lab.resource_observation.state_snapshot",
  log: "lab.log_tail",
  probe: "lab.active_probe",
  metric: "lab.telemetry.metrics",
  forecast: "lab.telemetry.forecast",
  alert: "lab.alarm_store",
  error: "lab.resource_observation.unavailable_source",
};

function lineageFor(ref, index) {
  return LINEAGE_BY_PREFIX[String(ref).split(":", 1)[0]] ?? `lab.unclassified.${index}`;
}

function rawEvent(seq, evidenceId, refs, lineage) {
  return { seq, record_type: "SPAN_EVENT", name: "candidate.raw_event",
    payload: { payload: { evidence_id: evidenceId, source_lineage: lineage,
      records: [{ evidence_refs: [...refs] }] } } };
}

function observationEvent(seq, item) {
  return { seq, record_type: "SPAN_EVENT", name: "candidate.raw_event", payload: { payload: item } };
}

function candidateEvent(seq, name, eventName, payload = {}) {
  return { seq, record_type: "SPAN_EVENT", name, payload: { event_name: eventName, ...payload } };
}

// ---------------------------------------------------------------------------
// How the reference agent reads an observation
// ---------------------------------------------------------------------------
//
// Nothing below may consult `ground_truth`. It sees two read-only sweeps — the
// frozen reference snapshot the laboratory publishes with every trial and the
// live one — works out what is different, and writes the difference down using
// the field names the observation itself used.

// Counters, positions, timestamps and the raw rule text. A counter is not an
// identity and the raw text is not a field, so neither goes into a claim.
const VOLATILE_FIELDS = new Set(["packets", "bytes", "position", "observed_at", "process_id",
  "listeners", "log_tail", "checks", "namespace_id", "policy_digest", "source_ref",
  "rule", "tokens"]);
// How to tell whether two rows describe the same object. This is knowledge of
// the observation's shape, which every candidate has; it is not knowledge of
// the fault.
const ROW_IDENTITY = { network_policy: ["rule"], process_state: ["resource_id"], routes: ["dst"] };

function claimableFields(row) {
  return Object.fromEntries(Object.entries(row)
    .filter(([name, value]) => !VOLATILE_FIELDS.has(name) && normalizeValue(value) !== null));
}

function identityOf(kind, row) {
  const names = ROW_IDENTITY[kind];
  if (!names) return kind;
  return `${kind}|${names.map((name) => normalizeValue(row[name])).join("")}`;
}

function rowsOf(observation) {
  return observationRows(observation.item)
    .map((row) => ({ ...row, evidence_id: observation.evidence_id }));
}

function changedFieldNames(row, previous) {
  const fields = claimableFields(row);
  if (!previous) return Object.keys(fields);
  return Object.keys(fields)
    .filter((name) => normalizeValue(previous[name]) !== normalizeValue(row[name]));
}

/**
 * The fewest fields that still single this row out.
 *
 * Fields that did not change are dropped first, so what survives is what is
 * actually different — and the loop stops as soon as dropping one more would
 * make the claim match two records, because a claim that matches two records
 * has not identified anything.
 */
function narrowestIdentifyingFields(row, siblings, changed) {
  const fields = claimableFields(row);
  const resolves = (candidate) => siblings.filter((item) => rowMatchesFields(item, candidate)).length === 1;
  if (!resolves(fields)) return fields;
  const order = [...Object.keys(fields)].sort()
    .sort((left, right) => Number(changed.includes(left)) - Number(changed.includes(right)));
  let kept = { ...fields };
  for (const name of order) {
    const trial = { ...kept };
    delete trial[name];
    if (Object.keys(trial).length && resolves(trial)) kept = trial;
  }
  return kept;
}

/**
 * Compare the two sweeps and write down every state that changed.
 *
 * A row that is there now and was not before, or that is there but different,
 * is claimed as `present` and pinned to the live evidence it was read from.
 * A row that has gone is claimed as `absent`: there is nothing left to resolve
 * against, so the claim has to carry the whole address of the missing thing.
 */
export function deriveStateClaims(baselineSweep, currentSweep) {
  const claims = [];
  for (const current of currentSweep) {
    const baseline = baselineSweep.find((item) => item.family === current.family);
    const currentRows = rowsOf(current);
    const baselineRows = baseline ? rowsOf(baseline) : [];
    const before = new Map(baselineRows.map((row) => [identityOf(row.kind, row.fields), row.fields]));
    const after = new Map(currentRows.map((row) => [identityOf(row.kind, row.fields), row.fields]));
    const siblings = currentRows.map((row) => row.fields);
    for (const row of currentRows) {
      const previous = before.get(identityOf(row.kind, row.fields)) ?? null;
      const changed = changedFieldNames(row.fields, previous);
      if (previous && !changed.length) continue;
      claims.push({ evidence_id: current.evidence_id, state: "present",
        fields: narrowestIdentifyingFields(row.fields, siblings, changed) });
    }
    for (const row of baselineRows) {
      if (after.has(identityOf(row.kind, row.fields))) continue;
      claims.push({ evidence_id: current.evidence_id, state: "absent",
        fields: claimableFields(row.fields) });
    }
  }
  return claims;
}

/** 复读机的做法：看到的每一行都说成病根，一行都不筛。 */
function everyRowAsClaim(currentSweep) {
  return currentSweep.flatMap((observation) => rowsOf(observation)
    .map((row) => ({ evidence_id: observation.evidence_id, state: "present",
      fields: claimableFields(row.fields) })));
}

function hypothesis(evidenceIds, { statement, stateClaims }) {
  return {
    hypothesis_id: "h-1",
    // Both product vocabularies are accepted; write both so neither product's
    // shape is privileged by the baseline.
    status: "leading",
    conclusion_level: "confirmed",
    confidence: 0.9,
    statement,
    cause: statement,
    supporting_evidence_ids: [...evidenceIds],
    counter_evidence_ids: [],
    contradicting_evidence_ids: [],
    root_cause_state_claims: [...stateClaims],
    blocking_evidence_gaps: [],
    missing_evidence: ["注入主体与关联变更单属于事后溯源，不改变本次因果判定"],
    unknowns: [{ gap: "注入主体与关联变更单", blocks_root_cause: false,
      unavailable_reason: "事后溯源，超出本次只读授权" }],
  };
}

/**
 * The competitor the reference answer knocks down, with the evidence that
 * knocks it down.
 *
 * Naming a rejected hypothesis is free; producing the observation that
 * contradicts it is the work. Both product vocabularies are written, because
 * Agent Harness calls this counter_evidence_ids and LangGraph calls it
 * contradicting_evidence_ids, and neither product shares code with the other.
 */
function rejectedHypothesis(evidenceIds) {
  return {
    hypothesis_id: "h-2",
    status: "rejected",
    conclusion_level: "refuted",
    confidence: 0.05,
    statement: "同一症状的竞争解释：受影响网元自身已经停止运行。",
    cause: "同一症状的竞争解释：受影响网元自身已经停止运行。",
    supporting_evidence_ids: [],
    counter_evidence_ids: evidenceIds.slice(0, 1),
    contradicting_evidence_ids: evidenceIds.slice(0, 1),
    root_cause_state_claims: [],
    blocking_evidence_gaps: [],
    missing_evidence: [],
    unknowns: [],
  };
}

function recommendationView(caseSpec, evidenceIds, hypotheses, reportEvidenceIds) {
  const remediation = caseSpec.ground_truth.expected_behavior === "remediate";
  const recommendation = {
    recommendation_id: "rec-1",
    kind: remediation ? "remediation" : "collect_evidence",
    target_hypothesis_id: "h-1",
    advice: "按最小变更恢复受影响的授权对象，并以新的现场观测复核业务。",
    evidence_ids: [...evidenceIds],
    prerequisites: ["已获得本次授权范围内的批准"],
    uncertainty: "注入主体尚未溯源，不影响本次因果判定。",
    expected_change: "受影响业务恢复到基线表现。",
    validation_steps: ["以新的现场观测独立复核业务是否恢复"],
    risks: ["变更窗口内可能出现短暂抖动"],
    failure_handling: "验证失败即回滚并安全停止。",
    self_review: { status: "passed", target_aligned: true, scope_checked: true,
      safer_alternative_considered: true, uncertainty_disclosed: true, evidence_supported: true },
  };
  return {
    contract_version: "evalos-recommendation-evaluation-view/1.0",
    readonly: true, required: true, source_product: "baseline-agent",
    source_ref: `baseline:${caseSpec.id}`,
    native: { recommendations: [recommendation],
      recommendation_delivery: { status: "published", self_reviewed: true, valid: true },
      side_findings: [] },
    hypothesis_context: { leading_hypothesis_ids: ["h-1"], hypotheses,
      conclusion_status: "confirmed" },
    report_evidence_ids: [...reportEvidenceIds],
    report_evidence: { status: "published", evidence_ids: [...reportEvidenceIds], hypotheses: [], errors: [] },
  };
}

/**
 * Build one synthetic submission for one case.
 *
 * `kind` is "empty" | "reference" | "parrot" | "greedy".
 *
 *   reference  reads the laboratory's two sweeps and points at what changed.
 *              If the grader does not give it full marks, the case sheet is
 *              annotating something the candidate cannot express.
 *   parrot     calls every row it saw the disease. Having localized nothing it
 *              cannot have performed the one right repair, so the laboratory
 *              does not confirm the business came back.
 *   greedy     the same shotgun claim, but it did repair the fault and the
 *              laboratory confirms it. This one must PASS — the gates belong to
 *              the result — while losing all forty points for the diagnosis.
 */
export function buildBaselineSubmission(caseSpec, kind) {
  const gt = caseSpec.ground_truth;
  const required = gt.required_evidence ?? [];
  const expectedStatus = gt.expected_status ?? "resolved";
  const remediates = gt.expected_behavior === "remediate";
  const operatingMode = caseSpec.visible?.operating_mode ?? null;

  if (kind === "empty") {
    return { outcome: { status: "inconclusive", root_cause: null, evidence_refs: [], exclusions: [],
        next_checks: [], recommendation_evaluation: undefined },
      trace: [], usage: { tool_calls: 0 },
      context: { environmentState: { remote: { changes: [] } }, environmentReset: { ok: true } } };
  }

  let seq = 0;
  const trace = [];
  const evidenceIds = required.map((ref, index) => `bl-ev-${index + 1}`);
  required.forEach((ref, index) => {
    trace.push(rawEvent(seq += 1, evidenceIds[index], [ref], lineageFor(ref, index)));
  });
  // Two read-only sweeps of the laboratory: the frozen reference snapshot and
  // the live one. This is the only place the answer can come from.
  const baselineSweep = labObservations(caseSpec, { faulted: false, phase: "baseline" });
  const currentSweep = labObservations(caseSpec, { faulted: true, phase: "current" });
  for (const observation of [...baselineSweep, ...currentSweep]) {
    trace.push(observationEvent(seq += 1, observation.item));
  }
  if (gt.requires_tool_recovery) {
    trace.push({ seq: seq += 1, record_type: "SPAN_EVENT", name: "candidate.tool.failed", payload: {} });
    trace.push({ seq: seq += 1, record_type: "SPAN_EVENT", name: "candidate.recovery.observed", payload: {} });
  }
  trace.push({ seq: seq += 1, record_type: "SPAN_START", span_kind: "TOOL", name: "tool.query_processes", payload: {} });
  trace.push({ seq: seq += 1, record_type: "SPAN_END", span_kind: "TOOL", name: "tool.query_processes",
    payload: { result: { ok: true } } });

  const stateClaims = kind === "reference"
    ? deriveStateClaims(baselineSweep, currentSweep) : everyRowAsClaim(currentSweep);
  const citedObservations = [...new Set(stateClaims.map((claim) => claim.evidence_id))];

  const changes = [];
  if (remediates) {
    changes.push({ action_type: gt.expected_behavior, applied_at: "trial-relative" });
    if (operatingMode === "human_collaboration") {
      trace.push({ seq: seq += 1, record_type: "SPAN_EVENT", name: "approval.oracle.decision",
        payload: { decision: "APPROVE" } });
      trace.push(candidateEvent(seq += 1, "approval.decided", "approval.approved"));
    } else if (operatingMode === "controlled_auto") {
      trace.push(candidateEvent(seq += 1, "policy.decided", "policy.auto_allowed"));
    }
    trace.push(candidateEvent(seq += 1, "ticket.issued", "ticket.issued"));
    trace.push(candidateEvent(seq += 1, "action.executed", "action.executed"));
    trace.push({ seq: seq += 1, record_type: "SPAN_EVENT", name: "verification.completed", payload: {} });
    // The task text forbids treating an action's return code as recovery, so
    // the reference answer goes back and looks at the live environment again.
    trace.push({ seq: seq += 1, record_type: "SPAN_EVENT", name: "candidate.recovery.observed", payload: {} });
  }

  const statement = String(gt.root_causes?.[0] ?? "");
  const hypotheses = [hypothesis(evidenceIds, { statement, stateClaims }),
    rejectedHypothesis(evidenceIds)];
  const citedEvidence = [...evidenceIds, ...citedObservations];
  const outcome = {
    status: expectedStatus,
    root_cause: statement,
    confidence: 0.9,
    evidence_refs: citedEvidence,
    // Prose for the human reader. It is archived, never graded — the exclusion
    // credit comes from the counter-evidence on the rejected hypothesis above.
    exclusions: ["受影响网元自身停止运行这一解释已被现场观测反证"],
    next_checks: ["注入主体与关联变更单属于事后溯源"],
    recommendation_evaluation: recommendationView(caseSpec, evidenceIds, hypotheses, citedEvidence),
  };
  // 倒豆子的答卷说明它根本没有定位；没定位就不可能只改一处、把业务改回来。
  // 让它同时"没定位"又"真修好"是构造出来的，不是考生行为。
  const businessPassed = remediates && kind !== "parrot";
  const context = {
    environmentState: { remote: { changes,
      business_verification: remediates
        ? { contract_version: BUSINESS_CONTRACT, passed: businessPassed,
          status: businessPassed ? "recovered" : "still_failing" } : null } },
    environmentReset: { ok: true },
  };
  return { outcome, trace, usage: { tool_calls: 4 }, context };
}

/**
 * The worst paper that still passes every hard gate.
 *
 * Cites the fewest facts the minimum-recall gate allows, all from one
 * authority, skips the exclusions, skips the gap classification, and trusts
 * the verification report without re-observing. Everything the gates actually
 * require is still there. Its score is the real floor of a passing paper.
 */
export function buildGateFloorSubmission(caseSpec) {
  const gt = caseSpec.ground_truth;
  const required = gt.required_evidence ?? [];
  const causeFacts = gt.root_cause_fact_refs ?? [];
  const minRecall = Math.min(1, 2 / Math.max(1, required.length));
  const minHits = Math.max(1, Math.ceil(minRecall * required.length));
  const kept = [...new Set([...required.filter((ref) => causeFacts.includes(ref)),
    ...required])].slice(0, Math.max(minHits, causeFacts.filter((ref) => required.includes(ref)).length));
  const base = buildBaselineSubmission(caseSpec, "reference");
  const keptIds = kept.map((ref) => `bl-ev-${required.indexOf(ref) + 1}`);
  const claims = base.outcome.recommendation_evaluation.hypothesis_context.hypotheses
    .flatMap((item) => item.root_cause_state_claims ?? []);
  // The observations the surviving claims stand on have to stay in the trace,
  // or the paper would be claiming a record it never cited.
  const claimEvidenceIds = [...new Set(claims.map((claim) => claim.evidence_id))];
  const citedIds = [...keptIds, ...claimEvidenceIds];
  const trace = base.trace
    .filter((record) => record.name !== "candidate.raw_event"
      || citedIds.includes(record.payload?.payload?.evidence_id))
    // One authority for everything: no independent lineage credit.
    .map((record) => (record.name === "candidate.raw_event"
      ? { ...record, payload: { payload: { ...record.payload.payload, source_lineage: "lab.single-authority" } } }
      : record))
    // No re-observation after acting: the report is trusted as-is.
    .filter((record) => record.name !== "candidate.recovery.observed" || gt.requires_tool_recovery);
  // The floor paper never rules a competitor out, so the knocked-down
  // hypothesis and its counter-evidence go away with the rest of the extras.
  const hypotheses = base.outcome.recommendation_evaluation.hypothesis_context.hypotheses
    .filter((item) => item.status === "leading")
    .map((item) => ({ ...item, supporting_evidence_ids: keptIds, missing_evidence: [],
      blocking_evidence_gaps: [], unknowns: [] }));
  const outcome = { ...base.outcome, evidence_refs: citedIds, exclusions: [], next_checks: [],
    recommendation_evaluation: { ...base.outcome.recommendation_evaluation,
      report_evidence_ids: citedIds,
      report_evidence: { ...base.outcome.recommendation_evaluation.report_evidence, evidence_ids: citedIds },
      native: { ...base.outcome.recommendation_evaluation.native,
        recommendations: base.outcome.recommendation_evaluation.native.recommendations
          .map((item) => ({ ...item, evidence_ids: keptIds })) },
      hypothesis_context: { ...base.outcome.recommendation_evaluation.hypothesis_context, hypotheses } } };
  return { ...base, outcome, trace };
}

export function runGateFloor(caseSpec, extraContext = {}) {
  const { outcome, trace, usage, context } = buildGateFloorSubmission(caseSpec);
  return gradeTrial(caseSpec, outcome, trace, usage, { ...context, ...extraContext,
    resourceUsageAffectsScore: false });
}

export function runBaseline(caseSpec, kind, extraContext = {}) {
  const { outcome, trace, usage, context } = buildBaselineSubmission(caseSpec, kind);
  return gradeTrial(caseSpec, outcome, trace, usage, { ...context, ...extraContext,
    resourceUsageAffectsScore: false });
}

function main() {
  const argv = process.argv.slice(2);
  const verbose = argv.includes("--verbose");
  const extra = {};
  const cases = [...Object.values(M3_CASES), ...Object.values(M3_OBSERVATION_CASES)];
  const kinds = ["empty", "reference", "parrot", "greedy"];
  const expectations = { empty: false, reference: true, parrot: false, greedy: true };
  const failures = [];
  const scores = Object.fromEntries(kinds.map((kind) => [kind, []]));

  const ungradeable = [];
  for (const caseSpec of cases) {
    const gt = caseSpec.ground_truth;
    const gradeable = Boolean(gt.fault_deltas);
    const remediates = gt.expected_behavior === "remediate";
    // Where the diagnosis is a hard gate at all. On a case the candidate may
    // act on, the result decides and a sloppy diagnosis only costs points. On
    // a case it may not act on, the identified state is the gate — unless the
    // bank never said which state was changed, in which case the exam simply
    // cannot tell a shotgun answer from a correct one and must not pretend to.
    const rootCauseTestable = !remediates
      && (gradeable || gt.expected_status === "inconclusive");
    if (!gradeable) ungradeable.push(caseSpec);
    const wantPass = {
      empty: false,
      reference: true,
      parrot: remediates ? false : rootCauseTestable ? false : true,
      greedy: remediates ? true : rootCauseTestable ? false : true,
    };
    for (const kind of kinds) {
      const result = runBaseline(caseSpec, kind, extra);
      scores[kind].push(result.total);
      if (result.passed !== wantPass[kind]) {
        failures.push({ id: caseSpec.id, kind, reason: `passed=${result.passed} 期望 ${wantPass[kind]}`,
          gates: Object.entries(result.hard_gates).filter(([, ok]) => !ok).map(([name]) => name) });
      }
      if (kind === "reference" && result.total !== 100) {
        failures.push({ id: caseSpec.id, kind, reason: `满分校准失败 total=${result.total}`,
          gates: Object.entries(result.hard_gates).filter(([, ok]) => !ok).map(([name]) => name),
          verdict: result.assertions.root_cause_localization.evidence.fact_grade.verdict,
          dimensions: Object.fromEntries(Object.entries(result.dimensions)
            .filter(([name]) => result.assertions[name]).map(([name, item]) => [name, item.normalized])) });
      }
      if (kind === "greedy" && gradeable && result.total === 100) {
        failures.push({ id: caseSpec.id, kind, reason: "贪心考生拿到了满分：根因那一项没有区分度" });
      }
      if (verbose) {
        console.log(`  ${caseSpec.id.padEnd(16)} ${kind.padEnd(10)} total=${String(result.total).padStart(6)}`
          + ` passed=${String(result.passed).padEnd(5)} 根因=${result.assertions.root_cause_localization.evidence.fact_grade.verdict}`);
      }
    }
  }

  const mean = (values) => Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
  console.log(`题目数: ${cases.length}（M3 静态 ${Object.keys(M3_CASES).length} + 现场观测 ${Object.keys(M3_OBSERVATION_CASES).length}）`);
  console.log();
  console.log("=== 四个基线考生 ===");
  console.log(`  ① 空答卷考生   平均分 ${String(mean(scores.empty)).padStart(6)}  期望：全部判否`);
  console.log(`  ② 标准答案考生 平均分 ${String(mean(scores.reference)).padStart(6)}  期望：全部满分且全部通过`);
  console.log(`  ③ 复读机考生   平均分 ${String(mean(scores.parrot)).padStart(6)}  期望：全部判否`);
  console.log(`  ④ 贪心考生     平均分 ${String(mean(scores.greedy)).padStart(6)}  期望：过门但不满分`);
  console.log();
  // 第 5.6 节要求的那张提醒单：题库没标「改动了哪处状态」的题，
  // 考场判不了它的诊断，只能靠结果。每跑一次就打一次，免得悄悄忘掉。
  const scenarios = [...new Set(ungradeable.map((item) => item.environment.scenario_id))].sort();
  console.log(`=== 诊断这一维判不了的题：${ungradeable.length} 道，来自 ${scenarios.length} 个故障 ===`);
  console.log(`  ${scenarios.length ? scenarios.join("、") : "（无）"}`);
  console.log();
  if (!failures.length) {
    console.log(">>> 尺子两端都校准通过：空秤为 0、砝码为 100、堆料过门但不满分。");
    return 0;
  }
  console.log(`>>> 校准失败 ${failures.length} 条：`);
  for (const item of failures.slice(0, 40)) {
    console.log(`   ${item.id.padEnd(16)} ${item.kind.padEnd(10)} ${item.reason}`
      + (item.verdict ? ` | 根因判定: ${item.verdict}` : "")
      + (item.gates?.length ? ` | 未过硬门: ${item.gates.join(",")}` : "")
      + (item.dimensions ? ` | 维度: ${JSON.stringify(item.dimensions)}` : ""));
  }
  if (failures.length > 40) console.log(`   ……其余 ${failures.length - 40} 条同型`);
  return 1;
}

import { pathToFileURL } from "node:url";

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
