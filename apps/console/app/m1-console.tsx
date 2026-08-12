"use client";

import { useEffect, useMemo, useState } from "react";

type Snapshot = {
  generated_at: string | null;
  gate: string;
  status: string;
  summary: { trials: number; total_trials: number; replay_rate: number; average_score: number; first_event_ms: number; ledger_valid: boolean };
  experiment: null | { id: string; name: string; status: string; manifest_hash: string; model: string; runtime: string };
  trials: Array<{ id: string; case_id: string; seed: number; blind_id: string; status: string; score: number; tool_calls: number }>;
  trace: Array<{ seq: number; kind: string; actor: string; timestamp: string; redacted: boolean; summary: string }>;
  checks: Array<{ id: string; passed: boolean }>;
};

type ApiTraceEvent = {
  seq: number;
  kind: string;
  actor: string;
  timestamp: string;
  redacted: boolean;
  payload: Record<string, unknown>;
};

const EMPTY: Snapshot = {
  generated_at: null,
  gate: "G1",
  status: "LOADING",
  summary: { trials: 0, total_trials: 12, replay_rate: 0, average_score: 0, first_event_ms: 0, ledger_valid: false },
  experiment: null,
  trials: [],
  trace: [],
  checks: [],
};

function apiBase() {
  if (typeof window === "undefined") return "http://127.0.0.1:8787";
  return `${window.location.protocol}//${window.location.hostname}:8787`;
}

