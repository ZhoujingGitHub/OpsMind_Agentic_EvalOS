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

const CHECK_NAMES_ZH = Object.freeze({
  required_trial_count: "Trial 数量符合要求",
  all_trials_completed: "所有 Trial 均已完成",
  all_code_grades_passed: "所有确定性代码评分均通过",
  runner_restart_recovery: "Runner 重启恢复",
  idempotency: "实验创建幂等性",
  trial_isolation: "Trial 独立隔离",
  blind_identity: "盲测身份保护",
  seeded_random_order: "基于种子的随机顺序",
  budget_soft_and_hard_limits: "预算软限制与硬限制",
  ledger_hash_chain: "Ledger 哈希链完整性",
  trace_first_event: "首条 Trace 事件时延",
  trace_heartbeat: "Trace 心跳",
  trace_cursor: "Trace 游标连续性",
  trace_redaction: "Trace 敏感信息脱敏",
  deterministic_replay: "确定性重放一致性",
  minimum_replay_rate: "最低重放比例",
  claude_sdk_deepseek_contract: "Claude Agent SDK 与 DeepSeek 集成约定",
});

const TRACE_KIND_NAMES_ZH = Object.freeze({
  "trial.started": "Trial 已启动",
  "runner.heartbeat": "Runner 心跳",
  "environment.snapshot": "环境快照",
  "model.decision": "模型决策",
  "tool.call": "工具调用",
  "tool.result": "工具结果",
  "grader.result": "评分结果",
  "trial.completed": "Trial 已完成",
});

