import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { BudgetExceededError, BudgetTracker } from "./budget.mjs";
import { createCaseEnvironment } from "./cases.mjs";
import { gradeTrial } from "./grader.mjs";
import { sha256, stableStringify } from "./utils.mjs";

export class TrialRunner {
  constructor({ store, ledger, adapters, cases, workerId = `runner-${process.pid}`, leaseMs = 30000 }) {
    this.store = store;
    this.ledger = ledger;
    this.adapters = adapters;
    this.cases = cases;
    this.workerId = workerId;
    this.leaseMs = leaseMs;
  }

  recover() {
    const recovered = this.store.recoverExpiredLeases();
    for (const trialId of recovered) {
      this.ledger.append({
        entityType: "trial",
        entityId: trialId,
        action: "runner.lease_recovered",
        payload: { worker_id: this.workerId },
      });
    }
    return recovered;
  }

  async runUntilIdle() {
    let count = 0;
    while (true) {
      const trial = this.store.claimNext(this.workerId, this.leaseMs);
      if (!trial) break;
      await this.runTrial(trial);
      count += 1;
    }
    return count;
  }

  async runTrial(trial) {
    const caseSpec = this.cases[trial.case_id];
    const adapter = this.adapters[trial.contestant_id];
    if (!caseSpec) throw new Error(`case not found: ${trial.case_id}`);
    if (!adapter) throw new Error(`contestant adapter not found: ${trial.contestant_id}`);
    const experiment = this.store.getExperiment(trial.experiment_id);
    const budget = new BudgetTracker(trial.budget);
    const environment = createCaseEnvironment(caseSpec);
    mkdirSync(trial.namespace, { recursive: true });
    const start = performance.now();

    const append = (kind, actor, payload) => this.store.appendTrace(trial.id, kind, actor, payload);
    const emitWarnings = (warnings) => {
      for (const warning of warnings) append("budget.warning", "kernel", warning);
    };

    try {
      append("trial.started", "runner", {
        case_id: trial.case_id,
        seed: trial.seed,
        blind_id: trial.blind_id,
        adapter_version: adapter.adapterVersion,
        runtime: adapter.runtime,
      });
      append("runner.heartbeat", "runner", { heartbeat_ms: experiment.manifest.policy.heartbeat_ms });
      append("environment.snapshot", "kernel", {
        namespace: path.basename(trial.namespace),
        connector_config: { api_key: "fixture-secret-must-not-persist" },
        isolation: "dedicated-trial-namespace",
      });

      const emit = async (kind, actor, payload, usageDelta = {}) => {
        emitWarnings(budget.consume(usageDelta));
        return append(kind, actor, payload);
      };
      const toolExecutor = async (toolName, args) => {
        if (!experiment.manifest.policy.allowed_tools.includes(toolName)) throw new Error(`tool denied by policy: ${toolName}`);
        emitWarnings(budget.consume({ tool_calls: 1 }));
        append("tool.call", "contestant", { tool: toolName, args });
        const callStart = performance.now();
        const result = await environment.call(toolName, args);
        const serialized = stableStringify(result);
        emitWarnings(budget.consume({
          compute_ms: Math.max(1, Math.round(performance.now() - callStart)),
          storage_bytes: Buffer.byteLength(serialized),
        }));
        append("tool.result", "environment", result);
        this.store.heartbeat(trial.id, this.workerId, this.leaseMs);
        return result;
      };

      const outcome = await adapter.execute({ caseSpec, trial, toolExecutor, emit, maxTurns: trial.budget.tool_calls - 1 });
      emitWarnings(budget.consume({ wallclock_ms: Math.max(1, Math.round(performance.now() - start)) }));
      const traceBeforeGrade = this.store.getTrace(trial.id);
      const usage = budget.snapshot().usage;
      const score = gradeTrial(caseSpec, outcome, traceBeforeGrade, usage);
      append("grader.result", "code-grader", { score });
      append("trial.completed", "runner", {
        status: "COMPLETED",
        outcome_status: outcome.status,
        score: score.total,
      });

      const artifact = {
        trial_id: trial.id,
        replay_of: trial.replay_of,
        manifest_hash: experiment.config_hash,
        case_id: trial.case_id,
        seed: trial.seed,
        blind_id: trial.blind_id,
        adapter_version: adapter.adapterVersion,
        model: experiment.manifest.model,
        outcome,
        score,
        usage,
      };
      const artifactPath = path.join(trial.namespace, "trial-result.json");
      writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      const digest = sha256(stableStringify(artifact));
      this.store.addArtifact(trial.id, "trial-result", artifactPath, digest, statSync(artifactPath).size);
      const traceHash = this.store.traceSemanticHash(trial.id);
      this.store.completeTrial(trial.id, { usage, outcome, score, traceHash });
      this.ledger.append({
        entityType: "trial",
        entityId: trial.id,
        action: "trial.completed",
        payload: {
          experiment_id: trial.experiment_id,
          case_id: trial.case_id,
          seed: trial.seed,
          blind_id: trial.blind_id,
          replay_of: trial.replay_of,
          manifest_hash: experiment.config_hash,
          model: experiment.manifest.model,
          dataset_hash: experiment.manifest.dataset.sha256,
          grader_version: score.grader_version,
          artifact_sha256: digest,
          trace_hash: traceHash,
          score: score.total,
        },
      });
      return this.store.getTrial(trial.id);
    } catch (error) {
      const snapshot = budget.snapshot();
      const category = error instanceof BudgetExceededError ? "budget.exceeded" : "trial.failed";
      append(category, "kernel", { error: error.message, dimension: error.dimension ?? null });
      this.store.failTrial(trial.id, error.message, snapshot.usage);
      this.ledger.append({
        entityType: "trial",
        entityId: trial.id,
        action: "trial.failed",
        payload: { error: error.message, usage: snapshot.usage },
      });
      return this.store.getTrial(trial.id);
    }
  }
}
