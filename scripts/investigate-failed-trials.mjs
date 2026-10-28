// Run the read-only AI investigator on every failed trial of a closed experiment (28 甲).
//
//   EVALOS_API_TOKEN=... node scripts/investigate-failed-trials.mjs <experiment-id> [--limit N]
//
// One investigation at a time: each is an agent loop with its own budget, and a
// burst would only trade a few minutes for a pile of rate-limit failures. A trial
// that already has a completed investigation is skipped, so the script can be
// re-run after an interruption. Investigations never change a score; their
// issue categories feed the report card's error taxonomy.
const [experimentId, ...rest] = process.argv.slice(2);
const limitAt = rest.indexOf("--limit");
const limit = limitAt >= 0 ? Number(rest[limitAt + 1]) : Number.POSITIVE_INFINITY;
const origin = process.env.EVALOS_API_ORIGIN ?? "http://127.0.0.1:8787";
const token = process.env.EVALOS_API_TOKEN;
if (!experimentId || !token) throw new Error("usage: EVALOS_API_TOKEN=... investigate-failed-trials.mjs <experiment-id> [--limit N]");

async function api(pathname, init = {}) {
  const response = await fetch(new URL(pathname, origin), { ...init, headers: { authorization: `Bearer ${token}`,
    "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status} ${body.error ?? ""}`);
  return body;
}

const PROMPT = "这场考试没有通过。请结合本 Trial 的任务、完整轨迹、按调查顺序排列的硬门漏斗和冻结源码，"
  + "找出它第一个出错的步骤和根本原因；区分是考生推理、工具设计、上下文、环境还是评分器的问题，"
  + "并给出按优先级排序、可验证的改进建议。不要把所有问题都归为提示词。";

const detail = await api(`/api/workbench/experiments/${encodeURIComponent(experimentId)}`);
const failed = detail.trials.filter((trial) => trial.status === "COMPLETED" && trial.grade && trial.grade.passed === false);
const done = [];
for (const trial of failed.slice(0, limit)) {
  const existing = (trial.analysis_runs ?? []).find((item) => item.status === "COMPLETED");
  if (existing) { done.push({ trial_id: trial.id, analysis_id: existing.id, status: "ALREADY_COMPLETED" }); continue; }
  const started = await api("/api/analysis-runs", { method: "POST", headers: { "idempotency-key": `failed-trial-${trial.id}` },
    body: JSON.stringify({ trial_id: trial.id, mode: "case_diagnosis", prompt: PROMPT, requested_by: "evalos-failure-review" }) });
  let analysis = started.analysis;
  const deadline = Date.now() + 15 * 60 * 1000;
  while (["QUEUED", "RUNNING"].includes(analysis.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    analysis = (await api(`/api/analysis-runs/${encodeURIComponent(analysis.id)}`)).analysis;
  }
  done.push({ trial_id: trial.id, case_ref: trial.case_ref, analysis_id: analysis.id, status: analysis.status });
  console.error(`[investigate] ${trial.case_ref} ${analysis.status}`);
}
console.log(JSON.stringify({ experiment_id: experimentId, failed_trials: failed.length, investigations: done }, null, 2));
