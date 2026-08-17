import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEEPSEEK_AGENT_RUNTIME } from "../packages/agent-runtime/src/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("config/m2-agent-acceptance.manifest.json"));
const coreFiles = [
  "packages/agent-runtime/src/deepseek-claude-adapter.mjs",
  "packages/kernel/src/runner.mjs",
  "packages/twin-runtime/src/environment.mjs",
  "packages/twin-runtime/src/ssh-client.mjs",
  "services/control-api/src/app.mjs",
  "scripts/run-real-m2.mjs",
];
const graphImport = /(?:from|require\()\s*["'](?:langgraph|@langchain\/langgraph|langchain)/i;
const violations = coreFiles.filter((file) => graphImport.test(read(file)));
const environment = read("packages/twin-runtime/src/environment.mjs");
const contracts = read("packages/twin-runtime/src/contracts.mjs");
const runner = read("packages/kernel/src/runner.mjs");
const checks = {
  claude_agent_sdk_core: DEEPSEEK_AGENT_RUNTIME.sdk === "@anthropic-ai/claude-agent-sdk",
  model_driven_loop: DEEPSEEK_AGENT_RUNTIME.orchestration === "model-driven-tool-loop",
  no_graph_framework_in_core: violations.length === 0 && DEEPSEEK_AGENT_RUNTIME.graphFramework === null,
  native_capabilities_preserved: ["Bash", "Read", "Write", "Edit", "Skill"].every((name) => DEEPSEEK_AGENT_RUNTIME.nativeTools.includes(name)),
  harness_owns_prepare_and_reset: /environment\.prepare\(\)/.test(runner) && /environment\.reset\(\)/.test(runner),
  agent_receives_observations_and_parameterized_changes: /operation:\s*"observe"/.test(environment)
    && /operation:\s*"act"/.test(environment) && /const ACTION_CONTRACTS = Object\.freeze/.test(contracts)
    && !/toolExecutor\([^)]*(?:prepare|reset)/.test(environment),
  harness_keeps_seed_isolation_and_reset: !/parameter_contract.*(?:seed|baseline_ref|trial_id)/.test(read("packages/kernel/src/m2-cases.mjs")),
  m2_is_single_system_acceptance: manifest.manifest_version === "3.0" && manifest.design === "single_system_acceptance"
    && manifest.contestants.length === 1 && manifest.contestants[0].ref === "agent-harness-v2",
  frozen_l2_dataset: Object.values((await import("../packages/kernel/src/m2-cases.mjs")).M2_CASES).length === 20,
};
const result = { status: Object.values(checks).every(Boolean) ? "PASSED" : "FAILED", checks, forbidden_core_imports: violations };
console.log(JSON.stringify(result, null, 2));
if (result.status !== "PASSED") process.exitCode = 1;
