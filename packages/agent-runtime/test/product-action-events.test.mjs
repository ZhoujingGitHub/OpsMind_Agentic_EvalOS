import assert from "node:assert/strict";
import test from "node:test";
import { boundActionApproval, evidenceBoundExclusions, productActionEventType, productRepairProgress } from "../src/product-action-events.mjs";

test("archiving, requesting verification and unknown action words never prove repair", () => {
  assert.equal(productActionEventType("archive.verified"), "archive.reconciled");
  assert.equal(productActionEventType("verification.requested"), null);
  assert.equal(productActionEventType("action.execution.preview"), null);
  assert.equal(productRepairProgress([{ event_type: "archive.reconciled", payload: { action_id: "a" } }]).recovery_verified, false);
});

test("repair needs ordered execution and effective verification for the same action", () => {
  const execute = { event_type: "action.executed", payload: { action_id: "a" } };
  const verify = { event_type: "verification.completed", payload: { action_id: "a" } };
  assert.equal(productRepairProgress([execute, verify]).recovery_verified, true);
  assert.equal(productRepairProgress([{ event_type: "action.proposed", payload: { action_id: "rejected-proposal" } },
    execute, verify]).recovery_verified, true);
  for (const events of [[verify, execute], [execute],
    [execute, { ...verify, payload: { action_id: "other" } }],
    [execute, verify, { event_type: "rollback.executed", payload: { action_id: "a" } }],
    [execute, verify, { event_type: "verification.inconclusive", payload: { action_id: "a" } }]]) {
    assert.equal(productRepairProgress(events).recovery_verified, false);
  }
});

test("only explicitly rejected hypotheses with cited counter evidence become exclusions", () => {
  const hypothesis = { status: "rejected", cause: "service stopped", counter_evidence_ids: ["ev-health"] };
  assert.deepEqual(evidenceBoundExclusions([hypothesis], ["ev-health"], "agent-harness"), ["service stopped"]);
  assert.deepEqual(evidenceBoundExclusions([hypothesis], [], "agent-harness"), []);
  assert.deepEqual(evidenceBoundExclusions([{ ...hypothesis, status: "possible" }], ["ev-health"], "agent-harness"), []);
  assert.deepEqual(evidenceBoundExclusions([{ ...hypothesis, counter_evidence_ids: [] }], ["ev-health"], "agent-harness"), []);
});

test("approval maps identities only after verifying exact product ownership and Trial scope", () => {
  const ref = { identifier_domain: "opsmind-twin", namespace: "ns-a", resource_type: "service", resource_id: "amf" };
  const options = { tenantId: "product-tenant", evaluationTenant: "eval-tenant", trialId: "eval-trial", runRef: "inv-a",
    resourceScope: { namespace: "ns-a", resource_refs: [ref] } };
  const item = { action_id: "action-a", tenant_id: "product-tenant", trial_id: "eval-trial", investigation_id: "inv-a",
    proposal: { action_type: "network.restore_policy", target_entity_id: "exact-ref", proposal_digest: "a".repeat(64),
      scope: { tenant_id: "product-tenant", entity_ids: ["exact-ref"], resource_ref: ref } },
    environment_snapshot: { snapshot_digest: "b".repeat(64), shared_resource: false } };
  const request = boundActionApproval(item, options);
  assert.equal(request.scope.tenant_id, "eval-tenant");
  assert.equal(request.source_scope.tenant_id, "product-tenant");
  assert.deepEqual(item.proposal, request.proposal);
  assert.deepEqual(item.proposal.scope, request.source_scope);
  assert.equal(request.scope.shared_resource, false);
  assert.equal(boundActionApproval({ ...item,
    environment_snapshot: { ...item.environment_snapshot, shared_resource: true } }, options).scope.shared_resource, true);
  for (const patch of [{ tenant_id: "foreign" }, { trial_id: "foreign" }, { investigation_id: "foreign" },
    { environment_snapshot: {} }, { proposal: undefined },
    { proposal: { ...item.proposal, target_entity_id: "foreign" } },
    { proposal: { ...item.proposal, proposal_digest: "short" } },
    { proposal: { ...item.proposal, scope: { ...item.proposal.scope, tenant_id: "foreign" } } },
    { proposal: { ...item.proposal, scope: { ...item.proposal.scope,
      resource_ref: { ...ref, namespace: "foreign" } } } }]) {
    assert.throws(() => boundActionApproval({ ...item, ...patch }, options), /BINDING_MISMATCH/);
  }
  // Internal action rows must not silently act as the public evaluation contract.
  const { proposal, ...identity } = item;
  assert.throws(() => boundActionApproval({ ...identity, ...proposal }, options), /BINDING_MISMATCH/);
});
