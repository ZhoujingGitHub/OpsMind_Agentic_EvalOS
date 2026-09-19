// 只读探针 7：过了 8 道硬门之后，分数还能在什么范围里浮动。
//
// 探针 6 算的是「下限」（过门最低分）。产品经理追问：过了门是不是就固定 90.36？
// 不是。下限之上还有两个变量在动，本脚本把每道题的下限和上限都算出来。
//
// 用法（EvalOS 仓根目录）： node _work/claude-takeover-20260911/tools/grader-probe7.mjs

import { M3_CASES } from "../../../packages/kernel/src/m3-cases.mjs";
import { M3_OBSERVATION_CASES } from "../../../packages/kernel/src/m3-observation-cases.mjs";

const WEIGHTS = { task_success: 25, rca_quality: 15, evidence_quality: 15, trajectory_quality: 15,
  open_world: 15, proactive_capability: 5, resource_cost: 5, engineering_agility: 5 };

function band(item) {
  const gt = item.ground_truth;
  const expectedStatus = gt.expected_status ?? "resolved";
  const recoveryRequired = Boolean(gt.requires_tool_recovery);
  const n = (gt.required_evidence ?? []).length;
  const hasForbidden = (gt.forbidden_claims ?? []).length > 0;

  const openWorldApplicable = recoveryRequired || expectedStatus === "inconclusive";
  const proactiveApplicable = Boolean(item.visible?.trigger_type === "proactive" || gt.proactive_expected);
  const applicable = { task_success: true, rca_quality: true, evidence_quality: true,
    trajectory_quality: true, open_world: openWorldApplicable,
    proactive_capability: proactiveApplicable, resource_cost: false, engineering_agility: false };

  // 过门之后，两个变量还在动：
  //   rca_quality      : 写了 exclusions = 1.0 ；没写且本题有禁止主张 = 0.8
  //   evidence_quality : (1 + 召回率)/2 ，召回率从硬门最低线一直到 1.0
  const minRecall = Math.min(1, 2 / Math.max(1, n));
  const lo = { task_success: 1, rca_quality: hasForbidden ? 0.8 : 1,
    evidence_quality: (1 + minRecall) / 2, trajectory_quality: 1,
    open_world: openWorldApplicable ? 1 : 0, proactive_capability: proactiveApplicable ? 1 : 0,
    resource_cost: 0, engineering_agility: 0 };
  const hi = { ...lo, rca_quality: 1, evidence_quality: 1 };

  const score = (v) => {
    let num = 0, den = 0;
    for (const [k, w] of Object.entries(WEIGHTS)) {
      if (!applicable[k]) continue;
      den += w; num += v[k] * w;
    }
    return Number((num / den * 100).toFixed(2));
  };
  return { id: item.id, den: Object.entries(WEIGHTS).reduce((s, [k, w]) => s + (applicable[k] ? w : 0), 0),
    n, lo: score(lo), hi: score(hi) };
}

const all = [...Object.values(M3_CASES), ...Object.values(M3_OBSERVATION_CASES)];
const rows = all.map(band);

const obs = rows.find((r) => r.id === "M3-OBS-001");
console.log("=== 今天在用的那道题 M3-OBS-001 ===");
console.log(`  分母 ${obs.den} 分 | 要求证据 ${obs.n} 条`);
console.log(`  过门后的分数区间：${obs.lo} ~ ${obs.hi} 分`);
console.log();

console.log("=== 过门之后，分数由这两件事决定 ===");
console.log("  1) 有没有写「已排除的其他可能」  → 写了 15 分拿满，没写只拿 12 分");
console.log("  2) 三条必需证据引全了几条        → 引全 15 分，只引 2 条 12.5 分");
console.log();

const byDen = {};
for (const r of rows) {
  byDen[r.den] = byDen[r.den] ?? { n: 0, lo: Infinity, hi: 0 };
  byDen[r.den].n += 1;
  byDen[r.den].lo = Math.min(byDen[r.den].lo, r.lo);
  byDen[r.den].hi = Math.max(byDen[r.den].hi, r.hi);
}
console.log("=== 全部 81 道题，过门后的分数区间 ===");
for (const [den, v] of Object.entries(byDen).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  分母 ${String(den).padStart(3)} | ${String(v.n).padStart(2)} 道 | ${v.lo} ~ ${v.hi} 分`);
}
const globalLo = Math.min(...rows.map((r) => r.lo));
const globalHi = Math.max(...rows.map((r) => r.hi));
console.log();
console.log(`>>> 全题库过门后的分数范围：${globalLo} ~ ${globalHi} 分（及格线 75）`);
console.log(">>> 所以 90.36 是「地板」，不是「结果」。满分 100 是够得着的。");
