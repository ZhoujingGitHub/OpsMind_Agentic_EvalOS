import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createAgentHarnessProductConnector, createLangGraphProductConnector } from "../src/index.mjs";

const ATTESTATION = Object.freeze({
  source_revision: "abcdef1234567890",
  artifact_digest: `sha256:${"a".repeat(64)}`,
});

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
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("Agent+Harness连接器只通过真实产品API提交任务并保留原始证据", async (t) => {
  let submittedGoal = "";
  const fixture = await fixtureServer({
    "GET /v2/auth/me": async ({ request }) => request.headers.authorization === "Bearer fixture-token"
      ? { user_id: "eval-submitter", tenant_id: "tenant-eval-harness", permissions: { investigate: true } }
      : request.headers.authorization === "Bearer approval-token"
        ? { user_id: "eval-approver", tenant_id: "tenant-eval-harness", permissions: { approve_action: true } }
        : { user_id: "eval-administrator", tenant_id: "tenant-eval-harness", permissions: { manage_roles: true } },
    "GET /v2/evaluation/controlled-remediation-contract": async () => ({ contract: "controlled-remediation.1", operating_modes: ["diagnosis_only", "human_collaboration", "controlled_auto"] }),
    "GET /v2/investigation-runtime": async () => ({ runtime: "claude-agent-sdk", model: "deepseek-v4-flash" }),
    "GET /v2/remediation/context": async () => ({ execution_environment: "controlled_simulation", production_writes_available: false }),
    "PUT /v2/remediation/mode": async ({ body }) => ({ ...body, production_writes_available: false }),
    "POST /v2/investigation-candidates": async ({ body }) => { submittedGoal = body.goal; return { investigation_id: "harness-run" }; },
    "GET /v2/investigations/harness-run": async () => ({ status: "resolved", objective: submittedGoal,
      usage: { input_tokens: 640, output_tokens: 96, model_calls: 3, result_bytes: 4096, cost_microunits: 25000 },
      tool_calls: [{ tool: "query_logs" }, { tool: "query_metrics" }],
      report: { summary: "AMF服务停止", evidence_ids: ["evidence:h1"], missing_evidence: ["复核AMF启动状态"] },
      hypotheses: [
        { cause: "amf-service-stopped", confidence: 0.87, status: "leading", supporting_evidence_ids: ["evidence:h1"] },
        { cause: "数据库故障", confidence: 0.1, status: "rejected", counter_evidence_ids: ["evidence:h1"] },
      ],
      evidence: [{ evidence_id: "evidence:h1" }] }),
    "GET /v2/investigations/harness-run/execution-log": async () => ({ next_sequence: 2, items: [{ sequence: 1, event_type: "evidence.collected", created_at: "2026-08-22T00:00:00Z", evidence_ref: "evidence:h1" }] }),
    "GET /v2/actions": async () => ({ items: [] }),
  });
  t.after(fixture.close);
  const connector = createAgentHarnessProductConnector({ origin: fixture.origin, token: "fixture-token",
    approvalToken: "approval-token", adminToken: "admin-token", tenantId: "tenant-eval-harness", attestation: ATTESTATION });
  const discovery = await connector.discover();
  assert.equal(discovery.architecture, "CLAUDE_AGENT_SDK_HARNESS");
  assert.equal(discovery.production_writes_available, false);
  const readiness = await connector.evaluationReadiness();
  assert.equal(readiness.identities_separated, true);
  assert.equal(readiness.least_privilege, true);
  const executionContract = { execution_mode: "controlled_simulation", trial: { id: "run" }, case: { goal: "调查AMF",
    visible: { operating_mode: "human_collaboration", time_window: "2026-08-22T00:00:00Z/2026-08-22T00:10:00Z" } } };
  const prepared = await connector.prepare({ executionContract });
  assert.equal(prepared.operating_mode, "human_collaboration");
  const started = await connector.start({ executionContract });
  assert.equal(started.run_ref, "harness-run");
  const observation = await connector.observe({ runRef: started.run_ref, cursor: 0, executionContract });
  assert.equal(observation.status, "COMPLETED");
  assert.equal(observation.outcome.root_cause, "amf-service-stopped");
  assert.equal(observation.outcome.confidence, 0.87);
  assert.deepEqual(observation.outcome.exclusions, ["数据库故障"]);
  assert.deepEqual(observation.outcome.next_checks, ["复核AMF启动状态"]);
  assert.equal(observation.evaluation_binding.complete, true);
  assert.equal(observation.evaluation_binding.binding_strength, "CONTROL_PLANE_RECEIPT");
  assert.deepEqual(observation.candidate_usage.values, { input_tokens: 640, output_tokens: 96, model_calls: 3,
    tool_calls: 2, storage_bytes: 4096, cost_usd: 0.025 });
  assert.equal(observation.candidate_usage.complete, true);
  assert.equal(observation.raw_events[0].source_system, "agent-harness-product");
  assert.deepEqual(observation.normalized_events[0].raw_source_refs, [observation.raw_events[0].source_ref]);
  const intake = fixture.requests.find((item) => item.method === "POST" && item.url === "/v2/investigation-candidates");
  assert.deepEqual(intake.body.time_window, {
    start_at: "2026-08-22T00:00:00Z", end_at: "2026-08-22T00:10:00Z", timezone: "Asia/Shanghai",
  });
  assert.ok(fixture.requests.every((item) => item.tenantId === "tenant-eval-harness"));
  assert.ok(fixture.requests.some((item) => item.authorization === "Bearer admin-token"));
  assert.equal(fixture.requests.some((item) => /tool|mcp/i.test(item.url)), false);
  assert.equal(intake.body.goal, "调查AMF");
  assert.equal(intake.body.goal.includes("EvalOS冻结评测上下文"), false);
  assert.equal(JSON.stringify(intake.body).includes("allowed_tool_names"), false);
});

