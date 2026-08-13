import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EvalStore,
  EvaluationLedger,
  PILOT_CASES,
  PILOT_DATASET_HASH,
  TrialRunner,
  sha256,
} from "../packages/kernel/src/index.mjs";
import {
  DEEPSEEK_AGENT_RUNTIME,
  LANGGRAPH_RUNTIME,
  createDeepSeekClaudeAgentAdapter,
  createLangGraphAdapter,
} from "../packages/agent-runtime/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const smoke = process.argv.includes("--smoke");
const mode = smoke ? "smoke" : "pilot";
const runId = process.env.M1_REAL_RUN_ID ?? `m1-real-${mode}-20260813-v1`;
const runtimeRoot = path.join(ROOT, "runtime", "m1-real", runId);
const artifactsRoot = path.join(ROOT, "artifacts", "m1-real", runId);
mkdirSync(runtimeRoot, { recursive: true });
mkdirSync(artifactsRoot, { recursive: true });

function commit(repo) {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "working-tree";
  }
}

function quantile(values, q) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(q * ordered.length) - 1));
  return ordered[index];
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + Number(value), 0) / values.length : 0;
}

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function stats(trials) {
  const completed = trials.filter((trial) => trial.status === "COMPLETED");
  const scores = completed.map((trial) => Number(trial.score?.total ?? 0));
  const durations = completed.map((trial) => Math.max(0, new Date(trial.completed_at) - new Date(trial.started_at)));
  const dimensions = {};
  for (const name of ["task_outcome", "rca", "evidence", "trajectory", "open_world", "proactive", "resource_cost", "engineering_agility"]) {
    dimensions[name] = round(mean(completed.map((trial) => Number(trial.score?.dimensions?.[name]?.normalized ?? 0))));
  }
  return {
    scheduled: trials.length,
    completed: completed.length,
    failed: trials.length - completed.length,
    code_grade_pass_rate: round(mean(completed.map((trial) => trial.score?.passed ? 1 : 0))),
    score_mean: round(mean(scores)),
    score_median: round(quantile(scores, 0.5)),
    score_p95: round(quantile(scores, 0.95)),
    duration_mean_ms: round(mean(durations), 0),
    duration_p95_ms: round(quantile(durations, 0.95), 0),
    input_tokens_mean: round(mean(completed.map((trial) => Number(trial.usage?.input_tokens ?? 0)))),
    output_tokens_mean: round(mean(completed.map((trial) => Number(trial.usage?.output_tokens ?? 0)))),
    tool_calls_mean: round(mean(completed.map((trial) => Number(trial.usage?.tool_calls ?? 0)))),
    dimensions,
  };
}

function pairedComparison(trials) {
  const groups = new Map();
  for (const trial of trials.filter((item) => item.status === "COMPLETED")) {
    const key = `${trial.case_id}:${trial.seed}`;
    groups.set(key, { ...(groups.get(key) ?? {}), [trial.contestant_id]: trial });
  }
  const pairs = [...groups.entries()].filter(([, value]) => value["agent-harness-v2"] && value["langgraph-v1"]);
  const deltas = pairs.map(([, value]) => Number(value["agent-harness-v2"].score.total) - Number(value["langgraph-v1"].score.total));
  const average = mean(deltas);
  const variance = deltas.length > 1 ? deltas.reduce((sum, value) => sum + (value - average) ** 2, 0) / (deltas.length - 1) : 0;
  const halfWidth = deltas.length > 1 ? 1.96 * Math.sqrt(variance / deltas.length) : 0;
  return {
    pair_count: pairs.length,
    score_delta_v2_minus_v1_mean: round(average),
    score_delta_95ci: [round(average - halfWidth), round(average + halfWidth)],
    v2_wins: deltas.filter((value) => value > 0).length,
    ties: deltas.filter((value) => value === 0).length,
    v1_wins: deltas.filter((value) => value < 0).length,
  };
}

