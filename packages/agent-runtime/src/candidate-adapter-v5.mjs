import { createHash } from "node:crypto";

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "INCONCLUSIVE"]);
const REAL_LANES = new Set(["AGENT_CAPABILITY", "CONTROLLED_CLOSURE", "PRODUCT_RELIABILITY"]);
const ALWAYS_REQUIRED_PRODUCT_EVIDENCE = ["queue", "worker", "persistence", "audit", "archive"];
const BINDING_RANK = Object.freeze({ UNBOUND: 0, EVIDENCE_CHAIN_BOUND: 1, PRODUCT_NATIVE_ACK: 2 });

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required`);
  return value;
}

function cancellationError(cancellation) {
  const error = new Error(cancellation?.reason || "evaluation cancellation requested");
  error.name = "TrialCancellationError";
  error.cancelled = true;
  error.cancellationRequestedAt = cancellation?.requested_at ?? null;
  return error;
}

function assertDiscovery(discovery, contestant) {
  if (!discovery || discovery.candidate_kind !== "REAL_PRODUCT") {
    throw new Error("Candidate Adapter 5.0 accepts only an external REAL_PRODUCT discovery document");
  }
  for (const field of ["source_revision", "artifact_digest", "runtime_digest", "runtime_manifest_digest", "capability_contract_digest"]) {
    if (discovery[field] !== contestant[field]) throw new Error(`candidate discovery drift: ${field}`);
  }
  if (discovery.architecture !== contestant.architecture) throw new Error("candidate discovery drift: architecture");
  if (contestant.candidate_runtime && canonical(discovery.candidate_runtime) !== canonical(contestant.candidate_runtime)) {
    throw new Error("candidate discovery drift: candidate_runtime");
  }
  if (discovery.production_writes_available !== false) throw new Error("real production writes must remain unavailable during EvalOS evaluation");
}

function assertObservation(observation, runRef) {
  if (!observation || typeof observation !== "object") throw new Error("candidate returned an invalid observation");
  if (observation.run_ref !== runRef) throw new Error("candidate observation escaped the frozen run identity");
  if (!Array.isArray(observation.raw_events)) throw new Error("candidate observation must preserve raw_events");
  if (!Array.isArray(observation.normalized_events)) throw new Error("candidate observation must provide normalized_events");
  const rawRefs = new Set(observation.raw_events.map((item) => item?.source_ref).filter(Boolean));
  for (const event of observation.normalized_events) {
    if (!Array.isArray(event?.raw_source_refs) || !event.raw_source_refs.length ||
        event.raw_source_refs.some((ref) => !rawRefs.has(ref))) {
      throw new Error("each normalized event must point to preserved raw evidence");
    }
  }
  return observation;
}

function assertProductEvidence(productEvidence) {
  for (const name of ALWAYS_REQUIRED_PRODUCT_EVIDENCE) {
    const item = productEvidence?.[name];
    if (item?.applicable === false || item?.recorded !== true || typeof item.ref !== "string" || !item.ref) {
      throw new Error(`candidate result is missing product evidence: ${name}`);
    }
  }
  const recovery = productEvidence?.recovery;
  if (!recovery || (recovery.applicable !== false && (recovery.recorded !== true || !recovery.ref))) {
    throw new Error("candidate result is missing applicable product evidence: recovery");
  }
}

function assertBinding(binding, requiredStrength) {
  const strength = binding?.binding_strength ?? "UNBOUND";
  const mismatches = [
    ...(binding?.native_conformance?.mismatches ?? []),
    ...(binding?.evidence_chain?.mismatches ?? []),
  ];
  if (binding?.contract !== "evalos-product-run-binding.3" || binding?.complete !== true || mismatches.length > 0 ||
      (BINDING_RANK[strength] ?? 0) < (BINDING_RANK[requiredStrength] ?? Number.POSITIVE_INFINITY)) {
    throw new Error(`external candidate result is not bound to the frozen Trial context: ${strength}`);
  }
}

export function createCandidateAdapterV5({ id, connector, pollIntervalMs = 500, timeoutMs = Number.POSITIVE_INFINITY,
  quarantineTimeoutMs = 300000, progressHeartbeatMs = 30000 } = {}) {
  requiredString(id, "candidate id");
  if (!connector || typeof connector.discover !== "function" || typeof connector.start !== "function" ||
      typeof connector.observe !== "function" || typeof connector.cancel !== "function") {
    throw new Error("Candidate Adapter 5.0 requires discover/start/observe/cancel connector methods");
  }
  return Object.freeze({
    id,
    adapterVersion: "candidate-adapter-5.0.0",
    adapterContractVersion: "5.0",
    supportedEvaluationLanes: [...REAL_LANES],
    runtime: `external-real-product/${connector.kind ?? "product"}`,
    async finalize({ runRef, outcome, executionContract, reason = "trial_terminal" } = {}) {
      const candidateRunRef = runRef ?? outcome?.candidate_run_ref;
      if (!candidateRunRef) return { ok: true, required: false, reason: "candidate_run_ref_unavailable" };
      if (typeof connector.finalize !== "function") {
        return { ok: true, required: false, run_ref: candidateRunRef, reason: "connector_owns_no_finalizer" };
      }
      const result = await connector.finalize({ runRef: candidateRunRef, executionContract, reason });
      if (result?.ok !== true) throw new Error("candidate product did not prove terminal cleanup handoff");
      return { required: true, ...result };
    },
    async preflight({ contestant, requiresTwin = false, budget = null }) {
      const discovery = await connector.discover();
      assertDiscovery(discovery, contestant);
      const connectorReadiness = typeof connector.evaluationReadiness === "function"
        ? await connector.evaluationReadiness() : { isolated_tenant_slots: 1, safe_parallelism: 1 };
      const healthy = new Set(["reachable", "ready", "healthy", "ok"]).has(String(discovery.health?.status ?? "").toLowerCase());
      const twinReady = connectorReadiness.external_twin_ready === true;
      const trialWallclockMs = Number(budget?.wallclock_ms);
      const candidateMaxRunMs = Number(connectorReadiness.budget_contract?.max_run_ms);
      const budgetObservable = connectorReadiness.budget_contract?.observable === true &&
        Number.isFinite(candidateMaxRunMs) && candidateMaxRunMs > 0;
      const budgetAligned = Number.isFinite(trialWallclockMs) && trialWallclockMs > 0 && budgetObservable
        ? candidateMaxRunMs <= trialWallclockMs : null;
      const budgetContractConsistent = connectorReadiness.budget_contract?.deployment_declaration_matches !== false;
      const limitations = [];
      if (!budgetObservable) limitations.push("candidate_max_run_time_not_public");
      if (!budgetContractConsistent) limitations.push("candidate_budget_declaration_drift");
      if (discovery.usage_observability?.complete !== true) limitations.push("candidate_usage_partially_observable");
      const hardReady = healthy && connectorReadiness.identities_separated === true &&
        connectorReadiness.tenant_bound === true && connectorReadiness.least_privilege === true &&
        (!requiresTwin || twinReady) && budgetAligned !== false && budgetContractConsistent;
      const formalReady = hardReady && budgetAligned === true &&
        (contestant.binding_requirement !== "PRODUCT_NATIVE_ACK" || discovery.native_run_context_supported === true);
      return {
        ready: hardReady,
        readiness_status: formalReady ? "READY" : hardReady ? "READY_WITH_LIMITATIONS" : "BLOCKED_FOR_FORMAL",
        formal_ready: formalReady,
        limitations,
        architecture: discovery.architecture,
        source_revision: discovery.source_revision,
        artifact_digest: discovery.artifact_digest,
        runtime_digest: discovery.runtime_digest,
        runtime_manifest_digest: discovery.runtime_manifest_digest,
        capability_contract_digest: discovery.capability_contract_digest,
        candidate_runtime: discovery.candidate_runtime ?? null,
        health: discovery.health,
        credentials: { roles: connectorReadiness.credential_roles ?? [],
          identities_separated: connectorReadiness.identities_separated === true,
          least_privilege: connectorReadiness.least_privilege === true,
          checks: connectorReadiness.credential_checks ?? {} },
        isolation: { tenant_bound: connectorReadiness.tenant_bound === true,
          isolated_tenant_slots: Number(connectorReadiness.isolated_tenant_slots ?? 0),
          safe_parallelism: Number(connectorReadiness.safe_parallelism ?? 1) },
        twin: { required: requiresTwin, ready: twinReady, ...(connectorReadiness.twin ?? {}) },
        budget: { trial_wallclock_ms: Number.isFinite(trialWallclockMs) ? trialWallclockMs : null,
          candidate_max_run_ms: budgetObservable ? candidateMaxRunMs : null,
          observable: budgetObservable, aligned: budgetAligned,
          native_enforcement: connectorReadiness.budget_contract?.native_enforcement === true,
          enforced_dimensions: connectorReadiness.budget_contract?.dimensions ?? null,
          deployment_declaration_matches: budgetContractConsistent,
          cancellation_supported: connectorReadiness.budget_contract?.cancellation_supported === true,
          source: connectorReadiness.budget_contract?.source ?? "not-declared" },
        production_writes_available: discovery.production_writes_available,
      };
    },
    async execute({ executionContract, emit, requestApproval, captureEnvironment, shouldCancel, heartbeat }) {
      if (executionContract.run_class !== "REAL_CANDIDATE" || executionContract.contestant.kind !== "REAL_PRODUCT") {
        throw new Error("Candidate Adapter 5.0 refuses test doubles and non-real runs");
      }
      if (!REAL_LANES.has(executionContract.evaluation_lane)) throw new Error("Candidate Adapter 5.0 refuses this evaluation lane");
      const discovery = await connector.discover();
      assertDiscovery(discovery, executionContract.contestant);
      await emit("candidate.discovery.verified", "candidate-adapter", {
        architecture: discovery.architecture,
        source_revision: discovery.source_revision,
        runtime_manifest_digest: discovery.runtime_manifest_digest,
        capability_contract_digest: discovery.capability_contract_digest,
        candidate_runtime: discovery.candidate_runtime ?? null,
      });
      if (typeof connector.prepare === "function") {
        const preparation = await connector.prepare({ executionContract });
        await emit("candidate.evaluation_context.prepared", "candidate-adapter", preparation ?? {});
      }
      const started = await connector.start({ executionContract });
      const runRef = requiredString(started?.run_ref, "external candidate run_ref");
      await emit("candidate.run.submitted", "candidate-adapter", {
        run_ref: runRef, status: started.status ?? "QUEUED", binding_receipt: started.binding_receipt ?? null,
      });
      let cursor = started.cursor ?? null;
      let status = started.status ?? "QUEUED";
      let finalObservation = null;
      let rawEventCount = 0;
      let normalizedEventCount = 0;
      const seenRawEventDigests = new Map();
      const seenNormalizedEventDigests = new Set();
      let lastProgressHeartbeatAt = 0;
      const runStartedAt = Date.now();
      let nextProgressCheckpointMs = 900000;
      const handledApprovalRefs = new Set();
      const deadline = Date.now() + Math.min(timeoutMs, executionContract.budget.wallclock_ms);
      try {
        while (!TERMINAL.has(status)) {
          const cancellation = typeof shouldCancel === "function" ? await shouldCancel() : { requested: false };
          if (cancellation?.requested) throw cancellationError(cancellation);
          if (typeof heartbeat === "function") await heartbeat();
          if (Date.now() >= deadline) throw new Error("external candidate run timed out");
          if (Date.now() - lastProgressHeartbeatAt >= Math.max(1000, progressHeartbeatMs)) {
            lastProgressHeartbeatAt = Date.now();
            await emit("candidate.poll.heartbeat", "candidate-adapter", { run_ref: runRef, status, cursor,
              raw_event_count: rawEventCount, normalized_event_count: normalizedEventCount });
          }
          const elapsedMs = Date.now() - runStartedAt;
          if (elapsedMs >= nextProgressCheckpointMs) {
            await emit("candidate.progress.checkpoint", "candidate-adapter", { run_ref: runRef, status,
              elapsed_ms: elapsedMs, checkpoint_ms: nextProgressCheckpointMs,
              raw_event_count: rawEventCount, normalized_event_count: normalizedEventCount });
            nextProgressCheckpointMs += 900000;
          }
          const observation = assertObservation(await connector.observe({ runRef, cursor, executionContract }), runRef);
          cursor = observation.next_cursor ?? cursor;
          status = observation.status;
          for (const raw of observation.raw_events) {
            const payloadDigest = raw.payload_digest ?? digest(raw.payload);
            const previousDigest = seenRawEventDigests.get(raw.source_ref);
            if (previousDigest && previousDigest !== payloadDigest) {
              throw new Error(`candidate raw evidence changed after publication: ${raw.source_ref}`);
            }
            if (previousDigest) continue;
            seenRawEventDigests.set(raw.source_ref, payloadDigest);
            rawEventCount += 1;
            await emit("candidate.raw_event", "external-candidate", { source_ref: raw.source_ref,
              source_system: raw.source_system, recorded_at: raw.recorded_at ?? new Date().toISOString(),
              payload_digest: payloadDigest, payload: raw.payload });
          }
          for (const normalized of observation.normalized_events) {
            const normalizedDigest = digest({ event_type: normalized.event_type, actor: normalized.actor,
              status: normalized.status, raw_source_refs: normalized.raw_source_refs, payload: normalized.payload ?? {} });
            if (seenNormalizedEventDigests.has(normalizedDigest)) continue;
            seenNormalizedEventDigests.add(normalizedDigest);
            normalizedEventCount += 1;
            await emit(normalized.event_type, normalized.actor ?? "external-candidate", {
              ...(normalized.payload ?? {}), status: normalized.status, raw_source_refs: normalized.raw_source_refs,
            });
          }
          const captureMilestones = observation.normalized_events.map((item) => item?.event_type)
            .filter((name) => ["evidence.collected", "conclusion.recorded", "action.executed",
              "verification.completed", "rollback.verified"].includes(name));
          if (captureMilestones.length && typeof captureEnvironment === "function") {
            await captureEnvironment(captureMilestones.at(-1));
          }
          for (const approvalRequest of observation.approval_requests ?? []) {
            if (handledApprovalRefs.has(approvalRequest.request_ref)) continue;
            if (typeof requestApproval !== "function" || typeof connector.respondApproval !== "function") {
              throw new Error("candidate requested approval but Approval Oracle integration is unavailable");
            }
            const decision = await requestApproval({ run_ref: runRef, ...approvalRequest });
            await connector.respondApproval({ runRef, request: approvalRequest, decision, executionContract });
            handledApprovalRefs.add(approvalRequest.request_ref);
            await emit("approval.oracle.responded", "approval-oracle", { request_ref: approvalRequest.request_ref,
              decision: decision.decision, reason_code: decision.reason_code, policy_digest: decision.policy_digest });
          }
          finalObservation = observation;
          if (!TERMINAL.has(status)) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
      } catch (error) {
        error.candidateUsage = finalObservation?.candidate_usage ?? error.candidateUsage ?? null;
        const cancellation = await connector.cancel({ runRef,
          reason: error.cancelled ? "evalos_operator_cancellation" : "evalos_adapter_failure" })
          .catch((cancelError) => ({ supported: false, error: cancelError?.message ?? String(cancelError) }));
        await emit("candidate.run.quarantine_started", "candidate-adapter", { run_ref: runRef, cause: error.message,
          cancellation_supported: cancellation?.supported === true,
          cancellation_reason: cancellation?.reason ?? cancellation?.error ?? null });
        const quarantineDeadline = Date.now() + Math.max(1, quarantineTimeoutMs);
        let lastObservationError = null;
        while (!TERMINAL.has(status) && Date.now() < quarantineDeadline) {
          try {
            const observation = assertObservation(await connector.observe({ runRef, cursor, executionContract }), runRef);
            cursor = observation.next_cursor ?? cursor;
            status = observation.status;
            lastObservationError = null;
          } catch (observeError) { lastObservationError = observeError; }
          if (!TERMINAL.has(status)) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
        if (TERMINAL.has(status)) {
          await emit("candidate.run.quarantine_released", "candidate-adapter", {
            run_ref: runRef, terminal_status: status, original_error: error.message });
          error.quarantineStarted = true;
          error.quarantineReleased = true;
          error.runRef = runRef;
          error.candidateTerminal = true;
          throw error;
        }
        const isolationError = new Error(`external candidate quarantine unresolved: ${error.message}`);
        isolationError.name = "CandidateIsolationError";
        isolationError.haltQueue = true;
        isolationError.keepEnvironmentQuarantined = true;
        isolationError.quarantineStarted = true;
        isolationError.quarantineReleased = false;
        isolationError.runRef = runRef;
        isolationError.observationError = lastObservationError?.message ?? null;
        isolationError.candidateUsage = error.candidateUsage ?? null;
        throw isolationError;
      }
      const requiredStrength = executionContract.contestant.binding_requirement ?? "EVIDENCE_CHAIN_BOUND";
      try { assertBinding(finalObservation?.evaluation_binding, requiredStrength); }
      catch (error) {
        error.candidateUsage = finalObservation?.candidate_usage ?? null;
        error.runRef = runRef;
        error.candidateTerminal = true;
        throw error;
      }
      await emit("candidate.evaluation_binding.verified", "candidate-adapter", { run_ref: runRef,
        binding_strength: finalObservation.evaluation_binding.binding_strength,
        required_strength: requiredStrength,
        expected_context_digest: finalObservation.evaluation_binding.expected_context_digest });
      if (status !== "COMPLETED" && status !== "INCONCLUSIVE") {
        const terminalError = finalObservation?.error ?? {};
        const detail = [terminalError.code, terminalError.message].filter(Boolean).join(" - ") || "unknown";
        const candidateError = new Error(`external candidate run ended with ${status}: ${detail}`);
        candidateError.name = terminalError.code || "CandidateProductError";
        candidateError.candidateUsage = finalObservation?.candidate_usage ?? null;
        candidateError.runRef = runRef;
        candidateError.candidateTerminal = true;
        throw candidateError;
      }
      if (!finalObservation?.outcome || typeof finalObservation.outcome !== "object") {
        const error = new Error("external candidate completed without a structured outcome");
        error.runRef = runRef;
        error.candidateTerminal = true;
        throw error;
      }
      if (executionContract.evaluation_lane === "PRODUCT_RELIABILITY") assertProductEvidence(finalObservation.product_evidence);
      await emit("candidate.evidence.frozen", "candidate-adapter", { run_ref: runRef,
        raw_event_count: rawEventCount, normalized_event_count: normalizedEventCount,
        artifact_refs: finalObservation.artifact_refs ?? [] });
      return { ...finalObservation.outcome, candidate_run_ref: runRef,
        evaluation_binding: finalObservation.evaluation_binding,
        product_evidence: finalObservation.product_evidence ?? null,
        artifact_refs: finalObservation.artifact_refs ?? [],
        adapter_translation_digest: digest({ runRef, cursor, status }),
        __evalos_usage: finalObservation.candidate_usage ?? null };
    },
  });
}

export const CANDIDATE_ADAPTER_V5_RUNTIME = Object.freeze({
  contract: "5.0",
  candidate_kind: "REAL_PRODUCT",
  lanes: [...REAL_LANES],
  role: "submit-translate-preserve-native-evidence",
  binding_strengths: Object.keys(BINDING_RANK),
  forbidden: ["invoke-candidate-internal-tools", "synthesize-missing-evidence", "change-official-score",
    "send-hidden-case-or-seed"],
  product_evidence: [...ALWAYS_REQUIRED_PRODUCT_EVIDENCE, "recovery-when-applicable"],
});
