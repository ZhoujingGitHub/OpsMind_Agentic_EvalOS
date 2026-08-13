import { sha256 } from "./utils.mjs";

export const SMOKE_CASES = {
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

function goldenCase({ id, goal, scope, tools, rootCause, rootCauseAliases = [], requiredEvidence, forbiddenClaims = [], expectedStatus = "resolved", recovery = false, minimumEvidenceSources = 3 }) {
  return {
    id,
    version: "1.0.0",
    goal,
    visible: {
      tenant: `pilot-${id.toLowerCase()}`,
      scope,
      time_window: "2026-08-13T02:00:00Z/2026-08-13T02:15:00Z",
      success_criteria: {
        minimum_evidence_sources: minimumEvidenceSources,
        require_alternative_exclusion: true,
        require_tool_failure_recovery: recovery,
      },
    },
    tools,
    ground_truth: {
      root_causes: [rootCause, ...rootCauseAliases],
      required_evidence: requiredEvidence,
      forbidden_claims: forbiddenClaims,
      expected_status: expectedStatus,
      requires_tool_recovery: recovery,
    },
  };
}

export const PILOT_CASES = {
  "PILOT-REG-001": goldenCase({
    id: "PILOT-REG-001",
    goal: "定位一批企业园区终端持续注册失败的首要根因，引用跨来源证据，并排除无线覆盖故障。",
    scope: "UE/CPE -> gNB -> AMF -> UDM",
    rootCause: "udm-subscriber-provisioning",
    rootCauseAliases: ["UDM subscriber provisioning", "UDM 批量用户导入", "UDM 签约数据"],
    requiredEvidence: ["log:amf-reg-101", "event:udm-profile-101", "metric:ran-rsrp-ok-101"],
    forbiddenClaims: ["gnb-radio-outage"],
    tools: {
      get_alerts: { description: "读取注册失败告警和受影响终端分布。", result: { alerts: [{ id: "alert-reg-101", symptom: "5GMM registration reject", affected_ues: 37 }], evidence_refs: ["alert:reg-101"] } },
      query_logs: { description: "查询 AMF 注册过程日志。", result: { matches: [{ id: "amf-reg-101", message: "UDM subscription data not found; reject cause 9" }], signals: [{ component: "udm-subscriber-provisioning", confidence: 0.96, evidence_ref: "log:amf-reg-101" }], evidence_refs: ["log:amf-reg-101"] } },
      query_events: { description: "查询 UDM 用户数据变更事件。", result: { events: [{ id: "udm-profile-101", message: "bulk import skipped IMSI range 46000170xxxx" }], signals: [{ component: "udm-subscriber-provisioning", confidence: 0.93, evidence_ref: "event:udm-profile-101" }], evidence_refs: ["event:udm-profile-101"] } },
      query_metrics: { description: "查询同期无线接入质量，验证是否存在覆盖故障。", result: { series: [{ id: "ran-rsrp-ok-101", metric: "RSRP", value: -84, unit: "dBm", status: "healthy" }], signals: [{ component: "gnb-radio-outage", confidence: 0.04, exclusion: true, evidence_ref: "metric:ran-rsrp-ok-101" }], evidence_refs: ["metric:ran-rsrp-ok-101"] } },
    },
  }),
  "PILOT-AUTH-002": goldenCase({
    id: "PILOT-AUTH-002",
    goal: "调查终端鉴权异常，给出最可能责任域和可验证的下一步，避免把正常的 RAN 波动误判为根因。",
    scope: "UE -> AMF -> AUSF -> UDM",
    rootCause: "ausf-authentication-vector",
    rootCauseAliases: ["AUSF authentication vector", "AUTS resynchronization", "AUSF 鉴权向量", "密钥轮换"],
    requiredEvidence: ["log:ausf-sync-202", "metric:auth-fail-202", "event:udm-key-202"],
    forbiddenClaims: ["ran-interference"],
    tools: {
      query_logs: { description: "查询 AMF/AUSF 鉴权日志。", result: { matches: [{ id: "ausf-sync-202", message: "AUTS resynchronization failed for affected subscriber batch" }], signals: [{ component: "ausf-authentication-vector", confidence: 0.91, evidence_ref: "log:ausf-sync-202" }], evidence_refs: ["log:ausf-sync-202"] } },
      query_metrics: { description: "查询鉴权成功率与无线质量。", result: { series: [{ id: "auth-fail-202", metric: "5G-AKA failure rate", value: 38, unit: "%" }, { id: "ran-ok-202", metric: "RRC setup success", value: 99.4, unit: "%" }], signals: [{ component: "ausf-authentication-vector", confidence: 0.94, evidence_ref: "metric:auth-fail-202" }, { component: "ran-interference", confidence: 0.03, exclusion: true, evidence_ref: "metric:ran-ok-202" }], evidence_refs: ["metric:auth-fail-202", "metric:ran-ok-202"] } },
      query_events: { description: "查询 UDM 密钥和用户档案变更。", result: { events: [{ id: "udm-key-202", message: "authentication key rotation partially applied" }], signals: [{ component: "ausf-authentication-vector", confidence: 0.9, evidence_ref: "event:udm-key-202" }], evidence_refs: ["event:udm-key-202"] } },
      run_probe: { description: "运行只读鉴权合成探测。", result: { probes: [{ id: "auth-probe-202", result: "AUTN verification failed", radio_path: "healthy" }], evidence_refs: ["probe:auth-202"] } },
    },
  }),
  "PILOT-PDU-003": goldenCase({
    id: "PILOT-PDU-003",
    goal: "定位 PDU Session 建立失败的根因，区分 DNN/策略问题与 UPF 可用性问题。",
    scope: "UE -> AMF -> SMF -> UPF -> enterprise-DN",
    rootCause: "smf-dnn-routing-policy",
    rootCauseAliases: ["DNN routing policy", "DNN 路由策略"],
    requiredEvidence: ["log:smf-dnn-303", "change:route-policy-303", "probe:upf-ok-303"],
    forbiddenClaims: ["upf-process-down"],
    tools: {
      query_logs: { description: "查询 SMF PDU Session 日志。", result: { matches: [{ id: "smf-dnn-303", message: "DNN factory.private has no matching route policy" }], signals: [{ component: "smf-dnn-routing-policy", confidence: 0.95, evidence_ref: "log:smf-dnn-303" }], evidence_refs: ["log:smf-dnn-303"] } },
      query_changes: { description: "查询 DNN 与路由策略变更。", result: { changes: [{ id: "route-policy-303", message: "factory.private route policy removed during cleanup" }], signals: [{ component: "smf-dnn-routing-policy", confidence: 0.93, evidence_ref: "change:route-policy-303" }], evidence_refs: ["change:route-policy-303"] } },
      query_metrics: { description: "查询 PDU Session 成功率和 UPF 健康度。", result: { series: [{ id: "pdu-fail-303", metric: "PDU establish success", value: 61, unit: "%" }, { id: "upf-health-303", metric: "UPF heartbeat", value: 100, unit: "%" }], evidence_refs: ["metric:pdu-fail-303", "metric:upf-health-303"] } },
      run_probe: { description: "对候选 UPF 做受控只读探测。", result: { probes: [{ id: "upf-ok-303", control: "healthy", user_plane: "healthy for other DNNs" }], signals: [{ component: "upf-process-down", confidence: 0.02, exclusion: true, evidence_ref: "probe:upf-ok-303" }], evidence_refs: ["probe:upf-ok-303"] } },
    },
  }),
  "PILOT-RAN-004": goldenCase({
    id: "PILOT-RAN-004",
    goal: "调查车间边缘区域 RAN 接入质量下降，定位首要原因并排除核心网容量不足。",
    scope: "UE -> gNB cell-04 -> AMF/UPF",
    rootCause: "gnb-radio-interference",
    rootCauseAliases: ["radio interference", "无线干扰", "宽带干扰", "中继器干扰"],
    requiredEvidence: ["metric:sinr-drop-404", "event:interference-404", "metric:core-ok-404"],
    forbiddenClaims: ["5gc-capacity-exhaustion"],
    tools: {
      query_metrics: { description: "查询小区无线、接入和核心网指标。", result: { series: [{ id: "sinr-drop-404", metric: "SINR p10", value: -3, unit: "dB" }, { id: "core-ok-404", metric: "AMF CPU", value: 31, unit: "%" }], signals: [{ component: "gnb-radio-interference", confidence: 0.9, evidence_ref: "metric:sinr-drop-404" }, { component: "5gc-capacity-exhaustion", confidence: 0.03, exclusion: true, evidence_ref: "metric:core-ok-404" }], evidence_refs: ["metric:sinr-drop-404", "metric:core-ok-404"] } },
      query_events: { description: "查询射频环境与邻区事件。", result: { events: [{ id: "interference-404", message: "wideband interference rose after unlicensed repeater powered on" }], signals: [{ component: "gnb-radio-interference", confidence: 0.94, evidence_ref: "event:interference-404" }], evidence_refs: ["event:interference-404"] } },
      get_alerts: { description: "查询小区告警。", result: { alerts: [{ id: "ran-quality-404", symptom: "high BLER and RRC retries" }], evidence_refs: ["alert:ran-quality-404"] } },
      run_probe: { description: "执行只读无线接入对比探测。", result: { probes: [{ id: "ran-probe-404", edge_cell: "degraded", neighbor_cell: "healthy" }], evidence_refs: ["probe:ran-404"] } },
    },
  }),
  "PILOT-N3-005": goldenCase({
    id: "PILOT-N3-005",
    goal: "定位 N3 用户面丢包，给出跨 gNB、承载与 UPF 的因果证据，排除 N6 出口故障。",
    scope: "gNB -> N3 transport -> UPF -> N6",
    rootCause: "n3-transport-packet-loss",
    rootCauseAliases: ["N3 packet loss", "N3 transport packet loss", "N3 承载丢包", "N3 上联 CRC"],
    requiredEvidence: ["metric:n3-loss-505", "log:transport-crc-505", "probe:n6-ok-505"],
    forbiddenClaims: ["n6-egress-congestion"],
    tools: {
      query_metrics: { description: "查询 N3/N6 分段丢包与接口指标。", result: { series: [{ id: "n3-loss-505", segment: "gNB-UPF/N3", loss: 6.8, unit: "%" }, { id: "n6-ok-505", segment: "UPF-DN/N6", loss: 0.02, unit: "%" }], signals: [{ component: "n3-transport-packet-loss", confidence: 0.94, evidence_ref: "metric:n3-loss-505" }], evidence_refs: ["metric:n3-loss-505", "metric:n6-ok-505"] } },
      query_logs: { description: "查询承载接口错误日志。", result: { matches: [{ id: "transport-crc-505", message: "CRC and input error burst on N3 uplink" }], signals: [{ component: "n3-transport-packet-loss", confidence: 0.92, evidence_ref: "log:transport-crc-505" }], evidence_refs: ["log:transport-crc-505"] } },
      run_probe: { description: "对 N3 与 N6 分段做受控探测。", result: { probes: [{ id: "n6-ok-505", n3_loss: 6.5, n6_loss: 0.0 }], signals: [{ component: "n6-egress-congestion", confidence: 0.02, exclusion: true, evidence_ref: "probe:n6-ok-505" }], evidence_refs: ["probe:n6-ok-505"] } },
      get_alerts: { description: "读取承载告警。", result: { alerts: [{ id: "n3-port-505", symptom: "physical input errors" }], evidence_refs: ["alert:n3-port-505"] } },
    },
  }),
  "PILOT-N6-006": goldenCase({
    id: "PILOT-N6-006",
    goal: "调查企业应用时延升高与丢包，定位 N6 出口是否拥塞，并排除 5GC 控制面异常。",
    scope: "UE -> 5GC -> UPF -> N6 -> enterprise-DN",
    rootCause: "n6-egress-congestion",
    rootCauseAliases: ["N6 egress congestion", "N6 出口拥塞", "N6 queue"],
    requiredEvidence: ["metric:n6-queue-606", "log:n6-drop-606", "metric:smf-ok-606"],
    forbiddenClaims: ["smf-control-plane"],
    tools: {
      query_metrics: { description: "查询 N6 队列、丢包、时延和 SMF 指标。", result: { series: [{ id: "n6-queue-606", metric: "N6 queue utilization", value: 98, unit: "%" }, { id: "smf-ok-606", metric: "SMF success", value: 99.98, unit: "%" }], signals: [{ component: "n6-egress-congestion", confidence: 0.95, evidence_ref: "metric:n6-queue-606" }, { component: "smf-control-plane", confidence: 0.01, exclusion: true, evidence_ref: "metric:smf-ok-606" }], evidence_refs: ["metric:n6-queue-606", "metric:smf-ok-606"] } },
      query_logs: { description: "查询 UPF N6 丢弃日志。", result: { matches: [{ id: "n6-drop-606", message: "egress queue tail drops exceed threshold" }], signals: [{ component: "n6-egress-congestion", confidence: 0.93, evidence_ref: "log:n6-drop-606" }], evidence_refs: ["log:n6-drop-606"] } },
      query_events: { description: "查询企业出口链路事件。", result: { events: [{ id: "link-busy-606", message: "backup replication overlapped production peak" }], evidence_refs: ["event:link-busy-606"] } },
      run_probe: { description: "执行 N6 到企业 DN 的受控探测。", result: { probes: [{ id: "n6-probe-606", latency_ms: 184, loss_pct: 5.9, control_plane: "healthy" }], evidence_refs: ["probe:n6-606"] } },
    },
  }),
  "PILOT-UPF-007": goldenCase({
    id: "PILOT-UPF-007",
    goal: "调查 UPF 间歇性用户面异常，判断是资源压力、进程故障还是外部链路问题。",
    scope: "SMF -> UPF-07 -> N3/N6",
    rootCause: "upf-process-memory-pressure",
    rootCauseAliases: ["UPF memory pressure", "UPF 内存压力", "UPF OOM", "memory cgroup OOM"],
    requiredEvidence: ["metric:upf-mem-707", "log:upf-oom-707", "probe:links-ok-707"],
    forbiddenClaims: ["external-link-failure"],
    tools: {
      query_metrics: { description: "查询 UPF 进程、节点和接口指标。", result: { series: [{ id: "upf-mem-707", metric: "UPF RSS", value: 96, unit: "% memory" }], signals: [{ component: "upf-process-memory-pressure", confidence: 0.94, evidence_ref: "metric:upf-mem-707" }], evidence_refs: ["metric:upf-mem-707"] } },
      query_logs: { description: "查询 UPF 进程和内核日志。", result: { matches: [{ id: "upf-oom-707", message: "UPF worker reclaimed after memory cgroup OOM" }], signals: [{ component: "upf-process-memory-pressure", confidence: 0.97, evidence_ref: "log:upf-oom-707" }], evidence_refs: ["log:upf-oom-707"] } },
      get_alerts: { description: "读取 UPF 存活和资源告警。", result: { alerts: [{ id: "upf-restart-707", symptom: "worker restarted twice" }], evidence_refs: ["alert:upf-restart-707"] } },
      run_probe: { description: "执行 N3/N6 外部链路探测。", result: { probes: [{ id: "links-ok-707", n3: "healthy after process restart", n6: "healthy" }], signals: [{ component: "external-link-failure", confidence: 0.03, exclusion: true, evidence_ref: "probe:links-ok-707" }], evidence_refs: ["probe:links-ok-707"] } },
    },
  }),
  "PILOT-MEC-008": goldenCase({
    id: "PILOT-MEC-008",
    goal: "定位 MEC/WMS 访问时延异常，区分 DNS 解析、应用处理和 5G 用户面问题。",
    scope: "UE -> UPF local breakout -> MEC DNS -> WMS",
    rootCause: "mec-dns-resolution-latency",
    rootCauseAliases: ["MEC DNS latency", "DNS resolution latency", "DNS 解析时延", "DNS 缓存"],
    requiredEvidence: ["metric:dns-latency-808", "log:dns-timeout-808", "metric:wms-ok-808"],
    forbiddenClaims: ["wms-application-overload"],
    tools: {
      query_metrics: { description: "查询 DNS、WMS 和用户面分段时延。", result: { series: [{ id: "dns-latency-808", metric: "DNS p95", value: 620, unit: "ms" }, { id: "wms-ok-808", metric: "WMS processing p95", value: 34, unit: "ms" }], signals: [{ component: "mec-dns-resolution-latency", confidence: 0.95, evidence_ref: "metric:dns-latency-808" }, { component: "wms-application-overload", confidence: 0.02, exclusion: true, evidence_ref: "metric:wms-ok-808" }], evidence_refs: ["metric:dns-latency-808", "metric:wms-ok-808"] } },
      query_logs: { description: "查询 MEC DNS 和应用日志。", result: { matches: [{ id: "dns-timeout-808", message: "upstream DNS retry after stale cache expiry" }], signals: [{ component: "mec-dns-resolution-latency", confidence: 0.92, evidence_ref: "log:dns-timeout-808" }], evidence_refs: ["log:dns-timeout-808"] } },
      run_probe: { description: "分别探测 IP 直连和域名访问。", result: { probes: [{ id: "mec-probe-808", direct_ip_ms: 22, hostname_ms: 644 }], evidence_refs: ["probe:mec-808"] } },
      query_events: { description: "查询 MEC DNS 配置事件。", result: { events: [{ id: "dns-cache-808", message: "cache size reduced before incident" }], evidence_refs: ["event:dns-cache-808"] } },
    },
  }),
  "PILOT-STORM-009": goldenCase({
    id: "PILOT-STORM-009",
    goal: "调查告警风暴与重复事件，识别真实底层问题和放大机制，避免把所有重复告警当成多个独立故障。",
    scope: "NMS alarm pipeline -> gNB/transport events",
    rootCause: "alarm-deduplication-regression",
    rootCauseAliases: ["alarm deduplication regression", "告警去重", "fingerprint normalization", "指纹归一化"],
    requiredEvidence: ["metric:duplicate-rate-909", "change:dedup-rule-909", "log:event-key-909"],
    forbiddenClaims: ["mass-device-failure"],
    tools: {
      get_alerts: { description: "读取告警样本及指纹分布。", result: { alerts: [{ id: "storm-909", count: 18420, unique_fingerprints: 12 }], evidence_refs: ["alert:storm-909"] } },
      query_metrics: { description: "查询告警重复率与设备可用性。", result: { series: [{ id: "duplicate-rate-909", metric: "duplicate ratio", value: 99.1, unit: "%" }, { id: "devices-up-909", metric: "device availability", value: 99.8, unit: "%" }], signals: [{ component: "alarm-deduplication-regression", confidence: 0.92, evidence_ref: "metric:duplicate-rate-909" }, { component: "mass-device-failure", confidence: 0.01, exclusion: true, evidence_ref: "metric:devices-up-909" }], evidence_refs: ["metric:duplicate-rate-909", "metric:devices-up-909"] } },
      query_changes: { description: "查询告警去重规则变更。", result: { changes: [{ id: "dedup-rule-909", message: "fingerprint normalization disabled in release 2.8.4" }], signals: [{ component: "alarm-deduplication-regression", confidence: 0.96, evidence_ref: "change:dedup-rule-909" }], evidence_refs: ["change:dedup-rule-909"] } },
      query_logs: { description: "查询事件管道指纹日志。", result: { matches: [{ id: "event-key-909", message: "same source event emitted with volatile timestamp in dedup key" }], signals: [{ component: "alarm-deduplication-regression", confidence: 0.95, evidence_ref: "log:event-key-909" }], evidence_refs: ["log:event-key-909"] } },
    },
  }),
  "PILOT-CHANGE-010": goldenCase({
    id: "PILOT-CHANGE-010",
    goal: "调查一次网络变更后的性能退化，建立时间因果关系并排除同期应用发布。",
    scope: "transport QoS -> UPF/N6 -> WMS",
    rootCause: "transport-qos-change",
    rootCauseAliases: ["transport QoS change", "QoS 变更", "QoS class remapped"],
    requiredEvidence: ["change:qos-policy-010", "metric:latency-step-010", "event:app-nochange-010"],
    forbiddenClaims: ["wms-release-regression"],
    tools: {
      query_changes: { description: "查询网络和应用变更时间线。", result: { changes: [{ id: "qos-policy-010", message: "transport QoS class remapped 90 seconds before latency step" }], signals: [{ component: "transport-qos-change", confidence: 0.94, evidence_ref: "change:qos-policy-010" }], evidence_refs: ["change:qos-policy-010"] } },
      query_metrics: { description: "查询变更前后分段性能。", result: { series: [{ id: "latency-step-010", metric: "N6 p95", before: 28, after: 176, unit: "ms" }, { id: "app-stable-010", metric: "WMS compute p95", before: 31, after: 32, unit: "ms" }], signals: [{ component: "transport-qos-change", confidence: 0.91, evidence_ref: "metric:latency-step-010" }], evidence_refs: ["metric:latency-step-010", "metric:app-stable-010"] } },
      query_events: { description: "查询同期发布与业务事件。", result: { events: [{ id: "app-nochange-010", message: "no WMS deployment in incident window" }], signals: [{ component: "wms-release-regression", confidence: 0.01, exclusion: true, evidence_ref: "event:app-nochange-010" }], evidence_refs: ["event:app-nochange-010"] } },
      run_probe: { description: "对变更后的 QoS 路径做只读探测。", result: { probes: [{ id: "qos-probe-010", priority_queue: "misclassified", best_effort: "healthy" }], evidence_refs: ["probe:qos-010"] } },
    },
  }),
  "PILOT-GAP-011": goldenCase({
    id: "PILOT-GAP-011",
    goal: "在关键遥测缺失且剩余证据相互冲突时评估能否得出可靠 RCA；若证据不足，明确停止并列出最小补证方案。",
    scope: "UE -> RAN -> 5GC -> UPF -> application (partial telemetry)",
    rootCause: "insufficient-observability",
    rootCauseAliases: ["insufficient observability", "证据不足", "可观测性不足", "telemetry gap"],
    requiredEvidence: ["event:telemetry-gap-011", "metric:conflict-011", "probe:denied-011"],
    forbiddenClaims: ["confirmed-upf-failure", "confirmed-ran-failure"],
    expectedStatus: "inconclusive",
    tools: {
      get_alerts: { description: "读取现有但不完整的告警。", result: { alerts: [{ id: "partial-011", symptom: "generic service degradation", source: "aggregator" }], evidence_refs: ["alert:partial-011"] } },
      query_metrics: { description: "读取互相冲突的残余指标。", result: { series: [{ id: "conflict-011", source: "edge", upf_loss: 4.1 }, { id: "conflict-011b", source: "core", upf_loss: 0.1 }], signals: [{ component: "insufficient-observability", confidence: 0.88, evidence_ref: "metric:conflict-011" }], evidence_refs: ["metric:conflict-011"] } },
      query_events: { description: "查询数据源健康与采集缺口。", result: { events: [{ id: "telemetry-gap-011", message: "RAN and N3 collectors missing for entire fault window" }], signals: [{ component: "insufficient-observability", confidence: 0.96, evidence_ref: "event:telemetry-gap-011" }], evidence_refs: ["event:telemetry-gap-011"] } },
      run_probe: { description: "尝试受控补证探测；当前 Scope 不包含目标端。", result: { probes: [{ id: "denied-011", status: "permission_denied", missing_scope: "target-endpoint" }], signals: [{ component: "insufficient-observability", confidence: 0.94, evidence_ref: "probe:denied-011" }], evidence_refs: ["probe:denied-011"] } },
    },
  }),
  "PILOT-RECOVERY-012": goldenCase({
    id: "PILOT-RECOVERY-012",
    goal: "在主日志连接器首次限流失败的情况下继续调查，通过退避重试或替代工具定位观测缺口根因。",
    scope: "observability pipeline / logs / metrics / connector health",
    rootCause: "log-connector-rate-limit",
    rootCauseAliases: ["log connector rate limit", "日志连接器限流", "HTTP 429", "connector rate limit"],
    requiredEvidence: ["alert:connector-012", "metric:rate-limit-012", "probe:connector-012"],
    forbiddenClaims: ["network-outage"],
    recovery: true,
    tools: {
      get_alerts: { description: "读取连接器健康告警。", result: { alerts: [{ id: "connector-012", symptom: "ingestion lag after HTTP 429" }], signals: [{ component: "log-connector-rate-limit", confidence: 0.78, evidence_ref: "alert:connector-012" }], evidence_refs: ["alert:connector-012"] } },
      query_logs: { description: "查询主日志连接器；第一次调用会返回可重试限流错误。", failures_before_success: 1, failure: { code: 429, retryable: true, message: "log connector rate limited; retry after backoff" }, result: { matches: [{ id: "connector-recovered-012", message: "connector recovered after bounded backoff" }], signals: [{ component: "log-connector-rate-limit", confidence: 0.86, evidence_ref: "log:connector-recovered-012" }], evidence_refs: ["log:connector-recovered-012"] } },
      query_metrics: { description: "查询独立的连接器请求率和队列指标。", result: { series: [{ id: "rate-limit-012", metric: "HTTP 429", value: 221, unit: "events/min" }], signals: [{ component: "log-connector-rate-limit", confidence: 0.95, evidence_ref: "metric:rate-limit-012" }], evidence_refs: ["metric:rate-limit-012"] } },
      run_probe: { description: "使用独立只读健康探测器检查连接器与底层网络。", result: { probes: [{ id: "connector-012", primary: "429", metrics_path: "healthy", network: "healthy" }], signals: [{ component: "log-connector-rate-limit", confidence: 0.97, evidence_ref: "probe:connector-012" }], evidence_refs: ["probe:connector-012"] } },
    },
  }),
};

export const CASES = { ...SMOKE_CASES, ...PILOT_CASES };
export const DATASET_HASH = sha256(SMOKE_CASES);
export const PILOT_DATASET_HASH = sha256(PILOT_CASES);

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
