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

test("Candidate Adapter 5.0在真实产品失败前仍先核验并落账原生Trial绑定", async () => {
  const base = connector("PRODUCT_NATIVE_ACK");
  const failed = { ...base, observe: async ({ runRef }) => ({ ...(await base.observe({ runRef })),
    status: "FAILED", error: { code: "BUDGET_EXCEEDED", message: "candidate exhausted frozen budget" },
    candidate_usage: { values: { model_calls: 16, tool_calls: 24 },
      observed_dimensions: ["model_calls", "tool_calls"], exhausted_dimensions: ["max_cost_microunits"],
      complete: false } }) };
  const emitted = [];
  const adapter = createCandidateAdapterV5({ id: "candidate", connector: failed, pollIntervalMs: 1 });
  await assert.rejects(adapter.execute({ executionContract: contract("PRODUCT_NATIVE_ACK"),
    emit: async (name, actor, payload) => emitted.push([name, actor, payload]) }), /BUDGET_EXCEEDED/);
  const binding = emitted.find(([name]) => name === "candidate.evaluation_binding.verified");
  assert.equal(binding?.[2].binding_strength, "PRODUCT_NATIVE_ACK");
});

test("Candidate Adapter 5.0在产品公开预算与部署声明漂移时阻止开考", async () => {
  const base = connector("PRODUCT_NATIVE_ACK");
  const drifted = { ...base,
    discover: async () => ({ candidate_kind: "REAL_PRODUCT", architecture: "EXTERNAL_PRODUCT",
      production_writes_available: false, health: { status: "healthy" }, native_run_context_supported: true,
      usage_observability: { complete: false }, ...FINGERPRINTS }),
    evaluationReadiness: async () => ({ identities_separated: true, tenant_bound: true, least_privilege: true,
      isolated_tenant_slots: 1, safe_parallelism: 1, external_twin_ready: true,
      budget_contract: { observable: true, max_run_ms: 900, native_enforcement: true,
        dimensions: { max_tool_calls: 24 }, deployment_declaration_matches: false } }),
  };
  const adapter = createCandidateAdapterV5({ id: "candidate", connector: drifted });
  const check = await adapter.preflight({ contestant: contract("PRODUCT_NATIVE_ACK").contestant,
    requiresTwin: true, budget: { wallclock_ms: 1000 } });
  assert.equal(check.ready, false);
  assert.equal(check.formal_ready, false);
  assert.ok(check.limitations.includes("candidate_budget_declaration_drift"));
  assert.equal(check.budget.native_enforcement, true);
  assert.equal(check.budget.deployment_declaration_matches, false);
});

test("Candidate Adapter 5.0不把仅公开数值但未原生强制的预算当作正式就绪", async () => {
  const base = connector("PRODUCT_NATIVE_ACK");
  const unnativelyBounded = { ...base,
    discover: async () => ({ candidate_kind: "REAL_PRODUCT", architecture: "EXTERNAL_PRODUCT",
      production_writes_available: false, health: { status: "healthy" }, native_run_context_supported: true,
      usage_observability: { complete: true }, ...FINGERPRINTS }),
    evaluationReadiness: async () => ({ identities_separated: true, tenant_bound: true, least_privilege: true,
      isolated_tenant_slots: 1, safe_parallelism: 1, external_twin_ready: true,
      budget_contract: { observable: true, max_run_ms: 900, native_enforcement: false,
        dimensions: { max_tool_calls: 24 }, deployment_declaration_matches: true } }),
  };
  const adapter = createCandidateAdapterV5({ id: "candidate", connector: unnativelyBounded });
  const check = await adapter.preflight({ contestant: contract("PRODUCT_NATIVE_ACK").contestant,
    requiresTwin: true, budget: { wallclock_ms: 1000 } });
  assert.equal(check.ready, true);
  assert.equal(check.formal_ready, false);
  assert.equal(check.readiness_status, "READY_WITH_LIMITATIONS");
  assert.ok(check.limitations.includes("candidate_budget_not_natively_enforced"));
});

