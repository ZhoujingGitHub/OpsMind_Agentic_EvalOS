import { sha256, stableStringify } from "./utils.mjs";

export const EFFICIENCY_AUDIT_CONTRACT = "evalos-trial-efficiency-audit/1.0";

const SECRET_KEY = /(?:authorization|cookie|credential|secret|token|api[_-]?key|password|passwd|private[_-]?key|dsn|base[_-]?url)/iu;
const VOLATILE_KEY = /(?:^|[_-])(?:timestamp|time|created_at|updated_at|request_id|trace_id|span_id|nonce)(?:$|[_-])/iu;
const TOOL_CALL = new Set(["tool.called", "tool.call", "pretooluse"]);
const TOOL_TERMINAL = /(?:^|\.)(?:tool\.(?:completed|failed|result)|posttooluse(?:failure)?|read_execution_completed)$/iu;
const PUBLIC_EVIDENCE = /(?:^|\.)(?:evidence\.collected|observation\.recorded|hypothesis\.revised)$/iu;
const PUBLIC_MILESTONES = Object.freeze({
  "investigation.started": "investigation_started",
  "evidence.collected": "evidence_collected",
  "conclusion.recorded": "conclusion_recorded",
  "candidate.evaluation_binding.verified": "binding_verified",
  "candidate.evidence.frozen": "evidence_frozen",
  "archive.reconciled": "archive_reconciled",
  "environment.reset": "environment_reset",
});
const USAGE_DIMENSIONS = Object.freeze(["input_tokens", "output_tokens", "model_calls", "tool_calls",
  "wallclock_ms", "compute_ms", "storage_bytes", "cost_usd"]);

function timestampMs(value) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function publicEvent(record, index) {
  if (record?.name !== "candidate.raw_event") return null;
  const envelope = record?.payload?.payload;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const detail = envelope.public_payload && typeof envelope.public_payload === "object"
    ? envelope.public_payload
    : envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  const eventType = String(envelope.event_type ?? envelope.name ?? envelope.action ?? "").trim().toLowerCase();
  if (!eventType) return null;
  return {
    index,
    seq: Number(record.seq ?? index + 1),
    event_type: eventType,
    detail,
    timestamp: envelope.created_at ?? envelope.timestamp ?? record?.payload?.recorded_at ?? record?.timestamp ?? null,
    timestamp_ms: timestampMs(envelope.created_at ?? envelope.timestamp ?? record?.payload?.recorded_at ?? record?.timestamp),
    source_ref: record?.payload?.source_ref ?? null,
  };
}

function normalizedToolName(value) {
  return String(value ?? "unknown").replace(/^mcp__[^_]+__/u, "").trim().toLowerCase();
}

function sanitizedForDigest(value) {
  if (Array.isArray(value)) return value.map(sanitizedForDigest);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
      if (SECRET_KEY.test(key)) return [[key, "[redacted]"]];
      if (VOLATILE_KEY.test(key)) return [];
      return [[key, sanitizedForDigest(value[key])]];
    }));
  }
  return value;
}

function toolIdentity(detail) {
  return detail.tool_use_id ?? detail.call_id ?? detail.id ?? null;
}

function toolInput(detail) {
  for (const key of ["input", "tool_input", "arguments", "args", "parameters"]) {
    if (detail[key] !== undefined) return detail[key];
  }
  return undefined;
}

function toolName(detail) {
  return normalizedToolName(detail.name ?? detail.tool_name ?? detail.tool);
}

function terminalStatus(event) {
  const status = String(event.detail.status ?? "").toLowerCase();
  if (event.event_type.includes("fail") || event.detail.is_error === true || ["failed", "error"].includes(status)) return "failed";
  return "completed";
}

function evidenceSignals(events) {
  return events.map((event) => ({ index: event.index,
    signal: PUBLIC_EVIDENCE.test(event.event_type) || hasEvidenceReference(event.detail) })).filter((item) => item.signal);
}

function hasEvidenceReference(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasEvidenceReference);
  return Object.entries(value).some(([key, item]) => /^(?:evidence_id|evidence_ids|evidence_refs)$/iu.test(key)
    ? typeof item === "string" && Boolean(item) || Array.isArray(item) && item.length > 0
    : item && typeof item === "object" && hasEvidenceReference(item));
}

