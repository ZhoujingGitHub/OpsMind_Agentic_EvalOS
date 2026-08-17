type ToolRow = {
  family: string;
  tools: readonly string[];
  purpose: string;
};

const agentMcp: readonly ToolRow[] = [
  { family: "发现", tools: ["discover_entities", "get_entity", "expand_topology", "get_service_path", "list_data_capabilities"], purpose: "先确认当前租户拥有什么、拓扑怎样、能查到哪些数据，避免假设固定网络。" },
  { family: "通用观测", tools: ["query_metrics", "query_logs", "query_alarms", "query_events", "query_changes"], purpose: "指标、日志、告警、事件和变更是跨专业域的稳定证据入口。" },
  { family: "5G 专项", tools: ["query_terminal_state", "query_pdu_sessions", "query_5gc_nf_state", "query_slice_qos"], purpose: "把终端、PDU 会话、5GC 网元、切片与 QoS 的专业语义保留下来。" },
  { family: "主动探测", tools: ["run_probe", "get_probe_result", "collect_diagnostics"], purpose: "允许 Agent 主动制造新证据，但探测是异步、耗资源、受预算和并发控制的。" },
  { family: "安全动作", tools: ["propose_action", "precheck_action", "execute_approved_action", "verify_action", "rollback_action"], purpose: "把提案、预检、审批后执行、验证和回滚分开，Agent 不能自己批准高风险动作。" },
  { family: "协作交付", tools: ["create_or_update_work_order", "freeze_report", "export_report", "notify_channel"], purpose: "工单、正式报告和外部通知都需要脱敏、版本和审批，不能只是聊天文本。" },
  { family: "记忆改进", tools: ["search_investigations", "get_action_outcomes", "record_feedback", "write_improvement"], purpose: "历史只提供线索和效果，不把旧答案变成固定工具顺序。" },
];

const agentSkills: readonly ToolRow[] = [
  { family: "通用调查", tools: ["open-world-investigation", "evidence-hypothesis-reasoning"], purpose: "拆目标、维护多个可证伪假设、主动找反证，并在证据不足时安全停止。" },
  { family: "5G 架构", tools: ["5g-architecture-interfaces", "deployment-profile-public-private"], purpose: "理解控制面/用户面、接口、PLMN、PNI-NPN、SNPN 和不同部署模式。" },
  { family: "专业域", tools: ["terminal-cpe", "ran-radio", "transport-ip", "5gc-control-user-plane", "slicing-pdu-qos", "mec-app-business"], purpose: "覆盖终端、无线、承载、核心网、切片和应用的指标、因果机制与常见误判。" },
  { family: "主动运维", tools: ["active-probing", "proactive-inspection", "trend-capacity-risk"], purpose: "指导怎样设计探测、动态巡检以及解释阈值前的趋势与容量风险。" },
  { family: "闭环交付", tools: ["remediation-safety", "report-workorder", "historical-prevention", "observability-gap"], purpose: "安全提动作、交付报告、复盘历史，并识别监控盲区而不是硬编答案。" },
];

const langGraphNodes = [
  ["01", "ingest_candidate", "接收任务并核对租户与 Scope"],
  ["02", "admission_governance", "准入治理；不符合条件直接收口"],
  ["03", "hydrate_context", "装载上下文与 Knowledge Pack"],
  ["04", "initialize_plan", "模型初始化假设与证据缺口"],
  ["05", "reason_and_select_tools", "模型选择下一批只读工具"],
  ["06", "execute_read_tools", "MCP Gateway 并行执行查询"],
  ["07", "normalize_evidence", "把返回值变成标准 Evidence"],
  ["08", "revise_hypotheses", "模型根据新证据修订假设"],
  ["09", "quality_gate", "继续、结束、证据不足或提动作"],
  ["10", "action_proposal", "模型生成结构化动作提案"],
  ["11", "policy_precheck", "确定性策略预检"],
  ["12", "human_interrupt", "需要时暂停并等待人工审批"],
  ["13", "execute_verify_rollback", "执行、验证，失败则回滚"],
  ["14", "finalize_and_learn", "形成结论、不确定性与学习记录"],
] as const;

