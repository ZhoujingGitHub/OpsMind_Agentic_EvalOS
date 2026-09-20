// A stand-in for the laboratory, written in the laboratory's own terms.
//
// Why this exists: until 2026-09-20 the reference ("standard answer") baseline
// filled its paper straight out of `ground_truth`, in the exam's own private
// vocabulary. It scored 100 on all 160 cases and therefore proved nothing —
// the four real trials that day were all diagnosed correctly and all failed,
// and the reference agent had no way of noticing, because it never travelled
// the road a candidate travels.
//
// So the reference agent now has to read an observation and pick the answer
// out of it. This module produces that observation. It is built ONLY from what
// the laboratory does — the argv of the fault-injection command and the record
// shapes in infra/twin — and it never looks at `identify`, the answer key. If
// a case sheet annotates a field the observation does not carry, the reference
// agent fails to express the right answer and the calibration run says so.

// infra/twin/opsmind_harness_labctl.py RUNTIME_TARGETS: the laboratory injects
// against a systemd unit and observes against a leased resource.
const UNIT_TO_RESOURCE = Object.freeze({
  "open5gs-amfd": "amf", "open5gs-smfd": "smf", "open5gs-upfd": "upf",
  "open5gs-nrfd": "nrf", mongod: "mongodb", "ueransim-gnb": "gnb-1", "ueransim-ue": "ue-1",
});
const RESOURCES = Object.freeze([
  { resource_id: "gnb-1", resource_type: "workload", service_id: "ueransim-gnb" },
  { resource_id: "ue-1", resource_type: "workload", service_id: "ueransim-ue" },
  { resource_id: "amf", resource_type: "service", service_id: "amf" },
  { resource_id: "smf", resource_type: "service", service_id: "smf" },
  { resource_id: "upf", resource_type: "service", service_id: "upf" },
  { resource_id: "nrf", resource_type: "service", service_id: "nrf" },
  { resource_id: "mongodb", resource_type: "service", service_id: "mongodb" },
]);

// infra/twin/harness_diagnostics.py parse_policy(): the option-to-field map is
// copied from there, not invented here.
const IPTABLES_FIELDS = Object.freeze({
  "-p": "protocol", "-s": "source", "-d": "destination", "-i": "input_interface",
  "-o": "output_interface", "--dport": "destination_port", "--sport": "source_port",
  "-j": "target", "-g": "goto",
});

// What a clean twin's kernel looks like: the two jump rules that hand traffic
// to the managed chains, and the managed chains returning by default.
const BASELINE_POLICY_ARGV = Object.freeze([
  ["iptables", "-A", "INPUT", "-j", "OPSMIND_TWIN_IN"],
  ["iptables", "-A", "FORWARD", "-j", "OPSMIND_TWIN_FWD"],
  ["iptables", "-A", "OPSMIND_TWIN_IN", "-j", "RETURN"],
  ["iptables", "-A", "OPSMIND_TWIN_FWD", "-j", "RETURN"],
]);
// inject_hidden_noise(): one real but business-irrelevant DROP on an unused
// port, whose counters never move. Present only in the noise partition.
const HIDDEN_NOISE_ARGV = Object.freeze(
  ["iptables", "-A", "OPSMIND_TWIN_IN", "-p", "udp", "--dport", "9999", "-j", "DROP"]);

const BASELINE_ROUTES = Object.freeze([
  { dst: "default", gateway: "172.16.0.1", dev: "eth0", protocol: "static", metric: 100 },
  { dst: "10.45.0.0/16", dev: "ogstun", protocol: "kernel", scope: "link", prefsrc: "10.45.0.1" },
  { dst: "10.46.0.0/24", dev: "ogstun", protocol: "static", scope: "link" },
  { dst: "172.16.0.0/20", dev: "eth0", protocol: "kernel", scope: "link", prefsrc: "172.16.0.9" },
]);

function ruleRecord(argv, { packets = 0, bytes = 0 } = {}) {
  const tokens = argv.slice(1);
  const chain = tokens[1];
  const fields = {};
  tokens.forEach((token, index) => {
    const name = IPTABLES_FIELDS[token];
    if (name && index + 1 < tokens.length) fields[name] = tokens[index + 1];
  });
  return { chain, rule: tokens.join(" "), tokens: [...tokens], packets, bytes,
    has_negation: tokens.includes("!"), ...fields };
}

function policyTables(argvList) {
  const position = new Map();
  const rules = argvList.map((argv, index) => {
    const record = ruleRecord(argv, index >= BASELINE_POLICY_ARGV.length
      ? { packets: 17, bytes: 1156 } : { packets: 48211, bytes: 7413908 });
    // The injected DROP has moved packets; the harmless noise rule has not.
    if (record.destination_port === "9999") Object.assign(record, { packets: 0, bytes: 0 });
    position.set(record.chain, (position.get(record.chain) ?? 0) + 1);
    return { ...record, position: position.get(record.chain) };
  });
  const chains = [...new Set(rules.map((rule) => rule.chain))]
    .map((name) => ({ name, policy: name.startsWith("OPSMIND") ? "-" : "ACCEPT", packets: 0, bytes: 0 }));
  return [{ table: "filter", chains, rules }];
}

