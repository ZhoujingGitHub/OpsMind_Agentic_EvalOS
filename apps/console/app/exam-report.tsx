"use client";
/* Report-card, funnel and annotation views render versioned EvalOS JSON whose shape varies by grader. */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useState } from "react";

type Json = Record<string, any>;

const STAGE_LABELS: Record<string, string> = { finish: "交卷", evidence: "查证据", diagnosis: "定病根", action: "处置", verification: "复核", closure: "收尾" };

export const GATE_LABELS: Record<string, string> = {
  did_not_finish: "考生自己没答完（按不通过计）",
  evidence_traceable: "证据都能在本场记录里找到", tool_recovery: "首查失败后自己换路或重试",
  required_observations: "查过这类故障该查的现场数据", root_cause_exact: "指中被改动的那处状态",
  expected_status: "结论状态符合预期", safety: "没有越权尝试、没碰诱饵", change_discipline: "改动次数合规",
  approval_integrity: "审批、授权与执行留痕合规", candidate_verification: "改完后考生自己做了独立复核",
  business_outcome: "实验室独立复测：业务确实恢复", reset_integrity: "考场复位干净",
};

export const VARIANT_LABELS: Record<string, string> = { main: "主考", diagnosis: "只诊断", auto: "受控自动", noise: "噪声干扰",
  injection: "提示注入", regression: "首查失败", public: "公开集", hidden: "隐藏集", safety: "安全集" };

async function requestJson(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `请求失败（${response.status}）`);
  return body;
}

function candidateName(ref: string) {
  const normalized = String(ref ?? "").toLowerCase();
  if (normalized.includes("harness")) return "AH（Agent+Harness）";
  if (normalized.includes("langgraph")) return "LG（LangGraph）";
  return ref || "匿名考生";
}

function ratio(numerator: number, denominator: number) {
  return denominator ? `${numerator}/${denominator}` : "—";
}

function Bar({ value, total, tone = "green" }: { value: number; total: number; tone?: "green" | "amber" | "red" }) {
  const width = total ? Math.round((value / total) * 100) : 0;
  return <span className={`mini-bar tone-${tone}`} aria-hidden="true"><i style={{ width: `${width}%` }} /></span>;
}

function Cell({ cell }: { cell: Json | undefined }) {
  if (!cell || !cell.trials) return <td className="report-cell empty">—</td>;
  return <td className="report-cell">
    <div><b>{ratio(cell.passed, cell.graded)}</b><small>通过</small><Bar value={cell.passed} total={cell.graded} /></div>
    <div><span>{ratio(cell.business_recovered, cell.business_applicable)}</span><small>业务恢复</small>
      <Bar value={cell.business_recovered} total={cell.business_applicable} tone="amber" /></div>
    <div><span>{ratio(cell.root_cause_exact, cell.root_cause_applicable)}</span><small>根因精确</small>
      <Bar value={cell.root_cause_exact} total={cell.root_cause_applicable} tone="red" /></div>
    {cell.did_not_finish > 0 && <small className="report-warn">其中 {cell.did_not_finish} 场考生自己没答完，按不通过计</small>}
    {cell.not_completed > 0 && <small className="report-warn">{cell.not_completed} 场没出成绩（考场原因或还没跑完，不计成绩）</small>}
  </td>;
}

function ReportTable({ title, sub, rows, candidates }: { title: string; sub: string; rows: Json[]; candidates: string[] }) {
  return <section className="surface"><div className="section-head"><div><h2>{title}</h2><p>{sub}</p></div></div>
    <div className="table-scroll"><table className="data-table report-table"><thead><tr><th>类别</th>
      {candidates.map((ref) => <th key={ref}>{candidateName(ref)}</th>)}</tr></thead><tbody>
      {rows.map((row) => <tr key={row.key}><td><strong>{row.label}</strong><small>{row.key}</small></td>
        {candidates.map((ref) => <Cell key={ref} cell={row.candidates?.[ref]} />)}</tr>)}
    </tbody></table></div></section>;
}

function FunnelBars({ steps }: { steps: Json[] }) {
  const top = Math.max(1, ...steps.map((step) => step.reached));
  return <div className="funnel-bars">{steps.filter((step) => step.reached > 0).map((step) => <div key={step.gate} className="funnel-step">
    <span className="funnel-stage">{STAGE_LABELS[step.stage] ?? step.stage}</span>
    <strong>{GATE_LABELS[step.gate] ?? step.gate}</strong>
    <span className="funnel-track"><i style={{ width: `${Math.round(step.reached / top * 100)}%` }} />
      {step.failed_here > 0 && <em style={{ width: `${Math.round(step.failed_here / top * 100)}%` }} />}</span>
    <small>走到这一步 {step.reached} 场{step.failed_here ? `，在这里卡住 ${step.failed_here} 场` : ""}</small>
  </div>)}</div>;
}

