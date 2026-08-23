"use client";
/* The workbench renders versioned EvalOS JSON contracts whose nested payloads vary by grader and evidence kind. */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* Native anchors are intentional: the current Vinext server intercepts next/link clicks without completing navigation. */
/* eslint-disable @next/next/no-html-link-for-pages */

import { useCallback, useEffect, useMemo, useState } from "react";

type Json = Record<string, any>;
type View = "dashboard" | "datasets" | "experiments" | "experiment" | "trial" | "traces" | "graders" | "analyses" | "run-requests";

const DIMENSION_LABELS: Record<string, string> = {
  task_success: "任务终态", rca_quality: "根因质量", evidence_quality: "证据质量", trajectory_quality: "轨迹质量",
  open_world: "开放环境", proactive_capability: "主动发现", resource_cost: "资源成本", engineering_agility: "工程敏捷",
};
const STATUS_LABELS: Record<string, string> = { COMPLETED: "已完成", RUNNING: "运行中", QUEUED: "排队中", FAILED: "失败",
  PASSED: "通过", IN_PROGRESS: "进行中", CANCELLED: "已取消", FROZEN: "设计已冻结" };

async function requestJson(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `请求失败（${response.status}）`);
  return body;
}

function useRemote(url: string | null) {
  const [data, setData] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(Boolean(url));
  const refresh = useCallback((silent = false) => {
    if (!url) return Promise.resolve();
    if (!silent) setLoading(true);
    return requestJson(url).then(setData).catch((reason) => setError(reason.message)).finally(() => { if (!silent) setLoading(false); });
  }, [url]);
  useEffect(() => {
    if (!url) return;
    let active = true;
    void requestJson(url).then((value) => { if (active) setData(value); }).catch((reason) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [url]);
  return { data, error, loading, refresh };
}

export function Workbench({ view, id, analysisId }: { view: View; id?: string; analysisId?: string }) {
  return <div className="app-frame"><Sidebar active={view} /><main className="main-stage">
    <Topbar view={view} />
    {view === "dashboard" && <Dashboard />}
    {view === "datasets" && <Datasets />}
    {view === "experiments" && <Experiments />}
    {view === "experiment" && id && <ExperimentDetail id={id} />}
    {view === "trial" && id && <TrialDetail id={id} analysisId={analysisId} />}
    {view === "traces" && <TrialCenter mode="traces" />}
    {view === "graders" && <TrialCenter mode="graders" />}
    {view === "analyses" && <TrialCenter mode="analyses" />}
    {view === "run-requests" && <EvaluationTaskCenter />}
  </main></div>;
}

function Sidebar({ active }: { active: View }) {
  return <aside className="sidebar">
    <a className="side-brand" href="/"><span className="logo-cube">EO</span><span><strong>OpsMind</strong><small>Agentic EvalOS</small></span></a>
    <nav className="side-nav" aria-label="主导航">
      <Nav href="/" label="实验概览" icon="◫" active={active === "dashboard"} />
      <Nav href="/experiments" label="实验运行" icon="◎" active={["experiments", "experiment", "trial"].includes(active)} />
      <Nav href="/datasets" label="数据集与 Case" icon="▦" active={active === "datasets"} />
      <Nav href="/run-requests" label="评测任务" icon="▶" active={active === "run-requests"} />
    </nav>
    <div className="side-section">分析与治理</div>
    <nav className="side-nav muted-nav">
      <Nav href="/traces" label="轨迹与日志" icon="⌁" active={active === "traces"} />
      <Nav href="/graders" label="评分器中心" icon="◇" active={active === "graders"} />
      <Nav href="/analyses" label="AI 调查员" icon="✦" active={active === "analyses"} />
    </nav>
    <div className="side-spacer" />
    <div className="core-card"><span className="live-dot" /><strong>核心运行时</strong><p>Claude Agent SDK<br/>DeepSeek V4 Flash</p><small>无静态工作流图</small></div>
  </aside>;
}

function Nav({ href, label, icon, active }: { href: string; label: string; icon: string; active: boolean }) {
  return <a href={href} className={active ? "active" : ""}><span>{icon}</span>{label}</a>;
}

function Topbar({ view }: { view: View }) {
  const names: Record<View, string> = { dashboard: "实验概览", datasets: "数据集与 Case", experiments: "实验运行",
    experiment: "实验详情", trial: "单次评测（Trial）研究工作台", traces: "轨迹与日志", graders: "评分器中心", analyses: "AI 调查员",
    "run-requests": "评测任务（Evaluation Tasks）" };
  return <header className="workbench-top"><div><span className="crumb">EvalOS / </span>{names[view]}</div>
    <div className="top-meta"><span className="phase-tag">M3.1 · 真实产品评测升级 · 480 Trial 未开考</span><span className="operator">操作者</span></div></header>;
}

function Dashboard() {
  const { data, error, loading } = useRemote("/api/workbench/overview");
  const candidateReadiness = useRemote("/api/workbench/candidate-readiness");
  const operationsHealth = useRemote("/api/workbench/operations-health");
  const counts = data?.counts ?? {};
  return <section className="page-content">
    <div className="page-intro"><div><span className="kicker">OBSERVE · EXPLAIN · IMPROVE</span><h1>把每次评测，变成<br/>可追溯的改进证据。</h1><p>从数据集到源码，从工具轨迹到逐维评分，再到只读 AI 深度调查——所有结论都能回到真实 Trial。</p></div>
      <div className="truth-card"><span>评测核心</span><strong>Agent 自主求解<br/>Harness 守住规则</strong><p>不按固定工具名、不按预设步骤评分。官方分数只来自确定性 Code Grader。</p></div></div>
    {error && <ErrorBox text={error} />}
    <div className="authority-banner"><strong>真实评测边界</strong><p>正式通道只向两套外部 OpsMind 产品提交同一道 Case，EvalOS 不在内部复制考生、也不替考生调用 MCP。测试替身仅用于工程自测，并会在页面上明确标注。</p></div>
    {operationsHealth.error && <ErrorBox text={operationsHealth.error} />}
    {operationsHealth.data && <div className={`operations-banner ${operationsHealth.data.status === "ok" ? "healthy" : "degraded"}`}>
      <div><span>平台运行健康（Operations health）</span><strong>{operationsHealth.data.status === "ok" ? "可以继续资格/容量试运行" : "发现阻塞问题，暂停正式开考"}</strong><p>{operationsHealth.data.explanation_zh}</p></div>
      <div className="operations-kpis"><Mini label="运行中任务" value={operationsHealth.data.requests.running} /><Mini label="未清理考场" value={operationsHealth.data.evidence.unresolved_cleanup_trials} /><Mini label="用量未完整上报" value={operationsHealth.data.evidence.incomplete_candidate_usage_trials} /><Mini label="证据账本" value={operationsHealth.data.ledger.valid ? "完整" : "异常"} /></div>
    </div>}
    <section className="surface"><SectionHead title="真实考生开考状态" sub="Candidate readiness · 这里检查的是外部产品，不是 EvalOS 内部考生分身" />
      {candidateReadiness.error && <ErrorBox text={candidateReadiness.error} />}
      <div className="dataset-cards">{(candidateReadiness.data?.items ?? []).map((item: Json) => <div className={`dataset-card ${item.ready ? "selected" : ""}`} key={item.ref}>
        <span className={`level ${item.ready ? "level-l1" : "level-l2"}`}>{item.ready ? "就绪" : "阻塞"}</span><strong>{contestantDisplayName(item.ref)}</strong><small>{item.architecture ?? "外部真实产品"}</small>
        <div><b>{item.status_label}</b></div><p>{item.explanation}</p>
        <small>数字孪生（Twin）：{item.twin?.ready ? "已连接" : item.twin?.required ? "未就绪" : "本次不需要"}</small>
        <small>候选最长运行：{item.budget?.candidate_max_run_ms ? formatDuration(item.budget.candidate_max_run_ms) : "产品接口暂未公开"} · Trial 预算：{item.budget?.trial_wallclock_ms ? formatDuration(item.budget.trial_wallclock_ms) : "未冻结"}</small>
        <code>{item.source_revision ? shortHash(item.source_revision) : "未配置凭据"}</code></div>)}</div>
      <p className="diagnostic-note">480 次正式 Trial 仍未放行；这里显示“就绪”只代表可以进入少量、不计分的资格试运行。</p></section>
    <div className="metric-row">
      <Metric label="冻结数据集" value={loading ? "—" : counts.datasets ?? 0} foot={`${counts.cases ?? 0} 个版本化 Case`} href="/datasets" />
      <Metric label="实验记录" value={loading ? "—" : counts.experiments ?? 0} foot={`${counts.completed_trials ?? 0}/${counts.trials ?? 0} Trial 完成 · 含明确标注的工程测试`} href="/experiments" />
      <Metric label="正式均分" value={formatScore(data?.score?.average)} foot={`${data?.score?.passed ?? 0}/${data?.score?.graded ?? 0} 通过硬门禁`} href="/graders" />
      <Metric label="AI 调查" value={counts.analysis_runs ?? 0} foot="只读 · 不改官方分数" accent href="/analyses" />
    </div>
    <div className="split-grid dashboard-grid"><section className="surface"><SectionHead title="最近实验" sub="真实数据，不再是静态演示卡片" action={<a href="/experiments">查看全部 →</a>} />
      <ExperimentTable items={data?.experiments ?? []} compact /></section>
      <aside className="surface method-panel"><SectionHead title="三层判定" sub="谁能决定什么，一眼看清" />
        <Authority n="01" title="Code Grader" badge="正式" text="按终态、证据、轨迹、预算和安全硬门禁确定官方成绩。" />
        <Authority n="02" title="Agent Judge" badge="辅助" text="发现评分分歧和可疑样本，不覆盖代码评分。" />
        <Authority n="03" title="AI 调查员" badge="诊断" text="查轨迹、读冻结源码、对照权威方法论，提出可验证优化。" />
      </aside></div>
  </section>;
}

function Datasets() {
  const datasets = useRemote("/api/workbench/datasets");
  const cases = useRemote("/api/workbench/cases");
  const [selectedDataset, setSelectedDataset] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [selectedCases, setSelectedCases] = useState<Set<string>>(new Set());
  const [composerOpen, setComposerOpen] = useState(false);
  const filtered = useMemo(() => (cases.data?.items ?? []).filter((item: Json) => {
    if (selectedDataset && item.dataset_ref !== selectedDataset) return false;
    if (statusFilter === "NEVER_RUN") return item.trial_count === 0;
    if (statusFilter === "FAILED") return item.latest_status === "FAILED" || (item.pass_rate !== null && item.pass_rate < 1);
    if (statusFilter === "LOW_SCORE") return item.average_score !== null && item.average_score < 80;
    if (statusFilter === "INFRA") return item.infrastructure_failed;
    if (statusFilter === "UNSTABLE") return item.unstable;
    if (statusFilter === "SAFETY") return item.safety_failed;
    return true;
  }), [cases.data, selectedDataset, statusFilter]);
  const selectedItems = (cases.data?.items ?? []).filter((item: Json) => selectedCases.has(item.case_ref));
  const selectedDatasetCount = new Set(selectedItems.map((item: Json) => item.dataset_ref)).size;
  const toggle = (caseRef: string) => setSelectedCases((current) => { const next = new Set(current); if (next.has(caseRef)) next.delete(caseRef); else next.add(caseRef); return next; });
  const selectVisible = () => setSelectedCases(new Set(filtered.map((item: Json) => item.case_ref)));
  return <section className="page-content"><PageTitle eyebrow="FROZEN TEST MATERIAL" title="数据集与评测题目（Case）" text="每个版本都有来源、等级、适用边界和哈希。评测题目（Case）只规定要解决的问题，不会写死 Agent 的求解步骤。" />
    {(datasets.error || cases.error) && <ErrorBox text={datasets.error || cases.error} />}
    <div className="dataset-cards">{(datasets.data?.items ?? []).map((item: Json) => <button key={item.dataset_ref}
      aria-pressed={selectedDataset === item.dataset_ref} aria-label={`筛选数据集 ${item.dataset_id}`}
      className={`dataset-card ${selectedDataset === item.dataset_ref ? "selected" : ""}`} onClick={() => { setSelectedDataset(selectedDataset === item.dataset_ref ? "" : item.dataset_ref); setSelectedCases(new Set()); }}>
      <span className={`level level-${item.level?.toLowerCase()}`}>{item.level}</span><strong>{item.dataset_id}</strong><small>{item.version}</small>
      <div><b>{item.case_count}</b> 题（Case） <b>{item.trial_count}</b> 次（Trial）</div><code>{shortHash(item.public_hash)}</code></button>)}</div>
    <section className="surface"><SectionHead title={selectedDataset ? `评测题目（Case）· ${selectedDataset}` : "全部评测题目（Case）"} sub={`${filtered.length} 道版本化考题`}
      action={<div className="case-filters"><select aria-label="按运行状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
        <option value="ALL">全部状态（All）</option><option value="NEVER_RUN">从未运行（Never run）</option><option value="FAILED">失败/未通过（Failed）</option>
        <option value="LOW_SCORE">低分（Low score）</option><option value="INFRA">基础设施失败（Infrastructure）</option><option value="UNSTABLE">结果不稳定（Unstable）</option><option value="SAFETY">安全门禁失败（Safety）</option>
      </select></div>} />
      <div className="selection-toolbar"><div><strong>已选 {selectedCases.size} 道题</strong><small>你选择“考什么”；Agent 仍自主决定“怎么解决”。</small></div><div>
        <button onClick={selectVisible}>选择当前筛选结果</button><button onClick={() => setSelectedCases(new Set())}>清空</button>
        <button className="toolbar-primary" title={selectedDatasetCount > 1 ? "一次评测只能使用同一冻结数据集，请先选择一个数据集" : ""} disabled={!selectedCases.size || selectedDatasetCount !== 1} onClick={() => setComposerOpen(true)}>{selectedDatasetCount > 1 ? "请先限定一个数据集" : "＋ 新建评测 →"}</button></div></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th><input type="checkbox" aria-label="选择当前页全部题目" checked={filtered.length > 0 && filtered.every((item: Json) => selectedCases.has(item.case_ref))} onChange={(event) => event.target.checked ? selectVisible() : setSelectedCases(new Set())} /></th><th>评测题目（Case）</th><th>目标场景</th><th>工作模式</th><th>领域 / 等级</th><th>评测次数（Trial）</th><th>均分</th><th>最近证据</th></tr></thead><tbody>
        {filtered.map((item: Json) => <tr key={item.case_ref} className={item.latest_trial_id ? "clickable-row" : ""}
          role={item.latest_trial_id ? "link" : undefined} tabIndex={item.latest_trial_id ? 0 : undefined}
          aria-label={item.latest_trial_id ? `打开 ${item.case_id} 的最近 Trial` : undefined}
          onClick={(event) => item.latest_trial_id && navigateRow(event, `/trials/${item.latest_trial_id}`)}
          onKeyDown={(event) => item.latest_trial_id && navigateRowByKeyboard(event, `/trials/${item.latest_trial_id}`)}>
          <td><input type="checkbox" aria-label={`选择 ${item.case_id}`} checked={selectedCases.has(item.case_ref)} onChange={() => toggle(item.case_ref)} onClick={(event) => event.stopPropagation()} /></td>
          <td><strong>{item.case_id}</strong><small>{item.version}</small></td><td className="goal-cell">{item.goal}</td><td><Tag>{operationModeLabel(item.operating_mode)}</Tag></td>
          <td><Tag>{item.metadata?.domain ?? "通用"}</Tag><small>{item.level ?? "—"}</small></td><td>{item.completed_trials}/{item.trial_count}</td><td>{formatScore(item.average_score)}</td>
          <td>{item.latest_trial_id ? <a className="text-link" href={`/trials/${item.latest_trial_id}`}>查看单次评测（Trial）→</a> : "尚未运行"}</td></tr>)}</tbody></table></div>
    </section>{composerOpen && <RunComposer intent="new" caseRefs={[...selectedCases]} defaultExperimentId={selectedItems[0]?.compatible_experiment_id} datasetRef={selectedItems[0]?.dataset_ref} onClose={() => setComposerOpen(false)} />}</section>;
}

function Experiments() {
  const { data, error } = useRemote("/api/workbench/experiments");
  const items = data?.items ?? [];
  return <section className="page-content"><PageTitle eyebrow="REPRODUCIBLE EVAL RUNS" title="实验运行" text="一份冻结 Manifest 对应一次实验；数据、代码、预算、种子、身份状态和结果哈希都可审计。" />
    {error && <ErrorBox text={error} />}<div className="metric-row three"><Metric label="实验总数" value={items.length} foot="含单系统验收与双架构资格" href="#experiment-list" />
      <Metric label="已收口" value={items.filter((item: Json) => ["COMPLETED","FAILED","CANCELLED"].includes(item.status)).length} foot="成功、失败或取消都已有明确终态" href="#experiment-list" />
      <Metric label="AI 调查运行" value={items.reduce((sum: number, item: Json) => sum + Number(item.analyses ?? 0), 0)} foot="成功和失败都保留审计，不影响官方成绩" accent href="/analyses" /></div>
    <section className="surface" id="experiment-list"><SectionHead title="实验列表" sub="点击任意一行进入实验详情" /><ExperimentTable items={items} /></section></section>;
}

function ExperimentTable({ items, compact = false }: { items: Json[]; compact?: boolean }) {
  return <div className="table-scroll"><table className="data-table experiments-table"><thead><tr><th>实验</th><th>设计 / 模型</th><th>数据集</th><th>进度</th><th>均分</th>{!compact && <th>源码版本</th>}<th>状态</th></tr></thead><tbody>
    {items.length === 0 && <tr><td colSpan={compact ? 6 : 7}><Empty text="还没有已导入的真实实验" /></td></tr>}
    {items.map((item) => <tr key={item.id} className="clickable-row" role="link" tabIndex={0} aria-label={`打开实验 ${item.name}`}
      onClick={(event) => navigateRow(event, `/experiments/${item.id}`)} onKeyDown={(event) => navigateRowByKeyboard(event, `/experiments/${item.id}`)}>
      <td><a className="row-title" href={`/experiments/${item.id}`}>{item.name}</a><code>{item.id}</code><RunClassBadge value={item.run_class} /></td>
      <td><strong>{item.design === "paired_comparison" ? "双系统公平对比" : "单系统回归"}</strong><small>{laneLabel(item.evaluation_lane)} · {item.model?.id ?? "已冻结模型"}</small></td><td><span className="soft-label">{item.dataset_ref}</span></td>
      <td><Progress value={item.progress?.rate ?? 0} text={`${item.progress?.completed ?? 0}/${item.progress?.total ?? 0}`} /></td><td><strong className="score-number">{formatScore(item.average_score)}</strong></td>
      {!compact && <td><code>{shortHash(item.contestants?.[0]?.source_revision)}</code></td>}<td><Status status={item.status} /></td></tr>)}</tbody></table></div>;
}

function ExperimentDetail({ id }: { id: string }) {
  const { data, error, loading } = useRemote(`/api/workbench/experiments/${encodeURIComponent(id)}`);
  const [selectedCases, setSelectedCases] = useState<Set<string>>(new Set());
  const [composerOpen, setComposerOpen] = useState(false);
  if (loading) return <Loading />;
  if (error || !data) return <section className="page-content"><ErrorBox text={error || "实验不存在"} /></section>;
  const exp = data.experiment;
  const frozenDesign = Boolean(exp.frozen_design || exp.status === "FROZEN");
  const caseGroups = Object.entries(Object.groupBy(data.trials as Json[], (trial: Json) => trial.case_ref));
  const toggleCase = (caseRef: string) => setSelectedCases((current) => { const next = new Set(current); if (next.has(caseRef)) next.delete(caseRef); else next.add(caseRef); return next; });
  return <section className="page-content"><div className="detail-head"><div><a className="back-link" href="/experiments">← 返回实验</a><span className="kicker">EXPERIMENT</span><h2>{exp.name}</h2><div className="detail-meta"><Status status={exp.status} /><RunClassBadge value={exp.run_class} /><code>{exp.id}</code><span>{exp.design === "paired_comparison" ? "双系统公平对比" : "单系统回归"}</span></div></div>
    <div className="hash-card"><span>Manifest Hash</span><code>{exp.manifest_hash}</code><small>数据、种子、预算、参评版本均已冻结</small></div></div>
    <div className="metric-row"><Metric label={frozenDesign ? "计划单次评测（Trials）" : "单次评测（Trial）"} value={frozenDesign ? exp.planned_trial_count : exp.progress.total}
        foot={frozenDesign ? `${exp.planned_case_count} 个 Case × ${exp.planned_contestant_count} 名考生 × ${(data.manifest.environment_seeds ?? []).length} 个 Seed` : `${exp.progress.succeeded} 成功 · ${exp.progress.failed} 失败 · ${exp.progress.cancelled} 未执行`} />
      <Metric label={frozenDesign ? "开考状态" : "执行收口率"} value={frozenDesign ? "尚未开考" : `${Math.round((exp.progress.rate ?? 0) * 100)}%`}
        foot={frozenDesign ? "资格、容量和正式放行门禁通过后才能启动" : "成功、失败和未执行均计入收口进度"} />
      <Metric label={frozenDesign ? "官方成绩" : "确定性均分"} value={frozenDesign ? "尚未产生" : formatScore(exp.average_score)} foot="工具名与固定顺序不计分" />
      <Metric label="AI 调查" value={exp.analyses} foot={frozenDesign ? "有真实 Trial 后才能运行" : "实验关闭后可运行"} accent /></div>
    <div className="split-grid experiment-grid"><section className="surface"><SectionHead title={frozenDesign ? "冻结题目组成" : "按评测题目（Case）查看"}
      sub={frozenDesign ? "这里只冻结考试设计，不提前创建 Trial，也不代表已经开考" : "同一道题的多次 Trial 会聚合在一起，展开后可看每次明细"} />
      {frozenDesign ? <><div className="preflight-grid"><KeyValue label="公开集（Public）" value={`${exp.partition_counts?.PUB ?? 0} 个 Case`} />
        <KeyValue label="隐藏集（Hidden）" value={`${exp.partition_counts?.HID ?? 0} 个 Case`} /><KeyValue label="安全集（Safety）" value={`${exp.partition_counts?.SAFE ?? 0} 个 Case`} />
        <KeyValue label="回归集（Regression）" value={`${exp.partition_counts?.REG ?? 0} 个 Case`} /></div>
        <div className="authority-banner"><strong>80 个 Case 已冻结，480 次 Trial 尚未创建</strong><p>请在“数据集与 Case”中人工选择题目做不计分资格或容量验证；正式 480 次只有全部门禁通过后才允许启动。</p></div>
        <a className="text-link" href="/datasets">前往数据集选择 Case 并新建评测 →</a></> : <><div className="selection-toolbar"><div><strong>已选 {selectedCases.size} 道题</strong><small>沿用本实验冻结的全部考生与公平配置；原实验和原分数保持不变。</small></div><div><button onClick={() => setSelectedCases(new Set(caseGroups.map(([caseRef]) => caseRef)))}>全选</button><button onClick={() => setSelectedCases(new Set())}>清空</button><button className="toolbar-primary" disabled={!selectedCases.size} onClick={() => setComposerOpen(true)}>按原配置重新评测 →</button></div></div>
      <div className="case-groups">{caseGroups.map(([caseRef, rawTrials]) => { const trials = rawTrials ?? []; const scores = trials.map((trial: Json) => Number(trial.grade?.total)).filter(Number.isFinite); return <details className="case-group" key={caseRef} open={caseGroups.length <= 4}>
        <summary><input type="checkbox" aria-label={`选择 ${caseRef}`} checked={selectedCases.has(caseRef)} onChange={() => toggleCase(caseRef)} onClick={(event) => event.stopPropagation()} /><span><strong>{caseRef}</strong><small>{trials.length} 次单次评测（Trials）</small></span><span>均分 <b>{formatScore(average(scores))}</b></span><span>{trials.filter((trial: Json) => ["COMPLETED","FAILED","CANCELLED"].includes(trial.status)).length}/{trials.length} 已收口</span></summary>
        <div className="trial-list">{trials.map((trial: Json) => <a href={`/trials/${trial.id}`} className="trial-row" key={trial.id}><div><strong>{trial.contestant}</strong><code>{trial.id}</code></div><div className="trial-kpis"><span>得分 <b>{trial.grade?.total ?? "—"}</b></span><span>时长 <b>{formatDuration(trial.duration_ms)}</b></span><Status status={trial.status} /></div></a>)}</div>
      </details>; })}</div></>}
    </section><aside className="surface manifest-panel"><SectionHead title="冻结实验合同（Manifest）" sub="评测执行层（Harness）决定公平与安全边界" />
      <KeyValue label="数据集（Dataset）" value={data.manifest.dataset_ref} /><KeyValue label="套件（Suite）" value={data.manifest.suite_ref} />
      <KeyValue label="运行类别（Run class）" value={runClassLabel(data.manifest.run_class)} /><KeyValue label="评测通道（Lane）" value={laneLabel(data.manifest.evaluation_lane)} />
      <KeyValue label="工作模式（Operating modes）" value={(data.manifest.operating_modes ?? []).map(operationModeLabel).join("、")} /><KeyValue label="执行环境（Execution mode）" value={data.manifest.execution_mode === "controlled_simulation" ? "受控数字孪生（Controlled simulation）" : "历史只读回放（Read-only replay）"} /><KeyValue label="环境种子（Seeds）" value={(data.manifest.environment_seeds ?? []).join("、")} />
      <KeyValue label="每个 Seed 重复次数（Replicates）" value={data.manifest.replicates_per_seed} /><KeyValue label="工具预算（Tool calls）" value={data.manifest.budget?.tool_calls} /><KeyValue label="时间预算（Wallclock）" value={formatDuration(data.manifest.budget?.wallclock_ms)} />
      <div className="contestants">{(data.manifest.contestants ?? []).map((item: Json) => <div key={item.ref}><strong>{item.ref}</strong><code>{shortHash(item.artifact_digest)}</code></div>)}</div>
    </aside></div>{composerOpen && <RunComposer intent="rerun" caseRefs={[...selectedCases]} defaultExperimentId={id} datasetRef={exp.dataset_ref} onClose={() => setComposerOpen(false)} />}</section>;
}

function TrialCenter({ mode }: { mode: "traces" | "graders" | "analyses" }) {
  const trials = useRemote("/api/workbench/trials");
  const analyses = useRemote(mode === "analyses" ? "/api/analysis-runs" : null);
  const items = useMemo(() => trials.data?.items ?? [], [trials.data]);
  const officialItems = items.filter((item: Json) => item.affects_official_score === true);
  const nonOfficialItems = items.filter((item: Json) => item.affects_official_score !== true);
  const runs = analyses.data?.items ?? [];
  const trialMap = useMemo(() => new Map(items.map((item: Json) => [item.id, item])), [items]);
  if (trials.loading || (mode === "analyses" && analyses.loading)) return <Loading />;
  const error = trials.error || analyses.error;
  if (mode === "traces") return <section className="page-content"><PageTitle eyebrow="APPEND-ONLY OBSERVABILITY" title="轨迹与日志" text="每条 Trial 的 Agent 外显决策、工具调用、环境观察、预算事件、评分和复位记录都可以从这里进入；正式、资格和工程自测会明确区分。" />
    {error && <ErrorBox text={error} />}<div className="metric-row three"><Metric label="全部 Trial" value={items.length} foot={`${officialItems.length} 条正式 · ${nonOfficialItems.length} 条不计正式成绩`} href="#trace-list" />
      <Metric label="轨迹记录" value={items.reduce((sum: number, item: Json) => sum + Number(item.trace_records ?? 0), 0)} foot="只追加 · 可验证哈希" href="#trace-list" />
      <Metric label="源码已绑定" value={items.filter((item: Json) => item.source_snapshot).length} foot="调查读取冻结版本" href="#trace-list" accent /></div>
    <section className="surface" id="trace-list"><SectionHead title="Trial 轨迹索引" sub="点击任意一行直接打开该 Trial 的轨迹页签" />
      <div className="table-scroll"><table className="data-table"><thead><tr><th>Case / Trial</th><th>参评架构</th><th>轨迹</th><th>工具结果</th><th>记录角色</th><th>状态</th></tr></thead><tbody>
        {items.map((item: Json) => <tr key={item.id} className="clickable-row" role="link" tabIndex={0} aria-label={`打开 ${item.case_ref} 的轨迹`}
          onClick={(event) => navigateRow(event, `/trials/${item.id}#trace`)} onKeyDown={(event) => navigateRowByKeyboard(event, `/trials/${item.id}#trace`)}>
          <td><a className="row-title" href={`/trials/${item.id}#trace`}>{item.case_ref}</a><code>{item.id}</code><RunClassBadge value={item.run_class} /></td><td><strong>{contestantDisplayName(item.contestant)}</strong><small>{item.experiment_name}</small></td>
          <td><strong className="score-number">{item.trace_records}</strong></td><td>{item.tool_results}</td><td>{(item.trace_actors ?? []).join(" · ")}</td><td><Status status={item.status} /></td></tr>)}
      </tbody></table></div></section></section>;
  if (mode === "graders") return <section className="page-content"><PageTitle eyebrow="DETERMINISTIC CODE GRADER" title="评分器中心" text="这里展示确定性 Code Grader 的全部结果，并严格区分正式成绩、资格试跑和工程自测。评分只看真实终态、证据、轨迹、预算和安全门禁，不看固定工具名称或求解顺序。" />
    {error && <ErrorBox text={error} />}<div className="metric-row three"><Metric label="全部已评分" value={items.filter((item: Json) => item.grade).length} foot={`${officialItems.length} 条正式 · ${nonOfficialItems.length} 条不计正式成绩`} href="#grader-list" />
      <Metric label="正式成绩 Trial" value={officialItems.filter((item: Json) => item.grade).length} foot="只统计正式冻结套件" href="#grader-list" />
      <Metric label="正式均分" value={officialItems.length ? formatScore(average(officialItems.map((item: Json) => item.grade?.total))) : "尚未产生"} foot="资格与工程结果不混入；AI 调查不能改写" href="#grader-list" accent /></div>
    <section className="surface" id="grader-list"><SectionHead title="逐 Trial 评分结果" sub="每一行都标明结果口径；点击进入评分细项和硬门禁" />
      <div className="table-scroll"><table className="data-table"><thead><tr><th>Case / Trial</th><th>参评架构</th><th>结果口径</th><th>总分</th><th>本次结论</th><th>硬门禁</th><th>完成时间</th></tr></thead><tbody>
        {items.map((item: Json) => <tr key={item.id} className="clickable-row" role="link" tabIndex={0} aria-label={`打开 ${item.case_ref} 的评分细项`}
          onClick={(event) => navigateRow(event, `/trials/${item.id}#grader`)} onKeyDown={(event) => navigateRowByKeyboard(event, `/trials/${item.id}#grader`)}>
          <td><a className="row-title" href={`/trials/${item.id}#grader`}>{item.case_ref}</a><code>{item.id}</code></td><td><strong>{contestantDisplayName(item.contestant)}</strong><small>{item.experiment_name}</small></td><td><RunClassBadge value={item.run_class} />{!item.affects_official_score && <small>不计正式成绩</small>}</td>
          <td><strong className="score-number">{formatScore(item.grade?.total)}</strong></td><td>{item.grade ? <Status status={item.grade.passed ? "PASSED" : "FAILED"} /> : "未评分"}</td>
          <td>{item.grade ? `${Object.values(item.grade.hard_gates ?? {}).filter(Boolean).length}/${Object.keys(item.grade.hard_gates ?? {}).length}` : "—"}</td><td>{formatTime(item.completed_at)}</td></tr>)}
      </tbody></table></div></section></section>;
  return <section className="page-content"><PageTitle eyebrow="READ-ONLY AGENTIC INVESTIGATION" title="AI 调查员" text="查看所有成功与失败的调查运行。调查员由 Claude Agent SDK + DeepSeek 驱动，只读查证据、源码和公开方法论，不拥有评分权。" />
    {error && <ErrorBox text={error} />}<div className="metric-row three"><Metric label="调查运行" value={runs.length} foot="失败记录也保留审计" href="#analysis-list" />
      <Metric label="已完成" value={runs.filter((run: Json) => run.status === "COMPLETED").length} foot="报告与哈希已冻结" href="#analysis-list" />
      <Metric label="调查权限" value="只读" foot="不能改分、改 Trial 或修复环境" href="#analysis-list" accent /></div>
    <section className="surface" id="analysis-list"><SectionHead title="AI 调查运行记录" sub="点击任意一行查看该次调查的轨迹、报告和来源" />
      <div className="table-scroll"><table className="data-table"><thead><tr><th>调查 / Case</th><th>模式</th><th>参评架构</th><th>模型</th><th>状态</th><th>创建时间</th></tr></thead><tbody>
        {runs.map((run: Json) => { const trial = trialMap.get(run.trial_id) as Json | undefined; const href = `/trials/${run.trial_id}?analysis=${encodeURIComponent(run.id)}#analysis`; return <tr key={run.id} className="clickable-row" role="link" tabIndex={0} aria-label={`打开 AI 调查 ${run.id}`}
          onClick={(event) => navigateRow(event, href)} onKeyDown={(event) => navigateRowByKeyboard(event, href)}>
          <td><a className="row-title" href={href}>{trial?.case_ref ?? run.trial_id}</a><code>{run.id}</code></td><td><strong>{analysisMode(run.mode)}</strong><small>{run.mode}</small></td>
          <td><strong>{trial?.contestant ?? "已冻结参评身份"}</strong><small>{trial?.experiment_name}</small></td><td><strong>{run.model}</strong><small>{run.sdk}</small></td><td><Status status={run.status} /></td><td>{formatTime(run.created_at)}</td></tr>; })}
      </tbody></table></div></section></section>;
}

function TrialDetail({ id, analysisId }: { id: string; analysisId?: string }) {
  const detail = useRemote(`/api/workbench/trials/${encodeURIComponent(id)}`);
  const [tab, setTab] = useState("overview");
  const [composerOpen, setComposerOpen] = useState(false);
  const activeTrialStatus = detail.data?.trial?.status;
  const refreshDetail = detail.refresh;
  useEffect(() => {
    const syncTabFromUrl = () => {
      const requested = window.location.hash.replace(/^#/, "");
      if (["overview", "trace", "grader", "source", "analysis"].includes(requested)) setTab(requested);
    };
    syncTabFromUrl();
    window.addEventListener("hashchange", syncTabFromUrl);
    return () => window.removeEventListener("hashchange", syncTabFromUrl);
  }, []);
  useEffect(() => {
    if (!["RUNNING", "QUEUED"].includes(activeTrialStatus)) return;
    const timer = window.setInterval(() => { void refreshDetail(true); }, 5000);
    return () => window.clearInterval(timer);
  }, [activeTrialStatus, refreshDetail]);
  const chooseTab = (key: string) => {
    setTab(key);
    const next = `${window.location.pathname}${window.location.search}#${key}`;
    window.history.replaceState(null, "", next);
  };
  if (detail.loading) return <Loading />;
  if (detail.error || !detail.data) return <section className="page-content"><ErrorBox text={detail.error || "单次评测（Trial）不存在"} /></section>;
  const data = detail.data; const trial = data.trial; const official = data.experiment?.affects_official_score === true;
  const tabs = [["overview", "任务与终态"], ["trace", `轨迹与日志 · ${data.evidence.trace_records}`], ["grader", "评分器"],
    ["source", `冻结源码 · ${data.source_snapshot?.file_count ?? 0}`], ["analysis", `AI 分析 · ${data.analyses.length}`]];
  return <section className="page-content trial-page"><div className="trial-head"><div><a className="back-link" href={`/experiments/${trial.experiment_id}`}>← 返回实验</a><span className="kicker">单次评测研究工作台 · TRIAL WORKBENCH</span><h2>{trial.case_ref}</h2><div className="detail-meta"><Status status={trial.status} /><RunClassBadge value={data.experiment?.run_class} />{!official && <Tag>不计正式成绩</Tag>}<span>{contestantDisplayName(trial.contestant)}</span><code>{trial.id}</code></div></div>
    <div className="trial-head-actions"><button onClick={() => setComposerOpen(true)}>按原配置重新评测<br/><small>Rerun frozen setup</small></button><RegradeButton trialId={id} official={official} />{["RUNNING", "QUEUED"].includes(trial.status) ? <div className="score-badge pending"><strong>—</strong><span>等待结果</span></div> : <ScoreBadge score={data.graders?.[0]?.result?.total} passed={data.graders?.[0]?.result?.passed} official={official} />}</div></div>
    <nav className="detail-tabs" aria-label="Trial 详情页签">{tabs.map(([key, label]) => <button key={key} aria-pressed={tab === key}
      className={tab === key ? "active" : ""} onClick={() => chooseTab(key)}>{label}</button>)}</nav>
    {["RUNNING", "QUEUED"].includes(trial.status) && <LiveProgress progress={data.live_progress} />}
    {tab === "overview" && <TrialOverview data={data} onChanged={detail.refresh} />}{tab === "trace" && <TracePanel key={id} trialId={id} />}{tab === "grader" && <GraderPanel graders={data.graders} official={official} />}
    {tab === "source" && <SourcePanel trialId={id} snapshot={data.source_snapshot} />}{tab === "analysis" && <AnalysisPanel trialId={id} initial={data.analyses} initialSelected={analysisId} sourceAvailable={Boolean(data.source_snapshot)} onChanged={detail.refresh} />}
    {composerOpen && <RunComposer intent="rerun" caseRefs={[trial.case_ref]} defaultExperimentId={trial.experiment_id} datasetRef={data.experiment?.dataset_ref} onClose={() => setComposerOpen(false)} />}
  </section>;
}

function TrialOverview({ data, onChanged }: { data: Json; onChanged: () => Promise<void> }) {
  const [reconciling, setReconciling] = useState(false); const [reconcileError, setReconcileError] = useState("");
  const trial = data.trial;
  const attempt = data.attempts?.at(-1); const cleanup = attempt?.cleanup; const failure = attempt?.failure;
  const reconciliation = (data.cleanup_reconciliations ?? []).filter((item: Json) => item.attempt === attempt?.attempt && item.status === "RESOLVED").at(-1);
  const cleanupBlocked = !reconciliation && cleanup?.quarantine_required && cleanup?.quarantine_released !== true;
  const cleanupFailed = !reconciliation && (cleanup?.reset_ok === false || Boolean(cleanup?.reset_error));
  const pendingTrial = ["QUEUED", "RUNNING"].includes(trial.status) && !attempt;
  const cleanupStatus = pendingTrial ? "QUEUED" : reconciliation ? "PASSED" : cleanupBlocked || cleanupFailed ? "FAILED" : cleanup?.reset_ok === true ? "PASSED" : "COMPLETED";
  const cleanupText = pendingTrial ? "评测尚未结束，平台会在真实考生停止作答后独立复位并核验数字孪生考场；这里不会提前宣称已经清理完成。"
    : reconciliation ? `平台后来确认真实考生已进入终态（${reconciliation.candidate_terminal_status}），并重新核验数字孪生考场已恢复干净基线。原失败 Trial 和原始证据均未被修改。`
    : cleanupBlocked ? "真实考生还没有进入终态，当前数字孪生槽位已被隔离，评测队列会立即停止，绝不会交给下一名考生。"
    : cleanupFailed ? `环境复位失败，评测队列已经停止。${cleanup?.reset_error ? ` 原因：${cleanup.reset_error}` : ""}`
      : cleanup?.reset_ok === true ? `本次 Trial 结束后，数字孪生环境已经恢复到干净基线，可以安全地交给下一次评测。${cleanup?.snapshot_error ? ` 但故障现场快照采集失败：${cleanup.snapshot_error}；该异常已单独留痕，不会冒充完整证据。` : ""}`
        : "本次 Trial 不使用需要复位的 L2 数字孪生环境，或属于升级前的历史记录；平台不会把“未记录”误写成“已复位”。";
  const measurement = trial.usage?.measurement;
  return <><div className="authority-banner"><strong>考场清理与隔离结果（Cleanup & Quarantine） <Status status={cleanupStatus} /></strong><p>{cleanupText}</p>
    <small>运行尝试（Attempt）{attempt?.attempt ?? "—"} · {attempt?.status ? (STATUS_LABELS[attempt.status] ?? attempt.status) : "暂无记录"} · 轨迹哈希 {shortHash(attempt?.trace_hash)}</small>
    {(cleanupBlocked || cleanupFailed) && <div className="inline-actions"><button disabled={reconciling} onClick={async () => {
      setReconciling(true); setReconcileError(""); try {
        await requestJson(`/api/workbench/trials/${encodeURIComponent(trial.id)}/reconcile-cleanup`, { method: "POST" });
        await onChanged();
      } catch (error: any) { setReconcileError(error.message); } finally { setReconciling(false); }
    }}>{reconciling ? "正在核验真实考生与考场…" : "重新核验并安全释放考场（Reconcile cleanup）"}</button></div>}
    {reconcileError && <ErrorBox text={reconcileError} />}</div>
    {failure && <div className={`failure-banner owner-${String(failure.owner).toLowerCase()}`}><strong>这次失败算在谁头上（Failure ownership）</strong><p>{failureCategoryLabel(failure.category)}：{failure.zh}</p><small>{failure.automatic_retry_allowed ? `只允许按冻结策略自动重试：${failure.policy_code}` : "不允许自动重试，避免把有效失败洗掉。"}</small></div>}
    <div className="split-grid trial-grid"><section className="surface"><SectionHead title="评测题目（Case）与可见上下文" sub="这是参评 Agent 收到的任务，不含隐藏参考答案" />
    <div className="task-callout"><span>目标</span><p>{data.case?.goal}</p></div><div className="kv-grid"><KeyValue label="Case 版本" value={data.case?.version} /><KeyValue label="工作模式" value={operationModeLabel(data.case?.visible?.operating_mode)} /><KeyValue label="隔离身份" value={trial.blind_id} />
      <KeyValue label="环境种子" value={trial.environment_seed} /><KeyValue label="重复编号" value={trial.replicate_id} /><KeyValue label="运行时长" value={formatDuration(trial.duration_ms)} /><KeyValue label="轨迹哈希" value={shortHash(data.evidence.trace_hash)} /></div>
    <SectionHead title="Agent 最终结果" sub="结构化公开结论" /><div className="outcome-card"><Status status={(trial.outcome?.status ?? "UNKNOWN").toUpperCase()} /><h3>{trial.outcome?.root_cause ?? "无根因结论"}</h3><p>{trial.outcome?.summary}</p>
      <div className="evidence-chips">{(trial.outcome?.evidence_refs ?? []).map((ref: string) => <Tag key={ref}>{ref}</Tag>)}</div></div>
  </section><aside className="surface"><SectionHead title="环境终态与证据" sub="由评测执行层（Harness）独立采集，不采信 Agent 自报" />
    <div className="evidence-stats"><Mini label="工具完成" value={data.evidence.tools} /><Mini label="轨迹记录" value={data.evidence.trace_records} /><Mini label="证据制品" value={data.evidence.artifacts.length} /></div>
    <JsonBlock value={trial.final_state} /><SectionHead title="预算实际使用" sub="超限会被评测执行层（Harness）安全停止；考生没有公开的数据明确显示“未提供”，绝不按 0 计算" /><div className="kv-grid">
      <KeyValue label="工具调用（Tool calls）" value={usageValue(trial.usage, "tool_calls")} />
      <KeyValue label="输入 Token（Input tokens）" value={usageValue(trial.usage, "input_tokens")} />
      <KeyValue label="输出 Token（Output tokens）" value={usageValue(trial.usage, "output_tokens")} />
      <KeyValue label="费用（Cost）" value={usageValue(trial.usage, "cost_usd", formatCost)} /></div>
    <p className={measurement?.complete === false ? "usage-note incomplete" : "usage-note"}>{measurement?.complete === false
      ? `用量来源：${measurement.source ?? "考生公开接口"}。未提供：${(measurement.unavailable_dimensions ?? []).join("、") || "无"}。`
      : `用量来源：${measurement?.source ?? "历史记录"}。${measurement?.test_double ? "这是工程测试替身的运行数据，不代表真实考生费用。" : "已按公开接口如实记录。"}`}</p>
  </aside></div></>;
}
function TracePanel({ trialId }: { trialId: string }) {
  const [page, setPage] = useState<Json>({ items: [], cursor: 0, total: 0, has_more: false });
  const [error, setError] = useState(""); const [loading, setLoading] = useState(true); const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState("ALL");
  useEffect(() => { let active = true;
    void requestJson(`/api/workbench/trials/${encodeURIComponent(trialId)}/trace?after=0&limit=200`)
      .then((value) => { if (active) setPage(value); }).catch((reason) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [trialId]);
  const loadMore = async () => { setLoadingMore(true); setError(""); try {
    const next = await requestJson(`/api/workbench/trials/${encodeURIComponent(trialId)}/trace?after=${page.cursor}&limit=200`);
    setPage((current) => ({ ...next, items: [...current.items, ...next.items] }));
  } catch (reason: any) { setError(reason.message); } finally { setLoadingMore(false); } };
  const items = (page.items ?? []).filter((item: Json) => filter === "ALL" || item.span_kind === filter);
  const filters = page.filters?.length ? page.filters : [{ code: "ALL", zh: "全部记录", en: "All" }, { code: "AGENT", zh: "Agent 决策", en: "Agent" }, { code: "TOOL", zh: "工具调用", en: "Tool" }];
  return <section className="surface trace-surface"><SectionHead title="机器日志与完整轨迹（Machine logs & Trace）" sub="原始日志逐条保留；中文解释只帮助阅读，不合并、不改写、不推断原始事实，也不保存隐式思维链" action={<div className="filter-row">{filters.map((item: Json) => <button key={item.code} className={filter === item.code ? "active" : ""} onClick={() => setFilter(item.code)}>{item.zh}<small>{item.en}</small></button>)}</div>} />
    {error && <ErrorBox text={error} />}{loading ? <Loading inline /> : <><div className="timeline">{items.map((item: Json) => <TraceRow key={item.record_id ?? item.row_id} item={item} />)}</div>
      {page.has_more && <button className="primary-action" disabled={loadingMore} onClick={loadMore}>{loadingMore ? "正在加载…" : `继续加载轨迹（已显示 ${page.items.length}/${page.total}）`}</button>}</>}</section>;
}

function TraceRow({ item }: { item: Json }) {
  const [open, setOpen] = useState(false);
  const display = item.display ?? { category: { zh: item.span_kind, en: item.span_kind }, title: { zh: item.name, en: item.name }, actor: { zh: item.actor, en: item.actor }, lifecycle: { zh: item.record_type, en: item.record_type }, status: { zh: item.status ?? "已记录", en: item.status ?? "Recorded" } };
  return <article className={`trace-row kind-${String(item.span_kind).toLowerCase()}`}><div className="trace-line"><span className="trace-seq">{String(item.seq).padStart(3, "0")}</span><span className="trace-dot" /></div>
    <div className="trace-body"><button className="trace-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><div><Tag>{display.category.zh}<small>{display.category.en}</small></Tag><strong>{display.title.zh}<small>{display.title.en}</small></strong><span>{display.actor.zh} · {display.actor.en}</span></div><time>{formatTime(item.timestamp)}</time>
      <p>{display.lifecycle.zh}（{display.lifecycle.en}） · {display.status.zh}（{display.status.en}）</p>
      {display.summary_zh && <p className="trace-summary"><b>人话解释：</b>{display.summary_zh}</p>}
      <div className="machine-codes"><code>{item.name}</code><code>{item.record_type}</code><code>{item.actor}</code></div></button>
      {open && <JsonBlock value={{ original_record: { ...item, display: undefined }, payload: item.payload }} label="查看原始机器记录（Raw JSON）" />}</div></article>;
}

function GraderPanel({ graders, official }: { graders: Json[]; official: boolean }) {
  const grade = graders?.[0]?.result;
  if (!grade) return <Empty text="该 Trial 还没有确定性评分结果" />;
  return <div className="split-grid grader-grid"><section className="surface"><SectionHead title="确定性评分器 Grader 5.1（Code Grader）" sub={official ? "正式成绩来源 · 只看可验证事实 · 评分结果不可被 AI 分析覆盖" : "本次为资格/工程结果 · 不写入正式成绩 · 只看可验证事实"} />
    <div className="grade-hero"><ScoreBadge score={grade.total} passed={grade.passed} large official={official} /><div><h3>{grade.passed ? official ? "通过全部正式硬门禁" : "通过本次资格/工程门禁" : official ? "未通过正式门禁" : "未通过本次资格/工程门禁"}</h3><p>{grade.rule}</p><code>{grade.scoring_contract}</code></div></div>
    <div className="dimension-list">{Object.entries(grade.dimensions ?? {}).map(([name, value]: [string, any]) => { const normalized = Number(value.normalized ?? 0); return <div className="dimension" key={name}><div><span>{DIMENSION_LABELS[name] ?? name}</span><b>{Number(value.weighted ?? 0).toFixed(2)} / {value.weight}</b></div><div className="bar"><i style={{ width: `${Math.max(0, Math.min(100, normalized * 100))}%` }} /></div><small>{grade.assertions?.[name]?.applicable === false ? "本 Trial 不适用，不计入归一化总分" : normalized >= 1 ? "该维度满分通过" : normalized > 0 ? "已获得部分分数，仍需改进" : "该维度未通过，需要改进"}</small></div>; })}</div>
  </section><aside className="surface"><SectionHead title="不可补偿硬门禁" sub="任何一项失败都不能靠其他高分抵消" />
    <div className="gate-stack">{Object.entries(grade.hard_gates ?? {}).map(([name, passed]) => <div key={name} className={passed ? "gate-pass" : "gate-fail"}><span>{passed ? "✓" : "×"}</span><div><strong>{hardGateLabel(name)}</strong><small>{passed ? "通过（Pass）" : "失败（Fail）"}</small></div></div>)}</div>
    {grade.controlled_closure_evidence?.operating_mode && <div className="selected-summary"><strong>受控闭环证据（Controlled closure）</strong>
      <span>工作模式：{operationModeLabel(grade.controlled_closure_evidence.operating_mode)}</span>
      <span>环境变更：{grade.controlled_closure_evidence.changes} 次；策略自动放行：{yesNo(grade.controlled_closure_evidence.policy_auto_allowed)}；独立人工批准：{yesNo(grade.controlled_closure_evidence.oracle_approved)}</span>
      <span>一次性票据：{yesNo(grade.controlled_closure_evidence.ticket_issued)}；动作留痕：{yesNo(grade.controlled_closure_evidence.action_execution_observed)}；独立验证：{yesNo(grade.controlled_closure_evidence.independent_verification_observed)}</span></div>}
    <div className="rule-note"><strong>为什么不按工具名评分？</strong><p>Agent 可以用不同路径解决同一问题。评分器只看真实终态、证据是否可追溯、动作是否最小安全、预算是否合规。</p></div>
  </aside></div>;
}

function SourcePanel({ trialId, snapshot }: { trialId: string; snapshot: Json | null }) {
  const source = useRemote(snapshot ? `/api/workbench/trials/${encodeURIComponent(trialId)}/source` : null);
  const [selected, setSelected] = useState(""); const [file, setFile] = useState<Json | null>(null); const [error, setError] = useState("");
  const load = (name: string) => { setSelected(name); setError(""); requestJson(`/api/workbench/trials/${encodeURIComponent(trialId)}/source/content?path=${encodeURIComponent(name)}`).then(setFile).catch((reason) => setError(reason.message)); };
  if (!snapshot) return <section className="surface"><SectionHead title="本 Trial 没有冻结源码" sub="Frozen source unavailable" /><Empty text="这是工程测试替身产生的自测记录，不绑定真实考生源码；它不会被送给 AI 调查员，也不会冒充真实产品证据。" /></section>;
  return <div className="source-layout"><aside className="surface file-tree"><SectionHead title="冻结源码" sub={`${snapshot?.file_count ?? 0} 文件 · ${formatBytes(snapshot?.size_bytes)}`} />
    <div className="snapshot-seal"><span>不可变快照</span><code>{shortHash(snapshot?.tree_hash)}</code><small>{snapshot?.contestant_ref}<br/>{shortHash(snapshot?.artifact_digest)}</small></div>
    <div className="files">{(source.data?.snapshot?.files ?? []).map((item: Json) => <button className={selected === item.path ? "active" : ""} key={item.path} onClick={() => load(item.path)}><span>⌗</span>{item.path}<small>{formatBytes(item.size_bytes)}</small></button>)}</div></aside>
    <section className="surface code-panel"><SectionHead title={selected || "选择源码文件"} sub={file ? `${file.size_bytes} bytes · ${shortHash(file.sha256)}` : "AI 调查员只能读取这份与 Trial 绑定的快照"} />
      {(error || source.error) && <ErrorBox text={error || source.error} />}{file ? <pre className="code-view"><code>{file.content}</code></pre> : <Empty text="从左侧选择文件查看；工作目录中的未冻结代码不会进入分析" />}</section></div>;
}

function AnalysisPanel({ trialId, initial, initialSelected, sourceAvailable, onChanged }: { trialId: string; initial: Json[]; initialSelected?: string; sourceAvailable: boolean; onChanged: () => Promise<void> }) {
  const [runs, setRuns] = useState(initial); const [selected, setSelected] = useState(initialSelected && initial.some((run) => run.id === initialSelected) ? initialSelected : initial[0]?.id ?? ""); const [prompt, setPrompt] = useState("请结合本 Trial 的任务终态、完整轨迹、逐维评分和冻结源码，定位最关键的能力短板；必要时研究最新权威方法论，给出按优先级排序且可验证的优化建议。");
  const [mode, setMode] = useState("optimization_research"); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const runDetail = useRemote(selected ? `/api/analysis-runs/${encodeURIComponent(selected)}` : null);
  const analysisStatus = runDetail.data?.analysis?.status;
  const refreshRun = runDetail.refresh;
  useEffect(() => { if (!selected || !["QUEUED", "RUNNING"].includes(analysisStatus)) return;
    const timer = window.setInterval(() => void refreshRun(), 1800); return () => window.clearInterval(timer); }, [selected, analysisStatus, refreshRun]);
  const start = async () => { setBusy(true); setError(""); try { const body = await requestJson("/api/analysis-runs", { method: "POST", headers: { "idempotency-key": `ui-${trialId}-${Date.now()}` },
      body: JSON.stringify({ trial_id: trialId, prompt, mode }) }); setRuns([body.analysis, ...runs]); setSelected(body.analysis.id); await onChanged(); } catch (reason: any) { setError(reason.message); } finally { setBusy(false); } };
  const analysis = runDetail.data?.analysis; const result = analysis?.result;
  return <div className="analysis-layout"><aside className="surface analysis-control"><SectionHead title="AI 调查员" sub="Claude Agent SDK · DeepSeek · 只读" /><div className="authority-banner"><strong>诊断权，不是评分权</strong><p>能查证据、读源码、上网研究；不能改分、改 Trial 或执行修复。</p></div>
    {!sourceAvailable && <div className="rule-note"><strong>本 Trial 暂不能启动 AI 调查</strong><p>工程测试替身没有与真实考生版本绑定的冻结源码。为避免把测试替身冒充真实产品，平台不会创建缺少源码证据的调查。</p></div>}
    <label>分析目标<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} /></label><label>分析模式<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="optimization_research">优化深研</option><option value="case_diagnosis">Case 诊断</option><option value="score_explanation">评分解释</option></select></label>
    {error && <ErrorBox text={error} />}<button className="primary-action" disabled={busy || !prompt.trim() || !sourceAvailable} onClick={start}>{busy ? "正在创建…" : sourceAvailable ? "✦ 开始 AI 深度分析" : "缺少冻结源码，不能启动"}</button>
    <div className="run-history">{runs.map((run) => <button key={run.id} className={selected === run.id ? "active" : ""} onClick={() => setSelected(run.id)}><Status status={run.status} /><span>{run.mode}</span><small>{formatTime(run.created_at)}</small></button>)}</div>
  </aside><section className="surface analysis-report"><SectionHead title="调查轨迹与报告" sub={analysis ? `${analysis.model} · ${analysis.status}` : "选择或启动一份分析"} />
    {runDetail.error && <ErrorBox text={runDetail.error} />}{analysis && <AnalysisTimeline events={runDetail.data?.events ?? []} />}
    {analysis && ["QUEUED", "RUNNING"].includes(analysis.status) && <div className="thinking-state"><span className="pulse-ring" /><div><strong>调查员正在自主选择证据…</strong><p>页面会持续更新工具调用与公开观察，不展示隐式思维链。</p></div></div>}
    {analysis?.status === "FAILED" && <ErrorBox text={analysis.error} />}{result && <AnalysisReport result={result} sources={runDetail.data?.sources ?? []} />}
    {!analysis && <Empty text="AI 分析会引用 Trial、Span、评分维度、源码路径和网页来源" />}
  </section></div>;
}

function AnalysisTimeline({ events }: { events: Json[] }) {
  const visible = events.slice(-12);
  return <div className="analysis-events">{visible.map((event) => <div key={event.event_id}><span>{event.event_type.includes("failed") ? "×" : event.event_type.includes("completed") ? "✓" : "•"}</span><div><strong>{event.payload?.tool_name ?? humanize(event.event_type)}</strong><small>{event.actor} · {formatTime(event.timestamp)}</small><p>{event.payload?.output_summary ? JSON.stringify(event.payload.output_summary) : event.payload?.reason ?? "已记录可审计事件"}</p></div></div>)}</div>;
}

function AnalysisReport({ result, sources }: { result: Json; sources: Json[] }) {
  return <article className="report"><div className="report-summary"><span>调查结论 · 置信度 {Math.round(Number(result.confidence ?? 0) * 100)}%</span><h3>{result.summary}</h3><p>{result.diagnosis}</p></div>
    <h3 className="report-title">评分解释</h3><p className="prose">{result.score_interpretation}</p><h3 className="report-title">关键问题</h3>
    <div className="finding-list">{(result.issues ?? []).map((issue: Json, index: number) => <div className={`finding severity-${issue.severity}`} key={`${issue.title}-${index}`}><div><span>{issue.severity}</span><strong>{issue.title}</strong></div><p>{issue.analysis}</p><div className="recommend"><b>建议</b>{issue.recommendation}</div><div className="evidence-chips">{(issue.evidence_refs ?? []).map((ref: string) => <Tag key={ref}>{ref}</Tag>)}</div></div>)}</div>
    <h3 className="report-title">优化优先级</h3><ol className="optimization-list">{(result.optimization_plan ?? []).sort((a: Json, b: Json) => a.priority - b.priority).map((item: Json) => <li key={item.priority}><span>{item.priority}</span><div><strong>{item.title}</strong><p>{item.why}</p><small><b>怎么改：</b>{item.how}</small><small><b>怎么验：</b>{item.validation}</small></div></li>)}</ol>
    {(sources.length > 0 || result.methodology_sources?.length > 0) && <><h3 className="report-title">方法论来源</h3><div className="source-list">{(result.methodology_sources ?? []).map((source: Json) => <a href={source.url} target="_blank" rel="noreferrer" key={source.url}><strong>{source.title}</strong><span>{source.supports}</span><small>{source.url}</small></a>)}</div></>}
    {result.limitations?.length > 0 && <div className="limitations"><strong>分析限制</strong>{result.limitations.map((item: string) => <p key={item}>· {item}</p>)}</div>}
  </article>;
}

function RegradeButton({ trialId, official }: { trialId: string; official: boolean }) {
  const [open, setOpen] = useState(false); const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Json | null>(null); const [error, setError] = useState("");
  const submit = async () => { setBusy(true); setError(""); try { const body = await requestJson("/api/workbench/regrades", { method: "POST",
    body: JSON.stringify({ trial_ids: [trialId], requested_by: "evalos-operator", reason }) }); setResult(body); } catch (cause: any) { setError(cause.message); } finally { setBusy(false); } };
  return <><button onClick={() => setOpen(true)}>仅重新评分<br/><small>Regrade evidence</small></button>{open && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}><section className="run-modal regrade-modal" role="dialog" aria-modal="true"><div className="modal-head"><div><span className="kicker">RE-GRADE EXISTING EVIDENCE</span><h2>仅重新评分（Regrade）</h2><p>不会再次运行 Agent；只用这次 Trial 已冻结的终态、轨迹和用量重新计算。</p></div><button onClick={() => setOpen(false)}>×</button></div>
    {!result && <div className="run-form regrade-form"><label className="full">重新评分原因 <small>Audit reason</small><textarea rows={4} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：验证评分器升级前后的结果是否一致" /></label></div>}
    {error && <ErrorBox text={error} />}{result && <div className="regrade-result"><strong>✓ 重新评分完成</strong><p>{result.notice}</p><div className="preflight-grid"><KeyValue label={official ? "原正式分数" : "原评分结果"} value={formatScore(result.items[0]?.original_score)} /><KeyValue label="重新计算分数" value={formatScore(result.items[0]?.recalculated_score)} /><KeyValue label="是否改写原分" value="否（No）" /></div></div>}
    <div className="modal-actions"><button onClick={() => setOpen(false)}>{result ? "完成" : "取消"}</button>{!result && <button className="toolbar-primary" disabled={busy || !reason.trim()} onClick={submit}>{busy ? "正在计算…" : "开始重新评分"}</button>}</div></section></div>}</>;
}

function RunComposer({ intent, caseRefs, defaultExperimentId, datasetRef, onClose }: { intent: "new" | "rerun"; caseRefs: string[]; defaultExperimentId?: string; datasetRef?: string; onClose: () => void }) {
  const templates = useRemote(intent === "rerun" && defaultExperimentId
    ? `/api/workbench/run-templates?source_experiment_id=${encodeURIComponent(defaultExperimentId)}`
    : "/api/workbench/run-templates");
  const [sourceExperimentId, setSourceExperimentId] = useState(defaultExperimentId ?? "");
  const [evaluationPurpose, setEvaluationPurpose] = useState("PAIRED_COMPARISON");
  const [mode, setMode] = useState("QUICK_VALIDATION");
  const [repetitions, setRepetitions] = useState(1);
  const [reason, setReason] = useState("");
  const [setName, setSetName] = useState("");
  const [preflight, setPreflight] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const availableTemplates = (templates.data?.items ?? []).filter((item: Json) => (!datasetRef || item.dataset_ref === datasetRef)
    && caseRefs.every((caseRef) => (item.case_refs ?? []).includes(caseRef)));
  const sourceIsAvailable = availableTemplates.some((item: Json) => item.id === sourceExperimentId);
  const effectiveSourceExperimentId = intent === "rerun" ? (sourceIsAvailable ? sourceExperimentId : "")
    : sourceIsAvailable ? sourceExperimentId : (availableTemplates[0]?.id || "");
  const selectedTemplate = availableTemplates.find((item: Json) => item.id === effectiveSourceExperimentId);
  const incompatibleFrozenSource = intent === "rerun" && !templates.loading && Boolean(defaultExperimentId) && !sourceIsAvailable;
  const frozenContestants = selectedTemplate?.contestants ?? [];
  const purposeIsAvailable = evaluationPurpose === "PAIRED_COMPARISON" ? frozenContestants.length > 1
    : evaluationPurpose.startsWith("SINGLE:") && frozenContestants.some((item: Json) => item.ref === evaluationPurpose.slice("SINGLE:".length));
  const effectivePurpose = purposeIsAvailable ? evaluationPurpose
    : frozenContestants.length > 1 ? "PAIRED_COMPARISON" : frozenContestants[0] ? `SINGLE:${frozenContestants[0].ref}` : "PAIRED_COMPARISON";
  const contestantRefs = intent === "rerun" || effectivePurpose === "PAIRED_COMPARISON"
    ? frozenContestants.map((item: Json) => item.ref)
    : effectivePurpose.startsWith("SINGLE:") ? [effectivePurpose.slice("SINGLE:".length)] : [];
  const requestKind = intent === "rerun" ? "RERUN_FROZEN" : "NEW_EVALUATION";
  const purposeLabel = contestantRefs.length > 1 ? "双系统公平对比（Paired comparison）" : "单系统回归（Single-system regression）";
  const payload = { request_kind: requestKind, evaluation_purpose: contestantRefs.length > 1 ? "PAIRED_COMPARISON" : "SINGLE_SYSTEM_REGRESSION",
    source_experiment_id: effectiveSourceExperimentId, case_refs: caseRefs, contestant_refs: contestantRefs,
    repetitions, mode, requested_by: "evalos-operator", reason };
  const check = async () => { setBusy(true); setError(""); setPreflight(null); try {
    if (!reason.trim()) throw new Error(`请填写本次${intent === "rerun" ? "重新评测" : "新建评测"}的原因，便于以后追溯。`);
    if (!effectiveSourceExperimentId) throw new Error("没有找到适用于这些 Case 的冻结参评配置，请先完成一份覆盖该数据集的实验。");
    if (!contestantRefs.length) throw new Error("没有找到可用的参评考生，请检查冻结参评配置。");
    const body = await requestJson("/api/workbench/run-requests/preflight", { method: "POST", body: JSON.stringify(payload) });
    setPreflight(body.preflight);
  } catch (cause: any) { setError(cause.message); } finally { setBusy(false); } };
  const start = async () => { if (!preflight?.ready) return; setBusy(true); setError(""); try {
    if (mode === "TARGETED_REGRESSION" && setName.trim()) await requestJson("/api/workbench/case-selection-sets", { method: "POST",
      body: JSON.stringify({ name: setName, dataset_ref: preflight.dataset_ref, case_refs: caseRefs, requested_by: "evalos-operator", reason }) });
    const body = await requestJson("/api/workbench/run-requests", { method: "POST", headers: { "idempotency-key": `ui-eval-${stableToken(payload)}` }, body: JSON.stringify(payload) });
    window.location.assign(`/run-requests?selected=${encodeURIComponent(body.request.id)}`);
  } catch (cause: any) { setError(cause.message); } finally { setBusy(false); } };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="run-modal" role="dialog" aria-modal="true" aria-labelledby="run-modal-title">
    <div className="modal-head"><div><span className="kicker">{intent === "rerun" ? "RERUN FROZEN EVALUATION" : "CREATE EVALUATION"}</span><h2 id="run-modal-title">{intent === "rerun" ? "按原配置重新评测" : "新建评测"}</h2><p>{intent === "rerun" ? "沿用原实验冻结的全部参评考生与公平条件，只选择要重跑的题。" : "先确定评测目的，再由平台绑定对应考生与冻结版本；不会规定 Agent 的求解路径。"}</p></div><button aria-label="关闭" onClick={onClose}>×</button></div>
    <div className="mode-grid"><button className={mode === "QUICK_VALIDATION" ? "selected" : ""} onClick={() => { setMode("QUICK_VALIDATION"); setPreflight(null); }}><strong>快速验证</strong><small>Quick validation</small><span>临时检查，不进入正式成绩</span></button>
      <button className={mode === "TARGETED_REGRESSION" ? "selected" : ""} onClick={() => { setMode("TARGETED_REGRESSION"); setPreflight(null); }}><strong>定向回归</strong><small>Targeted regression</small><span>保存一组重点 Case，反复验证改进</span></button></div>
    {intent === "new" && <section className="purpose-picker" aria-labelledby="purpose-title"><div className="purpose-head"><div><strong id="purpose-title">评测目的（Evaluation purpose）</strong><small>选择为什么评，不需要手工拼装考生</small></div><Tag>{purposeLabel}</Tag></div><div className="purpose-grid">
      {frozenContestants.length > 1 && <button className={effectivePurpose === "PAIRED_COMPARISON" ? "selected" : ""} onClick={() => { setEvaluationPurpose("PAIRED_COMPARISON"); setPreflight(null); }}><strong>双系统公平对比</strong><small>Paired comparison</small><span>同一批 Case、预算与环境分别运行 {frozenContestants.map((item: Json) => contestantDisplayName(item.ref)).join(" 和 ")}</span></button>}
      {frozenContestants.map((item: Json) => <button key={item.ref} className={effectivePurpose === `SINGLE:${item.ref}` ? "selected" : ""} onClick={() => { setEvaluationPurpose(`SINGLE:${item.ref}`); setPreflight(null); }}><strong>{contestantDisplayName(item.ref)} 单系统回归</strong><small>Single-system regression</small><span>只验证这一套系统，不生成双系统胜负结论</span></button>)}
    </div></section>}
    <div className="run-form">{intent === "new" ? <label>冻结参评配置 <small>Source experiment</small><select value={effectiveSourceExperimentId} onChange={(event) => { const nextId = event.target.value; const nextContestants = availableTemplates.find((item: Json) => item.id === nextId)?.contestants ?? []; setSourceExperimentId(nextId); setEvaluationPurpose(nextContestants.length > 1 ? "PAIRED_COMPARISON" : nextContestants[0] ? `SINGLE:${nextContestants[0].ref}` : "PAIRED_COMPARISON"); setPreflight(null); }}><option value="">请选择</option>{availableTemplates.map((item: Json) => <option key={item.id} value={item.id}>{item.name} · {item.suite_ref}</option>)}</select></label>
      : <div className="frozen-config"><span>沿用冻结参评配置 <small>Frozen source experiment</small></span>
        <strong>{templates.loading ? "正在读取…" : incompatibleFrozenSource ? "该实验不符合当前可执行评测合同，不能按原配置重新评测" : selectedTemplate?.name ?? "没有可用的冻结配置"}</strong>
        <code>{effectiveSourceExperimentId || defaultExperimentId}</code><small>{incompatibleFrozenSource ? "当前 M3.1 只接受 Manifest 6.0 与 Candidate Adapter 4.0；旧实验继续保留查看，但不能冒充真实产品复评。" : "重新评测不可更换考生；需要更换时请从数据集页面新建评测。"}</small>
        {incompatibleFrozenSource && <a className="text-link" href="/datasets">前往数据集与 Case →</a>}</div>}
      <label>每个 Seed 的重复次数 <small>Replicates per Seed</small><select value={repetitions} onChange={(event) => { setRepetitions(Number(event.target.value)); setPreflight(null); }}>{[1,2,3,4,5].map((value) => <option value={value} key={value}>{value} 次</option>)}</select></label>
      <label className="full">评测原因 <small>Audit reason</small><textarea rows={3} value={reason} onChange={(event) => { setReason(event.target.value); setPreflight(null); }} placeholder="例如：验证新版本是否修复了误判且没有回归" /></label>
      {mode === "TARGETED_REGRESSION" && <label className="full">保存为回归集（可选） <small>Regression set</small><input value={setName} onChange={(event) => setSetName(event.target.value)} placeholder="例如：跨租户安全核心回归集" /></label>}
    </div>
    <div className="selected-summary"><strong>{caseRefs.length} 道评测题目（Cases） · {contestantRefs.length} 名参评考生（Contestants）</strong><span>{caseRefs.slice(0, 4).join("、")}{caseRefs.length > 4 ? ` 等 ${caseRefs.length} 道` : ""}</span><span>{purposeLabel}：{contestantRefs.map(contestantDisplayName).join("、") || "等待选择冻结配置"}</span><span>Seed 决定同一道题的环境扰动；Replicate 是同一 Seed 下的再次独立作答。平台会把两者分别留痕。</span></div>
    {(error || templates.error) && <ErrorBox text={error || templates.error} />}
    {preflight && <PreflightCard data={preflight} />}
    <div className="modal-actions"><button onClick={onClose}>暂不评测</button>{!preflight ? <button className="toolbar-primary" disabled={busy || !effectiveSourceExperimentId} onClick={check}>{busy ? "正在检查…" : "生成执行前检查"}</button>
      : <><button onClick={check}>重新检查</button><button className="toolbar-primary" disabled={busy || !preflight.ready} onClick={start}>{busy ? "正在创建…" : `确认并创建 ${preflight.total_trials} 次 Trial`}</button></>}</div>
  </section></div>;
}

function PreflightCard({ data }: { data: Json }) {
  return <section className={`preflight-card ${data.ready ? "ready" : "blocked"}`}><div className="preflight-head"><div><strong>{data.ready ? "✓ 可以开始" : "× 暂不能开始"}</strong><small>执行前检查（Preflight）</small></div><Tag>{data.mode_label}</Tag></div>
    <div className="preflight-grid"><KeyValue label="评测题目（Cases）" value={data.case_refs.length} /><KeyValue label="参评考生（Contestants）" value={data.contestant_refs.map(contestantDisplayName).join("、")} /><KeyValue label="环境种子（Seeds）" value={(data.environment_seeds ?? []).join("、")} /><KeyValue label="单次评测（Trials）" value={data.total_trials} /><KeyValue label="预计耗时" value={formatDuration(data.estimated_duration_ms)} />
      <KeyValue label="最大工具调用" value={data.budget.maximum_tool_calls} /><KeyValue label="申请并发（Requested）" value={data.budget.requested_concurrency} /><KeyValue label="安全并发（Effective）" value={data.budget.effective_concurrency} /></div>
    <div className="selected-summary"><strong>真实考生开考检查（Candidate readiness）</strong>
      {(data.candidate_checks ?? []).map((item: Json) => <span key={item.ref}>{item.ready ? "✓" : "×"} {contestantDisplayName(item.ref)}：{item.kind === "TEST_DOUBLE" ? "工程测试替身，仅用于平台自测" : item.ready ? `外部产品可达，版本指纹一致，${item.isolation?.safe_parallelism ?? 1} 个安全隔离槽位` : item.error ?? "未就绪"}</span>)}
      <span>{data.budget.isolation_note}</span></div>
    <p className={data.affects_official_score ? "official-warning" : "diagnostic-note"}>{data.score_notice}</p>
    <div className="readiness-list">{Object.entries(data.readiness ?? {}).map(([name, ready]) => <span key={name} className={ready ? "yes" : "no"}>{ready ? "✓" : "×"} {readinessLabel(name)}</span>)}</div>
    {data.blockers?.map((item: string) => <ErrorBox key={item} text={item} />)}<small className="cost-note">费用说明：{data.cost_note}</small></section>;
}

function EvaluationTaskCenter() {
  const tasks = useRemote("/api/workbench/run-requests");
  const [selected, setSelected] = useState("");
  const refreshTasks = tasks.refresh;
  const items = tasks.data?.items ?? [];
  const hasActiveTasks = items.some((item: Json) => ["QUEUED", "RUNNING"].includes(item.status));
  useEffect(() => { if (!hasActiveTasks) return; const timer = window.setInterval(() => void refreshTasks(), 2500); return () => window.clearInterval(timer); }, [hasActiveTasks, refreshTasks]);
  const requested = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("selected") ?? "";
  const current = items.find((item: Json) => item.id === (selected || requested)) ?? items[0];
  const cancel = async () => {
    if (!current) return;
    const confirmed = window.confirm("安全停止会取消尚未开始的 Trial，并通知正在运行的真实考生停止；系统会等待终态、复位 Twin 并保留全部证据。确认继续吗？");
    if (!confirmed) return;
    await requestJson(`/api/workbench/run-requests/${encodeURIComponent(current.id)}/cancel`, {
      method: "POST", body: JSON.stringify({ reason: "operator confirmed safe cancellation from workbench" }),
    });
    await tasks.refresh();
  };
  return <section className="page-content"><PageTitle eyebrow="ASYNC EVALUATION TASKS" title="评测任务（Evaluation Tasks）" text="页面关闭后任务仍会继续。每次人工复评都会创建新实验和新 Trial，不覆盖原始证据；这里只负责调度，不干预 Agent 的求解路径。" />
    {tasks.error && <ErrorBox text={tasks.error} />}<div className="metric-row three"><Metric label="评测任务" value={items.length} foot="每份请求都有操作者与原因" /><Metric label="进行中" value={items.filter((item: Json) => ["QUEUED","RUNNING"].includes(item.status)).length} foot="异步执行，可离开页面" /><Metric label="已收口" value={items.filter((item: Json) => ["COMPLETED","FAILED","CANCELLED"].includes(item.status)).length} foot="成功、失败或取消都有明确结论" accent /></div>
    <div className="task-center-grid"><section className="surface task-index"><SectionHead title="任务队列" sub="排队 · 运行 · 已收口（Queue · Running · Closed）" />{items.length === 0 ? <Empty text="还没有人工发起的评测任务；可从数据集、实验或 Trial 页面发起" /> : <div className="task-list">{items.map((item: Json) => <button className={current?.id === item.id ? "selected" : ""} key={item.id} onClick={() => setSelected(item.id)}><div><Status status={item.status} /><small>{modeLabel(item.mode)}</small></div><strong>{item.reason}</strong><Progress value={item.progress.total ? item.progress.completed / item.progress.total : 0} text={`${item.progress.completed}/${item.progress.total}`} /><code>{item.id}</code></button>)}</div>}</section>
      <section className="surface task-detail">{current ? <><SectionHead title={current.reason} sub={`${modeLabel(current.mode)} · ${formatTime(current.created_at)}`} action={["QUEUED","RUNNING"].includes(current.status) ? <button key="cancel" className="danger-soft" onClick={cancel}>安全停止任务<br/><small>Safe cancellation</small></button> : undefined} />
        <div className="task-authority"><strong>{current.preflight.score_notice}</strong><span>{requestKindLabel(current.selection.request_kind)} · 操作者：{current.requested_by}</span></div>
        {current.cancel_requested_at && <div className="official-warning">已于 {formatTime(current.cancel_requested_at)} 请求安全停止。原因：{current.cancel_reason || "操作者主动停止"}</div>}
        <DecisionReport report={current.decision_report} />
        <div className="preflight-grid"><KeyValue label="状态（Status）" value={STATUS_LABELS[current.status] ?? current.status} /><KeyValue label="评测题目（Cases）" value={current.selection.case_refs.length} /><KeyValue label="参评考生（Contestants）" value={current.selection.contestant_refs.map(contestantDisplayName).join("、")} /><KeyValue label="单次评测（Trials）" value={current.progress.total} /><KeyValue label="新实验" value={current.created_experiment_id ? "已创建" : "等待创建"} /></div>
        {current.error && <ErrorBox title="任务执行失败" text={current.error} />}<SectionHead title="按 Case 查看稳定性" sub="分差范围越小，重复运行越稳定；至少两次有效结果才计算" />
        <div className="stability-strip">{current.case_summaries.map((item: Json) => <div key={item.case_ref}><strong>{item.case_ref}</strong><span>原分差 {formatScore(item.baseline_stability_range)} → 新分差 {formatScore(item.current_stability_range)}</span><small>新通过率 {item.current_pass_rate === null ? "—" : `${Math.round(item.current_pass_rate * 100)}%`}</small></div>)}</div>
        <SectionHead title="原结果与新结果对比" sub="逐次比较分数、通过结论、耗时、公开用量、费用与安全硬门禁；考生未提供的用量显示未知，不按 0 计算" />
        <div className="table-scroll"><table className="data-table comparison-table"><thead><tr><th>Case / 参评架构</th><th>分数变化</th><th>通过变化</th><th>时长变化</th><th>工具变化</th><th>费用变化</th><th>硬门禁变化</th><th>新 Trial</th></tr></thead><tbody>{current.items.map((item: Json) => { const unavailable = comparisonUnavailable(item); return <tr key={item.id}
          className={item.trial_id ? "clickable-row" : ""} role={item.trial_id ? "link" : undefined} tabIndex={item.trial_id ? 0 : undefined}
          aria-label={item.trial_id ? `打开 ${item.case_ref} 的新 Trial` : undefined}
          onClick={(event) => item.trial_id && navigateRow(event, `/trials/${item.trial_id}`)}
          onKeyDown={(event) => item.trial_id && navigateRowByKeyboard(event, `/trials/${item.trial_id}`)}>
          <td><strong>{item.case_ref}</strong><small>{contestantDisplayName(item.contestant_ref)} · Seed {item.environment_seed} · 第 {item.repeat_index} 次</small>{item.failure && <small className="failure-inline">{failureCategoryLabel(item.failure.category)} · {item.failure.zh}</small>}{item.status === "CANCELLED" && <small className="failure-inline">前序 Trial 失败后任务已收口，本 Trial 未执行。</small>}</td>
          <td>{unavailable ?? `${formatScore(item.baseline?.score)} → ${formatScore(item.current?.score)}`}</td><td>{unavailable ?? comparePassed(item.baseline?.passed, item.current?.passed)}</td><td>{unavailable ?? compareMetric(item.baseline?.duration_ms, item.current?.duration_ms, formatDuration)}</td><td>{unavailable ?? compareUsageMetric(item.baseline, item.current, "tool_calls", String)}</td><td>{unavailable ?? costChange(item.baseline, item.current)}</td><td>{unavailable ?? hardGateChange(item.baseline, item.current)}</td><td>{item.trial_id ? <a className="text-link" href={`/trials/${item.trial_id}`}>查看单次评测（Trial）→</a> : <Status status={item.status} />}</td></tr>; })}</tbody></table></div>
        {current.created_experiment_id && <a className="primary-link" href={`/experiments/${current.created_experiment_id}`}>打开新实验与全部证据 →</a>}</> : <Empty text="选择一个评测任务查看详情" />}</section></div>
  </section>;
}

function DecisionReport({ report }: { report: Json | null }) {
  if (!report) return null;
  const comparison = report.comparison;
  const interval = comparison?.clustered_bootstrap?.interval;
  const formal = report.decision_authority === "FORMAL_DECISION";
  return <section className={report.ready ? "decision-report ready" : "decision-report blocked"}>
    <div className="decision-title"><div><span>本次能下什么结论（Decision report）</span><strong>{formal ? "正式统计结论" : "诊断结论 · 不宣布胜负"}</strong></div><Tag>{report.conclusion_code}</Tag></div>
    <p>{report.explanation_zh}</p>
    <div className="decision-kpis"><Mini label="有效计分 Trial" value={report.sample.scored_trials} /><Mini label="Case 数" value={report.sample.cases} /><Mini label="完整配对" value={comparison ? `${comparison.paired_trials}/${comparison.expected_pairs}` : "单系统"} /><Mini label="证据不完整" value={report.evidence_quality.unresolved_evidence_trials} /></div>
    {comparison?.clustered_bootstrap && <div className="decision-comparison"><strong>配对平均分差：{comparison.clustered_bootstrap.mean_delta > 0 ? "+" : ""}{comparison.clustered_bootstrap.mean_delta}</strong><span>{comparison.score_delta_definition}</span><span>{Math.round(comparison.clustered_bootstrap.confidence * 100)}% 置信区间：[{interval[0]}, {interval[1]}]</span>{comparison.formal_winner && <b>正式领先：{contestantDisplayName(comparison.formal_winner)}</b>}</div>}
    <small>{report.evidence_quality.note_zh}</small>
  </section>;
}
function Metric({ label, value, foot, accent = false, href }: { label: string; value: any; foot: string; accent?: boolean; href?: string }) {
  const content = <><span>{label}</span><strong>{value}</strong><small>{foot}</small>{href && <i aria-hidden="true">打开 →</i>}</>;
  return href ? <a className={`metric metric-link ${accent ? "accent" : ""}`} href={href} aria-label={`${label}：${value}，打开详情`}>{content}</a>
    : <article className={`metric ${accent ? "accent" : ""}`}>{content}</article>;
}
function PageTitle({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) { return <div className="page-title"><span className="kicker">{eyebrow}</span><h1>{title}</h1><p>{text}</p></div>; }
function SectionHead({ title, sub, action }: { title: string; sub: string; action?: React.ReactNode }) { return <div className="section-head"><div><h2>{title}</h2><p>{sub}</p></div>{action}</div>; }
function Status({ status }: { status: string }) { const key = String(status ?? "UNKNOWN").toLowerCase(); const english = ({ COMPLETED: "Completed", RUNNING: "Running", QUEUED: "Queued", FAILED: "Failed", PASSED: "Passed", IN_PROGRESS: "In progress", CANCELLED: "Cancelled", FROZEN: "Frozen design" } as Record<string,string>)[status]; return <span className={`status status-${key}`}>{STATUS_LABELS[status] ?? status}{english && <small>{english}</small>}</span>; }
function Tag({ children }: { children: React.ReactNode }) { return <span className="tag">{children}</span>; }
function Progress({ value, text }: { value: number; text: string }) { return <div className="progress"><div><i style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} /></div><small>{text}</small></div>; }
function Authority({ n, title, badge, text }: { n: string; title: string; badge: string; text: string }) { return <div className="authority"><span>{n}</span><div><div><strong>{title}</strong><Tag>{badge}</Tag></div><p>{text}</p></div></div>; }
function KeyValue({ label, value }: { label: string; value: any }) { return <div className="key-value"><span>{label}</span><strong>{String(value ?? "—")}</strong></div>; }
function Mini({ label, value }: { label: string; value: any }) { return <div className="mini"><strong>{value}</strong><span>{label}</span></div>; }
function ScoreBadge({ score, passed, large = false, official = true }: { score: any; passed: boolean; large?: boolean; official?: boolean }) { return <div className={`score-badge ${passed ? "pass" : "fail"} ${large ? "large" : ""}`}><strong>{formatScore(score)}</strong><span>{passed ? official ? "正式通过" : "本次通过 · 不计正式成绩" : official ? "正式未通过" : "本次未通过"}</span></div>; }
function JsonBlock({ value, label = "查看结构化原始记录（Raw data）" }: { value: any; label?: string }) { return <details className="json-block"><summary>{label}</summary><pre>{JSON.stringify(value ?? {}, null, 2)}</pre></details>; }
function ErrorBox({ text, title = "出现问题" }: { text: string; title?: string }) { return <div className="error-box"><strong>{title}</strong><span>{text}</span></div>; }
function Empty({ text }: { text: string }) { return <div className="empty"><span>◇</span><p>{text}</p></div>; }
function Loading({ inline = false }: { inline?: boolean }) { return <div className={inline ? "loading inline" : "loading"}><span /><span /><span /><p>正在读取真实评测数据</p></div>; }
function shortHash(value: any) { const text = String(value ?? "").replace(/^sha256:/, ""); return text ? `${text.slice(0, 8)}…${text.slice(-6)}` : "—"; }
function formatDuration(value: any) { const ms = Number(value); if (!Number.isFinite(ms)) return "—"; if (ms < 1000) return `${ms}ms`; if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`; return `${Math.floor(ms / 60000)}m ${Math.round(ms % 60000 / 1000)}s`; }
function formatBytes(value: any) { const bytes = Number(value ?? 0); if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function laneLabel(value: any) { return ({ ENGINEERING_TEST: "工程自测通道（Engineering test）", AGENT_CAPABILITY: "Agent 能力通道（Agent capability）", CONTROLLED_CLOSURE: "受控闭环通道（Controlled closure）", PRODUCT_RELIABILITY: "产品可靠性通道（Product reliability）" } as Record<string,string>)[value] ?? value ?? "—"; }
function formatScore(value: any) { if (value === null || value === undefined || value === "") return "—"; const score = Number(value); return Number.isFinite(score) ? score.toFixed(2) : "—"; }
function formatCost(value: any) { const cost = Number(value); return Number.isFinite(cost) ? `$${cost.toFixed(4)}` : "—"; }
function formatTime(value: any) { if (!value) return "—"; return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }
function humanize(value: string) { return String(value).replaceAll("_", " ").replaceAll(".", " · "); }
function contestantDisplayName(value: string) { const ref = String(value ?? ""); const normalized = ref.toLowerCase();
  if (normalized.includes("langgraph")) return "LangGraph OpsMind";
  if (normalized.includes("agent-harness") || normalized.includes("agentic") || normalized.includes("claude")) return "Agent+Harness OpsMind";
  if (["mock-contestant-a", "test-double-a"].includes(normalized)) return "工程测试替身 A（Test double · 非真实考生）";
  if (["mock-contestant-b", "test-double-b"].includes(normalized)) return "工程测试替身 B（Test double · 非真实考生）";
  return ref;
}
function runClassLabel(value: any) { return value === "REAL_CANDIDATE" ? "真实考生（Real candidate）" : value === "ENGINEERING_TEST" ? "工程测试替身（Engineering test only）" : "历史实验（Legacy record）"; }
function RunClassBadge({ value }: { value: any }) { return <Tag>{runClassLabel(value)}</Tag>; }
function operationModeLabel(value: any) { return ({ diagnosis_only: "只诊断（Diagnosis only）", human_collaboration: "人工审批（Human approval）", controlled_auto: "受控自动修复（Controlled auto）" } as Record<string,string>)[value] ?? value ?? "未标注（Not specified）"; }
function failureCategoryLabel(value: string) { return ({
  OPERATOR_CANCELLED: "操作员主动取消（Operator cancelled）", BUDGET_EXCEEDED: "预算超限（Budget exceeded）",
  CANDIDATE_SAFETY_FAILURE: "考生安全失败（Candidate safety）", CANDIDATE_CAPABILITY_FAILURE: "考生能力失败（Candidate capability）",
  PRODUCT_RELIABILITY_FAILURE: "考生产品可靠性失败（Product reliability）", PLATFORM_CLEANUP_FAILURE: "EvalOS 考场清理失败（Platform cleanup）",
  RATE_LIMIT: "外部服务限流（Rate limit）", TRANSPORT_RESET: "连接临时中断（Transport reset）",
  TEMPORARY_UNAVAILABLE: "上游暂时不可用（Temporary unavailable）", PLATFORM_CONFIGURATION_FAILURE: "平台配置错误（Platform configuration）",
  UNCLASSIFIED_NON_RETRYABLE: "未归类且不重试（Unclassified）",
} as Record<string,string>)[value] ?? humanize(value); }
function usageValue(usage: Json | null, name: string, formatter: (value: any) => string = String) {
  const measurement = usage?.measurement;
  if (measurement?.unavailable_dimensions?.includes(name)) return "未提供（Not reported）";
  if (!usage || !Object.prototype.hasOwnProperty.call(usage, name)) return "未记录（Unknown）";
  const value = Number(usage[name]);
  return Number.isFinite(value) ? formatter(value) : "未记录（Unknown）";
}
function compareUsageMetric(before: Json | null, after: Json | null, name: string, formatter: (value: any) => string) {
  if (!after) return "等待结果";
  const display = (sample: Json | null) => {
    if (!sample) return "—";
    if (sample.usage_measurement?.unavailable_dimensions?.includes(name)) return "未提供";
    const value = Number(sample[name]);
    return Number.isFinite(value) ? formatter(value) : "未知";
  };
  return `${display(before)} → ${display(after)}`;
}

function LiveProgress({ progress }: { progress: Json }) {
  if (!progress) return null;
  const stateLabel = progress.progress_state === "QUEUED" ? "等待独立考场" : progress.progress_state === "ACTIVE" ? "持续推进" : progress.progress_state === "WAITING" ? "在线等待/需关注" : progress.progress_state === "STOPPING" ? "安全停止处理中" : progress.progress_state === "TERMINAL" ? "已收口" : "可能卡住";
  const displayStatus = progress.progress_state === "QUEUED" ? "QUEUED" : progress.progress_state === "STOPPING" || progress.liveness === "LIVE" ? "RUNNING" : progress.progress_state === "TERMINAL" ? "COMPLETED" : "FAILED";
  return <section className={`live-progress state-${String(progress.progress_state).toLowerCase()}`} aria-live="polite">
    <div className="live-progress-head"><div><span className="live-dot" /><strong>实时调查进展（Live progress）</strong><small>{stateLabel} · 每5秒自动刷新</small></div>
      <Status status={displayStatus} /></div>
    <Progress value={Number(progress.budget_ratio ?? 0)} text={`已运行 ${formatDuration(progress.elapsed_ms)} / Trial上限 ${formatDuration(progress.total_budget_ms)} · 剩余 ${formatDuration(progress.remaining_ms)}`} />
    <div className="live-progress-grid"><Mini label="最近系统活动" value={progress.activity?.age_ms == null ? "尚无" : `${formatDuration(progress.activity.age_ms)}前`} />
      <Mini label="最近实质进展" value={progress.meaningful_progress?.age_ms == null ? "尚无" : `${formatDuration(progress.meaningful_progress.age_ms)}前`} />
      <Mini label="外显事件" value={progress.counters?.candidate_events ?? 0} /><Mini label="工具结果" value={progress.counters?.tool_results ?? 0} /></div>
    <div className="live-progress-copy"><p><b>当前可见动作：</b>{progress.meaningful_progress?.summary_zh}</p><p><b>系统判断：</b>{progress.interpretation_zh}</p>
      <small>15分钟是进展检查点，不是死亡线；这里只展示外显事件和机器日志，不展示或伪造Agent隐式思维链，也不按日志数量计分。</small></div>
  </section>;
}
function comparisonUnavailable(item: Json) {
  if (item.status === "CANCELLED") return "未执行（Not run）";
  if (item.status === "FAILED" && (item.current?.score === null || item.current?.score === undefined)) return "执行失败，无评分（Failed before grading）";
  return null;
}
function hardGateLabel(value: string) { return ({ task_outcome: "任务结果（Task outcome）", evidence_integrity: "证据完整性（Evidence integrity）", scope_safety: "范围安全（Scope safety）", approval_integrity: "审批完整性（Approval integrity）", execution_safety: "执行安全（Execution safety）", independent_verification: "独立验证（Independent verification）", reset_integrity: "环境复位（Reset integrity）", expected_status: "结果状态符合预期（Expected status）", root_cause_or_justified_inconclusive: "根因正确或有理有据地停止（Root cause / justified stop）", no_forbidden_claim: "没有禁断结论（No forbidden claim）", evidence_traceable: "证据可追溯（Traceable evidence）", minimum_evidence_recall: "关键证据覆盖（Evidence recall）", recovery: "失败恢复（Recovery）", no_unsafe_tool_attempt: "无越权尝试（No unsafe attempt）", environment_task_success: "实验环境任务成功（Environment task）" } as Record<string,string>)[value] ?? humanize(value); }
function yesNo(value: any) { return value ? "是（Yes）" : "否（No）"; }
function requestKindLabel(value: string) { return value === "RERUN_FROZEN" ? "按原配置重新评测（Rerun）" : "新建评测（New evaluation）"; }
function stableToken(value: unknown) { const text = JSON.stringify(value); let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function analysisMode(value: string) { return ({ optimization_research: "优化深研", case_diagnosis: "Case 诊断", score_explanation: "评分解释" } as Record<string, string>)[value] ?? humanize(value); }
function modeLabel(value: string) { return ({ QUICK_VALIDATION: "快速验证（Quick validation）", TARGETED_REGRESSION: "定向回归（Targeted regression）", FORMAL: "正式评测（Formal evaluation）" } as Record<string,string>)[value] ?? value; }
function readinessLabel(value: string) { return ({ model_and_adapter: "模型与适配器（Model & adapter）", twin: "EvalOS 与两名考生都已连接数字孪生（Twin）", run_class_separation: "真实考生与测试替身隔离（Run class）", external_candidate_api: "真实产品公开接口（Product API）", candidate_budget_alignment: "考生最长运行不超过 Trial 时间预算（Budget alignment）", candidate_fingerprint: "考生版本指纹一致（Fingerprint）", approval_identity_separation: "提交、审批、管理账号分离（Separation of duties）", candidate_least_privilege: "三个评测账号均为最小权限（Least privilege）", candidate_tenant_isolation: "考生评测租户隔离（Tenant isolation）", formal_release_gate: "正式开考放行（Formal gate）", isolated_namespace: "Trial 隔离运行空间（Namespace）", environment_reset: "环境复位（Reset）", deterministic_grader: "确定性评分器（Code grader）" } as Record<string,string>)[value] ?? humanize(value); }
function comparePassed(before: any, after: any) { if (after === null || after === undefined) return "等待结果"; if (before === null || before === undefined) return after ? "— → 通过" : "— → 未通过"; return `${before ? "通过" : "未通过"} → ${after ? "通过" : "未通过"}`; }
function compareMetric(before: any, after: any, formatter: (value: any) => string) { if (after === null || after === undefined) return "等待结果"; return `${before === null || before === undefined ? "—" : formatter(before)} → ${formatter(after)}`; }
function costChange(before: Json | null, after: Json | null) { if (!after) return "等待结果"; if (after.cost_usd === null || after.cost_usd === undefined) return "未提供（Not reported）"; return `${before?.cost_usd === null || before?.cost_usd === undefined ? "—" : formatCost(before.cost_usd)} → ${formatCost(after.cost_usd)}`; }
function hardGateChange(before: Json | null, after: Json | null) { if (!after) return "等待结果"; const display = (value: Json | null) => value ? `${value.hard_gates_passed}/${value.hard_gates_total}` : "—"; return `${display(before)} → ${display(after)}`; }
function average(values: any[]) { const numbers = values.map(Number).filter(Number.isFinite); return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null; }
function navigateRow(event: React.MouseEvent<HTMLElement>, href: string) {
  const target = event.target as HTMLElement;
  if (target.closest("button,input,textarea,select,summary")) return;
  const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
  if (anchor) event.preventDefault();
  window.location.assign(anchor?.getAttribute("href") ?? href);
}
function navigateRowByKeyboard(event: React.KeyboardEvent<HTMLElement>, href: string) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  window.location.assign(href);
}
