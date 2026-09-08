// Public observation semantics, independent of Case labels. Running alone
// does not prove service health, socket readiness or end-to-end recovery.
export function protocolServiceHealthReferences(item) {
  const raw = item?.raw_value_json;
  const scope = item?.scope_json;
  if (item?.source_type !== "protocol_lab_resource_observation" ||
      item.source_lineage !== "lab.resource_observation.service_health" ||
      item.quality !== "verified" || item.freshness !== "live" ||
      !["complete", "partial"].includes(item.completeness) ||
      ![true, 1].includes(item.substantive) ||
      raw?.partial !== (item.completeness === "partial") || raw.production_network !== false ||
      raw.source_lineage !== item.source_lineage || !scope?.namespace ||
      item.protocol_trial_id !== scope.namespace || raw.trial_id !== scope.namespace ||
      !Array.isArray(scope.resource_refs) || !Array.isArray(raw.records)) return [];
  // Batch coverage and an individual object's verified health are independent.
  // Unknown neighbours do not erase complete facts; every credited row still
  // needs its own authorized identity, process and owned-listener proof.
  return [...new Set(raw.records.flatMap((record) => {
    const authorized = scope.resource_refs.some((ref) => ref.identifier_domain === "opsmind-twin" &&
      ref.namespace === scope.namespace && ref.resource_type === "service" && ref.resource_id === record.resource_id);
    return authorized && record.namespace_id === scope.namespace && record.resource_type === "service" &&
      record.resolution === "resolved" && record.read_only === true && record.active === true &&
      record.ready === true && record.health === "healthy" &&
      record.health_scope === "local_process_listener" &&
      record.checks?.process_active === true && record.checks?.owned_protocol_listener === true &&
      Number.isSafeInteger(record.process_id) && record.process_id > 0 &&
      ["sctp", "udp", "tcp"].includes(record.listener_protocol) &&
      Array.isArray(record.listeners) && record.listeners.some((line) =>
        typeof line === "string" && new RegExp("\\bpid=" + record.process_id + ",").test(line)) &&
      typeof record.resource_id === "string" &&
      /^[a-zA-Z0-9_.-]+$/.test(record.resource_id)
      ? [`process:${record.resource_id.toLowerCase()}-healthy`] : [];
  }))];
}


// A capture summary proves protocol presence in that capture only. It cannot
// prove a particular interface, current connectivity, packet direction or DROP.
function protocolCaptureReferences(item) {
  const raw = item?.raw_value_json;
  const scope = item?.scope_json;
  const source = `protocol-lab:${scope?.namespace}:protocol_summary`;
  if (item?.source_type !== "protocol_lab" || item.source_lineage !== "lab.packet_capture" ||
      item.quality !== "verified" || item.freshness !== "snapshot" ||
      item.completeness !== "complete" || ![true, 1].includes(item.substantive) ||
      !scope?.namespace || item.protocol_trial_id !== scope.namespace ||
      raw?.trial_id !== scope.namespace || raw.source_lineage !== item.source_lineage ||
      raw.production_network !== false || raw.partial !== false ||
      item.source_ref !== source || raw.source_ref !== source ||
      typeof raw.protocol_lab_call_id !== "string" || !raw.protocol_lab_call_id ||
      !Array.isArray(scope.resource_refs) ||
      !scope.resource_refs.some((ref) => ref.identifier_domain === "opsmind-twin" &&
        ref.namespace === scope.namespace && ref.resource_type === "runtime") ||
      !Array.isArray(raw.records)) return [];
  return [...new Set(raw.records.flatMap((record) => {
    const summary = record?.capture_summary;
    if (record?.observation_available !== true ||
        !validCaptureContract(record) ||
        record.source_ref !== source ||
        !Number.isSafeInteger(summary?.files) || summary.files <= 0 ||
        !Number.isSafeInteger(summary?.bytes) || summary.bytes <= 0 ||
        !summary.protocol_frames || typeof summary.protocol_frames !== "object" ||
        Array.isArray(summary.protocol_frames)) return [];
    return Object.entries(summary.protocol_frames)
      .filter(([protocol, count]) => /^[a-z][a-z0-9_]*$/.test(protocol) &&
        Number.isSafeInteger(count) && count > 0)
      .map(([protocol]) => `pcap:${protocol}-observed`);
  }))];
}

