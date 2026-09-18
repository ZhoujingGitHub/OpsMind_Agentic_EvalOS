// 只读探针 6：逐题算"8 道硬门全过时的最低可能总分"，用来判定 total>=75 这个条件
// 是不是空条件。不推算，按每道题自己的 required_evidence 条数和适用维度算。
//
// 用法（EvalOS 仓根目录）： node _work/claude-takeover-20260911/tools/grader-probe6.mjs

import { M3_CASES } from "../../../packages/kernel/src/m3-cases.mjs";
import { M3_OBSERVATION_CASES } from "../../../packages/kernel/src/m3-observation-cases.mjs";

const WEIGHTS = { task_success: 25, rca_quality: 15, evidence_quality: 15, trajectory_quality: 15,
  open_world: 15, proactive_capability: 5, resource_cost: 5, engineering_agility: 5 };
const PASS_LINE = 75;

// 硬门全过时，每个维度的**最低**得分率是多少（开放资源车道）
function minimumUnderPassingGates(item) {
  const gt = item.ground_truth;
  const expectedStatus = gt.expected_status ?? "resolved";
  const recoveryRequired = Boolean(gt.requires_tool_recovery);
  const n = (gt.required_evidence ?? []).length;

  // task_outcome 这道官方硬门 === task_success 的取值条件，所以过门即为 1
  const task = 1;
  // 根因命中是硬门；有 forbidden_claims 且不写 exclusions 时打八折
  const rca = (gt.forbidden_claims ?? []).length ? 0.8 : 1;
  // 硬门要求 精确率=1 且 召回率 >= min(1, 2/n)
  const minRecall = Math.min(1, 2 / Math.max(1, n));
  const evidence = (1 + minRecall) / 2;
  // 开放资源车道：调用过工具即 1；非回归题 recoveryPassed 恒真
  const trajectory = 1;
  // open_world 适用时，硬门全过 ⇒ recoveryPassed && statusHit ⇒ 1
  const openWorldApplicable = recoveryRequired || expectedStatus === "inconclusive";
  const proactiveApplicable = Boolean(item.visible?.trigger_type === "proactive" || gt.proactive_expected);

  const values = { task_success: task, rca_quality: rca, evidence_quality: evidence,
    trajectory_quality: trajectory, open_world: openWorldApplicable ? 1 : 0,
    proactive_capability: proactiveApplicable ? 1 : 0, resource_cost: 0, engineering_agility: 0 };
  const applicable = { task_success: true, rca_quality: true, evidence_quality: true,
    trajectory_quality: true, open_world: openWorldApplicable,
    proactive_capability: proactiveApplicable, resource_cost: false, engineering_agility: false };

  let num = 0, den = 0;
  for (const [name, w] of Object.entries(WEIGHTS)) {
    if (!applicable[name]) continue;
    den += w; num += values[name] * w;
  }
  return { total: Number((num / den * 100).toFixed(2)), den, n, minRecall,
    rcaDiscounted: rca === 0.8, openWorldApplicable };
}

const all = [...Object.values(M3_CASES), ...Object.values(M3_OBSERVATION_CASES)];
const rows = all.map((item) => ({ id: item.id, ...minimumUnderPassingGates(item) }));

rows.sort((a, b) => a.total - b.total);

console.log("题目数（含 M3-OBS-001）:", rows.length);
console.log("通过线 total >= ", PASS_LINE);
console.log();
console.log("=== 硬门全过时的最低可能总分（升序，前 10）===");
for (const r of rows.slice(0, 10)) {
  console.log(`  ${r.id.padEnd(12)} 最低 ${String(r.total).padStart(6)} | 分母 ${String(r.den).padStart(3)} | 要求证据 ${r.n} 条 → 最低召回 ${r.minRecall.toFixed(3)} | 根因打八折=${r.rcaDiscounted}`);
}
console.log();
const worst = rows[0];
console.log(`>>> 全题库最低 = ${worst.total} 分（${worst.id}）`);
console.log(`>>> 通过线 = ${PASS_LINE} 分`);
console.log(`>>> 差距 = ${(worst.total - PASS_LINE).toFixed(2)} 分`);
console.log();
const below = rows.filter((r) => r.total < PASS_LINE);
if (below.length === 0) {
  console.log("结论：没有任何一道题可能在「硬门全过」的同时低于通过线。");
  console.log("      total >= 75 是空条件 —— 过门必然过线。");
} else {
  console.log(`结论：有 ${below.length} 道题可能过门但不过线，通过线不是空条件：`);
  for (const r of below) console.log("   ", r.id, r.total);
}
console.log();
console.log("=== 按分母分组的最低分 ===");
const byDen = {};
for (const r of rows) {
  byDen[r.den] = byDen[r.den] ?? { n: 0, min: Infinity };
  byDen[r.den].n += 1;
  byDen[r.den].min = Math.min(byDen[r.den].min, r.total);
}
for (const [den, info] of Object.entries(byDen).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  分母 ${String(den).padStart(3)} | ${String(info.n).padStart(2)} 道 | 过门最低分 ${info.min}`);
}
