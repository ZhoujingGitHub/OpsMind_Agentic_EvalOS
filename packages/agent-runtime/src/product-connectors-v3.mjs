import { createHash } from "node:crypto";

const SHA256 = /^sha256:[a-f0-9]{64}$/;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function baseUrl(value) {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("real candidate product APIs require HTTPS; HTTP is allowed only on loopback");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

function assertAttestation(attestation) {
  if (!attestation?.source_revision || !SHA256.test(attestation.artifact_digest ?? "")) {
    throw new Error("candidate deployment attestation must freeze source_revision and artifact_digest");
  }
  return attestation;
}

function assertSeparatedIdentities(token, approvalToken, adminToken) {
  if (!approvalToken || !adminToken) throw new Error("candidate approval and admin bearer tokens are required through environment variables");
  if (new Set([token, approvalToken, adminToken]).size !== 3) {
    throw new Error("candidate submitter, Approval Oracle and mode administrator must use three separate identities");
  }
}

function permission(principal, name) {
  return principal?.permissions?.[name] === true;
}

function roleSet(principal) {
  return new Set((principal?.roles ?? []).map((item) => String(item).toLowerCase()));
}

function distinct(values) {
  return values.every(Boolean) && new Set(values).size === values.length;
}

function tenantScoped(principal, tenantId, kind) {
  if (kind === "agent-harness") return principal?.tenant_id === tenantId;
  return Array.isArray(principal?.tenant_ids) && principal.tenant_ids.includes(tenantId);
}

function client(origin, token, requestTimeoutMs, defaultHeaders = {}) {
  const root = baseUrl(origin);
  if (!token) throw new Error("real candidate product bearer token is required through an environment variable");
  const request = async (pathname, { method = "GET", body } = {}) => {
    const target = new URL(pathname.replace(/^\//, ""), root.href);
    if (target.origin !== root.origin) throw new Error("candidate connector URL escaped the frozen product origin");
    const response = await fetch(target, { method, headers: { accept: "application/json", authorization: `Bearer ${token}`,
      ...defaultHeaders,
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(requestTimeoutMs) });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`candidate product returned non-JSON HTTP ${response.status}`); }
    if (!response.ok) {
      const code = payload?.detail?.code ?? payload?.error?.code ?? payload?.detail ?? "request_failed";
      throw new Error(`candidate product ${method} ${target.pathname} HTTP ${response.status}: ${typeof code === "string" ? code : JSON.stringify(code)}`);
    }
    return payload;
  };
  return { request, origin: root.origin };
}

function rawEvent(sourceSystem, ref, payload) {
  return { source_ref: ref, source_system: sourceSystem, recorded_at: payload?.created_at ?? payload?.timestamp ?? new Date().toISOString(),
    payload, payload_digest: digest(payload) };
}

function normalizedType(value) {
  const name = String(value ?? "").toLowerCase();
  if (/candidate|job.accept|task.receive|investigation.create/.test(name)) return "task.received";
  if (/investigation.start|run.start|worker.start/.test(name)) return "investigation.started";
  if (/tool|evidence|observation|metric|log|alarm|probe/.test(name)) return "evidence.collected";
  if (/conclusion|report|finalize|completed/.test(name)) return "conclusion.recorded";
  if (/proposal/.test(name)) return "action.proposed";
  if (/policy/.test(name)) return "policy.decided";
  if (/approval|approved|rejected/.test(name)) return "approval.decided";
  if (/ticket/.test(name)) return "ticket.issued";
  if (/lease/.test(name)) return "lease.acquired";
  if (/rollback.*verif/.test(name)) return "rollback.verified";
  if (/rollback/.test(name)) return "rollback.executed";
  if (/verif/.test(name)) return "verification.completed";
  if (/execut|action\.(?:started|succeeded|failed|unknown)|action.result/.test(name)) return "action.executed";
  if (/circuit/.test(name)) return "circuit_breaker.opened";
  if (/kill|emergency.stop/.test(name)) return "emergency_stop.activated";
  if (/takeover|human.*required|escalat/.test(name)) return "human_takeover.requested";
  if (/archive|reconcil/.test(name)) return "archive.reconciled";
  return null;
}

function semanticPayload(event, eventName, sourceRef) {
  const nested = event?.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload : {};
  const publicPayload = event?.public_payload && typeof event.public_payload === "object" && !Array.isArray(event.public_payload)
    ? event.public_payload : {};
  const source = { ...event, ...publicPayload, ...nested };
  const allowed = ["decision", "decision_code", "reason_code", "authorization_source", "risk_level", "action_id",
    "proposal_digest", "policy_decision_id", "ticket_id", "execution_id", "state_changed", "production_execution",
    "verdict", "effective", "rolled_back", "status", "ok", "scope_digest", "runtime_manifest_digest"];
  return Object.fromEntries([["event_name", eventName], ["source_ref", sourceRef],
    ...allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])]);
}