function validCaptureContract(record) {
  // Preserve old receipt interpretation; new observations declare their schema.
  if (record.sampling_mode === "existing_capture_summary") {
    return record.protocol_counts_file_scope === "first_capture_file";
  }
  const inventory = record.capture_inventory;
  const start = Date.parse(record.capture_time_range?.start);
  const end = Date.parse(record.capture_time_range?.end);
  return record.contract_version === "opsmind-network-observation/1.0" &&
    record.sampling_mode === "retained_capture_window" && record.read_only === true &&
    record.location_coverage === "one_host_capture" &&
    record.capture_point?.kernel_namespace === "host" &&
    record.capture_point?.interface === "any" && record.capture_point?.separate_link_endpoints === false &&
    record.coverage?.status === "retained_files_scanned" &&
    record.coverage?.time_range_semantics === "matching_frames_only" &&
    Number.isFinite(Date.parse(record.summary_read_at)) &&
    Number.isFinite(start) && Number.isFinite(end) && start <= end &&
    Number.isSafeInteger(record.matched_frames) && record.matched_frames > 0 &&
    Array.isArray(inventory) && inventory.length === record.capture_summary?.files &&
    inventory.every((item) => Number.isSafeInteger(item.bytes) && item.bytes >= 0 &&
      Number.isSafeInteger(item.analysed_bytes) && (item.analysed_bytes === 0 || item.analysed_bytes >= 24) &&
      Number.isSafeInteger(item.incomplete_tail_bytes) && item.incomplete_tail_bytes >= 0 &&
      item.analysed_bytes + item.incomplete_tail_bytes === item.bytes &&
      /^[a-f0-9]{64}$/.test(item.sha256)) &&
    inventory.reduce((sum, item) => sum + item.bytes, 0) === record.capture_summary?.bytes;
}

// Rule presence is an observation, not proof that it caused this incident.
// The Agent interprets hook order, selectors, counters and packet evidence.
// No Case ID, expected action or fault-injection cache participates here.
function protocolPolicyReferences(item, kernelNamespaces = ["host", "opsmind-ue", "opsmind-ah-mec"]) {
  const raw = item?.raw_value_json, scope = item?.scope_json;
  if (item?.source_type !== "protocol_lab_resource_observation" ||
      item.source_lineage !== "lab.resource_observation.sandboxed_readonly_diagnostic" ||
      item.quality !== "verified" || item.freshness !== "live" ||
      !["complete", "partial"].includes(item.completeness) || ![true, 1].includes(item.substantive) ||
      raw?.partial !== (item.completeness === "partial") || raw.production_network !== false ||
      raw.source_lineage !== item.source_lineage || !scope?.namespace ||
      item.protocol_trial_id !== scope.namespace || raw.trial_id !== scope.namespace ||
      !Array.isArray(scope.resource_refs) || !Array.isArray(raw.records)) return [];
  return [...new Set(raw.records.flatMap((record) => {
    const authorized = scope.resource_refs.some((ref) => ref.identifier_domain === "opsmind-twin" &&
      ref.namespace === scope.namespace && ref.resource_type === record.resource_type &&
      ref.resource_id === record.resource_id);
    if (!authorized || record.namespace_id !== scope.namespace || record.resolution !== "resolved" ||
        record.read_only !== true || record.diagnostic_profile !== "network_policy" ||
        record.contract_version !== "opsmind-network-observation/1.0" ||
        record.sampling_mode !== "kernel_policy_snapshot" || record.policy_backend !== "iptables" ||
        record.policy_scope !== "kernel_namespace_only" || record.causal_conclusion !== "not_computed" ||
        !kernelNamespaces.includes(record.kernel_namespace) ||
        record.source_ref !== "protocol-lab:" + scope.namespace + ":network_policy:" + record.kernel_namespace ||
        !Number.isFinite(Date.parse(record.observed_at)) ||
        !/^[a-f0-9]{64}$/.test(record.policy_digest) || !Array.isArray(record.tables)) return [];
    return record.tables.flatMap((table) => {
      if (table.table !== "filter" || !Array.isArray(table.rules) || !Array.isArray(table.chains)) return [];
      return table.rules.flatMap((rule) => {
        if (!table.chains.some((chain) => chain.name === rule.chain) || rule.target !== "DROP" ||
            rule.has_negation !== false || !["sctp", "udp", "tcp"].includes(rule.protocol) ||
            !/^[1-9][0-9]{0,4}$/.test(rule.destination_port) || Number(rule.destination_port) > 65535 ||
            !Number.isSafeInteger(rule.position) || rule.position < 1 ||
            !Number.isSafeInteger(rule.packets) || rule.packets < 0 ||
            !Number.isSafeInteger(rule.bytes) || rule.bytes < 0) return [];
        return ["policy:" + rule.protocol + ":" + rule.destination_port + ":drop-rule-present"];
      });
    });
  }))];
}