const langGraphMcp: readonly ToolRow[] = [
  { family: "只读观测", tools: ["query_logs", "query_alarms", "query_events", "query_changes", "query_terminal_state", "query_pdu_sessions"], purpose: "首版只开放六个稳定查询能力；Gateway 对每次调用强制租户、Scope、权限和只读效果。" },
];

const evalLeadMcp: readonly ToolRow[] = [
  { family: "Lead Agent 只读 MCP", tools: ["list_experiments", "get_experiment", "get_trial_trace", "get_measurement_health", "get_optional_expert_reviews"], purpose: "读取实验、匿名 Trial、完整轨迹、测量健康和可选专家复核；只能分析和建议，不能改分或发布。" },
];

const investigatorMcp: readonly ToolRow[] = [
  { family: "Trial 与轨迹", tools: ["get_trial_bundle", "get_trace_index", "get_trace", "get_grader"], purpose: "先看任务、终态和官方逐维评分，再从轨迹索引下钻到关键原始 Span。" },
  { family: "冻结源码", tools: ["list_source_files", "search_source", "read_source_file"], purpose: "只分析与 Trial 绑定、带哈希的源码快照，不拿正在变化的工作区猜测。" },
  { family: "对照与研究", tools: ["list_related_trials", "search_methodology", "fetch_methodology"], purpose: "区分单例与重复模式；只用公开概念检索权威资料，网页内容按不可信数据处理。" },
  { family: "结果合同", tools: ["submit_report"], purpose: "把诊断、证据、评分解释和可验证优化方案一次性冻结；报告没有改分权。" },
];

const evalSkills: readonly ToolRow[] = [
  { family: "调查方法", tools: ["evidence-driven-rca"], purpose: "围绕证据缺口选择下一步，分开事实、推断、反证和未知项。" },
  { family: "协议孪生", tools: ["protocol-twin-investigation"], purpose: "理解 NAS、NGAP、SCTP、PFCP、GTP-U、进程和会话之间的因果关系。" },
  { family: "异常恢复", tools: ["tool-failure-recovery"], purpose: "把超时、空结果、429 和权限拒绝当成观察，选择有界重试、换源或停止。" },
  { family: "安全边界", tools: ["safe-operations"], purpose: "处理租户、写操作、审批、提示注入、外部内容与信息不足时的安全停止。" },
  { family: "Case 复盘", tools: ["eval-case-investigation"], purpose: "在实验关闭后结合轨迹、评分、冻结源码和权威方法论定位可验证改进。" },
];

const twinObserve: readonly ToolRow[] = [
  { family: "8 类观测 MCP", tools: ["get_network_health", "query_core_logs", "query_sessions", "query_processes", "capture_protocol_summary", "probe_user_plane", "query_subscriber", "query_metrics"], purpose: "覆盖健康、日志、会话、进程、PCAP 协议摘要、用户面连通性、订阅数据和指标趋势。" },
];

const twinActions: readonly ToolRow[] = [
  { family: "9 类参数化变更 MCP", tools: ["manage_subscriber_profile", "manage_ran_configuration", "manage_service_state", "manage_network_policy", "manage_route_state", "manage_traffic_control", "restart_component", "manage_alert_state", "manage_capture_policy"], purpose: "提供通用受控能力，而不是按 Case 暗示正确答案；参数、范围、预算和风险由 Harness 校验。" },
];

const roadmap = [
  { phase: "M2.6", status: "当前已完成", title: "评测操作与可理解性工作台", body: "实验/Case/Trial 可下钻；机器日志中英翻译；新建评测；单个或批量重新评测；逐 Case 新旧结果比较；源码、评分细节和 AI 调查入口。", current: true },
  { phase: "M3", status: "下一步 · 未完成", title: "正式 80 Case 独立盲测", body: "80 Case × 2 架构 × 3 seeds = 480 Trial；冻结隐藏集、安全集和回归集；输出置信区间、场景热图、成本、时延与稳定性，以及两种架构的适用边界。" },
  { phase: "M4", status: "计划中 · 未完成", title: "Agentic 改进闭环", body: "Case Mining、失败聚类、关键步骤诊断和 Lucky Pass 检测；Agent 只提 Change Proposal，在隔离分支修改；固定回归集与隐藏集复测；人工审批后才能合并和发布。" },
  { phase: "M5", status: "计划中 · 未完成", title: "证据交付与面试故事包", body: "交付架构演进图、公平评测方法、核心指标表、3 个代表 Case 的 Trial 对比，以及 1 个长尾问题从发现到回归的完整闭环；同时列出限制、失败案例和 ADR。" },
];

