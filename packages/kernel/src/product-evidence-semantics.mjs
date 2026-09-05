// Public observation semantics, independent of Case labels. Running alone
// does not prove service health, socket readiness or end-to-end recovery.
export function protocolServiceHealthReferences(item) {
  const raw = item?.raw_value_json;
  const scope = item?.scope_json;
  if (item?.source_type !== "protocol_lab_resource_observation" ||
      item.source_lineage !== "lab.resource_observation.service_health" ||
      item.quality !== "verified" || item.freshness !== "live" || item.completeness !== "complete" ||
      ![true, 1].includes(item.substantive) || raw?.partial !== false || raw.production_network !== false ||
      raw.source_lineage !== item.source_lineage || !scope?.namespace ||
      item.protocol_trial_id !== scope.namespace || raw.trial_id !== scope.namespace ||
      !Array.isArray(scope.resource_refs) || !Array.isArray(raw.records)) return [];
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
        record.sampling_mode !== "existing_capture_summary" ||
        record.protocol_counts_file_scope !== "first_capture_file" ||
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

export function protocolEvidenceReferences(item) {
  return [...protocolServiceHealthReferences(item), ...protocolCaptureReferences(item)];
}
