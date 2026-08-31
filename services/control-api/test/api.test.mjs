import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCandidateConnectorSet, candidatePreflightInput, createApp, evaluationRunName, trialLiveProgressView,
  trustedDeploymentAttestation } from "../src/app.mjs";
import { CANDIDATE_PRESENCE_CONTRACT, candidatePresenceSignaturePayload,
  createTestDouble, freezeSourceSnapshot } from "../../../packages/kernel/src/index.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const manifest = JSON.parse(readFileSync(path.join(ROOT, "config", "m15-smoke.manifest.json"), "utf8"));
const formalM3Manifest = JSON.parse(readFileSync(path.join(ROOT, "config", "m3-formal-agent-capability.manifest.json"), "utf8"));

test("一小时级Trial持续展示在线心跳、实质进展和卡顿风险而不规定求解步骤", () => {
  const startedAt = "2026-08-23T00:00:00.000Z";
  const experiment = { manifest: { budget: { wallclock_ms: 3600000 } } };
  const queued = trialLiveProgressView({ status: "QUEUED", started_at: null }, experiment, [], Date.now());
  assert.equal(queued.progress_state, "QUEUED");
  assert.equal(queued.liveness, "NOT_STARTED");
  assert.match(queued.interpretation_zh, /尚未开始作答/);
  const active = trialLiveProgressView({ status: "RUNNING", started_at: startedAt }, experiment, [
    { name: "candidate.raw_event", actor: "external-candidate", span_kind: "AGENT", record_type: "SPAN_EVENT", timestamp: "2026-08-23T00:08:00.000Z" },
    { name: "candidate.poll.heartbeat", actor: "candidate-adapter", span_kind: "INTERNAL", record_type: "SPAN_EVENT", timestamp: "2026-08-23T00:09:50.000Z" },
  ], new Date("2026-08-23T00:10:00.000Z").getTime());
  assert.equal(active.progress_state, "ACTIVE");
  assert.equal(active.liveness, "LIVE");
  assert.equal(active.elapsed_ms, 600000);
  assert.equal(active.next_checkpoint_ms, 900000);
  assert.equal(active.counters.liveness_heartbeats, 1);
  const starting = trialLiveProgressView({ status: "RUNNING", started_at: startedAt }, experiment, [
    { name: "candidate.poll.heartbeat", actor: "candidate-adapter", span_kind: "INTERNAL", record_type: "SPAN_EVENT", timestamp: "2026-08-23T00:00:20.000Z" },
  ], new Date("2026-08-23T00:00:30.000Z").getTime());
  assert.equal(starting.progress_state, "ACTIVE");
  const stalled = trialLiveProgressView({ status: "RUNNING", started_at: startedAt }, experiment, [
    { name: "candidate.raw_event", actor: "external-candidate", span_kind: "AGENT", record_type: "SPAN_EVENT", timestamp: "2026-08-23T00:01:00.000Z" },
    { name: "candidate.poll.heartbeat", actor: "candidate-adapter", span_kind: "INTERNAL", record_type: "SPAN_EVENT", timestamp: "2026-08-23T00:14:50.000Z" },
  ], new Date("2026-08-23T00:15:00.000Z").getTime());
  assert.equal(stalled.progress_state, "STALLED");
  assert.equal(stalled.liveness, "LIVE");
  assert.match(stalled.interpretation_zh, /10分钟没有实质进展/);

  const candidateHeartbeatOnly = trialLiveProgressView({ status: "RUNNING", started_at: startedAt }, experiment, [
    { name: "candidate.raw_event", actor: "external-candidate", span_kind: "AGENT", record_type: "SPAN_EVENT",
      timestamp: "2026-08-23T00:01:00.000Z", payload: { payload: { event_type: "agent.progress", payload: {
        title: "完成第一轮取证", next_step: "等待模型汇总" } } } },
    { name: "candidate.raw_event", actor: "external-candidate", span_kind: "AGENT", record_type: "SPAN_EVENT",
      timestamp: "2026-08-23T00:14:55.000Z", payload: { payload: { event_type: "investigation.heartbeat", payload: {} } } },
  ], new Date("2026-08-23T00:15:00.000Z").getTime());
  assert.equal(candidateHeartbeatOnly.liveness, "LIVE");
  assert.equal(candidateHeartbeatOnly.progress_state, "STALLED");
  assert.equal(candidateHeartbeatOnly.counters.candidate_events, 1);
  assert.match(candidateHeartbeatOnly.meaningful_progress.summary_zh, /完成第一轮取证/);

  const stopping = trialLiveProgressView({ status: "RUNNING", started_at: startedAt }, experiment, [
    { name: "candidate.run.quarantine_started", actor: "candidate-adapter", span_kind: "AGENT",
      record_type: "SPAN_EVENT", timestamp: "2026-08-23T00:09:00.000Z" },
  ], new Date("2026-08-23T00:10:30.000Z").getTime());
  assert.equal(stopping.progress_state, "STOPPING");
  assert.match(stopping.interpretation_zh, /等待真实考生进入终态/);
});

test("重评名称只保留一层用途前缀", () => {
  assert.equal(evaluationRunName("M3.1 双考生资格试运行", "QUICK_VALIDATION"), "快速验证 · M3.1 双考生资格试运行");
  assert.equal(evaluationRunName("快速验证 · M3.1 双考生资格试运行", "TARGETED_REGRESSION"), "定向回归 · M3.1 双考生资格试运行");
  assert.equal(evaluationRunName("定向回归 · M3.1 双考生资格试运行", "CAPACITY_REHEARSAL"), "容量演练 · M3.1 双考生资格试运行");
  assert.equal(evaluationRunName("定向回归 · M3.1 双考生资格试运行", "FORMAL"), "正式评测 · M3.1 双考生资格试运行");
});

test("管理员可在不创建Trial或触碰Twin的前提下只读核验Adapter 5漂移", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-v5-discovery-"));
  const discovery = {
    source_revision: "candidate-revision-v5", artifact_digest: `sha256:${"a".repeat(64)}`,
    runtime_digest: `sha256:${"b".repeat(64)}`, runtime_manifest_digest: `sha256:${"c".repeat(64)}`,
    capability_contract_digest: `sha256:${"d".repeat(64)}`,
    candidate_runtime: { contract_version: "1.0", models: [{ provider: "deepseek", id: "deepseek-v4-flash",
      interface: "anthropic", thinking: "enabled", roles: ["investigation"] }], versions: { service: "5.0.0" } },
  };
  const app = createApp({ databasePath: path.join(root, "control.sqlite"),
    privateLabelDatabasePath: path.join(root, "private", "labels.sqlite"), runtimeRoot: root,
    apiToken: "admin-secret", discoveryConnectorOverrides: {
      "agent-harness-v2:5.0": { discover: async () => discovery },
    } });
  try {
    assert.equal((await app.handler(new Request("http://local/api/candidate-adapters/discover?contract_version=5.0"))).status, 401);
    const invalid = await app.handler(new Request("http://local/api/candidate-adapters/discover?contract_version=6.0", {
      headers: { authorization: "Bearer admin-secret" } }));
    assert.equal(invalid.status, 400);
    const response = await app.handler(new Request("http://local/api/candidate-adapters/discover?contract_version=5.0", {
      headers: { authorization: "Bearer admin-secret" } }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.contract, "candidate-discovery.4");
    assert.equal(body.production_writes, false);
    assert.equal(body.creates_trial, false);
    assert.equal(body.touches_twin, false);
    assert.equal(body.items[0].contract_version, "5.0");
    assert.equal(body.items[0].frozen_contract_version, "5.0");
    assert.equal(body.items[0].freeze_required, false);
    assert.equal(body.items[0].ready, false);
    assert.ok(body.items[0].drift.includes("candidate_runtime"));
    assert.deepEqual(body.items[0].discovery.candidate_runtime, discovery.candidate_runtime);
    assert.equal(app.store.listTrials().length, 0);
  } finally { app.close(); }
});

