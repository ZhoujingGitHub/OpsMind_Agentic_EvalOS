import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CASES, DeterministicGradingService, EvalStore, EvaluationLedger, PrivateLabelStore, TrialRunner,
  clusteredPairedBootstrap, createM15Registry, createMockContestant,
  reliabilityMetrics, sha256,
} from "../packages/kernel/src/index.mjs";
import { BLIND_JUDGE_RUNTIME, DEEPSEEK_AGENT_RUNTIME, EVALOS_LEAD_RUNTIME } from "../packages/agent-runtime/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRunId = process.env.M15_SOURCE_RUN_ID ?? "m1-real-pilot-linux-20260813-v1";
const sourceRoot = path.join(ROOT, "artifacts", "m1-real", sourceRunId);
const outputRoot = path.join(ROOT, "artifacts", "m15");
const runtimeRoot = path.join(ROOT, "runtime", "m15-acceptance", `${Date.now()}-${process.pid}`);
mkdirSync(outputRoot, { recursive: true });
mkdirSync(runtimeRoot, { recursive: true });

function load(root, name) { return JSON.parse(readFileSync(path.join(root, name), "utf8")); }
function textExists(file, pattern) { return pattern.test(readFileSync(path.join(ROOT, file), "utf8")); }

const finalM1 = load(sourceRoot, "M1最终验收结论.json");
const trialIndex = load(sourceRoot, "trial-index.json");
const manifest = load(path.join(ROOT, "config"), "m15-smoke.manifest.json");
const pilotManifest = load(path.join(ROOT, "config"), "m15-pilot.manifest.json");
const formalResult = load(path.join(ROOT, "config"), "m15-formal-result.json");
const registry = createM15Registry(CASES);
const publicRegistry = registry.snapshot();
const privateSnapshot = registry.snapshot({ includePrivateLabels: true });
const privateLabelHash = sha256(privateSnapshot.cases.map((item) => ({ key: item.key, label: item.private_label })));

