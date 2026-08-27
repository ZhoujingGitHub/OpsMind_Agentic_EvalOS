import { createHash } from "node:crypto";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const USAGE_DIMENSIONS = Object.freeze(["input_tokens", "output_tokens", "model_calls", "tool_calls", "storage_bytes", "cost_usd"]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function sameValue(actual, expected) {
  return canonical(actual) === canonical(expected);
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

function assertSeparatedIdentities(token, approvalToken, adminToken, requestTransport = null) {
  if (requestTransport) {
    const roles = requestTransport.credential_roles ?? [];
    if (!["candidate_submitter", "approval_oracle", "mode_administrator"].every((role) => roles.includes(role))) {
      throw new Error("candidate relay must expose three separate credential roles");
    }
    return;
  }
  if (!approvalToken || !adminToken) throw new Error("candidate approval and admin bearer tokens are required through environment variables");
  if (new Set([token, approvalToken, adminToken]).size !== 3) {
    throw new Error("candidate submitter, Approval Oracle and mode administrator must use three separate identities");
  }
}

function client(origin, token, requestTimeoutMs, defaultHeaders = {}, requestTransport = null,
  credentialRole = "candidate_submitter") {
  if (requestTransport) {
    return { origin: requestTransport.origin,
      request: (pathname, { method = "GET", body } = {}) => requestTransport.request(credentialRole, pathname, {
        method, body, headers: defaultHeaders, timeoutMs: requestTimeoutMs,
      }) };
  }
  const root = baseUrl(origin);
  if (!token) throw new Error("real candidate product bearer token is required through an environment variable");
  const request = async (pathname, { method = "GET", body } = {}) => {
    const target = new URL(pathname.replace(/^\//, ""), root.href);
    if (target.origin !== root.origin) throw new Error("candidate connector URL escaped the frozen product origin");
    const response = await fetch(target, { method, headers: { accept: "application/json",
      authorization: `Bearer ${token}`, ...defaultHeaders,
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

function deploymentLimits(value) {
  const maxRunMs = Number(value?.max_run_ms);
  return Object.freeze({ observable: Number.isFinite(maxRunMs) && maxRunMs > 0,
    max_run_ms: Number.isFinite(maxRunMs) && maxRunMs > 0 ? maxRunMs : null,
    cancellation_supported: value?.cancellation_supported === true, source: value?.source ?? "not-declared" });
}

const NATIVE_BUDGET_KEYS = Object.freeze(["max_duration_seconds", "max_tool_calls", "max_model_calls",
  "max_tokens", "max_cost_microunits", "max_result_bytes"]);

const LANGGRAPH_JOB_RUNTIME_CONTRACT = "opsmind-job-runtime-limits:1.0";
const OPEN_RESOURCE_POLICY_CONTRACT = "opsmind-open-resource/1.0";
const LANGGRAPH_BUDGET_DIMENSIONS = Object.freeze({
  active_duration: Object.freeze({ budget_key: "max_duration_seconds", unit: "seconds" }),
  model_calls: Object.freeze({ budget_key: "max_model_calls", unit: "calls" }),
  tool_calls: Object.freeze({ budget_key: "max_tool_calls", unit: "calls" }),
  tokens: Object.freeze({ budget_key: "max_tokens", unit: "tokens" }),
  cost: Object.freeze({ budget_key: "max_cost_microunits", unit: "microunits" }),
  result_bytes: Object.freeze({ budget_key: "max_result_bytes", unit: "bytes" }),
});

function publicOpenResourcePolicy(...values) {
  const available = values.filter((value) => value && typeof value === "object" && !Array.isArray(value));
  if (!available.length) return Object.freeze({ supported: false, contract_version: null });
  if (available.some((value) => !sameValue(value, available[0]))) {
    throw new Error("candidate public open-resource policy declarations disagree");
  }
  const policy = available[0];
  const expected = {
    contract_version: OPEN_RESOURCE_POLICY_CONTRACT,
    mode: "open_with_safety_fuses",
    limits_are_safety_fuses_only: true,
    usage_affects_score: false,
    efficiency_reporting_only: true,
    case_specific_limits: false,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (policy[name] !== value) throw new Error(`candidate public open-resource policy has invalid ${name}`);
  }
  return Object.freeze({ supported: true, ...expected });
}

function strictInteger(value, name, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new Error(`LangGraph public Job runtime contract has invalid ${name}`);
  }
  return number;
}

function langGraphNativeContract(automation) {
  const contract = automation?.job_runtime_limits;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("LangGraph native Job runtime limits are not publicly available");
  }
  const fixedFields = {
    contract_version: LANGGRAPH_JOB_RUNTIME_CONTRACT,
    source: "product_runtime",
    native_enforcement: true,
    cancellation_supported: false,
    terminal_status: "budget_exhausted",
    stop_semantics: "safe_stop_without_confirmed_root_cause",
    budget_reason: "duration_limit",
  };
  for (const [name, expected] of Object.entries(fixedFields)) {
    if (contract[name] !== expected) {
      throw new Error(`LangGraph public Job runtime contract has invalid ${name}`);
    }
  }
  const maxRunMs = strictInteger(contract.max_run_ms, "max_run_ms");
  const terminalizationReserveMs = strictInteger(contract.terminalization_reserve_ms,
    "terminalization_reserve_ms", { allowZero: true });
  if (terminalizationReserveMs >= maxRunMs) {
    throw new Error("LangGraph public Job runtime contract has invalid terminalization reserve");
  }
  const publicDimensions = contract.budget_dimensions;
  if (!publicDimensions || typeof publicDimensions !== "object" || Array.isArray(publicDimensions)) {
    throw new Error("LangGraph public Job runtime contract has no budget_dimensions");
  }
  const expectedNames = Object.keys(LANGGRAPH_BUDGET_DIMENSIONS);
  if (!sameValue(Object.keys(publicDimensions).sort(), [...expectedNames].sort())) {
    throw new Error("LangGraph public Job runtime contract has incomplete or unknown budget dimensions");
  }
  const budgetLimits = {};
  const normalizedDimensions = {};
  for (const [name, expected] of Object.entries(LANGGRAPH_BUDGET_DIMENSIONS)) {
    const dimension = publicDimensions[name];
    if (!dimension || typeof dimension !== "object" || Array.isArray(dimension) ||
        dimension.unit !== expected.unit || dimension.native_enforcement !== true || dimension.observable !== true ||
        typeof dimension.enforcement_phase !== "string" || !dimension.enforcement_phase ||
        typeof dimension.measurement !== "string" || !dimension.measurement) {
      throw new Error(`LangGraph public Job runtime contract has invalid ${name} dimension`);
    }
    const limit = strictInteger(dimension.limit, `${name}.limit`);
    budgetLimits[expected.budget_key] = limit;
    normalizedDimensions[name] = { limit, unit: expected.unit, native_enforcement: true, observable: true,
      enforcement_phase: dimension.enforcement_phase, measurement: dimension.measurement };
  }
  if (budgetLimits.max_duration_seconds * 1000 + terminalizationReserveMs > maxRunMs) {
    throw new Error("LangGraph active duration and terminalization reserve exceed max_run_ms");
  }
  return Object.freeze({ supported: true, contract_version: LANGGRAPH_JOB_RUNTIME_CONTRACT,
    source: contract.source, max_run_ms: maxRunMs, terminalization_reserve_ms: terminalizationReserveMs,
    native_enforcement: true, cancellation_supported: false, terminal_status: contract.terminal_status,
    stop_semantics: contract.stop_semantics, budget_reason: contract.budget_reason,
    budget_limits: Object.freeze(budgetLimits), budget_dimensions: Object.freeze(normalizedDimensions) });
}

function agentHarnessNativeContract(capability, runtime) {
  const limits = runtime?.product_budget_limits;
  const budgetLimits = limits && typeof limits === "object" && !Array.isArray(limits) &&
    NATIVE_BUDGET_KEYS.every((name) => Number.isFinite(Number(limits[name])) && Number(limits[name]) > 0)
    ? Object.fromEntries(NATIVE_BUDGET_KEYS.map((name) => [name, Math.floor(Number(limits[name]))])) : null;
  const versions = {
    run_context: capability?.run_context_contract_version ?? runtime?.run_context_contract_version,
    run_budget: capability?.run_budget_contract_version ?? runtime?.run_budget_contract_version,
    run_usage: capability?.run_usage_contract_version ?? runtime?.run_usage_contract_version,
  };
  const versionsAgree = [[capability?.run_context_contract_version, runtime?.run_context_contract_version],
    [capability?.run_budget_contract_version, runtime?.run_budget_contract_version],
    [capability?.run_usage_contract_version, runtime?.run_usage_contract_version]]
    .every(([left, right]) => Boolean(left) && Boolean(right) && String(left) === String(right));
  return Object.freeze({ supported: capability?.native_run_context_supported === true &&
      runtime?.native_run_context_supported === true && versionsAgree && budgetLimits !== null,
    versions, budget_limits: budgetLimits });
}

function rawEvent(sourceSystem, ref, payload) {
  return { source_ref: ref, source_system: sourceSystem,
    recorded_at: payload?.created_at ?? payload?.timestamp ?? new Date().toISOString(),
    payload, payload_digest: digest(payload) };
}

function normalizedType(value) {
  const name = String(value ?? "").toLowerCase();
  if (/candidate|job.accept|task.receive|investigation.create/.test(name)) return "task.received";
  if (/investigation.start|run.start|worker.start/.test(name)) return "investigation.started";
  if (/tool.*fail|post_tool_failure|observation.*fail/.test(name)) return "candidate.tool.failed";
  if (/retry|recover|resume/.test(name)) return "candidate.recovery.observed";
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
    "verdict", "effective", "rolled_back", "status", "ok", "retryable", "attempt", "error_code",
    "scope_digest", "runtime_manifest_digest", "model_id", "stage", "stop_reason", "response_format"];
  return Object.fromEntries([["event_name", eventName], ["source_ref", sourceRef],
    ...allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])]);
}

function translate(events, sourceSystem, refOf, nameOf) {
  const raw = events.map((event, index) => rawEvent(sourceSystem, refOf(event, index), event));
  const normalized = raw.flatMap((item) => {
    const eventType = normalizedType(nameOf(item.payload));
    return eventType ? [{ event_type: eventType,
      actor: item.payload?.actor_id ?? item.payload?.source ?? sourceSystem,
      status: item.payload?.status ?? "RECORDED", raw_source_refs: [item.source_ref],
      payload: semanticPayload(item.payload, nameOf(item.payload), item.source_ref) }] : [];
  });
  return { raw, normalized };
}

function numericUsage(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
  const known = (value) => value && typeof value === "object" && !Array.isArray(value) && "status" in value
    ? String(value.status).toLowerCase() === "known" ? value.value : undefined
    : value;
  const values = {
    input_tokens: known(snapshot.input_tokens),
    output_tokens: known(snapshot.output_tokens),
    model_calls: known(snapshot.model_calls),
    tool_calls: known(snapshot.tool_calls),
    storage_bytes: known(snapshot.storage_bytes) ?? known(snapshot.result_bytes),
    cost_usd: known(snapshot.cost_usd) ?? (Number.isFinite(Number(known(snapshot.cost_microunits)))
      ? Number(known(snapshot.cost_microunits)) / 1_000_000 : undefined),
  };
  return Object.fromEntries(Object.entries(values).flatMap(([name, raw]) => {
    const number = Number(raw);
    return Number.isFinite(number) && number >= 0 ? [[name, number]] : [];
  }));
}

function exhaustedUsage(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
  const raw = snapshot.exhausted ?? snapshot.exhausted_dimensions ?? [];
  return [...new Set((Array.isArray(raw) ? raw : [raw])
    .map((item) => String(item ?? "").trim()).filter((item) => NATIVE_BUDGET_KEYS.includes(item)))];
}

function modelAttempt(event, index) {
  const payload = event?.public_payload ?? event?.payload ?? event ?? {};
  const snapshot = payload.output_snapshot ?? payload.model_usage ?? payload.usage ?? payload;
  const modelId = snapshot.model_id ?? payload.model_id;
  const usage = numericUsage(snapshot);
  const name = String(event?.event_type ?? event?.name ?? event?.action ?? "").toLowerCase();
  const errorType = String(payload.error_type ?? payload.error_code ?? payload.code ?? "").toLowerCase();
  const modelRelated = /agent[_\-.]?trace|model|deepseek/.test(`${name} ${errorType}`);
  if (!modelId && !Object.keys(usage).length && !modelRelated) return null;
  return { ref: event?.cursor ?? event?.sequence ?? index + 1,
    model_id: modelId ?? "unknown", stage: snapshot.stage ?? payload.stage ?? payload.node ?? "unknown",
    input_tokens: usage.input_tokens ?? null, output_tokens: usage.output_tokens ?? null,
    latency_ms: Number.isFinite(Number(snapshot.latency_ms)) ? Number(snapshot.latency_ms) : null,
    reasoning_mode: snapshot.reasoning_mode ?? payload.reasoning_mode ?? null,
    stop_reason: snapshot.stop_reason ?? payload.stop_reason ?? null,
    response_format: snapshot.response_format ?? payload.response_format ?? null,
    json_valid: snapshot.json_valid ?? payload.json_valid ?? null,
    success: !["failed", "error", "timeout"].includes(String(payload.status ?? "").toLowerCase()) };
}

function aggregateAttempts(attempts, key) {
  const result = {};
  for (const attempt of attempts) {
    const name = String(attempt[key] ?? "unknown");
    const item = result[name] ?? { model_calls: 0, input_tokens: 0, output_tokens: 0,
      input_tokens_complete: true, output_tokens_complete: true };
    item.model_calls += 1;
    if (attempt.input_tokens === null) item.input_tokens_complete = false;
    else item.input_tokens += attempt.input_tokens;
    if (attempt.output_tokens === null) item.output_tokens_complete = false;
    else item.output_tokens += attempt.output_tokens;
    result[name] = item;
  }
  return result;
}

function candidateUsageSnapshot({ authoritative = [], events = [], directToolCalls = null } = {}) {
  const values = {};
  const sources = {};
  const exhaustedDimensions = [];
  for (const { source, value } of authoritative) {
    for (const [name, number] of Object.entries(numericUsage(value))) {
      if (!Object.hasOwn(values, name)) { values[name] = number; sources[name] = source; }
    }
    exhaustedDimensions.push(...exhaustedUsage(value));
  }
  const eventToolCallRefs = new Set(events.flatMap((event, index) => {
    const name = String(event?.event_type ?? event?.name ?? event?.action ?? "").toLowerCase();
    if (name !== "tool.called") return [];
    const payload = event?.public_payload ?? event?.payload ?? event ?? {};
    return [String(payload.tool_use_id ?? payload.id ?? event.sequence ?? event.cursor ?? `event-${index}`)];
  }));
  const reportedToolCalls = Number.isFinite(Number(directToolCalls)) ? Number(directToolCalls) : null;
  const eventToolCalls = eventToolCallRefs.size ? eventToolCallRefs.size : null;
  if (!Object.hasOwn(values, "tool_calls") && (reportedToolCalls !== null || eventToolCalls !== null)) {
    values.tool_calls = Math.max(reportedToolCalls ?? 0, eventToolCalls ?? 0);
    sources.tool_calls = reportedToolCalls !== null && eventToolCalls !== null
      ? "candidate_public_tool_records_reconciled_with_events"
      : reportedToolCalls !== null ? "candidate_public_tool_records" : "candidate_public_tool_events";
  }
  const modelAttempts = events.map(modelAttempt).filter(Boolean);
  if (!Object.hasOwn(values, "model_calls") && modelAttempts.length) {
    values.model_calls = modelAttempts.length;
    sources.model_calls = "candidate_public_model_attempts";
  }
  for (const dimension of ["input_tokens", "output_tokens"]) {
    if (!Object.hasOwn(values, dimension) && modelAttempts.length && modelAttempts.every((item) => item[dimension] !== null)) {
      values[dimension] = modelAttempts.reduce((sum, item) => sum + item[dimension], 0);
      sources[dimension] = "candidate_public_model_attempts";
    }
  }
  const observedDimensions = USAGE_DIMENSIONS.filter((name) => Object.hasOwn(values, name));
  const totalsComplete = observedDimensions.length === USAGE_DIMENSIONS.length;
  const attemptBreakdownComplete = modelAttempts.every((item) => item.input_tokens !== null && item.output_tokens !== null);
  const complete = totalsComplete && attemptBreakdownComplete;
  return { contract: "evalos-candidate-usage.2", source: observedDimensions.length ? "candidate_public_api" : "unavailable",
    values, value_sources: sources, observed_dimensions: observedDimensions,
    unavailable_dimensions: USAGE_DIMENSIONS.filter((name) => !observedDimensions.includes(name)),
    totals_complete: totalsComplete, attempt_breakdown_complete: attemptBreakdownComplete,
    incomplete_model_attempt_refs: modelAttempts.filter((item) => item.input_tokens === null || item.output_tokens === null)
      .map((item) => item.ref),
    measurement_status: complete ? "COMPLETE"
      : observedDimensions.length ? "PARTIAL" : "UNAVAILABLE",
    complete, exhausted_dimensions: [...new Set(exhaustedDimensions)],
    by_model: aggregateAttempts(modelAttempts, "model_id"),
    by_stage: aggregateAttempts(modelAttempts, "stage"), model_attempts: modelAttempts };
}

function timeWindow(value) {
  const raw = String(value ?? "").trim();
  const [start_at, end_at, ...extra] = raw.split("/");
  const valid = extra.length === 0 && start_at && end_at && Number.isFinite(Date.parse(start_at)) &&
    Number.isFinite(Date.parse(end_at)) && Date.parse(start_at) < Date.parse(end_at);
  return valid ? { start_at, end_at, timezone: "Asia/Shanghai" } : { timezone: "Asia/Shanghai" };
}

function frozenEvaluationContext(executionContract) {
  const visible = executionContract.case.visible;
  const privateMaterial = { contract: "evalos-candidate-context.4", trial_id: executionContract.trial.id,
    case_ref: executionContract.trial.case_ref, environment_seed: executionContract.trial.environment_seed,
    replicate_id: executionContract.trial.replicate_id, dataset_ref: executionContract.dataset_ref,
    suite_ref: executionContract.suite_ref, evaluation_lane: executionContract.evaluation_lane,
    operating_mode: visible.operating_mode, execution_mode: executionContract.execution_mode,
    evalos_model: executionContract.model, budget: executionContract.budget,
    tool_contract_digest: digest(executionContract.tools ?? []), policy_digest: digest(executionContract.policy ?? {}),
    frozen_dependencies_digest: digest(executionContract.frozen_dependencies ?? {}) };
  return { ...privateMaterial, context_digest: digest(privateMaterial),
    environment_ref: `evalos-twin:${executionContract.trial.id}` };
}

function submissionReceipt({ runRef, expected, idempotencyKey, requestBody, channel }) {
  const material = { contract: "evalos-submission-receipt.2", run_ref: runRef,
    trial_id: expected.trial_id, context_digest: expected.context_digest,
    idempotency_key: idempotencyKey, request_digest: digest(requestBody), channel };
  return { ...material, receipt_digest: digest(material) };
}

function binding({ runRef, expected, nativeFields = {}, nativeRequired = [], evidenceChecks = {}, evidenceRequired = [] }) {
  const nativeChecks = Object.fromEntries(Object.entries(nativeFields).flatMap(([name, value]) => {
    if (value === undefined || value === null) return [];
    const expectedValue = name === "budget" ? expected.budget : expected[name];
    return [[name, sameValue(value, expectedValue)]];
  }));
  const nativeMismatches = Object.entries(nativeChecks).filter(([, passed]) => !passed).map(([name]) => name);
  const missingNative = nativeRequired.filter((name) => !Object.hasOwn(nativeChecks, name));
  const nativeComplete = nativeRequired.length > 0 && missingNative.length === 0 && nativeMismatches.length === 0;
  const evidenceMismatches = Object.entries(evidenceChecks).filter(([, passed]) => passed === false).map(([name]) => name);
  const missingEvidence = evidenceRequired.filter((name) => evidenceChecks[name] !== true);
  const evidenceComplete = evidenceRequired.length > 0 && missingEvidence.length === 0 && evidenceMismatches.length === 0;
  const strength = nativeMismatches.length ? "UNBOUND" : nativeComplete ? "PRODUCT_NATIVE_ACK"
    : evidenceComplete ? "EVIDENCE_CHAIN_BOUND" : "UNBOUND";
  return { contract: "evalos-product-run-binding.3", run_ref: runRef,
    expected_context_digest: expected.context_digest, binding_strength: strength,
    native_conformance: { required: nativeRequired, observed: Object.keys(nativeChecks), checks: nativeChecks,
      missing: missingNative, mismatches: nativeMismatches },
    evidence_chain: { required: evidenceRequired, checks: evidenceChecks, missing: missingEvidence,
      mismatches: evidenceMismatches }, complete: strength !== "UNBOUND" };
}

function stringList(value) {
  return (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
    .flatMap((item) => typeof item === "string" ? [item.trim()] : []).filter(Boolean);
}

function boundedConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number > 1 ? number / 100 : number)) : null;
}

function thinkingMode(value) {
  const mode = String(value ?? "unknown").toLowerCase();
  if (["disabled", "off", "false", "none"].includes(mode)) return "disabled";
  if (["unknown", ""].includes(mode)) return "unknown";
  return "enabled";
}

function gatePassed(gate) {
  if (!gate || typeof gate !== "object") return false;
  return gate.passed === true || ["passed", "confirmed"].includes(String(gate.status ?? gate.verdict ?? "").toLowerCase());
}

function leadingReportHypothesis(report) {
  const hypotheses = (report?.hypotheses ?? []).filter((item) => item && typeof item === "object");
  const leading = hypotheses.filter((item) => String(item.status ?? "").toLowerCase() === "leading");
  const viable = hypotheses.filter((item) => !["weakened", "rejected", "contradicted"]
    .includes(String(item.status ?? "").toLowerCase()));
  return (leading.length ? leading : viable).sort((left, right) =>
    (boundedConfidence(right.confidence) ?? -1) - (boundedConfidence(left.confidence) ?? -1))[0] ?? null;
}

function evidenceRefs(...sources) {
  const refs = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 7 || value === null || value === undefined) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (typeof value !== "object") return;
    for (const name of ["evidence_ref", "evidence_id", "id"]) stringList(value[name]).forEach((ref) => refs.add(ref));
    stringList(value.evidence_refs ?? value.evidence_ids ?? value.supporting_evidence_ids).forEach((ref) => refs.add(ref));
    for (const nested of Object.values(value)) if (nested && typeof nested === "object") visit(nested, depth + 1);
  };
  for (const source of sources) visit(source);
  return [...refs];
}

