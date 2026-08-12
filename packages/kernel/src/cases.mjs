import { sha256 } from "./utils.mjs";

export const CASES = {
  "SMOKE-RCA-001": {
    id: "SMOKE-RCA-001",
    version: "1.0.0",
    goal: "定位仓库业务时延升高的首要根因，引用至少三条跨来源证据，并说明排除项。",
    visible: {
      tenant: "factory-a",
      scope: "UE -> gNB -> 5GC -> UPF/N6 -> WMS",
      time_window: "2026-08-13T00:00:00Z/2026-08-13T00:15:00Z",
      success_criteria: { minimum_evidence_sources: 3, require_alternative_exclusion: true },
    },
    tools: {
      get_alerts: {
        description: "Read current alarms for the scoped tenant and time window.",
        result: {
          alerts: [{ id: "a-17", entity: "UPF-01", symptom: "N6 packet loss", severity: "critical" }],
          signals: [{ component: "upf-n6-path", confidence: 0.72, evidence_ref: "alert:a-17" }],
          evidence_refs: ["alert:a-17"],
        },
      },
      query_logs: {
        description: "Query correlated network and application logs.",
        result: {
          matches: [{ id: "log-44", message: "UPF-01 N6 retransmit threshold exceeded before WMS latency rise" }],
          signals: [{ component: "upf-n6-path", confidence: 0.91, evidence_ref: "log:log-44" }],
          evidence_refs: ["log:log-44"],
        },
      },
      query_metrics: {
        description: "Query time-aligned network and service metrics.",
        result: {
          series: [
            { id: "metric-n6-loss", entity: "UPF-01/N6", value: 7.4, unit: "%" },
            { id: "metric-smf-ok", entity: "SMF-01", value: 99.99, unit: "% success" },
          ],
          signals: [
            { component: "upf-n6-path", confidence: 0.95, evidence_ref: "metric:metric-n6-loss" },
            { component: "smf-control-plane", confidence: 0.08, evidence_ref: "metric:metric-smf-ok", exclusion: true },
          ],
          evidence_refs: ["metric:metric-n6-loss", "metric:metric-smf-ok"],
        },
      },
      run_probe: {
        description: "Run an authorized read-only active probe along the service path.",
        result: {
          probes: [{ id: "probe-8", segment: "N6->WMS", packet_loss: 7.2, control_plane_ok: true }],
          signals: [{ component: "upf-n6-path", confidence: 0.94, evidence_ref: "probe:probe-8" }],
          evidence_refs: ["probe:probe-8"],
        },
      },
    },
    ground_truth: {
      root_causes: ["upf-n6-path"],
      required_evidence: ["alert:a-17", "metric:metric-n6-loss", "log:log-44"],
      forbidden_claims: ["smf-control-plane"],
      requires_tool_recovery: false,
    },
  },
  "SMOKE-RECOVERY-001": {
    id: "SMOKE-RECOVERY-001",
    version: "1.0.0",
    goal: "在日志连接器首次失败的条件下继续调查，判断告警缺口的根因并提供替代证据。",
    visible: {
      tenant: "factory-b",
      scope: "NMS/metrics/log connector",
      time_window: "2026-08-13T01:00:00Z/2026-08-13T01:15:00Z",
      success_criteria: { minimum_evidence_sources: 3, require_tool_failure_recovery: true },
    },
    tools: {
      get_alerts: {
        description: "Read current alarms and ingestion health notices.",
        result: {
          alerts: [{ id: "a-29", entity: "log-connector-2", symptom: "ingestion lag and 429 rate limit" }],
          signals: [{ component: "log-connector-rate-limit", confidence: 0.7, evidence_ref: "alert:a-29" }],
          evidence_refs: ["alert:a-29"],
        },
      },
      query_logs: {
        description: "Query the primary log connector; the environment may return a transient failure.",
        failures_before_success: 1,
        failure: { code: 429, retryable: true, message: "log connector rate limited" },
        result: {
          matches: [{ id: "log-health-2", message: "connector recovered after backoff" }],
          signals: [{ component: "log-connector-rate-limit", confidence: 0.83, evidence_ref: "log:log-health-2" }],
          evidence_refs: ["log:log-health-2"],
        },
      },
      query_metrics: {
        description: "Query independent connector throughput and queue metrics.",
        result: {
          series: [{ id: "metric-ingest-429", entity: "log-connector-2", value: 184, unit: "429/min" }],
          signals: [{ component: "log-connector-rate-limit", confidence: 0.93, evidence_ref: "metric:metric-ingest-429" }],
          evidence_refs: ["metric:metric-ingest-429"],
        },
      },
      run_probe: {
        description: "Use an independent read-only connector health probe.",
        result: {
          probes: [{ id: "probe-connector", primary_logs: "429", metrics_path: "healthy", retry_after_ms: 1200 }],
          signals: [{ component: "log-connector-rate-limit", confidence: 0.96, evidence_ref: "probe:probe-connector" }],
          evidence_refs: ["probe:probe-connector"],
        },
      },
    },
    ground_truth: {
      root_causes: ["log-connector-rate-limit"],
      required_evidence: ["alert:a-29", "metric:metric-ingest-429", "probe:probe-connector"],
      forbidden_claims: ["network-outage"],
      requires_tool_recovery: true,
    },
  },
};

export const DATASET_HASH = sha256(CASES);

export function createCaseEnvironment(caseSpec) {
  const calls = new Map();
  return {
    async call(toolName, args = {}) {
      const definition = caseSpec.tools[toolName];
      if (!definition) return { ok: false, error: { code: "TOOL_NOT_FOUND", message: `unknown tool: ${toolName}` } };
      const count = (calls.get(toolName) ?? 0) + 1;
      calls.set(toolName, count);
      if (definition.failures_before_success && count <= definition.failures_before_success) {
        return { ok: false, error: definition.failure, tool: toolName, attempt: count };
      }
      return { ok: true, tool: toolName, args, data: structuredClone(definition.result), attempt: count };
    },
    calls,
  };
}