export function M1Console() {
  const [data, setData] = useState<Snapshot>(EMPTY);
  const [selectedTrial, setSelectedTrial] = useState<string | null>(null);
  const [trace, setTrace] = useState<Snapshot["trace"]>([]);
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"trials" | "manifest" | "ledger">("trials");

  useEffect(() => {
    fetch("/m1-snapshot.json")
      .then((response) => response.json())
      .then((snapshot: Snapshot) => {
        setData(snapshot);
        setSelectedTrial(snapshot.trials[0]?.id ?? null);
        setTrace(snapshot.trace);
      })
      .catch(() => setToast("无法读取 M1 验收快照，请先运行 npm run accept:m1。"));
  }, []);

  useEffect(() => {
    if (!selectedTrial) return;
    const snapshotTrial = data.trials[0]?.id === selectedTrial;
    fetch(`${apiBase()}/api/trials/${encodeURIComponent(selectedTrial)}/trace`)
      .then((response) => {
        if (!response.ok) throw new Error("offline");
        return response.json();
      })
      .then((body: { items: ApiTraceEvent[] }) => setTrace(body.items.map((event) => ({
        seq: event.seq,
        kind: event.kind,
        actor: event.actor,
        timestamp: event.timestamp,
        redacted: event.redacted,
        summary: String(event.payload.tool ?? event.payload.rationale_summary ?? event.payload.status ?? event.payload.outcome_status ?? event.kind),
      }))))
      .catch(() => {
        if (snapshotTrial) setTrace(data.trace);
      });
  }, [selectedTrial, data]);

  const selected = useMemo(() => data.trials.find((trial) => trial.id === selectedTrial), [data.trials, selectedTrial]);

  async function createAndRun() {
    setRunning(true);
    setToast("正在创建独立实验并运行 12 个 Trial…");
    try {
      const manifest = await fetch("/m1-manifest.json").then((response) => response.json());
      const now = new Date();
      manifest.name = `Console smoke · ${now.toLocaleString("zh-CN")}`;
      const idempotencyKey = `console-${now.toISOString()}`;
      const created = await fetch(`${apiBase()}/api/experiments`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ manifest }),
      }).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "创建实验失败");
        return body;
      });
      const run = await fetch(`${apiBase()}/api/experiments/${created.experiment.id}/run`, { method: "POST" }).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "执行实验失败");
        return body;
      });
      setToast(`实验完成：${run.summary.completed_trials}/12 Trial，平均分 ${run.summary.average_score.toFixed(1)}。`);
    } catch (error) {
      setToast(`本地 API 未就绪：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setRunning(false);
    }
  }

  const passed = data.status === "PASSED";
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">E/O</span><span>OpsMind EvalOS</span><span className="brand-sub">Agentic evaluation control plane</span></div>
        <div className="top-actions">
          <span className="neutral-pill">M1 · Trusted Kernel</span>
          <span className={`status-pill ${passed ? "" : "failed"}`}>{data.gate} {data.status}</span>
          <button className="primary-button" onClick={createAndRun} disabled={running}>{running ? "运行中…" : "新建实验"}</button>
        </div>
      </header>

      <section className="hero">
        <div>
          <div className="eyebrow">M1 acceptance / evidence first</div>
          <h1>可信评测，从一条可复现 Trial 开始。</h1>
          <p className="hero-copy">模型动态提出假设、选择 MCP 工具并根据环境反馈继续推理；确定性内核控制盲化、预算、隔离、评分和不可变账本。没有写死的节点，也没有预设的工具顺序。</p>
        </div>
        <aside className="hero-note"><strong>验收执行边界</strong>生产适配器：Claude Agent SDK + DeepSeek V4 Flash。当前 G1 证据由同接口的确定性 Replay Brain 生成，不冒充外部模型调用。</aside>
      </section>

      <section className="metric-grid" aria-label="G1 关键指标">
        <Metric label="Trial 完成" value={`${data.summary.trials}/${data.summary.total_trials}`} foot="原始冒烟执行" />
        <Metric label="重放覆盖" value={`${(data.summary.replay_rate * 100).toFixed(1)}%`} foot="门槛 ≥ 10%" />
        <Metric label="平均代码评分" value={data.summary.average_score.toFixed(1)} foot="确定性 Grader" />
        <Metric label="Trace 首事件" value={`${data.summary.first_event_ms} ms`} foot="门槛 ≤ 2,000 ms" />
        <Metric label="Ledger" value={data.summary.ledger_valid ? "VALID" : "PENDING"} foot="SHA-256 hash chain" />
      </section>

      <section className="loop-strip" aria-label="自主 Agent 循环">
        <span className="loop-label">adaptive agent loop</span>
        <span className="loop-node">目标与可见证据</span><span className="loop-arrow">→</span>
        <span className="loop-node">DeepSeek 动态决策</span><span className="loop-arrow">→</span>
        <span className="loop-node">Policy / Budget</span><span className="loop-arrow">→</span>
        <span className="loop-node">MCP 工具</span><span className="loop-arrow">→</span>
        <span className="loop-node">环境反馈</span><span className="loop-arrow">↺</span>
        <span className="loop-node">Outcome / Grade / Ledger</span>
      </section>

      <section className="workspace">
        <div className="panel">
          <div className="panel-head">
            <div><div className="panel-title">Experiment workspace</div><div className="panel-sub">冻结配置、随机 A/B 与 Trial 状态</div></div>
            <div className="tabs" aria-label="实验视图">
              <button className={`tab ${activeTab === "trials" ? "active" : ""}`} onClick={() => setActiveTab("trials")} aria-pressed={activeTab === "trials"}>Trials</button>
              <button className={`tab ${activeTab === "manifest" ? "active" : ""}`} onClick={() => setActiveTab("manifest")} aria-pressed={activeTab === "manifest"}>Manifest</button>
              <button className={`tab ${activeTab === "ledger" ? "active" : ""}`} onClick={() => setActiveTab("ledger")} aria-pressed={activeTab === "ledger"}>Ledger</button>
            </div>
          </div>
          <div className="experiment-band">
            <div>
              <div className="experiment-name">{data.experiment?.name ?? "正在载入验收实验…"}</div>
              <div className="experiment-meta">{data.experiment ? `${data.experiment.id} · ${data.experiment.model} · ${data.experiment.manifest_hash.slice(0, 20)}…` : "等待 acceptance snapshot"}</div>
            </div>
            <span className={`status-pill ${passed ? "" : "failed"}`}>{data.experiment?.status ?? data.status}</span>
          </div>
          {activeTab === "trials" && <div className="table-wrap">
            <table>
              <thead><tr><th>Case</th><th>Blind ID</th><th>Seed</th><th>Status</th><th>Score</th><th>Tools</th></tr></thead>
              <tbody>
                {data.trials.map((trial) => (
                  <tr key={trial.id} className={selectedTrial === trial.id ? "selected" : ""}>
                    <td><span className="case-id">{trial.case_id}</span><div className="mono">{trial.id.slice(0, 18)}</div></td>
                    <td className="mono"><button className="row-button" onClick={() => setSelectedTrial(trial.id)} aria-label={`查看 ${trial.case_id} ${trial.blind_id} seed ${trial.seed} Trace`}>{trial.blind_id}</button></td><td>{trial.seed}</td><td className="mini-status">{trial.status}</td><td className="score">{trial.score}</td><td>{trial.tool_calls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
          {activeTab === "manifest" && <div className="detail-sheet"><div className="detail-label">Frozen manifest</div><h2>{data.experiment?.name ?? "M1 smoke manifest"}</h2><p>Model: <code>deepseek-v4-flash</code> · Interface: <code>anthropic</code> · Seeds: <code>101 / 202 / 303</code></p><p>Manifest hash: <code>{data.experiment?.manifest_hash ?? "pending"}</code></p><p>Allowed tools: get_alerts, query_metrics, query_logs, run_probe. Heartbeat: 5,000 ms.</p></div>}
          {activeTab === "ledger" && <div className="detail-sheet"><div className="detail-label">Evaluation ledger</div><h2>{data.summary.ledger_valid ? "Hash chain valid" : "Verification pending"}</h2><p>每个 Trial 完成后写入 Manifest、Dataset、Model、Seed、Blind ID、Trace、Artifact 与 Grader 哈希；数据库触发器拒绝 UPDATE 和 DELETE。</p><p>G1 状态：<code>{data.status}</code> · 重放率：<code>{(data.summary.replay_rate * 100).toFixed(1)}%</code></p></div>}
          <div className="check-grid">
            {data.checks.map((item) => <div className="check-item" key={item.id}><span className={`check-dot ${item.passed ? "" : "fail"}`} />{item.id}</div>)}
          </div>
        </div>

        <aside className="panel">
          <div className="panel-head">
            <div><div className="panel-title">Trace timeline</div><div className="panel-sub">{selected ? `${selected.case_id} · ${selected.blind_id} · seed ${selected.seed}` : "选择 Trial 查看"}</div></div>
            <span className="neutral-pill">SSE cursor</span>
          </div>
          <div className="trace-list">
            {trace.length ? trace.map((event) => (
              <article className="trace-event" key={`${event.seq}-${event.kind}`}>
                <div className="trace-seq">{String(event.seq).padStart(2, "0")}</div>
                <div><div className="trace-kind">{event.kind}<span className="actor">{event.actor}</span>{event.redacted && <span className="redacted">REDACTED</span>}</div><div className="trace-summary">{String(event.summary)}</div></div>
              </article>
            )) : <div className="empty">暂无 Trace。选择一条已完成的 Trial。</div>}
          </div>
        </aside>
      </section>
      {toast && <div className="toast" role="status">{toast}<button className="toast-close" onClick={() => setToast(null)} aria-label="关闭提示">×</button></div>}
    </main>
  );
}

function Metric({ label, value, foot }: { label: string; value: string; foot: string }) {
  return <article className="metric-card"><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-foot">{foot}</div></article>;
}
