import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CASE_INVESTIGATOR_RUNTIME } from "../packages/agent-runtime/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");
const investigator = read("packages/agent-runtime/src/case-investigator.mjs");
const api = read("services/control-api/src/app.mjs");
const migration = read("infra/migrations/sqlite/002_m25_workbench.sql");
const consoleSource = read("apps/console/app/workbench-client.tsx");
const graphImport = /(?:from|require\()\s*["'](?:langgraph|@langchain\/langgraph|langchain)/i;
const checks = {
  claude_agent_sdk_core: CASE_INVESTIGATOR_RUNTIME.sdk === "@anthropic-ai/claude-agent-sdk",
  deepseek_model: CASE_INVESTIGATOR_RUNTIME.provider === "deepseek" && CASE_INVESTIGATOR_RUNTIME.model === "deepseek-v4-flash",
  dynamic_agent_loop_without_graph: CASE_INVESTIGATOR_RUNTIME.orchestration === "model-driven-read-only-investigation-loop"
    && CASE_INVESTIGATOR_RUNTIME.graphFramework === null && !graphImport.test(investigator),
  model_can_choose_evidence_source_and_web: ["get_trial_bundle", "get_trace_index", "get_trace", "get_grader", "list_source_files",
    "search_source", "read_source_file", "list_related_trials", "search_methodology", "fetch_methodology"]
    .every((name) => investigator.includes(`tool("${name}"`)),
  official_grade_separate_from_analysis: /official_score_source:\s*"deterministic_code_grader"/.test(api)
    && /authority:\s*"diagnostic_only"/.test(api),
  immutable_source_bound_to_trial: /CREATE TABLE IF NOT EXISTS source_snapshots/.test(migration)
    && /CREATE TABLE IF NOT EXISTS trial_source_snapshots/.test(migration)
    && /trial_source_snapshots_no_update/.test(migration),
  append_only_analysis_evidence: /analysis_events_no_update/.test(migration) && /analysis_results_no_update/.test(migration),
  product_surfaces_complete: ["实验概览", "数据集与 Case", "轨迹与日志", "评分器", "冻结源码", "AI 分析"]
    .every((label) => consoleSource.includes(label)),
};
const result = { status: Object.values(checks).every(Boolean) ? "PASSED" : "FAILED", checks };
console.log(JSON.stringify(result, null, 2));
if (result.status !== "PASSED") process.exitCode = 1;
