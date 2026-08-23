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
  "candidate.poll.heartbeat": ["确认真实考生仍在线", "Candidate liveness heartbeat", "运行保障"],
  "candidate.progress.checkpoint": ["记录15分钟调查进展检查点", "Record 15-minute progress checkpoint", "运行保障"],
  "candidate.discovery.verified": ["核验真实考生身份、版本与能力合同", "Verify candidate identity, version and capability contract", "开考检查"],
  "candidate.evaluation_context.prepared": ["向真实考生下发冻结评测上下文", "Prepare frozen evaluation context", "开考准备"],
  "candidate.run.submitted": ["已将题目提交给真实考生", "Submit task to real candidate", "开考准备"],
  "candidate.run.quarantine_started": ["真实考生停止较慢，考场已进入保护隔离", "Quarantine environment while candidate stops", "安全控制"],
  "environment.prepared": ["准备并隔离考试环境", "Prepare and isolate evaluation environment", "环境准备"],
  "environment.independent_capture": ["独立采集数字孪生现场证据", "Independently capture Twin evidence", "环境观察"],
  "environment.snapshot": ["采集环境快照", "Capture environment snapshot", "环境观察"],
  "environment.reset": ["复位考试环境", "Reset evaluation environment", "环境复位"],
  "model.decision": ["记录 Agent 的外显决策", "Record model decision", "Agent 决策"],
  "grader.code": ["执行确定性评分", "Run deterministic code grader", "确定性评分"],
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
  INTERNAL: ["系统内部", "Internal"], ENVIRONMENT: ["环境交互", "Environment"], EVALUATOR: ["确定性评分", "Grader"],
});

const ACTOR_DEFINITIONS = Object.freeze({
  contestant: ["参评 Agent", "Contestant"], runner: ["评测执行器", "Runner"], harness: ["评测执行层", "Harness"],
  kernel: ["评测内核", "Kernel"], environment: ["考试环境", "Environment"], grader: ["确定性评分器", "Code Grader"],
  "code-grader": ["确定性评分器", "Code Grader"], "langgraph-v1": ["外部对照 Agent", "External baseline agent"],
  model: ["大模型", "Model"], system: ["系统", "System"],
  "candidate-adapter": ["真实考生适配器", "Candidate adapter"],
  "external-candidate": ["真实参评产品", "Real candidate product"],
  "agent-harness-product": ["Agent+Harness OpsMind", "Agent+Harness OpsMind"],
  "twin-manager": ["数字孪生考务控制器", "Twin manager"],
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

function compact(value, maximum = 180) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function publicCandidateSummary(record) {
  if (record?.name !== "candidate.raw_event") return null;
  const envelope = record?.payload?.payload;
  const eventType = String(envelope?.event_type ?? "");
  const detail = envelope?.payload ?? {};
  if (!eventType) return null;

  // Only translate fields the candidate deliberately published to its audit API.
  // Never infer or expose hidden model chain-of-thought.
  if (eventType === "agent.progress") {
    const title = compact(detail.title) ?? "发布新的调查进展";
    const action = compact(detail.action_summary ?? detail.observation_summary);
    const next = compact(detail.next_step);
    return `Agent进展：${title}${action ? `；${action}` : ""}${next ? `；下一步：${next}` : ""}`;
  }
  if (eventType === "tool.called") {
    const rawName = String(detail.name ?? "未知工具");
    const name = rawName.replace(/^mcp__[^_]+__/, "");
    return `正在调用工具：${TOOL_DEFINITIONS[name] ?? name}`;
  }
  if (eventType === "tool.result") {
    return detail.is_error ? "工具返回错误，Agent仍需判断是否换路调查" : "已收到工具结果，Agent正在结合其他证据判断";
  }
  if (eventType === "agent.message") {
    const message = compact(detail.text);
    return message ? `Agent公开说明：${message}` : "Agent发布了一条公开调查说明";
  }
  const publicMilestones = {
    "task.received": "真实考生已收到评测题目",
    "investigation.started": "真实考生已开始调查",
    "evidence.collected": "真实考生已采集一项新证据",
    "conclusion.recorded": "真实考生已形成公开结论",
    "action.proposed": "真实考生已提出受控操作建议",
    "policy.decided": "后端安全策略已完成判断",
    "approval.decided": "独立审批裁判已完成判断",
    "ticket.issued": "已签发一次性受控操作票据",
    "lease.acquired": "已取得本次受控操作的短期执行权",
    "action.executed": "受控操作已经执行",
    "verification.completed": "独立验证已经完成",
    "rollback.executed": "失败操作已经回滚",
    "rollback.verified": "回滚结果已经独立核验",
    "circuit_breaker.opened": "安全熔断已经触发",
    "emergency_stop.activated": "紧急停止已经触发",
    "human_takeover.requested": "系统已请求人工接管",
    "archive.reconciled": "证据归档已经核对完成",
  };
  if (publicMilestones[eventType]) return publicMilestones[eventType];
  const summary = compact(detail.summary ?? detail.action_summary ?? detail.observation_summary);
  if (summary) return `${eventType}：${summary}`;
  return `真实考生公开事件：${eventType}`;
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
  const publicSummary = publicCandidateSummary(record);
  return {
    contract: "evalos-event-semantics.1",
    category: { zh: categoryZh, en: kind[1], code: kindCode },
    title: { zh: titleZh, en: titleEn, code: String(record?.name ?? "unknown.event") },
    actor: { zh: actor[0], en: actor[1], code: String(record?.actor ?? "unknown") },
    lifecycle: { zh: lifecycle[0], en: lifecycle[1], code: lifecycleCode },
    status: { zh: status[0], en: status[1], code: statusCode },
    summary_zh: publicSummary ?? `${actor[0]}${lifecycle[0]}：${titleZh}`,
  };
}

export const TRACE_FILTERS = Object.freeze([
  { code: "ALL", zh: "全部记录", en: "All" },
  ...Object.entries(KIND_DEFINITIONS).map(([code, [zh, en]]) => ({ code, zh, en })),
]);