function buildToolLedger(events) {
  const calls = [];
  const byId = new Map();
  const unmatchedTerminals = [];
  for (const event of events) {
    if (TOOL_CALL.has(event.event_type)) {
      const input = toolInput(event.detail);
      const name = toolName(event.detail);
      const id = toolIdentity(event.detail) ?? `unidentified-call-${event.seq}`;
      const inputObservable = input !== undefined;
      const inputDigest = inputObservable ? `sha256:${sha256(stableStringify(sanitizedForDigest(input)))}` : null;
      const call = { call_ref: String(id), tool_name: name, input_observable: inputObservable,
        input_digest: inputDigest, signature_digest: inputObservable
          ? `sha256:${sha256(stableStringify({ tool_name: name, input: sanitizedForDigest(input) }))}` : null,
        called_at: event.timestamp, called_seq: event.seq, called_index: event.index,
        terminal_status: "unresolved", terminal_at: null, terminal_seq: null, terminal_index: null };
      calls.push(call);
      byId.set(String(id), call);
      continue;
    }
    if (!TOOL_TERMINAL.test(event.event_type)) continue;
    const id = toolIdentity(event.detail);
    const call = id === null ? null : byId.get(String(id));
    if (!call || call.terminal_status !== "unresolved") {
      unmatchedTerminals.push({ event_type: event.event_type, terminal_seq: event.seq,
        call_ref_observable: id !== null });
      continue;
    }
    call.terminal_status = terminalStatus(event);
    call.terminal_at = event.timestamp;
    call.terminal_seq = event.seq;
    call.terminal_index = event.index;
  }
  return { calls, unmatchedTerminals };
}

function repeatReview(calls, signals) {
  const bySignature = new Map();
  for (const call of calls.filter((item) => item.signature_digest)) {
    const group = bySignature.get(call.signature_digest) ?? [];
    group.push(call);
    bySignature.set(call.signature_digest, group);
  }
  const exactGroups = [];
  const candidates = [];
  for (const [signatureDigest, group] of bySignature) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((left, right) => left.called_index - right.called_index);
    exactGroups.push({ signature_digest: signatureDigest, tool_name: sorted[0].tool_name,
      occurrences: sorted.length, call_refs: sorted.map((item) => item.call_ref) });
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      const boundary = previous.terminal_index ?? previous.called_index;
      const interveningEvidence = signals.filter((item) => item.index > boundary && item.index < current.called_index).length;
      if (interveningEvidence === 0) candidates.push({ signature_digest: signatureDigest,
        tool_name: current.tool_name, previous_call_ref: previous.call_ref, repeated_call_ref: current.call_ref,
        intervening_public_evidence: 0,
        interpretation: "exact_repeat_without_intervening_public_evidence_requires_human_review" });
    }
  }
  return { exactGroups, candidates };
}

function modelTiming(events) {
  const modelEvents = events.filter((event) => /(?:model|provider|deepseek)/iu.test(event.event_type));
  const eventCounts = Object.fromEntries([...new Set(modelEvents.map((item) => item.event_type))].sort()
    .map((name) => [name, modelEvents.filter((item) => item.event_type === name).length]));
  const spans = new Map();
  for (const event of modelEvents) {
    const id = event.detail.model_call_id ?? event.detail.provider_request_id ?? event.detail.request_id ?? null;
    if (id === null) continue;
    const entry = spans.get(String(id)) ?? { started: false, first_response: false, completed: false };
    if (/(?:request|call).*(?:start|sent)|(?:start|sent).*(?:request|call)/iu.test(event.event_type)) entry.started = true;
    if (/first.*(?:token|byte)|response_started/iu.test(event.event_type)) entry.first_response = true;
    if (/(?:request|call).*(?:complete|finish|end)|(?:complete|finish|end).*(?:request|call)/iu.test(event.event_type)) entry.completed = true;
    spans.set(String(id), entry);
  }
  const completeSpans = [...spans.values()].filter((item) => item.started && item.first_response && item.completed).length;
  return { public_model_event_counts: eventCounts, correlated_request_spans: spans.size,
    complete_request_spans: completeSpans,
    model_timing_complete: spans.size > 0 && completeSpans === spans.size,
    missing_observability: spans.size === 0
      ? ["provider_request_started", "provider_first_response", "provider_request_completed", "correlation_id"]
      : completeSpans === spans.size ? [] : ["one_or_more_provider_request_spans_incomplete"],
    interpretation: spans.size > 0 && completeSpans === spans.size
      ? "provider_timing_observable"
      : "cannot_separate_model_latency_from_product_queue_or_persistence_latency",
  };
}

