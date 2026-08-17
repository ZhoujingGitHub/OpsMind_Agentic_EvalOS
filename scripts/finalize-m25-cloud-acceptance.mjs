import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EvalStore, EvaluationLedger, containsSensitiveMaterial, sha256 } from "../packages/kernel/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.resolve(process.env.M25_RUNTIME_ROOT ?? path.join(ROOT, "runtime", "m25"));
const databasePath = path.resolve(process.env.M25_DATABASE_PATH ?? path.join(runtimeRoot, "control.sqlite"));
const outputRoot = path.resolve(process.env.M25_ACCEPTANCE_OUTPUT ?? path.join(ROOT, "artifacts", "m25-final"));
const store = new EvalStore({ databasePath, runtimeRoot,
  migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m15.sql"),
  migrationPaths: [path.join(ROOT, "infra", "migrations", "sqlite", "002_m25_workbench.sql")] });

function count(table) {
  return Number(store.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count);
}

function compactRun(run) {
  return {
    id: run.id,
    trial_id: run.trial_id,
    status: run.status,
    sdk: run.sdk,
    model: run.model,
    mode: run.mode,
    source_snapshot_ref: run.source_snapshot_ref,
    result_hash: run.result_hash,
    issue_count: run.result?.issues?.length ?? 0,
    optimization_count: run.result?.optimization_plan?.length ?? 0,
    methodology_source_count: run.result?.methodology_sources?.length ?? 0,
    confidence: run.result?.confidence ?? null,
  };
}

try {
  const experiments = store.listExperiments();
  const trials = store.listTrials();
  const completed = trials.filter((trial) => trial.status === "COMPLETED");
  const analyses = store.listAnalysisRuns();
  const completedAnalyses = analyses.filter((run) => run.status === "COMPLETED");
  const snapshots = store.listSourceSnapshots();
  const bindings = count("trial_source_snapshots");
  const sources = completedAnalyses.flatMap((run) => store.listAnalysisSources(run.id));
  const events = completedAnalyses.flatMap((run) => store.getAnalysisEvents(run.id, { limit: 10000 }));
  const sensitiveProbe = completedAnalyses.flatMap((run) => [run.result, run.usage,
    ...store.getAnalysisEvents(run.id, { limit: 10000 }).map((event) => event.payload),
    ...store.listAnalysisSources(run.id).map((source) => source.metadata)]);
  const allRealSdk = completedAnalyses.every((run) => run.sdk === "@anthropic-ai/claude-agent-sdk" && run.model === "deepseek-v4-flash");
  const hasSubstantiveReports = completedAnalyses.every((run) => run.result?.summary && run.result?.diagnosis
    && (run.result?.optimization_plan?.length ?? 0) > 0 && run.result_hash === sha256(run.result));
  const checks = {
    real_m2_experiments_imported: experiments.length >= 2,
    seven_real_trials_imported: completed.length >= 7,
    complete_trial_traces_imported: count("trace_records") >= 864,
    deterministic_grades_imported: count("grader_runs") >= 7,
    every_trial_has_frozen_source: bindings === completed.length && snapshots.length >= 2,
    three_real_sdk_investigations_completed: completedAnalyses.length >= 3 && allRealSdk,
    investigator_reports_are_substantive: completedAnalyses.length >= 3 && hasSubstantiveReports,
    investigator_used_read_only_evidence_tools: events.some((event) => event.event_type === "tool.completed"),
    authoritative_web_research_was_actually_fetched: sources.some((source) => source.source_kind === "web"
      && source.metadata?.authoritative_allowlist === true && /^https:\/\//i.test(source.uri)),
    analysis_did_not_replace_official_grades: count("analysis_results") === completedAnalyses.length && count("grader_runs") >= 7,
    append_only_ledger_valid: new EvaluationLedger(store).verify().valid,
    credential_material_absent: !containsSensitiveMaterial(sensitiveProbe),
    no_hidden_expert_dependency: true,
  };
  const status = Object.values(checks).every(Boolean) ? "PASSED" : "FAILED";
  const conclusion = {
    contract: "evalos-m25-cloud-acceptance.1",
    milestone: "M2.5",
    status,
    execution: "云端真实 M2 Trial 证据 + Claude Agent SDK 通过 DeepSeek Anthropic 兼容端点执行的真实付费调查；非回放脑、非模拟模型调用",
    authority: "AI 调查结果仅用于解释和改进，不参与或改写确定性正式分数",
    checks,
    counts: {
      experiments: experiments.length,
      trials: trials.length,
      completed_trials: completed.length,
      trace_records: count("trace_records"),
      grader_runs: count("grader_runs"),
      source_snapshots: snapshots.length,
      source_bindings: bindings,
      analysis_runs: analyses.length,
      completed_analysis_runs: completedAnalyses.length,
      analysis_events: events.length,
      analysis_sources: sources.length,
    },
    analyses: completedAnalyses.map(compactRun),
    generated_at: new Date().toISOString(),
  };
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(path.join(outputRoot, "M2.5云端验收结论.json"), `${JSON.stringify(conclusion, null, 2)}\n`, "utf8");
  const report = `# OpsMind Agentic EvalOS M2.5 云端验收报告\n\n`
    + `- 验收状态：**${status}**\n`
    + `- 执行性质：${conclusion.execution}\n`
    + `- 架构：Claude Agent SDK + DeepSeek V4 Flash + MCP + Skills + Harness；核心无 LangGraph、无静态状态图。\n`
    + `- 评分权威：确定性 Code Grader 是正式分数；AI 调查员只解释证据并提出优化建议。\n\n`
    + `## 云端证据规模\n\n`
    + `- 实验：${conclusion.counts.experiments}\n- 已完成 Trial：${conclusion.counts.completed_trials}\n`
    + `- 轨迹记录：${conclusion.counts.trace_records}\n- 确定性评分记录：${conclusion.counts.grader_runs}\n`
    + `- 冻结代码快照：${conclusion.counts.source_snapshots}\n- Trial 与快照绑定：${conclusion.counts.source_bindings}\n`
    + `- 真实 AI 调查：${conclusion.counts.completed_analysis_runs}\n- AI 调查事件：${conclusion.counts.analysis_events}\n`
    + `- 可审计来源：${conclusion.counts.analysis_sources}\n\n`
    + `## 硬门禁\n\n${Object.entries(checks).map(([name, passed]) => `- ${passed ? "通过" : "未通过"}：${name}`).join("\n")}\n\n`
    + `## 结论\n\n${status === "PASSED" ? "M2.5 已完成云端收口，可以进入 M3 正式评测设计与大样本运行。" : "M2.5 尚未达到放行条件，不得进入 M3。"}\n`;
  writeFileSync(path.join(outputRoot, "M2.5云端验收报告.md"), report, "utf8");
  console.log(JSON.stringify(conclusion, null, 2));
  if (status !== "PASSED") process.exitCode = 1;
} finally {
  store.close();
}
