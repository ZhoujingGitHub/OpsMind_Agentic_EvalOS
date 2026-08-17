import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = {
  protocol_twin: path.resolve(process.env.M2_PROTOCOL_ARTIFACTS_ROOT ?? path.join(ROOT, "artifacts", "m2")),
  change_executor: path.resolve(process.env.M2_EXECUTOR_ARTIFACTS_ROOT ?? path.join(ROOT, "artifacts", "m2-executor")),
  agent_e2e: path.resolve(process.env.M2_AGENT_ARTIFACTS_ROOT ?? path.join(ROOT, "artifacts", "m2-agent")),
  adapter_qualification: path.resolve(process.env.M2_QUALIFICATION_ARTIFACTS_ROOT ?? path.join(ROOT, "artifacts", "m2-qualification")),
};
const outputRoot = path.resolve(process.env.M2_CLOSURE_OUTPUT ?? path.join(ROOT, "artifacts", "m2-closure"));
const specs = {
  protocol_twin: "M2验收结论.json",
  change_executor: "M2变更执行器验收结论.json",
  agent_e2e: "M2-Agent端到端验收结论.json",
  adapter_qualification: "M2双架构适配资格验收结论.json",
};

function readGate(name) {
  const file = path.join(roots[name], specs[name]);
  const text = readFileSync(file, "utf8");
  return { result: JSON.parse(text), evidence: { file: specs[name],
    sha256: createHash("sha256").update(text, "utf8").digest("hex") } };
}

mkdirSync(outputRoot, { recursive: true });
const loaded = Object.fromEntries(Object.keys(specs).map((name) => [name, readGate(name)]));
const gates = Object.fromEntries(Object.entries(loaded).map(([name, item]) => [name, item.result]));
const checks = {
  protocol_twin_passed: gates.protocol_twin.status === "PASSED",
  change_executor_passed: gates.change_executor.status === "PASSED",
  agent_e2e_passed: gates.agent_e2e.status === "PASSED",
  adapter_qualification_passed: gates.adapter_qualification.status === "PASSED",
  no_m2_ranking_produced: !Object.values(gates).some((gate) => gate.ranking_produced === true),
};
const status = Object.values(checks).every(Boolean) ? "PASSED" : "FAILED";
const closure = {
  contract: "evalos-m2-closure.1",
  milestone: "M2 协议级数字孪生",
  status,
  completed_at: new Date().toISOString(),
  ranking_produced: false,
  conclusion_boundary: "M2 只证明真实协议考场、通用变更执行器、核心 Agent 端到端和双架构接入资格可信；不比较两套 OpsMind 强弱。",
  next_phase: "M3 正式独立盲测与 A/B 统计比较",
  checks,
  gates: Object.fromEntries(Object.entries(gates).map(([name, gate]) => [name, {
    gate: gate.gate, status: gate.status, run_id: gate.run_id ?? null,
  }])),
  evidence: Object.fromEntries(Object.entries(loaded).map(([name, item]) => [name, item.evidence])),
};
const privateBundle = { ...closure, gate_results: gates, private: true };
writeFileSync(path.join(outputRoot, "M2正式收口结论.json"), `${JSON.stringify(closure, null, 2)}\n`, "utf8");
const privatePath = path.join(outputRoot, "M2正式收口证据索引.private.json");
writeFileSync(privatePath, `${JSON.stringify(privateBundle, null, 2)}\n`, "utf8");
chmodSync(privatePath, 0o600);
writeFileSync(path.join(outputRoot, "M2正式收口报告.md"), [
  "# M2 正式收口报告", "", `- 结论：**${status}**`,
  "- 结论边界：M2 不产生两套 OpsMind 的胜负或排名。",
  "- 下一阶段：M3 正式独立盲测与 A/B 统计比较。", "", "## 四道硬门禁", "",
  ...Object.entries(closure.gates).map(([name, gate]) => `- ${gate.status === "PASSED" ? "通过" : "失败"}：${name}（${gate.gate ?? "未提供门禁编号"}）`),
  "", "## 重要架构声明", "",
  "- EvalOS 核心为 Claude Agent SDK + DeepSeek V4 Flash + MCP + Skill + Harness，没有 LangGraph 或固定节点工作流。",
  "- LangGraph 只作为外部被测架构参加接入资格验收。",
  "- Agent 评分不比较固定工具名或调用顺序，只认真实终态、证据、最小变更和安全行为。",
  "- 通用变更执行器门禁校准基础设施，不冒充 Agent 自主能力。", "",
].join("\n"), "utf8");
console.log(JSON.stringify({ status, checks, output_root: outputRoot }, null, 2));
if (status !== "PASSED") process.exitCode = 1;
