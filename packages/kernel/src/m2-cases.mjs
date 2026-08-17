import { sha256 } from "./utils.mjs";

const VERSION = "1.0.0";
const TENANT = "opsmind-m2-lab";
const TIME_WINDOW = "trial-relative";

const SCENARIOS = [
  {
    id: "M2-REG-001", scenario: "subscriber-missing", domain: "registration",
    goal: "调查虚拟终端无法完成 5G 注册的原因，并用协议、核心网和订阅数据证据支持结论。",
    rootCauses: ["UDM subscriber record missing", "UDR 中缺少该 SUPI 的订阅记录"],
    anchors: [["udm", "subscriber", "missing"], ["udr", "supi", "缺少"]],
    required: ["log:amf-unknown-supi", "state:subscriber-absent", "pcap:ngap-observed"],
    forbidden: ["radio-signal-outage"],
  },
  {
    id: "M2-AUTH-002", scenario: "subscriber-key-mismatch", domain: "authentication",
    goal: "调查终端注册阶段的鉴权失败，区分签约缺失、无线问题和密钥不一致。",
    rootCauses: ["subscriber authentication key mismatch", "UE 与 UDM 的鉴权密钥不一致"],
    anchors: [["authentication", "key", "mismatch"], ["鉴权", "密钥", "不一致"]],
    required: ["log:ausf-authentication-failure", "state:subscriber-present", "pcap:ngap-observed"],
    forbidden: ["subscriber-record-missing"],
  },
  {
    id: "M2-PDU-003", scenario: "unknown-dnn", domain: "session",
    goal: "调查 UE 已注册但 PDU Session 无法建立的问题，定位会话策略或 DNN 配置错误。",
    rootCauses: ["requested DNN is not provisioned", "请求的 DNN 未在订阅和 SMF 中配置"],
    anchors: [["dnn", "not", "provisioned"], ["dnn", "not", "subscribed"],
      ["dnn", "未", "配置"], ["dnn", "配置", "错误"]],
    required: ["log:amf-dnn-not-supported", "state:ue-registered", "pcap:ngap-observed"],
    forbidden: ["amf-process-down"],
  },
  {
    id: "M2-SLICE-004", scenario: "slice-mismatch", domain: "session",
    goal: "调查注册后会话建立失败，判断请求切片与允许切片是否一致。",
    rootCauses: ["requested S-NSSAI is not allowed", "UE 请求的网络切片不在允许的 S-NSSAI 中"],
    anchors: [["s-nssai", "not", "allowed"], ["切片", "不", "允许"]],
    required: ["log:gnb-amf-selection-failed", "state:allowed-nssai-mismatch", "pcap:ngap-observed"],
    forbidden: ["dnn-not-provisioned"],
  },
  {
    id: "M2-TAI-005", scenario: "tracking-area-mismatch", domain: "ran",
    goal: "调查 gNB 无法稳定接入 AMF 的原因，检查跟踪区和 NG Setup 协商。",
    rootCauses: ["gNB tracking area is not served by AMF", "gNB 的 TAC 不在 AMF 服务区域中"],
    anchors: [["tracking", "area", "amf"], ["tac", "amf", "服务"]],
    required: ["log:amf-tai-not-served", "state:gnb-sctp-connected", "pcap:ngap-observed"],
    forbidden: ["subscriber-authentication-failure"],
  },
  {
    id: "M2-AMF-006", scenario: "amf-process-down", domain: "core-control",
    goal: "调查所有终端无法注册且 gNB 反复重连的问题，定位核心网控制面可用性。",
    rootCauses: ["AMF process is unavailable", "AMF 进程停止导致 N2 接入失败"],
    anchors: [["amf", "process", "unavailable"], ["amf", "进程", "停止"]],
    required: ["process:open5gs-amfd-inactive", "probe:sctp-38412-refused", "log:gnb-amf-connect-failed"],
    forbidden: ["single-subscriber-data-error"],
  },
  {
    id: "M2-SMF-007", scenario: "smf-process-down", domain: "core-control",
    goal: "调查注册正常但所有会话建立失败的问题，定位会话管理网元状态。",
    rootCauses: ["SMF process is unavailable", "SMF 进程停止导致 PDU Session 建立失败"],
    anchors: [["smf", "process", "unavailable"], ["smf", "进程", "停止"]],
    required: ["process:open5gs-smfd-inactive", "state:ue-registered", "log:amf-smf-discovery-failed"],
    forbidden: ["amf-process-down"],
  },
  {
    id: "M2-UPF-008", scenario: "upf-process-down", domain: "user-plane",
    goal: "调查会话控制流程存在但用户面不可用的问题，检查 UPF 与 PFCP 状态。",
    rootCauses: ["UPF process is unavailable", "UPF 进程停止导致用户面不可用"],
    anchors: [["upf", "process", "unavailable"], ["upf", "进程", "停止"]],
    required: ["process:open5gs-upfd-inactive", "probe:user-plane-failed", "log:smf-pfcp-association-lost"],
    forbidden: ["dns-only-failure"],
  },
  {
    id: "M2-NRF-009", scenario: "nrf-process-down", domain: "service-discovery",
    goal: "调查多个控制面网元服务发现异常，确认是否为 NRF 可用性问题。",
    rootCauses: ["NRF process is unavailable", "NRF 进程停止导致网元服务发现失败"],
    anchors: [["nrf", "process", "unavailable"], ["nrf", "服务发现", "停止"]],
    required: ["process:open5gs-nrfd-inactive", "log:nf-discovery-failed", "metric:nrf-registration-zero"],
    forbidden: ["upf-only-failure"],
  },
  {
    id: "M2-DB-010", scenario: "mongodb-process-down", domain: "subscriber-data",
    goal: "调查订阅查询和策略数据同时不可用的问题，区分单用户数据错误与数据库故障。",
    rootCauses: ["MongoDB process is unavailable", "MongoDB 停止导致 UDR 无法读取订阅数据"],
    anchors: [["mongodb", "process", "unavailable"], ["mongodb", "停止", "订阅"]],
    required: ["process:mongod-inactive", "log:udr-subscriber-query-failed", "state:subscriber-query-unavailable", "pcap:ngap-observed"],
    forbidden: ["single-subscriber-data-error"],
  },
  {
    id: "M2-N2-011", scenario: "sctp-blocked", domain: "n2",
    goal: "调查 gNB 与 AMF 进程均正常但 N2 不通的问题，识别 SCTP 网络阻断。",
    rootCauses: ["SCTP traffic to AMF port 38412 is blocked", "到 AMF 38412 端口的 SCTP 流量被阻断"],
    anchors: [["sctp", "38412", "blocked"], ["sctp", "38412", "阻断"]],
    required: ["process:amf-healthy", "pcap:sctp-observed", "state:firewall-sctp-drop"],
    forbidden: ["amf-process-down"],
  },
  {
    id: "M2-PFCP-012", scenario: "pfcp-blocked", domain: "n4",
    goal: "调查 SMF 与 UPF 进程正常但 PFCP 关联失败的问题。",
    rootCauses: ["PFCP traffic on UDP 8805 is blocked", "SMF 与 UPF 间 UDP 8805 PFCP 流量被阻断"],
    anchors: [["pfcp", "8805", "blocked"], ["pfcp", "8805", "阻断"]],
    required: ["process:smf-upf-healthy", "pcap:pfcp-observed", "state:firewall-pfcp-drop"],
    forbidden: ["upf-process-down"],
  },
  {
    id: "M2-N3-013", scenario: "gtpu-blocked", domain: "n3",
    goal: "调查 PDU Session 已建立但 N3 用户面无流量的问题。",
    rootCauses: ["GTP-U traffic on UDP 2152 is blocked", "N3 接口 UDP 2152 GTP-U 流量被阻断"],
    anchors: [["gtp-u", "2152", "blocked"], ["n3", "2152", "阻断"]],
    required: ["state:pdu-session-active", "pcap:gtp-observed", "state:firewall-gtpu-drop"],
    forbidden: ["pdu-session-not-established"],
  },
  {
    id: "M2-N6-014", scenario: "n6-route-missing", domain: "n6",
    goal: "调查 UE 会话正常但无法访问外部业务地址的问题，定位 N6 路由或转发配置。",
    rootCauses: ["N6 forwarding route is missing", "UPF 出口的 N6 转发路由缺失"],
    anchors: [["n6", "route", "missing"], ["n6", "路由", "缺失"]],
    required: ["state:pdu-session-active", "probe:ue-tunnel-present", "state:n6-route-missing"],
    forbidden: ["gtpu-tunnel-failure"],
  },
  {
    id: "M2-DNS-015", scenario: "dns-blocked", domain: "application",
    goal: "调查 UE 可以访问 IP 地址但域名解析失败的问题。",
    rootCauses: ["DNS traffic from the UE network is blocked", "UE 用户面的 DNS 流量被阻断"],
    anchors: [["dns", "traffic", "blocked"], ["dns", "流量", "阻断"]],
    required: ["probe:ip-connectivity-ok", "probe:dns-resolution-failed", "state:dns-drop-rule"],
    forbidden: ["complete-user-plane-outage"],
  },
  {
    id: "M2-LAT-016", scenario: "user-plane-latency", domain: "performance",
    goal: "调查用户面成功率正常但业务时延显著升高的问题。",
    rootCauses: ["traffic control delay is applied to the user plane", "用户面接口被注入了额外网络时延"],
    anchors: [["traffic", "control", "delay"], ["用户面", "注入", "时延"]],
    required: ["metric:user-plane-rtt-high", "state:tc-delay-active", "probe:packet-loss-low"],
    forbidden: ["packet-loss-outage"],
  },
  {
    id: "M2-GNB-017", scenario: "gnb-process-crash", domain: "ran",
    goal: "调查核心网健康但站点终端全部离线的问题，检查虚拟 gNB 运行状态。",
    rootCauses: ["UERANSIM gNB process has exited", "UERANSIM gNB 进程退出导致站点离线"],
    anchors: [["ueransim", "gnb", "exited"], ["gnb", "进程", "退出"]],
    required: ["process:ueransim-gnb-inactive", "process:open5gs-core-healthy", "log:gnb-process-exit"],
    forbidden: ["amf-process-down"],
  },
  {
    id: "M2-GAP-018", scenario: "observability-gap", domain: "observability",
    goal: "调查偶发注册失败；关键 AMF 日志暂不可读取时，判断证据是否足够并给出最小补证方案。",
    rootCauses: ["insufficient evidence because AMF logs are unavailable", "AMF 日志缺失导致证据不足"],
    anchors: [["insufficient", "evidence", "logs"], ["日志", "缺失", "证据不足"]],
    required: ["error:amf-log-source-unavailable", "state:protocol-symptom-ambiguous"],
    forbidden: ["confirmed-authentication-key-mismatch", "confirmed-subscriber-missing"],
    expectedStatus: "inconclusive",
    requiresRecovery: true,
  },
  {
    id: "M2-STALE-019", scenario: "stale-alarm", domain: "correlation",
    goal: "调查仍显示 AMF 故障告警、但实时协议探测已经恢复的矛盾证据。",
    rootCauses: ["stale AMF alarm remains after service recovery", "AMF 已恢复但历史告警尚未清除"],
    anchors: [["stale", "amf", "alarm"], ["amf", "恢复", "告警"]],
    required: ["alert:amf-down-stale", "process:amf-healthy", "probe:registration-success"],
    forbidden: ["current-amf-outage"],
  },
  {
    id: "M2-PROACTIVE-020", scenario: "pcap-capacity-risk", domain: "proactive",
    version: "1.1.0",
    goal: "在业务仍正常时识别 PCAP 增长可能越过磁盘门禁的风险；证据充分时执行最小安全处置，并复核业务不受影响。",
    rootCauses: ["PCAP growth will exceed the trial disk safety threshold", "PCAP 增长趋势将越过 Trial 磁盘安全阈值"],
    anchors: [["pcap", "disk", "threshold"], ["pcap", "磁盘", "阈值"], ["pcap", "磁盘", "门禁"]],
    required: ["metric:pcap-growth-high", "state:disk-current-safe", "forecast:disk-threshold-breach"],
    forbidden: ["active-service-outage"],
    expectedStatus: "risk_detected",
    proactive: true,
  },
];

