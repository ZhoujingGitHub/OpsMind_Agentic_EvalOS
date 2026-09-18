// 只读探针 5：量全部 80 道题在开放资源车道下的真实分母分布。
//
// 声明权重合计 100，但 gradeTrial 会把 applicable===false 的维度从分子分母同时剔除。
// 所以"某维度占 15 分"这句话对具体某道题可能完全不成立。本脚本按题逐一算。
//
// 用法（EvalOS 仓根目录）： node _work/claude-takeover-20260911/tools/grader-probe5.mjs

import { M3_CASES } from "../../../packages/kernel/src/m3-cases.mjs";

const WEIGHTS = { task_success: 25, rca_quality: 15, evidence_quality: 15, trajectory_quality: 15,
  open_world: 15, proactive_capability: 5, resource_cost: 5, engineering_agility: 5 };

// 复刻 gradeTrial 里的 applicable 判据（开放资源车道：resourceUsageAffectsScore=false）
function applicability(item) {
  const expectedStatus = item.ground_truth.expected_status ?? "resolved";
  const recoveryRequired = Boolean(item.ground_truth.requires_tool_recovery);
  return {
    task_success: true,
    rca_quality: true,
    evidence_quality: true,
    trajectory_quality: true,
    open_world: recoveryRequired || expectedStatus === "inconclusive",
    proactive_capability: Boolean(item.visible?.trigger_type === "proactive" || item.ground_truth?.proactive_expected),
    resource_cost: false,       // usage_affects_score=false → 永不适用
    engineering_agility: false, // 代码里写死 applicable:false
  };
}

const rows = Object.values(M3_CASES).map((item) => {
  const app = applicability(item);
  const denom = Object.entries(WEIGHTS).reduce((sum, [name, w]) => sum + (app[name] ? w : 0), 0);
  return { id: item.id, partition: item.ground_truth.partition, mode: item.visible.operating_mode,
    expected: item.ground_truth.expected_status, behavior: item.ground_truth.expected_behavior,
    recovery: Boolean(item.ground_truth.requires_tool_recovery), app, denom,
    required_evidence: (item.ground_truth.required_evidence ?? []).length,
    forbidden: (item.ground_truth.forbidden_claims ?? []).length,
    anchorSets: (item.ground_truth.root_cause_anchor_sets ?? []).length,
    labels: (item.ground_truth.root_causes ?? []).length };
});

console.log("题目总数:", rows.length);
console.log();

const byDenom = {};
for (const r of rows) byDenom[r.denom] = (byDenom[r.denom] ?? 0) + 1;
console.log("=== 真实分母分布（开放资源车道）===");
for (const [d, n] of Object.entries(byDenom).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  分母 ${String(d).padStart(3)} 分 : ${String(n).padStart(2)} 道题   （声明 100 分中有 ${100 - Number(d)} 分不参与）`);
}
console.log();

console.log("=== 各维度在多少道题上真正参与计分 ===");
for (const name of Object.keys(WEIGHTS)) {
  const n = rows.filter((r) => r.app[name]).length;
  console.log(`  ${name.padEnd(22)} 权重 ${String(WEIGHTS[name]).padStart(2)} | 参与 ${String(n).padStart(2)}/80 道`);
}
console.log();

console.log("=== 根因判定的真值规模（决定词汇敏感度的暴露面）===");
const noAnchor = rows.filter((r) => r.anchorSets === 0);
console.log(`  有锚点集合的题: ${rows.length - noAnchor.length}/80 ；没有锚点集合、只靠整串标签匹配的: ${noAnchor.length}/80`);
const labelCounts = {};
for (const r of rows) labelCounts[r.labels] = (labelCounts[r.labels] ?? 0) + 1;
console.log("  每题的真值标签条数分布:", JSON.stringify(labelCounts));
const anchorCounts = {};
for (const r of rows) anchorCounts[r.anchorSets] = (anchorCounts[r.anchorSets] ?? 0) + 1;
console.log("  每题的锚点集合数分布:  ", JSON.stringify(anchorCounts));
console.log();

console.log("=== 禁止主张与要求证据 ===");
const fb = {}; for (const r of rows) fb[r.forbidden] = (fb[r.forbidden] ?? 0) + 1;
console.log("  forbidden_claims 条数分布:", JSON.stringify(fb));
console.log(`  有 forbidden_claims 的题（不写 exclusions 就只能拿 0.8 根因分）: ${rows.filter((r) => r.forbidden > 0).length}/80`);
const re = {}; for (const r of rows) re[r.required_evidence] = (re[r.required_evidence] ?? 0) + 1;
console.log("  required_evidence 条数分布:", JSON.stringify(re));
console.log();

console.log("=== 期望行为 / 运行模式交叉 ===");
const cross = {};
for (const r of rows) {
  const key = `${r.mode} + ${r.behavior}`;
  cross[key] = (cross[key] ?? 0) + 1;
}
for (const [k, v] of Object.entries(cross).sort()) console.log(`  ${k.padEnd(42)} ${v} 道`);
console.log();
const inconclusive = rows.filter((r) => r.expected === "inconclusive");
console.log(`  expected_status=inconclusive 的题: ${inconclusive.length}/80`);
console.log(`  requires_tool_recovery=true 的题: ${rows.filter((r) => r.recovery).length}/80`);
