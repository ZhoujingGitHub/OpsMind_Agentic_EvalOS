// Explicit product event semantics. Archiving and evidence review never prove
// that a repair was executed or independently verified.
const ACTION_EVENTS = new Map([
  ["proposal.created", "action.proposed"], ["action.proposed", "action.proposed"],
  ["approval.requested", "approval.requested"],
  ["approval.approved", "approval.decided"], ["approval.rejected", "approval.decided"],
  ["approval.expired", "approval.decided"],
  ["execution_ticket.issued", "ticket.issued"], ["ticket.issued", "ticket.issued"],
  ["action.started", "action.started"], ["action.succeeded", "action.executed"],
  ["action.failed", "action.failed"], ["action.unknown", "action.unknown"],
  ["verification.effective", "verification.completed"],
  ["verification.ineffective", "verification.failed"],
  ["verification.inconclusive", "verification.inconclusive"],
  ["archive.verified", "archive.reconciled"], ["archive.completed", "archive.reconciled"],
  ["archive.failed", "archive.failed"],
  ["rollback.succeeded", "rollback.executed"], ["rollback.verified", "rollback.verified"],
]);

export function productActionEventType(name) {
  return ACTION_EVENTS.get(String(name ?? "").toLowerCase()) ?? null;
}

export function hasPendingProductActions(actions) {
  return actions.some((item) => ["proposed", "prechecked", "human_required", "human_authorized",
    "auto_authorized", "ticket_issued", "executing", "executed"].includes(item.status));
}

export function boundActionApproval(item, { tenantId, evaluationTenant, trialId, runRef, resourceScope }) {
  const scope = item.scope_json ?? item.scope;
  const ref = scope?.resource_ref;
  const keys = ["identifier_domain", "namespace", "resource_type", "resource_id"];
  if (!evaluationTenant || item.tenant_id !== tenantId || item.trial_id !== trialId ||
      item.investigation_id !== runRef || scope?.tenant_id !== tenantId ||
      ref?.namespace !== resourceScope.namespace || Object.keys(ref ?? {}).length !== keys.length ||
      !resourceScope.resource_refs.some((allowed) => keys.every((key) => allowed[key] === ref?.[key])) ||
      !Array.isArray(scope.entity_ids) || scope.entity_ids.length !== 1 || scope.entity_ids[0] !== item.target_entity_id ||
      !/^[0-9a-f]{64}$/.test(item.proposal_digest ?? "") ||
      !/^[0-9a-f]{64}$/.test(item.environment_snapshot?.snapshot_digest ?? "")) {
    throw new Error("APPROVAL_RESOURCE_BINDING_MISMATCH");
  }
  return { request_ref: `agent-harness-approval:${item.action_id}:${item.proposal_digest}`,
    action_id: item.action_id, proposal: item, proposal_digest: item.proposal_digest,
    environment_snapshot_digest: item.environment_snapshot.snapshot_digest,
    source_scope: structuredClone(scope), scope: { ...scope, tenant_id: evaluationTenant },
    identity_binding: { contract_version: "opsmind-approval-scope/1.0", product_tenant: tenantId,
      evaluation_tenant: evaluationTenant, trial_id: trialId, investigation_id: runRef, resource_ref: { ...ref } },
    policy_decision: item.policy_decision };
}

export function evidenceBoundExclusions(hypotheses, reportEvidenceIds, product) {
  const cited = new Set(reportEvidenceIds);
  return (Array.isArray(hypotheses) ? hypotheses : []).flatMap((item) => {
    if (item?.status !== "rejected") return [];
    const refs = (product === "agent-harness" ? item.counter_evidence_ids : item.contradicting_evidence_ids) ?? [];
    const claim = item.cause ?? item.statement;
    return typeof claim === "string" && claim.trim() && Array.isArray(refs) &&
      refs.length > 0 && refs.every((id) => cited.has(id)) ? [claim.trim()] : [];
  });
}

export function productRepairProgress(events) {
  const actions = new Map();
  for (const event of events) {
    const id = event.payload?.action_id;
    if (typeof id !== "string" || !id) continue;
    if (!["action.proposed", "action.started", "action.executed", "action.failed", "action.unknown",
      "verification.completed", "verification.failed", "verification.inconclusive", "rollback.executed",
      "approval.requested", "approval.decided", "ticket.issued"].includes(event.event_type)) continue;
    const action = actions.get(id) ?? { action_id: id, approval: "not_observed", ticket: "not_observed",
      attempted: false, executed: false, verification: "not_observed" };
    if (event.event_type === "approval.requested") action.approval = "pending";
    if (event.event_type === "approval.decided") {
      const decision = String(event.payload.decision ?? event.payload.event_name ?? "");
      action.approval = ["approved", "APPROVE", "approval.approved"].includes(decision) ? "approved"
        : ["rejected", "REJECT", "approval.rejected"].includes(decision) ? "rejected" : "unknown";
    }
    if (event.event_type === "ticket.issued") action.ticket = "issued";
    if (event.event_type === "action.started" || event.event_type === "action.failed" ||
        event.event_type === "action.unknown" || event.event_type === "rollback.executed") {
      action.executed = false;
      action.verification = "not_observed";
      action.attempted = true;
    }
    if (event.event_type === "action.executed") { action.executed = true; action.attempted = true; }
    if (event.event_type === "verification.completed" && action.executed) action.verification = "effective";
    if (event.event_type === "verification.failed") action.verification = "ineffective";
    if (event.event_type === "verification.inconclusive") action.verification = "inconclusive";
    actions.set(id, action);
  }
  const rows = [...actions.values()];
  const attempted = rows.filter((row) => row.attempted);
  return { actions: rows, execution_observed: rows.some((row) => row.executed),
    recovery_verified: attempted.length > 0 && attempted.every((row) => row.executed && row.verification === "effective") };
}