test("新版候选的只读发现不被旧冻结运行合同阻断，而执行连接器继续严格绑定", () => {
  const v4Calls = [];
  const v5Calls = [];
  const createV4 = (options) => { v4Calls.push(options); return { kind: "v4-discovery" }; };
  const createV5 = (options) => { v5Calls.push(options); return { kind: options.declaredCandidateRuntime
    ? "v5-execution" : "v5-discovery" }; };
  const candidateRuntime = { contract_version: "1.0", models: [], versions: { service: "2.3.4" } };
  const connectorOptions = { attestation: { source_revision: "new", artifact_digest: `sha256:${"a".repeat(64)}` } };
  const built = buildCandidateConnectorSet({ createV4, createV5, connectorOptions,
    useV5: true, candidateRuntime });
  assert.equal(v4Calls.length, 1);
  assert.equal(v5Calls.length, 2);
  assert.equal(v5Calls[0].declaredCandidateRuntime, undefined);
  assert.equal(v5Calls[1].declaredCandidateRuntime, candidateRuntime);
  assert.equal(built.discoveryConnectorsByVersion["5.0"].kind, "v5-discovery");
  assert.equal(built.executionConnector.kind, "v5-execution");
});

test("就绪页与运行预检共用Manifest 8开放资源合同，不再回退到历史预算", () => {
  assert.equal(formalM3Manifest.manifest_version, "8.0");
  for (const contestant of formalM3Manifest.contestants) {
    const profile = formalM3Manifest.candidate_resource_contract.profiles
      .find((item) => item.contestant_ref === contestant.ref);
    const input = candidatePreflightInput(formalM3Manifest, contestant);
    assert.deepEqual(input.budget, profile.candidate_resources);
    assert.deepEqual(input.settlementBudget, profile.settlement_reserve);
    assert.deepEqual(input.resourcePolicy, formalM3Manifest.candidate_resource_contract.policy);
    assert.equal(input.requiresTwin, true);
  }
});

test("候选当前部署身份必须来自独立可信证明而不是正式Manifest循环自证", () => {
  const observed = trustedDeploymentAttestation({ contract_version: "evalos-deployment-attestation/1.0",
    source_revision: "a".repeat(40), artifact_digest: `sha256:${"b".repeat(64)}`,
    verification_method: "evalos_trusted_read_only_git_oci", verified_evidence_ref: "oci-readback:test" });
  assert.deepEqual(observed, { source_revision: "a".repeat(40), artifact_digest: `sha256:${"b".repeat(64)}` });
  assert.throws(() => trustedDeploymentAttestation({ source_revision: "a".repeat(40),
    artifact_digest: `sha256:${"b".repeat(64)}` }), /independent EvalOS deployment attestation/);
});

test("Twin状态接口只允许可信服务器执行只读status且不创建Trial", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-twin-status-"));
  const calls = [];
  const app = createApp({ databasePath: path.join(root, "control.sqlite"),
    privateLabelDatabasePath: path.join(root, "private", "labels.sqlite"), runtimeRoot: root,
    apiToken: "admin-secret", twinManagerClientOverride: { invoke: async (request) => {
      calls.push(request);
      return { ok: true, operation: "status", contestant_ref: request.contestant_ref,
        active_trial: null, slot_available: true, slot_lease_present: false,
        controller_status: "ready", topology: { ready: true, runtime_isolated: true } };
    } } });
  try {
    assert.equal((await app.handler(new Request("http://local/api/workbench/twin-status"))).status, 401);
    const response = await app.handler(new Request("http://local/api/workbench/twin-status", {
      headers: { authorization: "Bearer admin-secret" } }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.contract, "evalos-twin-status.1");
    assert.equal(body.ready, true);
    assert.equal(body.production_writes, false);
    assert.equal(body.operation, "status");
    assert.deepEqual(calls, [
      { operation: "status", contestant_ref: "agent-harness-v2" },
      { operation: "status", contestant_ref: "langgraph-v1" },
    ]);
    assert.equal(app.store.listTrials().length, 0);
  } finally { app.close(); }
});

test("候选报到入口只收独立签名状态，内存过期且不转发任何调查", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-candidate-presence-"));
  const langgraph = generateKeyPairSync("ed25519");
  const agent = generateKeyPairSync("ed25519");
  const presenceConfig = { candidates: {
    "agent-harness-v2": { key_id: "agent-presence-key",
      public_key_pem: agent.publicKey.export({ type: "spki", format: "pem" }) },
    "langgraph-v1": { key_id: "langgraph-presence-key",
      public_key_pem: langgraph.publicKey.export({ type: "spki", format: "pem" }) },
  } };
  const app = createApp({ databasePath: path.join(root, "control.sqlite"),
    privateLabelDatabasePath: path.join(root, "private", "labels.sqlite"), runtimeRoot: root,
    apiToken: "admin-secret", candidatePresenceConfig: presenceConfig });
  const now = Date.now();
  const report = { contract_version: CANDIDATE_PRESENCE_CONTRACT,
    candidate_ref: "agent-harness-v2", release_id: "abcdef123456", product_boot_id: "agent-boot-1",
    status: "ready", capabilities: ["investigation", "model_visible_result", "protocol_lab_mcp"],
    database_revision: "017_native_run_context_budget",
    binding: { status: "unbound", owner_mode: null, trial_id: null, lease_id: null,
      environment_ref: null, lab_boot_id: null }, observed_at: new Date(now).toISOString(),
    expires_at: new Date(now + 180000).toISOString(), nonce: "nonce_0123456789012345678901" };
  const signedRequest = (value, privateKey = agent.privateKey, keyId = "agent-presence-key") => new Request(
    "http://local/api/candidate-presence", { method: "POST", headers: { "content-type": "application/json",
      "x-opsmind-key-id": keyId,
      "x-opsmind-signature": sign(null, Buffer.from(candidatePresenceSignaturePayload(value)), privateKey)
        .toString("base64url") }, body: JSON.stringify(value) });
  try {
    const rejected = await app.handler(signedRequest(report, langgraph.privateKey));
    assert.equal(rejected.status, 401);
    const accepted = await app.handler(signedRequest(report));
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).accepted, true);
    assert.equal((await app.handler(signedRequest(report))).status, 401);
    const oversized = await app.handler(new Request(
      "http://local/api/candidate-presence", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }),
      }));
    assert.equal(oversized.status, 413);
    const malformed = await app.handler(new Request(
      "http://local/api/candidate-presence", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{",
      }));
    assert.equal(malformed.status, 400);
    assert.equal(app.store.listTrials().length, 0);
    const view = await app.handler(new Request("http://local/api/workbench/candidate-presence", {
      headers: { authorization: "Bearer admin-secret" } }));
    assert.equal(view.status, 200);
    assert.equal((await view.json()).items.find((item) => item.ref === "agent-harness-v2").report.status, "ready");
  } finally { app.close(); }

  const restarted = createApp({ databasePath: path.join(root, "control.sqlite"),
    privateLabelDatabasePath: path.join(root, "private", "labels.sqlite"), runtimeRoot: root,
    apiToken: "admin-secret", candidatePresenceConfig: presenceConfig });
  try {
    const view = await restarted.handler(new Request("http://local/api/workbench/candidate-presence", {
      headers: { authorization: "Bearer admin-secret" } }));
    assert.equal((await view.json()).items.find((item) => item.ref === "agent-harness-v2").report, null);
  } finally { restarted.close(); }
});

