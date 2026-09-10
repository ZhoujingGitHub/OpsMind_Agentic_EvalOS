import { productRepairProgress } from "./product-action-events.mjs";

// Approval state and independently verified repair history are separate facts.
// This adapter does not change the shared AH interpretation or grading weights.
export function langGraphRepairProgress(normalized, projection, rawEvents) {
  const progress = productRepairProgress(normalized);
  const delivery = projection?.repair_delivery;
  if (!delivery && projection?.contract_version !== "opsmind-controlled-remediation:1.3") return progress;
  const errors = [];
  const rows = delivery?.actions ?? [];
  const current = delivery?.final_action_ref;
  const final = rows.at(-1);
  const report = final?.verification;
  const attempt = { action_id: final?.action_id, attempt_id: final?.attempt_id,
    status: final?.execution_status, completed_at: final?.completed_at };
  const sameRef = (left, right) => left?.action_id === right?.action_id &&
    left?.proposal_digest === right?.proposal_digest;
  if (delivery?.contract_version !== "opsmind-lg-repair-delivery/1.0") errors.push("repair_delivery_contract_missing");
  if (!current?.action_id || !/^[a-f0-9]{64}$/.test(current.proposal_digest ?? "") ||
      !sameRef(current, final) || !sameRef(current, projection?.action_history?.at(-1)) ||
      !sameRef(projection?.current_action_ref, delivery?.current_action_ref) ||
      (projection?.current_action_ref && !sameRef(current, projection.current_action_ref))) {
    errors.push("final_action_binding_mismatch");
  }
  if (!report?.report_id || report.action_id !== current?.action_id || report.attempt_id !== attempt?.attempt_id ||
      attempt?.action_id !== current?.action_id || attempt?.status !== "succeeded" || report.outcome !== "effective" ||
      delivery?.final_verification?.report_id !== report.report_id ||
      !/^[a-f0-9]{64}$/.test(report.after_digest ?? "") || !report.verifier_identity ||
      !Number.isFinite(Date.parse(report.observed_at)) || !Number.isFinite(Date.parse(attempt.completed_at)) ||
      Date.parse(report.observed_at) < Date.parse(attempt.completed_at)) errors.push("final_verification_not_bound");
  const historyIds = new Set(rows.map((row) => row.action_id));
  const history = projection?.action_history ?? [];
  if (historyIds.size !== rows.length || history.length !== rows.length ||
      history.some((ref, index) => ref.action_id !== rows[index]?.action_id) ||
      progress.actions.some((row) => !historyIds.has(row.action_id))) {
    errors.push("action_history_incomplete");
  }
  const payload = (event) => event.public_payload ?? event.payload ?? {};
  const verifiedIndex = rawEvents.findLastIndex((event) => event.event_type === "verification.effective" &&
    payload(event).action_id === current?.action_id && payload(event).report_id === report?.report_id);
  const writes = new Set(["action.started", "action.succeeded", "action.failed", "action.unknown",
    "rollback.started", "rollback.succeeded", "rollback.failed", "rollback.unknown"]);
  if (verifiedIndex < 0 || rawEvents.slice(verifiedIndex + 1).some((event) => writes.has(event.event_type))) {
    errors.push("final_verification_not_after_last_action");
  }
  if (!projection?.current_action_ref && !rawEvents.some((event, index) => index > verifiedIndex &&
      event.event_type === "investigation.reopened" && payload(event).action_id === current?.action_id &&
      payload(event).reason === "action_closed_after_verified_outcome")) {
    errors.push("final_action_closure_missing");
  }
  for (const row of rows.slice(0, -1).filter((item) => item.attempt_id)) {
    const rollback = row.rollback;
    const priorReport = row.verification;
    const completedIndex = rawEvents.findLastIndex((event) =>
      event.event_type === `action.${row.execution_status}` &&
      payload(event).action_id === row.action_id);
    const priorVerifiedIndex = rawEvents.findLastIndex((event) =>
      event.event_type === `verification.${priorReport?.outcome}` &&
      payload(event).action_id === row.action_id && payload(event).report_id === priorReport?.report_id);
    const closureIndex = rawEvents.findIndex((event) => event.event_type === "investigation.reopened" &&
      payload(event).action_id === row.action_id && payload(event).reason === "action_closed_after_verified_outcome");
    const nextWriteIndex = rawEvents.findIndex((event, index) => index > completedIndex &&
      writes.has(event.event_type) && payload(event).action_id !== row.action_id);
    // Verified results can be closed without pretending the action was undone.
    // Both the independent report and the ordered public events must agree.
    const verifiedChange = row.changed_external_state === true && Boolean(priorReport?.report_id) &&
      priorReport?.action_id === row.action_id && priorReport?.attempt_id === row.attempt_id &&
      (priorReport?.outcome === "ineffective" ||
        (priorReport?.outcome === "effective" && row.execution_status === "succeeded")) &&
      Boolean(priorReport.verifier_identity) &&
      /^[a-f0-9]{64}$/.test(priorReport.after_digest ?? "") &&
      Number.isFinite(Date.parse(priorReport.observed_at)) &&
      Date.parse(priorReport.observed_at) <= Date.parse(report?.observed_at) &&
      completedIndex >= 0 && priorVerifiedIndex > completedIndex && closureIndex > priorVerifiedIndex;
    const safelyClosed = ["failed", "succeeded"].includes(row.execution_status) &&
      (row.changed_external_state === false || verifiedChange || (rollback?.attempt_id === row.attempt_id &&
        rollback?.outcome === "succeeded" && rollback?.verification_outcome === "effective"));
    if (!safelyClosed || row.escalation_reason || completedIndex < 0 || closureIndex <= completedIndex ||
        closureIndex >= verifiedIndex || (nextWriteIndex >= 0 && closureIndex >= nextWriteIndex)) {
      errors.push("prior_action_not_safely_closed");
    }
  }
  return { ...progress,
    recovery_verified: delivery?.recovery_verified === true && errors.length === 0,
    final_verification: report ?? null,
    attempt_history: rows,
    explanation: delivery?.explanation ?? "恢复结果尚未完成核验",
    reception_errors: [...new Set(errors)] };
}
