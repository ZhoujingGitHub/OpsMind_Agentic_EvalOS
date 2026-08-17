import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { containsSensitiveMaterial } from "../packages/kernel/src/index.mjs";

function stableStringify(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.keys(input).sort()
        .filter((key) => input[key] !== undefined)
        .map((key) => [key, normalize(input[key])]));
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function sha256(value) {
  const input = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(input).digest("hex");
}

function parse(value) {
  return JSON.parse(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const releaseRoot = path.resolve(process.argv[2] ?? process.cwd());
const runId = process.argv[3] ?? "m15-real-pilot-l1v2-20260814-v2";
const runtimeRoot = path.join(releaseRoot, "runtime", "m15-real", runId);
const artifactRoot = path.join(releaseRoot, "artifacts", "m15-real", runId);
const controlPath = path.join(runtimeRoot, "control.sqlite");
const privatePath = path.join(runtimeRoot, "private", "labels.sqlite");

assert(existsSync(controlPath), `控制库不存在：${controlPath}`);
assert(existsSync(privatePath), `私有标签库不存在：${privatePath}`);

const db = new DatabaseSync(controlPath, { readOnly: true });
const privateDb = new DatabaseSync(privatePath, { readOnly: true });

try {
  const verdict = parse(readFileSync(path.join(artifactRoot, "m15-real-verdict.json"), "utf8"));
  const progress = parse(readFileSync(path.join(artifactRoot, "progress.json"), "utf8"));
  const manifest = parse(readFileSync(path.join(artifactRoot, "experiment-manifest.frozen.json"), "utf8"));
  const trials = db.prepare("SELECT * FROM trials WHERE experiment_id=? AND trial_kind='PRIMARY' ORDER BY run_order").all(verdict.experiment_id);
  const results = db.prepare("SELECT * FROM trial_results WHERE trial_id IN (SELECT id FROM trials WHERE experiment_id=? AND trial_kind='PRIMARY')").all(verdict.experiment_id);
  const graders = db.prepare("SELECT * FROM grader_runs WHERE grader_type='code' AND dimension='overall' AND trial_id IN (SELECT id FROM trials WHERE experiment_id=? AND trial_kind='PRIMARY')").all(verdict.experiment_id);
  const artifacts = db.prepare("SELECT * FROM artifacts WHERE kind='trial-result' AND trial_id IN (SELECT id FROM trials WHERE experiment_id=? AND trial_kind='PRIMARY')").all(verdict.experiment_id);
  const traceRows = db.prepare("SELECT * FROM trace_records WHERE trial_id IN (SELECT id FROM trials WHERE experiment_id=? AND trial_kind='PRIMARY') ORDER BY trial_id,seq").all(verdict.experiment_id);
  const controlTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  const privateLabelRefs = new Set(privateDb.prepare("SELECT case_ref FROM private_case_labels").all().map((row) => row.case_ref));
  const privateLabels = privateLabelRefs.size;
  const checks = {};

  checks.runner_verdict_passed = verdict.status === "PASSED" && verdict.ranking_allowed === true;
  checks.progress_completed = progress.phase === "COMPLETED" && progress.completed === 90 && progress.failed === 0;
  checks.manifest_frozen = manifest.case_refs?.length === 15 && manifest.contestants?.length === 2 && manifest.replicates === 3
    && !/REPLACE_WITH_|sha256:f{64}/.test(JSON.stringify(manifest));
  checks.trial_cardinality = trials.length === 90 && trials.every((trial) => trial.status === "COMPLETED");
  checks.no_measurement_retries = trials.every((trial) => trial.attempt === 1);
  const pairs = new Map();
  for (const trial of trials) {
    const key = `${trial.case_ref}#${trial.replicate_id}`;
    if (!pairs.has(key)) pairs.set(key, new Set());
    pairs.get(key).add(trial.contestant_ref);
  }
  checks.paired_blind_design = pairs.size === 45 && [...pairs.values()].every((items) => items.size === 2);
  checks.one_result_grade_artifact_per_trial = results.length === 90 && graders.length === 90 && artifacts.length === 90
    && new Set(results.map((row) => row.trial_id)).size === 90
    && new Set(graders.map((row) => row.trial_id)).size === 90
    && new Set(artifacts.map((row) => row.trial_id)).size === 90;

  const traceGroups = Map.groupBy(traceRows, (row) => row.trial_id);
  checks.trace_sequence_contiguous = trials.every((trial) => {
    const rows = traceGroups.get(trial.id) ?? [];
    return rows.length > 0 && rows.every((row, index) => row.seq === index + 1);
  });
  checks.trace_payload_hashes_valid = traceRows.every((row) => sha256(parse(row.payload_json)) === row.payload_hash);
  const resultByTrial = new Map(results.map((row) => [row.trial_id, row]));
  checks.result_hashes_valid = results.every((row) => sha256({
    outcome: parse(row.outcome_json),
    usage: parse(row.usage_json),
    final_state: parse(row.final_state_json),
    trace_hash: row.trace_hash,
  }) === row.result_hash);
  checks.trace_semantic_hashes_valid = trials.every((trial) => {
    const semantic = (traceGroups.get(trial.id) ?? []).map((row) => ({
      seq: row.seq,
      record_type: row.record_type,
      name: row.name,
      span_kind: row.span_kind,
      actor: row.actor,
      status: row.status,
      payload: parse(row.payload_json),
      redacted: Boolean(row.redacted),
    }));
    return sha256(semantic) === resultByTrial.get(trial.id)?.trace_hash;
  });
  checks.grader_hashes_valid = graders.every((row) => sha256(parse(row.result_json)) === row.result_hash);
  checks.artifact_hashes_valid = artifacts.every((row) => {
    if (!existsSync(row.path) || statSync(row.path).size !== row.size_bytes) return false;
    return sha256(parse(readFileSync(row.path, "utf8"))) === row.sha256;
  });

  const ledgerRows = db.prepare("SELECT * FROM ledger_entries ORDER BY seq").all();
  let previous = "0".repeat(64);
  checks.ledger_chain_valid = ledgerRows.every((row) => {
    const valid = row.prev_hash === previous && sha256({
      timestamp: row.timestamp,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      action: row.action,
      payload: parse(row.payload_json),
      prev_hash: row.prev_hash,
    }) === row.entry_hash;
    previous = row.entry_hash;
    return valid;
  });
  checks.private_labels_physically_separated = !controlTables.includes("private_case_labels")
    && manifest.case_refs.every((caseRef) => privateLabelRefs.has(caseRef));
  const executionText = JSON.stringify({
    manifest,
    cases: db.prepare("SELECT public_json,runtime_json FROM case_versions").all(),
  });
  checks.execution_plane_has_no_answer_labels = !/(ground_truth|root_cause_anchor_sets|\"signals\")/i.test(executionText);
  const evidenceText = JSON.stringify({ traces: traceRows, results, graders });
  checks.no_credential_material = !containsSensitiveMaterial(evidenceText);
  checks.both_real_architectures_observed = traceRows.some((row) => row.name === "agent.sdk.message" && parse(row.payload_json).sdk === "@anthropic-ai/claude-agent-sdk")
    && traceRows.some((row) => row.name === "agent.langgraph.result" && parse(row.payload_json).architecture === "LANGGRAPH_V1");

  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  const contestantRows = db.prepare(`SELECT t.contestant_ref,g.result_json
    FROM trials t JOIN grader_runs g ON g.trial_id=t.id
    WHERE t.experiment_id=? AND t.trial_kind='PRIMARY' AND g.grader_type='code' AND g.dimension='overall'`).all(verdict.experiment_id);
  const contestantStats = Object.fromEntries([...Map.groupBy(contestantRows, (row) => row.contestant_ref)].map(([name, rows]) => {
    const scores = rows.map((row) => Number(parse(row.result_json).total));
    return [name, {
      trials: rows.length,
      mean_score: Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(2)),
      pass_rate: Number((rows.filter((row) => parse(row.result_json).passed).length / rows.length).toFixed(4)),
    }];
  }));
  const audit = {
    audit: "M1.5-L1-V2-INDEPENDENT-READ-ONLY-AUDIT",
    status: failedChecks.length === 0 ? "PASSED" : "FAILED",
    release_root: releaseRoot,
    run_id: runId,
    experiment_id: verdict.experiment_id,
    checks,
    failed_checks: failedChecks,
    counts: {
      trials: trials.length,
      pairs: pairs.size,
      results: results.length,
      code_grades: graders.length,
      artifacts: artifacts.length,
      trace_records: traceRows.length,
      ledger_entries: ledgerRows.length,
      private_labels: privateLabels,
    },
    contestants: contestantStats,
    file_hashes: Object.fromEntries([
      "experiment-manifest.frozen.json", "m15-real-verdict.json", "trial-index.json", "progress.json",
    ].map((name) => [name, sha256(readFileSync(path.join(artifactRoot, name), "utf8"))])),
    audited_at: new Date().toISOString(),
  };
  writeFileSync(path.join(artifactRoot, "m15-independent-audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  const report = [
    "# M1.5 L1 v2 正式 Pilot 独立审计报告", "",
    `- 独立审计：**${audit.status === "PASSED" ? "通过" : "未通过"}**`,
    `- 运行：${runId}`, `- Trial / 成对样本：${trials.length} / ${pairs.size}`,
    `- 轨迹 / 账本记录：${traceRows.length} / ${ledgerRows.length}`, "",
    "## 逐项检查", "",
    ...Object.entries(checks).map(([name, passed]) => `- ${passed ? "[通过]" : "[失败]"} ${name}`),
    "", "## 架构汇总", "",
    ...Object.entries(contestantStats).map(([name, item]) => `- ${name}：${item.trials} Trial，平均分 ${item.mean_score}，通过率 ${(item.pass_rate * 100).toFixed(1)}%`),
    "", "> 本审计器只读正式数据库，并独立重算哈希、数量和隔离条件；不修改 Trial 或官方 Code Grader 分数。", "",
  ].join("\n");
  writeFileSync(path.join(artifactRoot, "M1.5正式Pilot独立审计报告.md"), report, "utf8");
  console.log(JSON.stringify(audit, null, 2));
  if (failedChecks.length) process.exitCode = 1;
} finally {
  privateDb.close();
  db.close();
}
