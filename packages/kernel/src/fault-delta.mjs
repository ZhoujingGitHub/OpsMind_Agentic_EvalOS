// Root cause as "which piece of state was changed", not as a synthetic label.
//
// The previous criterion asked the candidate to nominate a canonical fact
// reference such as `policy:sctp:38412:drop-rule-present`. Four real trials on
// 2026-09-20 proved that string is minted by the exam itself and is never
// handed to a candidate: four correct diagnoses were all failed by it. So the
// exam stopped inventing a vocabulary. It now asks the candidate to point at
// the changed state using the field names and values of its *own* observation,
// and compares that against the parameters of the command the laboratory
// actually ran when it injected the fault.
//
// Nothing in this module knows about fault mechanisms, scenario ids or answer
// categories. It only knows how to read the rows out of a preserved product
// observation and how to compare a claim against them.

// The legal field names of each observation family, read off the laboratory
// code that produces them, not guessed:
//
//   network_policy  infra/twin/harness_diagnostics.py  parse_policy()
//   process_state   infra/twin/opsmind_harness_labctl.py
//                     query_resource_observation() + local_listener_health()
//   subscriber      infra/twin/opsmind_harness_labctl.py
//                     subscriber_auth_consistency()
//   routes          infra/twin/opsmind_harness_labctl.py  query_routes()
//
// A case sheet that names a field outside this table is annotating an answer
// the candidate could never express, so the case bank refuses to load.
export const OBSERVATION_FIELDS = Object.freeze({
  network_policy: Object.freeze(["chain", "position", "packets", "bytes", "rule", "tokens",
    "protocol", "source", "destination", "input_interface", "output_interface",
    "destination_port", "source_port", "target", "goto", "has_negation"]),
  process_state: Object.freeze(["resource_id", "namespace_id", "resource_type", "service_id",
    "resolution", "read_only", "diagnostic_profile", "active", "status", "runtime_state",
    "health", "ready", "health_scope", "business_health", "process_id", "listener_protocol"]),
  subscriber: Object.freeze(["subscriber_present", "ue_profile_available",
    "reference_profile_available", "checked_fields", "authentication_profile_consistent",
    "mismatched_fields", "secret_values_exposed"]),
  routes: Object.freeze(["node_profile", "dst", "dev", "gateway", "protocol", "scope",
    "prefsrc", "metric", "flags", "table", "type"]),
});

