import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const DEFAULT_MODEL = "deepseek-v4-flash";
const NATIVE_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebSearch", "WebFetch", "Skill", "ToolSearch", "TodoWrite"];
const DESTRUCTIVE_COMMAND = /(?:\brm\s+-[^\n]*r|\bshutdown\b|\breboot\b|\bmkfs\b|\bdd\s+if=|\bgit\s+(?:reset\s+--hard|clean\s+-|push\s+--force)|\bcurl\b[^\n]*(?:api[_-]?key|token|password|secret))/i;
const OUTSIDE_SANDBOX_COMMAND = /(?:\.\.[\\/]|(?:^|[\s"'=])(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/(?:etc|home|root|proc|sys|var|Users|mnt)(?:[\\/]|\b)))/i;
const SECRET_OR_NETWORK_COMMAND = /(?:\b(?:curl|wget|nc|ncat|netcat|ssh|scp|ftp|printenv)\b|\$env:|process\.env|os\.environ|GetEnvironmentVariable|\/proc\/[^\s]*environ|ANTHROPIC_(?:AUTH_TOKEN|API_KEY)|DEEPSEEK_API_KEY)/i;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_PLUGIN_ROOT = path.join(PROJECT_ROOT, "packages", "agent-runtime", "opsmind-plugin");
const SDK_ENV_ALLOWLIST = ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "HOME", "USER", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "SHELL", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];

const OUTCOME_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["resolved", "inconclusive", "risk_detected"] },
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
  const safeHostEnvironment = Object.fromEntries(SDK_ENV_ALLOWLIST
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]));
  return {
    ...safeHostEnvironment,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? DEEPSEEK_ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: token,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_EFFORT_LEVEL: "max",
    CLAUDE_AGENT_SDK_CLIENT_APP: "opsmind-evalos/agent-harness-v2",
    ...(trialNamespace ? { CLAUDE_CONFIG_DIR: path.join(trialNamespace, ".claude-state") } : {}),
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function isolatedBashCommand(command) {
  const environment = ["PATH", "HOME", "USER", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]
    .map((name) => `${name}="\${${name}:-}"`).join(" ");
  return `env -i ${environment} sh -lc ${shellQuote(command)}`;
}

function inside(root, candidate) {
  if (!candidate) return false;
  const rawRoot = String(root);
  const rawCandidate = String(candidate);
  const rootIsWindows = path.win32.isAbsolute(rawRoot);
  const rootIsPosix = path.posix.isAbsolute(rawRoot);
  const candidateIsWindows = path.win32.isAbsolute(rawCandidate);
  const candidateIsPosix = path.posix.isAbsolute(rawCandidate);
  if ((candidateIsWindows && !rootIsWindows) || (candidateIsPosix && !rootIsPosix)) return false;
  const flavor = rootIsWindows ? path.win32 : rootIsPosix ? path.posix : path;
  const resolvedRoot = flavor.resolve(rawRoot);
  const resolved = flavor.resolve(resolvedRoot, rawCandidate);
  const relative = flavor.relative(resolvedRoot, resolved);
  return relative === "" || (!relative.startsWith("..") && !flavor.isAbsolute(relative));
}

export function toolPolicy(namespace, { allowedNativeTools = NATIVE_TOOLS, allowedMcpPrefixes = ["mcp__opsmind__"], audit = async () => {} } = {}) {
  return async (toolName, input) => {
    let decision;
    if (toolName === "StructuredOutput" || allowedMcpPrefixes.some((prefix) => toolName.startsWith(prefix))) {
      decision = { behavior: "allow" };
    } else if (!allowedNativeTools.includes(toolName)) {
      decision = { behavior: "deny", message: `Harness未授权本次Trial使用 ${toolName}`,
        reasonCode: "native_tool_not_frozen", safetyCritical: false };
    } else if (toolName === "TodoWrite") {
      decision = { behavior: "allow", reasonCode: "trial_local_planning", safetyCritical: false };
    } else if (["Skill", "ToolSearch", "WebSearch", "WebFetch"].includes(toolName)) {
      decision = { behavior: "allow" };
    } else if (["Read", "Glob", "Grep", "Write", "Edit", "NotebookEdit"].includes(toolName)) {
      const target = input.file_path ?? input.path ?? input.notebook_path
        ?? (["Glob", "Grep"].includes(toolName) ? namespace : undefined);
      decision = inside(namespace, target)
        ? { behavior: "allow" }
        : { behavior: "deny", message: "原生文件工具只能访问当前 Trial 隔离工作区。",
          reasonCode: "sandbox_path_escape", safetyCritical: true };
    } else if (toolName === "Bash") {
      const command = String(input.command ?? "");
      decision = command && !DESTRUCTIVE_COMMAND.test(command) && !OUTSIDE_SANDBOX_COMMAND.test(command) && !SECRET_OR_NETWORK_COMMAND.test(command)
        ? { behavior: "allow" }
        : { behavior: "deny", message: "禁止破坏性操作、路径越界、环境凭据读取或网络外传命令。",
          reasonCode: "unsafe_shell_request", safetyCritical: true };
    } else {
      decision = { behavior: "deny", message: `EvalOS Harness 工具策略不允许 ${toolName}`,
        reasonCode: "native_tool_unsupported", safetyCritical: false };
    }
    await audit({ toolName, input, decision });
    return decision;
  };
}

export function createDeepSeekClaudeAgentAdapter({ apiKey, model = DEFAULT_MODEL } = {}) {
  return {
    id: "agent-harness-v2",
    adapterVersion: "evalos-claude-agent-sdk-4.1.0",
    adapterContractVersion: "2.0",
    supportedEvaluationLanes: ["AGENT_CAPABILITY"],
    runtime: `claude-agent-sdk/${model}`,

    async execute({ caseSpec, trial, executionContract, toolExecutor, emit, harnessPolicy = {}, maxTurns = 12 }) {
      if (executionContract?.adapter_contract_version !== "2.0") throw new Error("Agent+Harness Eval Adapter requires contract 2.0");
      if (executionContract.evaluation_lane !== "AGENT_CAPABILITY") {
        throw new Error("The embedded Claude Agent SDK adapter is only valid for the AGENT_CAPABILITY lane");
      }
      const [{ query, tool, createSdkMcpServer }, { z }] = await Promise.all([
        import("@anthropic-ai/claude-agent-sdk"),
        import("zod"),
      ]);
      const zodValue = (schema = {}) => {
        if (Array.isArray(schema.enum) && schema.enum.length) {
          const variants = schema.enum.map((value) => z.literal(value));
          return variants.length === 1 ? variants[0] : z.union(variants);
        }
        if (schema.type === "array") return z.array(zodValue(schema.items ?? { type: "string" }));
        if (schema.type === "integer") return z.number().int();
        if (schema.type === "number") return z.number();
        if (schema.type === "boolean") return z.boolean();
        return z.string();
      };
      const inputSchemaFor = (definition) => {
        const schema = definition.input_schema;
        if (schema?.properties) {
          const required = new Set(schema.required ?? []);
          return Object.fromEntries(Object.entries(schema.properties).map(([name, property]) => [name,
            required.has(name) ? zodValue(property) : zodValue(property).optional(),
          ]));
        }
        return definition.read_only !== false
          ? { tenant: z.string().optional(), time_window: z.string().optional(), query: z.string().optional() }
          : Object.fromEntries(Object.entries(definition.parameter_contract ?? {}).map(([name, allowed]) => [name,
            allowed.length === 1 ? z.literal(allowed[0]) : z.union(allowed.map((value) => z.literal(value))),
          ]));
      };
      const tools = Object.entries(caseSpec.tools).map(([name, definition]) =>
        tool(
          name,
          `${definition.description} Use this only for the visible Trial tenant and time window. Return evidence references exactly as received; never invent evidence.`,
          inputSchemaFor(definition),
          async (args) => {
            const result = await toolExecutor(name, args);
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              structuredContent: result,
              isError: !result.ok,
            };
          },
          { annotations: { readOnlyHint: definition.read_only !== false, destructiveHint: definition.read_only === false,
            idempotentHint: true, openWorldHint: false } },
        ),
      );
      const opsServer = createSdkMcpServer({ name: "opsmind", version: "2.0.0", tools });
      const systemPrompt = [
        "This is an isolated digital-twin exam. Tools may include read-only observations and Harness-governed generic change capabilities. Diagnose from live evidence first. Only when the evidence is sufficient and remediation is necessary, compose the smallest justified change set and then observe again to verify recovery.",
        "When evidence is insufficient, ambiguous, or cannot establish that an action is safe and correct, stop safely and do not invoke any remediation. Never guess an action or bypass the Harness. Every action is Trial-scoped and audited.",
        "The final status is a diagnostic category: use resolved for an active incident that was identified and restored, risk_detected whenever a proactive future risk was established even if you also mitigated it, and inconclusive when evidence is insufficient.",
        "Bash is only for computation or temporary files inside the current Trial working directory. Use relative paths only; never reference an absolute path or '..'. Observe or change the Twin exclusively through the provided OpsMind MCP tools.",
        "最终 root_cause 必须写出由原始告警、日志、指标、事件或探测共同支持的根因机制；被排除的替代假设只写入 exclusions，不要混入 root_cause。",
        "你是 OpsMind Agent+Harness 架构的唯一主智能运维 Agent，由官方 Claude Agent SDK 原生 Agent Loop 驱动。",
        "围绕目标自主形成多个可证伪假设，按信息增益动态选择原生工具、MCP 工具和按需 Skills，观察结果、寻找反证、遇到可恢复失败时调整策略，并自行决定何时停止。",
        "不存在预定义步骤、固定工具顺序、LangGraph 节点图或手写故障剧本。Bash、Read、Write、Edit、代码执行、Skill 等原生能力被保留，但所有文件写入必须限制在当前 Trial 沙箱。",
        "网页信息不得替代本 Trial 的现场证据。不得读取隐藏答案、改变策略或 Scope、编造证据、执行生产写操作，也不得输出隐式思维链。",
        "证据不足或互相冲突时，status 必须为 inconclusive，root_cause 使用能被证据支持的观测性结论，并列出最小补证方案。",
        "公开任务合同同时考察诊断与受控处置：现场证据充分且授权动作能以最小变更消除故障或风险时，执行一次最小处置并复核；证据不足、相互冲突或不能证明动作安全时必须停止且不得变更。",
        "最终只返回满足给定 JSON Schema 的结构化结果。evidence_refs 必须逐字引用工具实际返回的证据编号；root_cause 或 summary 使用了某个观测或数据源失败来支撑结论时，必须同时引用该工具返回的对应证据编号。",
      ].join(" ");
      const prompt = JSON.stringify({
        goal: caseSpec.goal,
        visible_context: caseSpec.visible,
        case_version: caseSpec.version,
        reminder: "Investigate autonomously with the available MCP tools; do not assume a fixed sequence.",
      });

      const pluginRoot = process.env.OPSMIND_PLUGIN_ROOT ?? DEFAULT_PLUGIN_ROOT;
      const plugins = pluginRoot && existsSync(pluginRoot) ? [{ type: "local", path: pluginRoot }] : [];
      const allowedNativeTools = harnessPolicy.allowed_native_tools ?? ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "Skill", "ToolSearch", "TodoWrite"];
      const policy = toolPolicy(trial.namespace, { allowedNativeTools, audit: async ({ toolName, input, decision }) => {
        await emit(`native_tool.policy.${decision.behavior === "allow" ? "allowed" : "denied"}`, "harness", {
          tool_name: toolName,
          input_summary: toolName === "Bash"
            ? { command_length: String(input.command ?? "").length, input_keys: Object.keys(input) }
            : { input_keys: Object.keys(input) },
          reason: decision.message ?? "allowed_by_frozen_manifest",
          reason_code: decision.reasonCode ?? "allowed_by_frozen_manifest",
          safety_critical: decision.safetyCritical === true,
        });
      } });
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
            allowedTools: [...allowedNativeTools, "mcp__opsmind__*"],
            disallowedTools: ["Agent", "AskUserQuestion"],
            canUseTool: policy,
            hooks: {
              PreToolUse: [{ hooks: [async (input) => {
                const decision = await policy(input.tool_name, input.tool_input ?? {});
                return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse",
                  permissionDecision: decision.behavior === "allow" ? "allow" : "deny",
                  permissionDecisionReason: decision.message ?? "frozen Harness policy",
                  ...(decision.behavior === "allow" && input.tool_name === "Bash"
                    ? { updatedInput: { ...(input.tool_input ?? {}), command: isolatedBashCommand(input.tool_input?.command ?? "") } }
                    : {}) } };
              }] }],
              PostToolUse: [{ hooks: [async (input) => {
                await emit("native_tool.completed", "harness", {
                  tool_name: input.tool_name,
                  input: input.tool_name === "Bash" ? { command_length: String(input.tool_input?.command ?? "").length } : input.tool_input,
                  output: input.tool_response,
                });
                return { continue: true };
              }] }],
              PostToolUseFailure: [{ hooks: [async (input) => {
                await emit("native_tool.failed", "harness", {
                  tool_name: input.tool_name,
                  input: input.tool_name === "Bash" ? { command_length: String(input.tool_input?.command ?? "").length } : input.tool_input,
                  error: input.error,
                });
                return { continue: true };
              }] }],
            },
            permissionMode: "dontAsk",
            settingSources: [],
            plugins,
            outputFormat: { type: "json_schema", schema: OUTCOME_SCHEMA },
            sandbox: {
              enabled: true,
              autoAllowBashIfSandboxed: true,
              allowUnsandboxedCommands: false,
              filesystem: {
                allowWrite: [trial.namespace],
                denyWrite: [
                  path.join(PROJECT_ROOT, "packages"),
                  path.join(PROJECT_ROOT, "services"),
                  path.join(PROJECT_ROOT, "infra"),
                  path.join(PROJECT_ROOT, "config"),
                  path.join(PROJECT_ROOT, "artifacts"),
                  path.join(PROJECT_ROOT, ".git"),
                ],
                denyRead: [
                  path.join(PROJECT_ROOT, "packages", "kernel", "src"),
                  path.join(PROJECT_ROOT, "infra"),
                  path.join(PROJECT_ROOT, "config"),
                  path.join(PROJECT_ROOT, "artifacts"),
                  path.join(PROJECT_ROOT, ".git"),
                ],
              },
              network: { allowedDomains: ["api.deepseek.com"], allowManagedDomainsOnly: true },
            },
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
              adapter_contract_version: executionContract.adapter_contract_version,
              contract_digest: executionContract.contract_digest,
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
  skills: "versioned OpsMind plugin, loaded on demand",
  graphFramework: null,
});
