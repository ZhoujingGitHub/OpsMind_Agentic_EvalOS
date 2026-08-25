import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const app = read("services/control-api/src/app.mjs");
const runtime = read("packages/agent-runtime/src/claude-agent-sdk-runtime.mjs");
const intelligence = read("packages/agent-runtime/src/case-investigator.mjs");
const adapter = read("packages/agent-runtime/src/candidate-adapter-v4.mjs");
const connectors = read("packages/agent-runtime/src/product-connectors-v4.mjs");
const adapterV5 = read("packages/agent-runtime/src/candidate-adapter-v5.mjs");
const connectorsV5 = read("packages/agent-runtime/src/product-connectors-v5.mjs");
const runner = read("packages/kernel/src/runner.mjs");
const grader = read("packages/kernel/src/grader.mjs");
const failurePolicy = read("packages/kernel/src/failure-policy.mjs");
const statistics = read("packages/kernel/src/statistics.mjs");
const twinEnvironment = read("packages/twin-runtime/src/environment.mjs");
const packageFiles = ["package.json", "packages/agent-runtime/package.json", "apps/console/package.json"]
  .map(read).join("\n");

assert.match(runtime, /@anthropic-ai\/claude-agent-sdk/);
assert.match(runtime, /deepseek-v4-flash/);
assert.match(runtime, /model-driven-tool-loop/);
assert.match(intelligence, /自主形成可证伪假设/);
assert.match(intelligence, /不存在固定步骤、静态节点图或预写修复流程/);
assert.match(adapter, /external REAL_PRODUCT/);
assert.match(adapter, /submit-translate-preserve-evidence/);
assert.doesNotMatch(adapter, /toolExecutor|environment\.call|invoke.*mcp/i);
assert.match(connectors, /external-product-control-plane-client/);
assert.match(connectors, /candidateCodeMutation:\s*false/);
assert.match(connectors, /evalos-product-run-binding\.2/);
assert.match(adapterV5, /external REAL_PRODUCT/);
assert.match(adapterV5, /submit-translate-preserve-native-evidence/);
assert.doesNotMatch(adapterV5, /toolExecutor|environment\.call|invoke.*mcp/i);
assert.match(connectorsV5, /external-product-native-contract-client/);
assert.match(connectorsV5, /candidateCodeMutation:\s*false/);
assert.match(connectorsV5, /evalos-product-run-binding\.3/);
assert.doesNotMatch(connectorsV5, /from\s+["'](?:langgraph|@langchain\/langgraph|langchain)["']/i,
  "EvalOS V5 connector must not import or embed a graph framework");
assert.match(adapter, /not bound to the frozen Trial context/);
assert.match(adapterV5, /not bound to the frozen Trial context/);
assert.equal(existsSync(path.join(root, "docs/contracts/product-run-binding-v2.schema.json")), true);
assert.equal(existsSync(path.join(root, "docs/contracts/product-run-binding-v3.schema.json")), true);
assert.equal(existsSync(path.join(root, "docs/contracts/experiment-manifest-v7.schema.json")), true);
assert.match(app, /createAgentHarnessProductConnector/);
assert.match(app, /createLangGraphProductConnector/);
assert.match(app, /createTestDouble\("test-double-a"/);
assert.match(app, /test-double-a:ENGINEERING_TEST/);
assert.match(runner, /buildEvaluationContract/);
assert.match(grader, /grader_contract_version:\s*"5\.1"/);
assert.match(grader, /DETERMINISTIC_CODE_GRADER/);
assert.match(twinEnvironment, /ExternalProductTwinEnvironment/);
assert.match(twinEnvironment, /real candidate product must invoke its own MCP tools/i);
assert.match(runner, /environment\.independent_capture/);
assert.doesNotMatch(packageFiles, /"(?:langgraph|@langchain\/langgraph|langchain)"\s*:/i);
const executableManifests = readdirSync(path.join(root, "config")).filter((name) => name.endsWith(".manifest.json"));
for (const name of executableManifests) {
  const manifest = JSON.parse(read(name.startsWith("config/") ? name : `config/${name}`));
  if (name === "m3-formal-agent-capability.manifest.json" || name === "m15-smoke.manifest.json") {
    assert.equal(manifest.manifest_version, "6.0", `当前可执行清单必须是 Manifest 6.0：${name}`);
  }
}
const formal = JSON.parse(read("config/m3-formal-agent-capability.manifest.json"));
assert.equal(formal.dataset_ref, "m3-l2-agentic-formal@3.0.0");
assert.equal(formal.suite_ref, "m3-formal-80@3.0.0");
assert.equal(formal.case_refs.every((ref) => ref.endsWith("@3.0.0")), true);

for (const removed of [
  "packages/agent-runtime/src/deepseek-claude-adapter.mjs",
  "packages/agent-runtime/src/langgraph-adapter.mjs",
  "packages/agent-runtime/src/product-e2e-adapter.mjs",
  "packages/agent-runtime/python/langgraph_runner.py",
  "config/m3-adapter-qualification.manifest.json",
  "config/m3-product-e2e-qualification.manifest.json",
  "config/m3-capacity-4x.manifest.json",
  "config/m3-capacity-8x.manifest.json",
]) assert.equal(existsSync(path.join(root, removed)), false, `旧考生分身仍存在：${removed}`);

assert.doesNotMatch(`${app}\n${runner}\n${adapterV5}\n${connectorsV5}`,
  /ProductToolBridgeRegistry|\/internal\/product-tool-bridge/);
assert.match(failurePolicy, /CANDIDATE_CAPABILITY_FAILURE/);
assert.match(failurePolicy, /PRODUCT_RELIABILITY_FAILURE/);
assert.match(failurePolicy, /RATE_LIMIT/);
assert.match(statistics, /QUALIFICATION_NO_WINNER/);
assert.match(statistics, /FORMAL_DECISION/);
assert.match(statistics, /clusteredPairedBootstrap/);
assert.match(app, /trial.infrastructure_retry_scheduled/);
assert.match(app, /decision_report_digest/);
assert.match(app, /evalos-operations-health.1/);console.log("M3.1 架构检查通过：EvalOS 保持 Claude Agent SDK 开放式单 Agent，真实考生只通过外部产品接口参评，旧考生分身与 Adapter 2.0 已断代移除。");