function Pills({ values }: { values: readonly string[] }) {
  return <div className="code-pills">{values.map((value) => <code key={value}>{value}</code>)}</div>;
}

function CapabilityTable({ title, subtitle, rows }: { title: string; subtitle: string; rows: readonly ToolRow[] }) {
  return (
    <div className="table-block">
      <div className="table-title"><h3>{title}</h3><p>{subtitle}</p></div>
      <div className="table-scroll"><table className="capability-table"><thead><tr><th>能力族</th><th>完整清单</th><th>为什么这样拆</th></tr></thead><tbody>
        {rows.map((row) => <tr key={row.family}><td><strong>{row.family}</strong></td><td><Pills values={row.tools} /></td><td>{row.purpose}</td></tr>)}
      </tbody></table></div>
    </div>
  );
}

function SectionTitle({ index, title, subtitle, badge }: { index: string; title: string; subtitle: string; badge: string }) {
  return <div className="section-title"><div><span>{index}</span><b>{badge}</b></div><h2>{title}</h2><p>{subtitle}</p></div>;
}

function ReasonGrid({ items }: { items: readonly (readonly [string, string])[] }) {
  return <div className="reason-grid">{items.map(([title, body], index) => <article key={title}><span>0{index + 1}</span><h4>{title}</h4><p>{body}</p></article>)}</div>;
}

function ProductLayers({ rows }: { rows: readonly (readonly [string, string, string])[] }) {
  return <div className="layer-diagram">{rows.map(([layer, title, body], index) => <div className="layer-row" key={layer}><span>{layer}</span><div><strong>{title}</strong><p>{body}</p></div>{index < rows.length - 1 && <i>↓</i>}</div>)}</div>;
}