const EVAL_CONTEXT_PREFIX = "[EvalOS冻结评测上下文｜不是求解提示] ";

function findFrozenContext(value, seen = new Set()) {
  if (typeof value === "string") {
    const index = value.indexOf(EVAL_CONTEXT_PREFIX);
    if (index < 0) return null;
    const line = value.slice(index + EVAL_CONTEXT_PREFIX.length).split(/\r?\n/, 1)[0];
    try {
      const context = JSON.parse(line);
      return context?.contract === "evalos-candidate-context.3" ? context : null;
    } catch { return null; }
  }
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  for (const nested of Object.values(value)) {
    const context = findFrozenContext(nested, seen);
    if (context) return context;
  }
  return null;
}

function sameValue(actual, expected) {
  return canonical(actual) === canonical(expected);
}

function evaluationBinding({ runRef, expected, publicPayloads = [], nativeClosures = [] }) {
  const taskContext = publicPayloads.map((item) => findFrozenContext(item)).find(Boolean) ?? null;
  const nativeClosure = nativeClosures.find(Boolean) ?? null;
  const context = nativeClosure ? {
    trial_id: nativeClosure.trial_id,
    case_ref: nativeClosure.case_id ?? nativeClosure.case_ref,
    environment_seed: nativeClosure.evaluation_seed ?? nativeClosure.seed,
    budget: nativeClosure.evaluation_budget ?? nativeClosure.budget,
    operating_mode: nativeClosure.operating_mode,
    execution_mode: nativeClosure.execution_mode,
  } : taskContext;
  const taskChecks = {
    context_digest: taskContext?.context_digest === expected?.context_digest,
    trial_id: taskContext?.trial_id === expected?.trial_id,
    case_ref: taskContext?.case_ref === expected?.case_ref,
    environment_seed: taskContext?.environment_seed === expected?.environment_seed,
    budget: sameValue(taskContext?.budget, expected?.budget),
    operating_mode: taskContext?.operating_mode === expected?.operating_mode,
    execution_mode: taskContext?.execution_mode === expected?.execution_mode,
  };
  const closureChecks = nativeClosure ? {
    trial_id: context.trial_id === expected?.trial_id,
    case_ref: context.case_ref === expected?.case_ref,
    environment_seed: context.environment_seed === expected?.environment_seed,
    budget: sameValue(context.budget, expected?.budget),
    operating_mode: context.operating_mode === expected?.operating_mode,
    execution_mode: context.execution_mode === expected?.execution_mode,
  } : null;
  const taskBound = Object.values(taskChecks).every(Boolean);
  const closureBound = closureChecks ? Object.values(closureChecks).every(Boolean) : true;
  return {
    contract: "evalos-product-run-binding.1", run_ref: runRef,
    expected_context_digest: expected?.context_digest ?? null,
    task_context_observed: Boolean(taskContext), native_closure_observed: Boolean(nativeClosure),
    binding_strength: nativeClosure ? "NATIVE_CLOSURE_FIELDS" : taskContext ? "PUBLIC_TASK_CONTEXT" : "UNBOUND",
    task_checks: taskChecks, closure_checks: closureChecks,
    complete: taskBound && closureBound,
  };
}

