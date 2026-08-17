import { mkdirSync } from "node:fs";
import path from "node:path";
import { blindExperimentView, blindGraderRunView, blindTraceView, blindTrialView } from "../../kernel/src/projections.mjs";
import { deepSeekEnvironment } from "./deepseek-claude-adapter.mjs";

const DEFAULT_MODEL = "deepseek-v4-flash";
const READ_ONLY_TOOLS = ["mcp__evalos__list_experiments", "mcp__evalos__get_experiment", "mcp__evalos__get_trial_trace",
  "mcp__evalos__get_measurement_health", "mcp__evalos__get_optional_expert_reviews"];

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    objective: { type: "string" },
    findings: { type: "array", items: { type: "object", properties: {
      category: { type: "string" }, severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
      claim: { type: "string" }, evidence_refs: { type: "array", items: { type: "string" } }, confidence: { type: "number", minimum: 0, maximum: 1 },
    }, required: ["category", "severity", "claim", "evidence_refs", "confidence"], additionalProperties: false } },
    recommended_actions: { type: "array", items: { type: "object", properties: {
      action: { type: "string" }, owner: { type: "string" }, requires_human_approval: { type: "boolean" }, validation: { type: "string" },
    }, required: ["action", "owner", "requires_human_approval", "validation"], additionalProperties: false } },
    limitations: { type: "array", items: { type: "string" } },
  },
  required: ["objective", "findings", "recommended_actions", "limitations"], additionalProperties: false,
};

function parse(value) {
  if (value && typeof value === "object") return value;
  const text = String(value ?? "").trim();
  return JSON.parse(text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text);
}

function readOnlyPolicy() {
  return async (toolName) => READ_ONLY_TOOLS.includes(toolName) || toolName === "Agent" || toolName === "Skill" || toolName === "ToolSearch"
    ? { behavior: "allow" }
    : { behavior: "deny", message: "M1.5 Lead Eval Agent只允许读取评测证据和提出建议；不可改规则或执行发布。" };
}

export function createEvalOSLeadAgent({ store, measurementHealth, apiKey, model = DEFAULT_MODEL } = {}) {
  return {
    id: "evalos-lead-agent",
    runtime: `claude-agent-sdk/${model}`,
    architecture: "model-driven-lead-with-on-demand-specialists",
    async analyze({ objective, namespace, maxTurns = 16 }) {
      mkdirSync(namespace, { recursive: true });
      const [{ query, tool, createSdkMcpServer }, { z }] = await Promise.all([
        import("@anthropic-ai/claude-agent-sdk"), import("zod"),
      ]);
      const tools = [
        tool("list_experiments", "列出冻结实验及其完成率。", {}, async () => ({ content: [{ type: "text", text: JSON.stringify(store.listExperiments().map(blindExperimentView)) }] })),
        tool("get_experiment", "读取实验、匿名Trial与聚合结果。", { experiment_id: z.string() }, async ({ experiment_id }) => ({
          content: [{ type: "text", text: JSON.stringify({
            summary: { ...store.experimentSummary(experiment_id), experiment: blindExperimentView(store.getExperiment(experiment_id)) },
            trials: store.listTrials(experiment_id).map(blindTrialView),
          }) }],
        })),
        tool("get_trial_trace", "读取某Trial的Span Trace与多评分器记录。", { trial_id: z.string() }, async ({ trial_id }) => ({
          content: [{ type: "text", text: JSON.stringify({ trace: blindTraceView(store.getTrace(trial_id)),
            graders: store.listGraderRuns(trial_id).map(blindGraderRunView), judges: store.listJudgeRuns(trial_id) }) }],
        })),
        tool("get_measurement_health", "读取确定性评分、辅助Judge、数据质量和账本健康。", {}, async () => ({
          content: [{ type: "text", text: JSON.stringify(measurementHealth()) }],
        })),
        tool("get_optional_expert_reviews", "按需读取可选专家复核样本；它不阻塞验收或排名。", {}, async () => ({
          content: [{ type: "text", text: JSON.stringify(store.listHumanReviewTasks()) }],
        })),
      ];
      const server = createSdkMcpServer({ name: "evalos", version: "1.0.0", tools });
      const agents = {
        "failure-diagnosis": { description: "当需要从多条轨迹区分Agent、Tool、Context、Environment、Task、Grader、Policy或Randomness责任时使用。",
          prompt: "独立分析关键失败步骤、失败签名和Lucky Pass。引用Trial/Span，不把一切归因于模型。只读，不提出未经证据支持的结论。", tools: READ_ONLY_TOOLS, maxTurns: 8 },
        "meta-eval-auditor": { description: "当需要检查坏题、评分分歧、Judge漂移、数据泄漏或测量系统健康时使用。",
          prompt: "独立审计测量系统。确定性 Code Grader 是官方分数；模型 Judge 只作辅助诊断；专家复核若存在也只作为可选质量信号。检查坏题、评分分歧、安全召回和样本平衡。只读。", tools: READ_ONLY_TOOLS, maxTurns: 8 },
        "evidence-reporter": { description: "当需要把总体统计、场景分组和代表Trial组织成可复核结论时使用。",
          prompt: "只基于可回溯证据组织结论，同时呈现正负结果、样本量、仿真级别和限制。只读。", tools: READ_ONLY_TOOLS, maxTurns: 8 },
      };
      let result = null;
      for await (const message of query({ prompt: objective, options: {
        model, cwd: namespace, maxTurns, maxBudgetUsd: 1,
        systemPrompt: [
          "你是 OpsMind Agentic EvalOS 的 Lead Eval Orchestrator，由官方 Claude Agent SDK 的原生 Agent Loop 驱动。",
          "你自主决定要查看哪些实验、Trial、Trace和测量健康信息，也可按需委派相互独立的专职Agent；不存在固定步骤、静态图或预定工具顺序。",
          "你可以发现失败、聚类、解释分歧并提出实验、复核或改进建议，但不能选择或修改随机种子、重复次数、预算、盲测身份、Ground Truth、Grader、安全门槛、账本、合并或发布。",
          "所有结论必须引用可审计标识；证据不足时明确限制，不得把仿真称为生产，也不得猜测匿名架构。",
        ].join(" "),
        tools: ["Agent", "Skill", "ToolSearch"], agents, mcpServers: { evalos: server }, strictMcpConfig: true,
        allowedTools: ["Agent", "Skill", "ToolSearch", ...READ_ONLY_TOOLS], canUseTool: readOnlyPolicy(), permissionMode: "dontAsk",
        settingSources: [], outputFormat: { type: "json_schema", schema: REPORT_SCHEMA },
        sandbox: { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
          filesystem: { allowWrite: [namespace], denyRead: [path.resolve(namespace, "..", "private")] } },
        persistSession: true, includePartialMessages: false, env: deepSeekEnvironment({ apiKey, model, trialNamespace: namespace }),
      } })) if (message.type === "result") {
        if (message.subtype !== "success") throw new Error(message.result ?? `Lead Eval Agent failed: ${message.subtype}`);
        result = message.structured_output ?? message.result;
      }
      if (!result) throw new Error("Lead Eval Agent returned no report");
      return parse(result);
    },
  };
}

export const EVALOS_LEAD_RUNTIME = Object.freeze({ sdk: "@anthropic-ai/claude-agent-sdk", provider: "deepseek", model: DEFAULT_MODEL,
  orchestration: "model-driven-tool-loop", specialistAgents: ["failure-diagnosis", "meta-eval-auditor", "evidence-reporter"],
  deterministicControls: ["seeds", "replicates", "budgets", "isolation", "safety", "blinds", "graders", "ledger"], graphFramework: null });