function noSensitiveMaterial(value) {
  const text = JSON.stringify(value);
  return !/(sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|auth[_-]?token|password|private[_-]?key)\s*[=:]\s*(?!\[REDACTED\]))/i.test(text);
}

const credentialAvailable = Boolean(process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY);
if (!credentialAvailable) throw new Error("真实 M1 需要通过环境变量提供 DeepSeek API 凭据");
if (!process.env.OPSMIND_LANGGRAPH_PYTHON || !process.env.OPSMIND_LANGGRAPH_ROOT) {
  throw new Error("真实 M1 需要 OPSMIND_LANGGRAPH_PYTHON 与 OPSMIND_LANGGRAPH_ROOT");
}

const caseIds = smoke ? ["PILOT-REG-001"] : Object.keys(PILOT_CASES);
const seeds = smoke ? [101] : [101, 202, 303];
const allTools = [...new Set(caseIds.flatMap((caseId) => Object.keys(PILOT_CASES[caseId].tools)))].sort();
const langGraphRoot = process.env.OPSMIND_LANGGRAPH_ROOT;
const opsMindRoot = process.env.OPSMIND_ROOT ?? path.resolve(ROOT, "../OpsMind");
const manifest = {
  manifest_version: "1.0",
  name: smoke ? "M1 真实双架构 Smoke" : "M1 12 Case 真实 Pilot",
  suite: { id: smoke ? "m1-real-smoke" : "m1-real-pilot", version: "1.0.0" },
  dataset: { id: "m1-l1-golden-cases", version: "1.0.0", sha256: PILOT_DATASET_HASH },
  contestants: [
    {
      id: "agent-harness-v2",
      adapter_version: "m1-claude-agent-sdk-2.0.0",
      code_commit: commit(opsMindRoot),
      image_digest: process.env.M1_IMAGE_DIGEST_V2 ?? `sha256:${sha256({ runtime: DEEPSEEK_AGENT_RUNTIME, commit: commit(opsMindRoot) })}`,
    },
    {
      id: "langgraph-v1",
      adapter_version: "m1-real-stategraph-1.0.0",
      code_commit: commit(langGraphRoot),
      image_digest: process.env.M1_IMAGE_DIGEST_V1 ?? `sha256:${sha256({ runtime: LANGGRAPH_RUNTIME, commit: commit(langGraphRoot) })}`,
    },
  ],
  cases: caseIds,
  seeds,
  model: { provider: "deepseek", id: "deepseek-v4-flash", interface: "anthropic", thinking: "disabled", temperature: 0 },
  budget: {
    input_tokens: 120000,
    output_tokens: 16000,
    tool_calls: 24,
    wallclock_ms: 300000,
    compute_ms: 300000,
    storage_bytes: 10485760,
    cost_usd: 0.5,
  },
  policy: {
    allowed_tools: allTools,
    forbidden_actions: ["write_production", "change_policy", "read_hidden_answer", "exfiltrate_secret"],
    heartbeat_ms: 5000,
    architecture_order: "seeded-balanced-paired-serial",
    infrastructure_retry_rule: "only transient API, timeout, connection, or runner infrastructure failure; maximum two retries",
  },
};