test("Candidate Adapter 5.0逐维核对冻结预算，拒绝产品用更低原生上限静默截断校准", async () => {
  const base = connector("PRODUCT_NATIVE_ACK");
  const bounded = { ...base,
    discover: async () => ({ candidate_kind: "REAL_PRODUCT", architecture: "EXTERNAL_PRODUCT",
      production_writes_available: false, health: { status: "healthy" }, native_run_context_supported: true,
      usage_observability: { complete: true }, ...FINGERPRINTS }),
    evaluationReadiness: async () => ({ identities_separated: true, tenant_bound: true, least_privilege: true,
      isolated_tenant_slots: 1, safe_parallelism: 1, external_twin_ready: true,
      budget_contract: { observable: true, max_run_ms: 120000, native_enforcement: true,
        dimensions: { max_duration_seconds: 120, max_tool_calls: 20, max_model_calls: 10,
          max_tokens: 10000, max_cost_microunits: 500000, max_result_bytes: 4096 },
        deployment_declaration_matches: true } }),
  };
  const adapter = createCandidateAdapterV5({ id: "candidate", connector: bounded });
  const budget = { wallclock_ms: 120000, tool_calls: 24, model_calls: 10,
    input_tokens: 6000, output_tokens: 3000, cost_usd: 0.4, storage_bytes: 4096 };
  const check = await adapter.preflight({ contestant: contract("PRODUCT_NATIVE_ACK").contestant,
    requiresTwin: true, budget });
  assert.equal(check.ready, false);
  assert.equal(check.formal_ready, false);
  assert.equal(check.budget.dimension_alignment.aligned, false);
  assert.equal(check.budget.dimension_alignment.checks.max_tool_calls.aligned, false);
  assert.ok(check.limitations.includes("candidate_budget_would_be_clamped_by_product"));
});

test("Candidate Adapter 5.0按不可变source_ref去重轮询重放且拒绝证据漂移", async () => {
  let poll = 0;
  const base = connector();
  const replaying = { ...base, observe: async ({ runRef }) => {
    poll += 1;
    const terminal = poll > 1;
    return { run_ref: runRef, status: terminal ? "COMPLETED" : "RUNNING", next_cursor: poll,
      raw_events: [
        { source_ref: "raw:stable", source_system: "product", payload: { value: 1 } },
        ...(terminal ? [{ source_ref: "raw:terminal", source_system: "product", payload: { value: 2 } }] : []),
      ],
      normalized_events: [
        { event_type: "evidence.collected", actor: "product", status: "OK",
          raw_source_refs: ["raw:stable"], payload: { value: 1 } },
        ...(terminal ? [{ event_type: "conclusion.recorded", actor: "product", status: "OK",
          raw_source_refs: ["raw:terminal"], payload: { value: 2 } }] : []),
      ],
      ...(terminal ? {
        evaluation_binding: { contract: "evalos-product-run-binding.3", complete: true,
          binding_strength: "EVIDENCE_CHAIN_BOUND", expected_context_digest: `sha256:${"5".repeat(64)}`,
          native_conformance: { mismatches: [] }, evidence_chain: { mismatches: [] } },
        product_evidence: base.observe ? (await base.observe({ runRef })).product_evidence : null,
        candidate_usage: { values: { tool_calls: 1 }, observed_dimensions: ["tool_calls"], complete: false },
        outcome: { status: "resolved", root_cause: "public-confirmed-root-cause", evidence_refs: ["evidence:1"] },
      } : {}),
    };
  } };
  const emitted = [];
  const adapter = createCandidateAdapterV5({ id: "candidate", connector: replaying, pollIntervalMs: 1 });
  await adapter.execute({ executionContract: contract(), emit: async (name, actor, payload) => emitted.push([name, actor, payload]) });
  assert.equal(emitted.filter(([name]) => name === "candidate.raw_event").length, 2);
  assert.equal(emitted.filter(([name]) => name === "evidence.collected").length, 1);
  assert.equal(emitted.filter(([name]) => name === "conclusion.recorded").length, 1);

  let driftPoll = 0;
  const drifting = { ...base, observe: async ({ runRef }) => {
    driftPoll += 1;
    return { run_ref: runRef, status: driftPoll > 1 ? "FAILED" : "RUNNING", next_cursor: driftPoll,
      raw_events: [{ source_ref: "raw:changed", source_system: "product", payload: { value: driftPoll } }],
      normalized_events: [{ event_type: "evidence.collected", actor: "product", status: "OK",
        raw_source_refs: ["raw:changed"], payload: { value: driftPoll } }],
      error: { code: "fixture", message: "fixture" } };
  } };
  const driftAdapter = createCandidateAdapterV5({ id: "candidate", connector: drifting, pollIntervalMs: 1 });
  await assert.rejects(driftAdapter.execute({ executionContract: contract(), emit: async () => {} }),
    /candidate raw evidence changed after publication/);
});
