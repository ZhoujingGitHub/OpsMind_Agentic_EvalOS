// 一场 Trial 的判分摘要（考场机，只读）。run-chain-queue.sh 每跑完一道调一次。
//   node sum.js <trial_id>
// 2026-10-29 改为 Grader 7.0 的结果形状：先看通没通过、卡在哪道门，再看根因与业务。
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/var/lib/opsmind-evalos/control/control.sqlite", { readOnly: true });
const id = process.argv[process.argv.length - 1];
const row = db.prepare("SELECT result_json FROM grader_runs WHERE trial_id=? AND dimension='overall' ORDER BY created_at DESC LIMIT 1").get(id)
  ?? db.prepare("SELECT result_json FROM grader_runs WHERE trial_id=? ORDER BY created_at DESC LIMIT 1").get(id);
if (!row) { console.log("  （还没有判分记录）"); process.exit(0); }
const g = JSON.parse(row.result_json);
const profile = g.case_profile ?? {};
const card = g.report_card ?? {};
console.log(`  阅卷 ${g.grader_version}  题 ${profile.scenario_id}/${profile.variant}  通过 ${g.passed}  描述分 ${g.total}`);
console.log(`  第一道没过的门: ${g.first_failed_gate ? `${g.first_failed_gate.gate}（${g.first_failed_gate.label}）` : "（全过）"}`);
console.log(`  根因 ${card.root_cause_verdict}  精确 ${card.root_cause_exact}  业务恢复 ${card.business_recovered}  改动 ${card.changes}`);
const failed = Object.entries(g.hard_gates ?? {}).filter(([, passed]) => passed === false).map(([name]) => name);
if (failed.length) console.log(`  全部未过的门: ${failed.join(", ")}`);
