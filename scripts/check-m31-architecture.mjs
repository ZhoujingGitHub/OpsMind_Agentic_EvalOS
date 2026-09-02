import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const app = read("services/control-api/src/app.mjs");
const runtime = read("packages/agent-runtime/src/claude-agent-sdk-runtime.mjs");
const intelligence = read("packages/agent-runtime/src/case-investigator.mjs");
const blindJudge = read("packages/agent-runtime/src/blind-judge.mjs");
const adapter = read("packages/agent-runtime/src/candidate-adapter-v4.mjs");
const connectors = read("packages/agent-runtime/src/product-connectors-v4.mjs");
const adapterV5 = read("packages/agent-runtime/src/candidate-adapter-v5.mjs");
const connectorsV5 = read("packages/agent-runtime/src/product-connectors-v5.mjs");
const runner = read("packages/kernel/src/runner.mjs");
const grader = read("packages/kernel/src/grader.mjs");
const failurePolicy = read("packages/kernel/src/failure-policy.mjs");
const statistics = read("packages/kernel/src/statistics.mjs");
const resourceProfile = read("packages/kernel/src/budget-profile.mjs");
const twinEnvironment = read("packages/twin-runtime/src/environment.mjs");
const peripheralContracts = read("packages/kernel/src/peripheral-mvp-contracts.mjs");
const packageFiles = ["package.json", "packages/agent-runtime/package.json", "apps/console/package.json"]
  .map(read).join("\n");