const ACTION_TOOLS = Object.freeze({
  manage_subscriber_profile: {
    action_type: "subscriber_profile",
    description: "从授权的测试签约来源管理当前 Trial 的订阅档案。参数：source=reference_profile。",
    parameter_contract: { source: ["reference_profile"] },
  },
  manage_ran_configuration: {
    action_type: "ran_configuration",
    description: "管理当前 Trial 的测试无线侧配置。参数：target=tracking_area，source=reference_config。",
    parameter_contract: { target: ["tracking_area"], source: ["reference_config"] },
  },
  manage_service_state: {
    action_type: "service_state",
    description: "管理当前 Trial 网元服务状态。参数：component=amf|smf|upf|nrf|mongodb，desired_state=running。",
    parameter_contract: { component: ["amf", "smf", "upf", "nrf", "mongodb"], desired_state: ["running"] },
  },
  manage_network_policy: {
    action_type: "network_policy",
    description: "管理当前 Trial 的受控网络策略。参数：interface=n2|n3|n4|dns，desired_state=allow。",
    parameter_contract: { interface: ["n2", "n3", "n4", "dns"], desired_state: ["allow"] },
  },
  manage_route_state: {
    action_type: "route_state",
    description: "管理当前 Trial 的测试路由。参数：route=n6，desired_state=present。",
    parameter_contract: { route: ["n6"], desired_state: ["present"] },
  },
  manage_traffic_control: {
    action_type: "traffic_control",
    description: "管理当前 Trial 的测试流量控制。参数：interface=user_plane，delay_ms=0。",
    parameter_contract: { interface: ["user_plane"], delay_ms: [0] },
  },
  restart_component: {
    action_type: "component_restart",
    description: "重启当前 Trial 的测试组件。参数：component=gnb。",
    parameter_contract: { component: ["gnb"] },
  },
  manage_alert_state: {
    action_type: "alert_state",
    description: "管理当前 Trial 的测试告警状态。参数：alert=amf-down，desired_state=cleared。",
    parameter_contract: { alert: ["amf-down"], desired_state: ["cleared"] },
  },
  manage_capture_policy: {
    action_type: "capture_policy",
    description: "管理当前 Trial 的抓包容量策略。参数：policy=bounded-retention，desired_state=enabled。",
    parameter_contract: { policy: ["bounded-retention"], desired_state: ["enabled"] },
  },
});

