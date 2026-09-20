// 只读探针 5：量全部 80 道题在真实考试车道下的分母分布与题库结构。
//
// 2026-09-19 重写：原版在探针里抄了一份 WEIGHTS，Grader 换成 RCA100 三维之后
// 那份抄件就变成了镜子里的旧脸。现在权重从 Grader 自己导出，抄不动了。
//
// 用法（EvalOS 仓根目录）： node _work/claude-takeover-20260911/tools/grader-probe5.mjs

import { GRADER_WEIGHTS, GRADER_SUB_WEIGHTS } from "../../../packages/kernel/src/grader.mjs";
import { M3_CASES } from "../../../packages/kernel/src/m3-cases.mjs";
import { runBaseline } from "./grader-baseline-agents.mjs";

const cases = Object.values(M3_CASES);
console.log("题目总数:", cases.length);
console.log();

console.log("=== 声明的权重表（从 Grader 导出，不是抄件）===");
for (const [name, weight] of Object.entries(GRADER_WEIGHTS)) {
  const subs = Object.entries(GRADER_SUB_WEIGHTS[name])
    .map(([sub, value]) => `${sub} ${value}`).join(" + ");
  console.log(`  ${name.padEnd(24)} ${String(weight).padStart(3)} 分 = ${subs}`);
}
console.log();

console.log("=== 真实分母分布（用标准答案考生跑一遍真 Grader 量出来的）===");
const denominators = {};
for (const item of cases) {
  const result = runBaseline(item, "reference");
  const denominator = Object.entries(GRADER_WEIGHTS)
    .reduce((sum, [name, weight]) => sum + (result.assertions[name].applicable === false ? 0 : weight), 0);
  denominators[denominator] = (denominators[denominator] ?? 0) + 1;
}
for (const [denominator, count] of Object.entries(denominators).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  分母 ${String(denominator).padStart(3)} 分 : ${String(count).padStart(2)} 道题`
    + `   （${100 - Number(denominator) === 0 ? "全部维度都参与" : `处置质量 ${100 - Number(denominator)} 分不适用：只诊断题`}）`);
}
console.log();

console.log("=== 根因判定的真值规模 ===");
const factCounts = {}, adjacentCounts = {};
let missingFacts = 0;
for (const item of cases) {
  const facts = item.ground_truth.root_cause_fact_refs ?? [];
  if (!facts.length) missingFacts += 1;
  factCounts[facts.length] = (factCounts[facts.length] ?? 0) + 1;
  const adjacent = (item.ground_truth.root_cause_adjacent_refs ?? []).length;
  adjacentCounts[adjacent] = (adjacentCounts[adjacent] ?? 0) + 1;
}
console.log(`  有判别性事实的题: ${cases.length - missingFacts}/${cases.length}`);
console.log(`  每题的事实编号条数分布（含活/静两套词表）: ${JSON.stringify(factCounts)}`);
console.log(`  每题的拓扑相邻标识数分布: ${JSON.stringify(adjacentCounts)}`);
console.log(`  有锚点集合的题（2026-09-20 起已无任何判定读它）: ${
  cases.filter((item) => (item.ground_truth.root_cause_anchor_sets ?? []).length).length}/${cases.length}`);
console.log();

console.log("=== 禁止主张与要求证据 ===");
const forbiddenCounts = {}, requiredCounts = {}, lineageTargets = {};
for (const item of cases) {
  const forbidden = (item.ground_truth.forbidden_claims ?? []).length;
  forbiddenCounts[forbidden] = (forbiddenCounts[forbidden] ?? 0) + 1;
  const required = item.ground_truth.required_evidence ?? [];
  requiredCounts[required.length] = (requiredCounts[required.length] ?? 0) + 1;
  const target = Math.min(3, Math.max(1, new Set(required.map((ref) => ref.split(":", 1)[0])).size));
  lineageTargets[target] = (lineageTargets[target] ?? 0) + 1;
}
console.log(`  forbidden_claims 条数分布（只是出题知识，任何判定都不读）: ${JSON.stringify(forbiddenCounts)}`);
console.log(`  required_evidence 条数分布: ${JSON.stringify(requiredCounts)}`);
console.log(`  独立血缘目标条数分布（本题自己的证据能跨几种来源）: ${JSON.stringify(lineageTargets)}`);
console.log();

console.log("=== 期望行为 / 运行模式 / 安全期望 ===");
const cross = {};
for (const item of cases) {
  const key = `${item.visible.operating_mode} + ${item.ground_truth.expected_behavior}`;
  cross[key] = (cross[key] ?? 0) + 1;
}
for (const [key, count] of Object.entries(cross).sort()) console.log(`  ${key.padEnd(42)} ${count} 道`);
console.log();
console.log(`  expected_status=inconclusive 的题: ${
  cases.filter((item) => item.ground_truth.expected_status === "inconclusive").length}/${cases.length}`);
console.log(`  requires_tool_recovery=true 的题: ${
  cases.filter((item) => item.ground_truth.requires_tool_recovery).length}/${cases.length}`);
console.log(`  带安全期望且带诱饵的题: ${
  cases.filter((item) => (item.ground_truth.security_expectations ?? []).length
    && (item.ground_truth.security_decoys ?? []).length).length}/${cases.length}`);
