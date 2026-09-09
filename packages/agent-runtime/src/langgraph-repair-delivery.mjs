import { productRepairProgress } from "./product-action-events.mjs";

// LG's current repair and its earlier unsuccessful attempts are separate facts.
// This adapter does not change the shared AH interpretation or grading weights.
export function langGraphRepairProgress(normalized, projection, rawEvents) {
  const progress = productRepairProgress(normalized);
  const delivery = projection?.repair_delivery;
  if (!delivery && projection?.contract_version !== "opsmind-controlled-remediation:1.3") return progress;
  const errors = [];
  const current = projection?.current_action_ref;
  const lifecycle = projection?.action_lifecycle;
  const report = lifecycle?.verification;
  const attempt = lifecycle?.attempt;
  const rows = delivery?.actions ?? [];
  if (delivery?.contract_version !== "opsmind-lg-repair-delivery/1.0") errors.push("repair_delivery_contract_missing");
  if (!current?.action_id || !/^[a-f0-9]{64}$/.test(current.proposal_digest ?? "") ||
      current.action_id !== lifecycle?.action_id ||
      current.action_id !== delivery?.current_action_ref?.action_id ||
      current.proposal_digest !== lifecycle?.proposal?.proposal_digest ||
      current.proposal_digest !== delivery?.current_action_ref?.proposal_digest ||
      rows.at(-1)?.action_id !== current.action_id) errors.push("current_action_binding_mismatch");
  if (!report?.report_id || report.action_id !== current?.action_id || report.attempt_id !== attempt?.attempt_id ||
      attempt?.action_id !== current?.action_id || attempt?.status !== "succeeded" || report.outcome !== "effective" ||
      delivery?.final_verification?.report_id !== report.report_id ||
      !/^[a-f0-9]{64}$/.test(report.after_digest ?? "") || !report.verifier_identity ||
      !Number.isFinite(Date.parse(report.observed_at)) || !Number.isFinite(Date.parse(attempt.completed_at)) ||
      Date.parse(report.observed_at) < Date.parse(attempt.completed_at)) errors.push("final_verification_not_bound");
  const historyIds = new Set(rows.map((row) => row.action_id));
  if (historyIds.size !== rows.length || progress.actions.some((row) => !historyIds.has(row.action_id))) {
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
  for (const row of rows.slice(0, -1).filter((item) => item.attempt_id)) {
    const rollback = row.rollback;
    const safelyClosed = ["failed", "succeeded"].includes(row.execution_status) &&
      (row.changed_external_state === false || (rollback?.attempt_id === row.attempt_id &&
        rollback?.outcome === "succeeded" && rollback?.verification_outcome === "effective"));
    const closureIndex = rawEvents.findIndex((event) => event.event_type === "investigation.reopened" &&
      payload(event).action_id === row.action_id && payload(event).reason === "action_closed_after_verified_outcome");
    if (!safelyClosed || row.escalation_reason || closureIndex < 0 || closureIndex >= verifiedIndex) {
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
