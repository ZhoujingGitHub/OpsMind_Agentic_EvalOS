// 只读探针 4：量两处怀疑有机械性缺陷的地方。
//
//  E 禁止主张（forbidden_claims）检测：它是硬门 no_forbidden_claim 的唯一实现。
//    normalizeClaim 对"标签"和"答卷"走同一套替换，但替换产物的空格不一样：
//    标签 amf-process-down → 连字符被 [^\p{L}\p{N}]+ 换成空格 → "amf 进程 停止"
//    答卷「AMF 服务未运行」→ 中文同义词规则直接产出「进程停止」（没有空格）
//    如果真是这样，最自然的中文错答会绕过这道硬门。必须实测。
//
//  F exclusions 对根因满分的隐性要求：
//    rca_quality = rootCauseHit ? (exclusions 非空 || 没有 forbidden_claims ? 1 : 0.8) : 0
//    本题有 forbidden_claims，所以不写 exclusions 就只能拿 0.8——考生可见的任务契约里没有这条。
//
// 用法（EvalOS 仓根目录）： node _work/claude-takeover-20260911/tools/grader-probe4.mjs

import { gradeObservableOutcome, gradeTrial } from "../../../packages/kernel/src/grader.mjs";
import { M3_OBSERVATION_CASES } from "../../../packages/kernel/src/m3-observation-cases.mjs";

const CASE = M3_OBSERVATION_CASES["M3-OBS-001"];
console.log("禁止主张标签:", JSON.stringify(CASE.ground_truth.forbidden_claims));
console.log();

console.log("#".repeat(96));
console.log("E 组：把「AMF 进程挂了」这个错答用各种说法写出来，看硬门拦不拦");
console.log("#".repeat(96));
const WRONG_ANSWERS = {
  "连字符原样（等于标签）": "根因是 amf-process-down。",
  "英文 amf process down": "The root cause is amf process down.",
  "英文 AMF process is down": "The AMF process is down.",
  "英文 AMF service is not running": "The AMF service is not running.",
  "中文：AMF 服务未运行": "AMF 服务未运行。",
  "中文：AMF 进程未运行": "AMF 进程未运行。",
  "中文：AMF 服务已停止": "AMF 服务已停止。",
  "中文：AMF 进程停止运行": "AMF 进程停止运行。",
  "中文：AMF 进程不可用": "AMF 进程不可用。",
  "中文：AMF 挂了": "AMF 挂了。",
};
for (const [label, text] of Object.entries(WRONG_ANSWERS)) {
  const grade = gradeObservableOutcome(CASE, { status: "resolved", root_cause: text, evidence_refs: [] }, []);
  console.log(`  ${grade.forbiddenAsserted ? "拦住" : "漏过"} | ${label.padEnd(30)} | forbiddenAsserted=${grade.forbiddenAsserted}`);
}
console.log();
console.log("  （注：漏过这道硬门不等于能拿分——根因匹配那一关仍会判否。");
console.log("    但 no_forbidden_claim 这道门的设计意图是专门识别这个错答，漏过就说明它名不副实。）");
console.log();

console.log("#".repeat(96));
console.log("F 组：exclusions 写不写，对根因维度的影响");
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
for (const [label, exclusions] of Object.entries({
  "不写 exclusions": [],
  "写了一条 exclusions": ["amf-process-down"],
  "写了一条无关的 exclusions": ["天气不好"],
})) {
  const r = gradeTrial(CASE, { status: "resolved", root_cause: RIGHT, evidence_refs: [], exclusions }, TRACE, { tool_calls: 2 }, CONTEXT);
  console.log(`  根因维度 ${r.assertions.rca_quality.value} | 总分 ${String(r.total).padStart(6)} | ${label}`);
}
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
