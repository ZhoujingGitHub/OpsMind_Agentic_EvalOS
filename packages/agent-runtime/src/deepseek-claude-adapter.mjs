const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const DEFAULT_MODEL = "deepseek-v4-flash";

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

export function deepSeekEnvironment({ apiKey, model = DEFAULT_MODEL } = {}) {
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
  };
}

export function createDeepSeekClaudeAgentAdapter({ apiKey, model = DEFAULT_MODEL } = {}) {
  return {
    id: "agent-harness-v2",
    adapterVersion: "m1-claude-agent-sdk-1.0.0",
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
        "You are an autonomous 5G operations investigation agent.",
        "Operate as an adaptive evidence loop: form and revise hypotheses, choose any allowed tool when it adds information, observe results, recover from failures, and stop only when the visible success criteria are met or safe tools are exhausted.",
        "There is no predefined workflow and no required tool order. Do not imitate a state graph.",
        "Never read hidden answers, change policy, exceed scope, claim evidence you did not observe, or reveal chain-of-thought.",
        "Return only a JSON object with status, root_cause, confidence, evidence_refs, exclusions, tool_failures_recovered, next_checks, and summary.",
      ].join(" ");
      const prompt = JSON.stringify({
        goal: caseSpec.goal,
        visible_context: caseSpec.visible,
        case_version: caseSpec.version,
        seed: trial.seed,
        reminder: "Investigate autonomously with the available MCP tools; do not assume a fixed sequence.",
      });

      let finalResult = null;
      for await (const message of query({
        prompt,
        options: {
          model,
          systemPrompt,
          maxTurns,
          taskBudget: { total: Math.max(256, Number(trial.budget.output_tokens)) },
          thinking: { type: "adaptive" },
          effort: "max",
          cwd: trial.namespace,
          tools: [],
          mcpServers: { opsmind: opsServer },
          strictMcpConfig: true,
          allowedTools: ["mcp__opsmind__*"],
          disallowedTools: ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch", "Agent", "AskUserQuestion"],
          permissionMode: "dontAsk",
          settingSources: [],
          includePartialMessages: false,
          env: deepSeekEnvironment({ apiKey, model }),
        },
      })) {
        const usage = message.usage ?? {};
        await emit(
          "agent.sdk.message",
          "contestant",
          {
            message_type: message.type,
            subtype: message.subtype ?? null,
            model: message.model ?? model,
            session_id: message.session_id ?? null,
            stop_reason: message.stop_reason ?? null,
          },
          {
            input_tokens: Number(usage.input_tokens ?? usage.inputTokens ?? 0),
            output_tokens: Number(usage.output_tokens ?? usage.outputTokens ?? 0),
          },
        );
        if (message.type === "result") {
          if (message.subtype !== "success") throw new Error(message.result ?? `Agent SDK failed: ${message.subtype}`);
          finalResult = message.structured_output ?? message.result;
        }
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
  graphFramework: null,
});

