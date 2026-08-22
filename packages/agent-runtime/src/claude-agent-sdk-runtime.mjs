import path from "node:path";

const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const DEFAULT_MODEL = "deepseek-v4-flash";
const NATIVE_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebSearch", "WebFetch", "Skill", "ToolSearch", "TodoWrite"];
const DESTRUCTIVE_COMMAND = /(?:\brm\s+-[^\n]*r|\bshutdown\b|\breboot\b|\bmkfs\b|\bdd\s+if=|\bgit\s+(?:reset\s+--hard|clean\s+-|push\s+--force)|\bcurl\b[^\n]*(?:api[_-]?key|token|password|secret))/i;
const OUTSIDE_SANDBOX_COMMAND = /(?:\.\.[\\/]|(?:^|[\s"'=])(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/(?:etc|home|root|proc|sys|var|Users|mnt)(?:[\\/]|\b)))/i;
const SECRET_OR_NETWORK_COMMAND = /(?:\b(?:curl|wget|nc|ncat|netcat|ssh|scp|ftp|printenv)\b|\$env:|process\.env|os\.environ|GetEnvironmentVariable|\/proc\/[^\s]*environ|ANTHROPIC_(?:AUTH_TOKEN|API_KEY)|DEEPSEEK_API_KEY)/i;
const SDK_ENV_ALLOWLIST = ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "HOME", "USER", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "SHELL", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];

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
    CLAUDE_AGENT_SDK_CLIENT_APP: "opsmind-agentic-evalos/intelligence",
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
      decision = { behavior: "deny", message: `Harness未授权本次分析使用 ${toolName}`, reasonCode: "native_tool_not_frozen", safetyCritical: false };
    } else if (toolName === "TodoWrite" || ["Skill", "ToolSearch", "WebSearch", "WebFetch"].includes(toolName)) {
      decision = { behavior: "allow" };
    } else if (["Read", "Glob", "Grep", "Write", "Edit", "NotebookEdit"].includes(toolName)) {
      const target = input.file_path ?? input.path ?? input.notebook_path ?? (["Glob", "Grep"].includes(toolName) ? namespace : undefined);
      decision = inside(namespace, target) ? { behavior: "allow" }
        : { behavior: "deny", message: "原生文件工具只能访问当前隔离工作区。", reasonCode: "sandbox_path_escape", safetyCritical: true };
    } else if (toolName === "Bash") {
      const command = String(input.command ?? "");
      decision = command && !DESTRUCTIVE_COMMAND.test(command) && !OUTSIDE_SANDBOX_COMMAND.test(command) && !SECRET_OR_NETWORK_COMMAND.test(command)
        ? { behavior: "allow" }
        : { behavior: "deny", message: "禁止破坏性操作、路径越界、环境凭据读取或网络外传命令。", reasonCode: "unsafe_shell_request", safetyCritical: true };
    } else {
      decision = { behavior: "deny", message: `EvalOS Harness 工具策略不允许 ${toolName}`, reasonCode: "native_tool_unsupported", safetyCritical: false };
    }
    await audit({ toolName, input, decision });
    return decision;
  };
}

export const DEEPSEEK_AGENT_RUNTIME = Object.freeze({
  sdk: "@anthropic-ai/claude-agent-sdk", provider: "deepseek", model: DEFAULT_MODEL,
  baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL, orchestration: "model-driven-tool-loop", graphFramework: null,
  nativeTools: NATIVE_TOOLS, role: "eval-intelligence-read-only",
});