export const CLAIM_STATES = Object.freeze(["present", "absent"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Upper and lower case are not part of the answer. Requiring the candidate to
// reproduce `OPSMIND_TWIN_IN` rather than `opsmind_twin_in` would fail a
// correct identification on typography, and the identified row is the same row
// either way. Everything else is compared exactly.
function normalizeScalar(value) {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

// A list field (checked_fields, mismatched_fields) is compared as a set, so the
// order the laboratory happened to emit is not an answer either. A field whose
// value is an object or contains one is never comparable and never matches.
export function normalizeValue(value) {
  if (Array.isArray(value)) {
    const items = value.map(normalizeScalar);
    if (items.some((item) => item === null)) return null;
    return `[${[...items].sort().join("")}]`;
  }
  return normalizeScalar(value);
}

/**
 * Every row a preserved product observation offers for identification.
 *
 * Both candidate products publish their evidence in their own envelope — Agent
 * Harness under `raw_value_json.records`, LangGraph under `records` — and this
 * reads either without either product sharing code with the other.
 */
export function observationRows(item) {
  const raw = item?.raw_value_json;
  const records = Array.isArray(raw?.records) ? raw.records
    : Array.isArray(item?.records) ? item.records : [];
  return records.filter(isPlainObject).flatMap((record) => {
    // A kernel policy snapshot identifies individual rules, not the snapshot.
    if (Array.isArray(record.tables)) {
      return record.tables.filter(isPlainObject).flatMap((table) =>
        (Array.isArray(table.rules) ? table.rules : []).filter(isPlainObject)
          .map((rule) => ({ kind: "network_policy", fields: rule })));
    }
    if (Array.isArray(record.routes)) {
      return record.routes.filter(isPlainObject)
        .map((route) => ({ kind: "routes", fields: { node_profile: record.node_profile, ...route } }));
    }
    if ("subscriber_present" in record) return [{ kind: "subscriber", fields: record }];
    if (typeof record.resource_id === "string" && ["active", "status", "runtime_state", "health"]
      .some((name) => name in record)) return [{ kind: "process_state", fields: record }];
    return [];
  });
}

export function rowMatchesFields(row, fields) {
  const entries = Object.entries(fields ?? {});
  if (!entries.length) return false;
  return entries.every(([name, value]) => {
    if (!(name in row)) return false;
    const wanted = normalizeValue(value);
    const found = normalizeValue(row[name]);
    return wanted !== null && found !== null && wanted === found;
  });
}

/**
 * Turn one claim into the concrete row it identifies.
 *
 * `present` means the candidate says this row is there and is the thing that
 * was changed, so the row is looked up in the evidence the claim itself cites
 * and **must resolve to exactly one row**. Zero rows means the claim points at
 * nothing; more than one means it did not narrow the field down — an answer
 * that says only "there is a DROP rule" has not identified which one.
 *
 * `absent` means the candidate says this piece of state is gone. There is
 * nothing to look up — a deleted route leaves no row — so the fields it names
 * are what gets compared.
 */
export function resolveStateClaim(claim, rowsByEvidenceId = new Map()) {
  const state = String(claim?.state ?? "present").toLowerCase();
  const fields = isPlainObject(claim?.fields) ? claim.fields : null;
  if (!CLAIM_STATES.includes(state)) {
    return { ok: false, state, verdict: "state_not_recognized", resolved: null, match_count: 0 };
  }
  if (!fields || !Object.keys(fields).length) {
    return { ok: false, state, verdict: "no_fields", resolved: null, match_count: 0 };
  }
  if (state === "absent") {
    return { ok: true, state, verdict: "declared_absent", resolved: { ...fields },
      match_count: 0, evidence_id: claim?.evidence_id ?? null };
  }
  const evidenceId = typeof claim?.evidence_id === "string" ? claim.evidence_id : null;
  const rows = evidenceId ? rowsByEvidenceId.get(evidenceId) ?? [] : [];
  const hits = rows.filter((row) => rowMatchesFields(row.fields, fields));
  if (hits.length === 1) {
    return { ok: true, state, verdict: "resolved_to_one_record", resolved: hits[0].fields,
      observation: hits[0].kind, match_count: 1, evidence_id: evidenceId };
  }
  return { ok: false, state, evidence_id: evidenceId, resolved: null, match_count: hits.length,
    verdict: hits.length === 0 ? "no_record_identified" : "more_than_one_record_identified" };
}

function deltaHitBy(delta, resolution) {
  if (!resolution.ok || !resolution.resolved) return false;
  if (String(delta.state ?? "present").toLowerCase() !== resolution.state) return false;
  return rowMatchesFields(resolution.resolved, delta.identify);
}

/**
 * Grade one paper's state claims against the changes the laboratory injected.
 *
 * exact    every injected change is identified and nothing else is claimed
 * partial  some are identified, or the paper claims a change that was not made
 * miss     none of the injected changes is identified
 */
export function gradeFaultDeltas({ truthDeltas = null, claims = [], rowsByEvidenceId = new Map() } = {}) {
  const deltas = Array.isArray(truthDeltas) && truthDeltas.length ? truthDeltas : null;
  const declared = Array.isArray(claims) ? claims.filter(isPlainObject) : [];
  const resolutions = declared.map((claim) => resolveStateClaim(claim, rowsByEvidenceId));
  const allResolve = resolutions.length > 0 && resolutions.every((item) => item.ok);
  if (!deltas) {
    // A case the bank does not annotate cannot be graded on this axis. It says
    // so instead of silently awarding or denying the points; whether a claim
    // made here is still an honest one is reported separately.
    return { applicable: false, verdict: "no_state_truth", score: 0, gate_passed: null,
      claim_count: declared.length, claims_resolve: declared.length === 0 || allResolve,
      resolutions, hits: [], unmatched_deltas: [], stray_claims: declared.length };
  }
  if (!declared.length) {
    return { applicable: true, verdict: "state_change_not_declared", score: 0, gate_passed: false,
      claim_count: 0, claims_resolve: false, resolutions, hits: [],
      unmatched_deltas: deltas.map((item) => item.identify), stray_claims: 0,
      note: "答卷没有指认任何一处被改动的状态，根因一项直接判否" };
  }
  const usedClaims = new Set();
  const hits = [];
  const unmatched = [];
  for (const delta of deltas) {
    const index = resolutions.findIndex((resolution) => deltaHitBy(delta, resolution));
    if (index >= 0) {
      usedClaims.add(index);
      hits.push({ observation: delta.observation, identify: delta.identify, claim_index: index });
    } else unmatched.push(delta.identify);
  }
  const stray = resolutions.length - usedClaims.size;
  const exact = unmatched.length === 0 && stray === 0 && resolutions.length === deltas.length;
  const verdict = exact ? "exact_state_match"
    : hits.length ? "partial_state_match" : "state_miss";
  return { applicable: true, verdict, score: exact ? 1 : hits.length ? 0.5 : 0,
    gate_passed: exact, claim_count: declared.length, claims_resolve: allResolve,
    resolutions, hits, unmatched_deltas: unmatched, stray_claims: stray };
}

/**
 * Can the candidate observe the family this change lives in at all?
 *
 * The old preflight asked whether the laboratory could mint the case's root
 * cause *reference*. There is no reference any more, so the question became:
 * is the changed state visible in an observation the candidate can ask for?
 */
export function faultDeltaObservable(delta) {
  return Boolean(delta) && Object.prototype.hasOwnProperty.call(OBSERVATION_FIELDS, delta.observation);
}

// Load-time guard for the case bank. A field name outside the family's table is
// an annotation the candidate could never reproduce — exactly the defect that
// made four correct diagnoses fail — so it fails loudly at import time.
export function assertFaultDeltas(caseId, deltas) {
  if (deltas === null || deltas === undefined) return;
  if (!Array.isArray(deltas) || !deltas.length) {
    throw new Error(`${caseId}: faultDeltas must be a non-empty array or null`);
  }
  for (const delta of deltas) {
    const legal = OBSERVATION_FIELDS[delta?.observation];
    if (!legal) throw new Error(`${caseId}: unknown observation family ${delta?.observation}`);
    if (!CLAIM_STATES.includes(delta?.state)) {
      throw new Error(`${caseId}: state must be one of ${CLAIM_STATES.join("|")}`);
    }
    const identify = isPlainObject(delta.identify) ? delta.identify : null;
    if (!identify || !Object.keys(identify).length) {
      throw new Error(`${caseId}: identify must name at least one observed field`);
    }
    for (const [name, value] of Object.entries(identify)) {
      if (!legal.includes(name)) {
        throw new Error(`${caseId}: ${delta.observation} has no observable field "${name}"`);
      }
      if (normalizeValue(value) === null) {
        throw new Error(`${caseId}: ${delta.observation}.${name} is not a comparable value`);
      }
    }
  }
}
