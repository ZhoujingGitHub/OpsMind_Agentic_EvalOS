import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(HERE, "../python/langgraph_runner.py");

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

export function createLangGraphAdapter({ python, langGraphRoot } = {}) {
  const executable = python ?? process.env.OPSMIND_LANGGRAPH_PYTHON;
  const root = langGraphRoot ?? process.env.OPSMIND_LANGGRAPH_ROOT;
  if (!executable || !root) throw new Error("OPSMIND_LANGGRAPH_PYTHON and OPSMIND_LANGGRAPH_ROOT are required");
  return {
    id: "langgraph-v1",
    adapterVersion: "m1-real-stategraph-1.0.0",
    runtime: "langgraph-stategraph/deepseek-v4-flash",

    async execute({ caseSpec, trial, emit }) {
      const inputPath = path.join(trial.namespace, "langgraph-input.json");
      const outputPath = path.join(trial.namespace, "langgraph-output.json");
      const contestantCase = {
        id: caseSpec.id,
        version: caseSpec.version,
        goal: caseSpec.goal,
        visible: caseSpec.visible,
        tools: caseSpec.tools,
      };
      writeFileSync(inputPath, `${JSON.stringify({ case_spec: contestantCase, trial: { id: trial.id, seed: trial.seed, budget: trial.budget } }, null, 2)}\n`, "utf8");
      const environment = {
        ...process.env,
        OPSMIND_LANGGRAPH_ROOT: root,
        PYTHONPATH: [path.join(root, "src"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      };
      try {
        await runProcess(executable, [RUNNER, inputPath, outputPath], { cwd: trial.namespace, env: environment }, Number(trial.budget.wallclock_ms ?? 300000) + 5000);
      } catch (error) {
        if (existsSync(outputPath)) {
          const failed = JSON.parse(readFileSync(outputPath, "utf8"));
          if (failed.error) throw new Error(`${error.message}; ${failed.error}`);
        }
        throw error;
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
});
