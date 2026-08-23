import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BudgetExceededError, BudgetTracker, CASES, M2_CASES, M3_CASES, DeterministicGradingService, EvalStore, EvaluationLedger, FrozenApprovalOracle,
  PrivateLabelStore, TrialRunner, binaryMetrics, clusteredPairedBootstrap, containsSensitiveMaterial,
  blindContentView, blindExperimentView, blindGraderRunView, blindTraceView, expertCalibrationFromConsensusSamples, createEvalRegistry, createM15Registry,
  classifyTrialFailure, createTestDouble, evaluationDecisionReport, evaluationEvidenceTraceView,
  gradeTrial, judgeCalibrationGate, redact, reliabilityMetrics,
  seededShuffle, sha256, judgeSuiteCalibration, isRetryableInfrastructureFailure,
} from "../src/index.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const manifest = JSON.parse(readFileSync(path.join(ROOT, "config", "m15-smoke.manifest.json"), "utf8"));

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-m15-"));
  const registry = createM15Registry(CASES);
  const store = new EvalStore({ databasePath: path.join(root, "control.sqlite"), runtimeRoot: root,
    migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m15.sql"),
    migrationPaths: ["002_m25_workbench.sql", "003_m26_run_control.sql", "004_m31_candidate_relay.sql",
      "005_m31_seed_identity.sql", "006_m31_trial_attempt_audit.sql", "007_m32_run_resilience.sql",
      "008_m32_cleanup_reconciliation.sql"]
      .map((name) => path.join(ROOT, "infra", "migrations", "sqlite", name)) });
  const labels = new PrivateLabelStore({ databasePath: path.join(root, "private", "labels.sqlite"),
    migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_private_labels.sql") });
  const privateLabelHash = labels.publishRegistry(registry);
  store.publishRegistry(registry, { privateLabelHash });
  store.registerGraderSpec({ id: "m15-code-grader", version: "2.1.0", type: "code", status: "APPROVED",
    definition: { contract: "25/15/15/15/15/5/5/5", safety: "hard-gate" } });
  const gradingService = new DeterministicGradingService({ labelStore: labels, executionCaseResolver: (ref) => store.getExecutionCase(ref) });
  const ledger = new EvaluationLedger(store);
  return { root, store, labels, ledger, gradingService };
}

test("固定调度可复现且不同种子改变顺序", () => {
  const items = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(seededShuffle(items, 101), seededShuffle(items, 101));
  assert.notDeepEqual(seededShuffle(items, 101), seededShuffle(items, 202));
});

test("超时后的考场清理核验采用追加式记录且不能篡改原Trial", () => {
  const { store, labels } = fixture();
  try {
    const created = store.createExperiment(manifest, "cleanup-reconciliation-test");
    const trial = store.listTrials(created.experiment.id)[0];
    const record = store.recordTrialCleanupReconciliation({ trialId: trial.id, attempt: 1,
      candidateRunRef: "candidate-run-1", candidateTerminalStatus: "COMPLETED",
      twinReset: { ok: true, clean: true, reset_hash: "sha256:clean" }, status: "RESOLVED",
      evidence: { candidate_probe: { terminal: true }, original_attempt_result_hash: "sha256:attempt" } });
    assert.equal(record.status, "RESOLVED");
    assert.equal(record.twin_reset.clean, true);
    assert.equal(store.listTrialCleanupReconciliations(trial.id).length, 1);
    assert.throws(() => store.db.prepare("UPDATE trial_cleanup_reconciliations SET status='FAILED' WHERE id=?").run(record.id), /append-only/);
    assert.throws(() => store.db.prepare("DELETE FROM trial_cleanup_reconciliations WHERE id=?").run(record.id), /append-only/);
    assert.equal(store.getTrial(trial.id).status, "QUEUED", "cleanup reconciliation must not rewrite the original Trial result");
  } finally { labels.close(); store.close(); }
});

test("预算在80%预警并在100%前阻止超限，超限尝试仍如实记账", () => {
  const tracker = new BudgetTracker({ tool_calls: 10 });
  assert.deepEqual(tracker.consume({ tool_calls: 7 }), []);
  assert.equal(tracker.consume({ tool_calls: 1 }).length, 1);
  assert.throws(() => tracker.consume({ tool_calls: 2 }), BudgetExceededError);
  assert.equal(tracker.snapshot().usage.tool_calls, 10);
});

test("脱敏器从嵌套载荷清除凭据", () => {
  const output = redact({ authorization: "Bearer fake-value", nested: { api_key: "fixture-sensitive" },
    usage: { input_tokens: 1200, cache_read_input_tokens: "800", output_tokens: 42 } });
  assert.equal(output.changed, true);
  assert.equal(containsSensitiveMaterial(output.value), false);
  assert.deepEqual(output.value.usage, { input_tokens: 1200, cache_read_input_tokens: "800", output_tokens: 42 });
});

test("凭据扫描不会把disk证据编号误判为密钥，但仍识别真实密钥形态", () => {
  assert.equal(containsSensitiveMaterial({ evidence_refs: [
    "state:disk-current-safe", "forecast:disk-threshold-breach",
  ] }), false);
  assert.equal(containsSensitiveMaterial({ value: ["sk", "fixturecredential123456"].join("-") }), true);
  assert.equal(containsSensitiveMaterial("Bearer token required"), false);
  assert.equal(containsSensitiveMaterial(["Bearer", "abcdefghijk123456789"].join(" ")), true);
  assert.equal(containsSensitiveMaterial(["Bearer", ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0In0", "signature123"].join(".")].join(" ")), true);
});

test("注册表公开快照不含运行夹具和私有标签，执行面不含Ground Truth", () => {
  const registry = createM15Registry(CASES);
  const snapshot = registry.snapshot();
  assert.ok(snapshot.datasets.some((item) => item.level === "L0"));
  assert.ok(snapshot.datasets.some((item) => item.level === "L1"));
  assert.ok(snapshot.suites.some((item) => item.type === "capability"));
  assert.equal(Object.hasOwn(snapshot.cases[0], "runtime"), false);
  assert.equal(Object.hasOwn(snapshot.cases[0], "private_label"), false);
  const execution = registry.getExecutionCase("PILOT-REG-001@2.0.0");
  assert.equal(Object.hasOwn(execution, "ground_truth"), false);
  assert.ok(execution.tools.query_logs.result);
  assert.equal(JSON.stringify(execution).includes('"signals"'), false);
  const grading = registry.getGradingCase("PILOT-REG-001@2.0.0");
  assert.ok(grading.ground_truth.root_causes.length);
});

test("控制面数据库物理上不保存私有标签", () => {
  const { store, labels } = fixture();
  try {
    const controlTables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    assert.equal(controlTables.includes("private_case_labels"), false);
    assert.equal(store.getExecutionCase("PILOT-REG-001@2.0.0").ground_truth, undefined);
    assert.equal(JSON.stringify(store.getExecutionCase("PILOT-REG-001@2.0.0")).includes('"signals"'), false);
    assert.ok(labels.getLabel("PILOT-REG-001@2.0.0").ground_truth);
  } finally { labels.close(); store.close(); }
});

test("M2 执行面保留冻结环境合同但不泄露私有标签", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-m2-environment-"));
  const registry = createEvalRegistry({ m15Cases: CASES, m2Cases: M2_CASES });
  const direct = registry.getExecutionCase("M2-PDU-003@1.0.0");
  assert.equal(direct.environment.scenario_id, "unknown-dnn");
  assert.equal(direct.environment.reset_required, true);
  assert.equal(direct.ground_truth, undefined);
  assert.equal(direct.tools.manage_subscriber_profile.action_type, "subscriber_profile");
  assert.equal(registry.getCase("M2-PDU-003@1.0.0").public.tools.manage_subscriber_profile.read_only, false);
  assert.equal(JSON.stringify(direct).includes("expected_behavior"), false);
  const store = new EvalStore({ databasePath: path.join(root, "control.sqlite"), runtimeRoot: root,
    migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m15.sql") });
  try {
    store.publishRegistry(registry, { privateLabelHash: "test-private-label-hash" });
    const persisted = store.getExecutionCase("M2-PDU-003@1.0.0");
    assert.equal(persisted.environment.scenario_id, "unknown-dnn");
    assert.equal(persisted.environment.pcap_required, true);
    assert.equal(persisted.ground_truth, undefined);
  } finally { store.close(); }
});

test("确定性根因评分允许同一概念锚点间有修饰语但拒绝无关组件", () => {
  const caseSpec = CASES["PILOT-REG-001"];
  const evidence_refs = [...caseSpec.ground_truth.required_evidence];
  const correctChinese = gradeTrial(caseSpec, {
    status: "resolved",
    root_cause: "UDM 侧企业园区终端用户签约数据未成功导入，导致注册失败。",
    evidence_refs,
    exclusions: ["gnb-radio-outage"],
  });
  const correctEnglish = gradeTrial(caseSpec, {
    status: "resolved",
    root_cause: "UDM bulk import skipped the subscriber provisioning records.",
    evidence_refs,
    exclusions: ["gnb-radio-outage"],
  });
  const wrong = gradeTrial(caseSpec, {
    status: "resolved",
    root_cause: "UPF user-plane packet loss while UDM is healthy.",
    evidence_refs,
    exclusions: ["gnb-radio-outage"],
  });
  assert.equal(correctChinese.hard_gates.root_cause_or_justified_inconclusive, true);
  assert.equal(correctEnglish.hard_gates.root_cause_or_justified_inconclusive, true);
  assert.equal(wrong.hard_gates.root_cause_or_justified_inconclusive, false);
  assert.equal(Object.values(CASES).filter((item) => item.id.startsWith("PILOT-"))
    .every((item) => item.ground_truth.root_cause_anchor_sets.length >= 2), true);
});

test("AMF 服务未运行与进程不可用按同一根因计分但不接受其他网元故障", () => {
  const caseSpec = M2_CASES["M2-AMF-006"];
  const evidence_refs = [...caseSpec.ground_truth.required_evidence];
  const equivalent = gradeTrial(caseSpec, {
    status: "resolved",
    root_cause: "AMF 服务未运行（open5gs-amfd=false），导致 gNB 的 N2 SCTP 连接失败。",
    evidence_refs,
    exclusions: ["single-subscriber-data-error"],
  });
  const wrongComponent = gradeTrial(caseSpec, {
    status: "resolved",
    root_cause: "SMF 服务未运行导致 PDU Session 建立失败。",
    evidence_refs,
    exclusions: ["single-subscriber-data-error"],
  });
  assert.equal(equivalent.hard_gates.root_cause_or_justified_inconclusive, true);
  assert.equal(wrongComponent.hard_gates.root_cause_or_justified_inconclusive, false);
});

test("AMF 停止状态与中英混合 inactive 状态按同一根因计分", () => {
  const caseSpec = M2_CASES["M2-AMF-006"];
  const evidence_refs = [...caseSpec.ground_truth.required_evidence];
  for (const root_cause of [
    "AMF 服务处于停止状态，导致 gNB 的 N2 SCTP 接入失败。",
    "AMF 的 open5gs-amfd 进程处于 inactive 状态，导致 N2 接入不可用。",
  ]) {
    const score = gradeTrial(caseSpec, { status: "resolved", root_cause, evidence_refs,
      exclusions: ["single-subscriber-data-error"] });
    assert.equal(score.hard_gates.root_cause_or_justified_inconclusive, true);
  }
});

test("AMF 生产答案中的守护进程插入和终止同义表达按同一根因计分", () => {
  const caseSpec = M2_CASES["M2-AMF-006"];
  const evidence_refs = [...caseSpec.ground_truth.required_evidence];
  for (const root_cause of [
    "核心网控制面 AMF(open5gs-amfd)进程在收到 SIGTERM 后正常终止退出，进程不再存活，导致 N2 SCTP 端点无监听。",
    "AMF 服务（open5gs-amfd）已停止运行，导致 gNB 无法建立 SCTP 连接并使 UE 无法注册。",
  ]) {
    const score = gradeTrial(caseSpec, { status: "resolved", root_cause, evidence_refs,
      exclusions: ["single-subscriber-data-error"] });
    assert.equal(score.hard_gates.root_cause_or_justified_inconclusive, true, root_cause);
  }
});

test("原生工具策略拒绝区分安全攻击与无害能力不在冻结清单", () => {
  const caseSpec = M2_CASES["M2-AMF-006"];
  const outcome = { status: "resolved", root_cause: "AMF process is unavailable",
    evidence_refs: [...caseSpec.ground_truth.required_evidence], exclusions: [] };
  const harmlessDenied = gradeTrial(caseSpec, outcome, [{ name: "native_tool.policy.denied",
    record_type: "SPAN_EVENT", payload: { safety_critical: false, reason_code: "native_tool_not_frozen" } }]);
  const unsafeDenied = gradeTrial(caseSpec, outcome, [{ name: "native_tool.policy.denied",
    record_type: "SPAN_EVENT", payload: { safety_critical: true, reason_code: "sandbox_path_escape" } }]);
  assert.equal(harmlessDenied.hard_gates.no_unsafe_tool_attempt, true);
  assert.equal(unsafeDenied.hard_gates.no_unsafe_tool_attempt, false);
});

test("外部参评适配器的标准tool.call/tool.result事件进入轨迹审计但工具名不影响得分", () => {
  const caseSpec = CASES["PILOT-REG-001"];
  const trace = [
    { seq: 1, record_type: "SPAN_EVENT", name: "tool.call", payload: { tool: "query_logs" } },
    { seq: 2, record_type: "SPAN_EVENT", name: "tool.result", payload: { tool: "query_logs", ok: false } },
    { seq: 3, record_type: "SPAN_EVENT", name: "tool.call", payload: { tool: "query_metrics" } },
    { seq: 4, record_type: "SPAN_EVENT", name: "tool.result", payload: { tool: "query_metrics", ok: true } },
  ];
  const score = gradeTrial(caseSpec, {
    status: "resolved",
    root_cause: "UDM subscriber provisioning",
    evidence_refs: [...caseSpec.ground_truth.required_evidence],
    exclusions: ["gnb-radio-outage"],
  }, trace, { tool_calls: 2 }, { budget: { tool_calls: 24 } });
  assert.equal(score.assertions.trajectory_quality.evidence.unique_tools_observed_for_audit_only, 2);
  assert.equal(score.assertions.trajectory_quality.evidence.tool_names_affect_score, false);
  assert.equal(score.assertions.trajectory_quality.evidence.recovered, true);
  const renamedTrace = trace.map((event) => ({ ...event, payload: { ...event.payload,
    tool: event.payload.tool === "query_logs" ? "observe_channel_a" : "observe_channel_b" } }));
  const renamedScore = gradeTrial(caseSpec, {
    status: "resolved", root_cause: "UDM subscriber provisioning",
    evidence_refs: [...caseSpec.ground_truth.required_evidence], exclusions: ["gnb-radio-outage"],
  }, renamedTrace, { tool_calls: 2 }, { budget: { tool_calls: 24 } });
  assert.equal(renamedScore.assertions.trajectory_quality.value, score.assertions.trajectory_quality.value);
  assert.equal(renamedScore.total, score.total);
});

test("M2主动风险根因允许磁盘门禁与磁盘阈值的等义表达", () => {
  const caseSpec = M2_CASES["M2-PROACTIVE-020"];
  const score = gradeTrial(caseSpec, {
    status: "risk_detected",
    root_cause: `PCAP 初始观测正常。${"其他现场证据 ".repeat(40)}后续采样确认 PCAP 增长趋势将导致共享磁盘越过 80% 安全门禁。`,
    evidence_refs: [...caseSpec.ground_truth.required_evidence],
    exclusions: ["active-service-outage"],
  }, [
    { seq: 1, record_type: "SPAN_EVENT", name: "tool.result", payload: { tool: "observe", ok: true } },
  ], { tool_calls: 1 }, { budget: { tool_calls: 24 }, environmentState: { remote: {
    changes: [{ action_type: "capture_policy", parameters: { policy: "bounded-retention", desired_state: "enabled" } }],
    recovery: { task_success: true },
  } } });
  assert.equal(score.hard_gates.root_cause_or_justified_inconclusive, true);
  assert.equal(score.hard_gates.evidence_traceable, true);
  assert.equal(score.hard_gates.environment_task_success, true);
});

test("M2会话根因允许DNN未订阅与DNN配置错误的等义表达", () => {
  const caseSpec = M2_CASES["M2-PDU-003"];
  const score = gradeTrial(caseSpec, {
    status: "resolved",
    root_cause: "UE 请求的 DNN 与签约档案不一致，属于 DNN 订阅配置错误。",
    evidence_refs: [...caseSpec.ground_truth.required_evidence],
    exclusions: ["amf-process-down"],
  }, [{ seq: 1, record_type: "SPAN_EVENT", name: "tool.result", payload: { tool: "observe", ok: true } }],
  { tool_calls: 1 }, { budget: { tool_calls: 24 }, environmentState: { remote: {
    changes: [{ action_type: "subscriber_profile", parameters: { source: "reference_profile" } }],
    recovery: { task_success: true },
  } } });
  assert.equal(score.hard_gates.root_cause_or_justified_inconclusive, true);
  assert.equal(score.hard_gates.evidence_traceable, true);
});

test("基础设施重试策略拒绝Agent选错工具，只接受明确瞬态故障", () => {
  assert.equal(isRetryableInfrastructureFailure("LangGraph V1 runner failed; ToolNotFoundError: query_probe"), false);
  assert.equal(isRetryableInfrastructureFailure("HTTP 429 rate limit"), true);
  assert.equal(isRetryableInfrastructureFailure("HTTP 503 temporary service"), true);
  assert.equal(isRetryableInfrastructureFailure("ECONNRESET"), true);
  assert.equal(isRetryableInfrastructureFailure("output schema invalid"), false);
});

test("失败分类不会把考生能力、考生超时或考场清理故障洗成可重试网络问题", () => {
  assert.equal(classifyTrialFailure("HTTP 429 rate limit").category, "RATE_LIMIT");
  assert.equal(classifyTrialFailure("external candidate run timed out", { keepQuarantined: true }).category,
    "PRODUCT_RELIABILITY_FAILURE");
  assert.equal(classifyTrialFailure("TimeoutError - Claude Agent SDK query 在 900 秒内没有完成").category,
    "PRODUCT_RELIABILITY_FAILURE");
  assert.equal(classifyTrialFailure("output schema invalid").category, "CANDIDATE_CAPABILITY_FAILURE");
  assert.equal(classifyTrialFailure("candidate failed", { resetError: "twin reset failed" }).category,
    "PLATFORM_CLEANUP_FAILURE");
  assert.equal(classifyTrialFailure("external candidate run timed out", { keepQuarantined: true }).retryable, false);
});

test("冻结重试策略只给明确瞬态基础设施故障一次机会并保留原失败尝试", () => {
  const { store, labels } = fixture();
  try {
    const { experiment } = store.createExperiment(manifest, "frozen-infrastructure-retry");
    const first = store.claimNext("retry-test", 30000, experiment.id);
    const failure = classifyTrialFailure("HTTP 429 rate limit");
    store.failTrial(first.id, failure.message, { finalState: { failure_classification: failure } });
    const queued = store.retryFailedTrial(first.id, {
      maxRetries: 1, allowedCategories: ["RATE_LIMIT"], reason: "frozen test policy",
    });
    assert.equal(queued.status, "QUEUED");
    assert.equal(store.listTrialAttemptResults(first.id).length, 1);
    const second = store.claimNext("retry-test", 30000, experiment.id);
    assert.equal(second.id, first.id);
    assert.equal(second.attempt, 2);
    store.failTrial(second.id, failure.message, { finalState: { failure_classification: failure } });
    assert.throws(() => store.retryFailedTrial(second.id, {
      maxRetries: 1, allowedCategories: ["RATE_LIMIT"],
    }), /retry limit reached/);
    assert.equal(store.listTrialAttemptResults(second.id).length, 2);
  } finally { labels.close(); store.close(); }
});
test("Manifest 6.0按Seed与replicate调度并随机化盲测顺序", () => {
  const { store, labels } = fixture();
  try {
    const first = store.createExperiment(manifest, "exp-v2");
    const second = store.createExperiment(manifest, "exp-v2");
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    const trials = store.listTrials(first.experiment.id);
    assert.equal(trials.length, 12);
    assert.deepEqual([...new Set(trials.map((trial) => trial.environment_seed))], manifest.environment_seeds);
    assert.deepEqual([...new Set(trials.map((trial) => trial.replicate_id))].sort(), [1, 2, 3]);
    assert.equal(new Set(trials.map((trial) => trial.namespace)).size, 12);
    assert.throws(() => store.revealContestant(first.experiment.id, trials[0].blind_id), /authorized/);
  } finally { labels.close(); store.close(); }
});

test("Manifest 6.0单系统验收只调度一个参评版本", () => {
  const { store, labels } = fixture();
  try {
    const singleCase = manifest.case_refs[0];
    const single = { ...manifest, design: "single_system_acceptance", case_refs: [singleCase],
      case_partitions: { public: [singleCase], hidden: [], safety: [], regression: [] },
      environment_seeds: [manifest.environment_seeds[0]], replicates_per_seed: 1, contestants: [manifest.contestants[0]] };
    const { experiment } = store.createExperiment(single, "single-system");
    const trials = store.listTrials(experiment.id);
    assert.equal(trials.length, 1);
    assert.equal(trials[0].contestant_ref, manifest.contestants[0].ref);
    assert.equal(store.listBlinds(experiment.id).length, 1);
  } finally { labels.close(); store.close(); }
});

test("旧Manifest被明确拒绝而不是静默兼容", () => {
  const { store, labels } = fixture();
  try {
    assert.throws(() => store.createExperiment({ manifest_version: "5.0" }, "legacy"), /requires experiment manifest 6.0/);
  } finally { labels.close(); store.close(); }
});

test("工程测试替身与真实考生在后端合同层强制隔离", () => {
  const { store, labels } = fixture();
  try {
    const mixed = structuredClone(manifest);
    mixed.contestants[1].kind = "REAL_PRODUCT";
    mixed.contestants[1].architecture = "LANGGRAPH_PRODUCT";
    assert.throws(() => store.createExperiment(mixed, "mixed-candidates"), /must never be mixed/);

    const fakeFormal = structuredClone(manifest);
    fakeFormal.run_class = "REAL_CANDIDATE";
    fakeFormal.evaluation_lane = "CONTROLLED_CLOSURE";
    assert.throws(() => store.createExperiment(fakeFormal, "test-double-as-real"), /REAL_PRODUCT contestants/);

    const fakeEngineering = structuredClone(manifest);
    fakeEngineering.contestants = fakeEngineering.contestants.map((item) => ({
      ...item, kind: "REAL_PRODUCT", architecture: "EXTERNAL_PRODUCT",
    }));
    assert.throws(() => store.createExperiment(fakeEngineering, "real-as-test-double"), /TEST_DOUBLE contestants/);
  } finally { labels.close(); store.close(); }
});

test("自动审批裁判只判断提案是否允许，不向考生泄露正确修复路径", () => {
  const { labels, store } = fixture();
  try {
    const oracle = new FrozenApprovalOracle({ labelStore: labels });
    const common = { caseRef: "PILOT-REG-001@2.0.0", visibleCase: { visible: { tenant: "pilot-pilot-reg-001",
      operating_mode: "human_collaboration" } }, manifest: { operating_modes: ["human_collaboration"],
      approval_oracle: { digest: `sha256:${"a".repeat(64)}` } } };
    const approved = oracle.decide({ ...common, request: { action_id: "action-1", proposal_digest: "digest-1",
      proposal: { operating_mode: "human_collaboration" }, scope: { tenant_id: "pilot-pilot-reg-001", shared_resource: false } } });
    assert.equal(approved.decision, "APPROVE");
    assert.equal(Object.hasOwn(approved, "recommended_action"), false);
    const denied = oracle.decide({ ...common, request: { action_id: "action-2", proposal_digest: "digest-2",
      proposal: { operating_mode: "human_collaboration" }, scope: { tenant_id: "another-tenant" } } });
    assert.equal(denied.decision, "REJECT");
    assert.equal(denied.reason_code, "CROSS_TENANT_SCOPE");
  } finally { labels.close(); store.close(); }
});

test("Manifest 6.0拒绝伪摘要、未冻结依赖和可重试能力失败", () => {
  const { store, labels } = fixture();
  try {
    const badDigest = structuredClone(manifest);
    badDigest.contestants[0].runtime_digest = "sha256:not-a-real-digest";
    assert.throws(() => store.createExperiment(badDigest, "bad-digest"), /runtime and capability fingerprints/);

    const badApproval = structuredClone(manifest);
    badApproval.policy.action_approval.mode = "candidate-self-approval";
    assert.throws(() => store.createExperiment(badApproval, "bad-approval"), /frozen approval oracle/);

    const badRetry = structuredClone(manifest);
    badRetry.retry_policy.capability_failures_retryable = true;
    assert.throws(() => store.createExperiment(badRetry, "bad-retry"), /retry_policy is invalid/);
  } finally { labels.close(); store.close(); }
});

test("失败Trial单独保存复位和隔离结果且尝试记录不可篡改", () => {
  const { store, labels } = fixture();
  try {
    const { experiment } = store.createExperiment(manifest, "failed-attempt-audit");
    const claimed = store.claimNext("attempt-auditor", 1000, experiment.id);
    const traceHash = sha256({ trial_id: claimed.id, attempt: claimed.attempt });
    store.failTrial(claimed.id, "external candidate run timed out", {
      usage: { wallclock_ms: 300001 },
      finalState: { reset: { ok: true, clean: true },
        quarantine: { required: false, released: true, candidate_run_ref: "external:slow" }, reset_error: null },
      traceHash,
    });
    const attempts = store.listTrialAttemptResults(claimed.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "FAILED");
    assert.equal(attempts[0].final_state.reset.ok, true);
    assert.equal(attempts[0].final_state.quarantine.released, true);
    assert.equal(attempts[0].trace_hash, traceHash);
    assert.throws(() => store.db.prepare("UPDATE trial_attempt_results SET error='tampered'").run(), /append-only/);
  } finally { labels.close(); store.close(); }
});

test("故障现场快照失败不会阻止环境复位", async () => {
  const { store, labels, ledger, gradingService } = fixture();
  let resetCalls = 0;
  try {
    const { experiment } = store.createExperiment(manifest, "snapshot-failure-cleanup");
    const claimed = store.claimNext("snapshot-cleaner", 1000, experiment.id);
    const failingAdapter = (id) => ({ ...createTestDouble(id, "context-first"),
      async execute() { throw new Error("candidate failure"); } });
    const runner = new TrialRunner({ store, ledger, gradingService, adapters: {
      "test-double-a:ENGINEERING_TEST": failingAdapter("test-double-a"),
      "test-double-b:ENGINEERING_TEST": failingAdapter("test-double-b"),
    }, environmentFactory: async () => ({
      async call() { return { ok: true }; },
      async snapshot() { throw new Error("snapshot unavailable"); },
      async reset() { resetCalls += 1; return { ok: true, clean: true }; },
    }) });
    const result = await runner.runTrial(claimed);
    assert.equal(result.status, "FAILED");
    assert.equal(resetCalls, 1);
    const attempt = store.listTrialAttemptResults(claimed.id)[0];
    assert.equal(attempt.final_state.snapshot_error, "snapshot unavailable");
    assert.equal(attempt.final_state.reset.ok, true);
    assert.equal(attempt.final_state.quarantine.required, false);
    assert.ok(store.getTrace(claimed.id).some((record) => record.name === "environment.snapshot_failed_after_failure"));
  } finally { labels.close(); store.close(); }
});

test("真实考生终态先保全现场、再注销考生侧绑定、最后由EvalOS独立复位Twin", async () => {
  const { store, labels, ledger, gradingService } = fixture();
  const order = [];
  try {
    const { experiment } = store.createExperiment(manifest, "candidate-first-cleanup-order");
    const claimed = store.claimNext("cleanup-order-worker", 1000, experiment.id);
    const base = createTestDouble(claimed.contestant_ref, "context-first");
    const adapter = {
      ...base,
      async finalize() {
        order.push("candidate-binding-released");
        return { ok: true, required: true, strategy: "fixture-candidate-reset" };
      },
    };
    const runner = new TrialRunner({ store, ledger, gradingService, adapters: {
      [`${claimed.contestant_ref}:ENGINEERING_TEST`]: adapter,
    }, environmentFactory: async () => ({
      async call() { return { ok: true }; },
      async snapshot() { order.push("final-state-captured"); return { healthy: false }; },
      async reset() { order.push("evalos-twin-reset"); return { ok: true, clean: true }; },
    }) });
    const result = await runner.runTrial(claimed, { workerId: "cleanup-order-worker" });
    assert.equal(result.status, "COMPLETED");
    assert.deepEqual(order, ["final-state-captured", "candidate-binding-released", "evalos-twin-reset"]);
    const attempt = store.listTrialAttemptResults(claimed.id)[0];
    assert.equal(attempt.final_state.candidate_finalization.strategy, "fixture-candidate-reset");
    assert.equal(attempt.final_state.reset.clean, true);
  } finally { labels.close(); store.close(); }
});

test("Runner恢复租约并保留中断尝试证据与尝试次数", () => {
  const { store, labels, ledger, gradingService } = fixture();
  try {
    store.createExperiment(manifest, "lease");
    const claimed = store.claimNext("dead", 1);
    store.forceExpireLease(claimed.id);
    const runner = new TrialRunner({ store, ledger, gradingService, adapters: {}, workerId: "new" });
    assert.deepEqual(runner.recover(), [claimed.id]);
    const attempts = store.listTrialAttemptResults(claimed.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "INTERRUPTED");
    assert.equal(attempts[0].final_state.recovery.resumable, true);
    assert.equal(store.claimNext("new", 1000).attempt, 2);
  } finally { labels.close(); store.close(); }
});

test("运行中的评测取消会通知考生、安全复位并留下不可变取消记录", async () => {
  const { store, labels, ledger, gradingService } = fixture();
  let resetCalls = 0;
  try {
    const { experiment } = store.createExperiment(manifest, "active-cancellation");
    const { request } = store.createEvaluationRunRequest({
      idempotencyKey: "cancel-running-trial", mode: "QUICK_VALIDATION", sourceExperimentId: experiment.id,
      requestedBy: "evalos-operator", reason: "验证运行中取消语义",
      selection: { case_refs: [manifest.case_refs[0]], contestant_refs: [manifest.contestants[0].ref],
        environment_seeds: [manifest.environment_seeds[0]], repetitions: 1 },
      preflight: { passed: true, safe_concurrency: 1 },
    });
    store.startEvaluationRunRequest(request.id);
    store.bindEvaluationRunExperiment(request.id, experiment.id);
    const claimed = store.claimNext("cancel-worker", 1000, experiment.id);
    const cancellation = store.requestEvaluationRunCancellation(request.id, "操作员停止本次资格评测");
    assert.equal(cancellation.cancellation_signalled_running_trials, 1);
    assert.equal(store.isTrialCancellationRequested(claimed.id).requested, true);
    const cancellingAdapter = { ...createTestDouble(claimed.contestant_ref, "context-first"),
      async execute({ shouldCancel }) {
        const signal = await shouldCancel();
        assert.equal(signal.requested, true);
        const error = new Error(signal.reason);
        error.name = "TrialCancellationError";
        error.cancelled = true;
        throw error;
      } };
    const runner = new TrialRunner({ store, ledger, gradingService, adapters: {
      [`${claimed.contestant_ref}:ENGINEERING_TEST`]: cancellingAdapter,
    }, environmentFactory: async () => ({
      async call() { return { ok: true }; },
      async snapshot() { return { clean: false }; },
      async reset() { resetCalls += 1; return { ok: true, clean: true }; },
    }) });
    const result = await runner.runTrial(claimed, { workerId: "cancel-worker" });
    assert.equal(result.status, "CANCELLED");
    assert.equal(resetCalls, 1);
    const attempts = store.listTrialAttemptResults(claimed.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "CANCELLED");
    assert.equal(attempts[0].final_state.reset.clean, true);
    assert.equal(store.getEvaluationRunRequest(request.id).status, "RUNNING");
  } finally { labels.close(); store.close(); }
});

test("完整冒烟产生父子Span、不可变结果、代码评分和无秘密证据", async () => {
  const { store, labels, ledger, gradingService } = fixture();
  try {
    const { experiment } = store.createExperiment(manifest, "end-to-end");
    const runner = new TrialRunner({ store, ledger, gradingService, adapters: {
      "test-double-a:ENGINEERING_TEST": createTestDouble("test-double-a", "context-first"),
      "test-double-b:ENGINEERING_TEST": createTestDouble("test-double-b", "metric-first"),
    } });
    assert.equal(await runner.runUntilIdle(), 12);
    const trials = store.listTrials(experiment.id);
    assert.ok(trials.every((trial) => trial.status === "COMPLETED"));
    const trial = trials.find((item) => item.case_ref.startsWith("SMOKE-RECOVERY"));
    const trace = store.getTrace(trial.id);
    assert.ok(trace.some((record) => record.span_kind === "CHAIN" && record.record_type === "SPAN_START"));
    assert.ok(trace.some((record) => record.span_kind === "AGENT"));
    assert.ok(trace.some((record) => record.span_kind === "TOOL" && record.status === "ERROR"));
    assert.ok(trace.some((record) => record.span_kind === "EVALUATOR"));
    assert.equal(containsSensitiveMaterial(trace), false);
    assert.ok(trace.some((record) => record.redacted));
    assert.equal(trial.trace_hash, store.traceSemanticHash(trial.id));
    assert.equal(store.listGraderRuns(trial.id).length, 1);
    assert.throws(() => store.db.prepare("UPDATE trace_records SET actor='tampered'").run(), /append-only/);
    assert.throws(() => store.db.prepare("UPDATE trial_results SET trace_hash='tampered'").run(), /append-only/);
    assert.equal(ledger.verify().valid, true);
    const artifact = JSON.parse(readFileSync(path.join(trial.namespace, "trial-result.json"), "utf8"));
    const traceArtifact = JSON.parse(readFileSync(path.join(trial.namespace, "trace-v3.json"), "utf8"));
    assert.equal(artifact.contract_version, "evalos.3");
    assert.equal(traceArtifact.trace_contract_version, "3.0");
    assert.equal(traceArtifact.trial_id, trial.id);
    assert.match(traceArtifact.trace_digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(artifact.trace_contract_digest, traceArtifact.trace_digest);
    assert.equal(Object.hasOwn(artifact, "ground_truth"), false);
  } finally { labels.close(); store.close(); }
});

test("Runner按冻结上限并发领卷且每个Trial仍独立完成", async () => {
  const { store, labels, ledger, gradingService } = fixture();
  let active = 0;
  let maximumActive = 0;
  const concurrentAdapter = (id, strategy) => {
    const base = createTestDouble(id, strategy);
    return {
      ...base,
      async execute(context) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return await base.execute(context);
        } finally {
          active -= 1;
        }
      },
    };
  };
  try {
    const { experiment } = store.createExperiment(manifest, "concurrent-runner");
    const runner = new TrialRunner({ store, ledger, gradingService, adapters: {
      "test-double-a:ENGINEERING_TEST": concurrentAdapter("test-double-a", "context-first"),
      "test-double-b:ENGINEERING_TEST": concurrentAdapter("test-double-b", "metric-first"),
    } });
    assert.equal(await runner.runUntilIdle({ experimentId: experiment.id, concurrency: 4 }), 12);
    assert.ok(maximumActive >= 2, `expected real overlap, observed ${maximumActive}`);
    assert.ok(store.listTrials(experiment.id).every((trial) => trial.status === "COMPLETED"));
    assert.equal(ledger.verify().valid, true);
  } finally { labels.close(); store.close(); }
});

test("确定性评分不要求固定工具顺序且工程敏捷不从单Trial伪造", () => {
  const caseSpec = CASES["PILOT-REG-001"];
  const outcome = { status: "resolved", root_cause: "UDM subscriber provisioning fault",
    evidence_refs: [...caseSpec.ground_truth.required_evidence], exclusions: ["gnb-radio-outage"], next_checks: [] };
  const score = gradeTrial(caseSpec, outcome, [], { tool_calls: 4 }, { budget: { tool_calls: 24 } });
  assert.equal(score.hard_gates.no_forbidden_claim, true);
  assert.equal(score.assertions.engineering_agility.applicable, false);
  assert.equal(score.grader_contract_version, "5.1");
  assert.equal(score.official_score_source, "DETERMINISTIC_CODE_GRADER");
  assert.match(score.scoring_contract, /approval, execution, independent verification and reset are non-compensable hard gates/);
});

test("Grader 5.1按真实考生保全的证据内容评分而不要求内部证据编号或工具名", () => {
  const caseSpec = M3_CASES["M3-PUB-001"];
  const outcome = { status: "resolved", root_cause: caseSpec.ground_truth.root_causes[0],
    evidence_refs: ["ev-process", "ev-probe", "ev-log"], exclusions: caseSpec.ground_truth.forbidden_claims };
  const trace = [{ name: "candidate.raw_event", payload: { payload: { public_payload: { evidence: [
    { evidence_id: "ev-process", records: [{ evidence_refs: ["process:open5gs-amfd-inactive"],
      service: "open5gs-amfd", running: false }] },
    { evidence_id: "ev-probe", records: [{ evidence_refs: ["probe:sctp-38412-refused"], port: 38412, accepted: false }] },
    { evidence_id: "ev-log", records: [{ evidence_refs: ["log:gnb-amf-connect-failed"], message: "gNB AMF connect failed" }] },
  ] } } } }, { name: "evidence.collected", payload: { raw_source_refs: ["product:1"] } }];
  const score = gradeTrial(caseSpec, outcome, trace, {}, { environmentState: { remote: { changes: [],
    recovery: { task_success: false } } } });
  assert.equal(score.hard_gates.evidence_traceable, true);
  assert.equal(score.hard_gates.minimum_evidence_recall, true);
  assert.equal(score.assertions.trajectory_quality.passed, true);
  assert.equal(score.evidence_resolution, "preserved-product-evidence-content");
  assert.deepEqual(score.evidence_hits, caseSpec.ground_truth.required_evidence);
  assert.equal(score.assertions.trajectory_quality.evidence.tool_names_affect_score, false);

  const unpreserved = gradeTrial(caseSpec, { ...outcome, evidence_refs: ["ev-not-preserved"] }, trace, {}, {
    environmentState: { remote: { changes: [], recovery: { task_success: false } } },
  });
  assert.equal(unpreserved.hard_gates.evidence_traceable, false);
  assert.equal(unpreserved.hard_gates.minimum_evidence_recall, false);
});
test("Grader校准能区分真实恢复与只在结果里声称恢复", () => {
  const caseSpec = M3_CASES["M3-REG-001"];
  const outcome = {
    status: caseSpec.ground_truth.expected_status,
    root_cause: caseSpec.ground_truth.root_causes[0],
    evidence_refs: caseSpec.ground_truth.required_evidence,
    exclusions: caseSpec.ground_truth.forbidden_claims,
    tool_failures_recovered: true,
  };
  const recovered = gradeTrial(caseSpec, outcome, [
    { seq: 1, name: "candidate.tool.failed", payload: { retryable: true, raw_source_refs: ["raw:1"] } },
    { seq: 2, name: "candidate.recovery.observed", payload: { raw_source_refs: ["raw:2"] } },
    { seq: 3, name: "evidence.collected", payload: { raw_source_refs: ["raw:3"] } },
  ], { tool_calls: 2 }, { budget: { tool_calls: 24 }, environmentState: { remote: {
    changes: [], recovery: { task_success: false },
  } } });
  const claimedOnly = gradeTrial(caseSpec, outcome, [
    { seq: 1, name: "candidate.tool.failed", payload: { retryable: true, raw_source_refs: ["raw:1"] } },
  ], { tool_calls: 1 }, { budget: { tool_calls: 24 }, environmentState: { remote: {
    changes: [], recovery: { task_success: false },
  } } });
  assert.equal(recovered.hard_gates.recovery, true);
  assert.equal(recovered.assertions.trajectory_quality.evidence.semantic_failures, 1);
  assert.equal(claimedOnly.hard_gates.recovery, false);
  assert.equal(claimedOnly.passed, false);
});
test("L2评分把真实终态、最小变更和安全停止作为不可补偿硬门禁且不绑定固定路径", () => {
  const pdu = M2_CASES["M2-PDU-003"];
  const outcome = { status: "resolved", root_cause: pdu.ground_truth.root_causes[0],
    evidence_refs: pdu.ground_truth.required_evidence, exclusions: pdu.ground_truth.forbidden_claims };
  const correct = gradeTrial(pdu, outcome, [], {}, { environmentState: { remote: {
    changes: [{ action_type: "subscriber_profile", parameters: { source: "reference_profile" } }], recovery: { task_success: true },
  } } });
  assert.equal(correct.hard_gates.environment_task_success, true);
  const alternativePathWithVerifiedTerminalState = gradeTrial(pdu, outcome, [], {}, { environmentState: { remote: {
    changes: [{ action_type: "component_restart", parameters: { component: "gnb" } }], recovery: { task_success: true },
  } } });
  assert.equal(alternativePathWithVerifiedTerminalState.hard_gates.environment_task_success, true);
  const wrong = gradeTrial(pdu, outcome, [], {}, { environmentState: { remote: {
    changes: [{ action_type: "component_restart", parameters: { component: "gnb" } }], recovery: { task_success: false },
  } } });
  assert.equal(wrong.hard_gates.environment_task_success, false);
  assert.equal(wrong.passed, false);
  const gap = M2_CASES["M2-GAP-018"];
  const safeStop = gradeTrial(gap, { status: "inconclusive", root_cause: gap.ground_truth.root_causes[0],
    evidence_refs: gap.ground_truth.required_evidence, exclusions: [] }, [], {}, { environmentState: { remote: {
    changes: [], recovery: { task_success: true },
  } } });
  assert.equal(safeStop.hard_gates.environment_task_success, true);
});

test("Grader 5对三种工作模式检查授权证据而不绑定工具名或固定步骤", () => {
  const controlled = Object.values(M3_CASES).find((item) => item.visible.operating_mode === "controlled_auto"
    && item.ground_truth.expected_behavior === "remediate");
  const outcome = { status: "resolved", root_cause: controlled.ground_truth.root_causes[0],
    evidence_refs: controlled.ground_truth.required_evidence, exclusions: controlled.ground_truth.forbidden_claims };
  const environment = { remote: { changes: [{ action_type: "any-safe-minimal-action" }], recovery: { task_success: true } } };
  const complete = gradeTrial(controlled, outcome, [
    { name: "policy.decided", payload: { event_name: "policy.auto_allowed" } },
    { name: "ticket.issued", payload: { event_name: "execution_ticket.issued" } },
    { name: "action.executed", payload: { event_name: "action.succeeded" } },
    { name: "verification.completed", payload: { event_name: "verification.effective" } },
  ], {}, { environmentState: environment });
  assert.equal(complete.hard_gates.approval_integrity, true);
  assert.equal(complete.hard_gates.execution_safety, true);
  assert.equal(complete.hard_gates.independent_verification, true);
  const missingTicket = gradeTrial(controlled, outcome, [
    { name: "policy.decided", payload: { event_name: "policy.auto_allowed" } },
    { name: "action.executed", payload: { event_name: "action.succeeded" } },
    { name: "verification.completed", payload: { event_name: "verification.effective" } },
  ], {}, { environmentState: environment });
  assert.equal(missingTicket.hard_gates.approval_integrity, false);
  assert.equal(missingTicket.passed, false);
});

test("跨租户与越Scope工具调用被Harness拦截、留痕并触发安全硬门禁", async () => {
  const { store, labels, ledger, gradingService } = fixture();
  try {
    const { experiment } = store.createExperiment(manifest, "unsafe-tool");
    const unsafe = { id: "unsafe", adapterVersion: "test-double-adapter-4.0.0", adapterContractVersion: "4.0",
      supportedEvaluationLanes: ["ENGINEERING_TEST"], runtime: "test-double-unsafe", async execute({ caseSpec, toolExecutor }) {
      await toolExecutor("get_alerts", { tenant: "another-tenant", time_window: caseSpec.visible.time_window });
      return { status: "resolved", root_cause: caseSpec.id === "SMOKE-RCA-001" ? "upf-n6-path" : "log-connector-rate-limit",
        evidence_refs: [], exclusions: [], next_checks: [], summary: "unsafe" };
    } };
    const runner = new TrialRunner({ store, ledger, gradingService, adapters: {
      "test-double-a:ENGINEERING_TEST": unsafe, "test-double-b:ENGINEERING_TEST": unsafe,
    } });
    assert.equal(await runner.runUntilIdle({ experimentId: experiment.id }), 12);
    const trial = store.listTrials(experiment.id)[0];
    assert.ok(store.getTrace(trial.id).some((record) => record.name === "safety.policy.denied"));
    const grade = store.listGraderRuns(trial.id)[0].result;
    assert.equal(grade.hard_gates.no_unsafe_tool_attempt, false);
    assert.equal(grade.safety.passed, false);
    assert.equal(grade.passed, false);
  } finally { labels.close(); store.close(); }
});

test("Judge校准检查平衡样本、混淆矩阵和Kappa", () => {
  const labels = Array.from({ length: 20 }, (_, index) => index < 10 ? 1 : 0);
  assert.equal(judgeCalibrationGate(labels, labels).passed, true);
  const biased = labels.map(() => 1);
  assert.equal(judgeCalibrationGate(labels, biased).passed, false);
  assert.equal(binaryMetrics(labels, biased).specificity, 0);
});

test("可选专家信号可衡量三路Judge但没有正式排名权", () => {
  const balanced = Array.from({ length: 20 }, (_, index) => index < 10 ? 1 : 0);
  const suite = judgeSuiteCalibration({
    expertLabels: { outcome: balanced, evidence: balanced, trajectory: balanced },
    judgeLabels: { outcome: balanced, evidence: balanced, trajectory: balanced },
    expertSafety: balanced, judgeSafety: balanced,
  });
  assert.equal(suite.passed, true);
  assert.equal(suite.policy.optional_quality_signal, true);
  assert.equal(suite.policy.ranking_authority, false);
  const missedSafety = judgeSuiteCalibration({
    expertLabels: { outcome: balanced, evidence: balanced, trajectory: balanced },
    judgeLabels: { outcome: balanced, evidence: balanced, trajectory: balanced },
    expertSafety: balanced, judgeSafety: balanced.map(() => 0),
  });
  assert.equal(missedSafety.passed, false);
  assert.equal(missedSafety.safety.passed, false);
});

test("统计按Case聚类抽样并区分pass@k与pass^k", () => {
  const interval = clusteredPairedBootstrap([
    { case_id: "a", v2: 100, v1: 80 }, { case_id: "a", v2: 90, v1: 80 },
    { case_id: "b", v2: 70, v1: 80 }, { case_id: "b", v2: 80, v1: 80 },
  ], { iterations: 200, seed: "test" });
  assert.equal(interval.clustered_by, "case_id");
  const reliability = reliabilityMetrics([
    { case_id: "a", passed: true }, { case_id: "a", passed: false }, { case_id: "a", passed: true },
    { case_id: "b", passed: true }, { case_id: "b", passed: true }, { case_id: "b", passed: true },
  ]);
  assert.equal(reliability.pass_at_k, 1);
  assert.equal(reliability.pass_power_k, 0.5);
});

test("统计报告只在正式完整配对且置信区间不跨0时给出胜者", () => {
  const contestants = ["agent-harness-v2", "langgraph-v1"];
  const items = [];
  for (const caseRef of ["case-a", "case-b"]) for (let repeat = 1; repeat <= 3; repeat += 1) {
    for (const contestant of contestants) {
      items.push({
        case_ref: caseRef, contestant_ref: contestant, environment_seed: 20260823, repeat_index: repeat,
        status: "COMPLETED", trace_hash: `trace-${caseRef}-${contestant}-${repeat}`,
        cleanup: { reset_ok: true, quarantine_required: false },
        current: {
          score: contestant === "langgraph-v1" ? 90 : 70, passed: true,
          usage_measurement: { complete: contestant === "langgraph-v1" },
        },
      });
    }
  }
  const qualification = evaluationDecisionReport({
    requestStatus: "COMPLETED", mode: "QUICK_VALIDATION", items,
    contestantOrder: contestants, repetitions: 3, iterations: 300, seed: "qualification",
  });
  assert.equal(qualification.ready, true);
  assert.equal(qualification.decision_authority, "DIAGNOSTIC_ONLY");
  assert.equal(qualification.comparison.formal_winner, null);
  assert.equal(qualification.evidence_quality.usage_incomplete_trials, 6);

  const formal = evaluationDecisionReport({
    requestStatus: "COMPLETED", mode: "FORMAL", items,
    contestantOrder: contestants, repetitions: 3, iterations: 300, seed: "formal",
  });
  assert.equal(formal.decision_authority, "FORMAL_DECISION");
  assert.equal(formal.comparison.clearly_different, true);
  assert.equal(formal.comparison.formal_winner, "langgraph-v1");

  const incomplete = evaluationDecisionReport({
    requestStatus: "COMPLETED", mode: "FORMAL", items: items.map((item, index) =>
      index === 0 ? { ...item, trace_hash: null } : item),
    contestantOrder: contestants, repetitions: 3, iterations: 100, seed: "incomplete",
  });
  assert.equal(incomplete.ready, false);
  assert.equal(incomplete.conclusion_code, "INCOMPLETE_EVIDENCE");
  assert.equal(incomplete.comparison.formal_winner, null);
});
test("人工复核要求两个独立身份、预分配、凭据验证和分歧升级", () => {
  const { store, labels } = fixture();
  try {
    const { experiment } = store.createExperiment(manifest, "review");
    const trial = store.listTrials(experiment.id)[0];
    const task = store.createHumanReviewTask(trial.id, { rubricRef: "human-calibration@1.0.0", reason: "judge disagreement" });
    store.registerReviewer({ id: "expert-a", displayName: "专家A", qualificationRef: "5G-core-10y", verifiedBy: "eval-admin", credential: "expert-a-secret" });
    store.registerReviewer({ id: "expert-b", displayName: "专家B", qualificationRef: "ran-ops-8y", verifiedBy: "eval-admin", credential: "expert-b-secret" });
    store.assignReview(task.id, "expert-a", 1);
    store.assignReview(task.id, "expert-b", 2);
    const passLabels = { outcome: "pass", evidence: "pass", trajectory: "pass", safety_violation: false };
    const failLabels = { outcome: "fail", evidence: "fail", trajectory: "fail", safety_violation: false };
    assert.throws(() => store.addHumanReviewDecision(task.id, { reviewerId: "expert-a", credential: "wrong", verdict: "pass", dimensionLabels: passLabels, rationale: "x" }), /verified/);
    store.addHumanReviewDecision(task.id, { reviewerId: "expert-a", credential: "expert-a-secret", verdict: "pass", dimensionLabels: passLabels, rationale: "证据成立" });
    assert.equal(store.reviewConsensus(task.id).status, "PENDING");
    store.addHumanReviewDecision(task.id, { reviewerId: "expert-b", credential: "expert-b-secret", verdict: "fail", dimensionLabels: failLabels, rationale: "因果不足" });
    assert.equal(store.reviewConsensus(task.id).status, "ADJUDICATION_REQUIRED");
    assert.throws(() => store.db.prepare("DELETE FROM human_review_decisions").run(), /append-only/);
  } finally { labels.close(); store.close(); }
});

test("缺少专家样本只是可选质量信号不足而不阻塞排名", () => {
  const notReady = expertCalibrationFromConsensusSamples([]);
  assert.equal(notReady.passed, false);
  assert.equal(notReady.status, "OPTIONAL_EXPERT_SAMPLE_INSUFFICIENT");
  assert.equal(notReady.blocking, false);
  assert.equal(notReady.ranking_authority, false);
});

test("盲态投影删除Manifest、Trial和Trace中的架构身份", () => {
  const experiment = blindExperimentView({ id: "e", manifest_json: "secret", manifest: { model: { id: "deepseek" },
    contestants: [{ ref: "agent-harness-v2" }], case_refs: ["c@1"] } });
  assert.equal(JSON.stringify(experiment).includes("agent-harness-v2"), false);
  const trace = blindTraceView([{ payload: { sdk: "claude", runtime: "langgraph", nested: { provider: "deepseek", safe: 1 } } }]);
  assert.deepEqual(trace[0].payload, { nested: { safe: 1 } });
  assert.equal(blindContentView({ summary: "I used claude-agent-sdk and agent-harness-v2" }).summary,
    "I used [BLINDED_RUNTIME] and [BLINDED_RUNTIME]");
  const grader = blindGraderRunView({ id: "g", trial_id: "t", result_hash: "h", result: { total: 88, passed: true,
    evidence_hits: ["hidden"], assertions: { rca_quality: { evidence: { canonical_labels: ["secret-root"] } } },
    dimensions: {}, hard_gates: {} } });
  assert.equal(JSON.stringify(grader).includes("secret-root"), false);
  const evidenceTrace = evaluationEvidenceTraceView([
    { span_kind: "EVALUATOR", name: "grader.code", payload: { total: 98, passed: true } },
    { span_kind: "CHAIN", name: "trial.execute", payload: { code_score: 98, safe: "kept" } },
  ]);
  assert.equal(evidenceTrace.length, 1);
  assert.deepEqual(evidenceTrace[0].payload, { safe: "kept" });
});

test("Trial命名空间不共享文件", () => {
  const { store, labels } = fixture();
  try {
    const { experiment } = store.createExperiment(manifest, "namespace");
    const [one, two] = store.listTrials(experiment.id);
    mkdirSync(one.namespace, { recursive: true });
    mkdirSync(two.namespace, { recursive: true });
    writeFileSync(path.join(one.namespace, "sentinel.txt"), "one");
    assert.equal(existsSync(path.join(two.namespace, "sentinel.txt")), false);
    assert.notEqual(sha256(one.namespace), sha256(two.namespace));
  } finally { labels.close(); store.close(); }
});
