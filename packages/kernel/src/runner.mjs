import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { BudgetExceededError, BudgetTracker } from "./budget.mjs";
import { createCaseEnvironment } from "./cases.mjs";
import { buildEvaluationContract } from "./evaluation-contract.mjs";
import { redact } from "./redaction.mjs";
import { sha256, stableStringify } from "./utils.mjs";

export function isRetryableInfrastructureFailure(error) {
  const message = String(error ?? "");
  if (/ToolNotFoundError|unknown\s+tool|tool\s+not\s+found/i.test(message)) return false;
  return /(?:^|\D)429(?:\D|$)|(?:^|\D)50[234](?:\D|$)|rate.?limit|timed?\s*out|timeout|ECONN(?:RESET|REFUSED|ABORTED)|EAI_AGAIN|ENETUNREACH|connection\s+(?:reset|refused|aborted)|temporary\s+(?:network|dns|service)/i.test(message);
}

export class TrialRunner {
  constructor({ store, ledger, adapters, gradingService, environmentFactory = ({ caseSpec }) => createCaseEnvironment(caseSpec),
    workerId = `runner-${process.pid}`, leaseMs = 30000 }) {
    this.store = store;
    this.ledger = ledger;
    this.adapters = adapters;
    this.gradingService = gradingService;
    this.environmentFactory = environmentFactory;
    this.workerId = workerId;
    this.leaseMs = leaseMs;
  }

  recover() {
    const recovered = this.store.recoverExpiredLeases();
    for (const trialId of recovered) this.ledger.append({
      entityType: "trial", entityId: trialId, action: "runner.lease_recovered", payload: { worker_id: this.workerId },
    });
    return recovered;
  }

  async runUntilIdle({ experimentId = null } = {}) {
    let count = 0;
    while (true) {
      const trial = this.store.claimNext(this.workerId, this.leaseMs, experimentId);
      if (!trial) break;
      await this.runTrial(trial);
      count += 1;
    }
    return count;
  }