function projectionEvidence(sourceSystem, sourceRef, projection) {
  if (!projection || typeof projection !== "object") return { raw: [], normalized: [] };
  const raw = [rawEvent(sourceSystem, sourceRef, projection)];
  const lifecycle = projection.action_lifecycle ?? projection;
  const candidates = [
    ["policy.decided", lifecycle.policy_decision,
      `policy.${String(lifecycle.policy_decision?.decision ?? "decision").toLowerCase()}`],
    ["approval.decided", lifecycle.approval,
      `approval.${String(lifecycle.approval?.decision ?? lifecycle.approval?.status ?? "approved").toLowerCase()}`],
    ["ticket.issued", lifecycle.execution_ticket ?? lifecycle.ticket, "ticket.issued"],
    ["action.executed", lifecycle.action_result ?? lifecycle.attempt, "action.executed"],
    ["verification.completed", lifecycle.independent_verification ?? lifecycle.verification, "verification.completed"],
    ["rollback.executed", lifecycle.rollback, "rollback.executed"],
    ["archive.reconciled", lifecycle.archive, "archive.reconciled"],
  ];
  const normalized = candidates.flatMap(([eventType, item, eventName]) => {
    if (!item) return [];
    const enriched = { ...item, event_name: eventName,
      authorization_source: item.authorization_source ?? projection.authorization_source,
      verdict: item.verdict ?? item.outcome, ticket_id: item.ticket_id,
      state_changed: item.state_changed ?? item.changed, production_execution: projection.production_execution ?? false };
    return [{ event_type: eventType, actor: sourceSystem, status: item.status ?? "RECORDED",
      raw_source_refs: [sourceRef], payload: semanticPayload(enriched, eventName, sourceRef) }];
  });
  return { raw, normalized };
}

function translate(events, sourceSystem, refOf, nameOf) {
  const raw = events.map((event, index) => rawEvent(sourceSystem, refOf(event, index), event));
  const normalized = raw.flatMap((item) => {
    const eventType = normalizedType(nameOf(item.payload));
    return eventType ? [{ event_type: eventType, actor: item.payload?.actor_id ?? item.payload?.source ?? sourceSystem,
      status: item.payload?.status ?? "RECORDED", raw_source_refs: [item.source_ref],
      payload: semanticPayload(item.payload, nameOf(item.payload), item.source_ref) }] : [];
  });
  return { raw, normalized };
}

function productEvidence(events, extra = {}) {
  const names = events.map((item) => String(item?.event_type ?? item?.name ?? item?.action ?? "").toLowerCase());
  const evidence = (name, pattern, fallback) => {
    const index = names.findIndex((value) => pattern.test(value));
    const ref = index >= 0 ? `event:${index + 1}` : fallback;
    return ref ? { recorded: true, ref } : { recorded: false, ref: "" };
  };
  return {
    queue: evidence("queue", /queue|job.accept|candidate/, extra.queue),
    worker: evidence("worker", /worker|run.start|investigation.start/, extra.worker),
    recovery: evidence("recovery", /recover|resume|checkpoint|retry|rollback/, extra.recovery),
    persistence: evidence("persistence", /persist|checkpoint|journal|event/, extra.persistence),
    audit: evidence("audit", /audit|policy|approval|event/, extra.audit),
    archive: evidence("archive", /archive|reconcil/, extra.archive),
  };
}

