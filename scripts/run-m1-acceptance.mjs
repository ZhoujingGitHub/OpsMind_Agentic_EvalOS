import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BudgetExceededError,
  BudgetTracker,
  CASES,
  EvalStore,
  EvaluationLedger,
  TrialRunner,
  containsSensitiveMaterial,
  createMockContestant,
  sha256,
  stableStringify,
} from "../packages/kernel/src/index.mjs";
import { DEEPSEEK_AGENT_RUNTIME } from "../packages/agent-runtime/src/index.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const ARTIFACTS = path.join(ROOT, "artifacts", "m1");
const RUNTIME = path.join(ROOT, "runtime", "m1");
mkdirSync(ARTIFACTS, { recursive: true });
mkdirSync(RUNTIME, { recursive: true });

const manifest = JSON.parse(readFileSync(path.join(ROOT, "config", "m1-smoke.manifest.json"), "utf8"));
const criteria = JSON.parse(readFileSync(path.join(ROOT, "config", "m1-g1.criteria.json"), "utf8"));
const acceptanceRunId = process.env.M1_RUN_ID;
if (!acceptanceRunId) {
  console.error("M1_RUN_ID is required so the acceptance evidence can be tied to a frozen version.");
  process.exit(2);
}
const runId = acceptanceRunId;
const store = new EvalStore({
  databasePath: path.join(RUNTIME, "evalos.sqlite"),
  runtimeRoot: RUNTIME,
  migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m1.sql"),
});
const ledger = new EvaluationLedger(store);
const adapters = {
  "mock-contestant-a": createMockContestant("mock-contestant-a", "context-first"),
  "mock-contestant-b": createMockContestant("mock-contestant-b", "metric-first"),
};
const runner = new TrialRunner({ store, ledger, adapters, cases: CASES, workerId: `m1-acceptance-${process.pid}` });

function check(id, passed, evidence, actual = null, expected = null) {
  return { id, passed: Boolean(passed), evidence, actual, expected };
}

function traceFingerprint(trialId) {
  const events = store.getTrace(trialId)
    .filter((event) => ["model.decision", "tool.call", "tool.result"].includes(event.kind))
    .map((event) => ({ kind: event.kind, actor: event.actor, payload: event.payload }));
  return sha256(events);
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "working-tree";
  }
}

