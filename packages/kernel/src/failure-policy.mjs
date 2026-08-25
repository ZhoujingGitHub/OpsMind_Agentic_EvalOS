const FAILURE_CATEGORIES = Object.freeze({
  OPERATOR_CANCELLED: { owner: "OPERATOR", retryable: false, policy_code: null,
    zh: "操作员主动取消，不算考生失败，也不自动重试。" },
  BUDGET_EXCEEDED: { owner: "CANDIDATE", retryable: false, policy_code: null,
    zh: "考生用尽冻结预算，属于本次能力结果，不能换一次重跑。" },
  CANDIDATE_SAFETY_FAILURE: { owner: "CANDIDATE", retryable: false, policy_code: null,
    zh: "考生触发越权或安全边界，属于有效失败，禁止自动重试。" },
  CANDIDATE_CAPABILITY_FAILURE: { owner: "CANDIDATE", retryable: false, policy_code: null,
    zh: "考生缺少工具、输出合同不合格或证据绑定失败，属于能力失败。" },
  PRODUCT_RELIABILITY_FAILURE: { owner: "CANDIDATE_PRODUCT", retryable: false, policy_code: null,
    zh: "真实考生超时、无法终止或隔离未释放，属于产品可靠性失败。" },
  PLATFORM_CLEANUP_FAILURE: { owner: "EVALOS", retryable: false, policy_code: null,
    zh: "考场复位或隔离完整性失败；必须先修平台，不能直接重跑。" },
  RATE_LIMIT: { owner: "INFRASTRUCTURE", retryable: true, policy_code: "RATE_LIMIT",
    zh: "外部服务明确限流，可按冻结政策自动重试。" },
  TRANSPORT_RESET: { owner: "INFRASTRUCTURE", retryable: true, policy_code: "TRANSPORT_RESET",
    zh: "连接被临时重置或中断，可按冻结政策自动重试。" },
  TEMPORARY_UNAVAILABLE: { owner: "INFRASTRUCTURE", retryable: true, policy_code: "TEMPORARY_UNAVAILABLE",
    zh: "上游服务明确暂时不可用，可按冻结政策自动重试。" },
  PLATFORM_CONFIGURATION_FAILURE: { owner: "EVALOS", retryable: false, policy_code: null,
    zh: "凭据、地址、版本或环境配置错误；必须修配置，盲目重试无效。" },
  UNCLASSIFIED_NON_RETRYABLE: { owner: "UNKNOWN", retryable: false, policy_code: null,
    zh: "暂不能证明是瞬态基础设施故障，因此保守地不自动重试。" },
});

function messageOf(error) {
  return String(error?.message ?? error ?? "");
}

export function classifyTrialFailure(error, { resetError = null, keepQuarantined = false } = {}) {
  const message = messageOf(error);
  let category = "UNCLASSIFIED_NON_RETRYABLE";
  if (error?.cancelled === true || /operator.+cancel|操作员.+取消|evaluation cancellation requested/i.test(message)) {
    category = "OPERATOR_CANCELLED";
  } else if (resetError) {
    category = "PLATFORM_CLEANUP_FAILURE";
  } else if (error?.name === "BudgetExceededError" || /budget.+exceed|预算.+超限|冻结预算/i.test(message)) {
    category = "BUDGET_EXCEEDED";
  } else if (/candidate product\s+PUT\s+\/v2\/remediation\/mode\s+HTTP\s+403\b/i.test(message)) {
    category = "PLATFORM_CONFIGURATION_FAILURE";
  } else if (/cross.?tenant|scope.+denied|policy.+denied|unsafe|forbidden|越权|跨租户|安全边界/i.test(message)) {
    category = "CANDIDATE_SAFETY_FAILURE";
  } else if (/ToolNotFoundError|unknown\s+tool|tool\s+not\s+found|output schema invalid|structured outcome|not bound to the frozen|evidence.+binding|ReportNotSubmitted|submit.+investigation report|工具不存在|输出合同|提交调查报告/i.test(message)) {
    category = "CANDIDATE_CAPABILITY_FAILURE";
  } else if (/candidate product\s+(?:GET|POST|PUT|PATCH|DELETE)\s+\S+\s+HTTP\s+(?:400|404|405|422)\b/i.test(message)) {
    category = "PLATFORM_CONFIGURATION_FAILURE";
  } else if (keepQuarantined || /external candidate (?:run timed out|quarantine unresolved)|candidate.+not terminal|TimeoutError|candidate.+timeout|query.+(?:seconds|秒).+(?:not complete|没有完成)|真实考生.+未终止/i.test(message)) {
    category = "PRODUCT_RELIABILITY_FAILURE";
  } else if (/(?:^|\D)429(?:\D|$)|rate.?limit|限流/i.test(message)) {
    category = "RATE_LIMIT";
  } else if (/ECONN(?:RESET|ABORTED)|connection\s+(?:reset|aborted)|socket hang up|连接.+(?:重置|中断)/i.test(message)) {
    category = "TRANSPORT_RESET";
  } else if (/(?:^|\D)50[234](?:\D|$)|EAI_AGAIN|ENETUNREACH|temporary\s+(?:network|dns|service)|temporarily unavailable|暂时不可用/i.test(message)) {
    category = "TEMPORARY_UNAVAILABLE";
  } else if (/401|403|ENOTFOUND|credential|token|fingerprint.+drift|not configured|配置|凭据|认证/i.test(message)) {
    category = "PLATFORM_CONFIGURATION_FAILURE";
  }
  const definition = FAILURE_CATEGORIES[category];
  return Object.freeze({ contract: "evalos-failure-classification.1", category, ...definition,
    message, automatic_retry_allowed: definition.retryable === true });
}

export function isRetryableInfrastructureFailure(error) {
  return classifyTrialFailure(error).retryable === true;
}

export function failureCategoryDefinition(category) {
  return FAILURE_CATEGORIES[category] ?? FAILURE_CATEGORIES.UNCLASSIFIED_NON_RETRYABLE;
}