function markdownCell(value) {
  return String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function traceSummaryZh(event) {
  if (event.kind === "trial.started") return `用例 ${event.payload.case_id}，种子 ${event.payload.seed}，盲测身份 ${event.payload.blind_id}`;
  if (event.kind === "runner.heartbeat") return `心跳间隔 ${event.payload.heartbeat_ms} 毫秒`;
  if (event.kind === "environment.snapshot") return `已记录独立命名空间，敏感配置已${event.redacted ? "脱敏" : "处理"}`;
  if (event.kind === "model.decision") return event.payload.action === "final" ? "模型判断证据已充分，准备输出最终结论" : `模型自主选择工具 ${event.payload.tool}`;
  if (event.kind === "tool.call") return `调用 ${event.payload.tool}`;
  if (event.kind === "tool.result") return `${event.payload.tool} 返回${event.payload.ok ? "成功" : "失败"}`;
  if (event.kind === "grader.result") return `确定性评分 ${event.payload.score?.total ?? "—"} 分，${event.payload.score?.passed ? "通过" : "未通过"}`;
  if (event.kind === "trial.completed") return `Trial 状态 ${event.payload.status}，得分 ${event.payload.score}`;
  return event.kind;
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
    check("required_trial_count", completedOriginals.length === criteria.required_trials, "2 个用例 × 2 个参评 Agent × 3 个随机种子", completedOriginals.length, criteria.required_trials),
    check("all_trials_completed", completedOriginals.every((trial) => trial.status === "COMPLETED"), "所有原始冒烟 Trial 均已进入 COMPLETED 状态", summary.completed_trials, criteria.required_trials),
    check("all_code_grades_passed", completedOriginals.every((trial) => trial.score?.passed), "每个确定性代码评分均已通过", completedOriginals.filter((trial) => trial.score?.passed).length, criteria.required_trials),
    check("runner_restart_recovery", recoveredIds.includes(interrupted.id) && recoveryTrial.attempt >= 2, "过期租约已重新入队，同一个 Trial 随后成功完成", recoveryTrial.attempt, ">=2"),
    check("idempotency", created.created && !duplicate.created && created.experiment.id === duplicate.experiment.id, "重复创建请求返回了已存在的实验", duplicate.created, false),
    check("trial_isolation", uniqueNamespaces.size === criteria.required_trials && completedOriginals.every((trial) => trial.namespace.includes(trial.id)), "每个 Trial 都使用独立命名空间", uniqueNamespaces.size, criteria.required_trials),
    check("blind_identity", blindRows.length === 2 && blindRows.every((row) => row.blind_id.startsWith("candidate-") && !row.blind_id.includes(row.contestant_id)), "公开的 Trial 身份仅使用不暴露真实参评方的盲测标签", blindRows.map((row) => row.blind_id), "2 个不暴露真实身份的标签"),
    check("seeded_random_order", orders.size === 6 && orderVariants.size >= 2, "每个种子的 A/B 顺序可复现，且不同组合之间存在顺序变化", orderVariants.size, ">=2"),
    check("budget_soft_and_hard_limits", softWarnings.length === 1 && hardStopped, "预算达到 80% 时发出预警，达到 100% 时阻止继续消耗", { warnings: softWarnings.length, hardStopped }, { warnings: 1, hardStopped: true }),
    check("ledger_hash_chain", ledgerStatus.valid, "只追加 Ledger 的哈希链校验通过", ledgerStatus.entries, ">0"),
    check("trace_first_event", maxFirstEventMs <= criteria.first_trace_event_ms_max, "所有原始 Trial 中首条 Trace 事件的最大时延", maxFirstEventMs, `<=${criteria.first_trace_event_ms_max}`),
    check("trace_heartbeat", manifest.policy.heartbeat_ms <= criteria.heartbeat_ms_max && completedOriginals.every((trial) => store.getTrace(trial.id).some((event) => event.kind === "runner.heartbeat")), "心跳策略符合要求，且每个 Trial 均有心跳事件", manifest.policy.heartbeat_ms, `<=${criteria.heartbeat_ms_max}`),
    check("trace_cursor", cursorChecks.every(Boolean), "游标能够无重复地读取下一条事件", cursorChecks.filter(Boolean).length, criteria.required_trials),
    check("trace_redaction", !containsSensitiveMaterial(allTraces) && allTraces.some((event) => event.redacted), "注入的冒烟测试密钥在持久化前已脱敏", allTraces.filter((event) => event.redacted).length, ">0"),
    check("deterministic_replay", completedReplays.length === 2 && replayComparisons.every((item) => item.outcome_match && item.score_match && item.trajectory_match), "两次重放的结果、得分以及模型/工具轨迹均与原 Trial 一致", replayComparisons, "全部为 true"),
    check("minimum_replay_rate", summary.replay_rate >= criteria.minimum_replay_rate, "12 个 Trial 的 10% 向上取整为 2 个，实际已完成 2 个重放", summary.replay_rate, `>=${criteria.minimum_replay_rate}`),
    check("claude_sdk_deepseek_contract", DEEPSEEK_AGENT_RUNTIME.sdk === "@anthropic-ai/claude-agent-sdk" && DEEPSEEK_AGENT_RUNTIME.model === "deepseek-v4-flash" && DEEPSEEK_AGENT_RUNTIME.graphFramework === null, "生产适配器使用 Claude Agent SDK 与 DeepSeek V4 Flash，未引入图工作流框架", DEEPSEEK_AGENT_RUNTIME, "Claude Agent SDK + DeepSeek V4 Flash"),
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
      acceptance_model_execution: "确定性重放测试替身（未提供外部 API 密钥）",
    },
    ledger: ledgerStatus,
    replay_comparisons: replayComparisons,
    checks,
  };
  writeFileSync(path.join(ARTIFACTS, "g1-verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  writeFileSync(path.join(ARTIFACTS, "experiment-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(path.join(ARTIFACTS, "ledger-verification.json"), `${JSON.stringify(ledgerStatus, null, 2)}\n`, "utf8");
  writeFileSync(path.join(ARTIFACTS, "replay-comparison.json"), `${JSON.stringify(replayComparisons, null, 2)}\n`, "utf8");
  const sampleTrace = store.getTrace(completedOriginals[0].id);
  writeFileSync(path.join(ARTIFACTS, "trace-sample.json"), `${JSON.stringify(sampleTrace, null, 2)}\n`, "utf8");

  const report = [
    "# OpsMind Agentic EvalOS M1 / G1 验收报告",
    "",
    `- 验收结论：**${verdict.accepted ? "通过" : "未通过"}**`,
    `- 运行版本：\`${runId}\``,
    `- 实验编号：\`${experimentId}\``,
    `- 原始 Trial：${summary.completed_trials}/${criteria.required_trials} 个已完成`,
    `- 确定性重放：${summary.replay_count}/${criteria.required_trials} 个（${(summary.replay_rate * 100).toFixed(1)}%）`,
    `- 平均代码评分：${verdict.execution.average_score} 分`,
    `- 首条 Trace 事件最大时延：${maxFirstEventMs} 毫秒`,
    `- Ledger：${ledgerStatus.valid ? "有效" : "无效"}，共 ${ledgerStatus.entries} 条记录`,
    "",
    "## 架构符合性声明",
    "",
    "生产适配器通过 DeepSeek 的 Anthropic 兼容接口，使用 Claude Agent SDK 调用 DeepSeek V4 Flash。Agent 采用模型驱动的工具循环：模型自主形成假设，并动态选择已授权的 MCP 工具。项目不依赖 LangGraph，也不存在静态节点工作流。随机种子、盲测身份、策略、预算、隔离、评分与 Ledger 均由确定性内核控制。",
    "",
    "M1 验收特意运行了无需密钥、实现相同行动协议的确定性重放适配器。本次结果验证的是可信内核，不宣称发生了付费 DeepSeek 模型调用。真实 API 密钥仍属于外部部署前置条件，不属于验收材料。",
    "",
    "## 验收项",
    "",
    "| 验收项 | 技术标识 | 结果 | 证据 |",
    "|---|---|---:|---|",
    ...checks.map((item) => `| ${CHECK_NAMES_ZH[item.id] ?? item.id} | \`${item.id}\` | ${item.passed ? "通过" : "未通过"} | ${markdownCell(item.evidence)} |`),
    "",
    `Ledger 链头哈希：\`${ledgerStatus.head_hash}\``,
    "",
  ].join("\n");
  writeFileSync(path.join(ARTIFACTS, "M1_G1验收报告.md"), report, "utf8");

  const verdictDocument = [
    "# G1 机器判定结果（中文解读）",
    "",
    "> 本文档是 `g1-verdict.json` 的中文可读版。JSON 保留稳定字段名，供程序读取和自动复验。",
    "",
    `- 验收门禁：${verdict.gate}`,
    `- 判定结果：**${verdict.accepted ? "通过" : "未通过"}**`,
    `- 判定时间：${verdict.accepted_at}`,
    `- 运行版本：\`${verdict.run_id}\``,
    `- Git 提交：\`${verdict.git_commit}\``,
    `- 实验编号：\`${verdict.experiment_id}\``,
    `- 实验清单哈希：\`${verdict.manifest_hash}\``,
    `- 数据集哈希：\`${verdict.dataset_hash}\``,
    `- 验收执行方式：${verdict.execution.acceptance_model_execution}`,
    "",
    "## 自动检查结果",
    "",
    "| 验收项 | 技术标识 | 结果 | 证据 |",
    "|---|---|---:|---|",
    ...checks.map((item) => `| ${CHECK_NAMES_ZH[item.id] ?? item.id} | \`${item.id}\` | ${item.passed ? "通过" : "未通过"} | ${markdownCell(item.evidence)} |`),
    "",
  ].join("\n");
  writeFileSync(path.join(ARTIFACTS, "G1机器判定结果.md"), verdictDocument, "utf8");

  const summaryDocument = [
    "# M1 实验汇总（中文解读）",
    "",
    "> 本文档是 `experiment-summary.json` 的中文可读版。",
    "",
    `- 实验编号：\`${experimentId}\``,
    `- 实验名称：M1 可信内核冒烟测试（机器标识：\`${manifest.name}\`）`,
    `- 实验状态：${summary.failed_trials === 0 ? "已完成" : "存在失败"}`,
    `- 原始 Trial 总数：${summary.trial_count}`,
    `- 已完成 Trial：${summary.completed_trials}`,
    `- 失败 Trial：${summary.failed_trials}`,
    `- 完成率：${(summary.completion_rate * 100).toFixed(1)}%`,
    `- 重放数量：${summary.replay_count}`,
    `- 重放比例：${(summary.replay_rate * 100).toFixed(1)}%`,
    `- 平均得分：${Number(summary.average_score.toFixed(2))} 分`,
    "",
  ].join("\n");
  writeFileSync(path.join(ARTIFACTS, "实验汇总.md"), summaryDocument, "utf8");

  const ledgerDocument = [
    "# M1 Ledger 校验结果（中文解读）",
    "",
    "> 本文档是 `ledger-verification.json` 的中文可读版。",
    "",
    `- 哈希链状态：**${ledgerStatus.valid ? "有效" : "无效"}**`,
    `- Ledger 记录数：${ledgerStatus.entries}`,
    `- 链头哈希：\`${ledgerStatus.head_hash}\``,
    `- 校验错误：${ledgerStatus.errors.length === 0 ? "无" : ledgerStatus.errors.join("；")}`,
    "",
  ].join("\n");
  writeFileSync(path.join(ARTIFACTS, "Ledger校验结果.md"), ledgerDocument, "utf8");

  const replayDocument = [
    "# M1 确定性重放对比（中文解读）",
    "",
    "> 本文档是 `replay-comparison.json` 的中文可读版。",
    "",
    "| 重放 Trial | 原始 Trial | 结果一致 | 得分一致 | 模型/工具轨迹一致 |",
    "|---|---|---:|---:|---:|",
    ...replayComparisons.map((item) => `| \`${item.replay_id}\` | \`${item.source_id}\` | ${item.outcome_match ? "是" : "否"} | ${item.score_match ? "是" : "否"} | ${item.trajectory_match ? "是" : "否"} |`),
    "",
    `结论：${replayComparisons.every((item) => item.outcome_match && item.score_match && item.trajectory_match) ? "两次重放均与原始 Trial 完全一致。" : "存在不一致项，需要复核。"}`,
    "",
  ].join("\n");
  writeFileSync(path.join(ARTIFACTS, "确定性重放对比.md"), replayDocument, "utf8");

  const traceDocument = [
    "# M1 Trace 轨迹样例（中文解读）",
    "",
    "> 本文档是 `trace-sample.json` 的中文可读版。原始 JSON 保留完整事件载荷，本文档用于快速验收。",
    "",
    `- Trial 编号：\`${completedOriginals[0].id}\``,
    `- 事件总数：${sampleTrace.length}`,
    `- 已脱敏事件数：${sampleTrace.filter((event) => event.redacted).length}`,
    "",
    "| 序号 | 事件 | 执行方 | 时间 | 是否脱敏 | 中文摘要 |",
    "|---:|---|---|---|---:|---|",
    ...sampleTrace.map((event) => `| ${event.seq} | ${TRACE_KIND_NAMES_ZH[event.kind] ?? event.kind}（\`${event.kind}\`） | ${event.actor} | ${event.timestamp} | ${event.redacted ? "是" : "否"} | ${markdownCell(traceSummaryZh(event))} |`),
    "",
  ].join("\n");
  writeFileSync(path.join(ARTIFACTS, "Trace轨迹样例.md"), traceDocument, "utf8");

  const deliveryIndex = [
    "# M1 中文交付材料索引",
    "",
    "以下 Markdown 文件均为中文交付材料，可直接阅读；同目录 JSON 文件是自动验收使用的原始机器证据，字段名保持稳定以保证程序兼容和可复验。",
    "",
    "- [M1 / G1 验收报告](M1_G1验收报告.md)",
    "- [G1 机器判定结果](G1机器判定结果.md)",
    "- [实验汇总](实验汇总.md)",
    "- [Ledger 校验结果](Ledger校验结果.md)",
    "- [确定性重放对比](确定性重放对比.md)",
    "- [Trace 轨迹样例](Trace轨迹样例.md)",
    "",
  ].join("\n");
  writeFileSync(path.join(ARTIFACTS, "交付材料索引.md"), deliveryIndex, "utf8");

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