test("后续安全复位会解除平台健康阻塞但不会改写失败Trial", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-cleanup-health-"));
  const app = createApp({ databasePath: path.join(root, "control.sqlite"),
    privateLabelDatabasePath: path.join(root, "private", "labels.sqlite"), runtimeRoot: root,
    apiToken: "admin-secret" });
  try {
    const created = app.store.createExperiment(manifest, "cleanup-health-test");
    const trial = app.store.claimNext("cleanup-test-worker", 30000, created.experiment.id);
    app.store.failTrial(trial.id, "external candidate quarantine unresolved: timed out", { finalState: {
      quarantine: { required: true, released: false, candidate_run_ref: "candidate-run-timeout" },
      failure_classification: { category: "PRODUCT_RELIABILITY_FAILURE", owner: "CANDIDATE" },
    } });
    let health = await (await app.handler(new Request("http://local/api/workbench/operations-health", {
      headers: { authorization: "Bearer admin-secret" } }))).json();
    assert.equal(health.status, "degraded");
    assert.equal(health.evidence.unresolved_cleanup_trials, 1);
    app.store.recordTrialCleanupReconciliation({ trialId: trial.id, attempt: 1,
      candidateRunRef: "candidate-run-timeout", candidateTerminalStatus: "COMPLETED",
      twinReset: { ok: true, clean: true }, status: "RESOLVED",
      evidence: { original_attempt_result_hash: app.store.listTrialAttemptResults(trial.id)[0].result_hash } });
    health = await (await app.handler(new Request("http://local/api/workbench/operations-health", {
      headers: { authorization: "Bearer admin-secret" } }))).json();
    assert.equal(health.status, "ok");
    assert.equal(health.evidence.unresolved_cleanup_trials, 0);
    assert.equal(health.evidence.reconciled_cleanup_trials, 1);
    assert.equal(app.store.getTrial(trial.id).status, "FAILED");
  } finally { app.close(); }
});

test("冻结设计中的未开考Trial与真正可运行队列分开统计", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-frozen-template-health-"));
  const app = createApp({ databasePath: path.join(root, "control.sqlite"),
    privateLabelDatabasePath: path.join(root, "private", "labels.sqlite"), runtimeRoot: root,
    apiToken: "admin-secret" });
  try {
    const created = app.store.createExperiment(manifest, "frozen-template-health-test");
    const planned = app.store.listTrials(created.experiment.id).length;
    assert.equal(planned > 0, true);
    const health = await (await app.handler(new Request("http://local/api/workbench/operations-health", {
      headers: { authorization: "Bearer admin-secret" } }))).json();
    assert.equal(health.trials.queued, 0);
    assert.equal(health.trials.frozen_template_trials, planned);
    assert.equal(health.requests.queued, 0);
  } finally { app.close(); }
});

test("清理核验必须先确认真实考生终态，再通过受限Twin管理器恢复干净基线", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-cleanup-reconcile-"));
  const caseRef = formalM3Manifest.case_refs[0];
  const contestant = formalM3Manifest.contestants[0];
  const smallManifest = { ...formalM3Manifest, name: "清理核验测试", design: "single_system_acceptance",
    evaluation_mode: "QUALIFICATION", contestants: [contestant], case_refs: [caseRef], environment_seeds: [2026082301],
    replicates_per_seed: 1, case_partitions: { public: [caseRef], hidden: [], safety: [], regression: [] },
    candidate_resource_contract: { ...formalM3Manifest.candidate_resource_contract,
      profiles: formalM3Manifest.candidate_resource_contract.profiles
        .filter((item) => item.contestant_ref === contestant.ref) } };
  const resetCalls = [];
  const candidateFinalizeCalls = [];
  const app = createApp({ databasePath: path.join(root, "control.sqlite"),
    privateLabelDatabasePath: path.join(root, "private", "labels.sqlite"), runtimeRoot: root,
    apiToken: "admin-secret", cleanupConnectorOverrides: { [contestant.ref]: {
      probeRun: async ({ runRef }) => ({ run_ref: runRef, status: "COMPLETED", terminal: true, raw_status: "resolved" }),
      finalize: async ({ runRef, reason }) => { candidateFinalizeCalls.push({ runRef, reason });
        throw new Error("候选产品内部复位检查未通过"); },
    } }, twinManagerClientOverride: { invoke: async (request) => { resetCalls.push(request); return { ok: true, clean: true,
      operation: "reset", reset_hash: "sha256:clean" }; } } });
  try {
    const created = app.store.createExperiment(smallManifest, "cleanup-reconcile-test");
    const bypass = await app.handler(new Request(`http://local/api/experiments/${created.experiment.id}/run`, {
      method: "POST", headers: { authorization: "Bearer admin-secret" } }));
    assert.equal(bypass.status, 409);
    const trial = app.store.claimNext("cleanup-test-worker", 30000, created.experiment.id);
    app.store.failTrial(trial.id, "external candidate quarantine unresolved: timed out", { finalState: {
      candidate_finalization_error: "candidate relay path was temporarily unavailable",
      quarantine: { required: true, released: false, candidate_run_ref: "candidate-run-terminal-later" },
      failure_classification: { category: "PRODUCT_RELIABILITY_FAILURE", owner: "CANDIDATE" },
    } });
    const reconciliation = await app.reconcileTrialCleanup(trial.id);
    assert.equal(reconciliation.status, "RESOLVED");
    assert.equal(reconciliation.candidate_terminal_status, "COMPLETED");
    assert.deepEqual(candidateFinalizeCalls, [{ runRef: "candidate-run-terminal-later", reason: "cleanup_reconciliation" }]);
    assert.equal(resetCalls.length, 1);
    assert.equal(resetCalls[0].operation, "reset");
    assert.match(resetCalls[0].trial_id, /^(?:ah-|lg-)/);
    assert.equal(app.store.getTrial(trial.id).status, "FAILED");
    assert.equal(app.ledger.entries().at(-1).action, "trial.cleanup_reconciled");
    assert.equal(reconciliation.evidence.candidate_product_cleanup_succeeded, false);
    assert.equal(reconciliation.evidence.candidate_finalization_error, "候选产品内部复位检查未通过");
    assert.equal(reconciliation.evidence.platform_cleanup_authority, "evalos-independent-twin-manager");
    assert.equal(reconciliation.twin_reset.clean, true);
  } finally { app.close(); }
});

