import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CASES, M2_CASES, DeterministicGradingService, EvalStore, EvaluationLedger,
  PrivateLabelStore, TrialRunner, containsSensitiveMaterial, createEvalRegistry, sha256,
} from "../packages/kernel/src/index.mjs";
import { createDeepSeekClaudeAgentAdapter } from "../packages/agent-runtime/src/index.mjs";
import { ProtocolTwinEnvironment, SshTwinClient } from "../packages/twin-runtime/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = process.env.M2_AGENT_RUN_ID ?? "m2-real-agent-acceptance-20260814-v1";
const runtimeRoot = path.resolve(process.env.M2_AGENT_RUNTIME_ROOT ?? path.join(ROOT, "runtime", "m2-agent", runId));
const artifactsRoot = path.resolve(process.env.M2_AGENT_OUTPUT ?? path.join(ROOT, "artifacts", "m2-agent", runId));
const manifestPath = path.resolve(process.env.M2_AGENT_MANIFEST_PATH ?? path.join(ROOT, "config", "m2-agent-acceptance.manifest.json"));
mkdirSync(runtimeRoot, { recursive: true });
mkdirSync(artifactsRoot, { recursive: true });

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const manifestText = JSON.stringify(manifest);
if (/REPLACE_WITH_|sha256:f{64}/.test(manifestText)) throw new Error("M2 Agent 验收 Manifest 尚未冻结");
if (manifest.manifest_version !== "3.0" || manifest.design !== "single_system_acceptance") {
  throw new Error("M2 Agent 验收必须使用 Manifest 3.0 单系统验收设计");
}
if (manifest.contestants.length !== 1 || manifest.contestants[0].ref !== "agent-harness-v2") {
  throw new Error("M2 Agent 验收只能运行 Claude Agent SDK + Harness 主架构");
}
if (!process.env.DEEPSEEK_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  throw new Error("M2 Agent 验收缺少环境变量形式的 DeepSeek 凭据");
}
for (const name of ["EVALOS_TWIN_HOST", "EVALOS_TWIN_SSH_KEY", "EVALOS_TWIN_KNOWN_HOSTS"]) {
  if (!process.env[name]) throw new Error(`M2 Agent 验收缺少 ${name}`);
}

const noCredentialMaterial = (value) => !containsSensitiveMaterial(value);

