#!/usr/bin/env node
// 三个基线考生：先校尺子，再量东西。纯本地、只读、毫秒级，不连服务器。
//
//   ① 空答卷考生    什么都不做，交白卷        →  必须挂
//   ② 标准答案考生  直接按真值填完美答卷      →  必须满分且必须过
//   ③ 复读机考生    把看到的编号全填成根因    →  必须挂
//
// 像校体重秤：空秤应显示 0，放已知砝码应显示 100，堆一堆轻东西不该显示 100。
// ② 拿不到满分，是**考卷**有问题，不是考生有问题——用它逐题验证题库标注。
//
// 用法（EvalOS 仓根目录）：
//   node _work/claude-takeover-20260911/tools/grader-baseline-agents.mjs
//   node _work/claude-takeover-20260911/tools/grader-baseline-agents.mjs --criterion text
//   node _work/claude-takeover-20260911/tools/grader-baseline-agents.mjs --verbose

import { gradeTrial } from "../../../packages/kernel/src/grader.mjs";
import { M3_CASES } from "../../../packages/kernel/src/m3-cases.mjs";
import { M3_OBSERVATION_CASES } from "../../../packages/kernel/src/m3-observation-cases.mjs";

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

function candidateEvent(seq, name, eventName, payload = {}) {
  return { seq, record_type: "SPAN_EVENT", name, payload: { event_name: eventName, ...payload } };
}

function hypothesis(caseSpec, evidenceIds, { factRefs, statement }) {
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
    root_cause_fact_refs: [...factRefs],
    blocking_evidence_gaps: [],
    missing_evidence: ["注入主体与关联变更单属于事后溯源，不改变本次因果判定"],
    unknowns: [{ gap: "注入主体与关联变更单", blocks_root_cause: false,
      unavailable_reason: "事后溯源，超出本次只读授权" }],
  };
}

function recommendationView(caseSpec, evidenceIds, hypotheses) {
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
    report_evidence_ids: [...evidenceIds],
    report_evidence: { status: "published", evidence_ids: [...evidenceIds], hypotheses: [], errors: [] },
  };
}

