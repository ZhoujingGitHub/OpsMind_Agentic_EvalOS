import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(HERE, "../python/langgraph_runner.py");
const ADAPTER_CONTRACT_VERSION = "2.0";

export function langGraphProcessEnvironment({ root, bridge, source = process.env } = {}) {
  const passThrough = [
    "PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec",
    "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "LC_ALL",
    "VIRTUAL_ENV", "LD_LIBRARY_PATH", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE",
  ];
  const environment = Object.fromEntries(passThrough
    .filter((name) => typeof source[name] === "string" && source[name].length)
    .map((name) => [name, source[name]]));
  const apiKey = source.ANTHROPIC_AUTH_TOKEN ?? source.ANTHROPIC_API_KEY ?? source.DEEPSEEK_API_KEY;
  if (apiKey) environment.ANTHROPIC_AUTH_TOKEN = apiKey;
  environment.ANTHROPIC_BASE_URL = source.ANTHROPIC_BASE_URL ?? "https://api.deepseek.com/anthropic";
  environment.ANTHROPIC_MODEL = source.ANTHROPIC_MODEL ?? "deepseek-v4-flash";
  environment.OPSMIND_LANGGRAPH_ROOT = root;
  environment.PYTHONPATH = [path.join(root, "src"), source.PYTHONPATH].filter(Boolean).join(path.delimiter);
  environment.EVALOS_TOOL_BRIDGE_URL = bridge.url;
  environment.EVALOS_TOOL_BRIDGE_TOKEN = bridge.token;
  return environment;
}