function authoritativeOutcome({ status, detail = {}, projection = null, events = [], product }) {
  const report = detail.report ?? {};
  const taskResult = projection?.task_result ?? detail.task_result ?? report.task_result ?? {};
  const gate = projection?.evidence_gate ?? detail.evidence_gate ?? report.evidence_gate ?? taskResult.evidence_gate;
  const taskOutcome = String(taskResult.task_outcome ?? taskResult.outcome ?? projection?.task_outcome ??
    detail.task_outcome ?? "").toLowerCase();
  const gateConclusion = String(gate?.effective_conclusion_status ?? gate?.status ?? "").toLowerCase();
  const rootCauseConfirmed = gatePassed(gate) && (product === "agent-harness"
    ? ["confirmed", "probable"].includes(gateConclusion)
    : ["root_cause_confirmed", "resolved", "completed", "success"].includes(taskOutcome));
  const leading = leadingReportHypothesis(report);
  const publishedRootCause = projection?.root_cause ?? taskResult.root_cause ?? report.root_cause ??
    detail.root_cause ?? leading?.cause ?? leading?.statement ??
    (typeof detail.conclusion === "string" ? detail.conclusion : null);
  const inconclusiveState = ["inconclusive", "insufficient_evidence", "waiting_data", "human_takeover", "denied",
    "budget_exhausted"].includes(String(status ?? "").toLowerCase());
  const failureRecovery = Array.isArray(projection?.failure_recovery) ? projection.failure_recovery : [];
  const recoveryFailure = failureRecovery.length > 0 || events.some((event) =>
    /fail|error|timeout/.test(String(event?.event_type ?? event?.name ?? "").toLowerCase()));
  const recoverySuccess = recoveryFailure && (failureRecovery.some((item) => item?.recovered === true ||
    ["recovered", "succeeded", "success"].includes(String(item?.status ?? item?.outcome ?? "").toLowerCase())) ||
    events.some((event) => /retry|recover|resume/.test(String(event?.event_type ?? event?.name ?? "").toLowerCase())));
  return { status: rootCauseConfirmed ? "resolved" : "inconclusive",
    root_cause: rootCauseConfirmed ? publishedRootCause : null,
    confidence: rootCauseConfirmed ? boundedConfidence(projection?.root_cause_confidence ?? taskResult.root_cause_confidence ??
      taskResult.confidence ?? leading?.confidence ?? report.confidence ?? detail.confidence) : 0,
    evidence_refs: evidenceRefs(projection?.evidence, detail.evidence, report),
    exclusions: stringList(taskResult.exclusions ?? report.exclusions),
    tool_failures_recovered: recoveryFailure ? recoverySuccess : null,
    next_checks: stringList(taskResult.next_checks ?? report.next_checks ?? report.missing_evidence ?? report.evidence_gaps),
    summary: taskResult.summary ?? report.summary ?? detail.summary ?? detail.conclusion ?? "",
    uncertainty: projection?.uncertainty ?? taskResult.uncertainty ?? report.uncertainty ?? detail.uncertainty ?? null,
    candidate_terminal_status: String(status ?? "").toLowerCase(),
    candidate_task_outcome: taskOutcome || null,
    evidence_gate: gate ?? null,
    evidence_gate_passed: gatePassed(gate),
    authoritative_source: product === "langgraph" ? "product_e2e.task_result" : "investigation.report.evidence_gate",
    safe_stop: !rootCauseConfirmed && inconclusiveState };
}