assert.match(runtime, /@anthropic-ai\/claude-agent-sdk/);
assert.match(runtime, /deepseek-v4-flash/);
assert.match(runtime, /model-driven-tool-loop/);
assert.doesNotMatch(blindJudge, /maxBudgetUsd\s*:/,
  "三位 AI Judge 不得设置费用截断上限；Token、费用和耗时只记录，不据此中断或评分");
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
assert.equal(existsSync(path.join(root, "docs/contracts/candidate-deployment-attestation-v1.schema.json")), true);
assert.equal(existsSync(path.join(root, "docs/contracts/experiment-manifest-v8.schema.json")), true);
assert.equal(existsSync(path.join(root, "docs/contracts/trial-efficiency-audit-v1.schema.json")), true);
assert.equal(existsSync(path.join(root, "packages/kernel/src/budget-profile.mjs")), true);
assert.equal(existsSync(path.join(root, "packages/kernel/src/efficiency-audit.mjs")), true);
assert.match(app, /trustedDeploymentAttestation/);
assert.doesNotMatch(app, /attestation:\s*\{\s*source_revision:\s*frozen\.source_revision/,
  "Candidate discovery must not return the frozen Manifest as if it were an independently observed deployment identity");
assert.match(app, /createAgentHarnessProductConnector/);
assert.match(app, /createLangGraphProductConnector/);
assert.match(app, /createTestDouble\("test-double-a"/);
assert.match(app, /test-double-a:ENGINEERING_TEST/);
assert.match(runner, /buildEvaluationContract/);
assert.match(grader, /grader_version: context\.graderRef \?\? "evalos-code-grader@5\.3\.0"/);
assert.match(grader, /recommendation quality is a separate zero-weight qualification signal/);
assert.match(grader, /DETERMINISTIC_CODE_GRADER/);
assert.match(twinEnvironment, /ExternalProductTwinEnvironment/);
assert.match(twinEnvironment, /real candidate product must invoke its own MCP tools/i);
assert.match(twinEnvironment, /candidate_runtime_lease_bound/);
assert.match(twinEnvironment, /verifyCandidateBinding/);
assert.match(adapterV5, /readiness_authority: "evalos_signed_candidate_presence"/);
assert.doesNotMatch(adapterV5, /candidate_observation_binding_not_ready/,
  "Legacy Candidate Observation must not remain a second Twin readiness authority");
assert.match(peripheralContracts, /opsmind-candidate-presence\/1\.0/);
assert.match(peripheralContracts, /assertCandidatePreflight/);
assert.match(peripheralContracts, /assertCandidateBound/);
assert.doesNotMatch(peripheralContracts, /(?:LangGraph|ClaudeSDKClient|DeepSeek|hypothesis|root_cause|scenario_id)/,
  "Candidate presence must remain status-only, not a candidate workflow or Case brain");
assert.match(runner, /environment\.independent_capture/);
assert.doesNotMatch(packageFiles, /"(?:langgraph|@langchain\/langgraph|langchain)"\s*:/i);
const executableManifests = readdirSync(path.join(root, "config")).filter((name) => name.endsWith(".manifest.json"));
for (const name of executableManifests) {
  const manifest = JSON.parse(read(name.startsWith("config/") ? name : `config/${name}`));
  if (name === "m15-smoke.manifest.json") {
    assert.equal(manifest.manifest_version, "6.0", "工程测试替身必须继续使用历史隔离的 Manifest 6.0");
    assert.equal(manifest.frozen_dependencies.grader.ref, "evalos-code-grader@5.3.0",
      "当前可执行工程测试不得偷偷保留旧 Grader 路径");
  }
  if (name === "m3-formal-agent-capability.manifest.json") {
    assert.equal(manifest.manifest_version, "8.0", "新的真实产品冻结源必须使用 Manifest 8.0 开放资源合同");
    assert.equal(manifest.milestone, "M3.2");
    assert.equal(manifest.contestants.every((item) => item.adapter_contract_version === "5.0"), true);
    assert.equal(manifest.contestants.every((item) => item.adapter_version === "candidate-adapter-5.0.0"), true);
    assert.equal(manifest.contestants.every((item) => item.candidate_runtime?.models?.length > 0), true);
    assert.equal(manifest.candidate_resource_contract.mode, "OPEN");
    assert.equal(manifest.candidate_resource_contract.policy.usage_affects_score, false);
    assert.equal(manifest.candidate_resource_contract.policy.cross_architecture_equal_limits_required, false);
  }
}
const formal = JSON.parse(read("config/m3-formal-agent-capability.manifest.json"));
const relayCandidates = JSON.parse(read("config/candidate-relay-public-keys.json")).candidates;
assert.equal(formal.dataset_ref, "m3-l2-agentic-formal@3.1.0");
assert.equal(formal.suite_ref, "m3-formal-80@3.1.0");
assert.equal(formal.case_refs.every((ref) => ref.endsWith("@3.1.0")), true);
assert.equal(formal.frozen_dependencies.grader.ref, "evalos-code-grader@5.3.0");
assert.equal(formal.model.sdk, "@anthropic-ai/claude-agent-sdk");
assert.equal(formal.model.id, "deepseek-v4-flash");
assert.deepEqual(formal.contestants.find((item) => item.ref === "langgraph-v1")
  .candidate_runtime.models.map((item) => item.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
assert.equal(formal.contestants.find((item) => item.ref === "langgraph-v1")
  .candidate_runtime.versions.job_runtime_limits_contract_version, "opsmind-job-runtime-limits:1.0");
for (const contestant of formal.contestants) {
  const attestation = relayCandidates[contestant.ref]?.deployment_attestation;
  assert.equal(attestation?.source_revision, contestant.source_revision,
    `${contestant.ref} 的可信部署 revision 必须与 Manifest 冻结身份一致`);
  assert.equal(attestation?.artifact_digest, contestant.artifact_digest,
    `${contestant.ref} 的可信部署镜像摘要必须与 Manifest 冻结身份一致`);
}
assert.match(resourceProfile, /evalos-candidate-open-resource\/1\.0/);
assert.match(resourceProfile, /cross_architecture_equal_limits_required/);
assert.match(resourceProfile, /usage_affects_score/);

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
assert.match(app, /evalos-operations-health.1/);
console.log("M3.2 架构检查通过：EvalOS 保持 Claude Agent SDK + DeepSeek V4 Flash 开放式单 Agent；Manifest 8 按架构开放产品最大资源且用量不评分，Manifest 7/6 只读保留历史证据。");
