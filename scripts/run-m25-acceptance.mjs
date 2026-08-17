import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { containsSensitiveMaterial, freezeSourceSnapshot } from "../packages/kernel/src/index.mjs";
import { createApp } from "../services/control-api/src/app.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "evalos-m25-acceptance-"));
const outputRoot = path.resolve(process.env.M25_ACCEPTANCE_OUTPUT ?? path.join(ROOT, "artifacts", "m25"));
mkdirSync(outputRoot, { recursive: true });
const apiToken = "m25-test";
const fakeInvestigator = { analyze: async ({ analysisRunId }) => ({ result: {
  summary: "M2.5 调查平面合同验证完成", diagnosis: "该样本用于验证平台记录与只读边界，不形成模型能力结论。",
  score_interpretation: "正式成绩由确定性 Code Grader 保持不变。", strengths: [{ title: "证据可追溯", evidence_refs: [analysisRunId], explanation: "分析绑定已完成 Trial。" }],
  issues: [{ severity: "info", category: "measurement", title: "L0测试替身", evidence_refs: [analysisRunId],
    analysis: "本次只验证平台合同。", recommendation: "云端使用真实 DeepSeek 调查补齐。", confidence: 1 }],
  optimization_plan: [{ priority: 1, title: "真实分析验收", why: "证明付费模型链路", how: "在真实 M2 Trial 运行", validation: "检查 SDK 轨迹和引用" }],
  methodology_sources: [], limitations: ["确定性测试替身，非付费模型调用"], confidence: 1,
}, usage: { test_double: true, turns: 1 } }) };
const app = createApp({ databasePath: path.join(runtimeRoot, "control.sqlite"),
  privateLabelDatabasePath: path.join(runtimeRoot, "private", "labels.sqlite"), runtimeRoot,
  apiToken, caseInvestigator: fakeInvestigator });
const auth = { authorization: `Bearer ${apiToken}` };