writeFileSync(path.join(artifactsRoot, "experiment-manifest.frozen.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const store = new EvalStore({
  databasePath: path.join(runtimeRoot, "evalos.sqlite"),
  runtimeRoot,
  migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m1.sql"),
});
const ledger = new EvaluationLedger(store);
const adapters = {
  "agent-harness-v2": createDeepSeekClaudeAgentAdapter(),
  "langgraph-v1": createLangGraphAdapter(),
};
const runner = new TrialRunner({ store, ledger, adapters, cases: PILOT_CASES, workerId: `m1-real-${process.pid}`, leaseMs: 360000 });

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
        manifest_hash: created.experiment.config_hash,
        dataset_hash: manifest.dataset.sha256,
      },
    });
  }
  store.setExperimentStatus(experimentId, "RUNNING");
  let completedThisProcess = 0;
  while (true) {
    const trial = store.claimNext(runner.workerId, runner.leaseMs);
    if (!trial) break;
    const result = await runner.runTrial(trial);
    completedThisProcess += 1;
    console.log(JSON.stringify({
      event: "m1.trial.finished",
      mode,
      ordinal: completedThisProcess,
      trial_id: result.id,
      case_id: result.case_id,
      blind_id: result.blind_id,
      status: result.status,
      score: result.score?.total ?? null,
      attempt: result.attempt,
    }));
  }

  const transient = /(429|rate.?limit|50[234]|timeout|timed out|connection|temporar|ECONN|runner failed)/i;
  const retryable = store.listTrials(experimentId, { includeReplays: false }).filter(
    (trial) => trial.status === "FAILED" && trial.attempt < 3 && transient.test(trial.error ?? ""),
  );
  for (const trial of retryable) {
    store.retryFailedTrial(trial.id, "事前冻结的基础设施失败规则命中");
    ledger.append({ entityType: "trial", entityId: trial.id, action: "trial.infrastructure_retry_approved", payload: { prior_error_hash: sha256(trial.error ?? ""), prior_attempt: trial.attempt } });
  }
  if (retryable.length) {
    while (true) {
      const trial = store.claimNext(runner.workerId, runner.leaseMs);
      if (!trial) break;
      await runner.runTrial(trial);
    }
  }

  const trials = store.listTrials(experimentId, { includeReplays: false });
  const byContestant = Object.fromEntries(
    manifest.contestants.map((contestant) => [contestant.id, stats(trials.filter((trial) => trial.contestant_id === contestant.id))]),
  );
  const comparison = pairedComparison(trials);
  const ledgerStatus = ledger.verify();
  const traces = trials.flatMap((trial) => store.getTrace(trial.id));
  const expectedTrialCount = caseIds.length * seeds.length * 2;
  const runtimeChecks = {
    agent_harness_sdk_trace: traces.some((event) => event.kind === "agent.sdk.message" && event.payload.sdk === "@anthropic-ai/claude-agent-sdk"),
    agent_harness_native_capabilities: ["Bash", "Read", "Write", "Edit", "Skill"].every((tool) => DEEPSEEK_AGENT_RUNTIME.nativeTools.includes(tool)),
    langgraph_real_stategraph_trace: traces.some((event) => event.kind === "agent.langgraph.result" && event.payload.architecture === "LANGGRAPH_V1"),
    credentials_redacted: noSensitiveMaterial(traces),
  };
  const accepted = trials.length === expectedTrialCount
    && trials.every((trial) => trial.status === "COMPLETED")
    && comparison.pair_count === caseIds.length * seeds.length
    && ledgerStatus.valid
    && Object.values(runtimeChecks).every(Boolean)
    && (!smoke || trials.every((trial) => trial.score?.passed));
  store.setExperimentStatus(experimentId, accepted ? "COMPLETED" : "FAILED");
  const failureClusters = {};
  for (const trial of trials.filter((item) => item.status === "COMPLETED" && !item.score?.passed)) {
    const failedGates = Object.entries(trial.score?.hard_gates ?? {}).filter(([, passed]) => !passed).map(([name]) => name);
    const key = failedGates.join("+") || "low_weighted_score";
    failureClusters[key] = (failureClusters[key] ?? 0) + 1;
  }
  const verdict = {
    gate: smoke ? "M1-REAL-SMOKE" : "M1-RESULT-CLOSURE",
    status: accepted ? "PASSED" : "FAILED",
    accepted,
    execution: "真实 DeepSeek V4 Flash 模型调用；非确定性回放替身",
    run_id: runId,
    experiment_id: experimentId,
    manifest_hash: created.experiment.config_hash,
    dataset_hash: manifest.dataset.sha256,
    expected_trials: expectedTrialCount,
    completed_trials: trials.filter((trial) => trial.status === "COMPLETED").length,
    failed_trials: trials.filter((trial) => trial.status === "FAILED").length,
    infrastructure_retries: trials.filter((trial) => trial.attempt > 1).length,
    contestants: byContestant,
    paired_comparison: comparison,
    failure_clusters: failureClusters,
    runtime_checks: runtimeChecks,
    ledger: ledgerStatus,
    generated_at: new Date().toISOString(),
  };
  writeFileSync(path.join(artifactsRoot, "m1-real-verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  writeFileSync(path.join(artifactsRoot, "trial-index.json"), `${JSON.stringify(trials.map((trial) => ({
    trial_id: trial.id,
    case_id: trial.case_id,
    seed: trial.seed,
    blind_id: trial.blind_id,
    contestant_id: trial.contestant_id,
    status: trial.status,
    score: trial.score?.total ?? null,
    passed: trial.score?.passed ?? false,
    usage: trial.usage,
    trace_hash: trial.trace_hash,
    attempt: trial.attempt,
  })), null, 2)}\n`, "utf8");
  const report = [
    `# ${smoke ? "M1 真实双架构 Smoke 验收报告" : "M1 真实 Pilot 结果收口报告"}`,
    "",
    `- 验收结论：**${accepted ? "通过" : "未通过"}**`,
    `- 执行性质：真实 DeepSeek V4 Flash 模型调用，不是模拟或确定性替身`,
    `- Trial：${verdict.completed_trials}/${expectedTrialCount} 完成，${verdict.failed_trials} 失败`,
    `- 成对样本：${comparison.pair_count}；V2 胜/平/V1 胜：${comparison.v2_wins}/${comparison.ties}/${comparison.v1_wins}`,
    `- V2−V1 平均分差：${comparison.score_delta_v2_minus_v1_mean}，95% 置信区间 [${comparison.score_delta_95ci.join(", ")}]`,
    `- Ledger：${ledgerStatus.valid ? "有效" : "无效"}，${ledgerStatus.entries} 条`,
    "",
    "## 两架构结果",
    "",
    "| 架构 | 完成 | 代码评分通过率 | 平均分 | 中位数 | P95 | 平均工具数 | 平均输入 Token | 平均耗时 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(byContestant).map(([id, item]) => `| ${id} | ${item.completed}/${item.scheduled} | ${(item.code_grade_pass_rate * 100).toFixed(1)}% | ${item.score_mean} | ${item.score_median} | ${item.score_p95} | ${item.tool_calls_mean} | ${item.input_tokens_mean} | ${(item.duration_mean_ms / 1000).toFixed(1)} 秒 |`),
    "",
    "## 架构真实性检查",
    "",
    `- V2 Claude Agent SDK 真实 Trace：${runtimeChecks.agent_harness_sdk_trace ? "通过" : "未通过"}`,
    `- V2 Bash/Read/Write/Edit/Skill 原生能力保留：${runtimeChecks.agent_harness_native_capabilities ? "通过" : "未通过"}`,
    `- V1 真实 StateGraph Trace：${runtimeChecks.langgraph_real_stategraph_trace ? "通过" : "未通过"}`,
    `- 凭据脱敏：${runtimeChecks.credentials_redacted ? "通过" : "未通过"}`,
    "",
    "## 失败簇",
    "",
    ...(Object.keys(failureClusters).length ? Object.entries(failureClusters).map(([name, count]) => `- ${name}：${count} 个 Trial`) : ["- 无代码评分失败 Trial。"]),
    "",
    "> 分数高低是评测结果，不影响评测平台工程验收；只有 Trial 缺失、真实架构未接通、盲测/隔离/账本失效或凭据泄露才使结果收口失败。",
    "",
  ].join("\n");
  writeFileSync(path.join(artifactsRoot, smoke ? "M1真实Smoke验收报告.md" : "M1真实Pilot结果收口报告.md"), report, "utf8");
  console.log(JSON.stringify({ event: "m1.finished", ...verdict }, null, 2));
  if (!accepted) process.exitCode = 1;
} finally {
  store.close();
}