function finalOutcome({ status, conclusion, uncertainty, evidence = [] }) {
  const evidenceRefs = evidence.flatMap((item) => item?.evidence_ref ?? item?.evidence_id ?? item?.id ?? []).filter(Boolean);
  const inconclusive = ["inconclusive", "insufficient_evidence", "waiting_data"].includes(String(status).toLowerCase());
  return { status: inconclusive ? "inconclusive" : "resolved", root_cause: conclusion ?? uncertainty ?? "candidate-did-not-publish-a-conclusion",
    confidence: inconclusive ? 0 : 1, evidence_refs: [...new Set(evidenceRefs)], exclusions: [],
    tool_failures_recovered: false, next_checks: inconclusive ? ["补充现场证据后重新评测"] : [], summary: conclusion ?? uncertainty ?? "" };
}

function timeWindow(value) {
  const [start_at, end_at] = String(value ?? "").split("/");
  return { ...(start_at ? { start_at } : {}), ...(end_at ? { end_at } : {}), timezone: "Asia/Shanghai" };
}

function frozenEvaluationContext(executionContract) {
  const visible = executionContract.case.visible;
  const material = {
    contract: "evalos-candidate-context.3", trial_id: executionContract.trial.id,
    case_ref: executionContract.trial.case_ref, environment_seed: executionContract.trial.environment_seed,
    replicate_id: executionContract.trial.replicate_id, dataset_ref: executionContract.dataset_ref,
    suite_ref: executionContract.suite_ref, evaluation_lane: executionContract.evaluation_lane,
    operating_mode: visible.operating_mode, execution_mode: executionContract.execution_mode,
    model: executionContract.model, budget: executionContract.budget,
    allowed_tool_names: (executionContract.tools ?? []).map((item) => item.name),
    policy_digest: digest(executionContract.policy ?? {}),
    frozen_dependencies_digest: digest(executionContract.frozen_dependencies ?? {}),
  };
  return { ...material, context_digest: digest(material) };
}

function candidateGoal(executionContract) {
  const context = frozenEvaluationContext(executionContract);
  return `[EvalOS冻结评测上下文｜不是求解提示] ${JSON.stringify(context)}\n\n评测题目：${executionContract.case.goal}`;
}

function discovery(attestation, architecture, capability, runtime, health = {}) {
  return {
    candidate_kind: "REAL_PRODUCT", architecture, production_writes_available: false,
    source_revision: attestation.source_revision, artifact_digest: attestation.artifact_digest,
    capability_contract_digest: digest(capability), runtime_manifest_digest: digest(runtime),
    runtime_digest: digest({ architecture, capability_contract_digest: digest(capability), runtime_manifest_digest: digest(runtime) }),
    capability, runtime, health,
  };
}

