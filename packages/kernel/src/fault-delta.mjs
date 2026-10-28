// Root cause as "which piece of state was changed", not as a synthetic label.
//
// The candidate points at the changed state using the field names and values
// of its *own* observation; the exam compares that against the parameters of
// the command the laboratory actually ran when it injected the fault. Nothing
// in this module knows about fault mechanisms, scenario ids or answer
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
//   interfaces      infra/twin/opsmind_harness_labctl.py  query_interfaces()
//                     (`ip -j address show`, one row per link)
//
// A case sheet that names a field outside this table is annotating an answer
// the candidate could never express, so the case bank refuses to load.
export const OBSERVATION_FIELDS = Object.freeze({
  network_policy: Object.freeze(["chain", "position", "packets", "bytes", "rule", "tokens",
    "protocol", "source", "destination", "input_interface", "output_interface",
    "destination_port", "source_port", "target", "goto", "has_negation",
    "table", "kernel_namespace", "policy_backend", "resource_id"]),
  process_state: Object.freeze(["resource_id", "namespace_id", "resource_type", "service_id",
    "resolution", "read_only", "diagnostic_profile", "active", "status", "runtime_state",
    "health", "ready", "health_scope", "business_health", "process_id", "listener_protocol"]),
  subscriber: Object.freeze(["subscriber_present", "ue_profile_available",
    "reference_profile_available", "checked_fields", "authentication_profile_consistent",
    "mismatched_fields", "secret_values_exposed"]),
  routes: Object.freeze(["node_profile", "dst", "dev", "gateway", "protocol", "scope",
    "prefsrc", "metric", "flags", "table", "type"]),
  interfaces: Object.freeze(["node_profile", "ifindex", "ifname", "flags", "mtu", "qdisc",
    "operstate", "group", "txqlen", "link_type", "address", "broadcast", "link", "link_index",
    "master", "link_netnsid"]),
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

// A list field (checked_fields, mismatched_fields, flags) is compared as a set,
// so the order the laboratory happened to emit is not an answer either. A field
// whose value is an object or contains one is never comparable and never matches.
export function normalizeValue(value) {
  if (Array.isArray(value)) {
    const items = value.map(normalizeScalar);
    if (items.some((item) => item === null)) return null;
    return `[${[...items].sort().join("")}]`;
  }
  return normalizeScalar(value);
}

function scalarFields(value) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, item]) => normalizeValue(item) !== null));
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
    // The rule keeps the coordinates of the table it lives in: a candidate that
    // copied `table: filter` down copied something it really saw.
    if (Array.isArray(record.tables)) {
      return record.tables.filter(isPlainObject).flatMap((table) =>
        (Array.isArray(table.rules) ? table.rules : []).filter(isPlainObject)
          .map((rule) => ({ kind: "network_policy", fields: { ...rule,
            ...(typeof table.table === "string" ? { table: table.table } : {}),
            ...(typeof record.kernel_namespace === "string" ? { kernel_namespace: record.kernel_namespace } : {}),
            ...(typeof record.policy_backend === "string" ? { policy_backend: record.policy_backend } : {}),
            ...(typeof record.resource_id === "string" ? { resource_id: record.resource_id } : {}) } })));
    }
    if (Array.isArray(record.routes)) {
      return record.routes.filter(isPlainObject)
        .map((route) => ({ kind: "routes", fields: { node_profile: record.node_profile, ...route } }));
    }
    if (Array.isArray(record.interfaces)) {
      return record.interfaces.filter(isPlainObject)
        .map((link) => ({ kind: "interfaces", fields: { node_profile: record.node_profile, ...scalarFields(link) } }));
    }
    if ("subscriber_present" in record) return [{ kind: "subscriber", fields: record }];
    if (typeof record.resource_id === "string" && ["active", "status", "runtime_state", "health"]
      .some((name) => name in record)) return [{ kind: "process_state", fields: record }];
    return [];
  });
}

// The same physical row is often offered more than once: six network
// functions on one host share one kernel policy table, and one observation can
// be quoted in the report, the evidence list and a progress snapshot. It is
// still one row. A kernel rule is identified by where it lives, never by which
// leased resource happened to ask for the table.
function rowIdentity(row) {
  const fields = row.fields ?? {};
  if (row.kind === "network_policy") {
    return [row.kind, fields.kernel_namespace ?? "", fields.table ?? "", fields.chain ?? "",
      fields.position ?? "", fields.rule ?? ""].join("|");
  }
  return `${row.kind}|${JSON.stringify(Object.fromEntries(Object.entries(fields)
    .filter(([name]) => name !== "observed_at").sort(([a], [b]) => a.localeCompare(b))))}`;
}

