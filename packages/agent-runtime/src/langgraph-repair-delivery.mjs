import { productRepairProgress } from "./product-action-events.mjs";

// Approval state and independently verified repair history are separate facts.
// This adapter does not change the shared AH interpretation or grading weights.
//
// LangGraph publishes one task-level conclusion plus the complete action ledger.
// EvalOS checks that the published conclusion is bound to real, ordered evidence;
// it never re-derives a conclusion of its own, and in particular never treats
// whichever action happens to sit last in the list as the task result.
const DELIVERY_CONTRACT = "opsmind-lg-repair-delivery/2.0";
const VERIFIED_OUTCOMES = new Set(["effective", "ineffective"]);
const WRITE_EVENTS = new Set(["action.started", "action.succeeded", "action.failed", "action.unknown",
  "rollback.started", "rollback.succeeded", "rollback.failed", "rollback.unknown"]);

export function langGraphRepairProgress(normalized, projection, rawEvents) {
  const progress = productRepairProgress(normalized);
  const delivery = projection?.repair_delivery;
  if (!delivery && projection?.contract_version !== "opsmind-controlled-remediation:1.3") return progress;
  const errors = [];
  const rows = delivery?.actions ?? [];
  const current = delivery?.current_action_ref;
  const taskRef = delivery?.task_action_ref;
  const report = delivery?.task_verification;
  const taskRow = rows.find((row) => row.action_id === taskRef?.action_id &&
    row.proposal_digest === taskRef?.proposal_digest) ?? null;
  const attempt = { action_id: taskRow?.action_id, attempt_id: taskRow?.attempt_id,
    status: taskRow?.execution_status, completed_at: taskRow?.completed_at };
  const sameRef = (left, right) => left?.action_id === right?.action_id &&
    left?.proposal_digest === right?.proposal_digest;
  if (delivery?.contract_version !== DELIVERY_CONTRACT) errors.push("repair_delivery_contract_missing");
  const payload = (event) => event.public_payload ?? event.payload ?? {};

  // The task conclusion must name an action that really exists in this run's history.
  if (!taskRef?.action_id || !/^[a-f0-9]{64}$/.test(taskRef.proposal_digest ?? "") || !taskRow ||
      !(projection?.action_history ?? []).some((ref) => sameRef(ref, taskRef))) {
    errors.push("task_action_binding_mismatch");
  }
  if (!sameRef(projection?.current_action_ref, delivery?.current_action_ref)) {
    errors.push("current_action_binding_mismatch");
  }
  // An action that is still open cannot coexist with a published task conclusion.
  const openAction = Boolean(current?.action_id) && !rows.some((row) =>
    row.action_id === current.action_id && row.proposal_digest === current.proposal_digest && row.verification);
  if (openAction && delivery?.recovery_verified === true) {
    errors.push("task_concluded_while_an_action_is_open");
  }

  // The conclusion must rest on one independent report, produced after that action.
  if (!report?.report_id || report.action_id !== taskRef?.action_id ||
      report.attempt_id !== attempt?.attempt_id || !VERIFIED_OUTCOMES.has(report.outcome) ||
      !["failed", "succeeded"].includes(attempt?.status) ||
      !/^[a-f0-9]{64}$/.test(report.after_digest ?? "") || !report.verifier_identity ||
      !Number.isFinite(Date.parse(report.observed_at)) ||
      !Number.isFinite(Date.parse(attempt.completed_at)) ||
      Date.parse(report.observed_at) < Date.parse(attempt.completed_at)) {
    errors.push("task_verification_not_bound");
  }

  const historyIds = new Set(rows.map((row) => row.action_id));
  const history = projection?.action_history ?? [];
  if (historyIds.size !== rows.length || history.length !== rows.length ||
      history.some((ref, index) => ref.action_id !== rows[index]?.action_id) ||
      progress.actions.some((row) => !historyIds.has(row.action_id))) {
    errors.push("action_history_incomplete");
  }

  const verifiedIndex = rawEvents.findLastIndex((event) =>
    event.event_type === `verification.${report?.outcome}` &&
    payload(event).action_id === taskRef?.action_id && payload(event).report_id === report?.report_id);
  if (verifiedIndex < 0 || rawEvents.slice(verifiedIndex + 1).some((event) => WRITE_EVENTS.has(event.event_type))) {
    errors.push("task_verification_not_after_last_action");
  }
  if (!delivery?.current_action_ref && !rawEvents.some((event, index) => index > verifiedIndex &&
      event.event_type === "investigation.reopened" && payload(event).action_id === taskRef?.action_id &&
      payload(event).reason === "action_closed_after_verified_outcome")) {
    errors.push("task_action_closure_missing");
  }

  for (const row of rows.filter((item) => item.attempt_id && item !== taskRow)) {
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
      WRITE_EVENTS.has(event.event_type) && payload(event).action_id !== row.action_id);
    // Verified results can be closed without pretending the action was undone.
    // Both the independent report and the ordered public events must agree.
    const verifiedChange = row.changed_external_state === true && Boolean(priorReport?.report_id) &&
      priorReport?.action_id === row.action_id && priorReport?.attempt_id === row.attempt_id &&
      VERIFIED_OUTCOMES.has(priorReport?.outcome) &&
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

  // The published conclusion is accepted as published, or rejected outright.
  // It is never replaced by a conclusion EvalOS inferred from the action order.
  const publishedRecovered = delivery?.recovery_verified === true;
  const conclusion = delivery?.recovery_conclusion ?? null;
  if (publishedRecovered !== (conclusion === "recovered" && report?.outcome === "effective")) {
    errors.push("task_conclusion_inconsistent_with_its_report");
  }
  return { ...progress,
    recovery_verified: publishedRecovered && errors.length === 0,
    recovery_conclusion: errors.length === 0 ? conclusion : "unverified",
    task_verification: report ?? null,
    attempt_history: rows,
    explanation: delivery?.explanation ?? "恢复结果尚未完成核验",
    reception_errors: [...new Set(errors)] };
}
