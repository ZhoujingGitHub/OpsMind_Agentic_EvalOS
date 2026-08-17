import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CASES,
  DeterministicGradingService,
  EvalStore,
  EvaluationLedger,
  PrivateLabelStore,
  TrialRunner,
  clusteredPairedBootstrap,
  containsSensitiveMaterial,
  createM15Registry,
  reliabilityMetrics,
  sha256,
  isRetryableInfrastructureFailure,
} from "../packages/kernel/src/index.mjs";
import {
  DEEPSEEK_AGENT_RUNTIME,
  createDeepSeekClaudeAgentAdapter,
  createLangGraphAdapter,
} from "../packages/agent-runtime/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preflight = process.argv.includes("--preflight");
const runId = process.env.M15_REAL_RUN_ID ?? (preflight
  ? "m15-real-preflight-l1v2-20260814-v1"
  : "m15-real-pilot-l1v2-20260814-v1");
const runtimeRoot = path.join(ROOT, "runtime", "m15-real", runId);
const artifactsRoot = path.join(ROOT, "artifacts", "m15-real", runId);
const manifestPath = process.env.M15_MANIFEST_PATH ?? path.join(ROOT, "config", preflight
  ? "m15-real-preflight.manifest.json"
  : "m15-pilot.manifest.json");
mkdirSync(runtimeRoot, { recursive: true });
mkdirSync(artifactsRoot, { recursive: true });

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const manifestText = JSON.stringify(manifest);
if (/REPLACE_WITH_|sha256:f{64}/.test(manifestText)) throw new Error("正式 Pilot Manifest 仍含未冻结占位符");
if (!manifest.contestants.every((item) => /^sha256:[a-f0-9]{64}$/.test(item.artifact_digest))) {
  throw new Error("正式 Pilot 的每个参评版本都必须提供 SHA-256 制品指纹");
}
if (!process.env.DEEPSEEK_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  throw new Error("正式 Pilot 必须通过环境变量提供 DeepSeek 凭据");
}
if (!process.env.OPSMIND_LANGGRAPH_PYTHON || !process.env.OPSMIND_LANGGRAPH_ROOT) {
  throw new Error("正式 Pilot 缺少 OPSMIND_LANGGRAPH_PYTHON 或 OPSMIND_LANGGRAPH_ROOT");
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + Number(value), 0) / values.length : 0;
}

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function quantile(values, q) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(q * ordered.length) - 1))];
}

const hasNoCredentialMaterial = (value) => !containsSensitiveMaterial(value);

const store = new EvalStore({
  databasePath: path.join(runtimeRoot, "control.sqlite"),
  runtimeRoot,
  migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m15.sql"),
});
const labels = new PrivateLabelStore({
  databasePath: path.join(runtimeRoot, "private", "labels.sqlite"),
  migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_private_labels.sql"),
});
const ledger = new EvaluationLedger(store);

function gradeFor(trialId) {
  return store.listGraderRuns(trialId).find((run) => run.grader_type === "code" && run.dimension === "overall")?.result ?? null;
}

function trialView(trial) {
  const grade = gradeFor(trial.id);
  return {
    trial_id: trial.id,
    case_ref: trial.case_ref,
    environment_seed: trial.environment_seed,
    replicate_id: trial.replicate_id,
    blind_id: trial.blind_id,
    contestant_ref: trial.contestant_ref,
    run_order: trial.run_order,
    status: trial.status,
    attempt: trial.attempt,
    score: grade?.total ?? null,
    passed: grade?.passed ?? false,
    usage: trial.usage,
    trace_hash: trial.trace_hash,
    error_hash: trial.error ? sha256(trial.error) : null,
  };
}

