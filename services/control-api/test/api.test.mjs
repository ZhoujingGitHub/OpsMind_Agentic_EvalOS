import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.mjs";
import { freezeSourceSnapshot } from "../../../packages/kernel/src/index.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const manifest = JSON.parse(readFileSync(path.join(ROOT, "config", "m15-smoke.manifest.json"), "utf8"));

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
    const health = await (await app.handler(new Request("http://local/health"))).json();
    assert.equal(health.contract, "evalos.5");
    assert.equal(health.milestone, "M3.0");
    const capabilities = await (await app.handler(new Request("http://local/api/runtime/capabilities"))).json();
    assert.equal(capabilities.runtime.model, "deepseek-v4-flash");
    assert.equal(capabilities.runtime.graphFramework, null);
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
    assert.equal(overview.contract, "evalos-workbench.3");
    assert.equal(overview.counts.experiments, 1);
    const workbenchTrials = await (await app.handler(new Request("http://local/api/workbench/trials", {
      headers: { authorization: "Bearer admin-secret" } }))).json();
    assert.equal(workbenchTrials.items.length, 12);
    assert.equal(workbenchTrials.items.some((item) => item.id === trialId && item.trace_records > 1 && item.grade?.total), true);
    assert.equal(JSON.stringify(workbenchTrials).includes("canonical_labels"), false);
    const workbenchTrial = await (await app.handler(new Request(`http://local/api/workbench/trials/${trialId}`, {
      headers: { authorization: "Bearer admin-secret" } }))).json();
    assert.equal(workbenchTrial.graders[0].result.rule.includes("工具名称"), true);
    assert.equal(JSON.stringify(workbenchTrial.graders).includes("canonical_labels"), false);
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
    const selectionBody = { request_kind: "RERUN_FROZEN", evaluation_purpose: "RERUN_FROZEN",
      mode: "QUICK_VALIDATION", source_experiment_id: firstBody.experiment.id,
      case_refs: [manifest.case_refs[0]], contestant_refs: manifest.contestants.map((item) => item.ref),
      repetitions: 1, requested_by: "api-test-operator", reason: "验证人工单题重新评测不会污染正式成绩" };
    const preflightResponse = await app.handler(new Request("http://local/api/workbench/run-requests/preflight", { method: "POST",
      headers: { authorization: "Bearer admin-secret", "content-type": "application/json" }, body: JSON.stringify(selectionBody) }));
    assert.equal(preflightResponse.status, 200);
    const preflight = (await preflightResponse.json()).preflight;
    assert.equal(preflight.ready, true);
    assert.equal(preflight.contract, "evalos-preflight.2");
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

test("Product Tool Bridge不能用控制面管理员Token绕过Trial限域令牌", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-api-product-bridge-"));
  const app = createApp({ databasePath: path.join(root, "control.sqlite"), privateLabelDatabasePath: path.join(root, "private.sqlite"),
    runtimeRoot: root, apiToken: "control-secret" });
  try {
    const request = (authorization) => app.handler(new Request("http://local/internal/product-tool-bridge", { method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ trial_id: "trial-forged", contract_digest: `sha256:${"a".repeat(64)}`,
        tool_name: "get_alerts", arguments: {} }) }));
    assert.equal((await request()).status, 401);
    assert.equal((await request("Bearer control-secret")).status, 401);
    const body = await (await request("Bearer forged-product-token")).json();
    assert.equal(body.error.code, "PRODUCT_TOOL_BRIDGE_TOKEN_INVALID");
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
        case_refs: ["M3-PUB-001@2.0.0"], contestant_refs: ["agent-harness-v2", "langgraph-v1"], repetitions: 1,
        requested_by: "api-test-operator", reason: "验证冻结设计可以生成预检但不会误启动正式评测" }) }));
    assert.equal(preflight.status, 200);
    const preflightBody = (await preflight.json()).preflight;
    assert.equal(preflightBody.total_trials, 6);
    assert.equal(preflightBody.affects_official_score, false);
    assert.equal(preflightBody.blockers.some((item) => item.includes("参评适配器未就绪")), true);
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