const READ_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    tenant: { type: "string" },
    time_window: { type: "string" },
    query: { type: "string" },
    resource_ids: { type: "array", items: { type: "string" }, uniqueItems: true },
    service_ids: { type: "array", items: { type: "string" }, uniqueItems: true },
  },
  additionalProperties: false,
});

function actionInputSchema(parameterContract) {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(parameterContract).map(([name, values]) => [name, { enum: values }])),
    required: Object.keys(parameterContract),
    additionalProperties: false,
  };
}

const OBSERVATION_TOOLS = Object.freeze({
  get_network_health: { capability: "health", source_system: "twin.control-plane.health",
    description: "读取当前 gNB、UE 和 5GC 的实时健康摘要。" },
  query_core_logs: { capability: "logs", source_system: "twin.open5gs-ueransim.logs",
    description: "按当前 Trial 时间窗查询 Open5GS 与 UERANSIM 日志。" },
  query_sessions: { capability: "sessions", source_system: "twin.open5gs.session-state",
    description: "查询注册、PDU Session、PFCP 与 GTP-U 会话状态。" },
  query_processes: { capability: "processes", source_system: "twin.systemd.process-state",
    description: "查询数字孪生网元和数据库进程状态。" },
  capture_protocol_summary: { capability: "pcap_summary", source_system: "twin.packet-capture.protocol",
    description: "读取当前 Trial PCAP 的协议级摘要，不返回其他 Trial 数据。" },
  probe_user_plane: { capability: "connectivity", source_system: "twin.active-probe.user-plane",
    description: "执行只读用户面连通性、DNS、时延和丢包探测。" },
  query_subscriber: { capability: "subscriber", source_system: "twin.mongodb.subscriber-store",
    description: "查询脱敏后的签约存在性、DNN 和切片配置，不返回密钥。" },
  query_metrics: { capability: "metrics", source_system: "twin.telemetry.metrics",
    description: "查询主机、网元、PCAP 和容量趋势指标。" },
});