test("LangGraph连接器只调用产品公开接口，不在EvalOS内重建Graph", async (t) => {
  let submittedGoal = "";
  const fixture = await fixtureServer({
    "GET /api/v1/me": async ({ request }) => request.headers.authorization === "Bearer fixture-token"
      ? { subject: "eval-submitter", roles: ["on_call"], tenant_ids: ["tenant-eval-graph"] }
      : request.headers.authorization === "Bearer approval-token"
        ? { subject: "eval-approver", roles: ["approver"], tenant_ids: ["tenant-eval-graph"] }
        : { subject: "eval-administrator", roles: ["tenant_admin"], tenant_ids: ["tenant-eval-graph"] },
    "GET /health/ready": async () => ({ ready: true, architecture_type: "langgraph" }),
    "GET /api/v1/automation/overview": async () => ({ worker: "ready", checkpoint: "ready" }),
    "PUT /api/v1/automation/mode": async ({ body }) => ({ ...body, production_write_enabled: false }),
    "POST /api/v1/candidates": async ({ body }) => { submittedGoal = body.goal; return { investigation: { investigation_id: "graph-run" } }; },
    "GET /api/v1/investigations/graph-run": async () => ({ status: "completed", objective: submittedGoal,
      budget_usage: { input_tokens: 710, output_tokens: 110, model_calls: 4, tool_calls: 5 },
      conclusion: "subscriber-profile-mismatch",
      hypotheses: [{ statement: "subscriber-profile-mismatch", confidence: 0.74, status: "supported",
        supporting_evidence_ids: ["evidence:g1"] }],
      evidence: [{ id: "evidence:g1" }] }),
    "GET /api/v1/investigations/graph-run/journal": async () => ({ next_cursor: 3, items: [{ cursor: 2, event_type: "investigation.completed", timestamp: "2026-08-22T00:00:00Z" }] }),
    "GET /api/v1/investigations/graph-run/product-e2e": async () => ({ root_cause: "subscriber-profile-mismatch", evidence: [{ id: "evidence:g1" }], public_events: [{ event_type: "archive.reconciled" }], archive_reconciled: true, archive_artifacts: [{ artifact_id: "archive:g1" }] }),
  });
  t.after(fixture.close);
  const connector = createLangGraphProductConnector({ origin: fixture.origin, token: "fixture-token",
    approvalToken: "approval-token", adminToken: "admin-token", tenantId: "tenant-eval-graph", attestation: ATTESTATION });
  const discovery = await connector.discover();
  assert.equal(discovery.architecture, "LANGGRAPH_PRODUCT");
  assert.equal(discovery.capability.production_writes_available, false);
  const readiness = await connector.evaluationReadiness();
  assert.equal(readiness.safe_parallelism, 1);
  assert.equal(readiness.least_privilege, true);
  const executionContract = { execution_mode: "controlled_simulation", trial: { id: "run" }, case: { goal: "调查用户注册失败",
    visible: { operating_mode: "controlled_auto", time_window: "trial-relative" } } };
  const prepared = await connector.prepare({ executionContract });
  assert.equal(prepared.operating_mode, "controlled_auto");
  const started = await connector.start({ executionContract });
  assert.equal(started.run_ref, "graph-run");
  const observation = await connector.observe({ runRef: started.run_ref, cursor: 0, executionContract });
  assert.equal(observation.status, "COMPLETED");
  assert.equal(observation.outcome.root_cause, "subscriber-profile-mismatch");
  assert.equal(observation.outcome.confidence, 0.74);
  assert.equal(observation.evaluation_binding.complete, true);
  assert.equal(observation.evaluation_binding.binding_strength, "CONTROL_PLANE_RECEIPT");
  assert.deepEqual(observation.candidate_usage.values, { input_tokens: 710, output_tokens: 110, model_calls: 4, tool_calls: 5 });
  assert.deepEqual(observation.candidate_usage.unavailable_dimensions, ["storage_bytes", "cost_usd"]);
  assert.equal(observation.candidate_usage.complete, false);
  assert.deepEqual(observation.artifact_refs, ["archive:g1"]);
  const intake = fixture.requests.find((item) => item.method === "POST" && item.url === "/api/v1/candidates");
  assert.equal(intake.body.trigger_type, "user");
  assert.equal(Object.hasOwn(intake.body, "source_ref"), false);
  assert.deepEqual(intake.body.time_window, { timezone: "Asia/Shanghai" });
  assert.ok(fixture.requests.every((item) => item.tenantId === "tenant-eval-graph"));
  assert.ok(fixture.requests.some((item) => item.authorization === "Bearer admin-token"));
  assert.equal(fixture.requests.some((item) => /invoke|tool|mcp/i.test(item.url)), false);
  assert.equal(intake.body.goal, "调查用户注册失败");
  assert.equal(intake.body.goal.includes("EvalOS冻结评测上下文"), false);
});

