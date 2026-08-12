import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CASES,
  EvalStore,
  EvaluationLedger,
  TrialRunner,
  createMockContestant,
} from "../../../packages/kernel/src/index.mjs";
import { DEEPSEEK_AGENT_RUNTIME, createDeepSeekClaudeAgentAdapter } from "../../../packages/agent-runtime/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function json(response, status = 200, headers = {}) {
  return new Response(JSON.stringify(response), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function publicTrial(trial) {
  if (!trial) return null;
  const { contestant_id: _contestantId, budget_json: _budgetJson, outcome_json: _outcomeJson, score_json: _scoreJson, lease_owner: _leaseOwner, ...safe } = trial;
  return safe;
}

export function createApp({
  databasePath = path.join(ROOT, "runtime", "m1", "evalos.sqlite"),
  runtimeRoot = path.join(ROOT, "runtime", "m1"),
  artifactsRoot = path.join(ROOT, "artifacts", "m1"),
} = {}) {
  const store = new EvalStore({
    databasePath,
    runtimeRoot,
    migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m1.sql"),
  });
  const ledger = new EvaluationLedger(store);
  const adapters = {
    "mock-contestant-a": createMockContestant("mock-contestant-a", "context-first"),
    "mock-contestant-b": createMockContestant("mock-contestant-b", "metric-first"),
  };
  const liveDeepSeekAvailable = Boolean(
    process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY,
  );
  if (liveDeepSeekAvailable) adapters["agent-harness-v2"] = createDeepSeekClaudeAgentAdapter();
  const runner = new TrialRunner({ store, ledger, adapters, cases: CASES });

  const handler = async (request) => {
    const url = new URL(request.url);
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type,idempotency-key",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ status: "ok", service: "opsmind-evalos-control-api", ledger: ledger.verify() }, 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/runtime/capabilities") {
        return json({
          live_deepseek_enabled: liveDeepSeekAvailable,
          runtime: DEEPSEEK_AGENT_RUNTIME,
          adapters: Object.keys(adapters),
          secret_source: liveDeepSeekAvailable ? "environment-only" : null,
        }, 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/experiments") {
        const items = store.listExperiments().map((experiment) => store.experimentSummary(experiment.id));
        return json({ items }, 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/api/experiments") {
        const body = await request.json();
        const key = request.headers.get("idempotency-key") ?? body.idempotency_key;
        if (!key) return json({ error: "idempotency key is required" }, 400, cors);
        const result = store.createExperiment(body.manifest, key);
        if (result.created) {
          ledger.append({
            entityType: "experiment",
            entityId: result.experiment.id,
            action: "experiment.created",
            payload: { manifest_hash: result.experiment.config_hash, trial_count: store.listTrials(result.experiment.id).length },
          });
        }
        return json({ experiment: result.experiment, created: result.created }, result.created ? 201 : 200, cors);
      }
      const experimentMatch = url.pathname.match(/^\/api\/experiments\/([^/]+)$/);
      if (request.method === "GET" && experimentMatch) {
        const id = decodeURIComponent(experimentMatch[1]);
        const summary = store.experimentSummary(id);
        if (!summary.experiment) return json({ error: "experiment not found" }, 404, cors);
        return json({ ...summary, trials: store.listTrials(id).map(publicTrial) }, 200, cors);
      }
      const runMatch = url.pathname.match(/^\/api\/experiments\/([^/]+)\/run$/);
      if (request.method === "POST" && runMatch) {
        const id = decodeURIComponent(runMatch[1]);
        if (!store.getExperiment(id)) return json({ error: "experiment not found" }, 404, cors);
        store.setExperimentStatus(id, "RUNNING");
        const executed = await runner.runUntilIdle();
        const summary = store.experimentSummary(id);
        store.setExperimentStatus(id, summary.failed_trials ? "FAILED" : "COMPLETED");
        return json({ executed, summary: store.experimentSummary(id) }, 200, cors);
      }
      const traceMatch = url.pathname.match(/^\/api\/trials\/([^/]+)\/trace$/);
      if (request.method === "GET" && traceMatch) {
        const trialId = decodeURIComponent(traceMatch[1]);
        if (!store.getTrial(trialId)) return json({ error: "trial not found" }, 404, cors);
        const after = Number(url.searchParams.get("after") ?? 0);
        const events = store.getTrace(trialId, { after });
        if ((request.headers.get("accept") ?? "").includes("text/event-stream")) {
          const body = [
            "retry: 1000",
            ...events.map((event) => `id: ${event.row_id}\nevent: trace\ndata: ${JSON.stringify(event)}\n`),
            `event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n`,
          ].join("\n");
          return new Response(body, {
            headers: { ...cors, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
          });
        }
        return json({ items: events, cursor: events.at(-1)?.row_id ?? after }, 200, cors);
      }
      const trialMatch = url.pathname.match(/^\/api\/trials\/([^/]+)$/);
      if (request.method === "GET" && trialMatch) {
        const trial = publicTrial(store.getTrial(decodeURIComponent(trialMatch[1])));
        return trial ? json({ trial }, 200, cors) : json({ error: "trial not found" }, 404, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/ledger/verify") {
        return json(ledger.verify(), 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/m1/acceptance") {
        try {
          return json(JSON.parse(readFileSync(path.join(artifactsRoot, "g1-verdict.json"), "utf8")), 200, cors);
        } catch {
          return json({ gate: "G1", status: "NOT_RUN" }, 200, cors);
        }
      }
      return json({ error: "not found" }, 404, cors);
    } catch (error) {
      return json({ error: error.message }, 500, cors);
    }
  };

  return { handler, store, ledger, runner, close: () => store.close() };
}

export { publicTrial };