/**
 * Apply one injected fault to a clean twin.
 *
 * `injectedBy` is the real argv the laboratory runs. The three faults with no
 * argv are injected from a named call site instead, and are keyed on that.
 */
function applyInjection(state, delta) {
  const argv = delta.injectedBy;
  const site = delta.injectedAt ?? "";
  if (Array.isArray(argv) && argv[0] === "iptables") {
    state.policyArgv = [...state.policyArgv, argv];
    return;
  }
  if (Array.isArray(argv) && argv[0] === "systemctl" && argv[1] === "stop") {
    const resource = UNIT_TO_RESOURCE[argv[2]];
    if (!resource) throw new Error(`simulator: unknown systemd unit ${argv[2]}`);
    state.stopped.add(resource);
    return;
  }
  if (Array.isArray(argv) && argv[0] === "ip" && argv[1] === "route" && argv[2] === "del") {
    state.routes = state.routes.filter((route) => route.dst !== argv[3]);
    return;
  }
  if (site.startsWith("stop_pid")) { state.stopped.add("gnb-1"); return; }
  if (site.startsWith("remove_subscriber")) { state.subscriberPresent = false; return; }
  if (site.startsWith("copy_active_configs")) { state.mismatchedProfileFields = ["key"]; return; }
  throw new Error(`simulator: no laboratory behaviour for ${JSON.stringify(argv) || site}`);
}

function twinState(caseSpec, { faulted }) {
  const state = {
    policyArgv: [...BASELINE_POLICY_ARGV],
    routes: BASELINE_ROUTES.map((route) => ({ ...route })),
    stopped: new Set(),
    subscriberPresent: true,
    mismatchedProfileFields: [],
  };
  if (caseSpec.ground_truth.partition === "hidden") state.policyArgv.push(HIDDEN_NOISE_ARGV);
  if (faulted) for (const delta of caseSpec.ground_truth.fault_deltas ?? []) applyInjection(state, delta);
  return state;
}

function observationRecords(state, trialId) {
  const checkedFields = ["amf", "key", "op", "supi"];
  return {
    network_policy: [{
      resource_id: "amf", resource_type: "service", namespace_id: trialId, resolution: "resolved",
      read_only: true, diagnostic_profile: "network_policy",
      contract_version: "opsmind-network-observation/1.0", sampling_mode: "kernel_policy_snapshot",
      kernel_namespace: "host", policy_backend: "iptables", policy_scope: "kernel_namespace_only",
      causal_conclusion: "not_computed", source_ref: `protocol-lab:${trialId}:network_policy:host`,
      observed_at: "2026-09-20T12:00:00Z", policy_digest: "c".repeat(64),
      tables: policyTables(state.policyArgv),
    }],
    process_state: RESOURCES.map((resource) => {
      const active = !state.stopped.has(resource.resource_id);
      return { ...resource, namespace_id: trialId, resolution: "resolved", read_only: true,
        diagnostic_profile: "process_summary", active, status: active ? "running" : "stopped" };
    }),
    subscriber: [{
      subscriber_present: state.subscriberPresent,
      ue_profile_available: true, reference_profile_available: true,
      checked_fields: checkedFields,
      authentication_profile_consistent: state.mismatchedProfileFields.length === 0,
      mismatched_fields: [...state.mismatchedProfileFields],
      secret_values_exposed: false,
    }],
    routes: [{ node_profile: "upf", routes: state.routes.map((route) => ({ ...route })) }],
  };
}

const LINEAGE_BY_FAMILY = Object.freeze({
  network_policy: "lab.resource_observation.sandboxed_readonly_diagnostic",
  process_state: "lab.resource_observation.service_health",
  subscriber: "lab.resource_observation.subscriber_auth_consistency",
  routes: "lab.resource_observation.routes",
});

/**
 * The observations one read-only sweep of the laboratory returns.
 *
 * `phase` is "baseline" for the frozen reference snapshot the laboratory
 * publishes with every trial, and "current" for the live sweep.
 */
export function labObservations(caseSpec, { faulted, phase, trialId = "trial-baseline" }) {
  const records = observationRecords(twinState(caseSpec, { faulted }), trialId);
  return Object.entries(records).map(([family, rows]) => ({
    family,
    evidence_id: `lab-${phase}-${family}`,
    item: {
      evidence_id: `lab-${phase}-${family}`,
      source_type: "protocol_lab_resource_observation",
      source_lineage: LINEAGE_BY_FAMILY[family],
      quality: "verified", freshness: "live", completeness: "complete", substantive: 1,
      protocol_trial_id: trialId,
      scope_json: { namespace: trialId, resource_refs: [] },
      raw_value_json: { trial_id: trialId, partial: false, production_network: false,
        source_lineage: LINEAGE_BY_FAMILY[family], records: rows },
    },
  }));
}