try {
  const manifest = { manifest_version: "3.0", design: "single_system_acceptance", name: "M2.5 工作台合同验收",
    suite_ref: "m15-kernel-smoke@1.0.0", dataset_ref: "m15-l0-test-doubles@1.0.0",
    case_refs: ["SMOKE-RCA-001@1.0.0"], environment_seed: 20260814, replicates: 1,
    contestants: [{ ref: "mock-contestant-a", adapter_version: "deterministic-test-double",
      source_revision: "m25-contract-fixture", artifact_digest: `sha256:${"a".repeat(64)}` }],
    model: { provider: "deterministic-test-double", id: "fixture", interface: "test", temperature: 0 },
    budget: { input_tokens: 1000, output_tokens: 1000, tool_calls: 8, wallclock_ms: 30000, compute_ms: 30000, storage_bytes: 1048576 },
    policy: { allowed_tools: ["get_alerts", "query_logs", "query_metrics", "run_probe"], allowed_native_tools: [],
      forbidden_actions: ["read_hidden_answer"], heartbeat_ms: 1000 } };
  const create = await app.handler(new Request("http://local/api/experiments", { method: "POST", headers: {
    ...auth, "content-type": "application/json", "idempotency-key": "m25-contract-acceptance" }, body: JSON.stringify({ manifest }) }));
  const experiment = (await create.json()).experiment;
  const runResponse = await app.handler(new Request(`http://local/api/experiments/${experiment.id}/run`, { method: "POST", headers: auth }));
  const runBody = await runResponse.json();
  const trial = app.store.listTrials(experiment.id)[0];
  if (trial.status !== "COMPLETED") throw new Error(`fixture Trial did not complete (${runResponse.status}): ${JSON.stringify({ runBody, trial })}`);
  const frozen = freezeSourceSnapshot({ roots: [{ path: path.join(ROOT, "packages", "agent-runtime", "src"), prefix: "agent-runtime" }],
    storageRoot: path.join(runtimeRoot, "source-snapshots"), contestantRef: trial.contestant_ref,
    sourceRevision: "m25-contract-fixture", artifactDigest: `sha256:${"a".repeat(64)}` });
  const snapshot = app.store.registerSourceSnapshot({ contestantRef: trial.contestant_ref, sourceRevision: "m25-contract-fixture",
    artifactDigest: `sha256:${"a".repeat(64)}`, treeHash: frozen.tree_hash, storagePath: frozen.storage_path, files: frozen.files });
  app.store.attachTrialSourceSnapshot(trial.id, snapshot.snapshot_ref);
  const start = await app.handler(new Request("http://local/api/analysis-runs", { method: "POST", headers: {
    ...auth, "content-type": "application/json", "idempotency-key": "m25-analysis-acceptance" },
    body: JSON.stringify({ trial_id: trial.id, mode: "case_diagnosis", prompt: "验证只读调查合同" }) }));
  const startBody = await start.json();
  if (!startBody.analysis) throw new Error(`M2.5 analysis start failed (${start.status}): ${JSON.stringify(startBody)}`);
  const analysisId = startBody.analysis.id;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const overview = await (await app.handler(new Request("http://local/api/workbench/overview", { headers: auth }))).json();
  const detail = await (await app.handler(new Request(`http://local/api/workbench/trials/${trial.id}`, { headers: auth }))).json();
  const trace = await (await app.handler(new Request(`http://local/api/workbench/trials/${trial.id}/trace`, { headers: auth }))).json();
  const source = await (await app.handler(new Request(`http://local/api/workbench/trials/${trial.id}/source`, { headers: auth }))).json();
  const analysis = await (await app.handler(new Request(`http://local/api/analysis-runs/${analysisId}`, { headers: auth }))).json();
  const checks = {
    api_contract_evalos_4: (await (await app.handler(new Request("http://local/health"))).json()).contract === "evalos.4",
    dynamic_overview_uses_database: overview.counts.experiments === 1 && overview.counts.trials === 1,
    trial_detail_has_outcome_and_environment: Boolean(detail.trial.outcome) && Boolean(detail.trial.final_state),
    complete_trace_visible: trace.items.length > 0 && /^[a-f0-9]{64}$/.test(detail.evidence.trace_hash),
    grader_detail_visible_without_hidden_label: detail.graders.length === 1 && !JSON.stringify(detail.graders).includes("canonical_labels"),
    frozen_source_bound_and_readable: source.snapshot.tree_hash === snapshot.tree_hash && source.snapshot.files.length > 0,
    analysis_is_separate_and_completed: analysis.analysis.status === "COMPLETED" && analysis.analysis.result.summary.includes("合同验证"),
    official_grade_unchanged: app.store.listGraderRuns(trial.id)[0].result.total === detail.graders[0].result.total,
    append_only_ledger_valid: app.ledger.verify().valid,
    credential_material_absent: !containsSensitiveMaterial({ overview, detail, trace, source: { ...source, snapshot: {
      ...source.snapshot, files: source.snapshot.files.map(({ path: filePath, sha256 }) => ({ path: filePath, sha256 })) } }, analysis }),
    l0_test_double_labeled_not_paid_call: analysis.analysis.usage.test_double === true,
  };
  const result = { contract: "evalos-m25-acceptance.1", gate: "M2.5", status: Object.values(checks).every(Boolean) ? "PASSED" : "FAILED",
    execution: "L0 确定性平台测试替身；只验工作台合同，不代表 DeepSeek 能力或付费模型调用", checks,
    counts: overview.counts, trial_id: trial.id, analysis_run_id: analysisId, source_snapshot_ref: snapshot.snapshot_ref };
  writeFileSync(path.join(outputRoot, "M2.5测量系统加固验收结论.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(path.join(outputRoot, "M2.5测量系统加固验收报告.md"), ["# M2.5 测量系统加固验收报告", "",
    `- 结论：**${result.status}**`, `- 执行性质：${result.execution}`, "- 说明：云端最终门禁还必须在真实 M2 Trial 上运行 Claude Agent SDK + DeepSeek AI 调查员。", "", "## 检查项", "",
    ...Object.entries(checks).map(([name, passed]) => `- ${passed ? "通过" : "失败"}：${name}`), ""].join("\n"), "utf8");
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "PASSED") process.exitCode = 1;
} finally { app.close(); }