test("LangGraph安全停止终态会进入评分而不是被误判为平台超时", async (t) => {
  let terminalState = "human_takeover";
  let submittedGoal = "";
  const fixture = await fixtureServer({
    "PUT /api/v1/automation/mode": async ({ body }) => body,
    "POST /api/v1/candidates": async ({ body }) => { submittedGoal = body.goal;
      return { investigation: { investigation_id: "safe-stop-run" } }; },
    "GET /api/v1/investigations/safe-stop-run": async () => ({ status: terminalState,
      objective: submittedGoal, conclusion: "安全边界要求转人工处理", evidence: [{ id: "evidence:safe-stop" }] }),
    "GET /api/v1/investigations/safe-stop-run/journal": async () => ({ next_cursor: 9, items: [
      { cursor: 8, event_type: "human_takeover.requested", timestamp: "2026-08-22T00:00:00Z" },
      { cursor: 9, event_type: "archive.reconciled", timestamp: "2026-08-22T00:00:01Z" },
    ] }),
    "GET /api/v1/investigations/safe-stop-run/product-e2e": async () => ({
      root_cause: "安全边界要求转人工处理", evidence: [{ id: "evidence:safe-stop" }],
      public_events: [{ event_type: "human_takeover.requested" }, { event_type: "archive.reconciled" }],
      archive_reconciled: true, archive_artifacts: [{ artifact_id: "archive:safe-stop" }],
    }),
  });
  t.after(fixture.close);
  const connector = createLangGraphProductConnector({ origin: fixture.origin, token: "fixture-token",
    approvalToken: "approval-token", adminToken: "admin-token", tenantId: "tenant-eval-graph", attestation: ATTESTATION });
  const executionContract = { execution_mode: "controlled_simulation", dataset_ref: "dataset@1", suite_ref: "suite@1",
    evaluation_lane: "CONTROLLED_CLOSURE", model: { id: "frozen-model" }, budget: { wallclock_ms: 60000 }, tools: [], policy: {},
    frozen_dependencies: {}, trial: { id: "safe-stop-trial", case_ref: "case@1", replicate_id: 1 },
    case: { goal: "验证安全停止", visible: { operating_mode: "controlled_auto", time_window: "trial-relative" } } };
  await connector.start({ executionContract });

  for (const state of ["human_takeover", "denied", "budget_exhausted"]) {
    terminalState = state;
    const observation = await connector.observe({ runRef: "safe-stop-run", cursor: 0, executionContract });
    assert.equal(observation.status, "INCONCLUSIVE", state);
    assert.equal(observation.outcome.status, "inconclusive", state);
    assert.equal(observation.outcome.candidate_terminal_status, state);
    assert.equal(observation.evaluation_binding.complete, true);
    assert.deepEqual(observation.artifact_refs, ["archive:safe-stop"]);
  }
});