  async runTrial(trial) {
    const caseSpec = this.store.getExecutionCase(trial.case_ref);
    const experiment = this.store.getExperiment(trial.experiment_id);
    const adapter = this.adapters[`${trial.contestant_ref}:${experiment.manifest.evaluation_lane}`] ?? this.adapters[trial.contestant_ref];
    if (!caseSpec) throw new Error(`execution case not found: ${trial.case_ref}`);
    if (!adapter) throw new Error(`contestant adapter not found: ${trial.contestant_ref}`);
    if ("ground_truth" in caseSpec) throw new Error("private label leaked into execution plane");
    const executionContract = buildEvaluationContract({ experiment, trial, caseSpec, adapter });
    const budget = new BudgetTracker(trial.budget);
    mkdirSync(trial.namespace, { recursive: true });
    const start = performance.now();
    const rootSpan = this.store.startSpan(trial.id, "trial.execute", "CHAIN", "runner", {
      case_ref: trial.case_ref,
      replicate_id: trial.replicate_id,
      environment_seed: trial.environment_seed,
      blind_id: trial.blind_id,
      adapter_version: adapter.adapterVersion,
      adapter_contract_version: executionContract.adapter_contract_version,
      evaluation_lane: executionContract.evaluation_lane,
      contract_digest: executionContract.contract_digest,
      runtime: adapter.runtime,
    });
    const agentSpan = this.store.startSpan(trial.id, "agent.invoke", "AGENT", "contestant", {}, rootSpan);

    const event = (name, actor, payload, spanId = rootSpan, spanKind = "INTERNAL") =>
      this.store.addSpanEvent(trial.id, spanId, name, actor, payload, spanKind);
    const emitWarnings = (warnings) => warnings.forEach((warning) => event("budget.warning", "kernel", warning));
    let environment = null;
    let environmentReset = null;
    let approvedWriteCount = 0;

    try {
      environment = await this.environmentFactory({ caseSpec, trial, experiment,
        emit: async (name, payload = {}) => event(name, "environment", payload) });
      if (!environment || typeof environment.call !== "function") throw new Error("environment factory returned an invalid environment");
      const prepared = typeof environment.prepare === "function" ? await environment.prepare() : null;
      if (prepared) event("environment.prepared", "environment", prepared);
      event("runner.heartbeat", "runner", { heartbeat_ms: experiment.manifest.policy.heartbeat_ms });
      event("environment.snapshot", "kernel", {
        namespace: path.basename(trial.namespace), isolation: "dedicated-trial-namespace",
        source: caseSpec.source ?? { type: "simulation", level: "L1" },
        environment: caseSpec.environment ?? null,
        secret_probe: { api_key: "fixture-sensitive" },
      });

      const emit = async (name, actor, payload, usageDelta = {}) => {
        emitWarnings(budget.consume(usageDelta));
        return event(name, actor, payload, agentSpan, "AGENT");
      };
      const toolExecutor = async (toolName, args = {}) => {
        if (!experiment.manifest.policy.allowed_tools.includes(toolName)) throw new Error(`tool denied by policy: ${toolName}`);
        const toolDefinition = caseSpec.tools[toolName];
        if (!toolDefinition) throw new Error(`tool is not frozen in this Case: ${toolName}`);
        const sourceSystem = toolDefinition.source_system ?? `evalos.unclassified.${toolDefinition.capability ?? toolName}`;
        emitWarnings(budget.consume({ tool_calls: 1 }));
        const toolSpan = this.store.startSpan(trial.id, `tool.${toolName}`, "TOOL", "contestant", {
          args, source_system: sourceSystem, effect: toolDefinition.read_only === false ? "CONTROLLED_WRITE" : "READ_ONLY",
        }, agentSpan);
        const callStart = performance.now();
        try {
          if (args.tenant && args.tenant !== caseSpec.visible.tenant) {
            event("safety.policy.denied", "kernel", { reason: "cross_tenant_access", tool: toolName }, toolSpan, "TOOL");
            const denied = { ok: false, error: { code: "POLICY_DENIED", message: "cross-tenant tool request denied by Harness" } };
            this.store.endSpan(trial.id, toolSpan, `tool.${toolName}`, "TOOL", "environment", "ERROR", { result: denied });
            return denied;
          }
          if (args.time_window && args.time_window !== caseSpec.visible.time_window) {
            event("safety.policy.denied", "kernel", { reason: "out_of_scope_time_window", tool: toolName }, toolSpan, "TOOL");
            const denied = { ok: false, error: { code: "POLICY_DENIED", message: "out-of-scope time window denied by Harness" } };
            this.store.endSpan(trial.id, toolSpan, `tool.${toolName}`, "TOOL", "environment", "ERROR", { result: denied });
            return denied;
          }
          if (toolDefinition.read_only === false) {
            const approval = experiment.manifest.policy.action_approval;
            event("action.approval.requested", "kernel", { tool: toolName, mode: approval.mode,
              risk_class: "ISOLATED_TWIN_WRITE", requested_write_number: approvedWriteCount + 1 }, toolSpan, "TOOL");
            if (approvedWriteCount >= approval.max_writes_per_trial) {
              event("action.approval.denied", "kernel", { reason: "trial_write_budget_exhausted", tool: toolName,
                max_writes_per_trial: approval.max_writes_per_trial }, toolSpan, "TOOL");
              const denied = { ok: false, error: { code: "APPROVAL_DENIED", message: "Trial write approval budget exhausted" } };
              this.store.endSpan(trial.id, toolSpan, `tool.${toolName}`, "TOOL", "environment", "ERROR", { result: denied });
              return denied;
            }
            approvedWriteCount += 1;
            event("action.approval.granted", "kernel", { tool: toolName, mode: approval.mode,
              approval_source: "frozen_harness_policy", approved_write_number: approvedWriteCount }, toolSpan, "TOOL");
          }
          const rawResult = await environment.call(toolName, args);
          const result = rawResult && typeof rawResult === "object" ? { ...rawResult, source_system: sourceSystem } : rawResult;
          const serialized = stableStringify(result);
          emitWarnings(budget.consume({ compute_ms: Math.max(1, Math.round(performance.now() - callStart)), storage_bytes: Buffer.byteLength(serialized) }));
          this.store.endSpan(trial.id, toolSpan, `tool.${toolName}`, "TOOL", "environment", result.ok ? "OK" : "ERROR", {
            result, source_system: sourceSystem,
          });
          this.store.heartbeat(trial.id, this.workerId, this.leaseMs);
          return result;
        } catch (error) {
          this.store.endSpan(trial.id, toolSpan, `tool.${toolName}`, "TOOL", "environment", "ERROR", { error: error.message });
          throw error;
        }
      };

      const rawOutcome = await adapter.execute({ caseSpec, trial, experiment, executionContract, toolExecutor, emit,
        harnessPolicy: experiment.manifest.policy, maxTurns: Math.max(1, trial.budget.tool_calls - 1) });
      const outcome = redact(rawOutcome).value;
      this.store.endSpan(trial.id, agentSpan, "agent.invoke", "AGENT", "contestant", "OK", { outcome });
      emitWarnings(budget.consume({ wallclock_ms: Math.max(1, Math.round(performance.now() - start)) }));
      const usage = budget.snapshot().usage;
      const environmentBeforeReset = typeof environment.snapshot === "function" ? await environment.snapshot() : {};
      if (typeof environment.reset === "function") {
        environmentReset = await environment.reset();
        event("environment.reset", "environment", environmentReset ?? { ok: true });
        if (environmentReset?.ok === false) throw new Error(`environment reset failed: ${environmentReset.error ?? "unknown"}`);
      }
      const traceBeforeGrade = this.store.getTrace(trial.id);
      const gradeSpan = this.store.startSpan(trial.id, "grader.code", "EVALUATOR", "code-grader", {}, rootSpan);
      const grading = this.gradingService.grade({
        caseRef: trial.case_ref, outcome, trace: traceBeforeGrade, usage, budget: trial.budget,
        environmentState: environmentBeforeReset,
      });
      this.store.addGraderRun(trial.id, { graderRef: grading.grader_ref, graderType: "code", dimension: "overall", result: grading.result });
      this.store.endSpan(trial.id, gradeSpan, "grader.code", "EVALUATOR", "code-grader", "OK", {
        grader_ref: grading.grader_ref, label_hash: grading.label_hash, total: grading.result.total, passed: grading.result.passed,
      });
      this.store.endSpan(trial.id, rootSpan, "trial.execute", "CHAIN", "runner", "OK", {
        outcome_status: outcome.status, code_score: grading.result.total,
      });

      const traceHash = this.store.traceSemanticHash(trial.id);
      const artifact = {
        contract_version: "evalos.3", trial_id: trial.id, replay_of: trial.replay_of,
        manifest_hash: experiment.manifest_hash, case_ref: trial.case_ref,
        environment_seed: trial.environment_seed, replicate_id: trial.replicate_id,
        blind_id: trial.blind_id, adapter_version: adapter.adapterVersion,
        model: experiment.manifest.model, outcome, code_grade: {
          grader_version: grading.result.grader_version, total: grading.result.total, passed: grading.result.passed,
          dimensions: grading.result.dimensions, hard_gates: grading.result.hard_gates,
          scoring_contract: grading.result.scoring_contract,
        }, usage, trace_hash: traceHash,
      };
      const artifactPath = path.join(trial.namespace, "trial-result.json");
      writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      const digest = sha256(stableStringify(artifact));
      this.store.addArtifact(trial.id, "trial-result", artifactPath, digest, statSync(artifactPath).size);
      this.store.completeTrial(trial.id, { usage, outcome,
        finalState: { before_reset: environmentBeforeReset, reset: environmentReset }, traceHash });
      this.ledger.append({
        entityType: "trial", entityId: trial.id, action: "trial.completed",
        payload: { experiment_id: trial.experiment_id, case_ref: trial.case_ref, environment_seed: trial.environment_seed,
          replicate_id: trial.replicate_id, blind_id: trial.blind_id, replay_of: trial.replay_of,
          manifest_hash: experiment.manifest_hash, model: experiment.manifest.model,
          dataset_ref: experiment.dataset_ref, grader_ref: grading.grader_ref,
          artifact_sha256: digest, trace_hash: traceHash, code_score: grading.result.total },
      });
      return this.store.getTrial(trial.id);
    } catch (error) {
      if (environment && environmentReset === null && typeof environment.reset === "function") {
        try {
          environmentReset = await environment.reset();
          event("environment.reset_after_failure", "environment", environmentReset ?? { ok: true });
        } catch (resetError) {
          event("environment.reset_failed", "environment", { error: resetError.message });
        }
      }
      const category = error instanceof BudgetExceededError ? "budget.exceeded" : "trial.failed";
      event(category, "kernel", { error: error.message, dimension: error.dimension ?? null });
      try { this.store.endSpan(trial.id, agentSpan, "agent.invoke", "AGENT", "contestant", "ERROR", { error: error.message }); } catch {}
      try { this.store.endSpan(trial.id, rootSpan, "trial.execute", "CHAIN", "runner", "ERROR", { error: error.message }); } catch {}
      this.store.failTrial(trial.id, error.message);
      this.ledger.append({ entityType: "trial", entityId: trial.id, action: "trial.failed", payload: { error: error.message, usage: budget.snapshot().usage } });
      return this.store.getTrial(trial.id);
    }
  }
}
