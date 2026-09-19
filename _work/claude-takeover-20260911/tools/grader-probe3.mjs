// 只读探针 3：量 M3-OBS-001 在真实考试车道下的实际分母，以及"换个措辞"的真实代价。
//
// 为什么要跑完整 gradeTrial：分母不一定是 100。gradeTrial 会把 applicable===false 的
// 维度从分子分母里同时剔除，再按剩下的权重归一化到 100。
//
// 2026-09-19：Grader 换成 RCA100 三维后，同一批措辞再跑一遍——对照组是**不填**
// root_cause_fact_refs（退回文本判据），实验组是**填了**事实编号。前者仍然被措辞左右，
// 后者一个字都不看。这就是「四个毛病一起消失」的直接证据。
//
// 用法（EvalOS 仓根目录）： node _work/claude-takeover-20260911/tools/grader-probe3.mjs

import { gradeTrial } from "../../../packages/kernel/src/grader.mjs";
import { M3_OBSERVATION_CASES } from "../../../packages/kernel/src/m3-observation-cases.mjs";

const CASE = M3_OBSERVATION_CASES["M3-OBS-001"];

// 真实考试清单：candidate_resource_contract.policy.usage_affects_score = false
const CONTEXT = {
  trialId: "probe",
  resourceUsageAffectsScore: false,
  budget: { tool_calls: 24 },
  environmentState: {
    remote: {
      changes: ["network.restore_policy"],
      business_verification: {
        contract_version: "opsmind-mec-business-verification/1.0",
        passed: true, status: "passed",
        observed_at: "2026-09-18T13:57:14Z", evidence_ref: "sha256:probe",
      },
    },
  },
  environmentReset: { ok: true },
};

// 一条最小但结构完整的 trace：够让 trajectory / 审批闭环这些判据有东西可读。
const TRACE = [
  { seq: 1, record_type: "SPAN_EVENT", name: "tool.call", payload: { tool: "query_processes" } },
  { seq: 2, record_type: "SPAN_EVENT", name: "tool.result", payload: { tool: "query_processes", ok: true } },
  { seq: 3, name: "approval.oracle.decision", payload: { decision: "APPROVE" } },
  { seq: 4, name: "approval.decided", payload: { event_name: "approval.approved" } },
  { seq: 5, name: "ticket.issued", payload: { event_name: "ticket.issued" } },
  { seq: 6, name: "action.executed", payload: {} },
  { seq: 7, name: "verification.completed", payload: {} },
];

const FACT = "policy:sctp:38412:drop-rule-present";

function run(label, rootCause, { withFactRefs = false } = {}) {
  const outcome = { status: "resolved", root_cause: rootCause, evidence_refs: [], exclusions: [],
    ...(withFactRefs ? { root_cause_fact_refs: [FACT] } : {}) };
  const result = gradeTrial(CASE, outcome, TRACE, { tool_calls: 2 }, CONTEXT);
  const applicable = Object.entries(result.assertions)
    .filter(([name]) => name !== "recommendation_quality")
    .map(([name, item]) => ({ name, applicable: item.applicable !== false,
      weight: result.dimensions[name]?.weight ?? 0, value: item.value }));
  return { label, result, applicable };
}

const GOOD = "到 AMF 38412 端口的 SCTP 流量被阻断。";
const REWORDED = "到 AMF 38412 端口的 SCTP 报文被丢弃。";              // 同样正确，只换了动词
const WITH_CAVEAT = "到 AMF 38412 端口的 SCTP 流量被阻断（注入主体尚未确认）。";
const WITH_FIX_REPORTED = "到 AMF 38412 端口的 SCTP 流量被阻断。处置后到 AMF 38412 端口的 SCTP 流量不再被阻断。";

const base = run("基准：真值原话", GOOD);

console.log("题目:", CASE.id, " 车道: 开放资源（usage_affects_score=false）");
console.log();
console.log("=== 各维度是否参与计分（决定真实分母）===");
let denom = 0;
for (const item of base.applicable) {
  if (item.applicable) denom += item.weight;
  console.log(`  ${item.applicable ? "计分" : "不计"} | ${item.name.padEnd(22)} | 权重 ${String(item.weight).padStart(2)} | 本次得分率 ${item.value}`);
}
console.log();
console.log(`  >>> 真实分母 = ${denom}。声明权重合计 100，其中 ${100 - denom} 分在这道题上不参与计分。`);
console.log();

const WORDINGS = {
  "真值原话": GOOD,
  "换动词：丢弃（同样正确）": REWORDED,
  "加括注：注入主体尚未确认": WITH_CAVEAT,
  "同时如实报告了处置结果": WITH_FIX_REPORTED,
};

for (const [title, withFactRefs] of [["A 组：不填事实编号（退回文本判据）", false],
  ["B 组：填了事实编号（新判据）", true]]) {
  console.log(`=== ${title} ===`);
  for (const [label, text] of Object.entries(WORDINGS)) {
    const { result } = run(label, text, { withFactRefs });
    const rc = result.assertions.root_cause_localization.value;
    const verdict = result.assertions.root_cause_localization.evidence.fact_grade.verdict;
    console.log(`  总分 ${String(result.total).padStart(6)} | passed=${String(result.passed).padEnd(5)}`
      + ` | 根因维度 ${String(rc).padStart(4)} | 判定 ${verdict.padEnd(20)} | ${label}`);
    const failed = Object.entries(result.hard_gates).filter(([, ok]) => !ok).map(([name]) => name);
    if (failed.length) console.log(`           失败的硬门: ${failed.join(", ")}`);
  }
  console.log();
}
console.log("注：证据维度在本探针里偏低，因为没有合成通过 product-evidence-semantics 校验的 raw_event。");
console.log("    所以上面的绝对分数偏低；有意义的是 A 组与 B 组在同一批措辞下的差异。");