test("Agent+Harness连接器不会把Twin相对时间窗冒充成非法日期", async (t) => {
  const fixture = await fixtureServer({
    "POST /v2/investigation-candidates": async () => ({ investigation_id: "relative-window-run" }),
  });
  t.after(fixture.close);
  const connector = createAgentHarnessProductConnector({ origin: fixture.origin, token: "fixture-token",
    approvalToken: "approval-token", adminToken: "admin-token", tenantId: "tenant-eval-harness", attestation: ATTESTATION });
  const executionContract = { execution_mode: "controlled_simulation", trial: { id: "relative-window" },
    case: { goal: "调查Twin当前现场", visible: { operating_mode: "diagnosis_only", time_window: "trial-relative" } } };
  await connector.start({ executionContract });
  const intake = fixture.requests.find((item) => item.method === "POST");
  assert.deepEqual(intake.body.time_window, { timezone: "Asia/Shanghai" });
  assert.equal(JSON.stringify(intake.body).includes("trial-relative"), false);
});

test("真实产品连接器拒绝公网明文HTTP和缺失凭据", () => {
  assert.throws(() => createAgentHarnessProductConnector({ origin: "http://example.com", token: "x", approvalToken: "y",
    adminToken: "z", tenantId: "tenant", attestation: ATTESTATION }), /require HTTPS/);
  assert.throws(() => createLangGraphProductConnector({ origin: "https://example.com", token: "", approvalToken: "y",
    adminToken: "z", tenantId: "tenant", attestation: ATTESTATION }), /bearer token is required/);
  assert.throws(() => createLangGraphProductConnector({ origin: "https://example.com", token: "same", approvalToken: "same",
    adminToken: "different", tenantId: "tenant", attestation: ATTESTATION }), /three separate identities/);
});

test("三个不同Token如果仍属于同一个超级管理员，也不能冒充职责分离", async (t) => {
  const fixture = await fixtureServer({
    "GET /api/v1/me": async () => ({ subject: "platform-super-admin", roles: ["platform_admin"],
      tenant_ids: ["tenant-eval-graph"] }),
  });
  t.after(fixture.close);
  const connector = createLangGraphProductConnector({ origin: fixture.origin, token: "submitter-session",
    approvalToken: "approval-session", adminToken: "admin-session", tenantId: "tenant-eval-graph", attestation: ATTESTATION });
  const readiness = await connector.evaluationReadiness();
  assert.equal(readiness.identities_separated, false);
  assert.equal(readiness.least_privilege, false);
  assert.equal(readiness.credential_checks.distinct_subjects, false);
});