export function createAgentHarnessProductConnector({ origin, token, approvalToken, adminToken, tenantId, attestation, requestTimeoutMs = 30000 } = {}) {
  if (!tenantId) throw new Error("Agent+Harness evaluation tenant id is required");
  assertSeparatedIdentities(token, approvalToken, adminToken);
  const tenantHeaders = { "x-tenant-id": tenantId };
  const api = client(origin, token, requestTimeoutMs, tenantHeaders);
  const approvalApi = client(origin, approvalToken, requestTimeoutMs, tenantHeaders);
  const adminApi = client(origin, adminToken, requestTimeoutMs, tenantHeaders);
  const frozen = assertAttestation(attestation);
  const expectedContexts = new Map();
  return Object.freeze({
    kind: "agent-harness-product-api",
    async evaluationReadiness() {
      const [submitter, approver, administrator] = await Promise.all([
        api.request("/v2/auth/me"), approvalApi.request("/v2/auth/me"), adminApi.request("/v2/auth/me"),
      ]);
      const subjectIds = [submitter.user_id, approver.user_id, administrator.user_id];
      const identitiesSeparated = distinct(subjectIds);
      const tenantBound = [submitter, approver, administrator]
        .every((principal) => tenantScoped(principal, tenantId, "agent-harness"));
      const submitterScoped = permission(submitter, "investigate") && !permission(submitter, "approve_action") &&
        !permission(submitter, "manage_users") && !permission(submitter, "manage_roles");
      const approverScoped = permission(approver, "approve_action") && !permission(approver, "investigate") &&
        !permission(approver, "manage_users") && !permission(approver, "manage_roles");
      const administratorScoped = permission(administrator, "manage_users") || permission(administrator, "manage_roles");
      return { credential_roles: ["candidate_submitter", "approval_oracle", "mode_administrator"],
        identities_separated: identitiesSeparated, least_privilege: submitterScoped && approverScoped && administratorScoped,
        tenant_bound: tenantBound, isolated_tenant_slots: 1, safe_parallelism: 1,
        credential_checks: { distinct_subjects: identitiesSeparated, submitter_least_privilege: submitterScoped,
          approver_least_privilege: approverScoped, administrator_authorized: administratorScoped },
        production_writes_available: false };
    },
    async discover() {
      const [capability, runtime, safety] = await Promise.all([
        api.request("/v2/evaluation/controlled-remediation-contract"),
        api.request("/v2/investigation-runtime"), api.request("/v2/remediation/context"),
      ]);
      const stableRuntime = {
        execution_api: runtime.sdk_execution_api,
        execution_mode: runtime.execution_mode,
        steering_application: runtime.steering_application,
        concurrency_limit: runtime.concurrency_limit,
        duplicate_policy: runtime.duplicate_policy,
        queue_policy: runtime.queue_policy,
        heartbeat_interval_seconds: runtime.heartbeat_interval_seconds,
        safety_framework_version: safety.safety_framework_version ?? safety.contract_version ?? "controlled-remediation.1",
        production_writes_available: false,
      };
      return discovery(frozen, "CLAUDE_AGENT_SDK_HARNESS", capability, stableRuntime, {
        status: "reachable", active_count: runtime.active_count, queued_count: runtime.queued_count,
        available_slots: runtime.available_slots,
      });
    },
    async prepare({ executionContract }) {
      const operatingMode = executionContract.case.visible.operating_mode;
      await adminApi.request("/v2/remediation/mode", { method: "PUT", body: {
        operating_mode: operatingMode, execution_mode: executionContract.execution_mode,
      } });
      return { tenant_id: tenantId, operating_mode: operatingMode,
        execution_mode: executionContract.execution_mode, production_writes_available: false };
    },
    async start({ executionContract }) {
      const visible = executionContract.case.visible;
      const evaluationContext = frozenEvaluationContext(executionContract);
      const scope = visible.scope ?? {};
      const result = await api.request("/v2/investigation-candidates", { method: "POST", body: {
        goal: candidateGoal(executionContract), trigger_type: "natural_language",
        source_ref: `evalos:${executionContract.trial.id}:${evaluationContext.context_digest.slice(-16)}`,
        priority: 70, scope_hint: { customer_id: scope.customer_id, service_id: scope.service_id, site_id: scope.site_id,
          entity_ids: scope.entity_ids ?? scope.resource_ids ?? [], source_page: `/evalos/trials/${executionContract.trial.id}` },
        time_window: timeWindow(visible.time_window), seed_evidence_refs: [], freshness: "fresh",
      } });
      const runRef = result.investigation_id ?? result.linked_investigation_id ?? result.candidate?.linked_investigation_id;
      if (!runRef) throw new Error("Agent+Harness product did not create a real investigation");
      expectedContexts.set(runRef, evaluationContext);
      return { run_ref: runRef, status: "RUNNING", cursor: 0 };
    },
    async observe({ runRef, cursor = 0 }) {
      const [detail, log, actionPage] = await Promise.all([
        api.request(`/v2/investigations/${encodeURIComponent(runRef)}`),
        api.request(`/v2/investigations/${encodeURIComponent(runRef)}/execution-log?after_sequence=${Number(cursor) || 0}&limit=5000`),
        api.request("/v2/actions?limit=500"),
      ]);
      const events = log.items ?? [];
      const translated = translate(events, "agent-harness-product", (event, index) => `agent-harness:${event.sequence ?? Number(cursor) + index + 1}`,
        (event) => event.event_type ?? event.name ?? event.action);
      const actions = (actionPage.items ?? []).filter((item) => item.investigation_id === runRef);
      const approvalRequests = actions.filter((item) => ["awaiting_approval", "human_approval_required", "prechecked"].includes(item.status))
        .map((item) => ({ request_ref: `agent-harness-approval:${item.action_id}`, action_id: item.action_id,
          proposal: item, proposal_digest: item.proposal_digest, scope: item.scope, policy_decision: item.policy_decision }));
      const state = String(detail.status ?? "").toLowerCase();
      const terminal = ["resolved", "inconclusive", "failed"].includes(state);
      const completeEvents = terminal && Number(cursor) > 0
        ? (await api.request(`/v2/investigations/${encodeURIComponent(runRef)}/execution-log?after_sequence=0&limit=5000`)).items ?? events
        : events;
      const evaluationAnswers = terminal ? await Promise.all(actions.map((item) =>
        api.request(`/v2/evaluation/actions/${encodeURIComponent(item.action_id)}`))) : [];
      const projected = evaluationAnswers.map((answer) => projectionEvidence("agent-harness-product",
        `agent-harness:evaluation-action:${answer.action_id}`, answer));
      const projectionRaw = projected.flatMap((item) => item.raw);
      const projectionNormalized = projected.flatMap((item) => item.normalized);
      const binding = terminal ? evaluationBinding({ runRef, expected: expectedContexts.get(runRef),
        publicPayloads: [detail, ...completeEvents], nativeClosures: evaluationAnswers }) : null;
      return { run_ref: runRef, status: terminal ? (state === "failed" ? "FAILED" : state === "inconclusive" ? "INCONCLUSIVE" : "COMPLETED") : "RUNNING",
        next_cursor: log.next_sequence ?? cursor, raw_events: [...translated.raw, ...projectionRaw],
        normalized_events: [...translated.normalized, ...projectionNormalized],
        approval_requests: approvalRequests, outcome: terminal ? finalOutcome({ status: state,
          conclusion: detail.report?.root_cause ?? detail.report?.summary ?? detail.answer ?? detail.conclusion,
          uncertainty: detail.report?.uncertainty, evidence: detail.evidence ?? [] }) : null,
        product_evidence: terminal ? productEvidence(completeEvents, { persistence: `investigation:${runRef}`, audit: `execution-log:${runRef}` }) : null,
        evaluation_binding: binding, artifact_refs: detail.report_ref ? [detail.report_ref] : [] };
    },
    async respondApproval({ request, decision }) {
      return approvalApi.request(`/v2/actions/${encodeURIComponent(request.action_id)}/approval`, { method: "POST",
        body: { decision: decision.decision === "APPROVE" ? "approved" : "rejected", comment: decision.reason_zh } });
    },
    async cancel() { return { supported: false, reason: "candidate-product-does-not-expose-cancel-api" }; },
  });
}

