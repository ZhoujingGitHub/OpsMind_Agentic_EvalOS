#!/usr/bin/env node
// 拿真实跑过的 Trial，用当前这版阅卷程序重判一遍。**在考场那台机上跑。**
//
// 为什么需要它：2026-09-20 上午跑的四道链路，诊断全对、全判否，因为当时的判据
// 要考生写一个考场从没交给过它的编号。换判据之后必须回头验一件事——
// **同一份答卷，新判据下结果变不变、变成什么**。不验就只是自说自话。
//
// 输入全部来自库里真实存着的那一份，不是重新构造的：
//   答卷      trial_results.outcome_json
//   轨迹      getTrace(trial_id)
//   用量      trial_results.usage_json
//   实验室状态 trial_results.final_state_json.before_reset   ← 业务复测结论在这里
//
// 题面用**当前代码里的**那一版（题库 3.2.2），不是库里冻结的旧版——
// 要问的问题正是"这份答卷放到新考试里会怎样"。
//
// 用法（考场机上）：
//   node regrade-sealed-trials.mjs <trial_id> [<trial_id> ...]

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const ROOT = "/opt/opsmind-evalos/current/evalos";
const DB_PATH = "/var/lib/opsmind-evalos/control/control.sqlite";

const { gradeTrial } = await import(path.join(ROOT, "packages/kernel/src/grader.mjs"));
const { M3_OBSERVATION_CASES } = await import(path.join(ROOT, "packages/kernel/src/m3-observation-cases.mjs"));

const ids = process.argv.slice(2);
if (!ids.length) { console.error("要给至少一个 trial id"); process.exit(2); }

const db = new DatabaseSync(DB_PATH, { readOnly: true });

function jsonOf(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function latestAttempt(trialId) {
  // 成功收口的那一次写在 trial_results；每次尝试写在 trial_attempt_results。
  return db.prepare(`SELECT outcome_json, usage_json, final_state_json
    FROM trial_results WHERE trial_id=?`).get(trialId)
    ?? db.prepare(`SELECT outcome_json, usage_json, final_state_json
      FROM trial_attempt_results WHERE trial_id=? ORDER BY attempt DESC LIMIT 1`).get(trialId)
    ?? null;
}

function traceOf(trialId) {
  return db.prepare(`SELECT * FROM trace_records WHERE trial_id=? ORDER BY seq ASC`).all(trialId)
    .map((row) => ({ ...row, payload: jsonOf(row.payload_json, {}) }));
}

function storedGrade(trialId) {
  const row = db.prepare(`SELECT result_json FROM grader_runs WHERE trial_id=?
    ORDER BY created_at DESC LIMIT 1`).get(trialId);
  return jsonOf(row?.result_json, null);
}

const rows = [];
for (const trialId of ids) {
  const trial = db.prepare("SELECT * FROM trials WHERE id=?").get(trialId);
  if (!trial) { console.error(`找不到 ${trialId}`); continue; }
  const attempt = latestAttempt(trialId);
  const outcome = jsonOf(attempt?.outcome_json);
  if (!outcome) { console.error(`${trialId} 没有存下答卷`); continue; }
  const finalState = jsonOf(attempt?.final_state_json, {});
  const caseId = String(trial.case_ref ?? "").split("@")[0];
  const caseSpec = M3_OBSERVATION_CASES[caseId];
  if (!caseSpec) { console.error(`${trialId} 的题 ${caseId} 不在当前题库里`); continue; }

  const before = storedGrade(trialId);
  const after = gradeTrial(caseSpec, outcome, traceOf(trialId), jsonOf(attempt?.usage_json, {}), {
    trialId,
    budget: jsonOf(trial.budget_json, {}),
    environmentState: finalState.before_reset ?? null,
    environmentReset: finalState.environment_reset ?? { ok: true },
    resourceUsageAffectsScore: false,
  });

  const failed = (result) => Object.entries(result?.hard_gates ?? {})
    .filter(([, ok]) => !ok).map(([name]) => name);
  rows.push({
    trial: trialId,
    case: `${caseId} (${caseSpec.visible.operating_mode})`,
    old_version: before?.grader_contract_version ?? "?",
    old_total: before?.total ?? null,
    old_passed: before?.passed ?? null,
    old_failed_gates: failed(before),
    new_version: after.grader_contract_version,
    new_total: after.total,
    new_passed: after.passed,
    new_failed_gates: failed(after),
    root_cause_verdict: after.assertions.root_cause_localization.evidence.fact_grade.verdict,
    root_cause_is_gate: after.assertions.root_cause_localization.evidence.is_hard_gate,
    business_recovered: after.controlled_closure_evidence?.business_recovered ?? null,
  });
}

console.log(JSON.stringify(rows, null, 1));
console.log();
console.log("=".repeat(112));
console.log("题".padEnd(34) + "旧判 ".padEnd(16) + "新判 ".padEnd(16) + "根因判定");
console.log("=".repeat(112));
for (const r of rows) {
  const oldCell = `${r.old_passed ? "通过" : "判否"} ${r.old_total}`;
  const newCell = `${r.new_passed ? "通过" : "判否"} ${r.new_total}`;
  console.log(r.case.padEnd(32) + "  " + oldCell.padEnd(14) + "  " + newCell.padEnd(14) + "  "
    + r.root_cause_verdict + (r.root_cause_is_gate ? "（这题根因是硬门）" : "（这题门交给结果）"));
  if (r.new_failed_gates.length) console.log("      新判未过的门: " + r.new_failed_gates.join(", "));
}