test("M1.5 API运行原生Manifest、公开注册表、流式Span Trace并隐藏身份和标签", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-api-m15-"));
  for (const file of ["M2验收结论.json", "M2变更执行器验收结论.json", "M2-Agent端到端验收结论.json", "M2双架构适配资格验收结论.json"]) {
    writeFileSync(path.join(root, file), JSON.stringify({ status: "PASSED", checks: { sample: true } }));
  }
  const app = createApp({ databasePath: path.join(root, "control.sqlite"), privateLabelDatabasePath: path.join(root, "private", "labels.sqlite"),
    runtimeRoot: root, artifactsRoot: root, m2ArtifactsRoot: root, m2ExecutorArtifactsRoot: root,
    m2AgentArtifactsRoot: root, m2QualificationArtifactsRoot: root, apiToken: "admin-secret",
    caseInvestigator: { analyze: async () => ({ result: { summary: "已完成只读调查", diagnosis: "工具恢复策略不足",
      score_interpretation: "正式分数保持不变", strengths: [], issues: [{ severity: "medium", category: "agent",
        title: "恢复不足", evidence_refs: ["trace:1"], analysis: "遇到失败后补证不足", recommendation: "增加反证", confidence: 0.8 }],
      optimization_plan: [{ priority: 1, title: "增强反证", why: "减少误判", how: "按信息增益补证", validation: "新增回归Case" }],
      methodology_sources: [], limitations: [], confidence: 0.8 }, usage: { turns: 2 } }) } });
  try {
    const ready = await (await app.handler(new Request("http://local/ready"))).json();
    assert.equal(ready.contract, "evalos-readiness.1");
    assert.equal(ready.ready, true);
    assert.equal(ready.formal_run.enabled, false);
    const health = await (await app.handler(new Request("http://local/health"))).json();
    assert.equal(health.contract, "evalos.7");
    assert.equal(health.milestone, "M3.2");
    assert.equal(health.formal_run.enabled, false);
    assert.equal(health.operations.contract, "evalos-operations-health.1");
    assert.equal(health.operations.ledger.valid, true);
    const operationsHealth = await (await app.handler(new Request("http://local/api/workbench/operations-health", { headers: { authorization: "Bearer admin-secret" } }))).json();
    assert.equal(operationsHealth.status, "ok");
    assert.equal(operationsHealth.evidence.unresolved_cleanup_trials, 0);
    const capabilities = await (await app.handler(new Request("http://local/api/runtime/capabilities"))).json();
    assert.equal(capabilities.candidate_execution, "external-real-products-only");
    assert.equal(capabilities.eval_intelligence.model, "deepseek-v4-flash");
    assert.equal(capabilities.eval_intelligence.graphFramework, null);
    assert.equal(capabilities.eval_intelligence.score_authority, false);
    assert.equal(capabilities.trust_boundary.execution_plane_private_labels, false);
    const m2Summary = await (await app.handler(new Request("http://local/api/m2/summary"))).json();
    assert.equal(m2Summary.status, "PASSED");
    assert.equal(m2Summary.ranking_produced, false);
    assert.equal(m2Summary.gates.change_executor.status, "PASSED");
    const executorCalibration = await (await app.handler(new Request("http://local/api/m2/executor"))).json();
    assert.equal(executorCalibration.status, "PASSED");
    assert.equal(Object.keys(m2Summary.gates).length, 4);
    const cases = await (await app.handler(new Request("http://local/api/cases"))).json();
    assert.equal(JSON.stringify(cases).includes("ground_truth"), false);
    const create = () => app.handler(new Request("http://local/api/experiments", { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "api-m15", authorization: "Bearer admin-secret" }, body: JSON.stringify({ manifest }) }));
    const first = await create();
    const firstBody = await first.json();
    assert.equal(first.status, 201);
    assert.equal((await create()).status, 200);
    const run = await app.handler(new Request(`http://local/api/experiments/${firstBody.experiment.id}/run`, {
      method: "POST", headers: { authorization: "Bearer admin-secret" } }));
    const runBody = await run.json();
    assert.equal(runBody.executed, 12);
    const detail = await (await app.handler(new Request(`http://local/api/experiments/${firstBody.experiment.id}`))).json();
    assert.equal(detail.trials.length, 12);
    assert.equal(Object.hasOwn(detail.trials[0], "contestant_ref"), false);
    assert.equal(JSON.stringify(detail.experiment).includes("contestants"), false);
    assert.equal(JSON.stringify(detail.experiment).includes("deepseek"), false);
    assert.equal(detail.trials[0].replicate_id > 0, true);
    const trialId = detail.trials[0].id;
    const stream = await app.handler(new Request(`http://local/api/trials/${trialId}/trace`, { headers: { accept: "text/event-stream" } }));
    const text = await stream.text();
    assert.match(text, /event: span-trace/);
    assert.match(text, /SPAN_START/);
    assert.doesNotMatch(text, /fixture-sensitive/);
    assert.doesNotMatch(text, /claude-agent-sdk|deterministic-replay-brain|mock-contestant/i);
    assert.doesNotMatch(text, /grader\.code|code_score|label_hash/);
    const graders = await (await app.handler(new Request(`http://local/api/trials/${trialId}/graders`, {
      headers: { authorization: "Bearer admin-secret" } }))).json();
    assert.equal(graders.items.length, 1);
    assert.equal(JSON.stringify(graders).includes("canonical_labels"), false);
    assert.equal(JSON.stringify(graders).includes("evidence_hits"), false);
    assert.equal((await app.handler(new Request(`http://local/api/trials/${trialId}/graders`))).status, 401);
    assert.equal((await app.handler(new Request("http://local/api/workbench/overview"))).status, 401);
    const overview = await (await app.handler(new Request("http://local/api/workbench/overview", {
      headers: { authorization: "Bearer admin-secret" } }))).json();
    assert.equal(overview.contract, "evalos-workbench.4");
    assert.equal(overview.counts.experiments, 1);
    const readiness = await (await app.handler(new Request("http://local/api/workbench/candidate-readiness", {
      headers: { authorization: "Bearer admin-secret" } }))).json();
    assert.equal(readiness.contract, "evalos-candidate-readiness.1");
    assert.equal(readiness.formal_480_enabled, false);
    assert.equal(readiness.items.every((item) => item.kind === "REAL_PRODUCT" && item.ready === false), true);
    const workbenchTrials = await (await app.handler(new Request("http://local/api/workbench/trials", {
      headers: { authorization: "Bearer admin-secret" } }))).json();
    assert.equal(workbenchTrials.items.length, 12);
    assert.equal(workbenchTrials.items.some((item) => item.id === trialId && item.trace_records > 1 && item.grade?.total), true);
    assert.equal(workbenchTrials.items.every((item) => item.evaluation_mode === "QUALIFICATION"), true);
    assert.equal(workbenchTrials.items.every((item) => item.affects_official_score === false), true);
    assert.equal(workbenchTrials.items.every((item) => item.attempts.length === 1 && Object.hasOwn(item.latest_cleanup, "reset_ok")), true);
    assert.equal(JSON.stringify(workbenchTrials).includes("canonical_labels"), false);
    const workbenchTrial = await (await app.handler(new Request(`http://local/api/workbench/trials/${trialId}`, {
      headers: { authorization: "Bearer admin-secret" } }))).json();
    assert.equal(workbenchTrial.efficiency_audit.contract, "evalos-trial-efficiency-audit/1.0");
    assert.equal(workbenchTrial.efficiency_audit.authority, "descriptive_post_hoc_review_not_official_grader");
    assert.equal(workbenchTrial.efficiency_audit.privacy.audit_contains_model_text, false);
    assert.equal(workbenchTrial.graders[0].result.rule.includes("工具名称"), true);
    assert.equal(JSON.stringify(workbenchTrial.graders).includes("canonical_labels"), false);
    assert.equal(workbenchTrial.attempts.length, 1);
    assert.equal(Object.hasOwn(workbenchTrial.attempts[0].cleanup, "reset_ok"), true);
    const workbenchTrace = await (await app.handler(new Request(`http://local/api/workbench/trials/${trialId}/trace?limit=1`, {
      headers: { authorization: "Bearer admin-secret" } }))).json();
    assert.equal(workbenchTrace.items.length, 1);
    assert.equal(workbenchTrace.total > 1, true);
    assert.equal(workbenchTrace.has_more, true);
    assert.equal(workbenchTrace.contract, "evalos-machine-log.1");
    assert.equal(workbenchTrace.items[0].display.contract, "evalos-event-semantics.1");
    assert.equal(Boolean(workbenchTrace.items[0].display.title.zh), true);
    assert.equal(Boolean(workbenchTrace.items[0].display.title.en), true);

    const templates = await (await app.handler(new Request("http://local/api/workbench/run-templates", {
      headers: { authorization: "Bearer admin-secret" } }))).json();
    assert.deepEqual(templates.items[0].case_refs, manifest.case_refs);
    const rerunTemplate = await (await app.handler(new Request(`http://local/api/workbench/run-templates?source_experiment_id=${firstBody.experiment.id}`, {
      headers: { authorization: "Bearer admin-secret" } }))).json();
    assert.deepEqual(rerunTemplate.items.map((item) => item.id), [firstBody.experiment.id]);
    const selectionBody = { request_kind: "RERUN_FROZEN", evaluation_purpose: "RERUN_FROZEN",
      mode: "QUICK_VALIDATION", source_experiment_id: firstBody.experiment.id,
      case_refs: [manifest.case_refs[0]], contestant_refs: manifest.contestants.map((item) => item.ref),
      repetitions: 1, requested_by: "api-test-operator", reason: "验证人工单题重新评测不会污染正式成绩" };
    const preflightResponse = await app.handler(new Request("http://local/api/workbench/run-requests/preflight", { method: "POST",
      headers: { authorization: "Bearer admin-secret", "content-type": "application/json" }, body: JSON.stringify(selectionBody) }));
    assert.equal(preflightResponse.status, 200);
    const preflight = (await preflightResponse.json()).preflight;
    assert.equal(preflight.ready, true);
    assert.equal(preflight.contract, "evalos-preflight.3");
    assert.equal(preflight.request_kind, "RERUN_FROZEN");
    assert.equal(preflight.total_trials, 2);
    assert.equal(preflight.affects_official_score, false);
    const singleResponse = await app.handler(new Request("http://local/api/workbench/run-requests/preflight", { method: "POST",
      headers: { authorization: "Bearer admin-secret", "content-type": "application/json" }, body: JSON.stringify({ ...selectionBody,
        request_kind: "NEW_EVALUATION", evaluation_purpose: "SINGLE_SYSTEM_REGRESSION",
        contestant_refs: [manifest.contestants[0].ref] }) }));
    assert.equal(singleResponse.status, 200);
    const singlePreflight = (await singleResponse.json()).preflight;
    assert.equal(singlePreflight.total_trials, 1);
    assert.deepEqual(singlePreflight.contestant_refs, [manifest.contestants[0].ref]);
    const illegalRerun = await app.handler(new Request("http://local/api/workbench/run-requests/preflight", { method: "POST",
      headers: { authorization: "Bearer admin-secret", "content-type": "application/json" }, body: JSON.stringify({ ...selectionBody,
        contestant_refs: [manifest.contestants[0].ref] }) }));
    assert.equal(illegalRerun.status, 400);
    const createEvaluationRequest = () => app.handler(new Request("http://local/api/workbench/run-requests", { method: "POST",
      headers: { authorization: "Bearer admin-secret", "content-type": "application/json", "idempotency-key": "api-select-one-case" },
      body: JSON.stringify(selectionBody) }));
    const evaluationResponse = await createEvaluationRequest();
    assert.equal(evaluationResponse.status, 202);
    const evaluationRequestId = (await evaluationResponse.json()).request.id;
    let evaluationRequest;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      evaluationRequest = (await (await app.handler(new Request(`http://local/api/workbench/run-requests/${evaluationRequestId}`, {
        headers: { authorization: "Bearer admin-secret" } }))).json()).request;
      if (["COMPLETED", "FAILED"].includes(evaluationRequest.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(evaluationRequest.status, "COMPLETED");
    assert.equal(evaluationRequest.progress.total, 2);
    assert.equal(evaluationRequest.progress.completed, 2);
    assert.equal(evaluationRequest.items.every((item) => item.source_trial_id && item.trial_id && item.source_trial_id !== item.trial_id), true);
    assert.equal(evaluationRequest.decision_report.ready, true);
    assert.equal(evaluationRequest.decision_report.decision_authority, "DIAGNOSTIC_ONLY");
    assert.equal(evaluationRequest.decision_report.conclusion_code, "QUALIFICATION_NO_WINNER");
    assert.equal(evaluationRequest.decision_report.comparison.paired_trials, 1);
    assert.equal(evaluationRequest.decision_report.comparison.formal_winner, null);
    assert.equal(evaluationRequest.items.every((item) => item.trace_hash && item.cleanup?.reset_ok !== false), true);
    assert.equal(evaluationRequest.items.every((item) => item.current?.usage_measurement?.complete === true), true);
    assert.equal((await createEvaluationRequest()).status, 200);
    const officialAfterValidation = await (await app.handler(new Request("http://local/api/workbench/overview", {
      headers: { authorization: "Bearer admin-secret" } }))).json();
    assert.equal(officialAfterValidation.score.graded, 0);
    assert.equal(officialAfterValidation.counts.experiments, 2);
    const regradeResponse = await app.handler(new Request("http://local/api/workbench/regrades", { method: "POST",
      headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
      body: JSON.stringify({ trial_ids: [trialId], requested_by: "api-test-operator", reason: "验证重评不覆盖原官方评分" }) }));
    assert.equal(regradeResponse.status, 201);
    const regrade = await regradeResponse.json();
    assert.equal(regrade.items[0].original_score, regrade.items[0].recalculated_score);
    assert.equal(regrade.items[0].official_score_mutated, false);
    assert.equal(app.store.listGraderRuns(trialId).length, 1);
    assert.equal(app.store.listRegradeRequests(trialId).length, 1);

    const sourceRoot = path.join(root, "source-fixture");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(path.join(sourceRoot, "agent.mjs"), "export const loop = 'agentic';\n", "utf8");
    const frozen = freezeSourceSnapshot({ roots: [{ path: sourceRoot, prefix: "opsmind" }], storageRoot: path.join(root, "snapshots"),
      contestantRef: app.store.getTrial(trialId).contestant_ref, sourceRevision: "fixture-revision",
      artifactDigest: `sha256:${"a".repeat(64)}` });
    const snapshot = app.store.registerSourceSnapshot({ contestantRef: app.store.getTrial(trialId).contestant_ref,
      sourceRevision: "fixture-revision", artifactDigest: `sha256:${"a".repeat(64)}`, treeHash: frozen.tree_hash,
      storagePath: frozen.storage_path, files: frozen.files });
    app.store.attachTrialSourceSnapshot(trialId, snapshot.snapshot_ref);
    const sourceBoundIndex = await (await app.handler(new Request("http://local/api/workbench/trials", {
      headers: { authorization: "Bearer admin-secret" } }))).json();
    assert.equal(sourceBoundIndex.items.find((item) => item.id === trialId).source_snapshot.file_count, 1);
    const analysisResponse = await app.handler(new Request("http://local/api/analysis-runs", { method: "POST",
      headers: { authorization: "Bearer admin-secret", "content-type": "application/json", "idempotency-key": "analysis-api-fixture" },
      body: JSON.stringify({ trial_id: trialId, prompt: "只读分析该Case", mode: "case_diagnosis",
        budget: { wallclock_ms: 1, cost_usd: 99, max_turns: 999 } }) }));
    assert.equal(analysisResponse.status, 202);
    const analysisId = (await analysisResponse.json()).analysis.id;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const analysis = await (await app.handler(new Request(`http://local/api/analysis-runs/${analysisId}`, {
      headers: { authorization: "Bearer admin-secret" } }))).json();
    assert.equal(analysis.analysis.status, "COMPLETED");
    assert.equal(analysis.analysis.result.summary, "已完成只读调查");
    assert.deepEqual(analysis.analysis.budget, { wallclock_ms: 300000, cost_usd: 2, max_turns: 32, max_tool_calls: 24 });
    assert.equal(app.store.listGraderRuns(trialId)[0].result.total, graders.items[0].result.total);
    const emptyReviews = await (await app.handler(new Request("http://local/api/reviews"))).json();
    assert.equal(emptyReviews.optional, true);
    assert.equal(emptyReviews.blocking, false);
    assert.equal(emptyReviews.ranking_authority, false);
    const task = app.store.createHumanReviewTask(trialId, { rubricRef: "human-calibration@1", reason: "test-blind-evidence" });
    app.store.registerReviewer({ id: "expert-evidence", displayName: "取证专家", qualificationRef: "5g-ops-8y",
      verifiedBy: "eval-admin", credential: "expert-evidence-secret" });
    app.store.assignReview(task.id, "expert-evidence", 1);
    const evidenceResponse = await app.handler(new Request(`http://local/api/reviews/${task.id}/evidence`, { headers: {
      "x-reviewer-id": "expert-evidence", "x-reviewer-credential": "expert-evidence-secret",
    } }));
    assert.equal(evidenceResponse.status, 200);
    const evidence = await evidenceResponse.json();
    assert.equal(JSON.stringify(evidence).includes("code_grade"), false);
    assert.equal(JSON.stringify(evidence).includes("judge_score"), false);
    assert.equal(JSON.stringify(evidence).includes("contestant_ref"), false);
    assert.equal(JSON.stringify(evidence).includes("grader.code"), false);
    assert.equal(JSON.stringify(evidence).includes("code_score"), false);
    assert.equal((await app.handler(new Request(`http://local/api/reviews/${task.id}/evidence`, { headers: {
      "x-reviewer-id": "expert-evidence", "x-reviewer-credential": "wrong",
    } }))).status, 401);
    assert.equal((await (await app.handler(new Request("http://local/api/ledger/verify"))).json()).valid, true);
  } finally { app.close(); }
});