function terminalFailure(detail = {}, events = [], job = null) {
  const resultError = [...events].reverse().find((event) => {
    const name = String(event?.event_type ?? event?.name ?? event?.action ?? "").toLowerCase();
    const payload = event?.public_payload ?? event?.payload ?? {};
    return name === "agent.result_received" && payload.is_error === true;
  });
  const resultPayload = resultError?.public_payload ?? resultError?.payload ?? {};
  const exhaustedDimensions = [...new Set([
    ...exhaustedUsage(detail.usage), ...exhaustedUsage(detail.report?.usage),
  ])];
  const resultSubtype = String(resultPayload.subtype ?? resultPayload.error_type ?? "").toLowerCase();
  if (exhaustedDimensions.length || /budget/.test(resultSubtype)) {
    const dimensions = exhaustedDimensions.length ? exhaustedDimensions : [resultSubtype];
    return { code: "BUDGET_EXCEEDED",
      message: `candidate exhausted frozen budget: ${dimensions.join(",")}`,
      source_event: resultError?.event_type ?? resultError?.name ?? "candidate_usage" };
  }
  const failedEvent = [...events].reverse().find((event) => {
    const name = String(event?.event_type ?? event?.name ?? event?.action ?? "").toLowerCase();
    const payload = event?.public_payload ?? event?.payload ?? {};
    return /(?:failed|timeout|error|dead_letter)$/.test(name) || payload.is_error === true ||
      ["failed", "error", "timeout", "dead_letter"].includes(String(payload.status ?? "").toLowerCase());
  });
  const payload = failedEvent?.public_payload ?? failedEvent?.payload ?? {};
  const nested = payload.error && typeof payload.error === "object" ? payload.error : {};
  const detailError = detail.error && typeof detail.error === "object" ? detail.error : {};
  return { code: String(job?.error_code ?? detailError.code ?? detail.error_type ?? detail.error_code ??
      nested.code ?? payload.error_type ?? payload.code ?? "candidate_failed"),
    message: String(job?.last_error ?? job?.error_message ?? job?.error ?? detailError.message ?? detail.error_message ?? detail.failure_reason ??
      nested.message ?? payload.message ?? (typeof payload.error === "string" ? payload.error : null) ??
      detail.stop_reason ?? "真实考生以失败终态结束，但没有公开更具体的错误说明。"),
    source_event: failedEvent?.event_type ?? failedEvent?.name ?? failedEvent?.action ?? (job ? "job" : null) };
}

