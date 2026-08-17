import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVALOS_LEAD_RUNTIME, DEEPSEEK_AGENT_RUNTIME } from "../packages/agent-runtime/src/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenCoreImports = /(?:from|require\()\s*["'](?:langgraph|@langchain\/langgraph|langchain)/i;
const coreFiles = [
  "packages/agent-runtime/src/deepseek-claude-adapter.mjs",
  "packages/agent-runtime/src/evalos-lead-agent.mjs",
  "packages/agent-runtime/src/blind-judge.mjs",
  "packages/kernel/src/runner.mjs",
  "packages/kernel/src/store.mjs",
  "packages/kernel/src/grader.mjs",
  "services/control-api/src/app.mjs",
];
const violations = coreFiles.filter((file) => forbiddenCoreImports.test(readFileSync(path.join(root, file), "utf8")));
const result = {
  status: violations.length === 0 && DEEPSEEK_AGENT_RUNTIME.sdk === "@anthropic-ai/claude-agent-sdk"
    && EVALOS_LEAD_RUNTIME.sdk === "@anthropic-ai/claude-agent-sdk" ? "PASSED" : "FAILED",
  rules: {
    core_sdk: DEEPSEEK_AGENT_RUNTIME.sdk,
    lead_sdk: EVALOS_LEAD_RUNTIME.sdk,
    v2_graph_framework: DEEPSEEK_AGENT_RUNTIME.graphFramework,
    lead_graph_framework: EVALOS_LEAD_RUNTIME.graphFramework,
    forbidden_core_imports: violations,
    claude_sdk_runtime_sources: coreFiles.filter((file) => /claude-agent-sdk/.test(readFileSync(path.join(root, file), "utf8"))),
    langgraph_scope: "external contestant adapter only",
  },
};
console.log(JSON.stringify(result, null, 2));
if (result.status !== "PASSED") process.exitCode = 1;