test("写接口启用Token时拒绝未认证请求且CORS不使用通配符", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-api-auth-"));
  const app = createApp({ databasePath: path.join(root, "control.sqlite"), privateLabelDatabasePath: path.join(root, "private.sqlite"),
    runtimeRoot: root, apiToken: "control-secret", allowedOrigin: "https://evalos.example" });
  try {
    const response = await app.handler(new Request("http://local/api/experiments", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://evalos.example");
  } finally { app.close(); }
});

test("旧Product Tool Bridge已被断代移除，EvalOS不能代替真实考生调用内部工具", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-api-product-bridge-"));
  const app = createApp({ databasePath: path.join(root, "control.sqlite"), privateLabelDatabasePath: path.join(root, "private.sqlite"),
    runtimeRoot: root, apiToken: "control-secret" });
  try {
    const request = () => app.handler(new Request("http://local/internal/product-tool-bridge", { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer control-secret" },
      body: JSON.stringify({ trial_id: "trial-forged", contract_digest: `sha256:${"a".repeat(64)}`,
        tool_name: "get_alerts", arguments: {} }) }));
    const response = await request();
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /not found/);
  } finally { app.close(); }
});

test("评测任务只对冻结允许的瞬态限流自动重试一次并保留两次尝试证据", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-api-auto-retry-"));
  const base = createTestDouble("test-double-a", "context-first");
  let executions = 0;
  const flaky = { ...base, async execute(context) {
    executions += 1;
    if (executions === 1) throw new Error("HTTP 429 rate limit from temporary model gateway");
    return base.execute(context);
  } };
  const app = createApp({
    databasePath: path.join(root, "control.sqlite"),
    privateLabelDatabasePath: path.join(root, "private.sqlite"),
    runtimeRoot: root,
    apiToken: "control-secret",
    bootstrapEngineeringTestDesign: true,
    engineeringAdapterOverrides: { "test-double-a:ENGINEERING_TEST": flaky },
  });
  try {
    const source = app.store.listExperiments().find((item) => item.manifest.run_class === "ENGINEERING_TEST");
    const selection = {
      request_kind: "NEW_EVALUATION", evaluation_purpose: "PAIRED_COMPARISON", mode: "QUICK_VALIDATION",
      source_experiment_id: source.id, case_refs: [manifest.case_refs[0]],
      contestant_refs: manifest.contestants.map((item) => item.ref),
      environment_seeds: [manifest.environment_seeds[0]], repetitions: 1,
      requested_by: "retry-policy-test", reason: "验证瞬态基础设施失败只按冻结策略重试一次",
    };
    const response = await app.handler(new Request("http://local/api/workbench/run-requests", {
      method: "POST",
      headers: { authorization: "Bearer control-secret", "content-type": "application/json",
        "idempotency-key": "auto-retry-once" },
      body: JSON.stringify(selection),
    }));
    assert.equal(response.status, 202);
    const id = (await response.json()).request.id;
    let request;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      request = (await (await app.handler(new Request(`http://local/api/workbench/run-requests/${id}`, {
        headers: { authorization: "Bearer control-secret" },
      }))).json()).request;
      if (["COMPLETED", "FAILED"].includes(request.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(request.status, "COMPLETED");
    const retried = request.items.find((item) => item.contestant_ref === "test-double-a");
    assert.equal(retried.attempt, 2);
    const attempts = app.store.listTrialAttemptResults(retried.trial_id);
    assert.deepEqual(attempts.map((item) => item.status), ["FAILED", "COMPLETED"]);
    assert.equal(attempts[0].final_state.failure_classification.category, "RATE_LIMIT");
    assert.equal(app.ledger.entries().some((item) => item.action === "trial.infrastructure_retry_scheduled"), true);
    const health = await (await app.handler(new Request("http://local/api/workbench/operations-health", {
      headers: { authorization: "Bearer control-secret" },
    }))).json();
    assert.equal(health.failure_categories.RATE_LIMIT, 1);
    assert.equal(health.retry_history.retried_trials, 1);
  } finally { app.close(); }
});

test("容量演练独立留痕请求并发与实际并发且绝不计入正式成绩", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-capacity-rehearsal-"));
  const app = createApp({ databasePath: path.join(root, "control.sqlite"),
    privateLabelDatabasePath: path.join(root, "private.sqlite"), runtimeRoot: root, apiToken: "control-secret" });
  try {
    const capacitySource = structuredClone(manifest);
    capacitySource.name = "容量演练冻结源";
    capacitySource.case_refs = [manifest.case_refs[0]];
    capacitySource.case_partitions = { public: capacitySource.case_refs, hidden: [], safety: [], regression: [] };
    capacitySource.environment_seeds = [manifest.environment_seeds[0]];
    capacitySource.capacity_policy = { ...capacitySource.capacity_policy, runner_workers: 8, twin_slots: 8 };
    const source = app.store.createExperiment(capacitySource, "capacity-source", { scheduleTrials: false }).experiment;
    const response = await app.handler(new Request("http://local/api/workbench/run-requests", {
      method: "POST", headers: { authorization: "Bearer control-secret", "content-type": "application/json",
        "idempotency-key": "capacity-rehearsal-4x" },
      body: JSON.stringify({ request_kind: "NEW_EVALUATION", evaluation_purpose: "PAIRED_COMPARISON",
        mode: "CAPACITY_REHEARSAL", requested_concurrency: 4, source_experiment_id: source.id,
        case_refs: capacitySource.case_refs, contestant_refs: capacitySource.contestants.map((item) => item.ref),
        environment_seeds: capacitySource.environment_seeds, repetitions: 1,
        requested_by: "capacity-test", reason: "验证容量演练不会冒充正式成绩" }),
    }));
    const responsePayload = await response.json();
    assert.equal(response.status, 202, JSON.stringify(responsePayload));
    const created = responsePayload.request;
    assert.equal(created.preflight.mode, "CAPACITY_REHEARSAL");
    assert.equal(created.preflight.affects_official_score, false);
    assert.equal(created.preflight.budget.requested_concurrency, 4);
    assert.equal(created.preflight.budget.effective_concurrency, 4);
    let request;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      request = (await (await app.handler(new Request(`http://local/api/workbench/run-requests/${created.id}`, {
        headers: { authorization: "Bearer control-secret" } }))).json()).request;
      if (["COMPLETED", "FAILED"].includes(request.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(request.status, "COMPLETED");
    const experiment = app.store.getExperiment(request.created_experiment_id);
    assert.equal(experiment.manifest.evaluation_mode, "CAPACITY_REHEARSAL");
    assert.equal(experiment.manifest.capacity_policy.runner_workers, 4);
    assert.equal(app.store.listTrials(experiment.id).length, 2);
  } finally { app.close(); }
});

test("真实能力门禁失败后收口未开考Trial并关闭实验，不留下假运行中任务", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-api-failure-closure-"));
  const fatalAdapter = (id) => {
    const base = createTestDouble(id, "context-first");
    return { ...base, async execute() {
      const error = new Error("candidate product terminal isolation failure");
      error.haltQueue = true;
      throw error;
    } };
  };
  const app = createApp({
    databasePath: path.join(root, "control.sqlite"),
    privateLabelDatabasePath: path.join(root, "private.sqlite"),
    runtimeRoot: root,
    apiToken: "control-secret",
    bootstrapEngineeringTestDesign: true,
    engineeringAdapterOverrides: {
      "test-double-a:ENGINEERING_TEST": fatalAdapter("test-double-a"),
      "test-double-b:ENGINEERING_TEST": fatalAdapter("test-double-b"),
    },
  });
  try {
    const source = app.store.listExperiments().find((item) => item.manifest.run_class === "ENGINEERING_TEST");
    const response = await app.handler(new Request("http://local/api/workbench/run-requests", {
      method: "POST",
      headers: { authorization: "Bearer control-secret", "content-type": "application/json",
        "idempotency-key": "terminal-failure-closes-work" },
      body: JSON.stringify({ request_kind: "NEW_EVALUATION", evaluation_purpose: "PAIRED_COMPARISON",
        mode: "QUICK_VALIDATION", source_experiment_id: source.id, case_refs: source.manifest.case_refs,
        contestant_refs: source.manifest.contestants.map((item) => item.ref),
        environment_seeds: [source.manifest.environment_seeds[0]], repetitions: 1,
        requested_by: "failure-closure-test", reason: "验证能力门禁失败后的任务状态完整收口" }),
    }));
    assert.equal(response.status, 202);
    const id = (await response.json()).request.id;
    let request;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      request = (await (await app.handler(new Request(`http://local/api/workbench/run-requests/${id}`, {
        headers: { authorization: "Bearer control-secret" },
      }))).json()).request;
      if (request.status === "FAILED" && request.progress.completed === request.progress.total) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(request.status, "FAILED");
    assert.equal(request.progress.completed, request.progress.total);
    const trials = app.store.listTrials(request.created_experiment_id, { includeReplays: false });
    assert.equal(trials.some((trial) => trial.status === "FAILED"), true);
    assert.equal(trials.some((trial) => trial.status === "CANCELLED"), true);
    assert.equal(trials.some((trial) => ["QUEUED", "RUNNING"].includes(trial.status)), false);
    assert.equal(app.store.getExperiment(request.created_experiment_id).status, "FAILED");
    const experiments = await (await app.handler(new Request("http://local/api/workbench/experiments", {
      headers: { authorization: "Bearer control-secret" },
    }))).json();
    const experiment = experiments.items.find((item) => item.id === request.created_experiment_id);
    assert.equal(experiment.progress.completed, experiment.progress.total);
    assert.equal(experiment.progress.succeeded, 0);
    assert.equal(experiment.progress.failed, 1);
    assert.equal(experiment.progress.cancelled, experiment.progress.total - 1);
    assert.equal(experiment.average_score, null);
    const failureEvent = app.ledger.entries().find((item) => item.entity_id === id
      && item.action === "evaluation.request.failed");
    assert.equal(failureEvent.payload.cancelled_queued_trials > 0, true);
  } finally { app.close(); }
});
test("M3冻结设计可用于新建评测预检但不能绕过门禁直接启动480 Trial", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-api-m3-frozen-design-"));
  const app = createApp({ databasePath: path.join(root, "control.sqlite"), privateLabelDatabasePath: path.join(root, "private.sqlite"),
    runtimeRoot: root, apiToken: "control-secret", bootstrapM3Design: true, formalM3RunEnabled: false });
  try {
    const headers = { authorization: "Bearer control-secret" };
    const templates = await (await app.handler(new Request("http://local/api/workbench/run-templates", { headers }))).json();
    assert.equal(templates.items.length, 1);
    const frozen = templates.items[0];
    assert.equal(frozen.status, "FROZEN");
    assert.equal(frozen.case_refs.length, 80);
    assert.deepEqual(frozen.contestants.map((item) => item.ref).sort(), ["agent-harness-v2", "langgraph-v1"]);
    assert.equal(app.store.listTrials(frozen.id).length, 0);
    const detail = await (await app.handler(new Request(`http://local/api/workbench/experiments/${frozen.id}`, { headers }))).json();
    assert.equal(detail.experiment.planned_case_count, 80);
    assert.equal(detail.experiment.planned_trial_count, 480);
    assert.deepEqual(detail.experiment.partition_counts, { PUB: 20, HID: 20, SAFE: 20, REG: 20 });
    const blocked = await app.handler(new Request(`http://local/api/experiments/${frozen.id}/run`, { method: "POST", headers }));
    assert.equal(blocked.status, 423);
    const preflight = await app.handler(new Request("http://local/api/workbench/run-requests/preflight", { method: "POST",
      headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ request_kind: "NEW_EVALUATION",
        evaluation_purpose: "PAIRED_COMPARISON", mode: "QUICK_VALIDATION", source_experiment_id: frozen.id,
        case_refs: ["M3-PUB-001@3.0.0"], contestant_refs: ["agent-harness-v2", "langgraph-v1"], repetitions: 1,
        requested_by: "api-test-operator", reason: "验证冻结设计可以生成预检但不会误启动正式评测" }) }));
    assert.equal(preflight.status, 200);
    const preflightBody = (await preflight.json()).preflight;
    assert.equal(preflightBody.total_trials, 6);
    assert.equal(preflightBody.affects_official_score, false);
    assert.equal(preflightBody.blockers.some((item) => item.includes("Manifest 8.0")), false);
    assert.equal(preflightBody.blockers.some((item) => item.includes("参评适配器未就绪")), true);
    assert.deepEqual(preflightBody.budget.per_contestant["agent-harness-v2"].candidate_public_maximum,
      formalM3Manifest.candidate_resource_contract.profiles
        .find((item) => item.contestant_ref === "agent-harness-v2").candidate_resources);
  } finally { app.close(); }
});