function productEvidence({ events, raw, artifactRefs = [], projectionRef = null, jobRef = null,
  failureRecovery = [] }) {
  const named = events.map((event, index) => ({ name: String(event?.event_type ?? event?.name ?? event?.action ?? "").toLowerCase(),
    ref: raw[index]?.source_ref ?? projectionRef })).filter((item) => item.ref);
  const find = (pattern, fallbacks = []) => named.find((item) => pattern.test(item.name))?.ref ?? fallbacks.find(Boolean) ?? null;
  const failedAt = named.findIndex((item) => /fail|error|timeout/.test(item.name));
  const recoveryApplicable = failedAt >= 0 || failureRecovery.length > 0;
  const recoveryRef = failedAt < 0 ? (failureRecovery.length ? projectionRef : null)
    : named.slice(failedAt + 1).find((item) => /retry|recover|resume/.test(item.name))?.ref ??
      (failureRecovery.length ? projectionRef : null);
  const entry = (ref, applicable = true) => ({ applicable, recorded: Boolean(ref), ref: ref ?? "" });
  return {
    queue: entry(find(/queue|job.accept|candidate|task.receive/, [jobRef])),
    worker: entry(find(/worker|run.start|investigation.start/, [jobRef])),
    recovery: entry(recoveryRef, recoveryApplicable),
    persistence: entry(find(/persist|checkpoint|journal|event/, [raw[0]?.source_ref])),
    audit: entry(find(/audit|policy|approval|event/, [projectionRef, raw[0]?.source_ref])),
    archive: entry(find(/archive|reconcil|report.delivery/, [artifactRefs[0] ? projectionRef ?? artifactRefs[0] : null])),
  };
}

function projectionEvidence(sourceSystem, sourceRef, projection) {
  if (!projection || typeof projection !== "object") return { raw: [], normalized: [] };
  const raw = [rawEvent(sourceSystem, sourceRef, projection)];
  const lifecycle = projection.action_lifecycle ?? {};
  const candidates = [["policy.decided", lifecycle.policy_decision], ["approval.decided", lifecycle.approval],
    ["ticket.issued", lifecycle.execution_ticket ?? lifecycle.ticket],
    ["action.executed", lifecycle.action_result ?? lifecycle.attempt],
    ["verification.completed", lifecycle.independent_verification ?? lifecycle.verification],
    ["rollback.executed", lifecycle.rollback], ["archive.reconciled", lifecycle.archive]];
  const normalized = candidates.flatMap(([eventType, item]) => item ? [{ event_type: eventType,
    actor: sourceSystem, status: item.status ?? "RECORDED", raw_source_refs: [sourceRef],
    payload: semanticPayload(item, eventType, sourceRef) }] : []);
  return { raw, normalized };
}

function discovery(attestation, architecture, capability, runtime, health, candidateRuntime,
  { nativeRunContextSupported = false, usageComplete = false } = {}) {
  return { candidate_kind: "REAL_PRODUCT", architecture, production_writes_available: false,
    source_revision: attestation.source_revision, artifact_digest: attestation.artifact_digest,
    capability_contract_digest: digest(capability), runtime_manifest_digest: digest(runtime),
    runtime_digest: digest({ architecture, capability_contract_digest: digest(capability),
      runtime_manifest_digest: digest(runtime) }), capability, runtime, health, candidate_runtime: candidateRuntime,
    native_run_context_supported: nativeRunContextSupported,
    usage_observability: { complete: usageComplete, policy: "reported_with_explicit_unknowns" } };
}

function agentHarnessSubmission(executionContract, nativeContract) {
  const context = frozenEvaluationContext(executionContract);
  const scope = executionContract.case.visible.scope ?? {};
  const candidateRuntime = executionContract.contestant.candidate_runtime;
  const limits = nativeContract?.budget_limits;
  if (nativeContract?.supported !== true || !limits) {
    throw new Error("Agent+Harness native run-context and budget contract is not publicly available");
  }
  const requestedBudget = Object.hasOwn(executionContract.budget, "max_duration_seconds")
    ? executionContract.budget : {
    max_duration_seconds: Number(executionContract.budget.wallclock_ms) / 1000,
    max_tool_calls: executionContract.budget.tool_calls,
    max_model_calls: executionContract.budget.model_calls,
    max_tokens: Number(executionContract.budget.input_tokens) + Number(executionContract.budget.output_tokens),
    max_cost_microunits: Number(executionContract.budget.cost_usd) * 1_000_000,
    max_result_bytes: executionContract.budget.storage_bytes };
  const budget = Object.fromEntries(NATIVE_BUDGET_KEYS.map((name) => {
    const requested = Math.floor(Number(requestedBudget[name]));
    const maximum = Math.floor(Number(limits[name]));
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > maximum) {
      throw new Error(`Agent+Harness requested native budget exceeds the public product limit: ${name}`);
    }
    return [name, requested];
  }));
  const runtimeVersion = candidateRuntime?.versions?.service;
  if (!runtimeVersion) throw new Error("Agent+Harness public service version is required for native run context");
  return { goal: executionContract.case.goal, trigger_type: "natural_language",
    source_ref: `evalos:${executionContract.trial.id}:${context.context_digest.slice(-16)}`, priority: 70,
    scope_hint: { customer_id: scope.customer_id, service_id: scope.service_id, site_id: scope.site_id,
      entity_ids: scope.entity_ids ?? scope.resource_ids ?? [], source_page: `/evalos/trials/${executionContract.trial.id}` },
    time_window: timeWindow(executionContract.case.visible.time_window), seed_evidence_refs: [], freshness: "fresh",
    run_context: { trial_id: executionContract.trial.id, context_digest: context.context_digest.replace(/^sha256:/, ""),
      environment_ref: context.environment_ref, runtime_version: runtimeVersion, budget } };
}

function langGraphSubmission(executionContract, nativeContract = null) {
  const context = frozenEvaluationContext(executionContract);
  const scope = executionContract.case.visible.scope ?? {};
  const productLimits = nativeContract?.supported === true ? nativeContract.budget_limits : {
    max_duration_seconds: 86400, max_tool_calls: 1000, max_model_calls: 1000,
    max_tokens: 10_000_000, max_cost_microunits: Number.MAX_SAFE_INTEGER,
    max_result_bytes: Number.MAX_SAFE_INTEGER };
  const requestedBudget = Object.hasOwn(executionContract.budget, "max_duration_seconds")
    ? executionContract.budget : {
      max_duration_seconds: Number(executionContract.budget.wallclock_ms) / 1000,
      max_tool_calls: executionContract.budget.tool_calls,
      max_model_calls: executionContract.budget.model_calls,
      max_tokens: Number(executionContract.budget.input_tokens) + Number(executionContract.budget.output_tokens),
      max_cost_microunits: Number(executionContract.budget.cost_usd) * 1_000_000,
      max_result_bytes: executionContract.budget.storage_bytes,
    };
  const budget = Object.fromEntries(NATIVE_BUDGET_KEYS.map((name) => {
    const requested = Math.floor(Number(requestedBudget[name]));
    const maximum = Math.floor(Number(productLimits[name]));
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > maximum) {
      throw new Error(`LangGraph requested native budget exceeds the public product limit: ${name}`);
    }
    return [name, requested];
  }));
  const allowedVersionNames = new Set(["graph_version", "state_schema_version", "mcp_contract_version",
    "knowledge_version", "model_version", "product_e2e_contract_version", "public_event_schema_version"]);
  const runtimeVersions = Object.fromEntries(Object.entries(executionContract.contestant.candidate_runtime?.versions ?? {})
    .filter(([name]) => allowedVersionNames.has(name)));
  return { goal: executionContract.case.goal, trigger_type: "user", title: `EvalOS ${executionContract.trial.id}`,
    resource_ids: scope.resource_ids ?? scope.entity_ids ?? [],
    service_ids: scope.service_ids ?? (scope.service_id ? [scope.service_id] : []),
    time_window: timeWindow(executionContract.case.visible.time_window), client_request_id: executionContract.trial.id,
    run_context: { trial_id: executionContract.trial.id, source_system: "evalos",
      contract_version: "evalos-product-run-binding.3", budget,
      environment_ref: context.environment_ref, context_digest: context.context_digest,
      runtime_versions: runtimeVersions } };
}

function listItems(page) {
  return Array.isArray(page) ? page : page?.items ?? page?.data ?? [];
}

async function readCursorPages({ api, pathname, cursorParam, nextField, itemCursorField,
  firstPage = null, initialCursor = 0, pageSize = 1000, maxPages = 128 }) {
  const items = [];
  let cursor = Number(initialCursor) || 0;
  let page = firstPage;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    page ??= await api.request(`${pathname}?${cursorParam}=${cursor}&limit=${pageSize}`);
    const batch = listItems(page);
    items.push(...batch);
    const hasMore = page?.has_more === true || page?.hasMore === true ||
      (page?.has_more !== false && page?.hasMore !== false && batch.length >= pageSize);
    if (!hasMore || batch.length === 0) return items;
    const next = Number(page?.[nextField] ?? batch.at(-1)?.[itemCursorField]);
    if (!Number.isFinite(next) || next <= cursor) {
      throw new Error(`candidate product cursor pagination did not advance for ${pathname}`);
    }
    cursor = next;
    page = null;
  }
  throw new Error(`candidate product cursor pagination exceeded ${maxPages} pages for ${pathname}`);
}

