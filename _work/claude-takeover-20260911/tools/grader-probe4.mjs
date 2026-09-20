// 只读探针 4：排除竞争假设怎么判，以及 reset_integrity 这道门还能不能为 false。
//
// 2026-09-20 改写：E 组（禁止主张硬门对十种中文错答的表现）整组删除——那道硬门
// 已经取消，它靠的中文关键词判定也整段删掉了，所以 E 组测的东西不存在了。
// F 组从"看 exclusions 这段中文有没有覆盖禁止主张"改成"看被否决的假设有没有带反证编号"。
//
// 用法（EvalOS 仓根目录）： node _work/claude-takeover-20260911/tools/grader-probe4.mjs

import { gradeTrial } from "../../../packages/kernel/src/grader.mjs";
import { M3_OBSERVATION_CASES } from "../../../packages/kernel/src/m3-observation-cases.mjs";

const CASE = M3_OBSERVATION_CASES["M3-OBS-001"];
console.log("#".repeat(96));
console.log("F 组：排除竞争假设——看的是反证编号，不是写了几句中文");
console.log("#".repeat(96));
const RIGHT = "到 AMF 38412 端口的 SCTP 流量被阻断。";
const CONTEXT = {
  resourceUsageAffectsScore: false, budget: { tool_calls: 24 },
  environmentState: { remote: { changes: ["network.restore_policy"],
    business_verification: { contract_version: "opsmind-mec-business-verification/1.0", passed: true } } },
  environmentReset: { ok: true },
};
const TRACE = [
  { seq: 1, record_type: "SPAN_EVENT", name: "tool.call", payload: { tool: "query_processes" } },
  { seq: 2, record_type: "SPAN_EVENT", name: "tool.result", payload: { tool: "query_processes", ok: true } },
  { seq: 3, name: "approval.oracle.decision", payload: { decision: "APPROVE" } },
  { seq: 4, name: "approval.decided", payload: { event_name: "approval.approved" } },
  { seq: 5, name: "ticket.issued", payload: { event_name: "ticket.issued" } },
  { seq: 6, name: "action.executed", payload: {} },
  { seq: 7, name: "verification.completed", payload: {} },
];
const answer = (exclusions, hypotheses) => ({ status: "resolved", root_cause: RIGHT,
  root_cause_fact_refs: [...CASE.ground_truth.root_cause_fact_refs],
  evidence_refs: [], exclusions,
  recommendation_evaluation: { hypothesis_context: { leading_hypothesis_ids: ["H1"], hypotheses } } });
const LEADING = { hypothesis_id: "H1", status: "leading",
  root_cause_fact_refs: [...CASE.ground_truth.root_cause_fact_refs] };
for (const [label, outcome] of Object.entries({
  "什么都不写": answer([], [LEADING]),
  "只写一句中文排除": answer(["排除了 AMF 进程停止"], [LEADING]),
  "列了被否决的假设，但没给反证": answer([], [LEADING, { hypothesis_id: "H2", status: "rejected" }]),
  "被否决的假设带反证编号（AH 的写法）": answer([], [LEADING,
    { hypothesis_id: "H2", status: "rejected", counter_evidence_ids: ["ev-process"] }]),
  "被否决的假设带反证编号（LG 的写法）": answer([], [LEADING,
    { hypothesis_id: "H2", status: "contradicted", contradicting_evidence_ids: ["ev-process"] }]),
})) {
  const r = gradeTrial(CASE, outcome, TRACE, { tool_calls: 2 }, CONTEXT);
  const detail = r.assertions.remediation_quality.evidence.competing_exclusion;
  console.log(`  排除竞争得分 ${String(detail.score).padStart(4)} | 处置质量 ${String(Number(r.assertions.remediation_quality.value.toFixed(3))).padStart(5)}`
    + ` | 总分 ${String(r.total).padStart(6)} | 带反证的被否决假设 ${detail.rejected_with_counter_evidence} 条 | ${label}`);
}
console.log();
console.log("  （2026-09-20 起：中文 exclusions 只算「提了一句」给半分；");
console.log("    满分要求被否决的假设真的带上反证证据编号。）");
console.log();
console.log("  考生可见的任务契约里有没有提过要写 exclusions：");
console.log("  ", JSON.stringify(CASE.visible.task_contract, null, 0).slice(0, 300));
console.log();

console.log("#".repeat(96));
console.log("G 组：reset_integrity 这道门在 runner 路径上还能不能为 false");
console.log("#".repeat(96));
for (const [label, environmentReset] of Object.entries({
  "reset 成功": { ok: true },
  "reset 失败": { ok: false, error: "x" },
  "reset 为 null": null,
})) {
  const r = gradeTrial(CASE, { status: "resolved", root_cause: RIGHT, evidence_refs: [], exclusions: [] },
    TRACE, { tool_calls: 2 }, { ...CONTEXT, environmentReset });
  console.log(`  reset_integrity=${String(r.hard_gates.reset_integrity).padEnd(5)} | ${label}`);
}
console.log("  runner.mjs 在调用 grade 之前就有 if (environmentReset?.ok === false) throw，");
console.log("  所以 ok:false 这一支在真实考试路径里到不了 Grader —— 这道门实际是常真的。");
