import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { BudgetExceededError, BudgetTracker } from "./budget.mjs";
import { createCaseEnvironment } from "./cases.mjs";
import { buildEvaluationContract } from "./evaluation-contract.mjs";
import { classifyTrialFailure } from "./failure-policy.mjs";
import { redact } from "./redaction.mjs";
import { sha256, stableStringify } from "./utils.mjs";


export function measuredUsage(budgetUsage, candidateUsage, runClass) {
  const dimensions = ["input_tokens", "output_tokens", "model_calls", "tool_calls", "wallclock_ms",
    "compute_ms", "storage_bytes", "cost_usd"];
  const candidateValues = runClass === "REAL_CANDIDATE"
    ? Object.fromEntries(Object.entries(candidateUsage?.values ?? {}).filter(([name, value]) =>
      name !== "wallclock_ms" && dimensions.includes(name) && Number.isFinite(Number(value)) && Number(value) >= 0)
      .map(([name, value]) => [name, Number(value)]))
    : {};
  const observed = [...new Set(candidateUsage?.observed_dimensions ?? Object.keys(candidateValues))]
    .filter((name) => Object.hasOwn(candidateValues, name));
  return {
    ...budgetUsage,
    ...candidateValues,
    measurement: runClass === "REAL_CANDIDATE" ? {
      source: candidateUsage?.source ?? "unavailable",
      observed_dimensions: observed,
      unavailable_dimensions: dimensions.filter((name) => !observed.includes(name) && name !== "wallclock_ms"),
      platform_wallclock_observed: true,
      complete: candidateUsage?.complete === true,
    } : {
      source: "evalos_engineering_runtime",
      observed_dimensions: dimensions,
      unavailable_dimensions: [],
      platform_wallclock_observed: true,
      complete: true,
      test_double: true,
    },
  };
}

export class TrialRunner {
  constructor({ store, ledger, adapters, gradingService, approvalOracle = null, environmentFactory = ({ caseSpec }) => createCaseEnvironment(caseSpec),
    workerId = `runner-${process.pid}`, leaseMs = 30000 }) {
    this.store = store;
    this.ledger = ledger;
    this.adapters = adapters;
    this.gradingService = gradingService;
    this.approvalOracle = approvalOracle;
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

  async runUntilIdle({ experimentId = null, concurrency = 1 } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
      throw new Error("runner concurrency must be an integer between 1 and 64");
    }
    const control = { halted: false };
    const workerLoop = async (index) => {
      const workerId = concurrency === 1 ? this.workerId : `${this.workerId}-c${index + 1}`;
      let count = 0;
      while (!control.halted) {
        const trial = this.store.claimNext(workerId, this.leaseMs, experimentId);
        if (!trial) break;
        try {
          await this.runTrial(trial, { workerId });
          count += 1;
        } catch (error) {
          if (error.haltQueue === true) control.halted = true;
          throw error;
        }
      }
      return count;
    };
    const settled = await Promise.allSettled(Array.from({ length: concurrency }, (_, index) => workerLoop(index)));
    const failure = settled.find((item) => item.status === "rejected");
    if (failure) throw failure.reason;
    return settled.reduce((total, item) => total + item.value, 0);
  }

