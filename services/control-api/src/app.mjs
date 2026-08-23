import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CASES, M2_CASES, M3_CASES, CandidateRelayBroker, DeterministicGradingService, EvalStore, EvaluationLedger, FrozenApprovalOracle, PrivateLabelStore, TrialRunner,
  auditableGraderRunView, blindExperimentView, blindGraderRunView, blindTraceView, blindTrialView,
  expertCalibrationFromConsensusSamples, createEvalRegistry, createCaseEnvironment, createTestDouble,
  evaluationDecisionReport, evaluationEvidenceTraceView, explainTraceRecord, TRACE_FILTERS, readSnapshotFile, sha256,
} from "../../../packages/kernel/src/index.mjs";
import {
  BLIND_JUDGE_VERSION, CASE_INVESTIGATOR_RUNTIME, createAgentHarnessProductConnector, createCandidateAdapterV4,
  createCaseInvestigator, createLangGraphProductConnector, judgeRecordAndSummarize,
} from "../../../packages/agent-runtime/src/index.mjs";
import { ExternalProductTwinEnvironment, ProtocolTwinEnvironment, SshTwinClient,
  SshTwinManagerClient, managedTwinTrialId } from "../../../packages/twin-runtime/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ANALYSIS_BUDGET = Object.freeze({ wallclock_ms: 300000, cost_usd: 2, max_turns: 32, max_tool_calls: 24 });

const CANDIDATE_RELAY_PATHS = Object.freeze({
  "agent-harness-v2": [
    "^/v2/auth/me$", "^/v2/evaluation/controlled-remediation-contract$", "^/v2/investigation-runtime$",
    "^/v2/protocol-lab$",
    "^/v2/remediation/context$", "^/v2/remediation/mode$", "^/v2/investigation-candidates$",
    "^/v2/investigations/[A-Za-z0-9_-]+$", "^/v2/investigations/[A-Za-z0-9_-]+/execution-log(?:\\?.*)?$",
    "^/v2/actions(?:\\?.*)?$", "^/v2/evaluation/actions/[A-Za-z0-9_-]+$", "^/v2/actions/[A-Za-z0-9_-]+/approval$",
  ],
  "langgraph-v1": [
    "^/api/v1/me$", "^/health/ready$", "^/api/v1/automation/overview$", "^/api/v1/automation/mode$",
    "^/api/v1/candidates$", "^/api/v1/investigations/[A-Za-z0-9_-]+$",
    "^/api/v1/investigations/[A-Za-z0-9_-]+/journal(?:\\?.*)?$",
    "^/api/v1/investigations/[A-Za-z0-9_-]+/product-e2e$", "^/api/v1/investigations/[A-Za-z0-9_-]+/approvals$",
  ],
});

function json(response, status = 200, headers = {}) {
  return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

function publicTrial(trial) {
  return blindTrialView(trial);
}

const NON_MEANINGFUL_PROGRESS_EVENTS = new Set(["runner.heartbeat", "candidate.poll.heartbeat", "candidate.progress.checkpoint", "budget.check"]);

function isMeaningfulProgressRecord(item) {
  if (NON_MEANINGFUL_PROGRESS_EVENTS.has(String(item?.name))) return false;
  if (item?.name !== "candidate.raw_event") return true;
  const publicEventType = String(item?.payload?.payload?.event_type ?? "").toLowerCase();
  return !publicEventType.endsWith(".heartbeat") && publicEventType !== "heartbeat";
}

function parsedTime(value) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function trialLiveProgressView(trial, experiment, trace, nowMs = Date.now()) {
  const trialStatus = String(trial?.status ?? "UNKNOWN");
  const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]).has(trialStatus);
  const queued = trialStatus === "QUEUED";
  const startedAtMs = parsedTime(trial?.started_at);
  const endedAtMs = parsedTime(trial?.completed_at);
  const elapsedMs = startedAtMs === null ? 0 : Math.max(0, (endedAtMs ?? nowMs) - startedAtMs);
  const totalBudgetMs = Number(experiment?.manifest?.budget?.wallclock_ms);
  const budgetMs = Number.isFinite(totalBudgetMs) && totalBudgetMs > 0 ? totalBudgetMs : null;
  const records = Array.isArray(trace) ? trace : [];
  const latest = records.at(-1) ?? null;
  const latestMeaningful = [...records].reverse().find(isMeaningfulProgressRecord) ?? null;
  const latestAtMs = parsedTime(latest?.timestamp);
  const meaningfulAtMs = parsedTime(latestMeaningful?.timestamp);
  const activityAgeMs = latestAtMs === null ? null : Math.max(0, nowMs - latestAtMs);
  const meaningfulAgeMs = meaningfulAtMs === null ? null : Math.max(0, nowMs - meaningfulAtMs);
  const isRunning = trialStatus === "RUNNING";
  const stopping = isRunning && records.some((item) => item?.name === "candidate.run.quarantine_started");
  const liveness = terminal ? "TERMINAL" : queued ? "NOT_STARTED"
    : !isRunning ? "UNKNOWN" : activityAgeMs === null || activityAgeMs > 60000 ? "NO_HEARTBEAT" : "LIVE";
  const meaningfulSilenceMs = meaningfulAgeMs ?? elapsedMs;
  const progressState = terminal ? "TERMINAL"
    : queued ? "QUEUED"
    : !isRunning ? "WAITING"
    : stopping ? "STOPPING"
      : liveness === "NO_HEARTBEAT" || meaningfulSilenceMs > 600000 ? "STALLED"
      : meaningfulSilenceMs > 300000 ? "WAITING" : "ACTIVE";
  const checkpointMs = 900000;
  const nextCheckpointMs = terminal || startedAtMs === null ? null
    : Math.min(budgetMs ?? Number.POSITIVE_INFINITY, (Math.floor(elapsedMs / checkpointMs) + 1) * checkpointMs);
  const latestDisplay = latest ? explainTraceRecord(latest) : null;
  const meaningfulDisplay = latestMeaningful ? explainTraceRecord(latestMeaningful) : null;
  return {
    contract: "evalos-live-progress.1", observable: true, status: trialStatus,
    progress_state: progressState, liveness, started_at: trial?.started_at ?? null,
    elapsed_ms: elapsedMs, total_budget_ms: budgetMs,
    remaining_ms: budgetMs === null ? null : Math.max(0, budgetMs - elapsedMs),
    budget_ratio: budgetMs === null ? null : Math.min(1, elapsedMs / budgetMs),
    checkpoint_interval_ms: checkpointMs, next_checkpoint_ms: Number.isFinite(nextCheckpointMs) ? nextCheckpointMs : null,
    activity: { last_at: latest?.timestamp ?? null, age_ms: activityAgeMs,
      event_code: latest?.name ?? null, summary_zh: latestDisplay?.summary_zh ?? "尚未产生运行事件" },
    meaningful_progress: { last_at: latestMeaningful?.timestamp ?? null, age_ms: meaningfulAgeMs,
      event_code: latestMeaningful?.name ?? null, summary_zh: meaningfulDisplay?.summary_zh ?? "尚未产生实质进展" },
    counters: {
      trace_records: records.length,
      liveness_heartbeats: records.filter((item) => item.name === "candidate.poll.heartbeat").length,
      progress_checkpoints: records.filter((item) => item.name === "candidate.progress.checkpoint").length,
      tool_results: records.filter((item) => item.span_kind === "TOOL" && item.record_type === "SPAN_END").length,
      candidate_events: records.filter((item) =>
        (item.actor === "external-candidate" || item.name === "candidate.raw_event") && isMeaningfulProgressRecord(item)).length,
    },
    interpretation_zh: progressState === "QUEUED" ? "正在等待独立考场和安全隔离槽位；真实考生尚未开始作答，50分钟 Trial 预算也尚未计时。"
      : progressState === "ACTIVE" ? "真实考生在线，最近5分钟内有新的外显调查进展。"
      : progressState === "WAITING" ? "真实考生仍在线，但已超过5分钟没有新证据或动作；页面继续观察，不自动判失败。"
        : progressState === "STOPPING" ? "已发出安全停止，系统正在等待真实考生进入终态，随后复位考场并保留全部证据。"
        : progressState === "STALLED" ? "运行可能卡住：心跳中断，或已超过10分钟没有实质进展；需要保留证据并关注安全停止。"
          : "本次Trial已经进入终态，进展时间线作为只追加证据保留。",
  };
}

export function evaluationRunName(sourceName, mode) {
  const runLabel = mode === "QUICK_VALIDATION" ? "快速验证" : mode === "TARGETED_REGRESSION" ? "定向回归" : "正式评测";
  const baseName = String(sourceName).replace(/^(快速验证|定向回归|正式评测)\s*·\s*/u, "");
  return `${runLabel} · ${baseName}`;
}

