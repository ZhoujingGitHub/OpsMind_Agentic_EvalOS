import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const app = readFileSync(path.join(root, "services/control-api/src/app.mjs"), "utf8");
const store = readFileSync(path.join(root, "packages/kernel/src/store.mjs"), "utf8");
const ui = readFileSync(path.join(root, "apps/console/app/workbench-client.tsx"), "utf8");
const semantics = readFileSync(path.join(root, "packages/kernel/src/event-semantics.mjs"), "utf8");

assert.match(app, /createDeepSeekClaudeAgentAdapter/);
assert.match(app, /createExperiment\(manifest, `evaluation-request:/);
assert.match(app, /evaluation_mode: request\.mode/);
assert.match(app, /affects_official_score: request\.mode === "FORMAL"/);
assert.match(store, /evaluation_run_requests/);
assert.match(store, /source_trial_id/);
assert.match(ui, /你选择“考什么”；Agent 仍自主决定“怎么解决”/);
assert.match(ui, /原结果与新结果对比/);
assert.match(ui, /LangGraph OpsMind/);
assert.match(semantics, /evalos-event-semantics\.1/);
assert.doesNotMatch(ui, /固定节点|状态图|StateGraph|@langchain\/langgraph|from\s+["'][^"']*langgraph/i);
console.log("M2.6 架构检查通过：界面可识别外部 LangGraph 对照考生，但控制面不引入图编排且不干预 Agent 自主求解。");
