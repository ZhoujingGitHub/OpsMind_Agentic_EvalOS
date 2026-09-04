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
      record.ready === true && record.health === "healthy" && typeof record.resource_id === "string" &&
      /^[a-zA-Z0-9_.-]+$/.test(record.resource_id)
      ? [`process:${record.resource_id.toLowerCase()}-healthy`] : [];
  }))];
}