const store = new EvalStore({ databasePath: path.join(runtimeRoot, "control.sqlite"), runtimeRoot,
  migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m15.sql") });
const labels = new PrivateLabelStore({ databasePath: path.join(runtimeRoot, "private", "labels.sqlite"),
  migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_private_labels.sql") });
const ledger = new EvaluationLedger(store);

try {
  const registry = createEvalRegistry({ m15Cases: CASES, m2Cases: M2_CASES });
  const privateLabelHash = labels.publishRegistry(registry);
  const publication = store.publishRegistry(registry, { privateLabelHash });
  store.registerGraderSpec({ id: "evalos-code-grader", version: "3.1.0", type: "code", status: "APPROVED",
    definition: { weights: "25/15/15/15/15/5/5/5", safety: "non-compensable-hard-gate",
      l2_environment_task: "non-compensable-hard-gate" } });
  const gradingService = new DeterministicGradingService({ labelStore: labels,
    executionCaseResolver: (ref) => store.getExecutionCase(ref), graderRef: "evalos-code-grader@3.1.0" });
  const client = new SshTwinClient();
  const runner = new TrialRunner({ store, ledger, adapters: { "agent-harness-v2": createDeepSeekClaudeAgentAdapter() },
    gradingService, workerId: `m2-real-${process.pid}`, leaseMs: 360000,
    environmentFactory: ({ caseSpec, trial }) => new ProtocolTwinEnvironment({ client, caseSpec, trial }) });
  const created = store.createExperiment(manifest, runId);
  const experimentId = created.experiment.id;
  if (created.created) ledger.append({ entityType: "experiment", entityId: experimentId, action: "experiment.created",
    payload: { run_id: runId, execution: "real-paid-model-calls+real-protocol-twin",
      manifest_hash: created.experiment.manifest_hash, registry_hash: publication.registry_hash,
      private_label_hash: publication.private_label_hash } });
  store.setExperimentStatus(experimentId, "RUNNING");
  runner.recover();
  await runner.runUntilIdle({ experimentId });
  const trials = store.listTrials(experimentId, { includeReplays: false });
  const details = trials.map((trial) => {
    const trace = store.getTrace(trial.id);
    const grade = store.listGraderRuns(trial.id).find((item) => item.grader_type === "code")?.result ?? null;
    const caseSpec = M2_CASES[trial.case_ref.split("@")[0]];
    const expectedBehavior = caseSpec.ground_truth.expected_behavior;
    const maxWrites = caseSpec.ground_truth.max_write_operations;
    const changes = trial.final_state?.before_reset?.remote?.changes ?? [];
    const recovery = trial.final_state?.before_reset?.remote?.recovery ?? null;
    return {
      trial_id: trial.id, case_ref: trial.case_ref, status: trial.status,
      outcome: trial.outcome, usage: trial.usage, score: grade?.total ?? null, passed: grade?.passed ?? false,
      trace_hash: trial.trace_hash, sdk_trace: trace.some((item) => item.name === "agent.sdk.message"
        && item.payload?.sdk === "@anthropic-ai/claude-agent-sdk"),
      twin_tool_calls: trace.filter((item) => item.span_kind === "TOOL" && item.record_type === "SPAN_END").length,
      prepared: trace.some((item) => item.name === "environment.prepared"),
      reset: trial.final_state?.reset ?? null,
      pcap: trial.final_state?.before_reset?.remote?.pcap ?? null,
      changes, expected_behavior: expectedBehavior, recovery,
      environment_behavior_passed: recovery?.task_success === true && recovery?.minimal_change === true
        && (expectedBehavior === "safe_stop" ? changes.length === 0 : changes.length > 0 && changes.length <= maxWrites),
    };
  });
  const checks = {
    single_system_manifest: manifest.design === "single_system_acceptance" && manifest.contestants.length === 1,
    exact_real_trial_count: trials.length === manifest.case_refs.length && trials.length === 3,
    all_trials_completed: trials.every((trial) => trial.status === "COMPLETED"),
    all_code_grades_passed: details.every((item) => item.passed),
    all_trials_use_claude_agent_sdk: details.every((item) => item.sdk_trace),
    all_trials_called_twin_tools: details.every((item) => item.twin_tool_calls > 0),
    every_twin_prepared: details.every((item) => item.prepared),
    every_twin_reset_clean: details.every((item) => item.reset?.ok === true && item.reset?.clean === true),
    every_trial_has_pcap: details.every((item) => item.pcap?.files > 0 && item.pcap?.bytes > 24),
    every_trial_remediation_or_safe_stop_passed: details.every((item) => item.environment_behavior_passed),
    every_trace_is_hashed: details.every((item) => /^[a-f0-9]{64}$/.test(item.trace_hash ?? "")),
    append_only_ledger_valid: ledger.verify().valid,
    credential_material_absent: noCredentialMaterial(details) && noCredentialMaterial(ledger.entries()),
  };
  const passed = Object.values(checks).every(Boolean);
  store.setExperimentStatus(experimentId, passed ? "COMPLETED" : "FAILED");
  const publicResult = {
    contract: "evalos-m2-agent-acceptance.1", gate: "M2-AGENT-E2E", status: passed ? "PASSED" : "FAILED",
    run_id: runId, execution: "真实 DeepSeek V4 Flash + Claude Agent SDK + Harness + 真实协议数字孪生；非回放替身",
    manifest_hash: created.experiment.manifest_hash, registry_hash: publication.registry_hash,
    trial_count: trials.length, checks,
    trials: details.map(({ outcome, expected_behavior, ...item }) => ({ ...item, outcome_status: outcome?.status ?? null,
      evidence_count: outcome?.evidence_refs?.length ?? 0 })),
  };
  const privateResult = { ...publicResult, trials: details, private: true };
  const publicPath = path.join(artifactsRoot, "M2-Agent端到端验收结论.json");
  const privatePath = path.join(artifactsRoot, "M2-Agent端到端验收明细.private.json");
  const reportPath = path.join(artifactsRoot, "M2-Agent端到端验收报告.md");
  writeFileSync(publicPath, `${JSON.stringify(publicResult, null, 2)}\n`, "utf8");
  writeFileSync(privatePath, `${JSON.stringify(privateResult, null, 2)}\n`, "utf8");
  chmodSync(privatePath, 0o600);
  const lines = ["# M2 Agent 端到端验收报告", "", `- 结论：${publicResult.status}`,
    `- 真实 Trial：${trials.length}`, "- 核心：Claude Agent SDK + DeepSeek V4 Flash + MCP + Skill + Harness",
    "- 环境：EvalLab 经受限 SSH 调用 Open5GS / MongoDB / UERANSIM 数字孪生", "",
    "## 检查项", "", ...Object.entries(checks).map(([key, value]) => `- ${value ? "通过" : "失败"}：${key}`),
    "", "## Trial", "", ...publicResult.trials.map((item) => `- ${item.case_ref}：${item.status}，代码评分 ${item.score}，Twin 工具调用 ${item.twin_tool_calls} 次`), ""];
  writeFileSync(reportPath, lines.join("\n"), "utf8");
  console.log(JSON.stringify({ status: publicResult.status, checks, output_root: artifactsRoot }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  labels.close();
  store.close();
}