export async function createHarnessToolBridge({ allowedTools, toolExecutor }) {
  if (typeof toolExecutor !== "function") throw new Error("Harness toolExecutor is required");
  const allowed = new Set(allowedTools);
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(value));
    };
    if (request.method !== "POST" || request.url !== "/tool") return reply(404, { ok: false, error: { code: "NOT_FOUND" } });
    if (request.headers.authorization !== `Bearer ${token}`) return reply(401, { ok: false, error: { code: "UNAUTHORIZED" } });
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 65536) return reply(413, { ok: false, error: { code: "PAYLOAD_TOO_LARGE" } });
      chunks.push(chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!allowed.has(body.tool_name)) return reply(403, { ok: false, error: { code: "TOOL_DENIED" } });
      return reply(200, await toolExecutor(body.tool_name, body.arguments ?? {}));
    } catch (error) {
      return reply(400, { ok: false, error: { code: "BRIDGE_REQUEST_FAILED", message: String(error.message ?? error).slice(0, 300) } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/tool`, token,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function runProcess(command, args, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16000) stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`LangGraph V1 exceeded ${timeoutMs} ms wall-clock budget`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`LangGraph V1 runner failed with code ${code}: ${stderr.trim().slice(-2000)}`));
    });
  });
}

export function isLangGraphCapabilityFailure(error) {
  return /ToolNotFoundError|tool\s+(?:not\s+found|does\s+not\s+exist)|unknown\s+tool/i.test(String(error ?? ""));
}

export function langGraphCapabilityFailureOutcome(error, allowedTools = []) {
  const match = String(error ?? "").match(/ToolNotFoundError:\s*([^\s;]+)/i);
  const selected = match?.[1] ?? "unknown-tool";
  return {
    status: "inconclusive",
    root_cause: `invalid-tool-selection: ${selected} is not available in the frozen Trial tool set`,
    confidence: 0,
    evidence_refs: [],
    exclusions: [],
    tool_failures_recovered: false,
    next_checks: [`Select only from the frozen tools: ${allowedTools.sort().join(", ")}`],
    summary: "The contestant selected a tool outside the frozen Trial contract; this is recorded as a capability failure, not an infrastructure outage.",
  };
}

export function createLangGraphAdapter({ python, langGraphRoot } = {}) {
  const executable = python ?? process.env.OPSMIND_LANGGRAPH_PYTHON;
  const root = langGraphRoot ?? process.env.OPSMIND_LANGGRAPH_ROOT;
  if (!executable || !root) throw new Error("OPSMIND_LANGGRAPH_PYTHON and OPSMIND_LANGGRAPH_ROOT are required");
  return {
    id: "langgraph-v1",
    adapterVersion: "langgraph-eval-adapter-2.0.0",
    adapterContractVersion: ADAPTER_CONTRACT_VERSION,
    supportedEvaluationLanes: ["AGENT_CAPABILITY"],
    runtime: "langgraph-stategraph/deepseek-v4-flash",

    async execute({ caseSpec, trial, experiment, executionContract, toolExecutor, emit }) {
      if (executionContract?.adapter_contract_version !== ADAPTER_CONTRACT_VERSION) {
        throw new Error("LangGraph Eval Adapter requires contract 2.0");
      }
      if (executionContract.evaluation_lane !== "AGENT_CAPABILITY") {
        throw new Error("The embedded StateGraph adapter is only valid for the AGENT_CAPABILITY lane");
      }
      const inputPath = path.join(trial.namespace, "langgraph-input.json");
      const outputPath = path.join(trial.namespace, "langgraph-output.json");
      const contestantCase = {
        id: caseSpec.id,
        version: caseSpec.version,
        goal: caseSpec.goal,
        visible: caseSpec.visible,
        tools: caseSpec.tools,
      };
      writeFileSync(inputPath, `${JSON.stringify({
        adapter_contract_version: ADAPTER_CONTRACT_VERSION,
        evaluation_lane: executionContract.evaluation_lane,
        execution_contract: executionContract,
        case_spec: contestantCase,
        trial: {
          id: trial.id,
          environment_seed: trial.environment_seed,
          replicate_id: trial.replicate_id,
          budget: trial.budget,
        },
        frozen_contract: {
          model: experiment?.manifest?.model ?? null,
          dependencies: experiment?.manifest?.frozen_dependencies ?? null,
          policy: experiment?.manifest?.policy ?? null,
        },
      }, null, 2)}\n`, "utf8");
      const bridge = await createHarnessToolBridge({ allowedTools: Object.keys(caseSpec.tools), toolExecutor });
      const environment = langGraphProcessEnvironment({ root, bridge });
      try {
        await runProcess(executable, [RUNNER, inputPath, outputPath], { cwd: trial.namespace, env: environment }, Number(trial.budget.wallclock_ms ?? 300000) + 5000);
      } catch (error) {
        if (existsSync(outputPath)) {
          const failed = JSON.parse(readFileSync(outputPath, "utf8"));
          if (failed.error && isLangGraphCapabilityFailure(failed.error)) {
            const outcome = langGraphCapabilityFailureOutcome(failed.error, Object.keys(caseSpec.tools));
            await emit("agent.capability.failure", "contestant", {
              architecture: "LANGGRAPH_V1",
              category: "invalid_tool_selection",
              error_hash_only: true,
            });
            return outcome;
          }
          if (failed.error) throw new Error(`${error.message}; ${failed.error}`);
        }
        throw error;
      } finally {
        await bridge.close();
      }
      const result = JSON.parse(readFileSync(outputPath, "utf8"));
      if (result.error) throw new Error(result.error);
      for (const event of result.trace ?? []) {
        await emit(
          event.kind,
          event.actor,
          event.payload,
          event.kind === "tool.call" ? { tool_calls: 1 } : {},
        );
      }
      const usage = result.usage ?? {};
      await emit("agent.langgraph.result", "contestant", {
        architecture: result.architecture,
        runtime: result.runtime,
        adapter_contract_version: ADAPTER_CONTRACT_VERSION,
        model_calls: usage.model_calls ?? 0,
      }, {
        input_tokens: Number(usage.input_tokens ?? 0),
        output_tokens: Number(usage.output_tokens ?? 0),
        ...(Object.hasOwn(trial.budget, "cost_usd") ? { cost_usd: 0 } : {}),
      });
      return result.outcome;
    },
  };
}

export const LANGGRAPH_RUNTIME = Object.freeze({
  architecture: "LANGGRAPH_V1",
  orchestration: "real-stategraph",
  model: "deepseek-v4-flash",
  adapterContractVersion: ADAPTER_CONTRACT_VERSION,
  adapterVersion: "langgraph-eval-adapter-2.0.0",
  supportedEvaluationLanes: ["AGENT_CAPABILITY"],
});
