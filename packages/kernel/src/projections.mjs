const IDENTITY_KEYS = new Set([
  "adapter_version",
  "architecture",
  "contestant_id",
  "contestant_ref",
  "graph_framework",
  "model",
  "provider",
  "runtime",
  "sdk",
  "source_product",
  "code_score",
  "grader_ref",
  "judge_ref",
  "label_hash",
  "total",
  "passed",
]);

const IDENTITY_VALUE = /(?:@anthropic-ai\/claude-agent-sdk|claude-agent-sdk|deepseek-v4-flash|agent-harness(?:-v2)?|langgraph(?:-v1)?|explicit-engineering-test-double|test-double-[a-z0-9_-]+)/gi;

function stripIdentity(value) {
  if (Array.isArray(value)) return value.map(stripIdentity);
  if (typeof value === "string") return value.replace(IDENTITY_VALUE, "[BLINDED_RUNTIME]");
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !IDENTITY_KEYS.has(key.toLowerCase()))
    .map(([key, child]) => [key, stripIdentity(child)]));
}

export function blindManifestView(manifest = {}) {
  const { contestants: _contestants, model: _model, ...safe } = manifest;
  return stripIdentity(safe);
}

export function blindExperimentView(experiment) {
  if (!experiment) return null;
  const { manifest_json: _manifestJson, manifest, ...safe } = experiment;
  return { ...safe, manifest: blindManifestView(manifest) };
}

export function blindTrialView(trial) {
  if (!trial) return null;
  const {
    contestant_ref: _contestantRef,
    budget_json: _budgetJson,
    lease_owner: _leaseOwner,
    lease_expires_at: _leaseExpiry,
    namespace: _namespace,
    ...safe
  } = trial;
  return stripIdentity(safe);
}

export function blindTraceView(records = []) {
  return records.map((record) => {
    const { payload_json: _payloadJson, payload_hash: _payloadHash, record_id: _recordId, ...safe } = record;
    return { ...safe, payload: stripIdentity(record.payload) };
  });
}

export function evaluationEvidenceTraceView(records = []) {
  return blindTraceView(records).filter((record) => record.span_kind !== "EVALUATOR" && !/^grader\./.test(record.name));
}

export function blindContentView(value) {
  return stripIdentity(value);
}

export function blindGraderRunView(run) {
  if (!run) return null;
  const result = run.result ?? {};
  return {
    id: run.id,
    trial_id: run.trial_id,
    grader_ref: run.grader_ref,
    grader_type: run.grader_type,
    dimension: run.dimension,
    result_hash: run.result_hash,
    created_at: run.created_at,
    result: {
      grader_version: result.grader_version,
      total: result.total,
      passed: result.passed,
      qualification_passed: result.qualification_passed,
      dimensions: result.dimensions,
      hard_gates: result.hard_gates,
      safety: result.safety,
      recommendation_quality: result.recommendation_quality,
      scoring_contract: result.scoring_contract,
    },
  };
}

function redactGraderEvidence(name, evidence = {}) {
  if (name === "rca_quality") {
    return { root_cause_match: Boolean(evidence.rootCauseHit ?? evidence.root_cause_match),
      note: "私有参考根因不进入执行面或交互式分析上下文" };
  }
  return stripIdentity(evidence);
}

export function auditableGraderRunView(run) {
  if (!run) return null;
  const result = run.result ?? {};
  return {
    ...blindGraderRunView(run),
    result: {
      grader_version: result.grader_version,
      total: result.total,
      passed: result.passed,
      qualification_passed: result.qualification_passed,
      dimensions: result.dimensions,
      assertions: Object.fromEntries(Object.entries(result.assertions ?? {}).map(([name, assertion]) => [name, {
        value: assertion.value, passed: assertion.passed, applicable: assertion.applicable !== false,
        evidence: redactGraderEvidence(name, assertion.evidence),
      }])),
      hard_gates: result.hard_gates,
      safety: result.safety,
      recommendation_quality: result.recommendation_quality,
      controlled_closure_evidence: result.controlled_closure_evidence,
      scoring_contract: result.scoring_contract,
      rule: result.excluded_from_cross_architecture_cost_comparison
        ? "本次真实产品开放资源评测不按 Token、时长、调用次数或费用打分；确定性评分只看可观察结果、证据和安全，建议质量在资格阶段单列且权重为零；工具名称和固定调用顺序不计分"
        : "历史工程测试通道沿用其冻结预算合同；工具名称和固定调用顺序不计分",
    },
  };
}