/**
 * Build one synthetic submission for one case.
 *
 * `kind` is "empty" | "reference" | "parrot". The reference submission is the
 * ground truth written back as an answer; if the grader does not give it full
 * marks, the case sheet is wrong.
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
  if (gt.requires_tool_recovery) {
    trace.push({ seq: seq += 1, record_type: "SPAN_EVENT", name: "candidate.tool.failed", payload: {} });
    trace.push({ seq: seq += 1, record_type: "SPAN_EVENT", name: "candidate.recovery.observed", payload: {} });
  }
  trace.push({ seq: seq += 1, record_type: "SPAN_START", span_kind: "TOOL", name: "tool.query_processes", payload: {} });
  trace.push({ seq: seq += 1, record_type: "SPAN_END", span_kind: "TOOL", name: "tool.query_processes",
    payload: { result: { ok: true } } });

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

  const factRefs = kind === "parrot"
    // Everything it saw, nominated as the cause. Precision, not recall, is the
    // thing being tested here.
    ? [...new Set([...required, ...(gt.root_cause_fact_refs ?? []),
      ...(gt.root_cause_adjacent_refs ?? [])])]
    : [...(gt.root_cause_fact_refs ?? [])];
  const statement = String(gt.root_causes?.[0] ?? "");
  const hypotheses = [hypothesis(caseSpec, evidenceIds, { factRefs, statement })];
  const outcome = {
    status: expectedStatus,
    root_cause: statement,
    root_cause_fact_refs: factRefs,
    confidence: 0.9,
    evidence_refs: [...evidenceIds],
    exclusions: [...(gt.forbidden_claims ?? [])],
    next_checks: ["注入主体与关联变更单属于事后溯源"],
    recommendation_evaluation: recommendationView(caseSpec, evidenceIds, hypotheses),
  };
  const context = {
    environmentState: { remote: { changes,
      business_verification: remediates
        ? { contract_version: BUSINESS_CONTRACT, passed: true, status: "recovered" } : null } },
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
  const trace = base.trace
    .filter((record) => record.name !== "candidate.raw_event"
      || keptIds.includes(record.payload?.payload?.evidence_id))
    // One authority for everything: no independent lineage credit.
    .map((record) => (record.name === "candidate.raw_event"
      ? { ...record, payload: { payload: { ...record.payload.payload, source_lineage: "lab.single-authority" } } }
      : record))
    // No re-observation after acting: the report is trusted as-is.
    .filter((record) => record.name !== "candidate.recovery.observed" || gt.requires_tool_recovery);
  const hypotheses = base.outcome.recommendation_evaluation.hypothesis_context.hypotheses
    .map((item) => ({ ...item, supporting_evidence_ids: keptIds, missing_evidence: [],
      blocking_evidence_gaps: [], unknowns: [] }));
  const outcome = { ...base.outcome, evidence_refs: keptIds, exclusions: [], next_checks: [],
    recommendation_evaluation: { ...base.outcome.recommendation_evaluation,
      report_evidence_ids: keptIds,
      report_evidence: { ...base.outcome.recommendation_evaluation.report_evidence, evidence_ids: keptIds },
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
  const criterionIndex = argv.indexOf("--criterion");
  const extra = criterionIndex >= 0 ? { rootCauseCriterion: argv[criterionIndex + 1] } : {};
  const cases = [...Object.values(M3_CASES), ...Object.values(M3_OBSERVATION_CASES)];
  const expectations = { empty: false, reference: true, parrot: false };
  const failures = [];
  const scores = { empty: [], reference: [], parrot: [] };

  for (const caseSpec of cases) {
    for (const kind of ["empty", "reference", "parrot"]) {
      const result = runBaseline(caseSpec, kind, extra);
      scores[kind].push(result.total);
      const wantPass = expectations[kind];
      if (result.passed !== wantPass) {
        failures.push({ id: caseSpec.id, kind, reason: `passed=${result.passed} 期望 ${wantPass}`,
          gates: Object.entries(result.hard_gates).filter(([, ok]) => !ok).map(([name]) => name) });
      }
      if (kind === "reference" && result.total !== 100) {
        failures.push({ id: caseSpec.id, kind, reason: `满分校准失败 total=${result.total}`,
          gates: Object.entries(result.hard_gates).filter(([, ok]) => !ok).map(([name]) => name),
          dimensions: Object.fromEntries(Object.entries(result.dimensions)
            .filter(([name]) => result.assertions[name]).map(([name, item]) => [name, item.normalized])) });
      }
      if (verbose) {
        console.log(`  ${caseSpec.id.padEnd(16)} ${kind.padEnd(10)} total=${String(result.total).padStart(6)}`
          + ` passed=${String(result.passed).padEnd(5)} 根因=${result.assertions.root_cause_localization.evidence.fact_grade.verdict}`);
      }
    }
  }

  const mean = (values) => Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
  console.log(`题目数: ${cases.length}（M3 静态 ${Object.keys(M3_CASES).length} + 现场观测 ${Object.keys(M3_OBSERVATION_CASES).length}）`);
  if (criterionIndex >= 0) console.log(`判据: ${argv[criterionIndex + 1]}`);
  console.log();
  console.log("=== 三个基线考生 ===");
  console.log(`  ① 空答卷考生   平均分 ${String(mean(scores.empty)).padStart(6)}  期望：全部判否`);
  console.log(`  ② 标准答案考生 平均分 ${String(mean(scores.reference)).padStart(6)}  期望：全部满分且全部通过`);
  console.log(`  ③ 复读机考生   平均分 ${String(mean(scores.parrot)).padStart(6)}  期望：全部判否`);
  console.log();
  if (!failures.length) {
    console.log(">>> 尺子两端都校准通过：空秤为 0、砝码为 100、堆料不满分。");
    return 0;
  }
  console.log(`>>> 校准失败 ${failures.length} 条：`);
  for (const item of failures.slice(0, 40)) {
    console.log(`   ${item.id.padEnd(16)} ${item.kind.padEnd(10)} ${item.reason}`
      + (item.gates?.length ? ` | 未过硬门: ${item.gates.join(",")}` : "")
      + (item.dimensions ? ` | 维度: ${JSON.stringify(item.dimensions)}` : ""));
  }
  if (failures.length > 40) console.log(`   ……其余 ${failures.length - 40} 条同型`);
  return 1;
}

import { pathToFileURL } from "node:url";

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