test("M3冻结合同变更会新增可审计设计而不会覆盖历史或阻塞服务启动", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-api-m3-design-upgrade-"));
  const databasePath = path.join(root, "control.sqlite");
  const privateLabelDatabasePath = path.join(root, "private.sqlite");
  const original = JSON.parse(readFileSync(path.join(ROOT, "config", "m3-formal-agent-capability.manifest.json"), "utf8"));
  const revised = structuredClone(original);
  revised.frozen_dependencies.scope_policy = {
    ...revised.frozen_dependencies.scope_policy,
    ref: "evalos-scope-policy:2.0.1",
  };
  const first = createApp({ databasePath, privateLabelDatabasePath, runtimeRoot: root,
    bootstrapM3Design: true, m3DesignManifest: original });
  first.close();
  const second = createApp({ databasePath, privateLabelDatabasePath, runtimeRoot: root,
    bootstrapM3Design: true, m3DesignManifest: revised });
  try {
    const designs = second.store.listExperiments();
    assert.equal(designs.length, 2);
    assert.equal(new Set(designs.map((item) => item.manifest_hash)).size, 2);
    assert.equal(designs.every((item) => second.store.listTrials(item.id).length === 0), true);
  } finally { second.close(); }
});

test("多Seed新建评测会生成并绑定每个Seed下的独立Trial", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-api-multiseed-"));
  const app = createApp({
    databasePath: path.join(root, "control.sqlite"),
    privateLabelDatabasePath: path.join(root, "private", "labels.sqlite"),
    runtimeRoot: root,
    artifactsRoot: root,
    m2ArtifactsRoot: root,
    m2ExecutorArtifactsRoot: root,
    m2AgentArtifactsRoot: root,
    m2QualificationArtifactsRoot: root,
    apiToken: "admin-secret",
    bootstrapEngineeringTestDesign: true,
  });
  try {
    const source = app.store.listExperiments().find((item) => item.manifest.run_class === "ENGINEERING_TEST");
    assert.ok(source);
    const selection = {
      request_kind: "NEW_EVALUATION",
      evaluation_purpose: "PAIRED_COMPARISON",
      mode: "QUICK_VALIDATION",
      source_experiment_id: source.id,
      case_refs: [manifest.case_refs[0]],
      contestant_refs: manifest.contestants.map((item) => item.ref),
      environment_seeds: [20260813, 20260814],
      repetitions: 1,
      requested_by: "seed-regression-test",
      reason: "验证不同Seed不会被数据库误判为重复Trial",
    };
    const preflightResponse = await app.handler(new Request("http://local/api/workbench/run-requests/preflight", {
      method: "POST",
      headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
      body: JSON.stringify(selection),
    }));
    assert.equal(preflightResponse.status, 200);
    assert.equal((await preflightResponse.json()).preflight.total_trials, 4);

    const createResponse = await app.handler(new Request("http://local/api/workbench/run-requests", {
      method: "POST",
      headers: { authorization: "Bearer admin-secret", "content-type": "application/json",
        "idempotency-key": "multi-seed-request" },
      body: JSON.stringify(selection),
    }));
    assert.equal(createResponse.status, 202);
    const requestId = (await createResponse.json()).request.id;
    let evaluationRequest;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      evaluationRequest = (await (await app.handler(new Request(`http://local/api/workbench/run-requests/${requestId}`, {
        headers: { authorization: "Bearer admin-secret" },
      }))).json()).request;
      if (["COMPLETED", "FAILED"].includes(evaluationRequest.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(evaluationRequest.status, "COMPLETED");
    assert.equal(evaluationRequest.progress.total, 4);
    assert.equal(evaluationRequest.progress.completed, 4);
    assert.deepEqual([...new Set(evaluationRequest.items.map((item) => item.environment_seed))].sort(), [20260813, 20260814]);
    assert.equal(evaluationRequest.items.every((item) => item.trial_id), true);
  } finally { app.close(); }
});

test("失败Trial汇总使用不可变attempt中的真实用量而不是误报未知", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-failed-attempt-usage-"));
  const app = createApp({
    databasePath: path.join(root, "control.sqlite"),
    privateLabelDatabasePath: path.join(root, "private", "labels.sqlite"),
    runtimeRoot: root,
    apiToken: "admin-secret",
    bootstrapEngineeringTestDesign: true,
  });
  try {
    const source = app.store.listExperiments().find((item) => item.manifest.run_class === "ENGINEERING_TEST");
    const caseRef = source.manifest.case_refs[0];
    const contestant = source.manifest.contestants[0];
    const selection = { request_kind: "NEW_EVALUATION", evaluation_purpose: "SINGLE_SYSTEM_REGRESSION",
      case_refs: [caseRef], contestant_refs: [contestant.ref], environment_seeds: [20260813], repetitions: 1 };
    const createdRequest = app.store.createEvaluationRunRequest({ idempotencyKey: "failed-attempt-usage",
      mode: "QUICK_VALIDATION", sourceExperimentId: source.id, requestedBy: "api-test-operator",
      reason: "验证失败Trial仍从不可变attempt展示真实用量", selection, preflight: {} }).request;
    app.store.startEvaluationRunRequest(createdRequest.id);
    const runManifest = structuredClone(source.manifest);
    runManifest.name = "失败Trial用量汇总回归";
    runManifest.design = "single_system_acceptance";
    runManifest.case_refs = [caseRef];
    runManifest.case_partitions = { public: [caseRef], hidden: [], safety: [], regression: [] };
    runManifest.environment_seeds = [20260813];
    runManifest.replicates_per_seed = 1;
    runManifest.contestants = [contestant];
    const experiment = app.store.createExperiment(runManifest, "failed-attempt-usage-experiment").experiment;
    app.store.bindEvaluationRunExperiment(createdRequest.id, experiment.id);
    const trial = app.store.listTrials(experiment.id)[0];
    const usage = { input_tokens: 79561, output_tokens: 12982, model_calls: 10, tool_calls: 24,
      wallclock_ms: 277100, compute_ms: 0, storage_bytes: 45945, cost_usd: 1.139239,
      measurement: { source: "candidate_public_api", observed_dimensions: ["input_tokens", "output_tokens",
        "model_calls", "tool_calls", "storage_bytes", "cost_usd"], unavailable_dimensions: ["compute_ms"],
        platform_wallclock_observed: true, complete: true } };
    app.store.failTrial(trial.id, "budget exceeded for cost_usd: 1.139239/1", { usage,
      finalState: { failure_classification: { category: "BUDGET_EXCEEDED" }, reset: { ok: true, clean: true } },
      traceHash: "failed-attempt-trace" });
    app.store.finishEvaluationRunRequest(createdRequest.id, "FAILED");

    const response = await app.handler(new Request(`http://local/api/workbench/run-requests/${createdRequest.id}`, {
      headers: { authorization: "Bearer admin-secret" },
    }));
    const request = (await response.json()).request;
    assert.equal(request.items[0].current.cost_usd, 1.139239);
    assert.equal(request.items[0].current.tool_calls, 24);
    assert.equal(request.items[0].current.usage_measurement.complete, true);
    assert.equal(request.decision_report.evidence_quality.usage_incomplete_trials, 0);
  } finally { app.close(); }
});