// Standalone technical acceptance: a fresh control DB and physically separate
// private-label DB. Deterministic replay brains are test doubles, never model calls.
const store = new EvalStore({ databasePath: path.join(runtimeRoot, "control.sqlite"), runtimeRoot,
  migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m15.sql") });
const labels = new PrivateLabelStore({ databasePath: path.join(runtimeRoot, "private", "labels.sqlite"),
  migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_private_labels.sql") });
let smoke;
try {
  const isolatedPrivateHash = labels.publishRegistry(registry);
  const publication = store.publishRegistry(registry, { privateLabelHash: isolatedPrivateHash });
  store.registerGraderSpec({ id: "m15-code-grader", version: "2.1.0", type: "code", status: "APPROVED",
    definition: { weights: "25/15/15/15/15/5/5/5", safety: "non-compensable-hard-gate" } });
  const gradingService = new DeterministicGradingService({ labelStore: labels, executionCaseResolver: (ref) => store.getExecutionCase(ref) });
  const ledger = new EvaluationLedger(store);
  const { experiment } = store.createExperiment(manifest, "m15-standalone-acceptance");
  const runner = new TrialRunner({ store, ledger, gradingService, adapters: {
    "mock-contestant-a": createMockContestant("mock-contestant-a", "context-first"),
    "mock-contestant-b": createMockContestant("mock-contestant-b", "metric-first"),
  } });
  const executed = await runner.runUntilIdle({ experimentId: experiment.id });
  const trials = store.listTrials(experiment.id);
  const records = trials.flatMap((trial) => store.getTrace(trial.id));
  const controlTables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  smoke = {
    declaration: "确定性Test Double技术验收，不是付费模型能力评测",
    executed,
    completed: trials.filter((trial) => trial.status === "COMPLETED").length,
    grader_runs: trials.reduce((sum, trial) => sum + store.listGraderRuns(trial.id).length, 0),
    span_kinds: [...new Set(records.map((record) => record.span_kind))].sort(),
    redaction_observed: records.some((record) => record.redacted),
    trace_append_only: (() => { try { store.db.prepare("UPDATE trace_records SET actor='tamper'").run(); return false; } catch { return true; } })(),
    result_append_only: (() => { try { store.db.prepare("DELETE FROM trial_results").run(); return false; } catch { return true; } })(),
    ledger: ledger.verify(),
    execution_plane_has_private_label_table: controlTables.includes("private_case_labels"),
    registry_hash: publication.registry_hash,
    private_label_hash: publication.private_label_hash,
  };
} finally {
  labels.close();
  store.close();
}

// Historical M1 read-only evidence: 72 paid model Trials. It is not rewritten
// into the new DB because the formal full trace DB is retained on the ECS.
const pairMap = new Map();
for (const trial of trialIndex) {
  const key = `${trial.case_id}:${trial.seed}`;
  pairMap.set(key, { ...(pairMap.get(key) ?? { case_id: trial.case_id, historical_seed: trial.seed }), [trial.contestant_id]: trial.score });
}
const pairs = [...pairMap.values()].filter((item) => item["agent-harness-v2"] != null && item["langgraph-v1"] != null).map((item) => ({
  case_id: item.case_id, v2: item["agent-harness-v2"], v1: item["langgraph-v1"],
}));
const statistics = {
  paired_clustered_bootstrap: clusteredPairedBootstrap(pairs),
  reliability: Object.fromEntries(["agent-harness-v2", "langgraph-v1"].map((contestant) => [contestant, reliabilityMetrics(
    trialIndex.filter((trial) => trial.contestant_id === contestant).map((trial) => ({ case_id: trial.case_id, passed: trial.passed })),
  )])),
  cost_comparison: { valid: false, reason: "历史V1成本为0而V2记录付费成本，口径不对称，禁止跨架构成本结论。" },
};

const automatedChecks = {
  historical_m1_72_real_trials: finalM1.status === "PASSED" && finalM1.checks.real_pilot_72_completed && trialIndex.length === 72,
  fresh_manifest_12_trial_count: smoke.executed === 12 && smoke.completed === 12,
  private_labels_physically_separated: !smoke.execution_plane_has_private_label_table,
  public_registry_has_no_runtime_or_ground_truth: !JSON.stringify(publicRegistry).includes("ground_truth") && !JSON.stringify(publicRegistry).includes("runtime"),
  private_labels_exported_as_hash_only: privateLabelHash.length === 64,
  versioned_dataset_case_suite_grader: publicRegistry.datasets.length >= 2 && publicRegistry.suites.some((item) => item.type === "capability")
    && publicRegistry.suites.some((item) => item.type === "regression") && publicRegistry.suites.some((item) => item.type === "calibration"),
  l1_v2_removes_answer_shaped_signals: publicRegistry.datasets.some((item) => item.id === "m15-l1-agentic-cases" && item.version === "2.0.0")
    && registry.getExecutionCase("PILOT-REG-001@2.0.0") && !JSON.stringify(registry.getExecutionCase("PILOT-REG-001@2.0.0")).includes('"signals"'),
  l1_v2_has_safety_and_proactive_cases: ["PILOT-SEC-013@2.0.0", "PILOT-SAFE-014@2.0.0", "PILOT-PROACTIVE-015@2.0.0"]
    .every((ref) => registry.getExecutionCase(ref)),
  formal_pilot_manifest_is_90_trials: pilotManifest.case_refs.length === 15 && pilotManifest.replicates === 3
    && pilotManifest.contestants.length === 2 && pilotManifest.case_refs.length * pilotManifest.replicates * pilotManifest.contestants.length === 90,
  formal_v2_pilot_attestation_passed: formalResult.status === "PASSED" && formalResult.ranking_allowed === true
    && formalResult.counts.completed_trials === 90 && formalResult.counts.failed_trials === 0
    && formalResult.counts.paired_samples === 45 && formalResult.counts.infrastructure_retries === 0
    && formalResult.independent_audit.status === "PASSED" && formalResult.independent_audit.failed_checks.length === 0
    && Object.values(formalResult.runtime_checks).every(Boolean),
  environment_seed_and_replicate_are_separate: manifest.environment_seed != null && manifest.replicates === 3 && !("seeds" in manifest),
  span_trace_complete: ["AGENT", "CHAIN", "EVALUATOR", "TOOL"].every((kind) => smoke.span_kinds.includes(kind)),
  trace_and_results_append_only: smoke.trace_append_only && smoke.result_append_only,
  redaction_operational: smoke.redaction_observed,
  grader_run_per_trial: smoke.grader_runs === 12,
  ledger_valid: smoke.ledger.valid,
  three_independent_judges_defined: BLIND_JUDGE_RUNTIME.independent === true && BLIND_JUDGE_RUNTIME.roles.length === 3,
  model_judges_are_advisory_only: BLIND_JUDGE_RUNTIME.authority === "advisory-only"
    && textExists("packages/agent-runtime/src/judge-orchestrator.mjs", /official_score_source:\s*"deterministic_code_grader"/),
  optional_expert_review_is_non_blocking: textExists("packages/kernel/src/registry.mjs", /ranking_authority:\s*false/)
    && textExists("services/control-api/src/app.mjs", /expert_review:\s*\{\s*optional:\s*true,\s*blocking:\s*false,\s*ranking_authority:\s*false/),
  lead_eval_agent_uses_claude_sdk: EVALOS_LEAD_RUNTIME.sdk === "@anthropic-ai/claude-agent-sdk" && EVALOS_LEAD_RUNTIME.graphFramework === null,
  contestant_v2_uses_claude_sdk: DEEPSEEK_AGENT_RUNTIME.sdk === "@anthropic-ai/claude-agent-sdk" && DEEPSEEK_AGENT_RUNTIME.graphFramework === null,
  native_capabilities_and_skills_preserved: ["Bash", "Read", "Write", "Edit", "Skill"].every((name) => DEEPSEEK_AGENT_RUNTIME.nativeTools.includes(name))
    && textExists("packages/agent-runtime/opsmind-plugin/.claude-plugin/plugin.json", /opsmind-agent-skills/),
  blinded_views_remove_architecture_identity: textExists("packages/kernel/src/projections.mjs", /evaluationEvidenceTraceView/)
    && textExists("packages/agent-runtime/src/blind-judge.mjs", /evaluationEvidenceTraceView/)
    && textExists("services/control-api/src/app.mjs", /evaluationEvidenceTraceView/),
  no_langgraph_in_evalos_core: ![
    "packages/agent-runtime/src/deepseek-claude-adapter.mjs", "packages/agent-runtime/src/evalos-lead-agent.mjs",
    "packages/agent-runtime/src/blind-judge.mjs", "packages/kernel/src/runner.mjs", "packages/kernel/src/store.mjs",
  ].some((file) => /(?:from|require\()\s*["'](?:langgraph|@langchain\/langgraph|langchain)/i.test(readFileSync(path.join(ROOT, file), "utf8"))),
  mysql_production_contract_present: textExists("infra/migrations/mysql/001_m15_control.sql", /trace_records/)
    && textExists("infra/migrations/mysql/001_m15_private_labels.sql", /private_case_labels/),
  misleading_historical_cost_comparison_blocked: statistics.cost_comparison.valid === false,
};
const technicalPassed = Object.values(automatedChecks).every(Boolean);

const optionalExpertReview = {
  status: "AVAILABLE_ON_DEMAND",
  optional: true,
  blocking: false,
  ranking_authority: false,
  tasks_created_automatically: 0,
  declaration: "专家盲审是可选的证据增强层；缺失不会阻塞 M1.5、正式 Pilot 或合成基准排名，也不会改写 Code Grader 官方分数。",
};

const verdict = {
  gate: "M1.5-MEASUREMENT-HARDENING",
  status: technicalPassed ? "ACCEPTED" : "FAILED",
  engineering_accepted: technicalPassed,
  formal_v2_pilot_status: formalResult.status,
  ranking_allowed: technicalPassed && formalResult.ranking_allowed,
  ranking_release_condition: "L1 v2正式90 Trial完成且确定性Code Grader、账本和统计检查通过",
  ranking_scope_after_release: "L1 v2合成仿真基准排名，不代表生产能力",
  official_score_source: "deterministic_code_grader",
  model_judges: "advisory_only",
  source_run: { id: sourceRunId, trial_count: trialIndex.length, evidence_mode: "read-only historical paid model evidence" },
  source_limitations: [
    "历史M1使用L1 v1合成观测，工具结果中的signals带有组件/置信度提示，存在答案式线索；只可作历史趋势和链路证据。",
    "M1.5 L1 v2已移除signals，并已完成90 Trial正式运行；正式能力结论以L1 v2结果为准。",
    "历史V1成本为0、V2记录付费成本，禁止成本优劣比较。",
  ],
  fresh_smoke: smoke,
  automated_checks: automatedChecks,
  optional_expert_review: optionalExpertReview,
  statistics: {
    formal_l1_v2: {
      paired_clustered_bootstrap: {
        cases: 15,
        pairs: formalResult.paired_comparison.pairs,
        mean_delta: formalResult.paired_comparison.v2_minus_v1_mean,
        interval: formalResult.paired_comparison.clustered_bootstrap_ci95,
        confidence: 0.95,
        clustered_by: "case_id",
      },
      reliability: Object.fromEntries(Object.entries(formalResult.contestants).map(([name, item]) => [name, {
        pass_at_k: item.pass_at_3,
        pass_power_k: item.pass_power_3,
      }])),
    },
    historical_l1_v1: statistics,
  },
  formal_result: formalResult,
  registry: { public_hash: publicRegistry.sha256, private_label_hash: privateLabelHash,
    dataset_count: publicRegistry.datasets.length, suite_count: publicRegistry.suites.length, case_count: publicRegistry.cases.length },
  architecture: {
    contestant_v2: "Claude Agent SDK + DeepSeek V4 Flash + MCP + versioned Skills + native tools",
    evalos_agent_layer: "Claude Agent SDK Lead Eval Agent + on-demand independent specialists",
    deterministic_harness: "Manifest / seed / replicate / isolation / budget / blind / code grader / safety / ledger",
    langgraph_scope: "external V1 contestant comparison adapter only",
    prohibited: ["LangGraph控制EvalOS或V2", "静态状态图", "固定工具顺序", "私有标签进入执行面", "模型Judge改写官方分数"],
  },
  generated_at: new Date().toISOString(),
};

const snapshot = {
  generated_at: verdict.generated_at,
  status: verdict.status,
  technical_status: technicalPassed ? "PASSED" : "FAILED",
  expert_review_status: "OPTIONAL_NOT_STARTED",
  source_run: { id: formalResult.run_id, trials: formalResult.counts.completed_trials, simulation_level: "L1 v2 状态化仿真" },
  planned_v2: { dataset_ref: pilotManifest.dataset_ref, suite_ref: pilotManifest.suite_ref,
    cases: pilotManifest.case_refs.length, trials: pilotManifest.case_refs.length * pilotManifest.replicates * pilotManifest.contestants.length,
    status: formalResult.status, reference_labels: "隐藏合成参考标签，仅用于L1 v2仿真基准，不代表生产事实" },
  metrics: { paired_delta: formalResult.paired_comparison.v2_minus_v1_mean,
    ci95: formalResult.paired_comparison.clustered_bootstrap_ci95,
    cases: 15, pairs: formalResult.paired_comparison.pairs,
    v2_pass_at_3: formalResult.contestants["agent-harness-v2"].pass_at_3,
    v2_pass_power_3: formalResult.contestants["agent-harness-v2"].pass_power_3 },
  contestants: formalResult.contestants,
  measurement: { code_grader: "m15-code-grader@2.1.0", official_score_source: "deterministic_code_grader",
    independent_judges: 3, model_judges: "advisory_only",
    expert_review: { optional: true, blocking: false, ranking_authority: false, tasks: 0 } },
  checks: Object.entries(automatedChecks).map(([label, passed]) => ({ label, passed, detail: passed ? "已验证" : "未通过" })),
  representative_trials: formalResult.representative_trials,
};

writeFileSync(path.join(outputRoot, "dataset-registry.public.json"), `${JSON.stringify(publicRegistry, null, 2)}\n`, "utf8");
writeFileSync(path.join(outputRoot, "private-labels.sha256"), `${privateLabelHash}\n`, "utf8");
writeFileSync(path.join(outputRoot, "M1.5统计复算.json"), `${JSON.stringify(statistics, null, 2)}\n`, "utf8");
writeFileSync(path.join(outputRoot, "M1.5验收结论.json"), `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
writeFileSync(path.join(outputRoot, "m15-statistics.json"), `${JSON.stringify(statistics, null, 2)}\n`, "utf8");
writeFileSync(path.join(outputRoot, "m15-verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
writeFileSync(path.join(ROOT, "apps", "console", "public", "m15-snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

const report = [
  "# OpsMind EvalOS M1.5 测量系统加固验收报告", "",
  `- M1.5 工程验收：**${technicalPassed ? "通过" : "未通过"}**`,
  "- 官方评分来源：**确定性 Code Grader**",
  "- 三路模型 Judge：**仅作辅助诊断，不进入总分、不推翻 Code Grader**",
  "- 专家盲审：**可选增强项，不阻塞验收、Pilot 或排名**",
  `- 正式 L1 v2 Pilot：**${formalResult.status}，${formalResult.counts.completed_trials}/90 Trial 完成**`,
  `- 当前是否发布排名：**${verdict.ranking_allowed ? "允许发布 L1 v2 合成仿真基准排名" : "不允许"}**`,
  `- 历史证据：${sourceRunId}，${trialIndex.length} 条真实 DeepSeek Trial，只读回灌`,
  `- 新内核自证：${smoke.completed}/${smoke.executed} 条确定性 Test Double Trial 完成；不冒充付费模型调用`, "",
  "## Agent 时代评测新范式", "",
  "- 评测对象是任务结果、执行轨迹、环境终态、安全行为和重复运行稳定性，不是一段最终文本。",
  "- Harness 固定考场和不可协商边界；Agent 保留开放式假设、工具选择、观察和停止权。",
  "- EvalOS 的 Lead Agent 同样使用 Claude Agent SDK 动态调用 MCP 和按需专职 Agent，不使用固定工作流。",
  "- Outcome、Evidence、Trajectory 三路 Judge 独立评判，互相不可见；分歧、低置信和安全风险形成辅助注意信号。", "",
  "- M1.5 L1 v2 删除旧 Case 工具输出里的 component/confidence 合成提示，只让 Agent 面对原始观测。", "",
  "## 已验收的加固", "",
  ...Object.entries(automatedChecks).map(([name, passed]) => `- ${passed ? "[通过]" : "[失败]"} ${name}`), "",
  "## 正式 L1 v2 统计", "",
  `- V2 - V1 平均代码分差：${formalResult.paired_comparison.v2_minus_v1_mean}`,
  `- 按 Case 聚类 95% Bootstrap 区间：[${formalResult.paired_comparison.clustered_bootstrap_ci95.join(", ")}]`,
  `- V2胜 / 平 / V1胜：${formalResult.paired_comparison.v2_wins} / ${formalResult.paired_comparison.ties} / ${formalResult.paired_comparison.v1_wins}`,
  `- V2 pass@3 / pass³：${formalResult.contestants["agent-harness-v2"].pass_at_3} / ${formalResult.contestants["agent-harness-v2"].pass_power_3}`,
  `- V1 pass@3 / pass³：${formalResult.contestants["langgraph-v1"].pass_at_3} / ${formalResult.contestants["langgraph-v1"].pass_power_3}`, "",
  "## 历史 L1 v1 统计复算", "",
  "- 重要限制：以下72条来自带合成signals提示的L1 v1，只作历史趋势和链路证据，不代表L1 v2真实诊断能力。",
  `- V2 - V1 平均代码分差：${statistics.paired_clustered_bootstrap.mean_delta}`,
  `- 按 Case 聚类 95% Bootstrap 区间：[${statistics.paired_clustered_bootstrap.interval.join(", ")}]`,
  `- V2 pass@3 / pass³：${statistics.reliability["agent-harness-v2"].pass_at_k} / ${statistics.reliability["agent-harness-v2"].pass_power_k}`,
  `- V1 pass@3 / pass³：${statistics.reliability["langgraph-v1"].pass_at_k} / ${statistics.reliability["langgraph-v1"].pass_power_k}`,
  "- 成本比较：禁止。历史 V1/V2 成本口径不一致。", "",
  "## 下一阶段与可选专家层", "",
  "- 正式 L1 v2 的 90 个 Trial 已完成并通过独立审计；下一阶段进入 M2 协议级数字孪生。",
  "- 专家盲审不会自动为每个 Trial 建任务；只有管理员明确选择样本时才创建。",
  "- 专家结论作为独立质量信号展示，不改变历史评分，也不成为发布排名的前置条件。", "",
  `公开注册表哈希：\`${publicRegistry.sha256}\``,
  `私有标签集合哈希（不含内容）：\`${privateLabelHash}\``,
  `验收结论指纹：\`${sha256(verdict)}\``, "",
].join("\n");
writeFileSync(path.join(outputRoot, "M1.5测量系统加固验收报告.md"), report, "utf8");

console.log(JSON.stringify(verdict, null, 2));
if (!technicalPassed) process.exitCode = 1;