  async runTrial(trial, { workerId = this.workerId } = {}) {
    const caseSpec = this.store.getExecutionCase(trial.case_ref);
    const experiment = this.store.getExperiment(trial.experiment_id);
    const contestant = experiment.manifest.contestants.find((item) => item.ref === trial.contestant_ref);
    const adapter = this.adapters[`${trial.contestant_ref}:${experiment.manifest.evaluation_lane}:${contestant?.adapter_contract_version}`]
      ?? this.adapters[`${trial.contestant_ref}:${experiment.manifest.evaluation_lane}`] ?? this.adapters[trial.contestant_ref];
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
    let environmentBeforeReset = null;
    let approvedWriteCount = 0;
    let candidateUsage = null;
    let leaseError = null;
    const heartbeatIntervalMs = Math.max(250, Math.min(
      Number(experiment.manifest.policy.heartbeat_ms ?? 5000), Math.max(250, Math.floor(this.leaseMs / 3)),
    ));
    const maintainLease = () => {
      if (leaseError) throw leaseError;
      try { this.store.heartbeat(trial.id, workerId, this.leaseMs); }
      catch (error) {
        error.haltQueue = true;
        leaseError = error;
        throw error;
      }
    };
    const leaseTimer = setInterval(() => {
      try { maintainLease(); } catch {}
    }, heartbeatIntervalMs);
    leaseTimer.unref?.();

    try {
      environment = await this.environmentFactory({ caseSpec, trial, experiment, executionContract,
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
          this.store.heartbeat(trial.id, workerId, this.leaseMs);
          return result;
        } catch (error) {
          this.store.endSpan(trial.id, toolSpan, `tool.${toolName}`, "TOOL", "environment", "ERROR", { error: error.message });
          throw error;
        }
      };

      const requestApproval = async (request) => {
        if (!this.approvalOracle) throw new Error("Approval Oracle is not configured for this evaluation service");
        const decision = this.approvalOracle.decide({ caseRef: trial.case_ref, visibleCase: caseSpec, request, manifest: experiment.manifest });
        event("approval.oracle.decision", "approval-oracle", { request_ref: request.request_ref,
          decision: decision.decision, reason_code: decision.reason_code, policy_digest: decision.policy_digest }, agentSpan, "EVALUATOR");
        return decision;
      };
      const captureEnvironment = async (reason = "candidate_progress") => {
        if (typeof environment.capture !== "function") return { captured: false, reason: "capture_not_supported" };
        const capture = await environment.capture(reason);
        event("environment.independent_capture", "twin-manager", capture ?? { captured: false, reason });
        return capture;
      };
      const adapterResult = await adapter.execute({ caseSpec, trial, experiment, executionContract, toolExecutor, emit, requestApproval,
        captureEnvironment,
        beforeStart: typeof environment.verifyCandidateBinding === "function"
          ? async () => environment.verifyCandidateBinding()
          : null,
        shouldCancel: async () => {
          if (leaseError) throw leaseError;
          return this.store.isTrialCancellationRequested(trial.id);
        },
        heartbeat: async () => maintainLease(),
        harnessPolicy: experiment.manifest.policy, maxTurns: Math.max(1, trial.budget.tool_calls - 1) });
      const { __evalos_usage: reportedCandidateUsage = null, ...rawOutcome } = adapterResult;
      candidateUsage = reportedCandidateUsage;
      if (experiment.manifest.run_class === "REAL_CANDIDATE") {
        const billable = Object.fromEntries(Object.entries(candidateUsage?.values ?? {})
          .filter(([name, value]) => ["input_tokens", "output_tokens", "model_calls", "tool_calls", "storage_bytes", "cost_usd"].includes(name)
            && Number.isFinite(Number(value))));
        emitWarnings(budget.consume(billable));
      }
      const outcome = redact(rawOutcome).value;
      this.store.endSpan(trial.id, agentSpan, "agent.invoke", "AGENT", "contestant", "OK", { outcome });
      emitWarnings(budget.consume({ wallclock_ms: Math.max(1, Math.round(performance.now() - start)) }));
      const usage = measuredUsage(budget.snapshot().usage, candidateUsage, experiment.manifest.run_class);
      environmentBeforeReset = typeof environment.snapshot === "function" ? await environment.snapshot() : {};
      let candidateFinalization = null;
      if (typeof adapter.finalize === "function") {
        try {
          candidateFinalization = await adapter.finalize({ outcome, executionContract, reason: "trial_completed" });
          event("candidate.environment.release_completed", "candidate-adapter", candidateFinalization ?? { ok: true });
        } catch (finalizationError) {
          finalizationError.runRef = outcome.candidate_run_ref ?? finalizationError.runRef ?? null;
          finalizationError.candidateTerminal = true;
          finalizationError.candidateFinalizationAttempted = true;
          throw finalizationError;
        }
      }
      if (typeof environment.reset === "function") {
        environmentReset = await environment.reset();
        event("environment.reset", "environment", environmentReset ?? { ok: true });
        if (environmentReset?.ok === false) throw new Error(`environment reset failed: ${environmentReset.error ?? "unknown"}`);
      }
      const traceBeforeGrade = this.store.getTrace(trial.id);
      const gradeSpan = this.store.startSpan(trial.id, "grader.code", "EVALUATOR", "code-grader", {}, rootSpan);
      const grading = this.gradingService.grade({
        trialId: trial.id, caseRef: trial.case_ref, outcome, trace: traceBeforeGrade, usage, budget: trial.budget,
        resourceUsageAffectsScore: experiment.manifest.candidate_resource_contract?.policy?.usage_affects_score !== false,
        environmentState: environmentBeforeReset, environmentReset,
      });
      this.store.addGraderRun(trial.id, { graderRef: grading.grader_ref, graderType: "code", dimension: "overall", result: grading.result });
      this.store.endSpan(trial.id, gradeSpan, "grader.code", "EVALUATOR", "code-grader", "OK", {
        grader_ref: grading.grader_ref, label_hash: grading.label_hash, total: grading.result.total,
        passed: grading.result.passed, qualification_passed: grading.result.qualification_passed,
      });
      this.store.endSpan(trial.id, rootSpan, "trial.execute", "CHAIN", "runner", "OK", {
        outcome_status: outcome.status, code_score: grading.result.total,
      });

      const traceHash = this.store.traceSemanticHash(trial.id);
      const completeTrace = this.store.getTrace(trial.id);
      const normalizedNames = new Set(["task.received", "investigation.started", "evidence.collected", "conclusion.recorded",
        "action.proposed", "policy.decided", "approval.decided", "ticket.issued", "lease.acquired", "action.executed",
        "verification.completed", "rollback.executed", "rollback.verified", "circuit_breaker.opened",
        "emergency_stop.activated", "human_takeover.requested", "archive.reconciled"]);
      const rawEvents = completeTrace.filter((record) => record.name === "candidate.raw_event").map((record) => ({
        source_ref: record.payload.source_ref, source_system: record.payload.source_system,
        recorded_at: record.payload.recorded_at ?? record.timestamp,
        payload: record.payload.payload, payload_digest: record.payload.payload_digest,
      }));
      const rawSourceRefs = new Set(rawEvents.map((item) => item.source_ref));
      const normalizedEvents = completeTrace.filter((record) => normalizedNames.has(record.name)
        && Array.isArray(record.payload.raw_source_refs) && record.payload.raw_source_refs.length > 0
        && record.payload.raw_source_refs.every((ref) => rawSourceRefs.has(ref))).map((record) => ({
        event_type: record.name, actor: record.actor, status: record.payload.status ?? "RECORDED",
        raw_source_refs: record.payload.raw_source_refs,
        payload: Object.fromEntries(Object.entries(record.payload).filter(([key]) => !["status", "raw_source_refs"].includes(key))),
      }));
      const traceContractMaterial = { trace_contract_version: "3.0", trial_id: trial.id,
        raw_events: rawEvents, normalized_events: normalizedEvents };
      const traceContract = { ...traceContractMaterial, trace_digest: `sha256:${sha256(traceContractMaterial)}` };
      const traceArtifactPath = path.join(trial.namespace, "trace-v3.json");
      writeFileSync(traceArtifactPath, `${JSON.stringify(traceContract, null, 2)}\n`, "utf8");
      this.store.addArtifact(trial.id, "trace-v3", traceArtifactPath, traceContract.trace_digest,
        statSync(traceArtifactPath).size);
      const artifact = {
        contract_version: "evalos.3", trial_id: trial.id, replay_of: trial.replay_of,
        manifest_hash: experiment.manifest_hash, case_ref: trial.case_ref,
        environment_seed: trial.environment_seed, replicate_id: trial.replicate_id,
        blind_id: trial.blind_id, adapter_version: adapter.adapterVersion,
        model: experiment.manifest.model, outcome, code_grade: {
          grader_contract_version: grading.result.grader_contract_version,
          grader_version: grading.result.grader_version, grader_digest: grading.result.grader_digest,
          official_score_source: grading.result.official_score_source,
          total: grading.result.total, passed: grading.result.passed,
          qualification_passed: grading.result.qualification_passed,
          recommendation_quality: grading.result.recommendation_quality,
          dimensions: grading.result.dimensions, hard_gates: grading.result.hard_gates,
          scoring_contract: grading.result.scoring_contract, evidence_refs: grading.result.evidence_refs,
        }, usage, trace_hash: traceHash, trace_contract_digest: traceContract.trace_digest,
      };
      const artifactPath = path.join(trial.namespace, "trial-result.json");
      writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      const digest = sha256(stableStringify(artifact));
      this.store.addArtifact(trial.id, "trial-result", artifactPath, digest, statSync(artifactPath).size);
      clearInterval(leaseTimer);
      this.store.completeTrial(trial.id, { usage, outcome,
        finalState: { before_reset: environmentBeforeReset, candidate_finalization: candidateFinalization,
          reset: environmentReset }, traceHash });
      this.ledger.append({
        entityType: "trial", entityId: trial.id, action: "trial.completed",
        payload: { experiment_id: trial.experiment_id, case_ref: trial.case_ref, environment_seed: trial.environment_seed,
          replicate_id: trial.replicate_id, blind_id: trial.blind_id, replay_of: trial.replay_of,
          manifest_hash: experiment.manifest_hash, model: experiment.manifest.model,
          dataset_ref: experiment.dataset_ref, grader_ref: grading.grader_ref,
          artifact_sha256: digest, trace_hash: traceHash, code_score: grading.result.total,
          qualification_passed: grading.result.qualification_passed },
      });
      return this.store.getTrial(trial.id);
    } catch (error) {
      clearInterval(leaseTimer);
      candidateUsage = error.candidateUsage ?? candidateUsage;
      try { emitWarnings(budget.consume({ wallclock_ms: Math.max(1, Math.round(performance.now() - start)) })); } catch {}
      let resetErrorMessage = null;
      let snapshotErrorMessage = null;
      let candidateFinalization = null;
      let candidateFinalizationError = error.candidateFinalizationAttempted === true ? error.message : null;
      const keepQuarantined = error.keepEnvironmentQuarantined === true;
      const quarantineStarted = error.quarantineStarted === true || keepQuarantined;
      if (environment && environmentReset === null && typeof environment.reset === "function" && !keepQuarantined) {
        if (typeof environment.snapshot === "function") {
          try {
            environmentBeforeReset = await environment.snapshot();
          } catch (snapshotError) {
            snapshotErrorMessage = snapshotError.message;
            event("environment.snapshot_failed_after_failure", "environment", { error: snapshotError.message });
          }
        }
        if (error.candidateTerminal === true && error.runRef && error.candidateFinalizationAttempted !== true &&
            typeof adapter.finalize === "function") {
          try {
            candidateFinalization = await adapter.finalize({ runRef: error.runRef, executionContract,
              reason: "trial_failed_after_candidate_terminal" });
            event("candidate.environment.release_completed_after_failure", "candidate-adapter",
              candidateFinalization ?? { ok: true });
          } catch (finalizationError) {
            candidateFinalizationError = finalizationError.message;
            event("candidate.environment.release_failed", "candidate-adapter", {
              run_ref: error.runRef, error: candidateFinalizationError,
            });
          }
        }
        try {
          environmentReset = await environment.reset();
          event("environment.reset_after_failure", "environment", environmentReset ?? { ok: true });
          if (environmentReset?.ok === false) resetErrorMessage = environmentReset.error ?? "environment reset returned ok=false";
        } catch (resetError) {
          resetErrorMessage = resetError.message;
          event("environment.reset_failed", "environment", { error: resetError.message });
        }
      } else if (keepQuarantined) {
        event("environment.quarantined", "kernel", {
          reason: "external_candidate_not_terminal", candidate_run_ref: error.runRef ?? null,
        });
      }
      const category = error instanceof BudgetExceededError ? "budget.exceeded" : "trial.failed";
      event(category, "kernel", { error: error.message, dimension: error.dimension ?? null });
      try { this.store.endSpan(trial.id, agentSpan, "agent.invoke", "AGENT", "contestant", "ERROR", { error: error.message }); } catch {}
      try { this.store.endSpan(trial.id, rootSpan, "trial.execute", "CHAIN", "runner", "ERROR", { error: error.message }); } catch {}
      const usage = measuredUsage(budget.snapshot().usage, candidateUsage, experiment.manifest.run_class);
      const traceHash = this.store.traceSemanticHash(trial.id);
      const failureClassification = classifyTrialFailure(error, { resetError: resetErrorMessage,
        keepQuarantined });
      const finalState = {
        before_reset: environmentBeforeReset,
        candidate_finalization: candidateFinalization,
        reset: environmentReset,
        quarantine: {
          required: quarantineStarted,
          released: quarantineStarted ? error.quarantineReleased === true : true,
          candidate_run_ref: error.runRef ?? null,
        },
        snapshot_error: snapshotErrorMessage,
        candidate_finalization_error: candidateFinalizationError,
        reset_error: resetErrorMessage,
        failure_classification: failureClassification,
      };
      if (error.cancelled === true && !keepQuarantined && !resetErrorMessage && environmentReset?.ok !== false) {
        this.store.cancelTrial(trial.id, error.message, { usage, finalState, traceHash });
        this.ledger.append({ entityType: "trial", entityId: trial.id, action: "trial.cancelled", payload: {
          reason: error.message, usage, trace_hash: traceHash, environment_reset: environmentReset,
          quarantine: finalState.quarantine,
        } });
        return this.store.getTrial(trial.id);
      }
      this.store.failTrial(trial.id, error.message, { usage, finalState, traceHash });
      this.ledger.append({ entityType: "trial", entityId: trial.id, action: "trial.failed", payload: {
        error: error.message, usage, trace_hash: traceHash, environment_reset: environmentReset,
        quarantine: finalState.quarantine,
        snapshot_error: snapshotErrorMessage,
        reset_error: resetErrorMessage,
      } });
      if (error.haltQueue === true || resetErrorMessage || environmentReset?.ok === false) {
        const haltError = error.haltQueue === true ? error
          : new Error(`trial cleanup failed; evaluation queue halted: ${resetErrorMessage ?? environmentReset?.error ?? "unknown"}`);
        haltError.haltQueue = true;
        throw haltError;
      }
      return this.store.getTrial(trial.id);
    }
  }
}