try {
  const idempotencyKey = `m1-acceptance:${runId}`;
  const created = store.createExperiment(manifest, idempotencyKey);
  const duplicate = store.createExperiment(manifest, idempotencyKey);
  const experimentId = created.experiment.id;
  ledger.append({
    entityType: "experiment",
    entityId: experimentId,
    action: "experiment.created",
    payload: {
      run_id: runId,
      manifest_hash: created.experiment.config_hash,
      dataset_hash: manifest.dataset.sha256,
      model_contract: manifest.model,
      execution_profile: "credential-free deterministic replay adapters",
    },
  });
  store.setExperimentStatus(experimentId, "RUNNING");

  const interrupted = store.claimNext("runner-before-restart", 1);
  store.forceExpireLease(interrupted.id);
  const recoveredIds = runner.recover();
  const executedOriginals = await runner.runUntilIdle();
  let summary = store.experimentSummary(experimentId);
  store.setExperimentStatus(experimentId, summary.failed_trials ? "FAILED" : "COMPLETED");

  const originals = store.listTrials(experimentId, { includeReplays: false });
  const replaySources = [
    originals.find((trial) => trial.case_id === "SMOKE-RCA-001" && trial.status === "COMPLETED"),
    originals.find((trial) => trial.case_id === "SMOKE-RECOVERY-001" && trial.status === "COMPLETED"),
  ];
  const replayTrials = replaySources.map((trial, index) => store.createReplay(trial.id, index + 1));
  const executedReplays = await runner.runUntilIdle();
  summary = store.experimentSummary(experimentId);

  const completedOriginals = store.listTrials(experimentId, { includeReplays: false });
  const completedReplays = replayTrials.map((trial) => store.getTrial(trial.id));
  const allTraces = [...completedOriginals, ...completedReplays].flatMap((trial) => store.getTrace(trial.id));
  const firstEventLatencies = completedOriginals.map((trial) => {
    const first = store.getTrace(trial.id, { limit: 1 })[0];
    return Math.max(0, new Date(first.timestamp).getTime() - new Date(trial.started_at).getTime());
  });
  const maxFirstEventMs = Math.max(...firstEventLatencies);
  const orders = new Map();
  for (const trial of completedOriginals) {
    const key = `${trial.case_id}:${trial.seed}`;
    orders.set(key, [...(orders.get(key) ?? []), trial.blind_id]);
  }
  const orderVariants = new Set([...orders.values()].map((items) => items.join(",")));
  const uniqueNamespaces = new Set(completedOriginals.map((trial) => trial.namespace));
  const cursorChecks = completedOriginals.map((trial) => {
    const first = store.getTrace(trial.id, { limit: 1 })[0];
    const next = store.getTrace(trial.id, { after: first.row_id, limit: 1 })[0];
    return first && next && next.row_id > first.row_id && next.seq === first.seq + 1;
  });
  const replayComparisons = completedReplays.map((replay) => {
    const source = store.getTrial(replay.replay_of);
    return {
      replay_id: replay.id,
      source_id: source.id,
      outcome_match: sha256(source.outcome) === sha256(replay.outcome),
      score_match: sha256(source.score) === sha256(replay.score),
      trajectory_match: traceFingerprint(source.id) === traceFingerprint(replay.id),
    };
  });
  const budgetProbe = new BudgetTracker({ tool_calls: 5 });
  const softWarnings = budgetProbe.consume({ tool_calls: 4 });
  let hardStopped = false;
  try {
    budgetProbe.consume({ tool_calls: 1 });
  } catch (error) {
    hardStopped = error instanceof BudgetExceededError;
  }
  const ledgerStatus = ledger.verify();
  const recoveryTrial = store.getTrial(interrupted.id);
  const blindRows = store.listBlinds(experimentId);
  const checks = [
    check("required_trial_count", completedOriginals.length === criteria.required_trials, "2 cases x 2 contestants x 3 seeds", completedOriginals.length, criteria.required_trials),
    check("all_trials_completed", completedOriginals.every((trial) => trial.status === "COMPLETED"), "All original smoke Trials reached COMPLETED", summary.completed_trials, criteria.required_trials),
    check("all_code_grades_passed", completedOriginals.every((trial) => trial.score?.passed), "Every deterministic code grade passed", completedOriginals.filter((trial) => trial.score?.passed).length, criteria.required_trials),
    check("runner_restart_recovery", recoveredIds.includes(interrupted.id) && recoveryTrial.attempt >= 2, "Expired lease was requeued and the same Trial completed", recoveryTrial.attempt, ">=2"),
    check("idempotency", created.created && !duplicate.created && created.experiment.id === duplicate.experiment.id, "Duplicate create returned the existing experiment", duplicate.created, false),
    check("trial_isolation", uniqueNamespaces.size === criteria.required_trials && completedOriginals.every((trial) => trial.namespace.includes(trial.id)), "Every Trial has a dedicated namespace", uniqueNamespaces.size, criteria.required_trials),
    check("blind_identity", blindRows.length === 2 && blindRows.every((row) => row.blind_id.startsWith("candidate-") && !row.blind_id.includes(row.contestant_id)), "Public Trial identity uses blind labels", blindRows.map((row) => row.blind_id), "2 non-revealing labels"),
    check("seeded_random_order", orders.size === 6 && orderVariants.size >= 2, "A/B order is deterministic per seed and varies across pairs", orderVariants.size, ">=2"),
    check("budget_soft_and_hard_limits", softWarnings.length === 1 && hardStopped, "80% warning emitted and 100% consumption blocked", { warnings: softWarnings.length, hardStopped }, { warnings: 1, hardStopped: true }),
    check("ledger_hash_chain", ledgerStatus.valid, "Append-only ledger hash chain verifies", ledgerStatus.entries, ">0"),
    check("trace_first_event", maxFirstEventMs <= criteria.first_trace_event_ms_max, "Maximum first Trace event latency", maxFirstEventMs, `<=${criteria.first_trace_event_ms_max}`),
    check("trace_heartbeat", manifest.policy.heartbeat_ms <= criteria.heartbeat_ms_max && completedOriginals.every((trial) => store.getTrace(trial.id).some((event) => event.kind === "runner.heartbeat")), "Heartbeat policy and events present", manifest.policy.heartbeat_ms, `<=${criteria.heartbeat_ms_max}`),
    check("trace_cursor", cursorChecks.every(Boolean), "Cursor reads the next event without duplication", cursorChecks.filter(Boolean).length, criteria.required_trials),
    check("trace_redaction", !containsSensitiveMaterial(allTraces) && allTraces.some((event) => event.redacted), "Injected smoke secret was redacted before persistence", allTraces.filter((event) => event.redacted).length, ">0"),
    check("deterministic_replay", completedReplays.length === 2 && replayComparisons.every((item) => item.outcome_match && item.score_match && item.trajectory_match), "Two replays match outcome, score, and model/tool trajectory", replayComparisons, "all true"),
    check("minimum_replay_rate", summary.replay_rate >= criteria.minimum_replay_rate, "Replay rate rounds 10% of 12 up to two Trials", summary.replay_rate, `>=${criteria.minimum_replay_rate}`),
    check("claude_sdk_deepseek_contract", DEEPSEEK_AGENT_RUNTIME.sdk === "@anthropic-ai/claude-agent-sdk" && DEEPSEEK_AGENT_RUNTIME.model === "deepseek-v4-flash" && DEEPSEEK_AGENT_RUNTIME.graphFramework === null, "Live adapter contract uses Claude Agent SDK + DeepSeek V4 Flash without a graph framework", DEEPSEEK_AGENT_RUNTIME, "Claude SDK + DeepSeek V4 Flash"),
  ];
  const passed = checks.every((item) => item.passed);
  const verdict = {
    gate: "G1",
    status: passed ? "PASSED" : "FAILED",
    accepted: passed,
    run_id: runId,
    accepted_at: new Date().toISOString(),
    git_commit: gitCommit(),
    experiment_id: experimentId,
    manifest_hash: created.experiment.config_hash,
    dataset_hash: manifest.dataset.sha256,
    execution: {
      original_trials_executed: executedOriginals,
      replay_trials_executed: executedReplays,
      original_trials_completed: summary.completed_trials,
      replay_count: summary.replay_count,
      replay_rate: summary.replay_rate,
      average_score: Number(summary.average_score.toFixed(2)),
      maximum_first_trace_event_ms: maxFirstEventMs,
      model_contract: DEEPSEEK_AGENT_RUNTIME,
      acceptance_model_execution: "deterministic replay test double (no external API key available)",
    },
    ledger: ledgerStatus,
    replay_comparisons: replayComparisons,
    checks,
  };
  writeFileSync(path.join(ARTIFACTS, "g1-verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  writeFileSync(path.join(ARTIFACTS, "experiment-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(path.join(ARTIFACTS, "ledger-verification.json"), `${JSON.stringify(ledgerStatus, null, 2)}\n`, "utf8");
  writeFileSync(path.join(ARTIFACTS, "replay-comparison.json"), `${JSON.stringify(replayComparisons, null, 2)}\n`, "utf8");
  writeFileSync(path.join(ARTIFACTS, "trace-sample.json"), `${JSON.stringify(store.getTrace(completedOriginals[0].id), null, 2)}\n`, "utf8");

  const report = [
    "# OpsMind Agentic EvalOS M1 / G1 acceptance report",
    "",
    `- Verdict: **${verdict.status}**`,
    `- Run: \`${runId}\``,
    `- Experiment: \`${experimentId}\``,
    `- Completed: ${summary.completed_trials}/${criteria.required_trials} original Trials`,
    `- Replay: ${summary.replay_count}/${criteria.required_trials} (${(summary.replay_rate * 100).toFixed(1)}%)`,
    `- Average code score: ${verdict.execution.average_score}`,
    `- Maximum first Trace event latency: ${maxFirstEventMs} ms`,
    `- Ledger: ${ledgerStatus.valid ? "valid" : "invalid"}, ${ledgerStatus.entries} entries`,
    "",
    "## Architecture assertion",
    "",
    "The production adapter uses Claude Agent SDK with DeepSeek V4 Flash through DeepSeek's Anthropic-compatible endpoint. Agent behavior is a model-driven tool loop: the model forms hypotheses and chooses allowed MCP tools dynamically. There is no LangGraph dependency and no static node workflow. The deterministic kernel retains seeds, blind IDs, policy, budgets, isolation, grading, and Ledger control.",
    "",
    "M1 acceptance intentionally ran credential-free deterministic replay adapters that implement the same action contract. This validates the trusted kernel and does not claim a paid DeepSeek model call. A live API key remains an external deployment prerequisite, not an acceptance secret.",
    "",
    "## Checks",
    "",
    "| Check | Result | Evidence |",
    "|---|---:|---|",
    ...checks.map((item) => `| ${item.id} | ${item.passed ? "PASS" : "FAIL"} | ${String(item.evidence).replaceAll("|", "\\|")} |`),
    "",
    `Ledger head: \`${ledgerStatus.head_hash}\``,
    "",
  ].join("\n");
  writeFileSync(path.join(ARTIFACTS, "M1_G1验收报告.md"), report, "utf8");

  const snapshot = {
    generated_at: verdict.accepted_at,
    gate: verdict.gate,
    status: verdict.status,
    summary: {
      trials: summary.completed_trials,
      total_trials: criteria.required_trials,
      replay_rate: summary.replay_rate,
      average_score: verdict.execution.average_score,
      first_event_ms: maxFirstEventMs,
      ledger_valid: ledgerStatus.valid,
    },
    experiment: {
      id: experimentId,
      name: manifest.name,
      status: verdict.status,
      manifest_hash: created.experiment.config_hash,
      model: manifest.model.id,
      runtime: "Claude Agent SDK contract / deterministic G1 replay",
    },
    trials: completedOriginals.slice(0, 8).map((trial) => ({
      id: trial.id,
      case_id: trial.case_id,
      seed: trial.seed,
      blind_id: trial.blind_id,
      status: trial.status,
      score: trial.score.total,
      tool_calls: trial.usage.tool_calls,
    })),
    trace: store.getTrace(completedOriginals[0].id).slice(0, 12).map((event) => ({
      seq: event.seq,
      kind: event.kind,
      actor: event.actor,
      timestamp: event.timestamp,
      redacted: event.redacted,
      summary:
        event.payload.tool ?? event.payload.rationale_summary ?? event.payload.status ?? event.payload.outcome_status ?? event.kind,
    })),
    checks: checks.map(({ id, passed }) => ({ id, passed })),
  };
  const consolePublic = path.join(ROOT, "apps", "console", "public");
  mkdirSync(consolePublic, { recursive: true });
  writeFileSync(path.join(consolePublic, "m1-snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  writeFileSync(path.join(consolePublic, "m1-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ gate: verdict.gate, status: verdict.status, experiment_id: experimentId, checks: checks.length, completed: summary.completed_trials, replays: summary.replay_count }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  store.close();
}