function gapAudit(events) {
  const timed = events.filter((item) => item.timestamp_ms !== null).sort((left, right) => left.timestamp_ms - right.timestamp_ms);
  const gaps = [];
  for (let index = 1; index < timed.length; index += 1) {
    gaps.push({ duration_ms: Math.max(0, timed[index].timestamp_ms - timed[index - 1].timestamp_ms),
      from_event: timed[index - 1].event_type, to_event: timed[index].event_type,
      from_at: timed[index - 1].timestamp, to_at: timed[index].timestamp });
  }
  const sorted = [...gaps].sort((left, right) => right.duration_ms - left.duration_ms);
  const percentile = (ratio) => sorted.length
    ? [...gaps].sort((left, right) => left.duration_ms - right.duration_ms)[Math.min(gaps.length - 1, Math.ceil(gaps.length * ratio) - 1)].duration_ms
    : null;
  return { observed_gap_count: gaps.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95),
    maximum_ms: sorted[0]?.duration_ms ?? null, largest_gaps: sorted.slice(0, 5),
    classification_threshold_ms: null,
    interpretation: "descriptive_only_no_fixed_stall_threshold" };
}

function usageAudit(usage, budget) {
  const measurement = usage?.measurement ?? {};
  const values = {};
  const ratios = {};
  for (const dimension of USAGE_DIMENSIONS) {
    const value = Number(usage?.[dimension]);
    const limit = Number(budget?.[dimension]);
    values[dimension] = Number.isFinite(value) && value >= 0 ? value : null;
    ratios[dimension] = values[dimension] !== null && Number.isFinite(limit) && limit > 0
      ? values[dimension] / limit : null;
  }
  const unavailable = [...new Set([...(measurement.unavailable_dimensions ?? []),
    ...USAGE_DIMENSIONS.filter((name) => values[name] === null)])];
  return { values, ratios, complete: measurement.complete === true && unavailable.length === 0,
    observed_dimensions: measurement.observed_dimensions ?? USAGE_DIMENSIONS.filter((name) => values[name] !== null),
    unavailable_dimensions: unavailable,
    interpretation: unavailable.length ? "usage_contains_explicit_unknown_dimensions" : "usage_dimensions_complete" };
}

function milestoneAudit(trace, events) {
  const entries = [];
  for (const event of events) {
    const milestone = PUBLIC_MILESTONES[event.event_type];
    if (milestone) entries.push({ milestone, event_type: event.event_type, at: event.timestamp, seq: event.seq });
  }
  trace.forEach((record, index) => {
    const milestone = PUBLIC_MILESTONES[String(record?.name ?? "").toLowerCase()];
    if (milestone) entries.push({ milestone, event_type: record.name, at: record.timestamp ?? null,
      seq: Number(record.seq ?? index + 1) });
  });
  return entries.sort((left, right) => left.seq - right.seq);
}

export function auditTrialEfficiency(trace = [], { usage = {}, budget = {} } = {}) {
  const records = Array.isArray(trace) ? trace : [];
  const events = records.map(publicEvent).filter(Boolean);
  const signals = evidenceSignals(events);
  const { calls, unmatchedTerminals } = buildToolLedger(events);
  const repeats = repeatReview(calls, signals);
  const unresolved = calls.filter((item) => item.terminal_status === "unresolved").map((item) => ({
    call_ref: item.call_ref, tool_name: item.tool_name, called_at: item.called_at, called_seq: item.called_seq,
  }));
  const requiresHumanReview = repeats.candidates.length > 0 || unresolved.length > 0;
  return {
    contract: EFFICIENCY_AUDIT_CONTRACT,
    authority: "descriptive_post_hoc_review_not_official_grader",
    privacy: { audit_contains_model_text: false, audit_contains_tool_inputs: false, audit_contains_tool_results: false,
      input_fingerprints_only: true },
    public_event_count: events.length,
    milestones: milestoneAudit(records, events),
    tool_execution: {
      called: calls.length,
      completed: calls.filter((item) => item.terminal_status === "completed").length,
      failed: calls.filter((item) => item.terminal_status === "failed").length,
      unresolved,
      unmatched_terminal_events: unmatchedTerminals,
      calls: calls.map(({ called_index: _calledIndex, terminal_index: _terminalIndex, ...item }) => item),
    },
    loop_review: {
      exact_repeat_groups: repeats.exactGroups,
      review_candidates: repeats.candidates,
      requires_human_review: requiresHumanReview,
      automatic_invalid_loop_decision: false,
      interpretation: requiresHumanReview
        ? "review_required_before_using_trial_for_budget_calibration"
        : "no_exact_repeat_without_public_evidence_detected",
    },
    model_timing: modelTiming(events),
    public_event_gaps: gapAudit(events),
    usage: usageAudit(usage, budget),
    calibration_sample_eligibility: requiresHumanReview ? "PENDING_HUMAN_REVIEW" : "ELIGIBLE_ON_EFFICIENCY_SIGNALS_ONLY",
  };
}
