// 只读探针 6：逐题量「硬门全过时的最低可能总分」和「满分」，判断分数有没有区分度。
//
// 2026-09-19 重写：原版自己推算最低分（抄了一份权重表）。现在改成**真的跑 Grader**——
// 拿一份「刚好过完所有硬门、但每个可选项都拿最低分」的答卷跑一遍，量出来的就是地板。
// 顺带回答旧问题：total >= 75 这个条件已经从判定里删掉了，分数不再决定通过与否。
//
// 用法（EvalOS 仓根目录）： node _work/claude-takeover-20260911/tools/grader-probe6.mjs

import { M3_CASES } from "../../../packages/kernel/src/m3-cases.mjs";
import { M3_OBSERVATION_CASES } from "../../../packages/kernel/src/m3-observation-cases.mjs";
import { runBaseline, runGateFloor } from "./grader-baseline-agents.mjs";

const cases = [...Object.values(M3_CASES), ...Object.values(M3_OBSERVATION_CASES)];
const rows = cases.map((item) => {
  const floor = runGateFloor(item);
  const ceiling = runBaseline(item, "reference");
  const required = (item.ground_truth.required_evidence ?? []).length;
  return { id: item.id, floor: floor.total, floorPassed: floor.passed, ceiling: ceiling.total,
    behavior: item.ground_truth.expected_behavior, required,
    failedGates: Object.entries(floor.hard_gates).filter(([, ok]) => !ok).map(([name]) => name) };
});

const broken = rows.filter((row) => !row.floorPassed);
console.log("题目数（M3 静态 + 现场观测）:", rows.length);
console.log();
if (broken.length) {
  console.log(`!!! 有 ${broken.length} 道题的「最低过门答卷」并没有真的过门，说明这个探针造的卷子不合法：`);
  for (const row of broken.slice(0, 5)) console.log(`   ${row.id} 未过: ${row.failedGates.join(",")}`);
  console.log();
}

rows.sort((left, right) => left.floor - right.floor);
console.log("=== 硬门全过时的最低总分（升序，前 10）===");
for (const row of rows.slice(0, 10)) {
  console.log(`  ${row.id.padEnd(16)} 地板 ${String(row.floor).padStart(6)} | 满分 ${String(row.ceiling).padStart(6)}`
    + ` | 区分度 ${String(Number((row.ceiling - row.floor).toFixed(2))).padStart(6)} 分`
    + ` | 期望行为 ${row.behavior.padEnd(13)} | 要求证据 ${row.required} 条`);
}
console.log();

const worst = rows[0], best = rows[rows.length - 1];
console.log(`>>> 全题库最低（过门但最省力）= ${worst.floor} 分（${worst.id}）`);
console.log(`>>> 全题库最高（标准答案）   = 100 分`);
console.log(`>>> 过门之后的区分区间 = ${worst.floor} ~ 100，宽度 ${Number((100 - worst.floor).toFixed(2))} 分`);
console.log(`>>> 对照：改动前是 90.36 ~ 100，宽度 9.64 分`);
console.log();

console.log("=== 按期望行为分组 ===");
const groups = {};
for (const row of rows) {
  const group = groups[row.behavior] ?? { n: 0, floor: Infinity, ceiling: 0 };
  group.n += 1;
  group.floor = Math.min(group.floor, row.floor);
  group.ceiling = Math.max(group.ceiling, row.ceiling);
  groups[row.behavior] = group;
}
for (const [behavior, group] of Object.entries(groups).sort()) {
  console.log(`  ${behavior.padEnd(14)} | ${String(group.n).padStart(3)} 道 | 地板 ${String(group.floor).padStart(6)}`
    + ` | 满分 ${group.ceiling} | 区分度 ${Number((group.ceiling - group.floor).toFixed(2))} 分`);
}
console.log();
console.log("注：地板之所以还不是 0，是因为十个细项里有三个本身就是硬门");
console.log("    （证据可溯源、最小变更、独立验证报告）——过了门就必然拿到那几分。");
console.log("    真正的可变部分是：必需证据召回、独立血缘、带证据排除竞争、缺口分级。");
console.log();
console.log("=== 通过线还在不在 ===");
const sample = runBaseline(cases[0], "reference");
console.log(`  scoring_contract 是否还提 75 分线: ${sample.scoring_contract.includes("75") ? "是（有问题）" : "否"}`);
console.log(`  判定 passed 是否只看硬门: ${
  Object.values(sample.hard_gates).every(Boolean) === sample.passed ? "是" : "否（有问题）"}`);
