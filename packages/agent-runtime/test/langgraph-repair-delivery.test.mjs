import assert from "node:assert/strict";
import test from "node:test";
import { langGraphRepairProgress } from "../src/langgraph-repair-delivery.mjs";

function recoveredAfterFailure() {
  const current = { action_id: "second", proposal_digest: "b".repeat(64) };
  const report = { report_id: "verify-second", action_id: "second", attempt_id: "attempt-second",
    outcome: "effective", after_digest: "a".repeat(64), verifier_identity: "independent-observer",
    observed_at: "2026-09-09T10:00:02Z" };
  const attempt = { action_id: "second", attempt_id: "attempt-second", status: "succeeded",
    completed_at: "2026-09-09T10:00:01Z" };
  const projection = { contract_version: "opsmind-controlled-remediation:1.3", current_action_ref: current,
    action_lifecycle: { action_id: "second", proposal: current, attempt, verification: report },
    repair_delivery: { contract_version: "opsmind-lg-repair-delivery/1.0", current_action_ref: current,
      recovery_verified: true, final_verification: report, explanation: "第1次修复未恢复；第2次修复成功，独立验证有效",
      actions: [{ action_id: "first", attempt_id: "attempt-first", execution_status: "failed", changed_external_state: false },
        { action_id: "second", attempt_id: "attempt-second", execution_status: "succeeded", changed_external_state: true }] } };
  const raw = [
    { event_type: "action.failed", public_payload: { action_id: "first" } },
    { event_type: "investigation.reopened", public_payload: { action_id: "first", reason: "action_closed_after_verified_outcome" } },
    { event_type: "action.succeeded", public_payload: { action_id: "second" } },
    { event_type: "verification.effective", public_payload: { action_id: "second", report_id: "verify-second" } },
  ];
  const normalized = [
    { event_type: "action.failed", payload: { action_id: "first" } },
    { event_type: "action.executed", payload: { action_id: "second" } },
    { event_type: "verification.completed", payload: { action_id: "second" } },
  ];
  return { projection, raw, normalized };
}

test("LG final independent recovery preserves unsuccessful first action", () => {
  const { projection, raw, normalized } = recoveredAfterFailure();
  const before = structuredClone({ projection, raw, normalized });
  const result = langGraphRepairProgress(normalized, projection, raw);
  assert.equal(result.recovery_verified, true);
  assert.equal(result.actions[0].executed, false);
  assert.equal(result.attempt_history[0].execution_status, "failed");
  assert.match(result.explanation, /第1次修复未恢复.*第2次修复成功/);
  assert.deepEqual({ projection, raw, normalized }, before);
});

test("LG cannot use old verification, omitted history or unresolved write as recovery", () => {
  const alterations = [
    ({ projection }) => { projection.current_action_ref = { action_id: "first" }; },
    ({ projection }) => { projection.current_action_ref.proposal_digest = "invalid"; },
    ({ projection }) => { projection.action_lifecycle.verification.attempt_id = "old-attempt"; },
    ({ projection }) => { projection.action_lifecycle.verification.observed_at = "2026-09-09T09:00:00Z"; },
    ({ projection }) => { projection.repair_delivery.actions.shift(); },
    ({ projection }) => { projection.repair_delivery.actions[0].execution_status = "unknown"; },
    ({ projection }) => { projection.repair_delivery.actions[0].changed_external_state = true; },
    ({ raw }) => { raw.splice(1, 1); },
    ({ raw }) => { raw.push({ event_type: "action.failed", public_payload: { action_id: "third" } }); },
    ({ projection }) => { delete projection.repair_delivery; },
  ];
  for (const alter of alterations) {
    const fixture = recoveredAfterFailure();
    alter(fixture);
    assert.equal(langGraphRepairProgress(fixture.normalized, fixture.projection, fixture.raw).recovery_verified, false);
  }
});

test("old LG contract keeps its original interpretation", () => {
  const fixture = recoveredAfterFailure();
  assert.equal(langGraphRepairProgress(fixture.normalized, {}, fixture.raw).recovery_verified, false);
});