function Counts({ title, items, labels = {} }: { title: string; items: Json[]; labels?: Record<string, string> }) {
  return <div className="taxonomy-block"><strong>{title}</strong>{items.length === 0 ? <p className="muted">暂无</p>
    : <ul>{items.slice(0, 12).map((item) => <li key={item.name}><span>{labels[item.name] ?? item.name}</span><b>{item.count}</b></li>)}</ul>}</div>;
}

export function ReportCardPanel({ experimentId }: { experimentId: string }) {
  const [card, setCard] = useState<Json | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    requestJson(`/api/workbench/experiments/${encodeURIComponent(experimentId)}/report-card`)
      .then((value) => { if (active) setCard(value); }).catch((reason) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [experimentId]);
  if (error) return <div className="error-box"><strong>成绩单读取失败</strong><span>{error}</span></div>;
  if (!card) return null;
  const graded = card.same_case?.some((row: Json) => Object.values(row.candidates ?? {}).some((cell: any) => cell.passed !== null));
  if (!graded) return <section className="surface"><div className="section-head"><div><h2>成绩单</h2>
    <p>本实验还没有判分 7.0 的成绩；成绩单只统计判分 7.0 的场次，历史场次按当时的判分程序展示在单场页面里。</p></div></div></section>;
  const candidates: string[] = card.candidates ?? [];
  return <div className="report-card">
    <div className="authority-banner"><strong>成绩单（按大类，不算总分）</strong><p>{card.notice}。{card.identity_state === "BLINDED"
      ? "实验未关闭，考生身份仍是盲态编号。" : "实验已关闭，考生身份已揭示。"}</p></div>
    <ReportTable title="按故障大类" sub="每格三行：通过 / 业务恢复 / 根因精确。修好不能抵诊断（31 甲），所以两者分开看" rows={card.by_category} candidates={candidates} />
    <ReportTable title="按考法" sub="同一批故障在不同考法和干扰下的表现" rows={card.by_variant} candidates={candidates} />
    <section className="surface"><div className="section-head"><div><h2>失败漏斗</h2><p>按调查顺序排列的硬门：每一行是走到这一步的场次，红色是在这一步卡住的场次</p></div></div>
      <div className="funnel-grid">{candidates.map((ref) => <div key={ref}><h3>{candidateName(ref)}</h3><FunnelBars steps={card.funnel?.[ref] ?? []} /></div>)}</div></section>
    <section className="surface"><div className="section-head"><div><h2>同题对比</h2><p>同一道题两名考生并排；点击结果进入单场工作台</p></div></div>
      <div className="table-scroll"><table className="data-table compare-table"><thead><tr><th>题目</th><th>场景</th><th>考法</th>
        {candidates.map((ref) => <th key={ref}>{candidateName(ref)}</th>)}</tr></thead><tbody>
        {card.same_case.map((row: Json) => <tr key={row.case_ref}><td><code>{row.case_ref}</code></td><td>{row.scenario_id ?? "—"}</td>
          <td>{VARIANT_LABELS[row.variant] ?? row.variant ?? "—"}</td>
          {candidates.map((ref) => { const cell = row.candidates?.[ref]; if (!cell) return <td key={ref}>—</td>;
            return <td key={ref}><a className={`compare-cell ${cell.passed ? "pass" : cell.passed === false ? "fail" : "pending"}`} href={`/trials/${cell.trial_id}`}>
              {cell.passed ? "✓ 通过" : cell.passed === false ? "× 未通过" : "未完成"}
              {cell.first_failed_gate && <small>卡在：{GATE_LABELS[cell.first_failed_gate.gate] ?? cell.first_failed_gate.gate}</small>}
            </a></td>; })}
        </tr>)}
      </tbody></table></div></section>
    <section className="surface"><div className="section-head"><div><h2>错误归类</h2>
      <p>标注进度 {card.taxonomy.annotation_progress.annotated}/{card.taxonomy.annotation_progress.trials} 场，其中人工复核 {card.taxonomy.annotation_progress.human_reviewed} 场</p></div></div>
      <div className="taxonomy-grid"><Counts title="标注标签" items={card.taxonomy.annotation_tags} />
        <Counts title="标注认定的第一个出错步骤" items={card.taxonomy.annotation_first_failures} labels={GATE_LABELS} />
        <Counts title="AI 调查员归纳的问题类别" items={card.taxonomy.investigator_issue_categories} /></div></section>
  </div>;
}

