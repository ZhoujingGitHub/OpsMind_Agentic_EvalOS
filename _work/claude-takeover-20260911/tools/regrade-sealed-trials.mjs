#!/usr/bin/env node
// Regrade sealed real trials with the current grader. **Runs on the exam host, read-only.**
//
// Why: before a new grader is released, the same answer sheets must be put
// through it and the differences explained. Inputs are exactly what the
// database sealed — never reconstructed:
//   answer sheet      trial_results.outcome_json
//   trace             trace_records
//   laboratory state  trial_results.final_state_json.before_reset   (business verification lives here)
//
// Since Grader 7.0 old banks are not graded the old way. A sealed paper is put
// to the M3.3 question that asks the same thing: same injected scenario, same
// test condition. The comparison to make is the root-cause verdict — the pass
// verdict legitimately changes where 31 甲 made the root cause a gate everywhere.
//
// Usage (exam host): node regrade-sealed-trials.mjs <grader-root> <trial_id> [<trial_id> ...]
//   <grader-root>  a copy of the repository holding the grader to try, e.g. /root/grader-sim/v7
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const [root, ...ids] = process.argv.slice(2);
if (!root || !ids.length) { console.error("usage: regrade-sealed-trials.mjs <grader-root> <trial_id> [...]"); process.exit(2); }
const { gradeTrial, OPS_CASES } = await import(path.join(root, "packages/kernel/src/index.mjs"));
const db = new DatabaseSync(process.env.EVALOS_DATABASE_PATH ?? "/var/lib/opsmind-evalos/control/control.sqlite", { readOnly: true });
const jsonOf = (value, fallback = null) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };

const VARIANT_BY_PROFILE = { "public-baseline": "main", "hidden-benign-noise": "noise",
  "safety-untrusted-instruction": "injection", "regression-first-observation-fails": "regression" };

function equivalentCase(caseRef) {
  const row = db.prepare("SELECT runtime_json FROM case_versions WHERE case_ref=?").get(caseRef);
  const environment = jsonOf(row?.runtime_json, {}).environment ?? {};
  const variant = VARIANT_BY_PROFILE[environment.observation_profile ?? "public-baseline"];
  return Object.values(OPS_CASES).find((item) => item.ground_truth.scenario_id === environment.scenario_id
    && item.ground_truth.variant === variant) ?? null;
}

const rows = [];
for (const trialId of ids) {
  const trial = db.prepare("SELECT * FROM trials WHERE id=?").get(trialId);
  if (!trial) { console.error(`找不到 ${trialId}`); continue; }
  const sealed = db.prepare("SELECT outcome_json, usage_json, final_state_json FROM trial_results WHERE trial_id=?").get(trialId)
    ?? db.prepare("SELECT outcome_json, usage_json, final_state_json FROM trial_attempt_results WHERE trial_id=? ORDER BY attempt DESC LIMIT 1").get(trialId);
  const outcome = jsonOf(sealed?.outcome_json);
  if (!outcome) { console.error(`${trialId} 没有存下答卷`); continue; }
  const caseSpec = equivalentCase(trial.case_ref);
  if (!caseSpec) { console.error(`${trialId} 的题在 M3.3 里没有对应题`); continue; }
  const finalState = jsonOf(sealed.final_state_json, {});
  const trace = db.prepare("SELECT * FROM trace_records WHERE trial_id=? ORDER BY seq ASC").all(trialId)
    .map((record) => ({ ...record, payload: jsonOf(record.payload_json, {}) }));
  const before = jsonOf(db.prepare("SELECT result_json FROM grader_runs WHERE trial_id=? AND dimension='overall' ORDER BY created_at DESC LIMIT 1")
    .get(trialId)?.result_json);
  const after = gradeTrial(caseSpec, outcome, trace, jsonOf(sealed.usage_json, {}), {
    trialId, candidateRef: trial.contestant_ref, environmentState: finalState.before_reset ?? null,
    environmentReset: finalState.reset ?? { ok: true },
  });
  const oldVerdict = before?.assertions?.root_cause_localization?.evidence?.fact_grade?.verdict ?? null;
  rows.push({ trial: trialId, candidate: trial.contestant_ref, old_case: trial.case_ref, new_case: caseSpec.id,
    old_version: before?.grader_contract_version ?? null, old_passed: before?.passed ?? null,
    old_root_cause: oldVerdict, new_passed: after.passed, new_root_cause: after.report_card.root_cause_verdict,
    new_first_failed_gate: after.first_failed_gate?.gate ?? null, business_recovered: after.report_card.business_recovered });
}
console.log(JSON.stringify(rows, null, 1));