test("可选专家管理必须启用管理员Token且不会获得排名权", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-api-reviewer-"));
  const app = createApp({ databasePath: path.join(root, "control.sqlite"), privateLabelDatabasePath: path.join(root, "private.sqlite"),
    runtimeRoot: root, apiToken: "control-secret" });
  try {
    const response = await app.handler(new Request("http://local/api/reviewers", { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer control-secret" }, body: JSON.stringify({
        id: "expert-a", display_name: "专家A", role: "5g-domain-expert", qualification_ref: "5G-core-10y",
        verified_by: "eval-admin", credential: "expert-a-secret",
      }) }));
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.reviewer.qualification_ref, "5G-core-10y");
    assert.equal(JSON.stringify(body).includes("expert-a-secret"), false);
    const health = await (await app.handler(new Request("http://local/api/measurement/health"))).json();
    assert.equal(health.official_score_source, "deterministic_code_grader");
    assert.equal(health.model_judges, "advisory_only");
    assert.equal(health.expert_review.optional, true);
    assert.equal(health.expert_review.blocking, false);
    assert.equal(health.expert_review.ranking_authority, false);
  } finally { app.close(); }
});

test("服务入口支持独立私有标签库", () => {
  const source = readFileSync(path.join(ROOT, "services/control-api/src/server.mjs"), "utf8");
  assert.match(source, /EVALOS_DATABASE_PATH/);
  assert.match(source, /EVALOS_PRIVATE_LABEL_DATABASE_PATH/);
  assert.match(source, /EVALOS_RUNTIME_ROOT/);
});
