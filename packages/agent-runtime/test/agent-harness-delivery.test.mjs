import test from "node:test";
import assert from "node:assert/strict";
import { agentHarnessRepairPending } from "../src/product-connectors-v5.mjs";

const detail = (actions, pending = false) => ({ repair_delivery: {
  contract_version: "opsmind-repair-delivery/1.1", source: "action_ledger", actions, pending,
} });
test("report completion cannot finish an AH run with pending approval or a mismatched action snapshot", () => {
  assert.equal(agentHarnessRepairPending(detail([], false), []), false);
  assert.equal(agentHarnessRepairPending(detail([{ action_id: "a", pending: true }], true),
    [{ action_id: "a", status: "human_required" }]), true);
  assert.equal(agentHarnessRepairPending(detail([], false), [{ action_id: "a", status: "verified_effective" }]), true);
  assert.equal(agentHarnessRepairPending(detail([{ action_id: "a", pending: false }]),
    [{ action_id: "a", status: "human_takeover" }]), false);
  assert.throws(() => agentHarnessRepairPending({ status: "resolved" }, []), /CONTRACT_MISSING/);
});
