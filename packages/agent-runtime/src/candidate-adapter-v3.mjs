import { createHash } from "node:crypto";

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "INCONCLUSIVE"]);
const REAL_LANES = new Set(["AGENT_CAPABILITY", "CONTROLLED_CLOSURE", "PRODUCT_RELIABILITY"]);
const REQUIRED_PRODUCT_EVIDENCE = ["queue", "worker", "recovery", "persistence", "audit", "archive"];

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required`);
  return value;
}

function assertDiscovery(discovery, contestant) {
  if (!discovery || discovery.candidate_kind !== "REAL_PRODUCT") {
    throw new Error("Candidate Adapter 3.0 accepts only an external REAL_PRODUCT discovery document");
  }
  for (const field of ["source_revision", "artifact_digest", "runtime_digest", "runtime_manifest_digest", "capability_contract_digest"]) {
    if (discovery[field] !== contestant[field]) throw new Error(`candidate discovery drift: ${field}`);
  }
  if (discovery.architecture !== contestant.architecture) throw new Error("candidate discovery drift: architecture");
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
  for (const name of REQUIRED_PRODUCT_EVIDENCE) {
    const item = productEvidence?.[name];
    if (item?.recorded !== true || typeof item.ref !== "string" || !item.ref) {
      throw new Error(`candidate result is missing product evidence: ${name}`);
    }
  }
}

export function createCandidateAdapterV3({ id, connector, pollIntervalMs = 500, timeoutMs = 300000 } = {}) {
  requiredString(id, "candidate id");
  if (!connector || typeof connector.discover !== "function" || typeof connector.start !== "function" ||
      typeof connector.observe !== "function" || typeof connector.cancel !== "function") {
    throw new Error("Candidate Adapter 3.0 requires discover/start/observe/cancel connector methods");
  }
  return Object.freeze({
    id,
    adapterVersion: "candidate-adapter-3.0.0",
    adapterContractVersion: "3.0",
    supportedEvaluationLanes: [...REAL_LANES],
    runtime: `external-real-product/${connector.kind ?? "product"}`,
    async preflight({ contestant }) {
      const discovery = await connector.discover();
      assertDiscovery(discovery, contestant);
      const connectorReadiness = typeof connector.evaluationReadiness === "function"
        ? await connector.evaluationReadiness() : { isolated_tenant_slots: 1, safe_parallelism: 1 };
      const healthy = new Set(["reachable", "ready", "healthy", "ok"]).has(String(discovery.health?.status ?? "").toLowerCase());
      return {
        ready: healthy && connectorReadiness.identities_separated === true && connectorReadiness.tenant_bound === true &&
          connectorReadiness.least_privilege === true,
        architecture: discovery.architecture,
        source_revision: discovery.source_revision,
        artifact_digest: discovery.artifact_digest,
        runtime_digest: discovery.runtime_digest,
        runtime_manifest_digest: discovery.runtime_manifest_digest,
        capability_contract_digest: discovery.capability_contract_digest,
        health: discovery.health,
        credentials: { roles: connectorReadiness.credential_roles ?? [],
          identities_separated: connectorReadiness.identities_separated === true,
          least_privilege: connectorReadiness.least_privilege === true,
          checks: connectorReadiness.credential_checks ?? {} },
        isolation: { tenant_bound: connectorReadiness.tenant_bound === true,
          isolated_tenant_slots: Number(connectorReadiness.isolated_tenant_slots ?? 0),
          safe_parallelism: Number(connectorReadiness.safe_parallelism ?? 1) },
        production_writes_available: discovery.production_writes_available,
      };
    },
    async execute({ trial, executionContract, emit, requestApproval, captureEnvironment }) {
      if (executionContract.run_class !== "REAL_CANDIDATE" || executionContract.contestant.kind !== "REAL_PRODUCT") {
        throw new Error("Candidate Adapter 3.0 refuses test doubles and non-real runs");
      }
      if (!REAL_LANES.has(executionContract.evaluation_lane)) throw new Error("Candidate Adapter 3.0 refuses this evaluation lane");
      const discovery = await connector.discover();
      assertDiscovery(discovery, executionContract.contestant);
      await emit("candidate.discovery.verified", "candidate-adapter", {
        architecture: discovery.architecture,
        source_revision: discovery.source_revision,
        runtime_manifest_digest: discovery.runtime_manifest_digest,
        capability_contract_digest: discovery.capability_contract_digest,
      });
      if (typeof connector.prepare === "function") {
        const preparation = await connector.prepare({ executionContract });
        await emit("candidate.evaluation_context.prepared", "candidate-adapter", preparation ?? {});
      }
      const started = await connector.start({ executionContract });
      const runRef = requiredString(started?.run_ref, "external candidate run_ref");
      await emit("candidate.run.submitted", "candidate-adapter", { run_ref: runRef, status: started.status ?? "QUEUED" });
      let cursor = started.cursor ?? null;
      let status = started.status ?? "QUEUED";
      let finalObservation = null;
      let rawEventCount = 0;
      let normalizedEventCount = 0;
      const handledApprovalRefs = new Set();
      const deadline = Date.now() + Math.min(timeoutMs, executionContract.budget.wallclock_ms);
      try {
        while (!TERMINAL.has(status)) {
          if (Date.now() >= deadline) throw new Error("external candidate run timed out");
          const observation = assertObservation(await connector.observe({ runRef, cursor, executionContract }), runRef);
          cursor = observation.next_cursor ?? cursor;
          status = observation.status;
          rawEventCount += observation.raw_events.length;
          normalizedEventCount += observation.normalized_events.length;
          for (const raw of observation.raw_events) {
            await emit("candidate.raw_event", "external-candidate", {
              source_ref: raw.source_ref, source_system: raw.source_system,
              recorded_at: raw.recorded_at ?? new Date().toISOString(),
              payload_digest: raw.payload_digest ?? digest(raw.payload), payload: raw.payload,
            });
          }
          for (const normalized of observation.normalized_events) {
            await emit(normalized.event_type, normalized.actor ?? "external-candidate", {
              ...(normalized.payload ?? {}), status: normalized.status, raw_source_refs: normalized.raw_source_refs,
            });
          }
          const captureMilestones = observation.normalized_events
            .map((item) => item?.event_type)
            .filter((eventType) => ["evidence.collected", "conclusion.recorded", "action.executed",
              "verification.completed", "rollback.verified"].includes(eventType));
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
            await emit("approval.oracle.responded", "approval-oracle", {
              request_ref: approvalRequest.request_ref, decision: decision.decision,
              reason_code: decision.reason_code, policy_digest: decision.policy_digest,
            });
          }
          finalObservation = observation;
          if (!TERMINAL.has(status)) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
      } catch (error) {
        await connector.cancel({ runRef, reason: "evalos_adapter_failure" }).catch(() => {});
        throw error;
      }
      if (status !== "COMPLETED" && status !== "INCONCLUSIVE") {
        throw new Error(`external candidate run ended with ${status}: ${finalObservation?.error?.code ?? "unknown"}`);
      }
      if (!finalObservation?.outcome || typeof finalObservation.outcome !== "object") {
        throw new Error("external candidate completed without a structured outcome");
      }
      if (!finalObservation?.evaluation_binding || finalObservation.evaluation_binding.complete !== true) {
        const binding = finalObservation?.evaluation_binding ?? { binding_strength: "UNBOUND" };
        throw new Error(`external candidate result is not bound to the frozen Trial context: ${binding.binding_strength}`);
      }
      if (executionContract.evaluation_lane === "PRODUCT_RELIABILITY") assertProductEvidence(finalObservation.product_evidence);
      await emit("candidate.evaluation_binding.verified", "candidate-adapter", {
        run_ref: runRef,
        binding_strength: finalObservation.evaluation_binding.binding_strength,
        expected_context_digest: finalObservation.evaluation_binding.expected_context_digest,
      });
      await emit("candidate.evidence.frozen", "candidate-adapter", {
        run_ref: runRef, raw_event_count: rawEventCount,
        normalized_event_count: normalizedEventCount,
        artifact_refs: finalObservation.artifact_refs ?? [],
      });
      return {
        ...finalObservation.outcome,
        candidate_run_ref: runRef,
        evaluation_binding: finalObservation.evaluation_binding,
        product_evidence: finalObservation.product_evidence ?? null,
        artifact_refs: finalObservation.artifact_refs ?? [],
        adapter_translation_digest: digest({ runRef, cursor, status }),
      };
    },
  });
}

export const CANDIDATE_ADAPTER_V3_RUNTIME = Object.freeze({
  contract: "3.0",
  candidate_kind: "REAL_PRODUCT",
  lanes: [...REAL_LANES],
  role: "submit-translate-preserve-evidence",
  forbidden: ["invoke-candidate-internal-tools", "synthesize-missing-evidence", "change-official-score"],
  product_evidence: REQUIRED_PRODUCT_EVIDENCE,
});
