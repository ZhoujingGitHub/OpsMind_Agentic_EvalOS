import { existsSync } from "node:fs";
import path from "node:path";

const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const DEFAULT_MODEL = "deepseek-v4-flash";
const NATIVE_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebSearch", "WebFetch", "Skill", "ToolSearch"];
const DESTRUCTIVE_COMMAND = /(?:\brm\s+-[^\n]*r|\bshutdown\b|\breboot\b|\bmkfs\b|\bdd\s+if=|\bgit\s+(?:reset\s+--hard|clean\s+-|push\s+--force)|\bcurl\b[^\n]*(?:api[_-]?key|token|password|secret))/i;

const OUTCOME_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["resolved", "inconclusive"] },
    root_cause: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence_refs: { type: "array", items: { type: "string" }, uniqueItems: true },
    exclusions: { type: "array", items: { type: "string" } },
    tool_failures_recovered: { type: "boolean" },
    next_checks: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["status", "root_cause", "confidence", "evidence_refs", "exclusions", "tool_failures_recovered", "next_checks", "summary"],
  additionalProperties: false,
};

function parseOutcome(result) {
  if (result && typeof result === "object") return result;
  const text = String(result ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  try {
    return JSON.parse(fenced);
  } catch {
    throw new Error("Claude Agent SDK returned a non-JSON final outcome");
  }
}

export function deepSeekEnvironment({ apiKey, model = DEFAULT_MODEL, trialNamespace } = {}) {
  const token = apiKey ?? process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
  if (!token) throw new Error("DeepSeek API key is required at runtime; set DEEPSEEK_API_KEY or ANTHROPIC_AUTH_TOKEN");
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? DEEPSEEK_ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: token,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_EFFORT_LEVEL: "max",
    CLAUDE_AGENT_SDK_CLIENT_APP: "opsmind-evalos/m1-agent-harness-v2",
    ...(trialNamespace ? { CLAUDE_CONFIG_DIR: path.join(trialNamespace, ".claude-state") } : {}),
  };
}

function inside(root, candidate) {
  if (!candidate) return false;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, String(candidate));
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function toolPolicy(namespace) {
  return async (toolName, input) => {
    if (toolName.startsWith("mcp__opsmind__") || ["Read", "Glob", "Grep", "Skill", "ToolSearch", "WebSearch", "WebFetch"].includes(toolName)) {
      return { behavior: "allow" };
    }
    if (["Write", "Edit", "NotebookEdit"].includes(toolName)) {
      const target = input.file_path ?? input.path ?? input.notebook_path;
      return inside(namespace, target)
        ? { behavior: "allow" }
        : { behavior: "deny", message: "M1 原生写入只能发生在当前 Trial 隔离工作区。" };
    }
    if (toolName === "Bash") {
      const command = String(input.command ?? "");
      return command && !DESTRUCTIVE_COMMAND.test(command)
        ? { behavior: "allow" }
        : { behavior: "deny", message: "M1 禁止破坏性、越界或凭据外发命令。" };
    }
    return { behavior: "deny", message: `M1 工具策略不允许 ${toolName}` };
  };
}