function eventPayload(event) {
  return event?.public_payload ?? event?.payload ?? event ?? {};
}

export function createAgentHarnessProductConnectorV5({ origin, token, approvalToken, adminToken, tenantId, attestation,
  requestTransport = null, requestTimeoutMs = 30000, declaredRuntimeLimits = null,
  declaredCandidateRuntime = null } = {}) {
  if (!tenantId) throw new Error("Agent+Harness evaluation tenant id is required");
  assertSeparatedIdentities(token, approvalToken, adminToken, requestTransport);
  const tenantHeaders = { "x-tenant-id": tenantId };
  const api = client(origin, token, requestTimeoutMs, tenantHeaders, requestTransport, "candidate_submitter");
  const approvalApi = client(origin, approvalToken, requestTimeoutMs, tenantHeaders, requestTransport, "approval_oracle");
  const adminApi = client(origin, adminToken, requestTimeoutMs, tenantHeaders, requestTransport, "mode_administrator");
  const frozen = assertAttestation(attestation);
  const runtimeLimits = deploymentLimits(declaredRuntimeLimits);
  const runs = new Map();
  let latestNativeContract = null;
  return Object.freeze({
    kind: "agent-harness-product-api-v5",
    async evaluationReadiness() {
      const [submitter, approver, administrator, protocolLab, capability, runtime] = await Promise.all([
        api.request("/v2/auth/me"), approvalApi.request("/v2/auth/me"), adminApi.request("/v2/auth/me"),
        api.request("/v2/protocol-lab"), api.request("/v2/capabilities"), api.request("/v2/investigation-runtime")]);
      latestNativeContract = agentHarnessNativeContract(capability, runtime);
      const identitiesSeparated = distinct([submitter.user_id, approver.user_id, administrator.user_id]);
      const tenantBound = [submitter, approver, administrator].every((principal) => tenantScoped(principal, tenantId, "agent-harness"));
      const submitterScoped = permission(submitter, "investigate") && !permission(submitter, "approve_action") &&
        !permission(submitter, "manage_users") && !permission(submitter, "manage_roles");
      const approverScoped = permission(approver, "approve_action") && !permission(approver, "investigate") &&
        !permission(approver, "manage_users") && !permission(approver, "manage_roles");
      const administratorScoped = permission(administrator, "manage_roles") || permission(administrator, "platform_admin");
      const twinReady = protocolLab.configured === true && protocolLab.connected === true;
      const publicMaxRunMs = latestNativeContract.supported
        ? latestNativeContract.budget_limits.max_duration_seconds * 1000 : null;
      const deploymentDeclarationMatches = !runtimeLimits.observable ||
        runtimeLimits.max_run_ms === publicMaxRunMs;
      const openResourcePolicy = publicOpenResourcePolicy(capability.open_resource_policy, runtime.open_resource_policy);
      return { credential_roles: ["candidate_submitter", "approval_oracle", "mode_administrator"],
        identities_separated: identitiesSeparated, least_privilege: submitterScoped && approverScoped && administratorScoped,
        tenant_bound: tenantBound, isolated_tenant_slots: 1, safe_parallelism: 1,
        credential_checks: { distinct_subjects: identitiesSeparated, submitter_least_privilege: submitterScoped,
          approver_least_privilege: approverScoped, administrator_authorized: administratorScoped },
        external_twin_ready: twinReady, twin: { configured: protocolLab.configured === true,
          connected: protocolLab.connected === true, slot_id: protocolLab.slot_id ?? null,
          roles: protocolLab.roles ?? [], summary: protocolLab.summary ?? null },
        budget_contract: { ...runtimeLimits, observable: latestNativeContract.supported,
          max_run_ms: publicMaxRunMs, native_enforcement: latestNativeContract.supported,
          deployment_declaration_matches: deploymentDeclarationMatches,
          dimensions: latestNativeContract.budget_limits,
          open_resource_policy: openResourcePolicy,
          source: latestNativeContract.supported ? "candidate_public_investigation_runtime" : runtimeLimits.source },
        production_writes_available: false };
    },
    async discover() {
      const [capability, runtime, modelProfile, health, safety] = await Promise.all([
        api.request("/v2/capabilities"), api.request("/v2/investigation-runtime"),
        api.request("/v2/model-profile"), api.request("/health"), api.request("/v2/remediation/context")]);
      const observedCandidateRuntime = { contract_version: "1.0", models: [{
        provider: modelProfile.provider ?? health.provider ?? "deepseek",
        id: modelProfile.model ?? modelProfile.model_id ?? runtime.model ?? health.model,
        interface: modelProfile.interface ?? modelProfile.protocol ?? runtime.sdk_execution_api ?? "anthropic",
        thinking: thinkingMode(modelProfile.thinking_mode ?? runtime.thinking_mode),
        roles: modelProfile.roles ?? ["investigation"],
      }], versions: { service: String(health.version ?? capability.service_version ?? "unknown"),
        investigation: String(capability.investigation_schema_version ?? capability.investigation_contract_version ?? "unknown"),
        report: String(capability.report_delivery_contract_version ?? capability.report_contract_version ?? "unknown"),
        protocol_binding: String(capability.protocol_lab_binding_contract_version ?? capability.protocol_binding_version ?? "unknown"),
        ...(capability.protocol_tool_loading?.contract_version ? {
          protocol_tool_loading: String(capability.protocol_tool_loading.contract_version),
        } : {}),
        ...(capability.identifier_scope_contract?.contract_version ? {
          identifier_scope: String(capability.identifier_scope_contract.contract_version),
        } : {}),
        ...(capability.native_tool_availability?.contract_version ? {
          native_tool_availability: String(capability.native_tool_availability.contract_version),
        } : {}),
        run_context: String(capability.run_context_contract_version ?? runtime.run_context_contract_version ?? "unknown"),
        run_budget: String(capability.run_budget_contract_version ?? runtime.run_budget_contract_version ?? "unknown"),
        run_usage: String(capability.run_usage_contract_version ?? runtime.run_usage_contract_version ?? "unknown") } };
      if (declaredCandidateRuntime && !sameValue(declaredCandidateRuntime, observedCandidateRuntime)) {
        throw new Error("candidate discovery drift: declared Agent+Harness candidate_runtime");
      }
      const candidateRuntime = declaredCandidateRuntime ?? observedCandidateRuntime;
      latestNativeContract = agentHarnessNativeContract(capability, runtime);
      const stableRuntime = { execution_api: runtime.sdk_execution_api, execution_mode: runtime.execution_mode,
        thinking_mode: runtime.thinking_mode, reasoning_effort: runtime.reasoning_effort,
        concurrency_limit: runtime.concurrency_limit, queue_policy: runtime.queue_policy,
        heartbeat_interval_seconds: runtime.heartbeat_interval_seconds,
        safety_framework_version: safety.safety_framework_version ?? safety.contract_version,
        native_run_context_supported: latestNativeContract.supported,
        run_context_contract_version: latestNativeContract.versions.run_context,
        run_budget_contract_version: latestNativeContract.versions.run_budget,
        run_usage_contract_version: latestNativeContract.versions.run_usage,
        product_budget_limits: latestNativeContract.budget_limits,
        capability_versions: candidateRuntime.versions, production_writes_available: false };
      return discovery(frozen, "CLAUDE_AGENT_SDK_HARNESS", capability, stableRuntime,
        { status: health.status ?? "reachable", active_count: runtime.active_count,
          queued_count: runtime.queued_count, available_slots: runtime.available_slots }, candidateRuntime,
        { nativeRunContextSupported: latestNativeContract.supported, usageComplete: false });
    },
    async prepare({ executionContract }) {
      const operatingMode = executionContract.case.visible.operating_mode;
      await adminApi.request("/v2/remediation/mode", { method: "PUT", body: {
        operating_mode: operatingMode, execution_mode: executionContract.execution_mode } });
      return { tenant_id: tenantId, operating_mode: operatingMode,
        execution_mode: executionContract.execution_mode, production_writes_available: false };
    },
    async start({ executionContract }) {
      const requestBody = agentHarnessSubmission(executionContract, latestNativeContract);
      const result = await api.request("/v2/investigation-candidates", { method: "POST", body: requestBody });
      const candidate = result.candidate ?? result;
      const runRef = result.investigation_id ?? result.linked_investigation_id ?? candidate.linked_investigation_id;
      if (!runRef) throw new Error("Agent+Harness product did not create a real investigation");
      const expected = { trial_id: requestBody.run_context.trial_id,
        context_digest: requestBody.run_context.context_digest,
        environment_ref: requestBody.run_context.environment_ref,
        runtime_version: requestBody.run_context.runtime_version,
        budget: requestBody.run_context.budget, native: true,
        run_context_contract_version: latestNativeContract.versions.run_context,
        run_budget_contract_version: latestNativeContract.versions.run_budget,
        run_usage_contract_version: latestNativeContract.versions.run_usage };
      runs.set(runRef, { expected, requestBody, candidate_id: candidate.candidate_id ?? result.candidate_id ?? null });
      return { run_ref: runRef, status: "RUNNING", cursor: 0,
        binding_receipt: submissionReceipt({ runRef, expected, requestBody,
          idempotencyKey: requestBody.source_ref, channel: "agent-harness:/v2/investigation-candidates" }) };
    },
    async observe({ runRef, cursor = 0, executionContract }) {
      const logPath = `/v2/investigations/${encodeURIComponent(runRef)}/execution-log`;
      const [detail, log, actionPage, candidatePage] = await Promise.all([
        api.request(`/v2/investigations/${encodeURIComponent(runRef)}`),
        api.request(`${logPath}?after_sequence=${Number(cursor) || 0}&limit=1000`),
        api.request("/v2/actions?limit=500"), api.request("/v2/investigation-candidates")]);
      const state = String(detail.status ?? "").toLowerCase();
      const terminal = ["resolved", "inconclusive", "insufficient_evidence", "failed", "cancelled", "budget_exhausted"].includes(state);
      const events = terminal ? await readCursorPages({ api, pathname: logPath, cursorParam: "after_sequence",
        nextField: "next_sequence", itemCursorField: "sequence", initialCursor: 0,
        firstPage: Number(cursor) === 0 ? log : null }) : listItems(log);
      const translated = translate(events, "agent-harness-product",
        (event, index) => `agent-harness:${event.sequence ?? Number(cursor) + index + 1}`,
        (event) => event.event_type ?? event.name ?? event.action);
      const actions = listItems(actionPage).filter((item) => item.investigation_id === runRef);
      const approvalRequests = actions.filter((item) => ["awaiting_approval", "human_approval_required", "prechecked"].includes(item.status))
        .map((item) => ({ request_ref: `agent-harness-approval:${item.action_id}`, action_id: item.action_id,
          proposal: item, proposal_digest: item.proposal_digest, scope: item.scope, policy_decision: item.policy_decision }));
      const fallbackRequest = runs.has(runRef) ? null : agentHarnessSubmission(executionContract, latestNativeContract);
      const run = runs.get(runRef) ?? { expected: { trial_id: fallbackRequest.run_context.trial_id,
        context_digest: fallbackRequest.run_context.context_digest,
        environment_ref: fallbackRequest.run_context.environment_ref,
        runtime_version: fallbackRequest.run_context.runtime_version, budget: fallbackRequest.run_context.budget,
        native: true, run_context_contract_version: latestNativeContract.versions.run_context,
        run_budget_contract_version: latestNativeContract.versions.run_budget,
        run_usage_contract_version: latestNativeContract.versions.run_usage },
        requestBody: fallbackRequest, candidate_id: detail.candidate_id ?? null };
      const candidateRecord = listItems(candidatePage).find((item) => item.candidate_id === (detail.candidate_id ?? run.candidate_id) ||
        item.linked_investigation_id === runRef || item.investigation_id === runRef) ?? null;
      const candidateId = detail.candidate_id ?? run.candidate_id ?? candidateRecord?.candidate_id ?? null;
      const boundEvent = events.find((event) => /protocol_lab\.trial_bound/i.test(String(event.event_type ?? event.name ?? "")));
      const boundPayload = eventPayload(boundEvent);
      const evidenceChecks = { candidate_record_found: Boolean(candidateRecord),
        source_ref: candidateRecord ? candidateRecord.source_ref === run.requestBody.source_ref : false,
        linked_investigation: candidateRecord ? (candidateRecord.linked_investigation_id ?? candidateRecord.investigation_id) === runRef : false,
        investigation_candidate_id: Boolean(candidateId && candidateRecord?.candidate_id === candidateId) };
      if (boundPayload.evalos_trial_id !== undefined) evidenceChecks.protocol_evalos_trial_id = boundPayload.evalos_trial_id === run.expected.trial_id;
      if (boundPayload.context_digest !== undefined) evidenceChecks.protocol_context_digest = boundPayload.context_digest === run.expected.context_digest;
      if (boundPayload.binding_fingerprint !== undefined) {
        evidenceChecks.protocol_binding_fingerprint = String(boundPayload.binding_fingerprint)
          .endsWith(run.expected.context_digest.slice(-16));
      }
      const nativeContext = detail.run_context ?? candidateRecord?.run_context ?? {};
      const nativeAck = detail.run_context_ack ?? candidateRecord?.run_context_ack ?? {};
      const nativeFields = { trial_id: nativeContext.trial_id, context_digest: nativeContext.context_digest,
        environment_ref: nativeContext.environment_ref, runtime_version: nativeContext.runtime_version,
        budget: nativeAck.actual_budget ?? nativeContext.budget, native: nativeAck.native,
        run_context_contract_version: nativeAck.contract_version,
        run_budget_contract_version: nativeAck.budget_contract_version,
        run_usage_contract_version: nativeAck.usage_contract_version ?? detail.usage?.contract_version };
      const evaluationBinding = terminal ? binding({ runRef, expected: run.expected, nativeFields,
        nativeRequired: ["trial_id", "context_digest", "environment_ref", "runtime_version", "budget", "native",
          "run_context_contract_version", "run_budget_contract_version", "run_usage_contract_version"] }) : null;
      const bindingRaw = terminal && candidateRecord
        ? [rawEvent("agent-harness-product", `agent-harness:candidate:${candidateRecord.candidate_id}`, candidateRecord)] : [];
      const delivery = detail.report?.delivery_receipt;
      const reportRef = detail.report_ref ?? delivery?.uri ?? detail.report?.archive_uri ??
        (delivery?.delivery_id ? `agent-harness:report-delivery:${delivery.delivery_id}` : null);
      const reportRaw = terminal && (detail.report || reportRef)
        ? [rawEvent("agent-harness-product", `agent-harness:report:${runRef}`, { report_ref: reportRef, report: detail.report })] : [];
      const evidenceRaw = terminal && Array.isArray(detail.evidence)
        ? detail.evidence.filter((item) => item && typeof item === "object").map((item, index) =>
          rawEvent("agent-harness-product",
            `agent-harness:evidence:${runRef}:${item.evidence_id ?? index + 1}`, item))
        : [];
      const allRaw = [...translated.raw, ...bindingRaw, ...reportRaw, ...evidenceRaw];
      const status = terminal ? state === "failed" ? "FAILED" : state === "cancelled" ? "CANCELLED"
        : ["inconclusive", "insufficient_evidence", "budget_exhausted"].includes(state) ? "INCONCLUSIVE" : "COMPLETED" : "RUNNING";
      return { run_ref: runRef, status, next_cursor: log.next_sequence ?? cursor, raw_events: allRaw,
        normalized_events: translated.normalized, approval_requests: approvalRequests,
        outcome: terminal ? authoritativeOutcome({ status: state, detail, events, product: "agent-harness" }) : null,
        product_evidence: terminal ? productEvidence({ events, raw: translated.raw,
          artifactRefs: [reportRef].filter(Boolean), projectionRef: reportRaw[0]?.source_ref,
          jobRef: bindingRaw[0]?.source_ref }) : null,
        evaluation_binding: evaluationBinding,
        candidate_usage: candidateUsageSnapshot({ authoritative: [
          { source: "investigation.usage", value: detail.usage },
          { source: "report.usage", value: detail.report?.usage }], events,
        directToolCalls: Array.isArray(detail.tool_calls) ? detail.tool_calls.length : null }),
        error: state === "failed" ? terminalFailure(detail, events) : null,
        artifact_refs: [reportRef].filter(Boolean) };
    },
    async respondApproval({ request, decision }) {
      return approvalApi.request(`/v2/actions/${encodeURIComponent(request.action_id)}/approval`, { method: "POST",
        body: { decision: decision.decision === "APPROVE" ? "approved" : "rejected", comment: decision.reason_zh } });
    },
    async probeRun({ runRef }) {
      const detail = await api.request(`/v2/investigations/${encodeURIComponent(runRef)}`);
      const rawStatus = String(detail.status ?? "").toLowerCase();
      const status = rawStatus === "resolved" ? "COMPLETED"
        : ["inconclusive", "insufficient_evidence", "budget_exhausted"].includes(rawStatus) ? "INCONCLUSIVE"
          : rawStatus === "failed" ? "FAILED" : rawStatus === "cancelled" ? "CANCELLED" : "RUNNING";
      return { run_ref: runRef, status, terminal: status !== "RUNNING", raw_status: rawStatus };
    },
    async finalize({ runRef }) {
      try {
        const result = await api.request(`/v2/investigations/${encodeURIComponent(runRef)}/protocol-lab/reset`, {
          method: "POST", body: {} });
        return { ok: true, run_ref: runRef, cleanup_owner: "candidate_product",
          strategy: "candidate_protocol_lab_reset", candidate_reset: true,
          evalos_authoritative_reset_pending: true, result };
      } catch (error) {
        if (/HTTP 404:.*PROTOCOL_TRIAL_NOT_FOUND/.test(error?.message ?? "")) {
          return { ok: true, run_ref: runRef, cleanup_owner: "external_controller",
            strategy: "no_candidate_protocol_trial", candidate_reset: false,
            evalos_authoritative_reset_pending: true, reason: "candidate_run_did_not_attach_protocol_trial" };
        }
        throw error;
      }
    },
    async cancel() { return { supported: false, reason: "candidate-product-does-not-expose-cancel-api" }; },
  });
}