export default function StoryClient() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top"><span className="brand-mark">OM</span><span><strong>OpsMind 架构图谱</strong><small>ARCHITECTURE ATLAS</small></span></a>
        <nav aria-label="四个产品导航">
          <a href="#map">总图</a><a href="#agent-harness">Agent+Harness</a><a href="#langgraph">LangGraph</a><a href="#evalos">EvalOS</a><a href="#twin">Twin</a><a href="#roadmap">路线图</a>
        </nav>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">OPS MIND · ARCHITECTURE ATLAS</p>
          <h1>四个产品，<br/>用架构图一次讲清。</h1>
          <p>两套 OpsMind 是考生，Open5GS/UERANSIM 是协议考场，Agentic EvalOS 是考官系统。页面只保留架构、完整能力清单和设计理由。</p>
        </div>
        <div className="hero-index">
          <a href="#agent-harness"><span>A</span><strong>Agent+Harness OpsMind</strong><small>开放世界考生</small></a>
          <a href="#langgraph"><span>B</span><strong>LangGraph OpsMind</strong><small>状态图考生</small></a>
          <a href="#evalos"><span>OS</span><strong>Agentic EvalOS</strong><small>考官与测量系统</small></a>
          <a href="#twin"><span>LAB</span><strong>Open5GS / UERANSIM</strong><small>数字孪生考场</small></a>
        </div>
      </section>

      <section className="section map-section" id="map">
        <SectionTitle index="00" badge="FOUR-PART MAP" title="四方协作总图" subtitle="先把职责边界讲清，再分别下钻四个产品。" />
        <div className="ecosystem-diagram" aria-label="OpsMind 四方协作架构图">
          <div className="eco-top eco-eval"><small>考官系统</small><strong>OpsMind Agentic EvalOS</strong><span>冻结题目 / 种子 / 预算 / 盲态 / 评分器</span></div>
          <div className="eco-arrow vertical">↓ 同题、同模型、同预算、同安全边界</div>
          <div className="eco-candidates">
            <div className="eco-card candidate-a"><small>考生 A</small><strong>Agent + Harness OpsMind</strong><span>模型驱动开放调查</span></div>
            <div className="versus">A / B</div>
            <div className="eco-card candidate-b"><small>考生 B</small><strong>LangGraph OpsMind</strong><span>14 节点通用状态图</span></div>
          </div>
          <div className="eco-arrow vertical">↓ 通过统一 Adapter / MCP 进入同一考场</div>
          <div className="eco-twin"><small>协议考场</small><strong>Open5GS + UERANSIM + MongoDB</strong><span>注障 → 观测 → 参数化变更 → 独立验真 → 确定性复位</span></div>
          <div className="eco-arrow vertical return">↑ 真实终态、PCAP、Evidence、Trace、Reset Hash</div>
          <div className="eco-bottom"><div><strong>Code Grader</strong><span>确定性官方得分</span></div><div><strong>3 路 Judge</strong><span>只做辅助判读</span></div><div><strong>AI 调查员</strong><span>解释失败，不改分</span></div><div><strong>Ledger</strong><span>不可变证据封存</span></div></div>
        </div>
        <div className="summary-table table-scroll"><table><thead><tr><th>产品</th><th>在体系中的角色</th><th>核心智能方式</th><th>关键能力规模</th><th>不能做什么</th></tr></thead><tbody>
          <tr><td>Agent+Harness OpsMind</td><td>考生 A</td><td>Claude Agent SDK 模型循环</td><td>30+1 MCP / 17 Skills</td><td>不能修改考题、预算和评分器</td></tr>
          <tr><td>LangGraph OpsMind</td><td>考生 B</td><td>14 节点 StateGraph + 节点内模型判断</td><td>6 只读 MCP / 1 Knowledge Pack</td><td>不能进入 EvalOS 核心当编排器</td></tr>
          <tr><td>Agentic EvalOS</td><td>考官与测量系统</td><td>确定性内核 + Claude Agent SDK 分析 Agent</td><td>Lead 5 MCP / Investigator 11 MCP / 5 Skills</td><td>AI Agent 不能改官方分数或发布</td></tr>
          <tr><td>Open5GS/UERANSIM Twin</td><td>数字孪生考场</td><td>无 AI；真实协议状态 + 确定性控制器</td><td>8 观测 / 9 变更 / 6 控制操作</td><td>不决定诊断路径，不伪装成生产网</td></tr>
        </tbody></table></div>
      </section>

      <section className="section product-section agent-section" id="agent-harness">
        <SectionTitle index="01" badge="CANDIDATE A" title="Agent+Harness OpsMind" subtitle="一个主 Agent 自主调查；Harness 固定安全与运行边界，不替 Agent 写死排障路径。" />
        <div className="diagram-pair">
          <div className="diagram-card"><div className="diagram-caption"><span>产品总体架构</span><h3>从用户目标到网络闭环</h3></div>
            <ProductLayers rows={[
              ["产品层", "运维工作台 / Investigation API", "用户输入目标，查看实时进展、证据、结论、动作审批和报告。"],
              ["服务层", "Agent Service + Investigation Repository", "组装租户 Scope、历史上下文与会话；持久化调查、Evidence、Action 和报告。"],
              ["智能层", "Claude Agent SDK + DeepSeek V4 Flash", "单主 Agent 维护完整上下文，自主选择工具、Skill、假设与停止时机。"],
              ["能力层", "Native Tools + 30 MCP + 17 Skills", "原生读写/代码/Bash/Web 能力与 5G 业务工具并存；Skill 按需加载。"],
              ["执行与数据层", "可观测数据 / 网络动作 / MySQL / Redis / OSS", "读日志指标和拓扑，动作走提案—预检—审批—执行—验证—回滚。"],
            ]} />
          </div>
          <div className="diagram-card dark-card"><div className="diagram-caption"><span>AI 架构</span><h3>Agent 负责探索，Harness 负责边界</h3></div>
            <div className="harness-diagram">
              <div className="harness-title"><strong>HARNESS</strong><span>Session · Context · Sandbox · Scope · Budget · Audit</span></div>
              <div className="hook-row"><div><small>PreToolUse Hook</small><b>动作前安检</b><span>放行 / 拒绝 / 改写到隔离环境</span></div><div><small>PostToolUse Hook</small><b>动作后留证</b><span>结果、耗时、Evidence、Trace</span></div><div><small>Failure Hook</small><b>失败也留现场</b><span>Agent 决定重试、换路或停止</span></div></div>
              <div className="agent-core"><span>CLAUDE AGENT SDK</span><strong>感知 → 假设 → 选工具 → 观察 → 修订 → 停止</strong><small>DeepSeek V4 Flash · 不存在固定故障流程</small></div>
              <div className="agent-ports"><div><b>原生能力</b><span>Read / Write / Edit / Bash / Web</span></div><div><b>MCP</b><span>受控的业务眼睛和手</span></div><div><b>Skill</b><span>按需加载的专业方法卡</span></div></div>
            </div>
          </div>
        </div>
        <CapabilityTable title="30 个业务 MCP + 1 个进度协议" subtitle="工具按稳定能力族拆分，而不是“一种故障一个工具”。另有 publish_investigation_progress 只负责实时进度，不属于业务诊断工具。" rows={agentMcp} />
        <CapabilityTable title="17 个 Skills，五层知识结构" subtitle="Skill 教方法和领域知识，不授予权限、不固定调用顺序。" rows={agentSkills} />
        <ReasonGrid items={[
          ["为什么是单主 Agent", "跨终端、无线、承载、核心网和应用的证据高度耦合；一个上下文更容易保持完整因果链，避免多 Agent 之间丢证据。"],
          ["为什么保留原生工具", "真实问题可能需要读文件、执行诊断代码或查外部资料；只给几个业务按钮会把开放问题重新写成封闭流程。"],
          ["为什么 MCP 与 Skill 分开", "MCP 决定能看什么、能做什么；Skill 只教怎样判断。能力授权和知识方法不能混为一体。"],
          ["为什么需要 Harness 与 Hook", "模型可以自由探索，但租户、预算、审批、隔离和审计必须由确定性机制强制，不能交给模型自觉。"],
        ]} />
      </section>

      <section className="section product-section langgraph-section" id="langgraph">
        <SectionTitle index="02" badge="CANDIDATE B" title="LangGraph OpsMind" subtitle="流程结构由 StateGraph 管理，模型在通用认知节点内提出假设、选工具和修订结论。" />
        <div className="diagram-pair">
          <div className="diagram-card"><div className="diagram-caption"><span>产品总体架构</span><h3>可恢复的工程化调查服务</h3></div>
            <ProductLayers rows={[
              ["产品层", "Web / FastAPI / SSE", "提交调查、查看进度、恢复审批中断并读取结果。"],
              ["编排层", "LangGraph StateGraph", "14 个通用节点、条件分支、Checkpoint、Interrupt/Resume 和线程锁。"],
              ["智能层", "Main Investigation Agent + DeepSeek V4 Flash", "在初始化、推理、修订和动作提案节点内做模型判断。"],
              ["能力层", "MCP Gateway + 6 只读工具 + Knowledge Pack", "每次工具调用先过不可变 Scope；知识包版本化加载。"],
              ["基础层", "MySQL/PostgreSQL + Redis + OSS", "保存业务状态、Checkpoint、分布式幂等锁和证据对象。"],
            ]} />
          </div>
          <div className="diagram-card dark-card"><div className="diagram-caption"><span>AI 与状态图架构</span><h3>14 个节点的真实分支关系</h3></div>
            <div className="lg-graph" aria-label="LangGraph OpsMind 14 节点状态图">
              <div className="lg-entry"><b>START</b><i>→</i><span>01 接收候选</span><i>→</i><span>02 准入治理</span><em>拒绝 → 14 收口</em></div>
              <div className="lg-main"><span>03 装载上下文</span><i>→</i><span>04 初始化计划</span><i>→</i><span>05 推理选工具</span><i>→</i><span>06 执行只读工具</span></div>
              <div className="lg-turn">↓ 工具结果进入证据与假设更新</div>
              <div className="lg-main continuation"><span>07 证据标准化</span><i>→</i><span>08 修订假设</span><i>→</i><strong>09 质量门</strong></div>
              <div className="lg-branches"><div><b>继续调查</b><span>↺ 回到 05 推理选工具</span></div><div><b>结论成立 / 证据不足</b><span>→ 14 收口</span></div><div><b>需要动作</b><span>→ 10 动作提案 → 11 策略预检</span></div></div>
              <div className="lg-action"><span>允许</span><i>→</i><strong>13 执行 / 验证 / 回滚</strong><i>→</i><b>14 收口</b><em>需要审批 → 12 Human Interrupt → 批准后执行；拒绝则收口</em></div>
              <div className="lg-end"><b>14 finalize_and_learn</b><i>→</i><span>END</span></div>
            </div>
          </div>
        </div>
        <div className="node-catalog"><div className="table-title"><h3>14 个 StateGraph 节点全量表</h3><p>固定的是通用治理阶段，不是某个故障的修复步骤。</p></div><div className="node-grid">{langGraphNodes.map(([num, name, explain]) => <article key={name}><span>{num}</span><code>{name}</code><p>{explain}</p></article>)}</div></div>
        <CapabilityTable title="6 个 MCP，全量展示" subtitle="当前 LangGraph 版工具面比 Agent+Harness 版小，属于真实能力边界，不做包装。" rows={langGraphMcp} />
        <CapabilityTable title="Knowledge Pack，而不是 Claude Skill" subtitle="LangGraph 版当前没有 Claude Agent SDK Skill；等价的专业指导采用可版本化 Knowledge Pack。" rows={[{ family: "当前 1 个知识包", tools: ["general-investigation@1.0.0"], purpose: "要求多假设、证据引用、时间与拓扑关联、区分事实/推断/未知；证据不足时返回 insufficient-evidence。" }]} />
        <ReasonGrid items={[
          ["为什么用 14 个通用节点", "把准入、证据标准化、质量门、审批、验证和恢复做成可测试的工程骨架，同时让模型在认知节点内保持选择空间。"],
          ["为什么要 Checkpoint", "长任务、服务重启和人工等待都不应丢失当前状态；线程可从最后一个持久化点继续。"],
          ["为什么要 Interrupt", "高风险动作需要暂停并等待外部审批；审批是独立权力，不能由模型自己模拟。"],
          ["它的主要取舍", "流程更清晰、恢复和审计更直接，但新增完全不同的问题类型时，更容易受到既有状态结构和节点边界约束。"],
        ]} />
      </section>

      <section className="section product-section evalos-section" id="evalos">
        <SectionTitle index="03" badge="EVALUATION OS" title="OpsMind Agentic EvalOS" subtitle="确定性系统负责公平和官方判分；Agentic AI 负责读证据、解释失败和提出下一轮实验。" />
        <div className="diagram-pair">
          <div className="diagram-card"><div className="diagram-caption"><span>产品总体架构</span><h3>从评测合同到不可变证据</h3></div>
            <div className="eval-flow">
              <div><small>01 冻结</small><strong>Suite / Dataset / Case / Manifest 3.0</strong><span>版本、种子、重复数、预算、盲态和评分规则</span></div><i>↓</i>
              <div><small>02 运行</small><strong>Dataset Loader + Runner + Candidate Adapters</strong><span>独立 Trial 命名空间；两位考生进入相同环境合同</span></div><i>↓</i>
              <div><small>03 留证</small><strong>Append-only Trace + Artifacts + Source Snapshot</strong><span>外显决策、工具、环境、预算和源码哈希；不保存隐式思维链</span></div><i>↓</i>
              <div><small>04 验真与判卷</small><strong>Twin Final State + Deterministic Code Grader</strong><span>工具名和固定顺序不计分；安全与终态是硬门禁</span></div><i>↓</i>
              <div><small>05 封存与分析</small><strong>Ledger + Console + AI Investigation</strong><span>官方分数不可被 Judge、专家或 AI 调查员覆盖</span></div>
            </div>
          </div>
          <div className="diagram-card dark-card"><div className="diagram-caption"><span>AI 架构</span><h3>分析 Agent 与确定性内核分权</h3></div>
            <div className="eval-ai">
              <div className="kernel-box"><small>TRUSTED KERNEL</small><strong>确定性内核</strong><span>种子 · 预算 · 隔离 · 安全 · 盲态 · Grader · Ledger</span></div>
              <div className="split-arrow">只读证据 ↓ / ↑ 建议与注意信号</div>
              <div className="ai-roster">
                <article><small>组织分析</small><strong>1 个 Lead Agent</strong><span>按需委派 3 个 Specialist：失败诊断、元评测审计、证据报告</span></article>
                <article><small>单 Case 深挖</small><strong>1 个 Case Investigator</strong><span>轨迹 + 评分 + 冻结源码 + 受控网络研究；只提交诊断报告</span></article>
                <article><small>辅助判读</small><strong>3 个独立 Judge</strong><span>Outcome / Evidence / Trajectory；无工具、相互不可见、只作 advisory</span></article>
              </div>
              <div className="agent-sdk-band"><b>Claude Agent SDK + DeepSeek V4 Flash</b><span>Lead 与 Investigator 均为模型驱动工具循环；不存在 LangGraph 或静态评测工作流</span></div>
            </div>
          </div>
        </div>
        <CapabilityTable title="Lead Agent：5 个只读 MCP" subtitle="它可以组织分析与委派专职 Agent，但公平条件和官方评分永远留在内核。" rows={evalLeadMcp} />
        <CapabilityTable title="Case AI 调查员：11 个 MCP" subtitle="同时保留 Read、Glob、Grep、Bash、Skill、ToolSearch 六类原生能力；Write/Edit 被禁用，冻结源码只读。" rows={investigatorMcp} />
        <CapabilityTable title="EvalOS 插件：5 个 Skills" subtitle="支撑协议孪生调查、证据方法、安全停止、工具恢复和评测 Case 深度复盘。" rows={evalSkills} />
        <ReasonGrid items={[
          ["为什么 AI 不能做官方评分", "同一个模型既分析又改分会形成自证循环。官方分数只能由可复算的 Code Grader 与独立 Twin 终态产生。"],
          ["为什么还要 AI 调查员", "代码评分能说哪里没过，却未必能解释为什么失败、属于模型还是工具问题、该怎样设计下一轮可验证实验。"],
          ["为什么 Judge 只作辅助", "Outcome、Evidence、Trajectory 三个视角可发现坏题、Lucky Pass 和评分分歧，但模型判断有漂移，不能覆盖确定性成绩。"],
          ["为什么保留 Harness", "题目、种子、预算、隔离、盲态、复位与 Ledger 都必须由参评者之外的考务系统控制，评测才公平。"],
        ]} />
      </section>

      <section className="section product-section twin-section" id="twin">
        <SectionTitle index="04" badge="DIGITAL TWIN LAB" title="Open5GS / UERANSIM 数字孪生实验室" subtitle="它不是另一个 Agent，而是一套会真实跑协议、能注障、能验真、能清场的受控考场。" />
        <div className="diagram-pair">
          <div className="diagram-card"><div className="diagram-caption"><span>产品总体架构</span><h3>5G 协议执行面</h3></div>
            <div className="twin-stack">
              <div className="twin-control"><small>EvalOS 控制面</small><strong>受限 SSH + 强制命令</strong><span>严格主机指纹、独立密钥、无任意 Shell</span></div>
              <div className="stack-arrow">↓ health / prepare / observe / act / snapshot / reset</div>
              <div className="controller"><small>确定性考场控制器</small><strong>opsmind-twinctl</strong><span>20 个版本化场景 · Trial 隔离 · 参数合同 · 证据缓存 · 干净复位</span></div>
              <div className="twin-components"><article><b>Open5GS 2.8.0</b><span>AMF / SMF / UPF / NRF / AUSF / UDM / UDR / PCF / NSSF / BSF</span></article><article><b>UERANSIM 3.2.7</b><span>1 个 gNB + 1 个 UE；NAS / NGAP / SCTP / GTP-U</span></article><article><b>MongoDB 8.0.29</b><span>订阅用户与 5GC 数据状态</span></article><article><b>Evidence Plane</b><span>日志 / 进程 / 会话 / 探测 / 指标 / PCAP / Reset Hash</span></article></div>
              <div className="baseline"><b>Baseline</b><span>每个 Trial 前准备干净基线，结束后复位并独立验证无残留</span></div>
            </div>
          </div>
          <div className="diagram-card dark-card"><div className="diagram-caption"><span>AI 架构</span><h3>刻意不把 AI 放进 Twin</h3></div>
            <div className="no-ai-diagram">
              <div className="candidate-brains"><span>Agent+Harness</span><b>AI 在考生侧决定怎么查</b><span>LangGraph</span></div>
              <div className="boundary-arrow">↓ 只能调用冻结能力合同</div>
              <div className="reality-box"><small>NO MODEL INSIDE</small><strong>Twin 只返回真实可观测事实</strong><span>不提示根因 · 不选择工具 · 不相信 Agent 自报成功</span></div>
              <div className="boundary-arrow">↓ 独立读取环境终态</div>
              <div className="grader-box"><b>Code Grader</b><span>最终状态正确才算成功；换一条合理路径同样可以通过</span></div>
            </div>
          </div>
        </div>
        <CapabilityTable title="Agent 可见：8 类只读观测 MCP" subtitle="工具返回协议与运行事实，Agent 自己决定调用哪些、先后顺序和何时停止。" rows={twinObserve} />
        <CapabilityTable title="Agent 可见：9 类通用参数化变更 MCP" subtitle="每个 Case 暴露同一类通用工具箱；Case 不携带“正确工具名”，评分器也不按工具名打分。" rows={twinActions} />
        <CapabilityTable title="Harness 专用：6 个控制操作" subtitle="这些不是考生的解题工具。prepare/reset 等考务能力必须与参评 Agent 隔离。" rows={[{ family: "考场控制面", tools: ["health", "prepare", "observe", "act", "snapshot", "reset"], purpose: "检查环境、布题、读取能力、执行受控动作、采集终态、确定性清场；调用方不能提交任意 Shell、路径或服务名。" }]} />
        <CapabilityTable title="Twin 自身 Skills：0 个" subtitle="Twin 是确定性现实来源，不需要 Skill。协议调查 Skill 属于考生或 EvalOS 调查员。" rows={[{ family: "无 Skill", tools: ["0 — deliberately none"], purpose: "如果 Twin 内部再放一个会解释和选择的 AI，考场就可能把答案泄给考生，也会让终态验证失去独立性。" }]} />
        <ReasonGrid items={[
          ["为什么必须是真实协议栈", "静态 JSON 回放只能测回答能力；Open5GS/UERANSIM 能真实产生注册、鉴权、会话、用户面和协议抓包状态。"],
          ["为什么必须可确定性复位", "上一个 Trial 的残留会污染下一个 Trial；清场、复位哈希和基线验证是比较公平的前提。"],
          ["为什么动作要参数化", "允许修复但不允许任意 Shell。通用动作保留探索空间，严格参数合同控制破坏半径。"],
          ["为什么 Twin 不含 AI", "考场只负责制造事实和验证事实；诊断智能属于考生，评价智能属于 EvalOS，三者必须分权。"],
        ]} />
      </section>

      <section className="section roadmap-section" id="roadmap">
        <SectionTitle index="05" badge="CURRENT & NEXT" title="EvalOS 当前到 M2.6，后续还有 M3–M5" subtitle="下面明确区分“已经完成”和“规划能力”，防止把路线图讲成现状。" />
        <div className="roadmap">{roadmap.map((item) => <article key={item.phase} className={item.current ? "current" : "planned"}><div><span>{item.phase}</span><b>{item.status}</b></div><h3>{item.title}</h3><p>{item.body}</p></article>)}</div>
        <div className="roadmap-gate"><strong>当前正确结论</strong><p>M2.6 已证明评测平台可操作、可下钻、可重评、可解释；M2 已证明协议考场和双架构接入资格。<b>现在还不能用 M2 结果宣称哪套 OpsMind 在正式评测中胜出。</b>正式 A/B 统计结论从 M3 的 480 个独立盲测 Trial 开始。</p></div>
      </section>

      <footer><div><span className="brand-mark">OM</span><strong>OpsMind 四系统架构图谱</strong></div><p>事实口径来自当前 PRD、Handoff、M1–M2.6 验收材料与实际代码；研发状态截至 M2.6。</p><a href="#top">回到顶部 ↑</a></footer>
    </main>
  );
}