export function createLangGraphProductConnector({ origin, token, approvalToken, adminToken, tenantId, attestation, requestTimeoutMs = 30000 } = {}) {
  if (!tenantId) throw new Error("LangGraph evaluation tenant id is required");
  assertSeparatedIdentities(token, approvalToken, adminToken);
  const tenantHeaders = { "x-tenant-id": tenantId };
  const api = client(origin, token, requestTimeoutMs, tenantHeaders);
  const approvalApi = client(origin, approvalToken, requestTimeoutMs, tenantHeaders);
  const adminApi = client(origin, adminToken, requestTimeoutMs, tenantHeaders);
  const frozen = assertAttestation(attestation);
  const expectedContexts = new Map();
  return Object.freeze({
    kind: "langgraph-product-api",
    async evaluationReadiness() {
      const [submitter, approver, administrator] = await Promise.all([
        api.request("/api/v1/me"), approvalApi.request("/api/v1/me"), adminApi.request("/api/v1/me"),
      ]);
      const submitterRoles = roleSet(submitter);
      const approverRoles = roleSet(approver);
      const administratorRoles = roleSet(administrator);
      const identitiesSeparated = distinct([submitter.subject, approver.subject, administrator.subject]);
      const tenantBound = [submitter, approver, administrator]
        .every((principal) => tenantScoped(principal, tenantId, "langgraph"));
      const submitterScoped = (submitterRoles.has("on_call") || submitterRoles.has("tenant_admin")) &&
        !submitterRoles.has("platform_admin") && !submitterRoles.has("approver");
      const approverScoped = (approverRoles.has("approver") || approverRoles.has("tenant_admin")) &&
        !approverRoles.has("platform_admin") && !approverRoles.has("on_call");
      const administratorScoped = administratorRoles.has("tenant_admin") || administratorRoles.has("platform_admin");
      return { credential_roles: ["candidate_submitter", "approval_oracle", "mode_administrator"],
        identities_separated: identitiesSeparated, least_privilege: submitterScoped && approverScoped && administratorScoped,
        tenant_bound: tenantBound, isolated_tenant_slots: 1, safe_parallelism: 1,
        credential_checks: { distinct_subjects: identitiesSeparated, submitter_least_privilege: submitterScoped,
          approver_least_privilege: approverScoped, administrator_authorized: administratorScoped },
        production_writes_available: false };
    },
    async discover() {
      const [ready, automation] = await Promise.all([api.request("/health/ready"), api.request("/api/v1/automation/overview")]);
      const capability = { architecture_type: ready.architecture_type, operating_modes: ["diagnosis_only", "human_collaboration", "controlled_auto"],
        execution_modes: ["controlled_simulation", "replay_read_only"], production_writes_available: false };
      const stableRuntime = {
        architecture_type: ready.architecture_type,
        connector_manifest: (ready.connectors ?? []).map((item) => ({ name: item.name ?? item.connector_id,
          kind: item.kind ?? item.connector_type, required: item.required ?? null })),
        safety_framework_version: automation.safety_framework_version,
        graph_version: automation.graph_version,
        state_schema_version: automation.state_schema_version,
        real_production_connector_registered: false,
        production_writes_available: false,
      };
      return discovery(frozen, "LANGGRAPH_PRODUCT", capability, stableRuntime, {
        status: ready.status ?? (ready.ready === true ? "ready" : "not_ready"), connector_states: (ready.connectors ?? []).map((item) => ({
          name: item.name ?? item.connector_id, status: item.status,
        })),
      });
    },
    async prepare({ executionContract }) {
      const operatingMode = executionContract.case.visible.operating_mode;
      await adminApi.request("/api/v1/automation/mode", { method: "PUT", body: {
        operating_mode: operatingMode, execution_mode: executionContract.execution_mode,
        production_write_enabled: false, reason: `EvalOS冻结Trial ${executionContract.trial.id} 切换受控评测模式。`,
      } });
      return { tenant_id: tenantId, operating_mode: operatingMode,
        execution_mode: executionContract.execution_mode, production_writes_available: false };
    },
    async start({ executionContract }) {
      const evaluationContext = frozenEvaluationContext(executionContract);
      const scope = executionContract.case.visible.scope ?? {};
      const result = await api.request("/api/v1/candidates", { method: "POST", body: {
        goal: candidateGoal(executionContract), trigger_type: "eval_replay",
        source_ref: `evalos:${executionContract.trial.id}:${evaluationContext.context_digest.slice(-16)}`,
        title: `EvalOS ${executionContract.trial.case_ref}`,
        resource_ids: scope.resource_ids ?? scope.entity_ids ?? [], service_ids: scope.service_ids ?? (scope.service_id ? [scope.service_id] : []),
        time_window: { value: executionContract.case.visible.time_window }, client_request_id: executionContract.trial.id,
      } });
      const runRef = result.investigation?.investigation_id;
      if (!runRef) throw new Error("LangGraph product did not create a real investigation");
      expectedContexts.set(runRef, evaluationContext);
      return { run_ref: runRef, status: "RUNNING", cursor: 0 };
    },
    async observe({ runRef, cursor = 0 }) {
      const [detail, journal, projection] = await Promise.all([
        api.request(`/api/v1/investigations/${encodeURIComponent(runRef)}`),
        api.request(`/api/v1/investigations/${encodeURIComponent(runRef)}/journal?after_cursor=${Number(cursor) || 0}&limit=1000`),
        api.request(`/api/v1/investigations/${encodeURIComponent(runRef)}/product-e2e`),
      ]);
      const events = journal.items ?? [];
      const translated = translate(events, "langgraph-product", (event, index) => `langgraph:${event.cursor ?? Number(cursor) + index + 1}`,
        (event) => event.event_type ?? event.name ?? event.action);
      const lifecycle = projection.action_lifecycle;
      const approvalRequests = detail.status === "waiting_approval" && lifecycle?.proposal ? [{
        request_ref: `langgraph-approval:${lifecycle.proposal.action_id}`, action_id: lifecycle.proposal.action_id,
        proposal: lifecycle.proposal, proposal_digest: lifecycle.proposal.proposal_digest,
        environment_snapshot_digest: lifecycle.environment_snapshot?.snapshot_digest,
        policy_decision_id: lifecycle.policy_decision?.decision_id, scope: lifecycle.proposal.scope_snapshot_id,
      }] : [];
      const state = String(detail.status ?? "").toLowerCase();
      const terminal = ["completed", "insufficient_evidence", "failed", "cancelled"].includes(state);
      const projected = terminal ? projectionEvidence("langgraph-product", `langgraph:product-e2e:${runRef}`, projection)
        : { raw: [], normalized: [] };
      const binding = terminal ? evaluationBinding({ runRef, expected: expectedContexts.get(runRef),
        publicPayloads: [detail, projection, ...events],
        nativeClosures: lifecycle ? [projection] : [] }) : null;
      return { run_ref: runRef, status: terminal ? (state === "completed" ? "COMPLETED" : state === "insufficient_evidence" ? "INCONCLUSIVE" : state.toUpperCase()) : "RUNNING",
        next_cursor: journal.next_cursor ?? cursor, raw_events: [...translated.raw, ...projected.raw],
        normalized_events: [...translated.normalized, ...projected.normalized],
        approval_requests: approvalRequests, outcome: terminal ? finalOutcome({ status: state,
          conclusion: projection.root_cause ?? detail.conclusion, uncertainty: projection.uncertainty ?? detail.uncertainty,
          evidence: projection.evidence ?? detail.evidence ?? [] }) : null,
        product_evidence: terminal ? productEvidence(projection.public_events ?? events, { persistence: `journal:${runRef}`,
          audit: `product-e2e:${runRef}`, archive: projection.archive_reconciled ? `archive:${runRef}` : null }) : null,
        evaluation_binding: binding,
        artifact_refs: (projection.archive_artifacts ?? []).map((item) => item.uri ?? item.object_key ?? item.artifact_id).filter(Boolean) };
    },
    async respondApproval({ runRef, request, decision }) {
      return approvalApi.request(`/api/v1/investigations/${encodeURIComponent(runRef)}/approvals`, { method: "POST", body: {
        action_id: request.action_id, decision: decision.decision === "APPROVE" ? "approved" : "rejected",
        reason: decision.reason_zh, proposal_digest: request.proposal_digest,
        environment_snapshot_digest: request.environment_snapshot_digest, policy_decision_id: request.policy_decision_id,
      } });
    },
    async cancel() { return { supported: false, reason: "candidate-product-does-not-expose-cancel-api" }; },
  });
}

export const PRODUCT_CONNECTOR_V3_RUNTIME = Object.freeze({
  role: "external-product-control-plane-client", productionWrites: false,
  candidateCodeMutation: false, candidateDatabaseMutation: false, tokenSource: "environment-only",
});