export function distinctRows(rows) {
  const seen = new Map();
  for (const row of rows ?? []) if (!seen.has(rowIdentity(row))) seen.set(rowIdentity(row), row);
  return [...seen.values()];
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

function familiesForFields(fields) {
  const names = Object.keys(fields);
  return Object.entries(OBSERVATION_FIELDS)
    .filter(([, legal]) => names.every((name) => legal.includes(name)))
    .map(([family]) => family);
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
 * `absent` means the candidate says this piece of state is gone. A deleted
 * route leaves no row to point at, so the claim has to cite the observation in
 * which it looked: that observation must be of a family the named fields belong
 * to, and must really not contain a matching row. Saying "it is gone" about
 * something one never looked at is not an identification.
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
  const evidenceId = typeof claim?.evidence_id === "string" ? claim.evidence_id : null;
  const rows = distinctRows(evidenceId ? rowsByEvidenceId.get(evidenceId) ?? [] : []);
  if (state === "absent") {
    const families = familiesForFields(fields);
    const looked = rows.filter((row) => families.includes(row.kind));
    if (!evidenceId || !looked.length) {
      return { ok: false, state, evidence_id: evidenceId, resolved: null, match_count: 0,
        verdict: "absence_not_observed" };
    }
    const stillThere = looked.filter((row) => rowMatchesFields(row.fields, fields));
    if (stillThere.length) {
      return { ok: false, state, evidence_id: evidenceId, resolved: null, match_count: stillThere.length,
        verdict: "claimed_absent_but_observed" };
    }
    return { ok: true, state, verdict: "absence_confirmed_in_observation", resolved: { ...fields },
      observation: looked[0].kind, match_count: 0, evidence_id: evidenceId };
  }
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
  if (resolution.observation && resolution.observation !== delta.observation) return false;
  return rowMatchesFields(resolution.resolved, delta.identify);
}

/**
 * The answer key a particular candidate has to produce.
 *
 * Both products drive the same physical laboratory, but each owns its own
 * transport hops (`ah-*` and `lg-*`), so a delta that lives on a candidate's
 * own topology names the field values per candidate. A case sheet without
 * candidate-specific values reads the same for both.
 */
export function deltasForCandidate(deltas, candidateRef = null) {
  if (!Array.isArray(deltas)) return null;
  return deltas.map((delta) => {
    if (!isPlainObject(delta.identify_by_candidate)) return delta;
    const identify = candidateRef ? delta.identify_by_candidate[candidateRef] : null;
    if (!isPlainObject(identify)) {
      throw new Error(`fault delta on ${delta.observation} is candidate-specific; grading needs a known candidate`);
    }
    return { ...delta, identify };
  });
}

/**
 * Grade one paper's state claims against the changes the laboratory injected.
 *
 * exact    every injected change is identified and nothing else is claimed
 * partial  some are identified, or the paper claims a change that was not made
 * miss     none of the injected changes is identified
 *
 * `incidentalDeltas` are changes the laboratory also made that are not the
 * answer (the shared base twin removing its own route alongside a candidate's
 * MEC route). Naming one is true and therefore never a stray claim; it is not
 * required either.
 *
 * A case with no fault at all (`truthDeltas` is an empty list) is answered
 * correctly only by claiming nothing: every claim is a false positive.
 */
export function gradeFaultDeltas({ truthDeltas = null, incidentalDeltas = [], claims = [],
  rowsByEvidenceId = new Map() } = {}) {
  const declared = Array.isArray(claims) ? claims.filter(isPlainObject) : [];
  const resolutions = declared.map((claim) => resolveStateClaim(claim, rowsByEvidenceId));
  const allResolve = resolutions.length > 0 && resolutions.every((item) => item.ok);
  if (!Array.isArray(truthDeltas)) {
    // A case the bank does not annotate cannot be graded on this axis. It says
    // so instead of silently awarding or denying the points.
    return { applicable: false, verdict: "no_state_truth", score: 0, gate_passed: null,
      claim_count: declared.length, claims_resolve: declared.length === 0 || allResolve,
      resolutions, hits: [], unmatched_deltas: [], stray_claims: declared.length };
  }
  if (!truthDeltas.length) {
    const quiet = declared.length === 0;
    return { applicable: true, no_fault: true, verdict: quiet ? "no_fault_no_claim" : "false_positive_claim",
      score: quiet ? 1 : 0, gate_passed: quiet, claim_count: declared.length, claims_resolve: allResolve,
      resolutions, hits: [], unmatched_deltas: [], stray_claims: declared.length,
      note: quiet ? null : "本题什么都没坏，指认任何一处改动都是误报" };
  }
  if (!declared.length) {
    return { applicable: true, verdict: "state_change_not_declared", score: 0, gate_passed: false,
      claim_count: 0, claims_resolve: false, resolutions, hits: [],
      unmatched_deltas: truthDeltas.map((item) => item.identify), stray_claims: 0,
      note: "答卷没有指认任何一处被改动的状态，根因一项直接判否" };
  }
  const usedClaims = new Set();
  const hits = [];
  const unmatched = [];
  for (const delta of truthDeltas) {
    const index = resolutions.findIndex((resolution, position) => !usedClaims.has(position)
      && deltaHitBy(delta, resolution));
    if (index >= 0) {
      usedClaims.add(index);
      hits.push({ observation: delta.observation, identify: delta.identify, claim_index: index });
    } else unmatched.push(delta.identify);
  }
  const incidentalHits = resolutions.map((resolution, position) => !usedClaims.has(position)
    && (incidentalDeltas ?? []).some((delta) => deltaHitBy(delta, resolution)));
  incidentalHits.forEach((hit, position) => { if (hit) usedClaims.add(position); });
  const stray = resolutions.length - usedClaims.size;
  const exact = unmatched.length === 0 && stray === 0;
  const verdict = exact ? "exact_state_match" : hits.length ? "partial_state_match" : "state_miss";
  return { applicable: true, verdict, score: exact ? 1 : hits.length ? 0.5 : 0,
    gate_passed: exact, claim_count: declared.length, claims_resolve: allResolve,
    resolutions, hits, unmatched_deltas: unmatched, stray_claims: stray,
    incidental_claims: incidentalHits.filter(Boolean).length };
}

/**
 * Can the candidate observe the family this change lives in at all?
 */
export function faultDeltaObservable(delta) {
  return Boolean(delta) && Object.prototype.hasOwnProperty.call(OBSERVATION_FIELDS, delta.observation);
}

function assertIdentify(caseId, family, identify) {
  const legal = OBSERVATION_FIELDS[family];
  if (!isPlainObject(identify) || !Object.keys(identify).length) {
    throw new Error(`${caseId}: identify must name at least one observed field`);
  }
  for (const [name, value] of Object.entries(identify)) {
    if (!legal.includes(name)) throw new Error(`${caseId}: ${family} has no observable field "${name}"`);
    if (normalizeValue(value) === null) throw new Error(`${caseId}: ${family}.${name} is not a comparable value`);
  }
}

// Load-time guard for the case bank. A field name outside the family's table is
// an annotation the candidate could never reproduce — exactly the defect that
// made four correct diagnoses fail — so it fails loudly at import time.
export function assertFaultDeltas(caseId, deltas, { allowEmpty = false } = {}) {
  if (deltas === null || deltas === undefined) return;
  if (!Array.isArray(deltas) || (!deltas.length && !allowEmpty)) {
    throw new Error(`${caseId}: faultDeltas must be a non-empty array, [] for a no-fault case, or null`);
  }
  for (const delta of deltas) {
    if (!OBSERVATION_FIELDS[delta?.observation]) throw new Error(`${caseId}: unknown observation family ${delta?.observation}`);
    if (!CLAIM_STATES.includes(delta?.state)) {
      throw new Error(`${caseId}: state must be one of ${CLAIM_STATES.join("|")}`);
    }
    if (isPlainObject(delta.identify_by_candidate)) {
      if (delta.identify !== undefined) throw new Error(`${caseId}: a delta is either shared or candidate-specific`);
      const variants = Object.entries(delta.identify_by_candidate);
      if (!variants.length) throw new Error(`${caseId}: identify_by_candidate names no candidate`);
      for (const [, identify] of variants) assertIdentify(caseId, delta.observation, identify);
    } else {
      assertIdentify(caseId, delta.observation, delta.identify);
    }
  }
}
