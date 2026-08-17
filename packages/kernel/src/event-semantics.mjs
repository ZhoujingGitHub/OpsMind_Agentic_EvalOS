const EVENT_DEFINITIONS = Object.freeze({
  "trial.execute": ["执行一次评测", "Execute trial", "评测执行"],
  "agent.invoke": ["启动参评 Agent", "Invoke contestant agent", "Agent 决策"],
  "agent.sdk.message": ["记录 Claude Agent SDK 消息", "Record Claude Agent SDK message", "Agent 运行"],
  "agent.langgraph.result": ["记录外部对照 Agent 的运行结果", "Record external baseline agent result", "Agent 运行"],
  "native_tool.policy.allowed": ["安全策略允许原生工具调用", "Native tool call allowed by policy", "安全控制"],
  "native_tool.policy.denied": ["安全策略拒绝原生工具调用", "Native tool call denied by policy", "安全控制"],
  "native_tool.completed": ["原生工具执行完成", "Native tool execution completed", "工具调用"],
  "native_tool.failed": ["原生工具执行失败", "Native tool execution failed", "工具调用"],
  "tool.call": ["外部适配器发起工具调用", "External adapter called a tool", "工具调用"],
  "tool.result": ["外部适配器收到工具结果", "External adapter received a tool result", "工具调用"],
  "runner.heartbeat": ["续约运行租约", "Runner heartbeat", "运行保障"],
  "environment.prepared": ["准备并隔离考试环境", "Prepare and isolate evaluation environment", "环境准备"],
  "environment.snapshot": ["采集环境快照", "Capture environment snapshot", "环境观察"],
  "environment.reset": ["复位考试环境", "Reset evaluation environment", "环境复位"],
  "model.decision": ["记录 Agent 的外显决策", "Record model decision", "Agent 决策"],
  "grader.code": ["执行确定性评分", "Run deterministic code grader", "正式评分"],
  "budget.check": ["检查资源预算", "Check resource budget", "预算控制"],
  "budget.warning": ["资源预算接近上限", "Resource budget nearing limit", "预算控制"],
  "budget.exhausted": ["资源预算已用尽", "Resource budget exhausted", "预算控制"],
});

const TOOL_DEFINITIONS = Object.freeze({
  get_alerts: "读取当前告警",
  query_metrics: "查询监控指标",
  query_logs: "查询机器日志",
  query_core_logs: "查询核心网机器日志",
  query_sessions: "查询会话状态",
  query_processes: "查询网元进程状态",
  query_subscriber: "查询用户签约数据",
  get_network_health: "检查网络整体健康度",
  probe_user_plane: "探测用户面连通性",
  capture_protocol_summary: "采集协议交互摘要",
  manage_subscriber_profile: "受控修改用户签约配置",
  manage_capture_policy: "受控修改抓包策略",
  run_probe: "执行诊断探针",
  inspect_state: "检查环境状态",
  apply_change: "执行受控变更",
  verify_recovery: "验证故障恢复",
});

const KIND_DEFINITIONS = Object.freeze({
  AGENT: ["Agent 决策", "Agent"], TOOL: ["工具调用", "Tool"], CHAIN: ["评测执行", "Harness"],
  INTERNAL: ["系统内部", "Internal"], ENVIRONMENT: ["环境交互", "Environment"], EVALUATOR: ["正式评分", "Grader"],
});

const ACTOR_DEFINITIONS = Object.freeze({
  contestant: ["参评 Agent", "Contestant"], runner: ["评测执行器", "Runner"], harness: ["评测执行层", "Harness"],
  kernel: ["评测内核", "Kernel"], environment: ["考试环境", "Environment"], grader: ["确定性评分器", "Code Grader"],
  "code-grader": ["确定性评分器", "Code Grader"], "langgraph-v1": ["外部对照 Agent", "External baseline agent"],
  model: ["大模型", "Model"], system: ["系统", "System"],
});

const RECORD_DEFINITIONS = Object.freeze({
  SPAN_START: ["开始", "Span start"], SPAN_EVENT: ["过程事件", "Span event"], SPAN_END: ["结束", "Span end"],
});

const STATUS_DEFINITIONS = Object.freeze({
  OK: ["成功", "OK"], COMPLETED: ["已完成", "Completed"], FAILED: ["失败", "Failed"],
  ERROR: ["异常", "Error"], CANCELLED: ["已取消", "Cancelled"],
});

function lookupActor(actor) {
  const normalized = String(actor ?? "system").toLowerCase();
  return ACTOR_DEFINITIONS[normalized] ?? ["记录主体", String(actor ?? "Unknown actor")];
}

function eventTitle(name, spanKind) {
  const raw = String(name ?? "unknown.event");
  if (EVENT_DEFINITIONS[raw]) return EVENT_DEFINITIONS[raw];
  if (raw.startsWith("tool.")) {
    const tool = raw.slice(5);
    return [`调用工具：${TOOL_DEFINITIONS[tool] ?? tool}`, `Call tool: ${tool}`, "工具调用"];
  }
  const category = KIND_DEFINITIONS[String(spanKind ?? "INTERNAL").toUpperCase()]?.[0] ?? "未识别事件";
  return [`${category}：${raw}`, raw, category];
}

export function explainTraceRecord(record) {
  const kindCode = String(record?.span_kind ?? "INTERNAL").toUpperCase();
  const kind = KIND_DEFINITIONS[kindCode] ?? ["未识别类型", kindCode];
  const actor = lookupActor(record?.actor);
  const lifecycleCode = String(record?.record_type ?? "SPAN_EVENT").toUpperCase();
  const lifecycle = RECORD_DEFINITIONS[lifecycleCode] ?? ["事件", lifecycleCode];
  const statusCode = String(record?.status ?? (lifecycleCode === "SPAN_END" ? "COMPLETED" : "RECORDED")).toUpperCase();
  const status = STATUS_DEFINITIONS[statusCode] ?? [statusCode === "RECORDED" ? "已记录" : "状态未知", statusCode];
  const [titleZh, titleEn, categoryZh] = eventTitle(record?.name, kindCode);
  return {
    contract: "evalos-event-semantics.1",
    category: { zh: categoryZh, en: kind[1], code: kindCode },
    title: { zh: titleZh, en: titleEn, code: String(record?.name ?? "unknown.event") },
    actor: { zh: actor[0], en: actor[1], code: String(record?.actor ?? "unknown") },
    lifecycle: { zh: lifecycle[0], en: lifecycle[1], code: lifecycleCode },
    status: { zh: status[0], en: status[1], code: statusCode },
    summary_zh: `${actor[0]}${lifecycle[0]}：${titleZh}`,
  };
}

export const TRACE_FILTERS = Object.freeze([
  { code: "ALL", zh: "全部记录", en: "All" },
  ...Object.entries(KIND_DEFINITIONS).map(([code, [zh, en]]) => ({ code, zh, en })),
]);
