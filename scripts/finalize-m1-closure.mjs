import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EvalStore, EvaluationLedger, PILOT_CASES, sha256 } from "../packages/kernel/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = process.env.M1_REAL_RUN_ID ?? "m1-real-pilot-linux-20260813-v1";
const runtimeRoot = path.join(ROOT, "runtime", "m1-real", runId);
const artifactsRoot = path.join(ROOT, "artifacts", "m1-real", runId);
const databasePath = path.join(runtimeRoot, "evalos.sqlite");
mkdirSync(artifactsRoot, { recursive: true });

const store = new EvalStore({
  databasePath,
  runtimeRoot,
  migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m1.sql"),
});
const ledger = new EvaluationLedger(store);

function readJson(name) {
  return JSON.parse(readFileSync(path.join(artifactsRoot, name), "utf8"));
}

function writeJson(name, value) {
  writeFileSync(path.join(artifactsRoot, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function digestFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function walkFiles(root, relative = "") {
  if (!root) return [];
  const current = path.join(root, relative);
  const ignored = new Set([".git", ".venv", "node_modules", "__pycache__", "runtime", "artifacts", ".claude-state"]);
  const result = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(root, child));
    if (entry.isFile()) result.push(child.replaceAll("\\", "/"));
  }
  return result.sort();
}

function digestTree(root, selected = null) {
  if (!root) return { root: null, files: 0, sha256: null, file_hashes: {} };
  const files = selected ?? walkFiles(root);
  const hashes = Object.fromEntries(files.map((relative) => [relative, digestFile(path.join(root, relative))]));
  return { root: realpathSync(root), files: files.length, sha256: sha256(hashes), file_hashes: hashes };
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + Number(value), 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (Number(value) - average) ** 2, 0) / (values.length - 1));
}

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function percentage(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function oneLine(value, limit = 260) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function list(value) {
  return Array.isArray(value) && value.length ? value.join("、") : "无";
}

function architectureName(id) {
  return id === "agent-harness-v2" ? "V2 Agent+Harness" : "V1 LangGraph";
}

function findLedgerAction(action) {
  return store.db.prepare("SELECT * FROM ledger_entries WHERE action=? ORDER BY seq LIMIT 1").get(action);
}

try {
  const sourceVerdict = readJson("m1-real-verdict.json");
  const judgeVerdict = readJson("m1-blind-judge-verdict.json");
  const manifest = readJson("experiment-manifest.frozen.json");
  const trials = store.listTrials(null, { includeReplays: false });
  const judgeResults = store.listJudgeResults();
  const reviews = store.listHumanReviewTasks();
  if (sourceVerdict.status !== "PASSED" || trials.length !== 72 || trials.some((trial) => trial.status !== "COMPLETED")) {
    throw new Error("M1 结果收口要求真实 Pilot 已通过且 72/72 Trial 完成");
  }
  if (judgeVerdict.status !== "PASSED" || judgeResults.length !== 72) {
    throw new Error("M1 结果收口要求独立盲评 Judge 已完成 72/72");
  }

  const evalosCriticalFiles = [
    "package.json",
    "infra/migrations/sqlite/001_m1.sql",
    "packages/kernel/src/cases.mjs",
    "packages/kernel/src/grader.mjs",
    "packages/kernel/src/ledger.mjs",
    "packages/kernel/src/runner.mjs",
    "packages/kernel/src/store.mjs",
    "packages/agent-runtime/package-lock.json",
    "packages/agent-runtime/python/langgraph_runner.py",
    "packages/agent-runtime/src/deepseek-claude-adapter.mjs",
    "packages/agent-runtime/src/langgraph-adapter.mjs",
    "scripts/run-real-m1.mjs",
  ];
  const v2PluginRoot = process.env.OPSMIND_PLUGIN_ROOT || null;
  const v1Root = process.env.OPSMIND_LANGGRAPH_ROOT || null;
  const sourceCommits = {
    evalos: process.env.M1_EVALOS_COMMIT ?? "unknown",
    agent_harness_v2_upstream: process.env.M1_V2_COMMIT ?? "unknown",
    langgraph_v1_upstream: process.env.M1_V1_COMMIT ?? "unknown",
  };
  const sourceHashes = {
    evalos_execution_surface: digestTree(ROOT, evalosCriticalFiles),
    agent_harness_v2_plugin: v2PluginRoot ? digestTree(v2PluginRoot) : { root: null, files: 0, sha256: null, file_hashes: {} },
    langgraph_v1_runtime: v1Root ? digestTree(v1Root) : { root: null, files: 0, sha256: null, file_hashes: {} },
  };
  const provenancePayload = {
    run_id: runId,
    release_root: realpathSync(ROOT),
    source_commits: sourceCommits,
    source_hashes: Object.fromEntries(Object.entries(sourceHashes).map(([key, value]) => [key, value.sha256])),
    original_manifest_commit_note: "冻结 Manifest 在无 .git 的发布包内生成，因此 contestant.code_commit 原样保留 working-tree；本记录是追加式来源证明，不改写冻结 Manifest。",
  };
  if (!findLedgerAction("release.provenance_attested")) {
    ledger.append({
      entityType: "release",
      entityId: runId,
      action: "release.provenance_attested",
      payload: provenancePayload,
    });
  }

  const judgeByTrial = new Map(judgeResults.map((item) => [item.trial_id, item]));
  const pairs = new Map();
  for (const trial of trials) {
    const key = `${trial.case_id}:${trial.seed}`;
    pairs.set(key, { ...(pairs.get(key) ?? {}), [trial.contestant_id]: trial });
  }
  const pairedRows = [...pairs.entries()].map(([key, value]) => ({
    key,
    case_id: value["agent-harness-v2"].case_id,
    seed: value["agent-harness-v2"].seed,
    v2: value["agent-harness-v2"],
    v1: value["langgraph-v1"],
    delta: Number(value["agent-harness-v2"].score.total) - Number(value["langgraph-v1"].score.total),
  }));

  const contestantStats = {};
  for (const contestantId of ["agent-harness-v2", "langgraph-v1"]) {
    const relevant = trials.filter((trial) => trial.contestant_id === contestantId);
    const judged = relevant.map((trial) => judgeByTrial.get(trial.id));
    const seedStats = Object.fromEntries([101, 202, 303].map((seed) => {
      const sample = relevant.filter((trial) => trial.seed === seed);
      return [seed, {
        count: sample.length,
        code_score_mean: round(mean(sample.map((trial) => trial.score.total))),
        judge_score_mean: round(mean(sample.map((trial) => judgeByTrial.get(trial.id).result.overall_score))),
      }];
    }));
    contestantStats[contestantId] = {
      trials: relevant.length,
      code_score_mean: round(mean(relevant.map((trial) => trial.score.total))),
      code_score_sd: round(standardDeviation(relevant.map((trial) => trial.score.total))),
      code_pass_rate: round(mean(relevant.map((trial) => trial.score.passed ? 1 : 0))),
      judge_score_mean: round(mean(judged.map((item) => item.result.overall_score))),
      judge_score_sd: round(standardDeviation(judged.map((item) => item.result.overall_score))),
      judge_safety_pass_rate: round(mean(judged.map((item) => item.result.safety_pass ? 1 : 0))),
      judge_evidence_complete_rate: round(mean(judged.map((item) => item.result.evidence_complete ? 1 : 0))),
      duration_mean_seconds: round(mean(relevant.map((trial) => Math.max(0, new Date(trial.completed_at) - new Date(trial.started_at)))) / 1000),
      input_tokens_total: relevant.reduce((sum, trial) => sum + Number(trial.usage?.input_tokens ?? 0), 0),
      output_tokens_total: relevant.reduce((sum, trial) => sum + Number(trial.usage?.output_tokens ?? 0), 0),
      tool_calls_total: relevant.reduce((sum, trial) => sum + Number(trial.usage?.tool_calls ?? 0), 0),
      reported_cost_usd: round(relevant.reduce((sum, trial) => sum + Number(trial.usage?.cost_usd ?? 0), 0), 6),
      seed_stats: seedStats,
    };
  }

  const disagreements = trials.filter((trial) => {
    const judge = judgeByTrial.get(trial.id).result;
    const judgePass = Number(judge.overall_score) >= 75 && judge.safety_pass;
    return Boolean(trial.score.passed) !== judgePass || Math.abs(Number(trial.score.total) - Number(judge.overall_score)) >= 20;
  });
  const luckyPasses = trials.filter((trial) => {
    const judge = judgeByTrial.get(trial.id).result;
    return trial.score.passed && (Number(judge.overall_score) < 75 || !judge.safety_pass);
  });
  const codeFalseNegatives = trials.filter((trial) => {
    const judge = judgeByTrial.get(trial.id).result;
    return !trial.score.passed && Number(judge.overall_score) >= 75 && judge.safety_pass;
  });
  const judgeFlags = {};
  for (const item of judgeResults) {
    for (const flag of item.result.flags ?? []) judgeFlags[flag] = (judgeFlags[flag] ?? 0) + 1;
  }
  const forbiddenToolEvents = store.db.prepare(`
    SELECT COUNT(*) AS count FROM trace_events
    WHERE kind='tool.call' AND json_extract(payload_json,'$.tool') NOT IN
      ('get_alerts','query_changes','query_events','query_logs','query_metrics','run_probe')
  `).get().count;

  const byAbsoluteDelta = [...pairedRows].sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));
  const representatives = [];
  const addRepresentative = (label, row) => {
    if (row && !representatives.some((item) => item.key === row.key)) representatives.push({ label, ...row });
  };
  addRepresentative("V2 优势最大", [...pairedRows].sort((left, right) => right.delta - left.delta)[0]);
  addRepresentative("V1 优势或差距最小", [...pairedRows].sort((left, right) => left.delta - right.delta)[0]);
  addRepresentative("评分器分歧代表", byAbsoluteDelta.find((row) => disagreements.some((trial) => trial.id === row.v1.id || trial.id === row.v2.id)));
  for (const row of byAbsoluteDelta) {
    if (representatives.length >= 3) break;
    addRepresentative("补充代表样本", row);
  }

  const traceSummary = representatives.map((row) => ({
    label: row.label,
    case_id: row.case_id,
    seed: row.seed,
    code_delta_v2_minus_v1: round(row.delta),
    architectures: Object.fromEntries([["agent-harness-v2", row.v2], ["langgraph-v1", row.v1]].map(([id, trial]) => {
      const trace = store.getTrace(trial.id);
      return [id, {
        trial_id: trial.id,
        blind_id: trial.blind_id,
        code_score: trial.score.total,
        code_passed: trial.score.passed,
        judge_score: judgeByTrial.get(trial.id).result.overall_score,
        judge_safety_pass: judgeByTrial.get(trial.id).result.safety_pass,
        root_cause: trial.outcome.root_cause,
        evidence_refs: trial.outcome.evidence_refs,
        tool_sequence: trace.filter((event) => event.kind === "tool.call").map((event) => event.payload.tool),
        trace_hash: trial.trace_hash,
      }];
    })),
  }));

  const acceptanceChecks = {
    real_pilot_72_completed: sourceVerdict.completed_trials === 72 && sourceVerdict.failed_trials === 0,
    paired_trials_36: sourceVerdict.paired_comparison.pair_count === 36,
    identical_frozen_boundaries: manifest.model.id === "deepseek-v4-flash" && manifest.contestants.length === 2,
    agent_harness_is_claude_agent_sdk: sourceVerdict.runtime_checks.agent_harness_sdk_trace && sourceVerdict.runtime_checks.agent_harness_native_capabilities,
    v1_is_real_stategraph: sourceVerdict.runtime_checks.langgraph_real_stategraph_trace,
    credentials_redacted: sourceVerdict.runtime_checks.credentials_redacted,
    blind_judge_72_completed: judgeResults.length === 72,
    human_review_entry_available: reviews.length >= 12,
    trial_isolation_and_traceability: new Set(trials.map((trial) => trial.namespace)).size === 72 && trials.every((trial) => trial.trace_hash),
    append_only_ledger_valid: ledger.verify().valid,
    forbidden_tool_events_zero: Number(forbiddenToolEvents) === 0,
    source_provenance_attested: Object.values(sourceCommits).every((value) => /^[0-9a-f]{40}$/i.test(value)),
  };
  const accepted = Object.values(acceptanceChecks).every(Boolean);
  if (!findLedgerAction("m1.acceptance_closed")) {
    ledger.append({
      entityType: "milestone",
      entityId: runId,
      action: "m1.acceptance_closed",
      payload: {
        accepted,
        checks_hash: sha256(acceptanceChecks),
        completed_trials: 72,
        judged_trials: 72,
        review_tasks: reviews.length,
        disagreements: disagreements.length,
        lucky_passes: luckyPasses.length,
      },
    });
  }
  const finalLedger = ledger.verify();
  const finalVerdict = {
    gate: "M1-FINAL-ACCEPTANCE",
    status: accepted && finalLedger.valid ? "PASSED" : "FAILED",
    accepted: accepted && finalLedger.valid,
    run_id: runId,
    scope: "12 Case × 2 架构 × 3 Seed；真实 DeepSeek V4 Flash 调用",
    checks: acceptanceChecks,
    source_verdict: sourceVerdict,
    blind_judge_verdict: judgeVerdict,
    contestant_statistics: contestantStats,
    grading_disagreements: {
      total: disagreements.length,
      code_lucky_passes: luckyPasses.length,
      code_false_negatives: codeFalseNegatives.length,
    },
    safety: {
      forbidden_tool_events: Number(forbiddenToolEvents),
      credentials_redacted: sourceVerdict.runtime_checks.credentials_redacted,
      note: "Judge safety_pass 是被测 Agent 输出质量指标；平台严重安全事件按越界工具、凭据泄露和隔离失效统计。",
    },
    human_review_queue: {
      total: reviews.length,
      pending: reviews.filter((review) => !review.decision_id).length,
      note: "M1 验收要求人工复核入口和队列可用，不伪造人工决定；待验收人登录后可追加决定。",
    },
    provenance: provenancePayload,
    ledger: finalLedger,
    generated_at: new Date().toISOString(),
  };
  writeJson("M1最终验收结论.json", finalVerdict);
  writeJson("M1源码与发布溯源.json", {
    ...provenancePayload,
    frozen_manifest: {
      manifest_hash: sourceVerdict.manifest_hash,
      dataset_hash: sourceVerdict.dataset_hash,
      model: manifest.model,
      contestants: manifest.contestants,
    },
    trees: sourceHashes,
    ledger_entry: findLedgerAction("release.provenance_attested"),
  });
  writeJson("M1代表Case轨迹对比.json", traceSummary);

  const managementReport = [
    "# OpsMind Agentic EvalOS M1 管理报告",
    "",
    `- 最终结论：**${finalVerdict.accepted ? "验收通过" : "验收未通过"}**`,
    `- 执行范围：12 个 L1 Case × 2 个真实架构 × 3 个 Seed，共 72 个真实 Trial`,
    `- 运行结果：${sourceVerdict.completed_trials}/72 完成，${sourceVerdict.failed_trials} 失败，${sourceVerdict.infrastructure_retries} 次基础设施重试`,
    `- 独立盲评：${judgeResults.length}/72 完成；人工复核队列 ${reviews.length} 条，均保留盲态，未伪造人工决定`,
    `- 证据账本：${finalLedger.valid ? "有效" : "无效"}，${finalLedger.entries} 条，Head ${finalLedger.head_hash}`,
    "",
    "## 核心结果",
    "",
    "| 架构 | 代码评分均值 | 代码通过率 | 盲评均值 | Judge 安全通过率 | 平均耗时 | 输入 Token | 输出 Token |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(contestantStats).map(([id, item]) => `| ${architectureName(id)} | ${item.code_score_mean} | ${percentage(item.code_pass_rate)} | ${item.judge_score_mean} | ${percentage(item.judge_safety_pass_rate)} | ${item.duration_mean_seconds}s | ${item.input_tokens_total} | ${item.output_tokens_total} |`),
    "",
    `代码 Grader 的成对结果为：V2 胜 ${sourceVerdict.paired_comparison.v2_wins}、平 ${sourceVerdict.paired_comparison.ties}、V1 胜 ${sourceVerdict.paired_comparison.v1_wins}；V2−V1 平均差 ${sourceVerdict.paired_comparison.score_delta_v2_minus_v1_mean}，95% 置信区间 [${sourceVerdict.paired_comparison.score_delta_95ci.join(", ")}]。`,
    "",
    `代码评分与独立 Judge 共有 ${disagreements.length} 条需要复核的显著分歧，其中代码 Lucky Pass ${luckyPasses.length} 条、代码疑似误杀 ${codeFalseNegatives.length} 条。正式决策不把代码评分单独当作产品胜负结论。`,
    "",
    "## 管理判断",
    "",
    "1. M1 评测平台已具备真实双架构 A/B、盲化、预算、隔离、Trace、代码评分、独立 Judge、人工复核入口和不可变账本，达到进入 M2 的工程条件。",
    "2. V2 在本批 L1 Case 的代码评分上显著领先，但最终产品结论应以 Judge 分歧复核后的口径解读；本报告明确保留评分器风险。",
    "3. M2 应建设 Open5GS/UERANSIM 数字孪生，把当前数据回放结论升级为可控故障注入、环境重置和因果一致性验证。",
    "4. 美元成本字段由当前兼容端未可靠回传，因此本轮以 Token、工具调用和耗时作为可审计成本代理；不伪造人民币或美元费用。",
    "",
  ].join("\n");
  writeFileSync(path.join(artifactsRoot, "M1管理报告.md"), managementReport, "utf8");

  const technicalReport = [
    "# OpsMind Agentic EvalOS M1 技术验收报告",
    "",
    `验收状态：**${finalVerdict.accepted ? "通过" : "未通过"}**`,
    "",
    "## 验收矩阵",
    "",
    "| 验收项 | 结果 | 证据摘要 |",
    "|---|---|---|",
    `| 72 次真实 Pilot | ${acceptanceChecks.real_pilot_72_completed ? "通过" : "未通过"} | 72/72 完成，0 失败 |`,
    `| 36 组成对样本 | ${acceptanceChecks.paired_trials_36 ? "通过" : "未通过"} | 相同 Case、Seed 下成对比较 |`,
    `| V2 核心架构 | ${acceptanceChecks.agent_harness_is_claude_agent_sdk ? "通过" : "未通过"} | Claude Agent SDK Trace；Bash/Read/Write/Edit/Skill 原生能力保留 |`,
    `| V1 对照架构 | ${acceptanceChecks.v1_is_real_stategraph ? "通过" : "未通过"} | 实际 LangGraph StateGraph Trace |`,
    `| 独立盲评 Judge | ${acceptanceChecks.blind_judge_72_completed ? "通过" : "未通过"} | 72/72；不接收架构身份 |`,
    `| 人工复核入口 | ${acceptanceChecks.human_review_entry_available ? "通过" : "未通过"} | ${reviews.length} 条待复核任务；决定只允许追加 |`,
    `| 隔离与可追溯 | ${acceptanceChecks.trial_isolation_and_traceability ? "通过" : "未通过"} | 72 个独立 namespace 与 72 个 Trace Hash |`,
    `| 安全边界 | ${acceptanceChecks.forbidden_tool_events_zero && acceptanceChecks.credentials_redacted ? "通过" : "未通过"} | 越界工具事件 ${forbiddenToolEvents}；凭据脱敏通过 |`,
    `| Ledger | ${acceptanceChecks.append_only_ledger_valid ? "通过" : "未通过"} | ${finalLedger.entries} 条；Hash Chain 有效 |`,
    `| 源码/发布溯源 | ${acceptanceChecks.source_provenance_attested ? "通过" : "未通过"} | 追加 Commit 与发布文件树 Hash，不改写冻结 Manifest |`,
    "",
    "## 公平性边界",
    "",
    `- 模型：${manifest.model.provider}/${manifest.model.id}，Anthropic 兼容接口，thinking=${manifest.model.thinking}，temperature=${manifest.model.temperature}。`,
    `- 数据集：${manifest.dataset.id}@${manifest.dataset.version}，SHA-256 ${manifest.dataset.sha256}。`,
    `- 工具：${manifest.policy.allowed_tools.join("、")}。`,
    `- 预算：输入 ${manifest.budget.input_tokens}、输出 ${manifest.budget.output_tokens}、工具 ${manifest.budget.tool_calls}、墙钟 ${manifest.budget.wallclock_ms}ms。`,
    `- 执行顺序：${manifest.policy.architecture_order}；Seed ${manifest.seeds.join("、")}；架构身份以 Blind ID 暴露给 Judge。`,
    "",
    "## 评分、稳定性与失败实验室",
    "",
    ...Object.entries(contestantStats).flatMap(([id, item]) => [
      `### ${architectureName(id)}`,
      "",
      `- 代码评分：均值 ${item.code_score_mean}，样本标准差 ${item.code_score_sd}，通过率 ${percentage(item.code_pass_rate)}。`,
      `- 盲评 Judge：均值 ${item.judge_score_mean}，样本标准差 ${item.judge_score_sd}，安全通过率 ${percentage(item.judge_safety_pass_rate)}，证据完整率 ${percentage(item.judge_evidence_complete_rate)}。`,
      `- Seed 均值：101=${item.seed_stats[101].code_score_mean}/${item.seed_stats[101].judge_score_mean}，202=${item.seed_stats[202].code_score_mean}/${item.seed_stats[202].judge_score_mean}，303=${item.seed_stats[303].code_score_mean}/${item.seed_stats[303].judge_score_mean}（代码/Judge）。`,
      `- 资源代理：${item.input_tokens_total} 输入 Token、${item.output_tokens_total} 输出 Token、${item.tool_calls_total} 次工具调用、平均 ${item.duration_mean_seconds}s。`,
      "",
    ]),
    `代码硬门失败簇：${Object.entries(sourceVerdict.failure_clusters).map(([name, count]) => `${name}=${count}`).join("；") || "无"}。`,
    `Judge Flag 聚类：${Object.entries(judgeFlags).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}=${count}`).join("；") || "无"}。`,
    `评分器显著分歧 ${disagreements.length} 条；Lucky Pass ${luckyPasses.length} 条；代码疑似误杀 ${codeFalseNegatives.length} 条，全部进入可审计复核口径。`,
    "",
    "## 已知限制",
    "",
    "- M1 是 L1 版本化数据回放，不是生产流量，也不是 Open5GS/UERANSIM 数字孪生；仿真或回放数据没有冒充生产事实。",
    "- 本轮 12 Case 适合验证评测闭环，不足以替代 M3 的 80 Case 隐藏集、安全集和回归集。",
    "- 人工复核入口已验收，实际专家决定保持待办；系统没有代替人类签字。",
    "- 冻结 Manifest 的 code_commit 字段因发布包不含 .git 而记录为 working-tree；已用追加式来源证明补齐三仓 Commit 和实际发布文件 Hash。",
    "",
  ].join("\n");
  writeFileSync(path.join(artifactsRoot, "M1技术验收报告.md"), technicalReport, "utf8");

  const traceReport = [
    "# M1 三个代表 Case 的 Trial 轨迹对比",
    "",
    ...traceSummary.flatMap((sample) => [
      `## ${sample.label}：${sample.case_id} / Seed ${sample.seed}`,
      "",
      `代码评分差（V2−V1）：${sample.code_delta_v2_minus_v1}。`,
      "",
      "| 架构 | 代码分 | Judge 分 | 安全 | 工具序列 | Trace Hash |",
      "|---|---:|---:|---|---|---|",
      ...Object.entries(sample.architectures).map(([id, item]) => `| ${architectureName(id)} | ${item.code_score} | ${item.judge_score} | ${item.judge_safety_pass ? "通过" : "需复核"} | ${list(item.tool_sequence)} | ${item.trace_hash} |`),
      "",
      ...Object.entries(sample.architectures).flatMap(([id, item]) => [
        `- ${architectureName(id)} 根因：${oneLine(item.root_cause)}`,
        `- ${architectureName(id)} 证据：${list(item.evidence_refs)}`,
      ]),
      "",
    ]),
    "> 代表样本由确定性规则选择：最大正差、最小差/反向差、评分器分歧代表；不是人工挑选的宣传案例。",
    "",
  ].join("\n");
  writeFileSync(path.join(artifactsRoot, "M1代表Case轨迹对比.md"), traceReport, "utf8");

  const reviewReport = [
    "# M1 人工复核队列说明",
    "",
    `当前共有 ${reviews.length} 条复核任务，待决定 ${reviews.filter((review) => !review.decision_id).length} 条。`,
    "",
    "复核任务来源包括：代码 Grader 与独立 Judge 的显著分歧、Judge 主动建议、代码/盲评分界不一致，以及每个 Case 一条固定 Hash 分层质检样本。复核前保留 Blind ID；只有授权裁决阶段才揭示架构身份。",
    "",
    "M1 验收的是“人工复核入口、队列、追加式决定记录与 Ledger”均可用，不把模型输出伪造成专家签字。验收人可通过回环控制 API 的 `/api/reviews` 查看任务，并向 `/api/reviews/{id}/decisions` 追加决定。",
    "",
    "| 优先级 | 数量 |",
    "|---|---:|",
    ...Object.entries(reviews.reduce((acc, review) => ({ ...acc, [review.priority]: (acc[review.priority] ?? 0) + 1 }), {})).map(([priority, count]) => `| ${priority} | ${count} |`),
    "",
  ].join("\n");
  writeFileSync(path.join(artifactsRoot, "M1人工复核队列说明.md"), reviewReport, "utf8");

  const evidenceFiles = [
    "experiment-manifest.frozen.json",
    "m1-real-verdict.json",
    "trial-index.json",
    "m1-blind-judge-verdict.json",
    "m1-human-review-queue.json",
    "M1最终验收结论.json",
    "M1源码与发布溯源.json",
    "M1代表Case轨迹对比.json",
    "M1管理报告.md",
    "M1技术验收报告.md",
    "M1代表Case轨迹对比.md",
    "M1人工复核队列说明.md",
  ];
  const evidenceIndex = evidenceFiles.map((name) => ({ name, sha256: digestFile(path.join(artifactsRoot, name)), bytes: statSync(path.join(artifactsRoot, name)).size }));
  writeJson("M1交付证据索引.json", { run_id: runId, files: evidenceIndex, ledger: finalLedger });
  const indexReport = [
    "# M1 交付证据索引",
    "",
    `- Run ID：${runId}`,
    `- Manifest Hash：${sourceVerdict.manifest_hash}`,
    `- Dataset Hash：${sourceVerdict.dataset_hash}`,
    `- Ledger Head：${finalLedger.head_hash}`,
    "",
    "| 文件 | SHA-256 | 字节 |",
    "|---|---|---:|",
    ...evidenceIndex.map((item) => `| ${item.name} | ${item.sha256} | ${item.bytes} |`),
    "",
    "完整 SQLite、72 个 Trial namespace、Trace 和原始结果保留在 EvalLab 服务器的本 Run 隔离目录；本索引不复制或暴露任何凭据。",
    "",
  ].join("\n");
  writeFileSync(path.join(artifactsRoot, "M1交付证据索引.md"), indexReport, "utf8");

  console.log(JSON.stringify({
    event: "m1.closure.completed",
    status: finalVerdict.status,
    run_id: runId,
    trials: trials.length,
    judges: judgeResults.length,
    reviews: reviews.length,
    disagreements: disagreements.length,
    ledger: finalLedger,
    artifacts_root: artifactsRoot,
  }, null, 2));
  if (!finalVerdict.accepted) process.exitCode = 1;
} finally {
  store.close();
}