function writeProgress(experimentId, phase = "RUNNING") {
  const trials = store.listTrials(experimentId, { includeReplays: false });
  const progress = {
    run_id: runId,
    experiment_id: experimentId,
    phase,
    expected: manifest.case_refs.length * manifest.replicates * manifest.contestants.length,
    queued: trials.filter((item) => item.status === "QUEUED").length,
    running: trials.filter((item) => item.status === "RUNNING").length,
    completed: trials.filter((item) => item.status === "COMPLETED").length,
    failed: trials.filter((item) => item.status === "FAILED").length,
    last_trial: trials.filter((item) => ["COMPLETED", "FAILED"].includes(item.status)).at(-1)?.id ?? null,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(path.join(artifactsRoot, "progress.json"), `${JSON.stringify(progress, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ event: "m15.progress", ...progress }));
  return progress;
}

function contestantStats(trials, contestantRef) {
  const selected = trials.filter((trial) => trial.contestant_ref === contestantRef);
  const completed = selected.filter((trial) => trial.status === "COMPLETED");
  const rows = completed.map((trial) => ({ trial, grade: gradeFor(trial.id) }));
  const scores = rows.map(({ grade }) => Number(grade?.total ?? 0));
  const durations = completed.map((trial) => Math.max(0, new Date(trial.completed_at) - new Date(trial.started_at)));
  const dimensionNames = ["task_success", "rca_quality", "evidence_quality", "trajectory_quality", "open_world", "proactive_capability", "resource_cost", "engineering_agility"];
  return {
    scheduled: selected.length,
    completed: completed.length,
    failed: selected.filter((trial) => trial.status === "FAILED").length,
    code_grade_pass_rate: round(mean(rows.map(({ grade }) => grade?.passed ? 1 : 0)), 4),
    score_mean: round(mean(scores)),
    score_median: round(quantile(scores, 0.5)),
    score_p95: round(quantile(scores, 0.95)),
    duration_mean_ms: round(mean(durations), 0),
    duration_p95_ms: round(quantile(durations, 0.95), 0),
    input_tokens_mean: round(mean(completed.map((trial) => trial.usage?.input_tokens ?? 0))),
    output_tokens_mean: round(mean(completed.map((trial) => trial.usage?.output_tokens ?? 0))),
    tool_calls_mean: round(mean(completed.map((trial) => trial.usage?.tool_calls ?? 0))),
    dimensions: Object.fromEntries(dimensionNames.map((name) => [name, round(mean(rows.map(({ grade }) => grade?.dimensions?.[name]?.normalized ?? 0)), 4)])),
  };
}

function pairedRows(trials) {
  const groups = new Map();
  for (const trial of trials.filter((item) => item.status === "COMPLETED")) {
    const key = `${trial.case_ref}:r${trial.replicate_id}`;
    groups.set(key, { ...(groups.get(key) ?? { case_id: trial.case_ref }), [trial.contestant_ref]: gradeFor(trial.id)?.total });
  }
  return [...groups.values()].filter((item) => item["agent-harness-v2"] != null && item["langgraph-v1"] != null)
    .map((item) => ({ case_id: item.case_id, v2: item["agent-harness-v2"], v1: item["langgraph-v1"] }));
}

const registry = createM15Registry(CASES);
const privateLabelHash = labels.publishRegistry(registry);
const publication = store.publishRegistry(registry, { privateLabelHash });
store.registerGraderSpec({
  id: "m15-code-grader",
  version: "2.1.0",
  type: "code",
  status: "APPROVED",
  definition: { weights: "25/15/15/15/15/5/5/5", safety: "non-compensable-hard-gate" },
});
const gradingService = new DeterministicGradingService({
  labelStore: labels,
  executionCaseResolver: (ref) => store.getExecutionCase(ref),
});
const adapters = {
  "agent-harness-v2": createDeepSeekClaudeAgentAdapter(),
  "langgraph-v1": createLangGraphAdapter(),
};
const runner = new TrialRunner({ store, ledger, adapters, gradingService, workerId: `m15-real-${process.pid}`, leaseMs: 360000 });

try {
  const created = store.createExperiment(manifest, runId);
  const experimentId = created.experiment.id;
  if (created.created) {
    ledger.append({
      entityType: "experiment",
      entityId: experimentId,
      action: "experiment.created",
      payload: {
        run_id: runId,
        execution: "real-paid-model-calls",
        manifest_hash: created.experiment.manifest_hash,
        registry_hash: publication.registry_hash,
        private_label_hash: publication.private_label_hash,
      },
    });
    writeFileSync(path.join(artifactsRoot, "experiment-manifest.frozen.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  store.setExperimentStatus(experimentId, "RUNNING");
  runner.recover();
  writeProgress(experimentId);

  async function drainQueue() {
    while (true) {
      const trial = store.claimNext(runner.workerId, runner.leaseMs, experimentId);
      if (!trial) break;
      const result = await runner.runTrial(trial);
      console.log(JSON.stringify({
        event: "m15.trial.finished",
        trial_id: result.id,
        case_ref: result.case_ref,
        replicate_id: result.replicate_id,
        blind_id: result.blind_id,
        status: result.status,
        attempt: result.attempt,
        score: gradeFor(result.id)?.total ?? null,
      }));
      writeProgress(experimentId);
    }
  }

  await drainQueue();
  while (store.listTrials(experimentId, { includeReplays: false }).some((trial) => trial.status === "RUNNING")) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    runner.recover();
    await drainQueue();
  }
  while (true) {
    const retryable = store.listTrials(experimentId, { includeReplays: false })
      .filter((trial) => trial.status === "FAILED" && trial.attempt < 3 && isRetryableInfrastructureFailure(trial.error));
    if (!retryable.length) break;
    for (const trial of retryable) {
      store.retryFailedTrial(trial.id, "命中事前冻结的基础设施故障规则");
      ledger.append({
        entityType: "trial",
        entityId: trial.id,
        action: "trial.infrastructure_retry_approved",
        payload: { prior_error_hash: sha256(trial.error ?? ""), prior_attempt: trial.attempt },
      });
    }
    await drainQueue();
  }

  const trials = store.listTrials(experimentId, { includeReplays: false });
  const expectedTrials = manifest.case_refs.length * manifest.replicates * manifest.contestants.length;
  const pairs = pairedRows(trials);
  const bootstrap = pairs.length ? clusteredPairedBootstrap(pairs) : null;
  const byContestant = Object.fromEntries(manifest.contestants.map((item) => [item.ref, contestantStats(trials, item.ref)]));
  const allTraces = trials.flatMap((trial) => store.getTrace(trial.id));
  const controlTables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  const artifactCount = Number(store.db.prepare("SELECT COUNT(*) AS count FROM artifacts").get().count);
  const graderCount = Number(store.db.prepare("SELECT COUNT(*) AS count FROM grader_runs WHERE grader_type='code'").get().count);
  const ledgerStatus = ledger.verify();
  const runtimeChecks = {
    frozen_manifest_has_no_placeholders: !/REPLACE_WITH_|sha256:f{64}/.test(manifestText),
    expected_trial_count: trials.length === expectedTrials && expectedTrials === (preflight ? 2 : 90),
    all_trials_completed: trials.every((trial) => trial.status === "COMPLETED"),
    all_pairs_complete: pairs.length === manifest.case_refs.length * manifest.replicates && pairs.length === (preflight ? 1 : 45),
    deterministic_grade_per_trial: graderCount === expectedTrials,
    result_artifact_per_trial: artifactCount === expectedTrials,
    trace_hash_per_trial: trials.every((trial) => /^[a-f0-9]{64}$/.test(trial.trace_hash ?? "")),
    agent_harness_sdk_trace: allTraces.some((record) => record.name === "agent.sdk.message" && record.payload.sdk === "@anthropic-ai/claude-agent-sdk"),
    agent_harness_native_capabilities: ["Bash", "Read", "Write", "Edit", "Skill"].every((name) => DEEPSEEK_AGENT_RUNTIME.nativeTools.includes(name)),
    langgraph_real_stategraph_trace: allTraces.some((record) => record.name === "agent.langgraph.result" && record.payload.architecture === "LANGGRAPH_V1"),
    execution_plane_has_no_private_labels: !controlTables.includes("private_case_labels"),
    credential_material_absent: hasNoCredentialMaterial(allTraces) && hasNoCredentialMaterial(trials.map(trialView)),
    ledger_valid: ledgerStatus.valid,
  };
  const accepted = Object.values(runtimeChecks).every(Boolean);
  store.setExperimentStatus(experimentId, accepted ? "COMPLETED" : "FAILED");

  const reliability = Object.fromEntries(manifest.contestants.map((item) => [item.ref, reliabilityMetrics(
    trials.filter((trial) => trial.contestant_ref === item.ref).map((trial) => ({
      case_id: trial.case_ref,
      passed: gradeFor(trial.id)?.passed ?? false,
    })),
  )]));
  const deltas = pairs.map((pair) => pair.v2 - pair.v1);
  const verdict = {
    gate: preflight ? "M1.5-L1-V2-REAL-PREFLIGHT" : "M1.5-L1-V2-FORMAL-PILOT",
    status: accepted ? "PASSED" : "FAILED",
    engineering_accepted: accepted,
    execution: "真实 DeepSeek V4 Flash 付费模型调用；V2 为 Claude Agent SDK，V1 为真实 LangGraph 对照；非 Test Double",
    scope: "L1 v2 合成仿真基准，不外推为生产能力",
    official_score_source: "deterministic_code_grader",
    model_judges: "advisory_only_not_required_for_ranking",
    expert_review: { optional: true, blocking: false, ranking_authority: false, status: "NOT_REQUESTED" },
    run_id: runId,
    experiment_id: experimentId,
    manifest_hash: created.experiment.manifest_hash,
    registry_hash: publication.registry_hash,
    private_label_hash: publication.private_label_hash,
    expected_trials: expectedTrials,
    completed_trials: trials.filter((trial) => trial.status === "COMPLETED").length,
    failed_trials: trials.filter((trial) => trial.status === "FAILED").length,
    infrastructure_retries: trials.filter((trial) => trial.attempt > 1).length,
    contestants: byContestant,
    paired_comparison: {
      pairs: pairs.length,
      v2_minus_v1_mean: bootstrap?.mean_delta ?? null,
      clustered_bootstrap_ci95: bootstrap?.interval ?? null,
      v2_wins: deltas.filter((value) => value > 0).length,
      ties: deltas.filter((value) => value === 0).length,
      v1_wins: deltas.filter((value) => value < 0).length,
    },
    reliability,
    runtime_checks: runtimeChecks,
    ledger: ledgerStatus,
    ranking_allowed: accepted && !preflight,
    ranking_basis: accepted && !preflight ? "L1 v2 合成仿真确定性 Code Grader" : "预检或未通过时不允许发布排名",
    generated_at: new Date().toISOString(),
  };
  const trialIndex = trials.map(trialView);
  writeFileSync(path.join(artifactsRoot, "trial-index.json"), `${JSON.stringify(trialIndex, null, 2)}\n`, "utf8");
  writeFileSync(path.join(artifactsRoot, "m15-real-verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  writeProgress(experimentId, accepted ? "COMPLETED" : "FAILED");

  const report = [
    `# OpsMind EvalOS M1.5 L1 v2 ${preflight ? "真实预检" : "正式 Pilot 收口"}报告`,
    "",
    `- 工程验收：**${accepted ? "通过" : "未通过"}**`,
    "- 执行性质：真实 DeepSeek V4 Flash 付费模型调用，不是模拟脑或确定性回放替身",
    `- Trial：${verdict.completed_trials}/${expectedTrials} 完成；基础设施重试 ${verdict.infrastructure_retries} 次`,
    `- 成对样本：${pairs.length}/${preflight ? 1 : 45}`,
    `- V2−V1 平均代码分差：${verdict.paired_comparison.v2_minus_v1_mean ?? "无"}`,
    `- 按 Case 聚类 95% Bootstrap 区间：${bootstrap ? `[${bootstrap.interval.join(", ")}]` : "无"}`,
    `- V2胜/平/V1胜：${verdict.paired_comparison.v2_wins}/${verdict.paired_comparison.ties}/${verdict.paired_comparison.v1_wins}`,
    `- 账本：${ledgerStatus.valid ? "有效" : "无效"}，${ledgerStatus.entries} 条`,
    "- 专家评审：可选、非阻塞、不进入官方排名；本次未要求",
    "",
    "## 两个架构",
    "",
    "| 架构 | 完成 | Code Grader通过率 | 平均分 | 中位数 | P95 | 平均工具数 | 平均输入Token | 平均耗时 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(byContestant).map(([name, item]) => `| ${name} | ${item.completed}/${item.scheduled} | ${(item.code_grade_pass_rate * 100).toFixed(1)}% | ${item.score_mean} | ${item.score_median} | ${item.score_p95} | ${item.tool_calls_mean} | ${item.input_tokens_mean} | ${(item.duration_mean_ms / 1000).toFixed(1)}秒 |`),
    "",
    "## 工程验收检查",
    "",
    ...Object.entries(runtimeChecks).map(([name, passed]) => `- ${passed ? "[通过]" : "[失败]"} ${name}`),
    "",
    "> 本报告只发布 L1 v2 合成仿真基准结论，不把它表述成真实生产网络能力。",
    "",
  ].join("\n");
  writeFileSync(path.join(artifactsRoot, preflight ? "M1.5真实预检报告.md" : "M1.5正式Pilot收口报告.md"), report, "utf8");
  console.log(JSON.stringify({ event: "m15.finished", ...verdict }, null, 2));
  if (!accepted) process.exitCode = 1;
} finally {
  labels.close();
  store.close();
}