export function protocolEvidenceReferences(item) {
  return [...protocolServiceHealthReferences(item), ...protocolCaptureReferences(item),
    ...protocolPolicyReferences(item), ...langGraphProtocolReferences(item)];
}

function langGraphProtocolReferences(item) {
  const context = item?.observation_context, scope = context?.resource_scope;
  const capability = context?.capability;
  const lineage = { service_health: "lab.resource_observation.service_health",
    sandboxed_readonly_diagnostic: "lab.resource_observation.sandboxed_readonly_diagnostic",
    protocol_summary: "lab.packet_capture" }[capability];
  if (!lineage || item?.evidence_type !== "mcp.tool_result" ||
      context?.contract_version !== "opsmind-lg-protocol-observation/1.0" ||
      context.production_network !== false || scope?.identifier_domain !== "opsmind-twin" ||
      typeof scope.namespace !== "string" || !scope.namespace || context.trial_id !== scope.namespace ||
      !Array.isArray(scope.resource_refs) || !scope.resource_refs.length ||
      !scope.resource_refs.every((ref) => ref?.identifier_domain === "opsmind-twin" &&
        ref.namespace === scope.namespace && typeof ref.resource_id === "string" && ref.resource_id &&
        typeof ref.resource_type === "string" && ref.resource_type) ||
      !["protocol-lab." + capability, "candidate-observation." + capability].includes(item.source_system) ||
      ![item.tenant_id, item.scope_snapshot_id, item.investigation_id, item.tool_call_id, item.evidence_id]
        .every((value) => typeof value === "string" && value) ||
      !Number.isFinite(Date.parse(item.observed_at)) || item.quality !== "verified" ||
      !Array.isArray(item.records) || typeof item.partial !== "boolean" ||
      !["complete", "filtered_complete", "upstream_partial"].includes(item.coverage) ||
      item.freshness !== (capability === "protocol_summary" ? "snapshot" : "live")) return [];
  // Interpret the LG-native, gateway-attested scope with the same fact rules.
  // This view is internal to grading; it does not create an AH receipt or alter the trace.
  const source = `protocol-lab:${scope.namespace}:protocol_summary`;
  const view = { source_type: capability === "protocol_summary" ? "protocol_lab" : "protocol_lab_resource_observation",
    source_lineage: lineage, source_ref: source, protocol_trial_id: scope.namespace,
    scope_json: scope, quality: item.quality,
    freshness: capability === "protocol_summary" ? "snapshot" : item.freshness,
    completeness: item.partial ? "partial" : "complete", substantive: item.records.length > 0,
    raw_value_json: { records: item.records, partial: item.partial, trial_id: scope.namespace,
      source_lineage: lineage, source_ref: source, production_network: false,
      protocol_lab_call_id: `langgraph:${item.tool_call_id}` } };
  return [...protocolServiceHealthReferences(view), ...protocolCaptureReferences(view),
    ...protocolPolicyReferences(view, ["host", "opsmind-ue", "opsmind-lg-mec"])];
}
