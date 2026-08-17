import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const deepSeek = read("packages/agent-runtime/src/deepseek-claude-adapter.mjs");
const langGraph = read("packages/agent-runtime/src/langgraph-adapter.mjs");
const product = read("packages/agent-runtime/src/product-e2e-adapter.mjs");
const runner = read("packages/kernel/src/runner.mjs");
const contract = read("packages/kernel/src/evaluation-contract.mjs");
const store = read("packages/kernel/src/store.mjs");
const app = read("services/control-api/src/app.mjs");
const manifestSchema = read("docs/contracts/experiment-manifest.schema.json");
const designFreeze = read("scripts/freeze-m3-design.mjs");

// 核心考生仍由 Claude Agent SDK 驱动；M3 不能把它替换成普通 API 或图工作流。
assert.match(deepSeek, /@anthropic-ai\/claude-agent-sdk/);
assert.match(deepSeek, /for await \(const message of query\(/);
assert.match(deepSeek, /supportedEvaluationLanes:\s*\["AGENT_CAPABILITY"\]/);
assert.doesNotMatch(deepSeek, /@langchain\/langgraph|StateGraph|createReactAgent/);

// 两类考生都只能走能力通道；商用品质必须经过独立的 Product E2E Adapter。
assert.match(langGraph, /supportedEvaluationLanes:\s*\["AGENT_CAPABILITY"\]/);
assert.match(product, /supportedEvaluationLanes:\s*\["PRODUCT_E2E"\]/);
assert.match(runner, /\$\{trial\.contestant_ref\}:\$\{experiment\.manifest\.evaluation_lane\}/);
assert.match(app, /adapters\[`\$\{ref\}:PRODUCT_E2E`\]/);

// Harness 冻结公平性和安全边界，但不冻结 Agent 的调查路径。
assert.match(contract, /environment_seed: trial\.environment_seed/);
assert.match(contract, /replicate_id: trial\.replicate_id/);
assert.match(contract, /tools: Object\.entries\(caseSpec\.tools/);
assert.match(contract, /model: experiment\.manifest\.model/);
assert.match(contract, /budget: trial\.budget/);
assert.match(contract, /policy: experiment\.manifest\.policy/);
assert.match(contract, /contract_digest/);
assert.match(store, /legacy manifests are not accepted/);
assert.match(store, /capability_failures_retryable !== false/);
assert.match(store, /if \(!scheduleTrials\) return/);
assert.match(app, /experiment\.design_frozen/);
assert.match(app, /frozenDesign \? "FROZEN" : experiment\.status/);
assert.match(manifestSchema, /"manifest_version"\s*:\s*\{\s*"const"\s*:\s*"4\.0"/);
assert.match(manifestSchema, /"AGENT_CAPABILITY",\s*"PRODUCT_E2E"/);
assert.match(designFreeze, /M3-REG-001@2\.0\.0/);
assert.match(designFreeze, /M3-REG-002@2\.0\.0/);
assert.doesNotMatch(designFreeze, /M3-REG-005@1\.0\.0/);

console.log("M3.0 架构检查通过：Claude Agent SDK 单 Agent 核心、Adapter 2.0、双评测通道、零 Trial 冻结设计与 Harness 边界均已固化。");
