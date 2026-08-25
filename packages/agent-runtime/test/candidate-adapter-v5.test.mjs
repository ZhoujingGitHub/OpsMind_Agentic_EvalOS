import assert from "node:assert/strict";
import test from "node:test";
import { CANDIDATE_ADAPTER_V5_RUNTIME, createCandidateAdapterV5 } from "../src/index.mjs";

const FINGERPRINTS = Object.freeze({
  source_revision: "abcdef1234567",
  artifact_digest: `sha256:${"1".repeat(64)}`,
  runtime_digest: `sha256:${"2".repeat(64)}`,
  runtime_manifest_digest: `sha256:${"3".repeat(64)}`,
  capability_contract_digest: `sha256:${"4".repeat(64)}`,
});

function contract(bindingRequirement = "EVIDENCE_CHAIN_BOUND") {
  return { run_class: "REAL_CANDIDATE", evaluation_lane: "PRODUCT_RELIABILITY",
    trial: { id: "trial-v5" }, contestant: { ref: "candidate", kind: "REAL_PRODUCT",
      architecture: "EXTERNAL_PRODUCT", binding_requirement: bindingRequirement, ...FINGERPRINTS },
    budget: { wallclock_ms: 1000 } };
}

function connector(bindingStrength = "EVIDENCE_CHAIN_BOUND") {
  return { kind: "fixture-product-v5",
    discover: async () => ({ candidate_kind: "REAL_PRODUCT", architecture: "EXTERNAL_PRODUCT",
      production_writes_available: false, ...FINGERPRINTS }),
    start: async () => ({ run_ref: "external:v5", status: "RUNNING" }),
    observe: async ({ runRef }) => ({ run_ref: runRef, status: "COMPLETED", next_cursor: 1,
      raw_events: [{ source_ref: "raw:v5", source_system: "product", payload: { status: "completed" } }],
      normalized_events: [{ event_type: "conclusion.recorded", actor: "product", status: "OK",
        raw_source_refs: ["raw:v5"], payload: {} }],
      evaluation_binding: { contract: "evalos-product-run-binding.3", complete: true,
        binding_strength: bindingStrength, expected_context_digest: `sha256:${"5".repeat(64)}`,
        native_conformance: { mismatches: [] }, evidence_chain: { mismatches: [] } },
      product_evidence: {
        queue: { applicable: true, recorded: true, ref: "raw:queue" },
        worker: { applicable: true, recorded: true, ref: "raw:worker" },
        recovery: { applicable: false, recorded: false, ref: "" },
        persistence: { applicable: true, recorded: true, ref: "raw:persistence" },
        audit: { applicable: true, recorded: true, ref: "raw:audit" },
        archive: { applicable: true, recorded: true, ref: "raw:archive" },
      },
      candidate_usage: { values: { model_calls: 2 }, complete: false },
      outcome: { status: "resolved", root_cause: "public-confirmed-root-cause", evidence_refs: ["evidence:1"] } }),
    cancel: async () => ({ supported: false }),
    finalize: async ({ runRef }) => ({ ok: true, run_ref: runRef, cleanup_owner: "external_controller",
      candidate_reset: false, evalos_authoritative_reset_pending: true }),
  };
}

test("Candidate Adapter 5.0接受真实证据链绑定，且无失败时恢复证据明确不适用", async () => {
  const adapter = createCandidateAdapterV5({ id: "candidate", connector: connector(), pollIntervalMs: 1 });
  const result = await adapter.execute({ executionContract: contract(), emit: async () => {} });
  assert.equal(result.status, "resolved");
  assert.equal(result.evaluation_binding.binding_strength, "EVIDENCE_CHAIN_BOUND");
  assert.equal(result.product_evidence.recovery.applicable, false);
  assert.equal(result.__evalos_usage.complete, false);
  assert.equal(adapter.adapterContractVersion, "5.0");
  assert.ok(CANDIDATE_ADAPTER_V5_RUNTIME.forbidden.includes("send-hidden-case-or-seed"));
});

test("Candidate Adapter 5.0拒绝本地提交回执冒充产品绑定，也执行每考生冻结的强度门槛", async () => {
  const receiptOnly = createCandidateAdapterV5({ id: "candidate", connector: connector("CONTROL_PLANE_RECEIPT"),
    pollIntervalMs: 1 });
  await assert.rejects(receiptOnly.execute({ executionContract: contract(), emit: async () => {} }),
    /not bound to the frozen Trial context: CONTROL_PLANE_RECEIPT/);

  const nativeRequired = createCandidateAdapterV5({ id: "candidate", connector: connector("EVIDENCE_CHAIN_BOUND"),
    pollIntervalMs: 1 });
  await assert.rejects(nativeRequired.execute({ executionContract: contract("PRODUCT_NATIVE_ACK"), emit: async () => {} }),
    /not bound to the frozen Trial context: EVIDENCE_CHAIN_BOUND/);
});
