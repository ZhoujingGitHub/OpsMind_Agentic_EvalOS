import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createAgentHarnessProductConnectorV5, createLangGraphProductConnectorV5 } from "../src/index.mjs";

const ATTESTATION = Object.freeze({ source_revision: "abcdef1234567890",
  artifact_digest: `sha256:${"a".repeat(64)}` });

async function fixtureServer(routes) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization,
      tenantId: request.headers["x-tenant-id"], body });
    const key = `${request.method} ${new URL(request.url, "http://fixture").pathname}`;
    const handler = routes[key];
    const payload = handler ? await handler({ request, body }) : { detail: "not found" };
    response.writeHead(handler ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

function executionContract(id, candidateRuntime) {
  return { execution_mode: "controlled_simulation", evaluation_lane: "PRODUCT_RELIABILITY",
    model: { provider: "deepseek", id: "deepseek-v4-flash", sdk: "@anthropic-ai/claude-agent-sdk" },
    budget: { input_tokens: 120000, output_tokens: 32768, model_calls: 32, tool_calls: 24,
      wallclock_ms: 3000000, compute_ms: 3000000, storage_bytes: 10485760, cost_usd: 1 },
    tools: [], policy: {}, frozen_dependencies: {}, dataset_ref: "dataset@1", suite_ref: "suite@1",
    trial: { id, case_ref: "HIDDEN-CASE@1", environment_seed: 918273, replicate_id: 1 },
    contestant: { candidate_runtime: candidateRuntime },
    case: { goal: "普通运维用户看到业务访问失败，请调查", visible: { operating_mode: "diagnosis_only",
      time_window: "trial-relative", scope: { resource_ids: ["ue-public-1"], service_ids: ["mec-public-1"] } } } };
}

test("Adapter 5 Agent+Harness连接器发送原生预算并核验产品回执与显式未知用量", async (t) => {
  let sourceRef = null;
  let runContext = null;
  let budgetAckOverride = null;
  let conclusionStatus = "confirmed";
  let investigationStatus = "resolved";
  let usageExhausted = [];
  const fixture = await fixtureServer({
    "GET /v2/auth/me": async ({ request }) => request.headers.authorization === "Bearer submitter"
      ? { user_id: "submitter", tenant_id: "tenant-ah", permissions: { investigate: true } }
      : request.headers.authorization === "Bearer approver"
        ? { user_id: "approver", tenant_id: "tenant-ah", permissions: { approve_action: true } }
        : { user_id: "administrator", tenant_id: "tenant-ah", permissions: { manage_roles: true } },
    "GET /v2/protocol-lab": async () => ({ configured: true, connected: true, slot_id: "slot-ah" }),
    "GET /v2/capabilities": async () => ({ service_version: "5.0", investigation_schema_version: "5.0",
      report_delivery_contract_version: "opsmind-report-delivery/2.0",
      protocol_tool_loading: { contract_version: "opsmind-protocol-tool-loading/1.0",
        always_loaded: ["publish_investigation_progress", "submit_investigation_report"],
        tool_search_required: false },
      identifier_scope_contract: { contract_version: "opsmind-identifier-scope/1.0",
        scope_enforcement: "server_injected_narrowest_scope",
        unresolved_behavior: "structured_coverage_no_tenant_fallback",
        exact_lookup_semantics: "no_alias_or_similarity_mapping" },
      native_tool_availability: { contract_version: "opsmind-native-tool-availability/1.0",
        available: ["Read", "Glob", "Grep", "Write", "Edit", "WebSearch", "WebFetch", "Skill", "ToolSearch"],
        unavailable: { Bash: { status: "unavailable", reason_code: "SDK_SANDBOX_PROC_MOUNT_NOT_PERMITTED",
          sandbox_required: true, unsafe_fallback_allowed: false } } },
      protocol_lab_binding_contract_version: "2.0", native_run_context_supported: true,
      run_context_contract_version: "opsmind-run-context/1.0",
      run_budget_contract_version: "opsmind-run-budget/1.0",
      run_usage_contract_version: "opsmind-run-usage/1.0" }),
    "GET /v2/investigation-runtime": async () => ({ sdk_execution_api: "claude-agent-sdk-query",
      execution_mode: "agent-loop", model: "deepseek-v4-flash", thinking_mode: "high", reasoning_effort: "max",
      native_run_context_supported: true, run_context_contract_version: "opsmind-run-context/1.0",
      run_budget_contract_version: "opsmind-run-budget/1.0", run_usage_contract_version: "opsmind-run-usage/1.0",
      product_budget_limits: { max_duration_seconds: 2700, max_tool_calls: 128, max_model_calls: 32,
        max_tokens: 1000000, max_cost_microunits: 1000000, max_result_bytes: 8388608 } }),
    "GET /v2/model-profile": async () => ({ provider: "deepseek", model: "deepseek-v4-flash",
      protocol: "anthropic-compatible", thinking_mode: "high", roles: ["investigation"] }),
    "GET /health": async () => ({ status: "healthy", version: "5.0", model: "deepseek-v4-flash" }),
    "GET /v2/remediation/context": async () => ({ safety_framework_version: "2.0" }),
    "PUT /v2/remediation/mode": async ({ body }) => body,
    "POST /v2/investigation-candidates": async ({ body }) => { sourceRef = body.source_ref; runContext = body.run_context; return {
      candidate: { candidate_id: "candidate-ah", linked_investigation_id: "run-ah" } }; },
    "GET /v2/investigation-candidates": async () => ({ items: [{ candidate_id: "candidate-ah",
      linked_investigation_id: "run-ah", source_ref: sourceRef, run_context: runContext,
      run_context_ack: { native: true, contract_version: "opsmind-run-context/1.0",
        budget_contract_version: "opsmind-run-budget/1.0", actual_budget: budgetAckOverride ?? runContext?.budget } }] }),
    "GET /v2/investigations/run-ah": async () => ({ status: investigationStatus, candidate_id: "candidate-ah",
      run_context: runContext, run_context_ack: { native: true, contract_version: "opsmind-run-context/1.0",
        budget_contract_version: "opsmind-run-budget/1.0", usage_contract_version: "opsmind-run-usage/1.0",
        actual_budget: budgetAckOverride ?? runContext?.budget }, usage: { contract_version: "opsmind-run-usage/1.0", tool_calls: 2,
        model_calls: { status: "known", value: 4 }, tokens: { status: "unknown", value: null },
        input_tokens: { status: "unknown", value: null }, output_tokens: { status: "unknown", value: null },
        cost_microunits: { status: "known", value: 250000 }, result_bytes: 2048,
        exhausted: usageExhausted }, tool_calls: [], report: {
        summary: "确认UE路由缺失", conclusion_status: conclusionStatus,
        hypotheses: [{ cause: "ue-route-missing", status: "leading", confidence: 0.91,
          supporting_evidence_ids: ["evidence:ah"] }],
        evidence_gate: { effective_conclusion_status: conclusionStatus, passed: true },
        evidence_ids: ["evidence:ah"], delivery_receipt: { delivery_id: "delivery-ah", status: "accepted" } },
      evidence: [{ evidence_id: "evidence:ah", source_ref: "mcp:probe_sctp_association",
        raw_value_json: { records: [{ evidence_refs: ["probe:sctp-38412-refused"], accepted: false }] } }] }),
    "GET /v2/investigations/run-ah/execution-log": async ({ request }) => {
      const query = new URL(request.url, "http://fixture").searchParams;
      assert.equal(query.get("limit"), "1000");
      const items = [
        { sequence: 1, event_type: "candidate.accepted" }, { sequence: 2, event_type: "worker.started" },
        { sequence: 3, event_type: "evidence.persisted" }, { sequence: 4, event_type: "audit.recorded" },
        { sequence: 5, event_type: "tool.called", payload: { id: "tool-1" } },
        { sequence: 6, event_type: "tool.called", payload: { id: "tool-2" } },
        { sequence: 7, event_type: "report.delivery.completed" },
        ...(investigationStatus === "failed" ? [{ sequence: 8, event_type: "agent.result_received",
          payload: { subtype: "error_max_budget_usd", is_error: true, stop_reason: "tool_use" } },
        { sequence: 9, event_type: "investigation.failed", payload: { status: "failed" } }] : []),
      ];
      return { next_sequence: items.at(-1).sequence, items };
    },
    "GET /v2/actions": async () => ({ items: [] }),
    "POST /v2/investigations/run-ah/protocol-lab/reset": async () => ({ ok: true, clean: true }),
  });
  t.after(fixture.close);
  const connector = createAgentHarnessProductConnectorV5({ origin: fixture.origin, token: "submitter",
    approvalToken: "approver", adminToken: "administrator", tenantId: "tenant-ah", attestation: ATTESTATION });
  const discovery = await connector.discover();
  assert.equal(discovery.candidate_runtime.models[0].thinking, "enabled");
  assert.equal(discovery.candidate_runtime.versions.protocol_tool_loading,
    "opsmind-protocol-tool-loading/1.0");
  assert.equal(discovery.candidate_runtime.versions.identifier_scope,
    "opsmind-identifier-scope/1.0");
  assert.equal(discovery.candidate_runtime.versions.native_tool_availability,
    "opsmind-native-tool-availability/1.0");
  assert.equal(discovery.native_run_context_supported, true);
  const readiness = await connector.evaluationReadiness();
  assert.equal(readiness.budget_contract.native_enforcement, true);
  assert.equal(readiness.budget_contract.max_run_ms, 2700000);
  assert.equal(readiness.budget_contract.dimensions.max_result_bytes, 8388608);
  assert.equal(readiness.budget_contract.deployment_declaration_matches, true);
  const contract = executionContract("evalos-ah-1", discovery.candidate_runtime);
  await connector.prepare({ executionContract: contract });
  const started = await connector.start({ executionContract: contract });
  assert.match(runContext.context_digest, /^[a-f0-9]{64}$/);
  assert.equal(runContext.runtime_version, "5.0");
  assert.deepEqual(runContext.budget, { max_duration_seconds: 2700, max_tool_calls: 24, max_model_calls: 32,
    max_tokens: 152768, max_cost_microunits: 1000000, max_result_bytes: 8388608 });
  assert.equal(JSON.stringify(runContext).includes("HIDDEN-CASE"), false);
  assert.equal(JSON.stringify(runContext).includes("918273"), false);
  assert.equal(JSON.stringify(runContext).toLowerCase().includes("grader"), false);
  const observation = await connector.observe({ runRef: started.run_ref, cursor: 0, executionContract: contract });
  assert.equal(observation.status, "COMPLETED");
  assert.equal(observation.evaluation_binding.binding_strength, "PRODUCT_NATIVE_ACK");
  assert.equal(observation.evaluation_binding.complete, true);
  assert.equal(observation.outcome.root_cause, "ue-route-missing");
  assert.equal(observation.outcome.evidence_gate_passed, true);
  assert.equal(observation.candidate_usage.measurement_status, "PARTIAL");
  assert.deepEqual(observation.candidate_usage.values,
    { model_calls: 4, tool_calls: 2, storage_bytes: 2048, cost_usd: 0.25 });
  assert.equal(observation.product_evidence.recovery.applicable, false);
  assert.match(observation.product_evidence.queue.ref, /^agent-harness:/);
  assert.deepEqual(observation.artifact_refs, ["agent-harness:report-delivery:delivery-ah"]);
  const frozenEvidence = observation.raw_events.find((item) =>
    item.source_ref === "agent-harness:evidence:run-ah:evidence:ah");
  assert.equal(frozenEvidence.payload.evidence_id, "evidence:ah");
  assert.deepEqual(frozenEvidence.payload.raw_value_json.records[0].evidence_refs,
    ["probe:sctp-38412-refused"]);
  assert.match(frozenEvidence.payload_digest, /^sha256:[a-f0-9]{64}$/);
  budgetAckOverride = { ...runContext.budget, max_tool_calls: runContext.budget.max_tool_calls + 1 };
  const drifted = await connector.observe({ runRef: started.run_ref, cursor: 0, executionContract: contract });
  assert.equal(drifted.evaluation_binding.binding_strength, "UNBOUND");
  assert.deepEqual(drifted.evaluation_binding.native_conformance.mismatches, ["budget"]);
  budgetAckOverride = null;
  conclusionStatus = "possible";
  const possible = await connector.observe({ runRef: started.run_ref, cursor: 0, executionContract: contract });
  assert.equal(possible.outcome.status, "inconclusive");
  assert.equal(possible.outcome.root_cause, null);
  investigationStatus = "failed";
  usageExhausted = ["max_cost_microunits", "max_tool_calls"];
  const exhausted = await connector.observe({ runRef: started.run_ref, cursor: 0, executionContract: contract });
  assert.equal(exhausted.status, "FAILED");
  assert.equal(exhausted.error.code, "BUDGET_EXCEEDED");
  assert.match(exhausted.error.message, /max_cost_microunits/);
  assert.deepEqual(exhausted.candidate_usage.exhausted_dimensions,
    ["max_cost_microunits", "max_tool_calls"]);
  const finalized = await connector.finalize({ runRef: started.run_ref });
  assert.equal(finalized.candidate_reset, true);
  assert.equal(finalized.evalos_authoritative_reset_pending, true);
});

test("Adapter 5 Agent+Harness模式管理员必须具备产品切换模式所需的精确权限", async (t) => {
  const fixture = await fixtureServer({
    "GET /v2/auth/me": async ({ request }) => request.headers.authorization === "Bearer submitter"
      ? { user_id: "submitter", tenant_id: "tenant-ah", permissions: { investigate: true } }
      : request.headers.authorization === "Bearer approver"
        ? { user_id: "approver", tenant_id: "tenant-ah", permissions: { approve_action: true } }
        : { user_id: "administrator", tenant_id: "tenant-ah", permissions: { manage_users: true } },
    "GET /v2/protocol-lab": async () => ({ configured: true, connected: true, slot_id: "slot-ah" }),
    "GET /v2/capabilities": async () => ({ native_run_context_supported: true,
      run_context_contract_version: "opsmind-run-context/1.0", run_budget_contract_version: "opsmind-run-budget/1.0",
      run_usage_contract_version: "opsmind-run-usage/1.0" }),
    "GET /v2/investigation-runtime": async () => ({ native_run_context_supported: true,
      run_context_contract_version: "opsmind-run-context/1.0", run_budget_contract_version: "opsmind-run-budget/1.0",
      run_usage_contract_version: "opsmind-run-usage/1.0", product_budget_limits: { max_duration_seconds: 2700,
        max_tool_calls: 128, max_model_calls: 32, max_tokens: 1000000, max_cost_microunits: 1000000,
        max_result_bytes: 8388608 } }),
  });
  t.after(fixture.close);
  const connector = createAgentHarnessProductConnectorV5({ origin: fixture.origin, token: "submitter",
    approvalToken: "approver", adminToken: "administrator", tenantId: "tenant-ah", attestation: ATTESTATION });
  const readiness = await connector.evaluationReadiness();
  assert.equal(readiness.credential_checks.administrator_authorized, false);
  assert.equal(readiness.least_privilege, false);
});

test("Adapter 5 LangGraph连接器发送不透明run_context并等待Job、归档和外部清场交接", async (t) => {
  let runContext = null;
  const modelPortfolio = [
    { provider: "deepseek", model_id: "deepseek-v4-flash", interface: "anthropic", thinking: "disabled", roles: ["reason", "tool_selection"] },
    { provider: "deepseek", model_id: "deepseek-v4-pro", interface: "openai-chat", thinking: "high", roles: ["revise", "adjudicate"] },
  ];
  const publicEvents = [
    { cursor: 1, schema_version: "opsmind-public-event:1.0", event_type: "job.accepted" },
    { cursor: 2, schema_version: "opsmind-public-event:1.0", event_type: "worker.started" },
    { cursor: 3, schema_version: "opsmind-public-event:1.0", event_type: "agent_trace", public_payload: { stage: "reason", output_snapshot: {
      model_id: "deepseek-v4-flash", input_tokens: 1000, output_tokens: 120, latency_ms: 900,
      reasoning_mode: "native_tool", stop_reason: "tool_use", response_format: "anthropic", json_valid: true } } },
    { cursor: 4, schema_version: "opsmind-public-event:1.0", event_type: "agent_trace", public_payload: { stage: "adjudicate", output_snapshot: {
      model_id: "deepseek-v4-pro", input_tokens: 4000, output_tokens: 700, latency_ms: 80000,
      reasoning_mode: "deep", stop_reason: "stop", response_format: "json", json_valid: true } } },
    { cursor: 5, schema_version: "opsmind-public-event:1.0", event_type: "action.status_changed",
      actor_id: "external-cleanup-handoff", public_payload: { cleanup_owner: "external_controller" } },
    { cursor: 6, schema_version: "opsmind-public-event:1.0", event_type: "archive.reconciled" },
  ];
  const terminalJournalEvents = publicEvents.map((event) => ({ ...event, cursor: event.cursor + 1000 }));
  const fixture = await fixtureServer({
    "GET /api/v1/me": async ({ request }) => request.headers.authorization === "Bearer submitter"
      ? { subject: "submitter", roles: ["on_call"], tenant_ids: ["tenant-lg"] }
      : request.headers.authorization === "Bearer approver"
        ? { subject: "approver", roles: ["approver"], tenant_ids: ["tenant-lg"] }
        : { subject: "administrator", roles: ["tenant_admin"], tenant_ids: ["tenant-lg"] },
    "GET /health/ready": async () => ({ ready: true, status: "healthy", architecture_type: "langgraph",
      model_portfolio: modelPortfolio,
      connectors: [{ connector_id: "open5gs-ueransim-protocol-lab", status: "healthy" }] }),
    "GET /api/v1/automation/overview": async () => ({ graph_version: "opsmind-langgraph:5.0.0",
      state_schema_version: "graph-state:5.0.0", model_portfolio: modelPortfolio,
      mcp_contract_version: "observation+protocol-lab:3.2.0", knowledge_version: "knowledge:5.0.0",
      model_version: "deepseek-v4-flash+deepseek-v4-pro",
      product_e2e_contract_version: "opsmind-controlled-remediation:1.1",
      public_event_schema_version: "opsmind-public-event:1.0" }),
    "PUT /api/v1/automation/mode": async ({ body }) => body,
    "POST /api/v1/candidates": async ({ body }) => { runContext = body.run_context;
      return { investigation: { investigation_id: "run-lg" }, job: { job_id: "job-lg" } }; },
    "GET /api/v1/investigations/run-lg": async () => ({ status: "completed", budget_usage: {
      input_tokens: 5000, output_tokens: 820, model_calls: 2, tool_calls: 6, result_bytes: 12345,
      cost_microunits: 200000 } }),
    "GET /api/v1/investigations/run-lg/journal": async ({ request }) => {
      const query = new URL(request.url, "http://fixture").searchParams;
      assert.equal(query.get("limit"), "1000");
      const cursor = Number(query.get("after_cursor"));
      if (cursor === 0) return { next_cursor: 1000, items: Array.from({ length: 1000 }, (_, index) => ({
        cursor: index + 1, schema_version: "opsmind-public-event:1.0", event_type: "evidence.persisted" })) };
      return { next_cursor: 1006, has_more: false, items: terminalJournalEvents };
    },
    "GET /api/v1/investigations/run-lg/product-e2e": async () => ({
      contract_version: "opsmind-controlled-remediation:1.1", trial_id: runContext?.trial_id,
      run_context_digest: runContext?.context_digest, run_contract_version: runContext?.contract_version,
      evaluation_budget: runContext?.budget, task_result: { outcome: "root_cause_confirmed", root_cause: "ue-route-missing",
        root_cause_confidence: 0.85, summary: "确认UE路由缺失" }, root_cause: "ue-route-missing",
      root_cause_confidence: 0.85, graph_version: "opsmind-langgraph:5.0.0",
      state_schema_version: "graph-state:5.0.0", mcp_contract_version: "observation+protocol-lab:3.2.0",
      knowledge_version: "knowledge:5.0.0", model_version: "deepseek-v4-flash+deepseek-v4-pro",
      evidence_gate: { status: "confirmed", passed: true }, evidence: [{ id: "evidence:lg" }],
      budget_usage: { input_tokens: 5000, output_tokens: 820, model_calls: 2, tool_calls: 6,
        result_bytes: 12345, cost_microunits: 200000 }, public_events: publicEvents, archive_reconciled: true,
      archive_artifacts: [{ uri: "oss://langgraph/archive-lg.json" }] }),
    "GET /api/v1/jobs": async () => ({ items: [{ job_id: "job-lg", investigation_id: "run-lg", status: "completed" }] }),
  });
  t.after(fixture.close);
  const declaredRuntime = { contract_version: "1.0", models: [
    { provider: "deepseek", id: "deepseek-v4-flash", interface: "anthropic", thinking: "disabled",
      roles: ["reason", "tool_selection"] },
    { provider: "deepseek", id: "deepseek-v4-pro", interface: "openai-chat", thinking: "enabled",
      roles: ["revise", "adjudicate"] },
  ], versions: { graph_version: "opsmind-langgraph:5.0.0", state_schema_version: "graph-state:5.0.0",
    mcp_contract_version: "observation+protocol-lab:3.2.0", knowledge_version: "knowledge:5.0.0",
    model_version: "deepseek-v4-flash+deepseek-v4-pro",
    product_e2e_contract_version: "opsmind-controlled-remediation:1.1",
    public_event_schema_version: "opsmind-public-event:1.0" } };
  const connector = createLangGraphProductConnectorV5({ origin: fixture.origin, token: "submitter",
    approvalToken: "approver", adminToken: "administrator", tenantId: "tenant-lg", attestation: ATTESTATION,
    declaredCandidateRuntime: declaredRuntime });
  const discovery = await connector.discover();
  assert.deepEqual(discovery.candidate_runtime, declaredRuntime);
  assert.deepEqual(discovery.candidate_runtime.models.map((item) => item.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(discovery.candidate_runtime.models[1].thinking, "enabled");
  const drifted = createLangGraphProductConnectorV5({ origin: fixture.origin, token: "submitter",
    approvalToken: "approver", adminToken: "administrator", tenantId: "tenant-lg", attestation: ATTESTATION,
    declaredCandidateRuntime: { ...declaredRuntime, models: declaredRuntime.models.slice(0, 1) } });
  await assert.rejects(drifted.discover(), /declared LangGraph candidate_runtime/);
  const contract = executionContract("evalos-lg-1", discovery.candidate_runtime);
  await connector.prepare({ executionContract: contract });
  const started = await connector.start({ executionContract: contract });
  assert.equal(Object.hasOwn(runContext, "case_id"), false);
  assert.equal(Object.hasOwn(runContext, "seed"), false);
  assert.deepEqual(Object.keys(runContext.budget).sort(), ["max_cost_microunits", "max_duration_seconds",
    "max_model_calls", "max_result_bytes", "max_tokens", "max_tool_calls"]);
  assert.ok(Object.keys(runContext.runtime_versions).every((name) => ["graph_version", "state_schema_version",
    "mcp_contract_version", "knowledge_version", "model_version", "product_e2e_contract_version",
    "public_event_schema_version"].includes(name)));
  assert.equal(JSON.stringify(runContext).includes("HIDDEN-CASE"), false);
  assert.equal(JSON.stringify(runContext).includes("918273"), false);
  const observation = await connector.observe({ runRef: started.run_ref, cursor: 1, executionContract: contract });
  assert.equal(observation.status, "COMPLETED");
  assert.equal(observation.evaluation_binding.binding_strength, "PRODUCT_NATIVE_ACK");
  assert.equal(observation.outcome.root_cause, "ue-route-missing");
  assert.equal(observation.candidate_usage.complete, true);
  assert.equal(observation.candidate_usage.by_model["deepseek-v4-flash"].input_tokens, 1000);
  assert.equal(observation.candidate_usage.by_model["deepseek-v4-pro"].output_tokens, 700);
  assert.deepEqual(observation.artifact_refs, ["oss://langgraph/archive-lg.json"]);
  const journalQueries = fixture.requests.filter((item) => item.url.startsWith("/api/v1/investigations/run-lg/journal"))
    .map((item) => new URL(item.url, "http://fixture").searchParams);
  assert.deepEqual(journalQueries.map((query) => query.get("after_cursor")), ["1", "0", "1000"]);
  assert.ok(journalQueries.every((query) => query.get("limit") === "1000"));
  const finalized = await connector.finalize({ runRef: started.run_ref });
  assert.equal(finalized.cleanup_owner, "external_controller");
  assert.equal(finalized.candidate_reset, false);
  assert.equal(finalized.cleanup_handoff_verified, true);
});

test("Adapter 5 LangGraph连接器以Jobs dead_letter覆盖仍显示running的调查状态", async (t) => {
  const fixture = await fixtureServer({
    "GET /api/v1/investigations/run-dead": async () => ({ status: "running" }),
    "GET /api/v1/investigations/run-dead/journal": async () => ({ next_cursor: 2,
      items: [{ cursor: 2, event_type: "job.dead_letter", payload: { error_type: "DeepSeekModelError" } }] }),
    "GET /api/v1/investigations/run-dead/product-e2e": async () => ({ public_events: [] }),
    "GET /api/v1/jobs": async () => ({ items: [{ job_id: "job-dead", investigation_id: "run-dead",
      status: "dead_letter", error_code: "DeepSeekModelError", error_message: "no public decision" }] }),
  });
  t.after(fixture.close);
  const connector = createLangGraphProductConnectorV5({ origin: fixture.origin, token: "submitter",
    approvalToken: "approver", adminToken: "administrator", tenantId: "tenant-lg", attestation: ATTESTATION });
  const contract = executionContract("evalos-lg-dead", { contract_version: "1.0", models: [{ provider: "deepseek",
    id: "deepseek-v4-pro", interface: "openai-chat", thinking: "enabled", roles: ["adjudicate"] }],
  versions: { graph: "5.0.0" } });
  const observation = await connector.observe({ runRef: "run-dead", cursor: 0, executionContract: contract });
  assert.equal(observation.status, "FAILED");
  assert.equal(observation.error.code, "DeepSeekModelError");
  assert.equal(observation.error.message, "no public decision");
  assert.equal(observation.candidate_usage.complete, false);
  assert.deepEqual(observation.candidate_usage.incomplete_model_attempt_refs, [2]);
});