export function createApp({
  databasePath = path.join(ROOT, "runtime", "evalos", "control.sqlite"),
  privateLabelDatabasePath = path.join(ROOT, "runtime", "evalos-private", "labels.sqlite"),
  runtimeRoot = path.join(ROOT, "runtime", "evalos"),
  artifactsRoot = path.join(ROOT, "artifacts", "m15"),
  m2ArtifactsRoot = path.join(ROOT, "artifacts", "m2"),
  m2ExecutorArtifactsRoot = path.join(ROOT, "artifacts", "m2-executor"),
  m2AgentArtifactsRoot = path.join(ROOT, "artifacts", "m2-agent"),
  m2QualificationArtifactsRoot = path.join(ROOT, "artifacts", "m2-qualification"),
  apiToken = process.env.EVALOS_API_TOKEN ?? null,
  allowedOrigin = process.env.EVALOS_ALLOWED_ORIGIN ?? "http://127.0.0.1:3000",
  caseInvestigator = null,
  bootstrapM3Design = false,
  bootstrapEngineeringTestDesign = false,
  m3DesignManifest = null,
  formalM3RunEnabled = process.env.EVALOS_M3_FORMAL_RUN_ENABLED === "1",
  candidateRelayConfig = null,
  engineeringAdapterOverrides = {},
  cleanupConnectorOverrides = {},
  twinManagerClientOverride = null,
} = {}) {
  const registry = createEvalRegistry({ m15Cases: CASES, m2Cases: M2_CASES, m3Cases: M3_CASES });
  const store = new EvalStore({ databasePath, runtimeRoot,
    migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m15.sql"),
    migrationPaths: [path.join(ROOT, "infra", "migrations", "sqlite", "002_m25_workbench.sql"),
      path.join(ROOT, "infra", "migrations", "sqlite", "003_m26_run_control.sql"),
      path.join(ROOT, "infra", "migrations", "sqlite", "004_m31_candidate_relay.sql"),
      path.join(ROOT, "infra", "migrations", "sqlite", "005_m31_seed_identity.sql"),
      path.join(ROOT, "infra", "migrations", "sqlite", "006_m31_trial_attempt_audit.sql"),
      path.join(ROOT, "infra", "migrations", "sqlite", "007_m32_run_resilience.sql"),
      path.join(ROOT, "infra", "migrations", "sqlite", "008_m32_cleanup_reconciliation.sql")] });
  const labels = new PrivateLabelStore({ databasePath: privateLabelDatabasePath,
    migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_private_labels.sql") });
  const privateLabelHash = labels.publishRegistry(registry);
  store.publishRegistry(registry, { privateLabelHash });
  store.registerGraderSpec({ id: "evalos-code-grader", version: "5.1.0", type: "code", status: "APPROVED",
    definition: { weights: "25/15/15/15/15/5/5/5", safety: "non-compensable-hard-gate",
      l2_environment_task: "non-compensable-hard-gate", evidence_resolution: "preserved-product-evidence-content" } });
  const gradingService = new DeterministicGradingService({ labelStore: labels,
    executionCaseResolver: (ref) => store.getExecutionCase(ref), graderRef: "evalos-code-grader@5.1.0" });
  const approvalOracle = new FrozenApprovalOracle({ labelStore: labels });
  const ledger = new EvaluationLedger(store);
  const loadRelayConfig = () => {
    if (candidateRelayConfig) return candidateRelayConfig;
    const relayConfigPath = process.env.EVALOS_CANDIDATE_RELAY_CONFIG;
    if (!relayConfigPath) return { candidates: {} };
    try { return JSON.parse(readFileSync(relayConfigPath, "utf8")); }
    catch { return { candidates: {} }; }
  };
  const relayConfig = loadRelayConfig();
  const relayCandidates = Object.fromEntries(Object.entries(relayConfig.candidates ?? {}).map(([ref, item]) => [ref, {
    ...item, allowed_paths: CANDIDATE_RELAY_PATHS[ref] ?? [],
  }]));
  const candidateRelay = new CandidateRelayBroker({ store, ledger, candidates: relayCandidates });
  const frozenM31Manifest = m3DesignManifest ?? JSON.parse(readFileSync(path.join(ROOT, "config", "m3-formal-agent-capability.manifest.json"), "utf8"));
  if (bootstrapM3Design) {
    const frozenManifest = frozenM31Manifest;
    // A frozen design is immutable. A release that intentionally changes any
    // part of the contract must create a new audited design instead of trying
    // to overwrite the previous idempotent record during process startup.
    const designKey = `m3-formal-agent-capability-design:${sha256(frozenManifest)}`;
    const frozen = store.createExperiment(frozenManifest, designKey, { scheduleTrials: false });
    if (frozen.created) ledger.append({ entityType: "experiment", entityId: frozen.experiment.id,
      action: "experiment.design_frozen", payload: { manifest_hash: frozen.experiment.manifest_hash,
        planned_trial_count: frozenManifest.case_refs.length * frozenManifest.environment_seeds.length * frozenManifest.contestants.length,
        execution_authorized: false } });
  }
  if (bootstrapEngineeringTestDesign) {
    const engineeringManifest = JSON.parse(readFileSync(path.join(ROOT, "config", "m15-smoke.manifest.json"), "utf8"));
    const designKey = `engineering-test-design:${sha256(engineeringManifest)}`;
    const frozen = store.createExperiment(engineeringManifest, designKey, { scheduleTrials: false });
    if (frozen.created) ledger.append({ entityType: "experiment", entityId: frozen.experiment.id,
      action: "experiment.engineering_test_design_registered", payload: {
        manifest_hash: frozen.experiment.manifest_hash,
        run_class: "ENGINEERING_TEST",
        candidate_kind: "TEST_DOUBLE",
        affects_official_score: false,
        execution_authorized: false,
      } });
  }
  for (const key of Object.keys(engineeringAdapterOverrides)) {
    if (!/^test-double-[ab]:ENGINEERING_TEST$/.test(key)) {
      throw new Error("adapter overrides are restricted to named ENGINEERING_TEST test doubles");
    }
  }  const adapters = {
    "test-double-a:ENGINEERING_TEST": createTestDouble("test-double-a", "context-first"),
    "test-double-b:ENGINEERING_TEST": createTestDouble("test-double-b", "metric-first"),
    ...engineeringAdapterOverrides,
  };  const frozenCandidate = (ref) => frozenM31Manifest.contestants.find((item) => item.ref === ref);
  const realCandidateConnectors = {};
  const connectorConfigs = [
    { ref: "agent-harness-v2", origin: process.env.EVALOS_AGENT_HARNESS_ORIGIN,
      token: process.env.EVALOS_AGENT_HARNESS_TOKEN, approvalToken: process.env.EVALOS_AGENT_HARNESS_APPROVAL_TOKEN,
      adminToken: process.env.EVALOS_AGENT_HARNESS_ADMIN_TOKEN, tenantId: process.env.EVALOS_AGENT_HARNESS_TENANT_ID,
      create: createAgentHarnessProductConnector },
    { ref: "langgraph-v1", origin: process.env.EVALOS_LANGGRAPH_ORIGIN,
      token: process.env.EVALOS_LANGGRAPH_TOKEN, approvalToken: process.env.EVALOS_LANGGRAPH_APPROVAL_TOKEN,
      adminToken: process.env.EVALOS_LANGGRAPH_ADMIN_TOKEN, tenantId: process.env.EVALOS_LANGGRAPH_TENANT_ID,
      create: createLangGraphProductConnector },
  ];
  for (const config of connectorConfigs) {
    const frozen = frozenCandidate(config.ref);
    const relayTransport = candidateRelay.hasCandidate(config.ref) ? candidateRelay.transport(config.ref) : null;
    const tenantId = config.tenantId ?? relayCandidates[config.ref]?.tenant_id;
    const directConfigured = config.origin && config.token && config.approvalToken && config.adminToken;
    if ((!directConfigured && !relayTransport) || !tenantId || !frozen) continue;
    const connector = config.create({ origin: config.origin, token: config.token,
      approvalToken: config.approvalToken, adminToken: config.adminToken, tenantId,
      requestTransport: relayTransport,
      declaredRuntimeLimits: relayCandidates[config.ref]?.evaluation_limits ?? null,
      attestation: { source_revision: frozen.source_revision, artifact_digest: frozen.artifact_digest } });
    const adapter = createCandidateAdapterV4({ id: config.ref, connector });
    realCandidateConnectors[config.ref] = connector;
    for (const lane of adapter.supportedEvaluationLanes) adapters[`${config.ref}:${lane}`] = adapter;
  }
  Object.assign(realCandidateConnectors, cleanupConnectorOverrides);
  const liveDeepSeekAvailable = Boolean(process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY);
  const adapterFor = (ref, lane) => adapters[`${ref}:${lane}`] ?? adapters[ref];
  const twinEnvironmentConfigured = Boolean(process.env.EVALOS_TWIN_HOST && process.env.EVALOS_TWIN_SSH_KEY && process.env.EVALOS_TWIN_KNOWN_HOSTS);
  const twinConfigured = Boolean(twinManagerClientOverride || twinEnvironmentConfigured);
  const twinClient = twinEnvironmentConfigured ? new SshTwinClient() : null;
  const twinManagerClient = twinManagerClientOverride ?? (twinConfigured ? new SshTwinManagerClient() : null);
  const runner = new TrialRunner({ store, ledger, adapters, gradingService, approvalOracle,
    environmentFactory: ({ caseSpec, trial }) => {
      if (caseSpec.source?.level !== "L2") return createCaseEnvironment(caseSpec);
      return realCandidateConnectors[trial.contestant_ref]
        ? new ExternalProductTwinEnvironment({ client: twinManagerClient, caseSpec, trial })
        : new ProtocolTwinEnvironment({ client: twinClient, caseSpec, trial });
    } });
  store.recoverInterruptedAnalyses();
  const investigator = caseInvestigator ?? (liveDeepSeekAvailable ? createCaseInvestigator({ store }) : null);

  const isAdmin = (request) => Boolean(apiToken && request.headers.get("authorization") === `Bearer ${apiToken}`);
  const readAcceptance = (root, file, fallback) => {
    try { return JSON.parse(readFileSync(path.join(root, file), "utf8")); }
    catch { return fallback; }
  };
  const safeSnapshot = (snapshot, { includeFiles = false } = {}) => snapshot ? {
    snapshot_ref: snapshot.snapshot_ref, contestant_ref: snapshot.contestant_ref, source_revision: snapshot.source_revision,
    artifact_digest: snapshot.artifact_digest, tree_hash: snapshot.tree_hash, file_count: snapshot.file_count,
    size_bytes: snapshot.size_bytes, created_at: snapshot.created_at,
    ...(includeFiles ? { files: snapshot.manifest?.files ?? [] } : {}),
  } : null;
  const auditTrial = (trial, experiment) => {
    if (!trial) return null;
    const publicView = publicTrial(trial);
    return { ...publicView, contestant: experiment?.status === "COMPLETED" ? trial.contestant_ref : trial.blind_id,
      identity_state: experiment?.status === "COMPLETED" ? "REVEALED_AFTER_CLOSE" : "BLINDED",
      budget: trial.budget, duration_ms: trial.started_at && trial.completed_at
        ? Math.max(0, new Date(trial.completed_at).getTime() - new Date(trial.started_at).getTime()) : null };
  };
  const attemptView = (attempt) => ({
    id: attempt.id, trial_id: attempt.trial_id, attempt: attempt.attempt, status: attempt.status, error: attempt.error,
    usage: attempt.usage, trace_hash: attempt.trace_hash, result_hash: attempt.result_hash,
    failure: attempt.final_state?.failure_classification ?? null,
    cleanup: {
      reset_ok: attempt.final_state?.reset?.ok ?? null,
      reset_clean: attempt.final_state?.reset?.clean ?? null,
      quarantine_required: attempt.final_state?.quarantine?.required === true,
      quarantine_released: attempt.final_state?.quarantine?.released ?? null,
      snapshot_error: attempt.final_state?.snapshot_error ?? null,
      reset_error: attempt.final_state?.reset_error ?? null,
    },
    created_at: attempt.created_at,
  });
  const cleanupNeedsReconciliation = (attempt) => Boolean(attempt && (
    attempt.final_state?.reset?.ok === false
    || attempt.final_state?.quarantine?.required === true && attempt.final_state?.quarantine?.released !== true
  ));
  const successfulCleanup = (trialId, attempt) => store.listTrialCleanupReconciliations(trialId)
    .find((item) => item.attempt === Number(attempt) && item.status === "RESOLVED") ?? null;
  const reconcileTrialCleanup = async (trialId) => {
    const trial = store.getTrial(trialId);
    if (!trial) throw new Error("trial not found");
    const attempt = store.listTrialAttemptResults(trialId).at(-1);
    if (!cleanupNeedsReconciliation(attempt)) return { status: "NOT_REQUIRED", trial_id: trialId };
    const existing = successfulCleanup(trialId, attempt.attempt);
    if (existing) return existing;
    const runRef = attempt.final_state?.quarantine?.candidate_run_ref;
    if (!runRef) throw new Error("cleanup reconciliation is missing the exact candidate run reference");
    const connector = realCandidateConnectors[trial.contestant_ref];
    if (!connector || typeof connector.probeRun !== "function") throw new Error("candidate cleanup probe is not configured");
    if (!twinManagerClient) throw new Error("Twin manager is not configured for cleanup reconciliation");
    const candidate = await connector.probeRun({ runRef });
    if (candidate.terminal !== true) {
      const error = new Error("真实考生仍在运行，考场继续隔离；平台不会提前复位或交给下一场评测");
      error.code = "CLEANUP_NOT_READY";
      throw error;
    }
    let reset;
    try {
      reset = await twinManagerClient.invoke({ operation: "reset", contestant_ref: trial.contestant_ref,
        trial_id: managedTwinTrialId(trial.contestant_ref, trial.id) });
    } catch (error) {
      reset = { ok: false, clean: false, error: error?.message ?? String(error) };
    }
    const resolved = reset?.ok === true && reset?.clean === true;
    const reconciliation = store.recordTrialCleanupReconciliation({ trialId, attempt: attempt.attempt,
      candidateRunRef: runRef, candidateTerminalStatus: candidate.status, twinReset: reset,
      status: resolved ? "RESOLVED" : "FAILED", error: resolved ? null : reset?.error ?? "Twin reset did not prove a clean baseline",
      evidence: { contract: "evalos-cleanup-reconciliation.1", candidate_probe: candidate,
        managed_twin_trial_id: managedTwinTrialId(trial.contestant_ref, trial.id), original_attempt_result_hash: attempt.result_hash } });
    ledger.append({ entityType: "trial", entityId: trialId,
      action: resolved ? "trial.cleanup_reconciled" : "trial.cleanup_reconciliation_failed",
      payload: { reconciliation_id: reconciliation.id, record_hash: reconciliation.record_hash,
        attempt: attempt.attempt, candidate_run_ref: runRef, candidate_terminal_status: candidate.status,
        twin_reset: reset } });
    if (!resolved) throw new Error(`考场复位仍未通过：${reconciliation.error}`);
    return reconciliation;
  };
  let cleanupReconciliationRunning = false;
  const reconcilePendingCleanups = async () => {
    if (cleanupReconciliationRunning || !twinConfigured) return;
    cleanupReconciliationRunning = true;
    try {
      for (const trial of store.listTrials(null, { includeReplays: false })) {
        const attempt = store.listTrialAttemptResults(trial.id).at(-1);
        if (!cleanupNeedsReconciliation(attempt) || successfulCleanup(trial.id, attempt.attempt)) continue;
        try { await reconcileTrialCleanup(trial.id); }
        catch (error) { if (error?.code !== "CLEANUP_NOT_READY") console.error("cleanup reconciliation failed", trial.id, error); }
      }
    } finally { cleanupReconciliationRunning = false; }
  };
  const gradeFor = (trialId) => store.listGraderRuns(trialId).find((item) => item.dimension === "overall") ?? null;
  const evaluationMode = (experiment) => experiment?.manifest?.evaluation_mode ?? "FORMAL";
  const workbenchExperiments = () => store.listExperiments().map((experiment) => {
    const summary = store.experimentSummary(experiment.id);
    const trials = store.listTrials(experiment.id, { includeReplays: false });
    const frozenDesign = trials.length === 0 && (experiment.manifest.evaluation_mode === "FORMAL"
      || experiment.manifest.run_class === "ENGINEERING_TEST");
    const plannedCaseRefs = experiment.manifest.case_refs ?? [];
    const plannedContestants = experiment.manifest.contestants ?? [];
    const plannedSeeds = experiment.manifest.environment_seeds ?? [];
    const plannedReplicates = Number(experiment.manifest.replicates_per_seed ?? 1);
    const partitionCounts = Object.fromEntries(["PUB", "HID", "SAFE", "REG"].map((partition) =>
      [partition, plannedCaseRefs.filter((caseRef) => caseRef.startsWith(`M3-${partition}-`)).length]));
    return { id: experiment.id, name: experiment.name, status: frozenDesign ? "FROZEN" : experiment.status, design: experiment.manifest.design,
      manifest_version: experiment.manifest.manifest_version,
      run_class: experiment.manifest.run_class, evaluation_lane: experiment.manifest.evaluation_lane,
      operating_modes: experiment.manifest.operating_modes, execution_mode: experiment.manifest.execution_mode,
      evaluation_mode: evaluationMode(experiment), affects_official_score: evaluationMode(experiment) === "FORMAL",
      frozen_design: frozenDesign, planned_case_count: plannedCaseRefs.length,
      planned_contestant_count: plannedContestants.length,
      planned_trial_count: plannedCaseRefs.length * plannedContestants.length * plannedSeeds.length * plannedReplicates,
      partition_counts: partitionCounts,
      dataset_ref: experiment.dataset_ref, suite_ref: experiment.suite_ref, manifest_hash: experiment.manifest_hash,
      model: experiment.manifest.model ?? null, contestants: experiment.status === "COMPLETED"
        ? experiment.manifest.contestants?.map(({ ref, kind, architecture, adapter_version, source_revision, artifact_digest }) =>
          ({ ref, kind, architecture, adapter_version, source_revision, artifact_digest }))
        : store.listBlinds(experiment.id).map(({ blind_id }) => ({ ref: blind_id, kind: "BLINDED" })),
      progress: { completed: summary.terminal_trials, succeeded: summary.completed_trials,
        failed: summary.failed_trials, cancelled: summary.cancelled_trials, total: summary.trial_count,
        rate: summary.completion_rate }, average_score: summary.average_score,
      analyses: trials.reduce((sum, trial) => sum + store.listAnalysisRuns(trial.id).length, 0),
      created_at: experiment.created_at, started_at: experiment.started_at, completed_at: experiment.completed_at };
  });
  const workbenchCases = () => store.listCases().map((item) => {
    const trials = store.listTrials(null, { includeReplays: false }).filter((trial) => trial.case_ref === item.case_ref);
    const scores = trials.map((trial) => Number(gradeFor(trial.id)?.result?.total)).filter(Number.isFinite);
    const grades = trials.map((trial) => gradeFor(trial.id)?.result).filter(Boolean);
    const compatible = store.listExperiments().find((experiment) => {
      const suite = store.listSuites().find((candidate) => candidate.suite_ref === experiment.suite_ref);
      return experiment.dataset_ref === item.dataset_ref && suite?.definition?.case_refs?.includes(item.case_ref);
    });
    const latest = [...trials].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).at(-1) ?? null;
    return { case_ref: item.case_ref, case_id: item.case_id, version: item.version, dataset_ref: item.dataset_ref,
      goal: item.public.goal, scope: item.public.visible?.scope ?? null,
      operating_mode: item.public.visible?.operating_mode ?? null,
      operating_mode_label: item.public.visible?.operating_mode_label ?? null, metadata: item.metadata,
      level: item.metadata?.level ?? store.listDatasets().find((dataset) => dataset.dataset_ref === item.dataset_ref)?.level,
      trial_count: trials.length, completed_trials: trials.filter((trial) => trial.status === "COMPLETED").length,
      average_score: scores.length ? Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(2)) : null,
      pass_rate: grades.length ? grades.filter((grade) => grade.passed).length / grades.length : null,
      unstable: scores.length > 1 && Math.max(...scores) - Math.min(...scores) >= 15,
      safety_failed: grades.some((grade) => Object.entries(grade.hard_gates ?? {}).some(([name, passed]) => name.includes("safety") && !passed)),
      infrastructure_failed: trials.some((trial) => trial.status === "FAILED" && /infrastructure|lease|ssh|timeout|twin/i.test(trial.error ?? "")),
      latest_status: latest?.status ?? "NEVER_RUN", compatible_experiment_id: compatible?.id ?? null,
      latest_trial_id: trials.filter((trial) => trial.status === "COMPLETED").at(-1)?.id ?? null };
  });
  const workbenchTrials = () => {
    const attemptsByTrial = new Map();
    for (const attempt of store.listTrialAttemptResults().map(attemptView)) {
      const attempts = attemptsByTrial.get(attempt.trial_id) ?? [];
      attempts.push(attempt);
      attemptsByTrial.set(attempt.trial_id, attempts);
    }
    return store.listTrials(null, { includeReplays: false }).map((trial) => {
    const experiment = store.getExperiment(trial.experiment_id);
    const grade = gradeFor(trial.id);
    const trace = store.getTrace(trial.id);
    const snapshot = store.getTrialSourceSnapshot(trial.id);
    const attempts = attemptsByTrial.get(trial.id) ?? [];
    return {
      id: trial.id,
      experiment_id: trial.experiment_id,
      experiment_name: experiment?.name ?? trial.experiment_id,
      run_class: experiment?.manifest?.run_class ?? null,
      evaluation_lane: experiment?.manifest?.evaluation_lane ?? null,
      evaluation_mode: evaluationMode(experiment),
      affects_official_score: evaluationMode(experiment) === "FORMAL",
      candidate_kind: experiment?.manifest?.contestants?.find((item) => item.ref === trial.contestant_ref)?.kind ?? null,
      case_ref: trial.case_ref,
      contestant: experiment?.status === "COMPLETED" ? trial.contestant_ref : trial.blind_id,
      status: trial.status,
      duration_ms: trial.started_at && trial.completed_at
        ? Math.max(0, new Date(trial.completed_at).getTime() - new Date(trial.started_at).getTime()) : null,
      trace_records: trace.length,
      trace_actors: [...new Set(trace.map((item) => item.actor))],
      tool_results: trace.filter((item) => item.span_kind === "TOOL" && item.record_type === "SPAN_END").length,
      grade: grade ? auditableGraderRunView(grade).result : null,
      analysis_runs: store.listAnalysisRuns(trial.id).map((item) => ({
        id: item.id, status: item.status, mode: item.mode, created_at: item.created_at, completed_at: item.completed_at,
      })),
      source_snapshot: safeSnapshot(snapshot),
      attempts,
      latest_cleanup: attempts.at(-1)?.cleanup ?? null,
      completed_at: trial.completed_at,
    };
    });
  };

  const preflightEvaluation = async (body) => {
    const mode = body.mode ?? "QUICK_VALIDATION";
    if (!new Set(["QUICK_VALIDATION", "TARGETED_REGRESSION", "FORMAL"]).has(mode)) throw new Error("invalid evaluation run mode");
    const requestKind = body.request_kind;
    if (!new Set(["RERUN_FROZEN", "NEW_EVALUATION"]).has(requestKind)) throw new Error("必须明确选择按原配置重新评测或新建评测");
    const source = store.getExperiment(body.source_experiment_id);
    if (!source) throw new Error("source experiment is required");
    if (source.manifest.manifest_version !== "6.0") throw new Error("冻结参评配置属于旧版只读历史；M3.1 只执行 Manifest 6.0，请选择新版实验配置");
    const suite = store.listSuites().find((item) => item.suite_ref === source.suite_ref);
    const caseRefs = [...new Set(body.case_refs ?? [])];
    if (!caseRefs.length) throw new Error("at least one case is required");
    for (const caseRef of caseRefs) if (!suite?.definition?.case_refs?.includes(caseRef)) {
      throw new Error(`case ${caseRef} is outside the source experiment suite`);
    }
    const availableContestants = source.manifest.contestants ?? [];
    if (!Array.isArray(body.contestant_refs) || !body.contestant_refs.length) throw new Error("必须明确本次评测的参评考生，平台不会静默沿用或猜测");
    const requestedContestants = [...new Set(body.contestant_refs)];
    const contestants = requestedContestants.map((ref) => availableContestants.find((item) => item.ref === ref));
    if (!contestants.length || contestants.some((item) => !item)) throw new Error("所选参评考生不属于这份冻结参评配置");
    if (contestants.length > 2) throw new Error("一次评测最多选择两名参评考生");
    const allFrozenRefs = availableContestants.map((item) => item.ref).sort();
    if (requestKind === "RERUN_FROZEN" && JSON.stringify([...requestedContestants].sort()) !== JSON.stringify(allFrozenRefs)) {
      throw new Error("按原配置重新评测必须保留原实验冻结的全部参评考生；如需更换，请新建评测");
    }
    const evaluationPurpose = requestKind === "RERUN_FROZEN" ? "RERUN_FROZEN"
      : body.evaluation_purpose === "PAIRED_COMPARISON" ? "PAIRED_COMPARISON"
        : body.evaluation_purpose === "SINGLE_SYSTEM_REGRESSION" ? "SINGLE_SYSTEM_REGRESSION" : null;
    if (!evaluationPurpose) throw new Error("新建评测必须选择双系统公平对比或单系统回归");
    if (evaluationPurpose === "PAIRED_COMPARISON" && contestants.length !== 2) throw new Error("双系统公平对比必须包含两名冻结参评考生");
    if (evaluationPurpose === "SINGLE_SYSTEM_REGRESSION" && contestants.length !== 1) throw new Error("单系统回归只能包含一名参评考生");
    const repetitions = Number(body.repetitions ?? 1);
    if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("repetitions must be between 1 and 5");
    const environmentSeeds = [...new Set(body.environment_seeds ?? source.manifest.environment_seeds ?? [])];
    if (!environmentSeeds.length || environmentSeeds.some((seed) => !Number.isInteger(seed))) {
      throw new Error("本次评测必须冻结至少一个整数 Seed（环境随机种子）");
    }
    if (requestKind === "RERUN_FROZEN" &&
        JSON.stringify([...environmentSeeds].sort((a, b) => a - b)) !== JSON.stringify([...source.manifest.environment_seeds].sort((a, b) => a - b))) {
      throw new Error("按原配置重新评测必须保留原实验冻结的全部 Seed；如需更换，请新建评测");
    }
    if (mode === "FORMAL") {
      const fullSuite = [...(suite?.definition?.case_refs ?? [])].sort();
      if (JSON.stringify([...caseRefs].sort()) !== JSON.stringify(fullSuite)) throw new Error("formal evaluation must run the complete frozen suite");
      if (JSON.stringify([...requestedContestants].sort()) !== JSON.stringify(allFrozenRefs)) {
        throw new Error("formal evaluation must retain all frozen contestants");
      }
    }
    const selectedHistory = store.listTrials(source.id, { includeReplays: false }).filter((trial) => caseRefs.includes(trial.case_ref));
    const durations = selectedHistory.map((trial) => trial.started_at && trial.completed_at
      ? new Date(trial.completed_at).getTime() - new Date(trial.started_at).getTime() : NaN).filter(Number.isFinite);
    const perTrialDuration = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length
      : Number(source.manifest.budget?.wallclock_ms ?? 30000);
    const totalTrials = caseRefs.length * contestants.length * environmentSeeds.length * repetitions;
    const needsTwin = caseRefs.some((caseRef) => store.getExecutionCase(caseRef)?.source?.level === "L2");
    const missingAdapters = contestants.map((item) => item.ref).filter((ref) => !adapterFor(ref, source.manifest.evaluation_lane)
      || !adapterFor(ref, source.manifest.evaluation_lane).supportedEvaluationLanes?.includes(source.manifest.evaluation_lane));
    const runClassViolations = contestants.flatMap((item) => {
      if (source.manifest.run_class === "ENGINEERING_TEST" && item.kind !== "TEST_DOUBLE") {
        return [`工程测试实验只能使用明确标注的测试替身：${item.ref}`];
      }
      if (source.manifest.run_class === "REAL_CANDIDATE" && item.kind !== "REAL_PRODUCT") {
        return [`真实评测实验禁止使用测试替身或内部考生分身：${item.ref}`];
      }
      if (item.kind === "TEST_DOUBLE" && source.manifest.evaluation_lane !== "ENGINEERING_TEST") {
        return [`测试替身只能进入工程测试通道：${item.ref}`];
      }
      if (item.kind === "REAL_PRODUCT" && source.manifest.evaluation_lane === "ENGINEERING_TEST") {
        return [`真实产品不能伪装成工程测试替身：${item.ref}`];
      }
      return [];
    });
    const candidateChecks = await Promise.all(contestants.map(async (contestant) => {
      if (contestant.kind === "TEST_DOUBLE") {
        return { ref: contestant.ref, kind: "TEST_DOUBLE", ready: true, label: "工程测试替身（不进入真实成绩）",
          isolation: { safe_parallelism: Number(source.manifest.capacity_policy?.runner_workers ?? 1) } };
      }
      const adapter = adapterFor(contestant.ref, source.manifest.evaluation_lane);
      if (!adapter || typeof adapter.preflight !== "function") {
        return { ref: contestant.ref, kind: contestant.kind, ready: false,
          error: "真实产品连接器或开考检查未配置" };
      }
      try {
        return { ref: contestant.ref, kind: contestant.kind,
          ...(await adapter.preflight({ contestant, requiresTwin: needsTwin, budget: source.manifest.budget })) };
      } catch (error) {
        return { ref: contestant.ref, kind: contestant.kind, ready: false,
          error: String(error?.message ?? error) };
      }
    }));
    const failedCandidateChecks = candidateChecks.filter((item) => !item.ready);
    const requestedConcurrency = Math.max(1, Number(source.manifest.capacity_policy?.runner_workers ?? 1));
    const candidateParallelism = candidateChecks.length
      ? Math.min(...candidateChecks.map((item) => Number(item.isolation?.safe_parallelism ?? requestedConcurrency)))
      : 1;
    const twinParallelism = needsTwin ? Math.max(1, Number(source.manifest.capacity_policy?.twin_slots ?? 1)) : requestedConcurrency;
    const effectiveConcurrency = Math.max(1, Math.min(requestedConcurrency, candidateParallelism, twinParallelism));
    const blockers = [
      ...(missingAdapters.length ? [`参评适配器未就绪：${missingAdapters.join("、")}`] : []),
      ...runClassViolations,
      ...failedCandidateChecks.map((item) => `真实考生开考检查失败（${item.ref}）：${item.error ?? "产品未就绪或冻结指纹不一致"}`),
      ...(mode === "FORMAL" ? candidateChecks.filter((item) => item.kind === "REAL_PRODUCT" && item.budget?.aligned !== true)
        .map((item) => `正式评测预算合同未冻结或不一致（${item.ref}）：考生必须在 Trial 的 ${source.manifest.budget?.wallclock_ms ?? "未知"}ms 时间预算内自行终止`) : []),
      ...(needsTwin && !twinConfigured ? ["所选 L2 Case 需要数字孪生环境，但 Twin 尚未配置"] : []),
      ...(mode === "FORMAL" && effectiveConcurrency < requestedConcurrency
        ? [`正式评测并发资格未通过：冻结配置要求 ${requestedConcurrency} 并发，当前隔离环境只能安全支持 ${effectiveConcurrency} 并发`] : []),
      ...(mode === "FORMAL" && !formalM3RunEnabled ? ["M3 正式评测尚未放行：Adapter 资格、4/8 并发容量和商用产品通道门禁必须全部通过"] : []),
    ];
    return { contract: "evalos-preflight.3", ready: blockers.length === 0, blockers,
      request_kind: requestKind, evaluation_purpose: evaluationPurpose,
      mode, mode_label: mode === "QUICK_VALIDATION" ? "快速验证（Quick validation）" : mode === "TARGETED_REGRESSION"
        ? "定向回归（Targeted regression）" : "正式评测（Formal evaluation）",
      source_experiment_id: source.id, dataset_ref: source.dataset_ref, suite_ref: source.suite_ref,
      case_refs: caseRefs, contestant_refs: contestants.map((item) => item.ref), environment_seeds: environmentSeeds,
      contestants: contestants.map(({ ref, adapter_version, source_revision, artifact_digest }) =>
        ({ ref, adapter_version, source_revision, artifact_digest })), repetitions, total_trials: totalTrials,
      candidate_checks: candidateChecks,
      estimated_duration_ms: Math.round(perTrialDuration * totalTrials), estimated_cost_usd: null,
      cost_note: "模型单价未写入冻结合同，平台展示预算与真实用量，不伪造费用估算。",
      budget: { per_trial: source.manifest.budget, maximum_tool_calls: totalTrials * Number(source.manifest.budget?.tool_calls ?? 0),
        requested_concurrency: requestedConcurrency, effective_concurrency: effectiveConcurrency,
        isolation_note: effectiveConcurrency < requestedConcurrency
          ? "当前按安全隔离槽位降为串行/低并发执行；不会让不同工作模式共享同一租户并发切换。"
          : "每个并发任务均有冻结的隔离边界。" },
      readiness: { model_and_adapter: missingAdapters.length === 0,
        twin: !needsTwin || (twinConfigured && candidateChecks.filter((item) => item.kind === "REAL_PRODUCT")
          .every((item) => item.twin?.ready === true)),
        run_class_separation: runClassViolations.length === 0,
        external_candidate_api: failedCandidateChecks.length === 0,
        candidate_budget_alignment: candidateChecks.filter((item) => item.kind === "REAL_PRODUCT")
          .every((item) => item.budget?.aligned !== false),
        candidate_fingerprint: failedCandidateChecks.every((item) => !/drift/i.test(item.error ?? "")),
        approval_identity_separation: candidateChecks.filter((item) => item.kind === "REAL_PRODUCT")
          .every((item) => item.credentials?.identities_separated === true),
        candidate_least_privilege: candidateChecks.filter((item) => item.kind === "REAL_PRODUCT")
          .every((item) => item.credentials?.least_privilege === true),
        candidate_tenant_isolation: candidateChecks.filter((item) => item.kind === "REAL_PRODUCT")
          .every((item) => item.isolation?.tenant_bound === true),
        formal_release_gate: mode !== "FORMAL" || formalM3RunEnabled,
        isolated_namespace: true, environment_reset: true, deterministic_grader: true },
      affects_official_score: mode === "FORMAL",
      score_notice: mode === "FORMAL" ? "本次是完整冻结套件，完成后可进入正式成绩口径。" : "本次是诊断/回归实验，不会改变或覆盖正式成绩。",
    };
  };

  const decisionReportCache = new Map();
  const cachedDecisionReport = (key, factory) => {
    if (decisionReportCache.has(key)) return decisionReportCache.get(key);
    const value = factory();
    decisionReportCache.set(key, value);
    if (decisionReportCache.size > 256) decisionReportCache.delete(decisionReportCache.keys().next().value);
    return value;
  };
  const runRequestView = (request) => {
    if (!request) return null;
    const measuredValue = (trial, name) => {
      if (!trial?.usage || !Object.prototype.hasOwnProperty.call(trial.usage, name)) return null;
      const value = Number(trial.usage[name]);
      return Number.isFinite(value) ? value : null;
    };
    const measurementView = (trial) => {
      if (!trial) return null;
      return trial.usage?.measurement ?? {
        source: "candidate_not_reported",
        observed_dimensions: [],
        unavailable_dimensions: ["input_tokens", "output_tokens", "model_calls", "tool_calls", "compute_ms", "storage_bytes", "cost_usd"],
        platform_wallclock_observed: measuredValue(trial, "wallclock_ms") !== null,
        complete: false,
      };
    };
    const latestAttemptByTrial = new Map();
    for (const attempt of store.listTrialAttemptResults().map(attemptView)) latestAttemptByTrial.set(attempt.trial_id, attempt);
    const latestAttempt = (trial) => trial ? latestAttemptByTrial.get(trial.id) ?? null : null;
    const itemViews = request.items.map((item) => {
      const currentGrade = item.trial_id ? gradeFor(item.trial_id)?.result ?? null : null;
      const baselineTrial = item.source_trial_id ? store.getTrial(item.source_trial_id) : null;
      const baselineGrade = baselineTrial ? gradeFor(baselineTrial.id)?.result ?? null : null;
      const baselineAttempt = latestAttempt(baselineTrial);
      const currentAttempt = latestAttempt(item.trial);
      const duration = (trial) => trial?.started_at && trial?.completed_at
        ? new Date(trial.completed_at).getTime() - new Date(trial.started_at).getTime() : null;
      return { id: item.id, case_ref: item.case_ref, contestant_ref: item.contestant_ref,
        environment_seed: item.environment_seed, repeat_index: item.repeat_index,
        source_trial_id: item.source_trial_id, trial_id: item.trial_id, status: item.trial?.status ?? request.status,
        attempt: item.trial?.attempt ?? null, failure: currentAttempt?.failure ?? null,
        trace_hash: currentAttempt?.trace_hash ?? null, cleanup: currentAttempt?.cleanup ?? null,
        baseline: baselineTrial ? { score: baselineGrade?.total ?? null, passed: baselineGrade?.passed ?? null,
          duration_ms: duration(baselineTrial), tool_calls: measuredValue(baselineTrial, "tool_calls"),
          cost_usd: measuredValue(baselineTrial, "cost_usd"), usage_measurement: measurementView(baselineTrial),
          failure: baselineAttempt?.failure ?? null,
          hard_gates_passed: Object.values(baselineGrade?.hard_gates ?? {}).filter(Boolean).length,
          hard_gates_total: Object.keys(baselineGrade?.hard_gates ?? {}).length } : null,
        current: item.trial ? { score: currentGrade?.total ?? null, passed: currentGrade?.passed ?? null,
          duration_ms: duration(item.trial), tool_calls: measuredValue(item.trial, "tool_calls"),
          cost_usd: measuredValue(item.trial, "cost_usd"), usage_measurement: measurementView(item.trial),
          hard_gates_passed: Object.values(currentGrade?.hard_gates ?? {}).filter(Boolean).length,
          hard_gates_total: Object.keys(currentGrade?.hard_gates ?? {}).length, error: item.trial.error } : null };
    });
    const caseSummaries = request.selection.case_refs.map((caseRef) => {
      const caseItems = itemViews.filter((item) => item.case_ref === caseRef);
      const baselineScores = caseItems.map((item) => Number(item.baseline?.score)).filter(Number.isFinite);
      const currentScores = caseItems.map((item) => Number(item.current?.score)).filter(Number.isFinite);
      return { case_ref: caseRef, trials: caseItems.length,
        baseline_stability_range: baselineScores.length > 1 ? Number((Math.max(...baselineScores) - Math.min(...baselineScores)).toFixed(2)) : null,
        current_stability_range: currentScores.length > 1 ? Number((Math.max(...currentScores) - Math.min(...currentScores)).toFixed(2)) : null,
        current_pass_rate: currentScores.length ? caseItems.filter((item) => item.current?.passed).length / currentScores.length : null };
    });
    const statisticsPolicy = store.getExperiment(request.created_experiment_id ?? request.source_experiment_id)
      ?.manifest?.statistics_policy ?? {};
    const reportKey = sha256({ request_id: request.id, request_status: request.status,
      item_state: itemViews.map((item) => ({ id: item.id, status: item.status, attempt: item.attempt,
        score: item.current?.score ?? null, passed: item.current?.passed ?? null, failure: item.failure,
        trace_hash: item.trace_hash, cleanup: item.cleanup, usage_complete: item.current?.usage_measurement?.complete ?? null })),
      statistics_policy: statisticsPolicy });
    const decisionReport = cachedDecisionReport(reportKey, () => evaluationDecisionReport({
      requestStatus: request.status, mode: request.mode, items: itemViews,
      contestantOrder: request.selection.contestant_refs, repetitions: request.selection.repetitions,
      confidence: Number(statisticsPolicy.confidence_level ?? 0.95),
      seed: `evaluation-request:${request.id}`,
    }));
    return { id: request.id, mode: request.mode, status: request.status, requested_by: request.requested_by, reason: request.reason,
      source_experiment_id: request.source_experiment_id, created_experiment_id: request.created_experiment_id,
      selection: request.selection, preflight: request.preflight, error: request.error, created_at: request.created_at,
      started_at: request.started_at, completed_at: request.completed_at,
      cancel_requested_at: request.cancel_requested_at, cancel_reason: request.cancel_reason,
      progress: {
        completed: itemViews.filter((item) => ["COMPLETED", "FAILED", "CANCELLED"].includes(item.status)).length,
        total: itemViews.length }, case_summaries: caseSummaries, decision_report: decisionReport, items: itemViews };
  };
  const activeEvaluationRequests = new Set();
  const executeEvaluationRequest = async (requestId) => {
    if (activeEvaluationRequests.has(requestId)) return;
    activeEvaluationRequests.add(requestId);
    try {
      let request = store.getEvaluationRunRequest(requestId);
      if (!request || request.status === "CANCELLED") return;
      if (request.status === "QUEUED") request = store.startEvaluationRunRequest(requestId);
      const source = store.getExperiment(request.source_experiment_id);
      const contestants = source.manifest.contestants.filter((item) => request.selection.contestant_refs.includes(item.ref));
      let experiment = request.created_experiment_id ? store.getExperiment(request.created_experiment_id) : null;
      if (!experiment) {
        const selectedRefs = new Set(request.selection.case_refs);
        const casePartitions = Object.fromEntries(Object.entries(source.manifest.case_partitions)
          .map(([name, refs]) => [name, refs.filter((ref) => selectedRefs.has(ref))]));
        const manifest = { ...source.manifest,
          name: evaluationRunName(source.name, request.mode),
          design: contestants.length === 2 ? "paired_comparison" : "single_system_acceptance",
          case_refs: request.selection.case_refs, case_partitions: casePartitions, contestants,
          environment_seeds: request.selection.environment_seeds, replicates_per_seed: request.selection.repetitions,
          evaluation_mode: request.mode === "FORMAL" ? "FORMAL" : "QUALIFICATION", request_kind: request.selection.request_kind,
          evaluation_purpose: request.selection.evaluation_purpose,
          source_experiment_id: source.id, operator_reason: request.reason };
        const created = store.createExperiment(manifest, `evaluation-request:${request.id}`);
        experiment = created.experiment;
        store.bindEvaluationRunExperiment(request.id, experiment.id);
        ledger.append({ entityType: "evaluation_run_request", entityId: request.id, action: "evaluation.request.started",
          payload: { source_experiment_id: source.id, created_experiment_id: experiment.id, mode: request.mode,
            request_kind: request.selection.request_kind, evaluation_purpose: request.selection.evaluation_purpose,
            affects_official_score: request.mode === "FORMAL", requested_by: request.requested_by, reason: request.reason } });
      }
      store.setExperimentStatus(experiment.id, "RUNNING");
      const effectiveConcurrency = Math.max(1, Math.min(
        Number(request.preflight?.budget?.effective_concurrency ?? 1),
        Number(experiment.manifest.capacity_policy?.runner_workers ?? 1),
        Number(experiment.manifest.capacity_policy?.twin_slots ?? 1),
      ));
      await runner.runUntilIdle({ experimentId: experiment.id, concurrency: effectiveConcurrency });
      request = store.getEvaluationRunRequest(request.id);
      let currentTrials = store.listTrials(experiment.id, { includeReplays: false });
      if (request.cancel_requested_at || request.status === "CANCELLED") {
        const terminalTrials = currentTrials.filter((trial) => ["COMPLETED", "FAILED", "CANCELLED"].includes(trial.status));
        store.setExperimentStatus(experiment.id, "CANCELLED");
        const finished = request.status === "CANCELLED" ? request
          : store.finishEvaluationRunRequest(request.id, "CANCELLED", request.cancel_reason);
        const report = runRequestView(finished).decision_report;
        ledger.append({ entityType: "evaluation_run_request", entityId: request.id, action: "evaluation.request.cancelled",
          payload: { experiment_id: experiment.id, completed_trials: terminalTrials.length,
            total_trials: currentTrials.length, cancellation_requested_at: request.cancel_requested_at,
            decision_report_digest: sha256(report), conclusion_code: report.conclusion_code } });
        return;
      }

      const retryPolicy = experiment.manifest.retry_policy;
      const scheduledRetries = [];
      for (const trial of currentTrials.filter((item) => item.status === "FAILED")) {
        const latestAttempt = store.listTrialAttemptResults(trial.id).at(-1);
        const failure = latestAttempt?.final_state?.failure_classification;
        const eligible = failure?.retryable === true && failure.policy_code
          && retryPolicy.retryable_categories.includes(failure.policy_code)
          && trial.attempt <= retryPolicy.max_infrastructure_retries;
        if (!eligible) continue;
        store.retryFailedTrial(trial.id, {
          maxRetries: retryPolicy.max_infrastructure_retries,
          allowedCategories: retryPolicy.retryable_categories,
          reason: "evaluation request frozen retry policy",
        });
        scheduledRetries.push({ trial_id: trial.id, from_attempt: trial.attempt, next_attempt: trial.attempt + 1,
          category: failure.category, policy_code: failure.policy_code });
        ledger.append({ entityType: "trial", entityId: trial.id, action: "trial.infrastructure_retry_scheduled",
          payload: { request_id: request.id, experiment_id: experiment.id, from_attempt: trial.attempt,
            next_attempt: trial.attempt + 1, failure_category: failure.category,
            policy_code: failure.policy_code, max_infrastructure_retries: retryPolicy.max_infrastructure_retries } });
      }
      if (scheduledRetries.length) {
        ledger.append({ entityType: "evaluation_run_request", entityId: request.id,
          action: "evaluation.request.infrastructure_retries_scheduled",
          payload: { experiment_id: experiment.id, retries: scheduledRetries } });
        scheduleEvaluationRequest(request.id, 1000);
        return;
      }

      currentTrials = store.listTrials(experiment.id, { includeReplays: false });
      const terminalTrials = currentTrials.filter((trial) => ["COMPLETED", "FAILED", "CANCELLED"].includes(trial.status));
      if (terminalTrials.length < currentTrials.length) {
        scheduleEvaluationRequest(request.id, 1000);
      } else {
        const summary = store.experimentSummary(experiment.id);
        const status = summary.failed_trials ? "FAILED" : "COMPLETED";
        store.setExperimentStatus(experiment.id, status);
        const finished = store.finishEvaluationRunRequest(request.id, status);
        const report = runRequestView(finished).decision_report;
        ledger.append({ entityType: "evaluation_run_request", entityId: request.id, action: `evaluation.request.${status.toLowerCase()}`,
          payload: { experiment_id: experiment.id, completed_trials: summary.completed_trials,
            failed_trials: summary.failed_trials, decision_report_digest: sha256(report),
            decision_authority: report.decision_authority, conclusion_code: report.conclusion_code,
            formal_winner: report.comparison?.formal_winner ?? null } });
      }
    } catch (error) {
      const request = store.getEvaluationRunRequest(requestId);
      if (request && request.status !== "CANCELLED") {
        const closure = store.closeEvaluationRunAfterFailure(requestId, error?.message ?? error);
        const report = runRequestView(closure.request).decision_report;
        ledger.append({ entityType: "evaluation_run_request", entityId: requestId, action: "evaluation.request.failed",
          payload: { error: String(error?.message ?? error),
            cancelled_queued_trials: closure.cancelled_queued_trials,
            cancelled_running_trials: closure.cancelled_running_trials,
            experiment_status_changed: closure.experiment_status_changed,
            decision_report_digest: sha256(report),
            conclusion_code: report.conclusion_code } });
      }
    } finally {
      activeEvaluationRequests.delete(requestId);
    }
  };  const scheduleEvaluationRequest = (id, delayMs = 0) => setTimeout(() => void executeEvaluationRequest(id), delayMs);
  runner.recover();
  for (const request of store.listEvaluationRunRequests().filter((item) => item.status === "FAILED" && item.created_experiment_id)) {
    const closure = store.closeEvaluationRunAfterFailure(request.id, request.error);
    if (closure.cancelled_queued_trials || closure.cancelled_running_trials || closure.experiment_status_changed) {
      ledger.append({ entityType: "evaluation_run_request", entityId: request.id,
        action: "evaluation.request.failure_lifecycle_reconciled",
        payload: { experiment_id: request.created_experiment_id,
          cancelled_queued_trials: closure.cancelled_queued_trials,
          cancelled_running_trials: closure.cancelled_running_trials,
          experiment_status_changed: closure.experiment_status_changed,
          original_error: request.error } });
    }
  }

  const operationsHealth = () => {
    const requests = store.listEvaluationRunRequests();
    const trials = store.listTrials(null, { includeReplays: false });
    const attemptHistory = store.listTrialAttemptResults().map(attemptView);
    const latestByTrial = new Map();
    for (const attempt of attemptHistory) latestByTrial.set(attempt.trial_id, attempt);
    const latestAttempts = trials.map((trial) => ({ trial, attempt: latestByTrial.get(trial.id) ?? null }));
    const failureCategories = {};
    for (const attempt of attemptHistory) {
      const category = attempt?.failure?.category;
      if (category) failureCategories[category] = (failureCategories[category] ?? 0) + 1;
    }
    const reconciliations = store.listTrialCleanupReconciliations();
    const resolvedCleanupKeys = new Set(reconciliations.filter((item) => item.status === "RESOLVED")
      .map((item) => `${item.trial_id}:${item.attempt}`));
    const unresolvedCleanup = latestAttempts.filter(({ trial, attempt }) => attempt && (
      attempt.cleanup?.reset_ok === false
      || attempt.cleanup?.quarantine_required && attempt.cleanup?.quarantine_released !== true
    ) && !resolvedCleanupKeys.has(`${trial.id}:${attempt.attempt}`)).length;
    const incompleteUsage = trials.filter((trial) => trial.status === "COMPLETED"
      && trial.usage?.measurement?.complete === false).length;
    const now = Date.now();
    const expiredRunningLeases = trials.filter((trial) => trial.status === "RUNNING"
      && trial.lease_expires_at && new Date(trial.lease_expires_at).getTime() < now).length;
    const ledgerState = ledger.verify();
    const degraded = unresolvedCleanup > 0 || expiredRunningLeases > 0 || !ledgerState.valid;
    return {
      contract: "evalos-operations-health.1",
      status: degraded ? "degraded" : "ok",
      explanation_zh: degraded
        ? "平台存在需要处理的复位、隔离、租约或账本问题；在恢复健康前不应启动正式评测。"
        : "任务调度、考场清理和证据账本均未发现阻塞性问题。",
      requests: {
        queued: requests.filter((item) => item.status === "QUEUED").length,
        running: requests.filter((item) => item.status === "RUNNING").length,
        completed: requests.filter((item) => item.status === "COMPLETED").length,
        failed: requests.filter((item) => item.status === "FAILED").length,
        cancelled: requests.filter((item) => item.status === "CANCELLED").length,
      },
      trials: {
        queued: trials.filter((item) => item.status === "QUEUED").length,
        running: trials.filter((item) => item.status === "RUNNING").length,
        completed: trials.filter((item) => item.status === "COMPLETED").length,
        failed: trials.filter((item) => item.status === "FAILED").length,
        cancelled: trials.filter((item) => item.status === "CANCELLED").length,
        expired_running_leases: expiredRunningLeases,
      },
      evidence: {
        unresolved_cleanup_trials: unresolvedCleanup,
        reconciled_cleanup_trials: resolvedCleanupKeys.size,
        incomplete_candidate_usage_trials: incompleteUsage,
      },
      failure_categories: failureCategories,
      retry_history: { attempts: attemptHistory.length, retried_trials: trials.filter((item) => item.attempt > 1).length },
      ledger: ledgerState,
      formal_release_blocked: degraded || !formalM3RunEnabled,
    };
  };
  const handler = async (request) => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const cors = {
      "access-control-allow-origin": origin === allowedOrigin ? origin : allowedOrigin,
      vary: "origin",
      "access-control-allow-headers": "content-type,idempotency-key,authorization,x-reviewer-id,x-reviewer-credential",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const reviewerDecision = request.method === "POST" && /^\/api\/reviews\/[^/]+\/decisions$/.test(url.pathname);
    const relayMutation = request.method === "POST" && /^\/api\/candidate-relay\/[^/]+\/(?:claim|requests\/[^/]+\/complete)$/.test(url.pathname);
    if (request.method === "POST" && !reviewerDecision && !relayMutation && !apiToken) {
      return json({ error: "EVALOS_API_TOKEN must be configured before control-plane mutations" }, 503, cors);
    }
    if (request.method === "POST" && !reviewerDecision && !relayMutation && !isAdmin(request)) {
      return json({ error: "authenticated control-plane token required" }, 401, cors);
    }
    try {
      const relayClaimMatch = url.pathname.match(/^\/api\/candidate-relay\/([^/]+)\/claim$/);
      const relayCompleteMatch = url.pathname.match(/^\/api\/candidate-relay\/([^/]+)\/requests\/([^/]+)\/complete$/);
      if (request.method === "POST" && (relayClaimMatch || relayCompleteMatch)) {
        const candidateRef = decodeURIComponent((relayClaimMatch ?? relayCompleteMatch)[1]);
        const rawBody = await request.text();
        candidateRelay.authenticate({ candidateRef, method: request.method, pathname: url.pathname,
          headers: request.headers, rawBody });
        const body = rawBody ? JSON.parse(rawBody) : {};
        if (relayClaimMatch) return json({ request: candidateRelay.claim(candidateRef, body) }, 200, cors);
        return json(candidateRelay.complete(candidateRef, decodeURIComponent(relayCompleteMatch[2]), body), 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/health") {
        const operations = operationsHealth();
        return json({ status: operations.status, service: "opsmind-evalos-control-api", contract: "evalos.7", milestone: "M3.1",
          ledger: operations.ledger, operations,
          formal_run: { enabled: formalM3RunEnabled, guard: "480_TRIAL_NOT_AUTHORIZED" },
          twin: { configured: twinConfigured } }, 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/workbench/operations-health") {
        if (!isAdmin(request)) return json({ error: "authenticated workbench session required" }, 401, cors);
        return json(operationsHealth(), 200, cors);
      }      if (request.method === "GET" && url.pathname === "/api/runtime/capabilities") {
        return json({ contract: "evalos-runtime-capabilities.3", milestone: "M3.1",
          eval_intelligence_enabled: liveDeepSeekAvailable,
          candidate_execution: "external-real-products-only", adapters: Object.keys(adapters),
          real_candidate_adapters: Object.fromEntries(["agent-harness-v2", "langgraph-v1"].map((ref) =>
            [ref, { configured: Boolean(realCandidateConnectors[ref]), transport: candidateRelay.hasCandidate(ref) ? "outbound-signed-relay" : "direct-https" }])),
          case_investigator: { enabled: Boolean(investigator), ...CASE_INVESTIGATOR_RUNTIME },
          eval_intelligence: { enabled: Boolean(investigator), ...CASE_INVESTIGATOR_RUNTIME,
            role: "read-only-score-explanation-and-comparison", score_authority: false },
          secret_source: liveDeepSeekAvailable ? "environment-only" : null,
          twin: { configured: twinConfigured, transport: twinConfigured ? "restricted-ssh-command" : null },
          trust_boundary: { execution_plane_private_labels: false, grading_plane_private_labels: true } }, 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/datasets") return json({ items: store.listDatasets() }, 200, cors);
      if (request.method === "GET" && url.pathname === "/api/workbench/candidate-readiness") {
        const items = [];
        for (const ref of ["agent-harness-v2", "langgraph-v1"]) {
          const frozen = frozenCandidate(ref);
          const adapter = adapterFor(ref, frozenM31Manifest.evaluation_lane);
          if (!frozen || !adapter || typeof adapter.preflight !== "function") {
            items.push({ ref, kind: "REAL_PRODUCT", configured: false, ready: false,
              status_label: "尚未连接", explanation: "EvalOS 尚未取得该真实产品的独立评测凭据或公开产品接口。" });
            continue;
          }
          try {
            const check = await adapter.preflight({ contestant: frozen, requiresTwin: true,
              budget: frozenM31Manifest.budget });
            const budgetUnknown = check.budget?.aligned == null;
            items.push({ ref, kind: "REAL_PRODUCT", configured: true, ready: check.ready,
              architecture: check.architecture, source_revision: check.source_revision,
              status_label: check.ready ? (budgetUnknown ? "资格试跑可用，正式评测未放行" : "可以参加资格试运行") : "产品未就绪",
              explanation: check.ready ? (budgetUnknown
                ? "外部产品、身份隔离和数字孪生均已就绪，可以进行少量不计分资格试跑；但产品尚未公开最长运行时间，正式评测不能放行。"
                : "外部产品可达，版本指纹一致，评测身份相互独立，数字孪生已连接，且候选超时没有超过 Trial 时间预算。")
                : "产品健康、数字孪生、身份隔离、最小权限、评测租户或候选超时预算未达到开考要求。",
              health: check.health, isolation: check.isolation, credentials: check.credentials,
              twin: check.twin, budget: check.budget });
          } catch (error) {
            items.push({ ref, kind: "REAL_PRODUCT", configured: true, ready: false, status_label: "开考检查失败",
              explanation: String(error?.message ?? error) });
          }
        }
        return json({ contract: "evalos-candidate-readiness.1", formal_480_enabled: false, items }, 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/candidate-adapters/discover") {
        if (!isAdmin(request)) return json({ error: "authenticated control-plane token required" }, 401, cors);
        const items = [];
        for (const ref of ["agent-harness-v2", "langgraph-v1"]) {
          const connector = realCandidateConnectors[ref];
          if (!connector) { items.push({ ref, configured: false, ready: false, reason: "connector_not_configured" }); continue; }
          try {
            const discovered = await connector.discover();
            const frozen = frozenCandidate(ref);
            const drift = ["source_revision", "artifact_digest", "runtime_digest", "runtime_manifest_digest", "capability_contract_digest"]
              .filter((field) => discovered[field] !== frozen[field]);
            items.push({ ref, configured: true, ready: drift.length === 0, drift, discovery: discovered });
          } catch (error) { items.push({ ref, configured: true, ready: false, reason: error.message }); }
        }
        return json({ contract: "candidate-discovery.3", items, production_writes: false }, 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/suites") return json({ items: store.listSuites() }, 200, cors);
      if (request.method === "GET" && url.pathname === "/api/cases") return json({ items: store.listCases() }, 200, cors);
      if (request.method === "GET" && url.pathname === "/api/experiments") {
        return json({ items: store.listExperiments().map((item) => ({ ...store.experimentSummary(item.id), experiment: blindExperimentView(item) })) }, 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/api/experiments") {
        const body = await request.json();
        const key = request.headers.get("idempotency-key") ?? body.idempotency_key;
        if (!key) return json({ error: "idempotency key is required" }, 400, cors);
        const result = store.createExperiment(body.manifest, key);
        if (result.created) ledger.append({ entityType: "experiment", entityId: result.experiment.id,
          action: "experiment.created", payload: { manifest_hash: result.experiment.manifest_hash, trial_count: store.listTrials(result.experiment.id).length } });
        return json({ experiment: result.experiment, created: result.created }, result.created ? 201 : 200, cors);
      }
      const experimentMatch = url.pathname.match(/^\/api\/experiments\/([^/]+)$/);
      if (request.method === "GET" && experimentMatch) {
        const id = decodeURIComponent(experimentMatch[1]);
        const summary = store.experimentSummary(id);
        return summary.experiment ? json({ ...summary, experiment: blindExperimentView(summary.experiment), trials: store.listTrials(id).map(publicTrial) }, 200, cors)
          : json({ error: "experiment not found" }, 404, cors);
      }
      const runMatch = url.pathname.match(/^\/api\/experiments\/([^/]+)\/run$/);
      if (request.method === "POST" && runMatch) {
        const id = decodeURIComponent(runMatch[1]);
        const experiment = store.getExperiment(id);
        if (!experiment) return json({ error: "experiment not found" }, 404, cors);
        const frozenDesign = store.listTrials(id, { includeReplays: false }).length === 0 && experiment.manifest.evaluation_mode === "FORMAL";
        if (frozenDesign || (experiment.manifest.evaluation_mode === "FORMAL" && !formalM3RunEnabled)) {
          return json({ error: "M3 正式设计已冻结但尚未放行；必须先通过 Adapter 资格、4/8 并发容量和商用产品通道门禁" }, 423, cors);
        }
        const concurrency = Number(url.searchParams.get("concurrency") ?? 1);
        const maximumConcurrency = experiment.manifest.capacity_policy.runner_workers;
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > maximumConcurrency) {
          return json({ error: `runner concurrency must be between 1 and frozen maximum ${maximumConcurrency}` }, 400, cors);
        }
        const needsTwin = experiment.manifest.case_refs.some((caseRef) => store.getExecutionCase(caseRef)?.source?.level === "L2");
        const twinSlots = needsTwin ? Math.max(1, Number(experiment.manifest.capacity_policy.twin_slots ?? 1)) : concurrency;
        const effectiveConcurrency = Math.max(1, Math.min(concurrency, twinSlots));
        store.setExperimentStatus(id, "RUNNING");
        const executed = await runner.runUntilIdle({ experimentId: id, concurrency: effectiveConcurrency });
        const summary = store.experimentSummary(id);
        store.setExperimentStatus(id, summary.failed_trials ? "FAILED" : "COMPLETED");
        return json({ executed, requested_concurrency: concurrency, effective_concurrency: effectiveConcurrency,
          capacity_limited_by: effectiveConcurrency < concurrency ? (needsTwin ? "frozen_twin_slots" : "frozen_capacity_policy") : null,
          summary: store.experimentSummary(id) }, 200, cors);
      }
      const traceMatch = url.pathname.match(/^\/api\/trials\/([^/]+)\/trace$/);
      if (request.method === "GET" && traceMatch) {
        const trialId = decodeURIComponent(traceMatch[1]);
        if (!store.getTrial(trialId)) return json({ error: "trial not found" }, 404, cors);
        const after = Number(url.searchParams.get("after") ?? 0);
        const items = evaluationEvidenceTraceView(store.getTrace(trialId, { after }));
        if ((request.headers.get("accept") ?? "").includes("text/event-stream")) {
          const body = ["retry: 1000", ...items.map((record) => `id: ${record.row_id}\nevent: span-trace\ndata: ${JSON.stringify(record)}\n`),
            `event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n`].join("\n");
          return new Response(body, { headers: { ...cors, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
        }
        return json({ items, cursor: items.at(-1)?.row_id ?? after }, 200, cors);
      }
      const gradeMatch = url.pathname.match(/^\/api\/trials\/([^/]+)\/graders$/);
      if (request.method === "GET" && gradeMatch) return isAdmin(request)
        ? json({ items: store.listGraderRuns(decodeURIComponent(gradeMatch[1])).map(blindGraderRunView) }, 200, cors)
        : json({ error: "admin audit authorization required" }, 401, cors);
      const judgeMatch = url.pathname.match(/^\/api\/trials\/([^/]+)\/judges$/);
      if (request.method === "GET" && judgeMatch) return isAdmin(request)
        ? json({ items: store.listJudgeRuns(decodeURIComponent(judgeMatch[1])) }, 200, cors)
        : json({ error: "admin audit authorization required" }, 401, cors);
      const judgeRunMatch = url.pathname.match(/^\/api\/trials\/([^/]+)\/judge$/);
      if (request.method === "POST" && judgeRunMatch) {
        if (!liveDeepSeekAvailable) return json({ error: "DeepSeek runtime credential is not configured" }, 503, cors);
        const trialId = decodeURIComponent(judgeRunMatch[1]);
        const trial = store.getTrial(trialId);
        if (!trial?.outcome) return json({ error: "completed trial result is required before Judge" }, 400, cors);
        const label = labels.getLabel(trial.case_ref);
        const execution = store.getExecutionCase(trial.case_ref);
        const result = await judgeRecordAndSummarize({ store, gradingCase: { ...execution, ground_truth: label.ground_truth }, trial,
          namespace: path.join(store.runtimeRoot, "judges", trial.id), model: process.env.ANTHROPIC_MODEL ?? "deepseek-v4-flash" });
        ledger.append({ entityType: "judge_bundle", entityId: trial.id, action: "judge.completed",
          payload: { judge_ref: result.bundle.judge_ref, roles: result.bundle.runs.map((run) => run.role),
            authority: "advisory-only", attention_required: result.advisory.attention_required } });
        return json({ judge_ref: result.bundle.judge_ref, consensus: result.bundle.consensus,
          runs: result.bundle.runs.map((run) => ({ role: run.role, result: run.result, usage: run.usage })),
          advisory: result.advisory, official_score_source: "deterministic_code_grader" }, 201, cors);
      }
      const trialMatch = url.pathname.match(/^\/api\/trials\/([^/]+)$/);
      if (request.method === "GET" && trialMatch) {
        const trial = publicTrial(store.getTrial(decodeURIComponent(trialMatch[1])));
        return trial ? json({ trial }, 200, cors) : json({ error: "trial not found" }, 404, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/reviews") return json({ optional: true, blocking: false,
        ranking_authority: false, items: store.listHumanReviewTasks() }, 200, cors);
      if (request.method === "POST" && url.pathname === "/api/reviews") {
        const body = await request.json();
        if (!store.getTrial(body.trial_id)) return json({ error: "trial not found" }, 404, cors);
        const task = store.createHumanReviewTask(body.trial_id, { rubricRef: body.rubric_ref ?? "m15-optional-expert-review@2.0.0",
          reason: body.reason ?? "optional-quality-sample", priority: body.priority ?? "normal" });
        ledger.append({ entityType: "optional_expert_review", entityId: task.id, action: "optional_review.created",
          payload: { trial_id: task.trial_id, blocking: false, ranking_authority: false } });
        return json({ optional: true, blocking: false, ranking_authority: false, task }, 201, cors);
      }
      const reviewEvidenceMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/evidence$/);
      if (request.method === "GET" && reviewEvidenceMatch) {
        const reviewTaskId = decodeURIComponent(reviewEvidenceMatch[1]);
        const reviewerId = request.headers.get("x-reviewer-id");
        const credential = request.headers.get("x-reviewer-credential");
        if (!reviewerId || !credential || !store.verifyReviewAccess(reviewTaskId, reviewerId, credential)) {
          return json({ error: "verified assigned reviewer required" }, 401, cors);
        }
        const task = store.getHumanReviewTask(reviewTaskId);
        const trial = task && store.getTrial(task.trial_id);
        if (!task || !trial) return json({ error: "review task not found" }, 404, cors);
        return json({ task, case: store.getPublicCase(trial.case_ref), trial: publicTrial(trial),
          trace: evaluationEvidenceTraceView(store.getTrace(trial.id)), declaration: "不包含代码Grader、模型Judge、架构身份或私有参考标签" }, 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/reviewers") return json({ items: store.listReviewers() }, 200, cors);
      if (request.method === "POST" && url.pathname === "/api/reviewers") {
        if (!apiToken) return json({ error: "EVALOS_API_TOKEN must be configured before reviewer administration" }, 503, cors);
        const body = await request.json();
        const reviewer = store.registerReviewer({ id: body.id, displayName: body.display_name, role: body.role,
          qualificationRef: body.qualification_ref, verifiedBy: body.verified_by, credential: body.credential });
        ledger.append({ entityType: "reviewer", entityId: reviewer.id, action: "reviewer.verified",
          payload: { qualification_ref: reviewer.qualification_ref, verified_by: reviewer.verified_by } });
        return json({ reviewer }, 201, cors);
      }
      const assignmentMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/assignments$/);
      if (request.method === "POST" && assignmentMatch) {
        if (!apiToken) return json({ error: "EVALOS_API_TOKEN must be configured before review assignment" }, 503, cors);
        const body = await request.json();
        const assignment = store.assignReview(decodeURIComponent(assignmentMatch[1]), body.reviewer_id, Number(body.assignment_order));
        ledger.append({ entityType: "review_assignment", entityId: assignment.id, action: "review.assigned",
          payload: { review_task_id: assignment.review_task_id, reviewer_id: assignment.reviewer_id, assignment_order: assignment.assignment_order } });
        return json({ assignment }, 201, cors);
      }
      const reviewMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/decisions$/);
      if (request.method === "POST" && reviewMatch) {
        const body = await request.json();
        const credential = request.headers.get("x-reviewer-credential");
        if (!body.reviewer_id || !body.verdict || !body.rationale || !credential) return json({ error: "verified reviewer, verdict and rationale are required" }, 400, cors);
        const decision = store.addHumanReviewDecision(decodeURIComponent(reviewMatch[1]), {
          reviewerId: body.reviewer_id, credential, verdict: body.verdict, rationale: body.rationale,
          dimensionLabels: body.dimension_labels ?? {}, evidenceRefs: body.evidence_refs ?? [],
        });
        ledger.append({ entityType: "human_review_decision", entityId: decision.id, action: "human_review.decision_recorded",
          payload: { review_task_id: decision.review_task_id, reviewer_id: decision.reviewer_id, verdict: decision.verdict } });
        return json({ decision }, 201, cors);
      }
      const consensusMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/consensus$/);
      if (request.method === "GET" && consensusMatch) return json(store.reviewConsensus(decodeURIComponent(consensusMatch[1])), 200, cors);
      if (request.method === "GET" && url.pathname === "/api/calibrations") return json({ items: store.listCalibrationRuns() }, 200, cors);
      if (request.method === "POST" && url.pathname === "/api/calibrations/run") {
        if (!apiToken) return json({ error: "EVALOS_API_TOKEN must be configured before calibration" }, 503, cors);
        const body = await request.json();
        const judgeRef = body.judge_ref ?? BLIND_JUDGE_VERSION;
        const datasetRef = body.dataset_ref ?? "m15-l1-agentic-cases@2.0.0";
        const calibration = expertCalibrationFromConsensusSamples(store.calibrationSamples(judgeRef, datasetRef));
        const id = store.addCalibrationRun({ judgeRef, datasetRef, metrics: calibration, passed: calibration.passed });
        ledger.append({ entityType: "calibration", entityId: id, action: "judge.calibrated",
          payload: { judge_ref: judgeRef, dataset_ref: datasetRef, sample_count: calibration.sample_count, passed: calibration.passed } });
        return json({ id, calibration, optional: true, blocking: false, ranking_authority: false,
          official_score_source: "deterministic_code_grader" }, 201, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/measurement/health") {
        const optionalExpertSignal = store.latestCalibration(BLIND_JUDGE_VERSION, "m15-l1-agentic-cases@2.0.0");
        const tasks = store.listHumanReviewTasks();
        return json({ judge_ref: BLIND_JUDGE_VERSION, official_score_source: "deterministic_code_grader",
          model_judges: "advisory_only", expert_review: { optional: true, blocking: false, ranking_authority: false,
          latest_quality_signal: optionalExpertSignal, review_tasks: tasks.length,
          double_reviewed: tasks.filter((task) => store.reviewConsensus(task.id).status === "AGREED").length,
          adjudication_required: tasks.filter((task) => store.reviewConsensus(task.id).status === "ADJUDICATION_REQUIRED").length,
          }, ledger: ledger.verify() }, 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/ledger/verify") return json(ledger.verify(), 200, cors);

      if (url.pathname.startsWith("/api/workbench/") && !isAdmin(request)) {
        return json({ error: "authenticated workbench session required" }, 401, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/workbench/run-templates") {
        const requestedSourceExperimentId = url.searchParams.get("source_experiment_id");
        return json({ items: store.listExperiments().filter((item) => item.manifest.manifest_version === "6.0"
          && (requestedSourceExperimentId
            ? item.id === requestedSourceExperimentId
            : ((store.listTrials(item.id, { includeReplays: false }).length === 0
                && (item.manifest.evaluation_mode === "FORMAL" || item.manifest.run_class === "ENGINEERING_TEST"))
              || item.status === "COMPLETED" || store.experimentSummary(item.id).completion_rate === 1)))
          .map((item) => ({ id: item.id, name: item.name,
            status: store.listTrials(item.id, { includeReplays: false }).length === 0 ? "FROZEN" : item.status,
            dataset_ref: item.dataset_ref,
            suite_ref: item.suite_ref, case_refs: item.manifest.case_refs,
            contestants: item.manifest.contestants.map(({ ref, adapter_version, source_revision, artifact_digest }) =>
              ({ ref, adapter_version, source_revision, artifact_digest })),
            evaluation_mode: item.manifest.evaluation_mode, evaluation_lane: item.manifest.evaluation_lane,
            environment_seeds: item.manifest.environment_seeds,
          })) }, 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/api/workbench/run-requests/preflight") {
        return json({ preflight: await preflightEvaluation(await request.json()) }, 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/workbench/run-requests") {
        return json({ contract: "evalos-run-request-list.2", items: store.listEvaluationRunRequests().map(runRequestView) }, 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/api/workbench/run-requests") {
        const body = await request.json();
        const idempotencyKey = request.headers.get("idempotency-key") ?? body.idempotency_key;
        const preflight = await preflightEvaluation(body);
        if (!preflight.ready) return json({ error: "preflight failed", preflight }, 409, cors);
        const created = store.createEvaluationRunRequest({ idempotencyKey, mode: preflight.mode,
          sourceExperimentId: preflight.source_experiment_id, requestedBy: body.requested_by ?? "evalos-operator",
          reason: body.reason, selection: { request_kind: preflight.request_kind, evaluation_purpose: preflight.evaluation_purpose,
            case_refs: preflight.case_refs, contestant_refs: preflight.contestant_refs, environment_seeds: preflight.environment_seeds,
            repetitions: preflight.repetitions }, preflight });
        if (created.created) ledger.append({ entityType: "evaluation_run_request", entityId: created.request.id,
          action: "evaluation.request.created", payload: { mode: preflight.mode, request_kind: preflight.request_kind,
            evaluation_purpose: preflight.evaluation_purpose, case_count: preflight.case_refs.length,
            trial_count: preflight.total_trials, requested_by: body.requested_by ?? "evalos-operator", reason: body.reason,
            affects_official_score: preflight.affects_official_score } });
        if (["QUEUED", "RUNNING"].includes(created.request.status)) scheduleEvaluationRequest(created.request.id);
        return json({ request: runRequestView(store.getEvaluationRunRequest(created.request.id)), created: created.created }, created.created ? 202 : 200, cors);
      }
      const runRequestCancelMatch = url.pathname.match(/^\/api\/workbench\/run-requests\/([^/]+)\/cancel$/);
      if (request.method === "POST" && runRequestCancelMatch) {
        const id = decodeURIComponent(runRequestCancelMatch[1]);
        const requestItem = store.getEvaluationRunRequest(id);
        if (!requestItem) return json({ error: "evaluation run request not found" }, 404, cors);
        if (!["QUEUED", "RUNNING"].includes(requestItem.status)) return json({ error: "only queued or running evaluation work may be cancelled" }, 409, cors);
        let body = {};
        try { body = await request.json(); } catch {}
        const cancellationReason = String(body.reason ?? "operator requested safe cancellation").trim();
        const cancellation = store.requestEvaluationRunCancellation(id, cancellationReason);
        ledger.append({ entityType: "evaluation_run_request", entityId: id, action: "evaluation.request.cancellation_requested",
          payload: { requested_by: requestItem.requested_by, reason: cancellationReason,
            cancelled_queued_trials: cancellation.cancelled_queued_trials,
            cancellation_signalled_running_trials: cancellation.cancellation_signalled_running_trials,
            running_trial_policy: "request-candidate-cancel-then-wait-terminal-reset" } });
        return json({ request: runRequestView(cancellation.request),
          cancelled_queued_trials: cancellation.cancelled_queued_trials,
          cancellation_signalled_running_trials: cancellation.cancellation_signalled_running_trials }, 202, cors);
      }
      const runRequestMatch = url.pathname.match(/^\/api\/workbench\/run-requests\/([^/]+)$/);
      if (request.method === "GET" && runRequestMatch) {
        const requestItem = runRequestView(store.getEvaluationRunRequest(decodeURIComponent(runRequestMatch[1])));
        return requestItem ? json({ request: requestItem }, 200, cors) : json({ error: "evaluation run request not found" }, 404, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/workbench/case-selection-sets") {
        return json({ items: store.listCaseSelectionSets() }, 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/api/workbench/case-selection-sets") {
        const body = await request.json();
        const item = store.saveCaseSelectionSet({ name: body.name, datasetRef: body.dataset_ref, caseRefs: body.case_refs,
          requestedBy: body.requested_by ?? "evalos-operator", reason: body.reason });
        ledger.append({ entityType: "case_selection_set", entityId: item.id, action: "case_selection_set.created",
          payload: { name: item.name, dataset_ref: item.dataset_ref, definition_hash: item.definition_hash,
            requested_by: item.requested_by, reason: item.reason } });
        return json({ item }, 201, cors);
      }
      if (request.method === "POST" && url.pathname === "/api/workbench/regrades") {
        const body = await request.json();
        const trialIds = [...new Set(body.trial_ids ?? [])];
        if (!trialIds.length || !body.reason) throw new Error("completed trial ids and regrade reason are required");
        const items = trialIds.map((trialId) => {
          const trial = store.getTrial(trialId);
          if (!trial || trial.status !== "COMPLETED" || !trial.outcome) throw new Error(`completed trial is required for regrade: ${trialId}`);
          const original = gradeFor(trialId);
          if (!original) throw new Error(`original deterministic grade is required: ${trialId}`);
          const grading = gradingService.grade({ trialId: trial.id, caseRef: trial.case_ref, outcome: trial.outcome, trace: store.getTrace(trial.id),
            usage: trial.usage, budget: trial.budget, environmentState: trial.final_state?.before_reset ?? null });
          const regrade = store.addRegradeRequest({ trialId, requestedBy: body.requested_by ?? "evalos-operator",
            reason: body.reason, graderRef: grading.grader_ref, originalGraderRunId: original.id, result: grading.result });
          ledger.append({ entityType: "regrade_request", entityId: regrade.id, action: "regrade.completed",
            payload: { trial_id: trialId, requested_by: regrade.requested_by, reason: regrade.reason,
              original_score: original.result.total, recalculated_score: grading.result.total,
              official_score_mutated: false } });
          return { ...regrade, original_score: original.result.total, recalculated_score: grading.result.total,
            score_changed: Number(original.result.total) !== Number(grading.result.total), official_score_mutated: false };
        });
        return json({ contract: "evalos-regrade.1", items, notice: "只使用现有冻结证据重新计算；不运行 Agent，也不覆盖原评分记录，正式成绩口径保持不变。" }, 201, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/workbench/overview") {
        const experiments = workbenchExperiments();
        const trials = store.listTrials(null, { includeReplays: false });
        const formalExperimentIds = new Set(store.listExperiments().filter((item) => evaluationMode(item) === "FORMAL").map((item) => item.id));
        const formalTrialIds = new Set(trials.filter((item) => formalExperimentIds.has(item.experiment_id)).map((item) => item.id));
        const grades = store.listGraderRuns().filter((item) => item.dimension === "overall" && formalTrialIds.has(item.trial_id));
        return json({ contract: "evalos-workbench.4", milestone: "M3.1", platform: {
          core: "Claude Agent SDK + DeepSeek + MCP + Skills + Harness", workflow_graph: null,
          official_score_source: "deterministic_code_grader", ai_analysis_authority: "diagnostic_only",
          candidate_execution: "external-real-products-only", candidate_adapter_contract: "4.0",
          trace_contract: "4.0", grader_contract: "5.1", formal_480_enabled: false,
        }, counts: { datasets: store.listDatasets().length, cases: store.listCases().length,
          experiments: experiments.length, trials: trials.length, completed_trials: trials.filter((item) => item.status === "COMPLETED").length,
          analysis_runs: store.listAnalysisRuns().length, evaluation_tasks: store.listEvaluationRunRequests().length }, score: {
          average: grades.length ? Number((grades.reduce((sum, item) => sum + Number(item.result.total ?? 0), 0) / grades.length).toFixed(2)) : null,
          passed: grades.filter((item) => item.result.passed).length, graded: grades.length,
        }, experiments: experiments.slice(0, 8), ledger: ledger.verify() }, 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/workbench/datasets") {
        const cases = workbenchCases();
        const suites = store.listSuites();
        const experiments = workbenchExperiments();
        return json({ items: store.listDatasets().map((dataset) => ({ ...dataset,
          case_count: cases.filter((item) => item.dataset_ref === dataset.dataset_ref).length,
          suite_count: suites.filter((item) => item.definition.case_refs?.some((ref) =>
            cases.find((candidate) => candidate.case_ref === ref && candidate.dataset_ref === dataset.dataset_ref))).length,
          experiment_count: experiments.filter((item) => item.dataset_ref === dataset.dataset_ref).length,
          trial_count: cases.filter((item) => item.dataset_ref === dataset.dataset_ref).reduce((sum, item) => sum + item.trial_count, 0),
        })) }, 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/workbench/cases") {
        const datasetRef = url.searchParams.get("dataset_ref");
        const items = workbenchCases().filter((item) => !datasetRef || item.dataset_ref === datasetRef);
        return json({ items }, 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/workbench/experiments") {
        return json({ items: workbenchExperiments() }, 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/workbench/trials") {
        return json({ items: workbenchTrials() }, 200, cors);
      }
      const workbenchExperimentMatch = url.pathname.match(/^\/api\/workbench\/experiments\/([^/]+)$/);
      if (request.method === "GET" && workbenchExperimentMatch) {
        const id = decodeURIComponent(workbenchExperimentMatch[1]);
        const experiment = store.getExperiment(id);
        if (!experiment) return json({ error: "experiment not found" }, 404, cors);
        const summary = workbenchExperiments().find((item) => item.id === id);
        const trials = store.listTrials(id).map((trial) => ({ ...auditTrial(trial, experiment),
          grade: gradeFor(trial.id) ? auditableGraderRunView(gradeFor(trial.id)).result : null,
          analysis_runs: store.listAnalysisRuns(trial.id).map((item) => ({ id: item.id, status: item.status, mode: item.mode,
            created_at: item.created_at, completed_at: item.completed_at })) }));
        return json({ experiment: summary, manifest: { ...experiment.manifest,
          contestants: experiment.status === "COMPLETED" ? experiment.manifest.contestants : undefined }, trials }, 200, cors);
      }
      const workbenchTrialTraceMatch = url.pathname.match(/^\/api\/workbench\/trials\/([^/]+)\/trace$/);
      if (request.method === "GET" && workbenchTrialTraceMatch) {
        const trialId = decodeURIComponent(workbenchTrialTraceMatch[1]);
        if (!store.getTrial(trialId)) return json({ error: "trial not found" }, 404, cors);
        const after = Math.max(0, Number(url.searchParams.get("after") ?? 0));
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 250)));
        const items = blindTraceView(store.getTrace(trialId, { after, limit })).map((item) => ({ ...item, display: explainTraceRecord(item) }));
        const total = store.countTraceRecords(trialId);
        const cursor = items.at(-1)?.row_id ?? after;
        const remaining = store.getTrace(trialId, { after: cursor, limit: 1 }).length > 0;
        return json({ contract: "evalos-machine-log.1", filters: TRACE_FILTERS, items, cursor, total, has_more: remaining }, 200, cors);
      }
      const workbenchTrialSourceContentMatch = url.pathname.match(/^\/api\/workbench\/trials\/([^/]+)\/source\/content$/);
      if (request.method === "GET" && workbenchTrialSourceContentMatch) {
        const trialId = decodeURIComponent(workbenchTrialSourceContentMatch[1]);
        const snapshot = store.getTrialSourceSnapshot(trialId);
        if (!snapshot) return json({ error: "frozen source snapshot not found" }, 404, cors);
        const requestedPath = url.searchParams.get("path");
        if (!requestedPath) return json({ error: "source path is required" }, 400, cors);
        return json(readSnapshotFile(snapshot, requestedPath), 200, cors);
      }
      const workbenchTrialSourceMatch = url.pathname.match(/^\/api\/workbench\/trials\/([^/]+)\/source$/);
      if (request.method === "GET" && workbenchTrialSourceMatch) {
        const snapshot = store.getTrialSourceSnapshot(decodeURIComponent(workbenchTrialSourceMatch[1]));
        return snapshot ? json({ snapshot: safeSnapshot(snapshot, { includeFiles: true }) }, 200, cors)
          : json({ error: "frozen source snapshot not found" }, 404, cors);
      }
      const workbenchTrialCleanupMatch = url.pathname.match(/^\/api\/workbench\/trials\/([^/]+)\/reconcile-cleanup$/);
      if (request.method === "POST" && workbenchTrialCleanupMatch) {
        const trialId = decodeURIComponent(workbenchTrialCleanupMatch[1]);
        try { return json({ reconciliation: await reconcileTrialCleanup(trialId) }, 200, cors); }
        catch (error) {
          if (error?.code === "CLEANUP_NOT_READY") return json({ error: error.message }, 409, cors);
          throw error;
        }
      }
      const workbenchTrialMatch = url.pathname.match(/^\/api\/workbench\/trials\/([^/]+)$/);
      if (request.method === "GET" && workbenchTrialMatch) {
        const trialId = decodeURIComponent(workbenchTrialMatch[1]);
        const trial = store.getTrial(trialId);
        if (!trial) return json({ error: "trial not found" }, 404, cors);
        const experiment = store.getExperiment(trial.experiment_id);
        const trace = store.getTrace(trial.id);
        return json({ trial: auditTrial(trial, experiment), case: store.getPublicCase(trial.case_ref),
          experiment: workbenchExperiments().find((item) => item.id === trial.experiment_id),
          live_progress: trialLiveProgressView(trial, experiment, trace),
          evidence: { trace_records: trace.length, trace_hash: trial.trace_hash,
            actors: [...new Set(trace.map((item) => item.actor))],
            tools: trace.filter((item) => item.span_kind === "TOOL" && item.record_type === "SPAN_END").length,
            artifacts: store.listArtifacts(trial.id).map(({ path: _path, ...artifact }) => artifact) },
          graders: store.listGraderRuns(trial.id).map(auditableGraderRunView), judges: store.listJudgeRuns(trial.id).map((item) => ({
            id: item.id, role: item.judge_role, result: item.result, authority: "advisory_only", created_at: item.created_at })),
          source_snapshot: safeSnapshot(store.getTrialSourceSnapshot(trial.id)), analyses: store.listAnalysisRuns(trial.id),
          regrades: store.listRegradeRequests(trial.id), attempts: store.listTrialAttemptResults(trial.id).map(attemptView),
          cleanup_reconciliations: store.listTrialCleanupReconciliations(trial.id),
        }, 200, cors);
      }

      if (request.method === "GET" && url.pathname === "/api/analysis-runs") {
        if (!isAdmin(request)) return json({ error: "authenticated workbench session required" }, 401, cors);
        return json({ items: store.listAnalysisRuns(url.searchParams.get("trial_id")) }, 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/api/analysis-runs") {
        if (!investigator) return json({ error: "Claude Agent SDK + DeepSeek investigator is not configured" }, 503, cors);
        const body = await request.json();
        const trial = store.getTrial(body.trial_id);
        if (!trial || trial.status !== "COMPLETED") return json({ error: "completed trial is required" }, 400, cors);
        const experiment = store.getExperiment(trial.experiment_id);
        if (experiment?.status !== "COMPLETED") return json({ error: "experiment must be closed before AI analysis" }, 409, cors);
        const snapshot = store.getTrialSourceSnapshot(trial.id);
        if (!snapshot) return json({ error: "frozen source snapshot is required" }, 409, cors);
        const idempotencyKey = request.headers.get("idempotency-key") ?? body.idempotency_key;
        const created = store.createAnalysisRun({ trialId: trial.id, idempotencyKey, requestedBy: body.requested_by,
          prompt: body.prompt, mode: body.mode, sourceSnapshotRef: snapshot.snapshot_ref,
          budget: ANALYSIS_BUDGET });
        if (created.created) {
          const running = store.startAnalysisRun(created.analysis.id);
          ledger.append({ entityType: "ai_analysis", entityId: running.id, action: "analysis.started",
            payload: { trial_id: trial.id, source_snapshot_ref: snapshot.snapshot_ref, authority: "diagnostic_only" } });
          const namespace = path.join(store.runtimeRoot, "analyses", running.id);
          void investigator.analyze({ analysisRunId: running.id, trialId: trial.id, prompt: running.prompt, namespace,
            maxTurns: Number(running.budget.max_turns ?? ANALYSIS_BUDGET.max_turns) }).then(({ result, usage }) => {
              store.completeAnalysisRun(running.id, { result, usage });
              ledger.append({ entityType: "ai_analysis", entityId: running.id, action: "analysis.completed",
                payload: { trial_id: trial.id, result_hash: store.getAnalysisRun(running.id).result_hash,
                  authority: "diagnostic_only" } });
            }).catch((error) => {
              store.appendAnalysisEvent(running.id, { eventType: "analysis.failed", actor: "harness",
                payload: { error: String(error?.message ?? error) } });
              store.failAnalysisRun(running.id, error?.message ?? error);
            });
        }
        return json({ analysis: store.getAnalysisRun(created.analysis.id), created: created.created }, created.created ? 202 : 200, cors);
      }
      const analysisEventsMatch = url.pathname.match(/^\/api\/analysis-runs\/([^/]+)\/events$/);
      if (request.method === "GET" && analysisEventsMatch) {
        if (!isAdmin(request)) return json({ error: "authenticated workbench session required" }, 401, cors);
        const id = decodeURIComponent(analysisEventsMatch[1]);
        const analysis = store.getAnalysisRun(id);
        if (!analysis) return json({ error: "analysis run not found" }, 404, cors);
        const after = Math.max(0, Number(url.searchParams.get("after") ?? 0));
        const items = store.getAnalysisEvents(id, { after });
        if ((request.headers.get("accept") ?? "").includes("text/event-stream")) {
          const body = ["retry: 1000", ...items.map((event) => `id: ${event.row_id}\nevent: analysis-event\ndata: ${JSON.stringify(event)}\n`),
            `event: analysis-status\ndata: ${JSON.stringify({ id, status: analysis.status })}\n`].join("\n");
          return new Response(body, { headers: { ...cors, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
        }
        return json({ items, cursor: items.at(-1)?.row_id ?? after, status: analysis.status }, 200, cors);
      }
      const analysisSourcesMatch = url.pathname.match(/^\/api\/analysis-runs\/([^/]+)\/sources$/);
      if (request.method === "GET" && analysisSourcesMatch) {
        if (!isAdmin(request)) return json({ error: "authenticated workbench session required" }, 401, cors);
        return json({ items: store.listAnalysisSources(decodeURIComponent(analysisSourcesMatch[1])) }, 200, cors);
      }
      const analysisMatch = url.pathname.match(/^\/api\/analysis-runs\/([^/]+)$/);
      if (request.method === "GET" && analysisMatch) {
        if (!isAdmin(request)) return json({ error: "authenticated workbench session required" }, 401, cors);
        const analysis = store.getAnalysisRun(decodeURIComponent(analysisMatch[1]));
        return analysis ? json({ analysis, events: store.getAnalysisEvents(analysis.id), sources: store.listAnalysisSources(analysis.id) }, 200, cors)
          : json({ error: "analysis run not found" }, 404, cors);
      }

      if (request.method === "GET" && url.pathname === "/api/m15/acceptance") {
        try { return json(JSON.parse(readFileSync(path.join(artifactsRoot, "M1.5验收结论.json"), "utf8")), 200, cors); }
        catch { return json({ gate: "M1.5", status: "NOT_RUN" }, 200, cors); }
      }
      if (request.method === "GET" && url.pathname === "/api/m2/acceptance") {
        return json(readAcceptance(m2ArtifactsRoot, "M2验收结论.json",
          { gate: "M2-PROTOCOL-TWIN", status: "NOT_RUN", twin_configured: twinConfigured }), 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/m2/executor") {
        return json(readAcceptance(m2ExecutorArtifactsRoot, "M2变更执行器验收结论.json",
          { gate: "M2-CHANGE-EXECUTOR", status: "NOT_RUN" }), 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/m2/agent") {
        return json(readAcceptance(m2AgentArtifactsRoot, "M2-Agent端到端验收结论.json",
          { gate: "M2-AGENT-E2E", status: "NOT_RUN" }), 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/m2/qualification") {
        return json(readAcceptance(m2QualificationArtifactsRoot, "M2双架构适配资格验收结论.json",
          { gate: "M2-ADAPTER-QUALIFICATION", status: "NOT_RUN" }), 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/m2/summary") {
        const gates = {
          protocol_twin: readAcceptance(m2ArtifactsRoot, "M2验收结论.json", { gate: "M2-PROTOCOL-TWIN", status: "NOT_RUN" }),
          change_executor: readAcceptance(m2ExecutorArtifactsRoot, "M2变更执行器验收结论.json", { gate: "M2-CHANGE-EXECUTOR", status: "NOT_RUN" }),
          agent_e2e: readAcceptance(m2AgentArtifactsRoot, "M2-Agent端到端验收结论.json", { gate: "M2-AGENT-E2E", status: "NOT_RUN" }),
          adapter_qualification: readAcceptance(m2QualificationArtifactsRoot, "M2双架构适配资格验收结论.json", { gate: "M2-ADAPTER-QUALIFICATION", status: "NOT_RUN" }),
        };
        return json({ contract: "evalos-m2-summary.1",
          status: Object.values(gates).every((gate) => gate.status === "PASSED") ? "PASSED" : "IN_PROGRESS",
          ranking_produced: false, next_phase: "M3 正式盲测评测", gates }, 200, cors);
      }
      return json({ error: "not found" }, 404, cors);
    } catch (error) {
      const clientError = /required|not frozen|requires experiment manifest|exactly two|positive integer|credential|assignment|calibration labels|evaluation run|repetitions|outside the source|formal evaluation|idempotency|candidate relay|Manifest 3\.0|旧版合同|参评考生|重新评测|新建评测|评测必须|评测对象/.test(error.message);
      return json({ error: error.message }, clientError ? 400 : 500, cors);
    }
  };
  for (const request of store.listEvaluationRunRequests().filter((item) => ["QUEUED", "RUNNING"].includes(item.status))) {
    scheduleEvaluationRequest(request.id);
  }
  const cleanupReconciliationTimer = twinConfigured ? setInterval(() => void reconcilePendingCleanups(), 30000) : null;
  cleanupReconciliationTimer?.unref?.();
  const cleanupReconciliationKickoff = twinConfigured ? setTimeout(() => void reconcilePendingCleanups(), 1000) : null;
  cleanupReconciliationKickoff?.unref?.();
  return { handler, store, labels, ledger, runner, reconcileTrialCleanup,
    close: () => { if (cleanupReconciliationTimer) clearInterval(cleanupReconciliationTimer);
      if (cleanupReconciliationKickoff) clearTimeout(cleanupReconciliationKickoff); labels.close(); store.close(); } };
}

export { publicTrial };