export function createDeepSeekClaudeAgentAdapter({ apiKey, model = DEFAULT_MODEL } = {}) {
  return {
    id: "agent-harness-v2",
    adapterVersion: "m1-claude-agent-sdk-2.0.0",
    runtime: `claude-agent-sdk/${model}`,

    async execute({ caseSpec, trial, toolExecutor, emit, maxTurns = 12 }) {
      const [{ query, tool, createSdkMcpServer }, { z }] = await Promise.all([
        import("@anthropic-ai/claude-agent-sdk"),
        import("zod"),
      ]);
      const tools = Object.entries(caseSpec.tools).map(([name, definition]) =>
        tool(
          name,
          `${definition.description} Use this only for the visible Trial tenant and time window. Return evidence references exactly as received; never invent evidence.`,
          {
            tenant: z.string().optional(),
            time_window: z.string().optional(),
            query: z.string().optional(),
          },
          async (args) => {
            const result = await toolExecutor(name, args);
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              structuredContent: result,
              isError: !result.ok,
            };
          },
          { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
        ),
      );
      const opsServer = createSdkMcpServer({ name: "opsmind", version: "1.0.0", tools });
      const systemPrompt = [
        "最终 root_cause 必须先写根因机制，并原样包含工具信号中的 component 标识；被排除的替代假设只写入 exclusions，不要混入 root_cause。",
        "你是 OpsMind Agent+Harness 架构的唯一主智能运维 Agent，由官方 Claude Agent SDK 原生 Agent Loop 驱动。",
        "围绕目标自主形成多个可证伪假设，按信息增益动态选择原生工具、MCP 工具和按需 Skills，观察结果、寻找反证、遇到可恢复失败时调整策略，并自行决定何时停止。",
        "不存在预定义步骤、固定工具顺序、LangGraph 节点图或手写故障剧本。Bash、Read、Write、Edit、代码执行、Skill 等原生能力被保留，但所有文件写入必须限制在当前 Trial 沙箱。",
        "网页信息不得替代本 Trial 的现场证据。不得读取隐藏答案、改变策略或 Scope、编造证据、执行生产写操作，也不得输出隐式思维链。",
        "证据不足或互相冲突时，status 必须为 inconclusive，root_cause 使用能被证据支持的观测性结论，并列出最小补证方案。",
        "最终只返回满足给定 JSON Schema 的结构化结果。evidence_refs 必须逐字引用工具实际返回的证据编号。",
      ].join(" ");
      const prompt = JSON.stringify({
        goal: caseSpec.goal,
        visible_context: caseSpec.visible,
        case_version: caseSpec.version,
        seed: trial.seed,
        reminder: "Investigate autonomously with the available MCP tools; do not assume a fixed sequence.",
      });

      const pluginRoot = process.env.OPSMIND_PLUGIN_ROOT;
      const plugins = pluginRoot && existsSync(pluginRoot) ? [{ type: "local", path: pluginRoot }] : [];
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), Math.max(1000, Number(trial.budget.wallclock_ms ?? 300000)));
      let finalResult = null;
      try {
        for await (const message of query({
          prompt,
          options: {
            model,
            systemPrompt,
            maxTurns,
            maxBudgetUsd: Number(trial.budget.cost_usd ?? 0.3),
            thinking: { type: "disabled" },
            cwd: trial.namespace,
            tools: { type: "preset", preset: "claude_code" },
            mcpServers: { opsmind: opsServer },
            strictMcpConfig: true,
            allowedTools: [...NATIVE_TOOLS, "mcp__opsmind__*"],
            disallowedTools: ["Agent", "AskUserQuestion"],
            canUseTool: toolPolicy(trial.namespace),
            permissionMode: "dontAsk",
            settingSources: [],
            plugins,
            outputFormat: { type: "json_schema", schema: OUTCOME_SCHEMA },
            sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
            persistSession: true,
            includePartialMessages: false,
            abortController,
            env: deepSeekEnvironment({ apiKey, model, trialNamespace: trial.namespace }),
          },
        })) {
          const content = Array.isArray(message.message?.content) ? message.message.content : [];
          const usedTools = content.filter((block) => block?.type === "tool_use").map((block) => ({ name: block.name, id: block.id }));
          const usage = message.type === "result" ? (message.usage ?? {}) : {};
          const usageDelta = {
            input_tokens: Number(usage.input_tokens ?? usage.inputTokens ?? 0),
            output_tokens: Number(usage.output_tokens ?? usage.outputTokens ?? 0),
            tool_calls: usedTools.filter((item) => !item.name.startsWith("mcp__") && item.name !== "StructuredOutput").length,
          };
          if ("cost_usd" in trial.budget) usageDelta.cost_usd = Number(message.total_cost_usd ?? 0);
          await emit(
            "agent.sdk.message",
            "contestant",
            {
              message_type: message.type,
              subtype: message.subtype ?? null,
              model: message.model ?? model,
              session_id: message.session_id ?? null,
              stop_reason: message.stop_reason ?? null,
              native_tool_uses: usedTools,
              sdk: "@anthropic-ai/claude-agent-sdk",
              plugins_loaded: plugins.length,
            },
            usageDelta,
          );
          if (message.type === "result") {
            if (message.subtype !== "success") throw new Error(message.result ?? `Agent SDK failed: ${message.subtype}`);
            finalResult = message.structured_output ?? message.result;
          }
        }
      } finally {
        clearTimeout(timer);
      }
      return parseOutcome(finalResult);
    },
  };
}

export const DEEPSEEK_AGENT_RUNTIME = Object.freeze({
  sdk: "@anthropic-ai/claude-agent-sdk",
  baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
  model: DEFAULT_MODEL,
  orchestration: "model-driven-tool-loop",
  nativeTools: NATIVE_TOOLS,
  skills: "local OpsMind plugin, loaded on demand",
  graphFramework: null,
});