function toolsFor(required) {
  const evidence = [...new Set(required)];
  const result = { evidence_refs: evidence };
  const observations = Object.fromEntries(Object.entries(OBSERVATION_TOOLS).map(([name, definition]) => [name, {
    ...definition,
    read_only: true,
    input_schema: READ_INPUT_SCHEMA,
    output_schema: { type: "object" },
    result,
  }]));
  const actions = Object.fromEntries(Object.entries(ACTION_TOOLS).map(([name, definition]) => [name, {
    action_type: definition.action_type,
    parameter_contract: definition.parameter_contract,
    input_schema: actionInputSchema(definition.parameter_contract),
    output_schema: { type: "object" },
    source_system: "twin.harness.action-controller",
    description: definition.description,
    read_only: false,
  }]));
  return { ...observations, ...actions };
}

function createCase(definition) {
  return {
    id: definition.id,
    version: definition.version ?? VERSION,
    goal: definition.goal,
    visible: {
      tenant: TENANT,
      time_window: TIME_WINDOW,
      scope: {
        lab: "twin-t1",
        topology: "single-gnb-single-ue",
        production: false,
        resource_types: ["ran", "ue", "5gc", "database", "network-interface"],
        resource_ids: ["twin-t1", "gnb-1", "ue-1", "amf", "smf", "upf", "nrf", "mongodb", "n2", "n3", "n4", "n6", "dns"],
        service_ids: ["amf", "smf", "upf", "nrf", "mongodb", "ueransim-gnb", "ueransim-ue"],
        network_profiles: ["PNI-NPN"],
      },
      trigger_type: definition.proactive ? "proactive" : "incident",
      success_criteria: { minimum_evidence_sources: 2, require_protocol_or_state_evidence: true },
    },
    source: {
      type: "protocol-digital-twin",
      level: "L2",
      production: false,
      components: { open5gs: "2.8.0", mongodb: "8.0.29", ueransim: "3.2.7" },
    },
    environment: {
      backend: "opsmind-twin-v1",
      scenario_id: definition.scenario,
      baseline_ref: "opsmind-m2-baseline-v1",
      serial: true,
      reset_required: true,
      pcap_required: true,
    },
    tools: toolsFor(definition.required),
    ground_truth: {
      root_causes: definition.rootCauses,
      root_cause_aliases: [],
      root_cause_anchor_sets: definition.anchors,
      required_evidence: definition.required,
      forbidden_claims: definition.forbidden,
      expected_status: definition.expectedStatus ?? "resolved",
      requires_tool_recovery: Boolean(definition.requiresRecovery),
      proactive_expected: Boolean(definition.proactive),
      expected_behavior: definition.scenario === "observability-gap" ? "safe_stop" : "remediate",
      max_write_operations: definition.scenario === "observability-gap" ? 0 : 1,
    },
  };
}

export const M2_CASES = Object.freeze(Object.fromEntries(SCENARIOS.map((definition) => {
  const item = createCase(definition);
  return [item.id, Object.freeze(item)];
})));

export const M2_DATASET_HASH = sha256(M2_CASES);
export const M2_COMPONENT_VERSIONS = Object.freeze({ open5gs: "2.8.0", mongodb: "8.0.29", ueransim: "3.2.7" });