export function FunnelView({ grade }: { grade: Json }) {
  const steps: Json[] = grade?.funnel ?? [];
  if (!steps.length) return null;
  const first = grade.first_failed_gate?.gate;
  return <div className="trial-funnel">{steps.map((step, index) => <div key={step.gate}
    className={`trial-funnel-step ${step.applicable === false ? "na" : step.passed ? "pass" : "fail"} ${first === step.gate ? "first" : ""}`}>
    <span>{index + 1}</span><div><small>{STAGE_LABELS[step.stage] ?? step.stage}</small>
      <strong>{GATE_LABELS[step.gate] ?? step.label ?? step.gate}</strong>
      <em>{step.applicable === false ? "本题不适用" : step.passed ? "通过" : first === step.gate ? "第一个没过的一步" : "未通过"}</em></div>
  </div>)}</div>;
}

const ANNOTATOR_KEY = "evalos-annotator";

function storedAnnotator() {
  if (typeof window === "undefined") return "";
  try { return window.localStorage.getItem(ANNOTATOR_KEY) ?? ""; } catch { return ""; }
}

export function AnnotationPanel({ trialId, experimentId }: { trialId: string; experimentId: string }) {
  const [items, setItems] = useState<Json[]>([]);
  // This panel only mounts after a tab is chosen in the browser, so reading the
  // remembered name lazily never races server rendering.
  const [annotator, setAnnotator] = useState(() => storedAnnotator() || "产品经理");
  const [verdict, setVerdict] = useState("pending");
  const [gate, setGate] = useState("");
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [siblings, setSiblings] = useState<string[]>([]);
  const load = useCallback(() => requestJson(`/api/workbench/trials/${encodeURIComponent(trialId)}/annotations`)
    .then((body) => setItems(body.items ?? [])).catch((reason) => setError(reason.message)), [trialId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    requestJson(`/api/workbench/experiments/${encodeURIComponent(experimentId)}`)
      .then((body) => setSiblings((body.trials ?? []).map((item: Json) => item.id))).catch(() => setSiblings([]));
  }, [experimentId]);
  const position = useMemo(() => siblings.indexOf(trialId), [siblings, trialId]);
  const go = useCallback((offset: number) => {
    const next = siblings[position + offset];
    if (next) window.location.href = `/trials/${next}#annotation`;
  }, [siblings, position]);
  const save = useCallback(async () => {
    setBusy(true); setError(""); setSaved("");
    try {
      try { window.localStorage.setItem(ANNOTATOR_KEY, annotator); } catch { /* storage is a convenience only */ }
      await requestJson(`/api/workbench/trials/${encodeURIComponent(trialId)}/annotations`, { method: "POST",
        body: JSON.stringify({ annotator, annotator_kind: "human", verdict, first_failure_gate: gate || null,
          tags: tags.split(/[,，、]/).map((item) => item.trim()).filter(Boolean), note }) });
      setSaved("已保存"); await load();
    } catch (reason: any) { setError(reason.message); } finally { setBusy(false); }
  }, [annotator, verdict, gate, tags, note, trialId, load]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const key = event.key.toLowerCase();
      if (key === "p") setVerdict("pass");
      else if (key === "f") setVerdict("fail");
      else if (key === "d") setVerdict("pending");
      else if (key === "j") go(1);
      else if (key === "k") go(-1);
      else if (key === "s" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, save]);
  return <div className="split-grid annotation-grid"><section className="surface annotation-panel">
    <div className="section-head"><div><h2>讲评标注</h2><p>只记你的判断，不改官方成绩。快捷键：P 通过 · F 未通过 · D 待定 · J/K 下一场/上一场 · Ctrl+S 保存</p></div></div>
    <div className="annotation-progress">本实验第 {position >= 0 ? position + 1 : "—"} / {siblings.length || "—"} 场</div>
    <label>标注人<input value={annotator} onChange={(event) => setAnnotator(event.target.value)} /></label>
    <div className="verdict-row" role="group" aria-label="你的判断">{[["pass", "✓ 通过（P）"], ["fail", "× 未通过（F）"], ["pending", "… 待定（D）"]]
      .map(([value, label]) => <button key={value} className={verdict === value ? "active" : ""} aria-pressed={verdict === value}
        onClick={() => setVerdict(value)}>{label}</button>)}</div>
    <label>第一个出错的步骤<select value={gate} onChange={(event) => setGate(event.target.value)}><option value="">（不适用 / 没出错）</option>
      {Object.entries(GATE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>标签（用逗号分隔）<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="例如：指认太笼统，把复查当病根" /></label>
    <label>一句话原因<textarea rows={4} value={note} onChange={(event) => setNote(event.target.value)} /></label>
    {error && <div className="error-box"><strong>保存失败</strong><span>{error}</span></div>}
    <div className="inline-actions"><button className="primary-action" disabled={busy || !annotator.trim()} onClick={() => void save()}>{busy ? "正在保存…" : "保存标注"}</button>
      <button disabled={position <= 0} onClick={() => go(-1)}>← 上一场</button><button disabled={position < 0 || position >= siblings.length - 1} onClick={() => go(1)}>下一场 →</button>
      {saved && <span className="saved-hint">{saved}</span>}</div>
  </section><aside className="surface"><div className="section-head"><div><h2>标注记录</h2><p>只追加，不改写；AI 首轮与人工复核分开记</p></div></div>
    {items.length === 0 ? <p className="muted">还没有标注</p> : <div className="annotation-list">{[...items].reverse().map((item) => <div key={item.id} className={`annotation-item verdict-${item.verdict}`}>
      <div><strong>{item.annotator}</strong><small>{item.annotator_kind === "ai_first_pass" ? "AI 首轮" : "人工"} · {new Date(item.created_at).toLocaleString("zh-CN")}</small></div>
      <b>{item.verdict === "pass" ? "通过" : item.verdict === "fail" ? "未通过" : "待定"}</b>
      {item.first_failure_gate && <span>第一个出错：{GATE_LABELS[item.first_failure_gate] ?? item.first_failure_gate}</span>}
      {item.tags?.length > 0 && <span>标签：{item.tags.join("、")}</span>}{item.note && <p>{item.note}</p>}
    </div>)}</div>}
  </aside></div>;
}

// Render what the candidate actually saw in the shape an engineer reads it:
// firewall rules, links and routes as tables, not as raw JSON.
function collectRecords(value: any, found: Json[] = [], depth = 0): Json[] {
  if (!value || typeof value !== "object" || depth > 8 || found.length > 12) return found;
  if (Array.isArray(value)) { value.forEach((item) => collectRecords(item, found, depth + 1)); return found; }
  if (Array.isArray(value.tables) || Array.isArray(value.interfaces) || Array.isArray(value.routes)) found.push(value);
  Object.values(value).forEach((item) => collectRecords(item, found, depth + 1));
  return found;
}

function SmallTable({ title, columns, rows }: { title: string; columns: string[]; rows: Json[] }) {
  if (!rows.length) return null;
  return <div className="evidence-table"><strong>{title}</strong><div className="table-scroll"><table><thead><tr>{columns.map((name) => <th key={name}>{name}</th>)}</tr></thead>
    <tbody>{rows.slice(0, 40).map((row, index) => <tr key={index}>{columns.map((name) => <td key={name}>{Array.isArray(row[name])
      ? row[name].join(",") : String(row[name] ?? "")}</td>)}</tr>)}</tbody></table></div></div>;
}

export function EvidenceTables({ payload }: { payload: any }) {
  const records = collectRecords(payload);
  if (!records.length) return null;
  return <div className="evidence-tables">{records.map((record, index) => <div key={index}>
    {Array.isArray(record.tables) && record.tables.map((table: Json, tableIndex: number) => <SmallTable key={tableIndex}
      title={`防火墙规则 · ${record.kernel_namespace ?? ""} ${table.table ?? ""}`.trim()}
      columns={["chain", "position", "protocol", "destination_port", "target", "packets", "bytes"]} rows={table.rules ?? []} />)}
    {Array.isArray(record.interfaces) && <SmallTable title={`网络接口 · ${record.node_profile ?? ""}`}
      columns={["ifname", "operstate", "qdisc", "mtu", "flags"]} rows={record.interfaces} />}
    {Array.isArray(record.routes) && <SmallTable title={`路由表 · ${record.node_profile ?? ""}`}
      columns={["dst", "gateway", "dev", "protocol", "scope"]} rows={record.routes} />}
  </div>)}</div>;
}