function langGraphStatus(state) {
  if (state === "completed") return "COMPLETED";
  if (["insufficient_evidence", "human_takeover", "denied", "budget_exhausted", "inconclusive"].includes(state)) return "INCONCLUSIVE";
  if (["failed", "dead_letter"].includes(state)) return "FAILED";
  if (state === "cancelled") return "CANCELLED";
  return "RUNNING";
}

export function createLangGraphProductConnectorV5({ origin, token, approvalToken, adminToken, tenantId, attestation,
  requestTransport = null, requestTimeoutMs = 30000, declaredRuntimeLimits = null,
  declaredCandidateRuntime = null } = {}) {
  if (!tenantId) throw new Error("LangGraph evaluation tenant id is required");
  assertSeparatedIdentities(token, approvalToken, adminToken, requestTransport);
  const tenantHeaders = { "x-tenant-id": tenantId };
  const api = client(origin, token, requestTimeoutMs, tenantHeaders, requestTransport, "candidate_submitter");
  const approvalApi = client(origin, approvalToken, requestTimeoutMs, tenantHeaders, requestTransport, "approval_oracle");
  const adminApi = client(origin, adminToken, requestTimeoutMs, tenantHeaders, requestTransport, "mode_administrator");
  const frozen = assertAttestation(attestation);
  const runtimeLimits = deploymentLimits(declaredRuntimeLimits);
  let latestNativeContract = null;
  const runs = new Map();
  const runStates = new Map();
  return Object.freeze({
    kind: "langgraph-product-api-v5",
    async evaluationReadiness() {
      const [submitter, approver, administrator, ready, automation] = await Promise.all([
        api.request("/api/v1/me"), approvalApi.request("/api/v1/me"), adminApi.request("/api/v1/me"),
        api.request("/health/ready"), api.request("/api/v1/automation/overview")]);
      latestNativeContract = langGraphNativeContract(automation);
      const submitterRoles = roleSet(submitter);
      const approverRoles = roleSet(approver);
      const administratorRoles = roleSet(administrator);
      const identitiesSeparated = distinct([submitter.subject, approver.subject, administrator.subject]);
      const tenantBound = [submitter, approver, administrator].every((principal) => tenantScoped(principal, tenantId, "langgraph"));
      const submitterScoped = (submitterRoles.has("on_call") || submitterRoles.has("tenant_admin")) &&
        !submitterRoles.has("platform_admin") && !submitterRoles.has("approver");
      const approverScoped = (approverRoles.has("approver") || approverRoles.has("tenant_admin")) &&
        !approverRoles.has("platform_admin") && !approverRoles.has("on_call");
      const administratorScoped = administratorRoles.has("tenant_admin") || administratorRoles.has("platform_admin");
      const twinConnector = (ready.connectors ?? []).find((item) =>
        /(?:open5gs|ueransim|protocol-lab)/i.test(String(item.connector_id ?? item.name ?? "")));
      const externalTwinReady = Boolean(twinConnector) && ["healthy", "ready", "ok"]
        .includes(String(twinConnector.status ?? "").toLowerCase());
      const deploymentDeclarationMatches = !runtimeLimits.observable ||
        runtimeLimits.max_run_ms === latestNativeContract.max_run_ms;
      const openResourcePolicy = publicOpenResourcePolicy(automation.open_resource_policy);
      return { credential_roles: ["candidate_submitter", "approval_oracle", "mode_administrator"],
        identities_separated: identitiesSeparated, least_privilege: submitterScoped && approverScoped && administratorScoped,
        tenant_bound: tenantBound, isolated_tenant_slots: 1, safe_parallelism: 1,
        credential_checks: { distinct_subjects: identitiesSeparated, submitter_least_privilege: submitterScoped,
          approver_least_privilege: approverScoped, administrator_authorized: administratorScoped },
        external_twin_ready: externalTwinReady,
        twin: { configured: Boolean(twinConnector), connected: externalTwinReady,
          connector_id: twinConnector?.connector_id ?? twinConnector?.name ?? null,
          status: twinConnector?.status ?? null, summary: twinConnector?.public_message ?? null },
        budget_contract: { observable: true, max_run_ms: latestNativeContract.max_run_ms,
          native_enforcement: true, cancellation_supported: latestNativeContract.cancellation_supported,
          deployment_declaration_matches: deploymentDeclarationMatches,
          dimensions: latestNativeContract.budget_limits,
          dimension_metadata: latestNativeContract.budget_dimensions,
          open_resource_policy: openResourcePolicy,
          terminalization_reserve_ms: latestNativeContract.terminalization_reserve_ms,
          terminal_status: latestNativeContract.terminal_status,
          stop_semantics: latestNativeContract.stop_semantics,
          budget_reason: latestNativeContract.budget_reason,
          source: "candidate_public_automation_overview" }, production_writes_available: false };
    },
    async discover() {
      const [ready, automation] = await Promise.all([api.request("/health/ready"), api.request("/api/v1/automation/overview")]);
      latestNativeContract = langGraphNativeContract(automation);
      const observedVersions = { graph_version: automation.graph_version ?? ready.graph_version,
        state_schema_version: automation.state_schema_version ?? ready.state_schema_version,
        mcp_contract_version: automation.mcp_contract_version ?? ready.mcp_contract_version,
        knowledge_version: automation.knowledge_version ?? automation.knowledge_contract_version ?? ready.knowledge_version,
        model_version: automation.model_version ?? ready.model_version,
        product_e2e_contract_version: automation.product_e2e_contract_version ?? ready.product_e2e_contract_version,
        public_event_schema_version: automation.public_event_schema_version ?? ready.public_event_schema_version,
        job_runtime_limits_contract_version: latestNativeContract.contract_version };
      const versions = Object.fromEntries(Object.entries(observedVersions)
        .filter(([, value]) => value !== undefined && value !== null).map(([name, value]) => [name, String(value)]));
      const publicModels = automation.model_portfolio ?? ready.model_portfolio ?? automation.models ?? ready.models ?? [];
      const models = (Array.isArray(publicModels) ? publicModels : Object.values(publicModels)).map((item) => ({
        provider: item.provider ?? "deepseek", id: item.model_id ?? item.id ?? item.model,
        interface: item.interface ?? item.api_style ?? "unknown",
        thinking: thinkingMode(item.thinking ?? item.thinking_mode),
        roles: item.roles ?? (item.role ? [item.role] : ["unknown"]),
      })).filter((item) => item.id);
      const observedCandidateRuntime = { contract_version: "1.0", models, versions };
      if (declaredCandidateRuntime && !sameValue(declaredCandidateRuntime, observedCandidateRuntime)) {
        throw new Error("candidate discovery drift: declared LangGraph candidate_runtime");
      }
      const candidateRuntime = declaredCandidateRuntime ?? observedCandidateRuntime;
      const capability = { architecture_type: ready.architecture_type,
        operating_modes: automation.operating_modes ?? ["diagnosis_only", "human_collaboration", "controlled_auto"],
        execution_modes: automation.execution_modes ?? ["controlled_simulation", "replay_read_only"],
        external_run_context: true, native_budget_enforcement: true,
        job_runtime_limits_contract_version: latestNativeContract.contract_version,
        production_writes_available: false };
      const stableRuntime = { architecture_type: ready.architecture_type,
        connector_manifest: (ready.connectors ?? []).map((item) => ({ name: item.name ?? item.connector_id,
          kind: item.kind ?? item.connector_type, required: item.required ?? null })),
        safety_framework_version: automation.safety_framework_version,
        versions: candidateRuntime.versions, model_portfolio: candidateRuntime.models,
        job_runtime_limits: { contract_version: latestNativeContract.contract_version,
          source: latestNativeContract.source, max_run_ms: latestNativeContract.max_run_ms,
          terminalization_reserve_ms: latestNativeContract.terminalization_reserve_ms,
          native_enforcement: latestNativeContract.native_enforcement,
          cancellation_supported: latestNativeContract.cancellation_supported,
          terminal_status: latestNativeContract.terminal_status,
          stop_semantics: latestNativeContract.stop_semantics,
          budget_reason: latestNativeContract.budget_reason,
          budget_dimensions: latestNativeContract.budget_dimensions },
        external_cleanup_owner: "external_controller",
        production_writes_available: false };
      return discovery(frozen, "LANGGRAPH_PRODUCT", capability, stableRuntime,
        { status: ready.status ?? (ready.ready === true ? "ready" : "not_ready"),
          connector_states: (ready.connectors ?? []).map((item) => ({ name: item.name ?? item.connector_id,
            status: item.status })) }, candidateRuntime, { nativeRunContextSupported: true, usageComplete: true });
    },
    async prepare({ executionContract }) {
      const operatingMode = executionContract.case.visible.operating_mode;
      await adminApi.request("/api/v1/automation/mode", { method: "PUT", body: { operating_mode: operatingMode,
        execution_mode: executionContract.execution_mode, production_write_enabled: false,
        reason: `EvalOS冻结Trial ${executionContract.trial.id} 切换受控评测模式。` } });
      return { tenant_id: tenantId, operating_mode: operatingMode,
        execution_mode: executionContract.execution_mode, production_writes_available: false };
    },
    async start({ executionContract }) {
      if (latestNativeContract?.supported !== true) {
        throw new Error("LangGraph native Job runtime limits must be discovered before starting a Trial");
      }
      const requestBody = langGraphSubmission(executionContract, latestNativeContract);
      const result = await api.request("/api/v1/candidates", { method: "POST", body: requestBody });
      const runRef = result.investigation?.investigation_id ?? result.investigation_id;
      if (!runRef) throw new Error("LangGraph product did not create a real investigation");
      const expected = frozenEvaluationContext(executionContract);
      runs.set(runRef, { expected, requestBody, job_id: result.job?.job_id ?? result.job_id ?? null });
      return { run_ref: runRef, status: "RUNNING", cursor: 0,
        binding_receipt: submissionReceipt({ runRef, expected, requestBody,
          idempotencyKey: requestBody.client_request_id, channel: "langgraph:/api/v1/candidates" }) };
    },
    async observe({ runRef, cursor = 0, executionContract }) {
      const journalPath = `/api/v1/investigations/${encodeURIComponent(runRef)}/journal`;
      const [detail, journal, projection, jobsPage] = await Promise.all([
        api.request(`/api/v1/investigations/${encodeURIComponent(runRef)}`),
        api.request(`${journalPath}?after_cursor=${Number(cursor) || 0}&limit=1000`),
        api.request(`/api/v1/investigations/${encodeURIComponent(runRef)}/product-e2e`),
        api.request("/api/v1/jobs?limit=200")]);
      const run = runs.get(runRef) ?? { expected: frozenEvaluationContext(executionContract),
        requestBody: langGraphSubmission(executionContract, latestNativeContract), job_id: null };
      const jobs = listItems(jobsPage);
      const job = jobs.find((item) => item.job_id === run.job_id || item.investigation_id === runRef ||
        item.run_id === projection.run_id) ?? null;
      const jobState = String(job?.status ?? "").toLowerCase();
      const detailState = String(detail.status ?? "").toLowerCase();
      const semanticStatus = ["dead_letter", "failed"].includes(jobState) ? "FAILED"
        : jobState === "cancelled" ? "CANCELLED" : langGraphStatus(detailState);
      const semanticTerminal = semanticStatus !== "RUNNING";
      const incrementalEvents = listItems(journal);
      const events = semanticTerminal ? await readCursorPages({ api, pathname: journalPath,
        cursorParam: "after_cursor", nextField: "next_cursor", itemCursorField: "cursor", initialCursor: 0,
        firstPage: Number(cursor) === 0 ? journal : null }) : incrementalEvents;
      const publicEvents = projection.public_events ?? events;
      const allEvents = publicEvents.length >= events.length ? publicEvents : events;
      const translated = translate(events, "langgraph-product",
        (event, index) => `langgraph:${event.cursor ?? Number(cursor) + index + 1}`,
        (event) => event.event_type ?? event.name ?? event.action);
      const lifecycle = projection.action_lifecycle;
      const approvalRequests = detailState === "waiting_approval" && lifecycle?.proposal ? [{
        request_ref: `langgraph-approval:${lifecycle.proposal.action_id}`, action_id: lifecycle.proposal.action_id,
        proposal: lifecycle.proposal, proposal_digest: lifecycle.proposal.proposal_digest,
        environment_snapshot_digest: lifecycle.environment_snapshot?.snapshot_digest,
        policy_decision_id: lifecycle.policy_decision?.decision_id, scope: lifecycle.proposal.scope_snapshot_id }] : [];
      const handoffEvent = allEvents.find((event) => {
        const payload = eventPayload(event);
        return /external[-_.]cleanup[-_.]handoff|cleanup.*external_controller/i
          .test(String(event.event_type ?? event.name ?? event.action ?? event.actor_id ?? "")) ||
          payload.cleanup_owner === "external_controller";
      });
      const archiveRefs = (projection.archive_artifacts ?? []).map((item) => item.uri ?? item.object_key ?? item.artifact_id).filter(Boolean);
      const archiveReady = projection.archive_reconciled === true && archiveRefs.length > 0;
      const jobTerminal = ["completed", "failed", "dead_letter", "cancelled"].includes(jobState);
      const failureTerminal = ["FAILED", "CANCELLED"].includes(semanticStatus);
      const terminalReady = semanticTerminal && (failureTerminal || (jobTerminal && archiveReady && Boolean(handoffEvent)));
      const projected = terminalReady ? projectionEvidence("langgraph-product", `langgraph:product-e2e:${runRef}`, projection)
        : { raw: [], normalized: [] };
      // /api/v1/jobs is a live projection: fields such as status and attempts legitimately change while the
      // worker is running. Publishing that mutable object under one source_ref would falsely look like an
      // immutable-evidence rewrite on the next poll. Use it for scheduling until the product has reached its
      // terminal delivery boundary, then preserve exactly one terminal Job snapshot in the evidence chain.
      const jobRaw = terminalReady && job
        ? [rawEvent("langgraph-product", `langgraph:job:${job.job_id ?? runRef}`, job)] : [];
      const runContract = projection.run_contract ?? {};
      const nativeFields = { trial_id: projection.trial_id ?? runContract.trial_id,
        context_digest: projection.run_context_digest ?? projection.context_digest ?? runContract.context_digest,
        contract_version: projection.run_contract_version ?? runContract.contract_version,
        budget: projection.evaluation_budget ?? runContract.budget };
      for (const name of ["graph_version", "state_schema_version", "mcp_contract_version", "knowledge_version",
        "model_version", "product_e2e_contract_version", "public_event_schema_version"]) {
        if (projection[name] !== undefined) nativeFields[name] = projection[name];
      }
      if (projection.contract_version !== undefined) nativeFields.product_e2e_contract_version = projection.contract_version;
      const publicEventSchemas = [...new Set((projection.public_events ?? []).map((event) => event.schema_version).filter(Boolean))];
      if (publicEventSchemas.length === 1) nativeFields.public_event_schema_version = publicEventSchemas[0];
      const sentVersions = run.requestBody.run_context.runtime_versions;
      const expectedForBinding = { ...run.expected, contract_version: "evalos-product-run-binding.3",
        budget: run.requestBody.run_context.budget, ...sentVersions };
      const nativeRequired = ["trial_id", "context_digest", ...Object.keys(sentVersions)];
      const evaluationBinding = terminalReady ? binding({ runRef, expected: expectedForBinding, nativeFields,
        nativeRequired, evidenceChecks: { job_investigation: job ? job.investigation_id === runRef : false },
        evidenceRequired: [] }) : null;
      const status = terminalReady ? semanticStatus : "RUNNING";
      runStates.set(runRef, { terminalReady, semanticStatus, job_state: jobState,
        archive_ready: archiveReady, cleanup_handoff_verified: Boolean(handoffEvent) });
      return { run_ref: runRef, status, next_cursor: journal.next_cursor ?? cursor,
        raw_events: [...translated.raw, ...projected.raw, ...jobRaw],
        normalized_events: [...translated.normalized, ...projected.normalized], approval_requests: approvalRequests,
        outcome: terminalReady && !failureTerminal
          ? authoritativeOutcome({ status: detailState, detail, projection, events: allEvents, product: "langgraph" }) : null,
        product_evidence: terminalReady && !failureTerminal ? productEvidence({ events: allEvents,
          raw: translated.raw, artifactRefs: archiveRefs, projectionRef: projected.raw[0]?.source_ref,
          jobRef: jobRaw[0]?.source_ref, failureRecovery: projection.failure_recovery ?? [] }) : null,
        evaluation_binding: evaluationBinding,
        candidate_usage: candidateUsageSnapshot({ authoritative: [
          { source: "product_e2e.budget_usage", value: projection.budget_usage },
          { source: "investigation.budget_usage", value: detail.budget_usage },
          { source: "job.usage", value: job?.usage }], events: allEvents }),
        error: failureTerminal ? terminalFailure(detail, allEvents, job) : null,
        artifact_refs: archiveRefs };
    },
    async respondApproval({ runRef, request, decision }) {
      return approvalApi.request(`/api/v1/investigations/${encodeURIComponent(runRef)}/approvals`, { method: "POST", body: {
        action_id: request.action_id, decision: decision.decision === "APPROVE" ? "approved" : "rejected",
        reason: decision.reason_zh, proposal_digest: request.proposal_digest,
        environment_snapshot_digest: request.environment_snapshot_digest,
        policy_decision_id: request.policy_decision_id } });
    },
    async probeRun({ runRef }) {
      const [detail, jobsPage] = await Promise.all([api.request(`/api/v1/investigations/${encodeURIComponent(runRef)}`),
        api.request("/api/v1/jobs?limit=200")]);
      const job = listItems(jobsPage).find((item) => item.investigation_id === runRef);
      const jobState = String(job?.status ?? "").toLowerCase();
      const rawStatus = String(detail.status ?? "").toLowerCase();
      const status = ["dead_letter", "failed"].includes(jobState) ? "FAILED"
        : jobState === "cancelled" ? "CANCELLED" : langGraphStatus(rawStatus);
      return { run_ref: runRef, status, terminal: status !== "RUNNING", raw_status: rawStatus, job_status: jobState || null };
    },
    async finalize({ runRef }) {
      const state = runStates.get(runRef);
      if (!state?.terminalReady) return { ok: false, run_ref: runRef,
        cleanup_owner: "external_controller", candidate_reset: false, reason: "terminal_cleanup_handoff_not_observed" };
      return { ok: true, run_ref: runRef, cleanup_owner: "external_controller",
        strategy: "external_cleanup_handoff", candidate_reset: false,
        cleanup_handoff_verified: state.cleanup_handoff_verified,
        archive_ready: state.archive_ready, job_status: state.job_state,
        evalos_authoritative_reset_pending: true };
    },
    async cancel() { return { supported: false, reason: "candidate-product-does-not-expose-cancel-api" }; },
  });
}

export const PRODUCT_CONNECTOR_V5_RUNTIME = Object.freeze({
  contract: "5.0", role: "external-product-native-contract-client", productionWrites: false,
  candidateCodeMutation: false, candidateDatabaseMutation: false, tokenSource: "environment-only",
  hiddenFieldsSent: false, bindingContract: "evalos-product-run-binding.3",
  cleanup: "candidate-handoff-then-evalos-authoritative-snapshot-reset",
});
