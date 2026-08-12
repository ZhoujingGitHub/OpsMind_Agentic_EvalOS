# OpsMind Agentic EvalOS 新项目 Handoff

> 版本：v1.0  
> 日期：2026-08-13  
> 用途：在独立目录、独立 Git 仓库中构建 OpsMind Agentic EvalOS，对 OpsMind LangGraph V1 与 Agent + Harness V2 做公平、可复现、可解释的端到端评测。  
> 当前状态：产品需求、方法论、总体架构和资源方案已经明确；EvalOS 代码尚未开始开发。

---

## 1. 新项目一句话目标

构建一个以 Claude Agent SDK Agent Harness 为核心的“智能评测操作系统”：在没有真实 5G 网元和外部运维系统的条件下，通过版本化数据回放、可控数字孪生、故障注入、盲测、多 Seed Trial、组合 Grader、轨迹诊断和受控改进闭环，公平评估两套 OpsMind 智能运维 Agent 的真实能力，并形成可以追溯到 Case、Trial、Trace、Evidence 和代码版本的结论。

被测产品：

- Contestant A：OpsMind LangGraph V1。
- Contestant B：OpsMind Agent + Harness V2。

评测平台自身：

- 必须采用 Claude Agent SDK Agent Harness。
- 允许由多个专业评测 Agent 协作，但不能用写死工作流代替 Agent 判断。
- 确定性、公平性、安全门禁和不可变审计由可信内核负责，不能交给模型自由决定。

---

## 2. 背景与叙事边界

### 2.1 面试叙事

- V1：使用 LangGraph 状态图架构，实现可控、可持久化、可审计、可人工介入的智能运维调查。
- V2：随着模型和 Agent Harness 成熟，升级为 Claude Agent SDK Agent Harness，实现开放世界假设生成、动态工具选择、按需 Skills 加载和对未知故障的更强泛化。
- EvalOS：用公平 A/B 实验验证 V2 是否在开放世界能力、证据质量、恢复能力、成本和工程复杂度方面真实优于 V1。

### 2.2 工程事实边界

- 实际工程中，Agent Harness 版本先完成，LangGraph 版本后补建。
- 可以按“产品 V1 → V2”讲架构演进，但不得伪造 Git 时间线、上线时间、客户使用事实或生产效果。
- 不得为了证明 V2 更好而故意削弱 LangGraph V1。
- 最终报告必须同时展示 V1 优势、V2 优势、失败样本和适用边界，不能只挑 V2 获胜案例。

---

## 3. 新项目目录与仓库边界

建议新项目目录：

```text
D:\AIPM\黄钊+张和AIPM训练营\5期\从0到1打造一个Agent落地产品\OpsMind-Agentic-EvalOS
```

建议独立 GitHub 仓库：

```text
OpsMind-Agentic-EvalOS
```

两个被测产品只作为外部 Contestant 接入，不直接在 EvalOS 仓库内修改：

```text
Agent + Harness V2
D:\AIPM\黄钊+张和AIPM训练营\5期\从0到1打造一个Agent落地产品\OpsMind

LangGraph V1
D:\AIPM\黄钊+张和AIPM训练营\5期\从0到1打造一个Agent落地产品\OpsMind-LangGraph
```

EvalOS 必须通过版本化镜像、Git Commit、标准 API/事件契约或受控 Runner 调用两套产品，禁止跨仓库隐式引用源代码。

---

## 4. 必读材料

### 4.1 核心 PRD

```text
D:\AIPM\黄钊+张和AIPM训练营\5期\从0到1打造一个Agent落地产品\OpsMind\材料\OpsMind_Agentic_EvalOS评测体系_PRD与技术架构_v1.0.docx
```

它是新项目的核心产品与技术依据，包含：

- EvalOS 产品定位。
- 教师方法与产业最佳实践的融合。
- Agentic EvalOS 总体架构。
- 多 Agent 角色、MCP 工具、Skills、数据模型和 API。
- 数字孪生、Case、Trial、Grader、失败分析和发布门禁。
- 阿里云部署建议、实施路线和验收标准。

### 4.2 教师评测方法原始材料

```text
D:\AIPM\黄钊+张和AIPM训练营\4.5期\week10-评测.doc
```

核心方法：

```text
构建数据集
  → 批量运行
  → 量化打分
  → 逐条分析失败与低质量案例
  → 针对性优化
  → 回归验证
```

教师方法强调：

- 评测不是只看一个总分，而是批量运行后逐条分析 Case。
- 数据集、测试环境、Grader 和人工校准缺一不可。
- 0～30 分先解决基础可用；30～80 分扩大覆盖；80～95 分重点治理长尾。
- AI 可以协助分析日志、失败聚类和改进建议，但 Ground Truth、关键标签和发布门禁需要人工治理。

### 4.3 两套被测产品资料

```text
OpsMind\材料\OpsMind智能运维Agent开放世界_PRD与技术架构_v2.3.docx
OpsMind\材料\OpsMind_5G智能运维Agent_LangGraph版_PRD与技术架构_v1.0.docx
OpsMind\材料\OpsMind_LangGraph新项目_HANDOFF_v1.0.md
OpsMind\材料\OpsMind_AgentHarness与LangGraph对比评测方案_v1.0.docx
```

---

## 5. 核心评测对象与公平性原则

### 5.1 唯一自变量

正式对比中只允许“Agent 核心架构”不同：

- LangGraph V1：StateGraph、Checkpoint、节点式控制。
- Harness V2：Claude Agent SDK Harness、开放世界推理、动态工具选择。

以下条件必须相同：

- DeepSeek V4 Flash 模型及固定版本。
- Temperature、Thinking 模式和最大上下文。
- MCP 工具集合及工具后端。
- Skills/Knowledge 内容基线；表达机制可因架构不同而不同，但知识事实必须一致。
- 版本化 5G/5GC 数据。
- Case、Seed、时间窗和故障注入。
- Token、调用次数、墙钟时间和并发预算。
- CPU、内存和网络资源级别。
- 安全审批边界和禁止动作。

### 5.2 盲测与多次运行

- 对两个架构使用 `blind_id`，Judge 默认不知道架构名称。
- 同一 Case 至少运行 3 个 Seed。
- 运行顺序随机化，避免冷启动、缓存和机器负载偏差。
- 每次 Trial 使用独立 namespace、缓存、临时状态和证据目录。
- 正式对比必须同时报告均值、中位数、P95、置信区间、失败分布和样本数量。

### 5.3 禁止结论污染

- 两个 Contestant 不得读取 Ground Truth。
- Hidden Holdout 不得暴露给改进 Agent 和产品开发人员。
- Grader 版本必须冻结并记录。
- 改进建议只能在公开回归集验证；最终发布判断必须重新运行隐藏集。

---

## 6. 评测基本单位

- **Suite**：一组有明确目标和版本的评测集合。
- **Case**：一个可复现的 5G 端到端运维问题。
- **Trial**：某个 Contestant 在某个 Case、Seed、预算下的一次完整运行。
- **Trace**：Trial 中的模型消息、工具调用、环境事件、证据和成本轨迹。
- **Outcome**：最终 RCA、证据、不确定性、建议、动作和安全结果。
- **Grader Run**：某个固定版本 Grader 对 Trial 的一次评分。
- **Experiment**：一批冻结配置的 A/B Trial。
- **Failure Cluster**：多个 Trial 的相似关键失败模式。
- **Change Proposal**：基于失败证据形成的受控改进建议。
- **Release Gate**：是否允许接受改进或发布评测结论的确定性门禁。

---

## 7. 数据与仿真分层

EvalOS 不允许把“数据库里造了一些数据”直接描述为真实网元评测。所有数据必须标注来源和仿真等级。

### L0：静态结构数据

- 租户、客户、站点、网络实体、服务路径和资源关系。
- 用于 UI、权限和基础查询，不足以评测动态调查能力。

### L1：版本化观测数据回放

- 告警、日志、指标、事件、变更、终端状态和 PDU 会话。
- 保留统一时钟、因果关系、Ground Truth 和故障窗口。
- 适合第一阶段 12 个黄金 Case Pilot。

### L2：Open5GS/UERANSIM 数字孪生

说人话：在云服务器里搭建一个可以运行的缩小版 5G 网络实验室。

- Open5GS 模拟 AMF、SMF、UPF、UDM、AUSF、PCF、NRF、NSSF 等 5GC 网元。
- UERANSIM 模拟 UE/CPE 和 gNB。
- 可以真正产生注册、鉴权、PDU Session、用户面流量、日志和网元状态。
- 可以注入鉴权失败、DNN 错误、N3/N6 异常、UPF 故障、网元退出和时延升高等故障。

它不能完全复刻真实射频、厂商私有日志和运营商规模，但比写死数据库数据更能验证 Agent 是否真的会调查。

### L3/L4：后续增强

- L3：引入更多真实开源网络组件、容器网络和外部系统仿真器。
- L4：未来接入脱敏真实数据和真实外部系统，只能在获得合法授权后启用。

---

## 8. Case 设计

### 8.1 Pilot

首期建立 12 个黄金 Case，每个 Case 双人审核：

- 终端注册失败。
- 鉴权异常。
- PDU Session 建立失败。
- RAN 接入质量下降。
- N3 丢包。
- N6 丢包或时延升高。
- UPF 资源或进程异常。
- DNS/MEC/WMS 应用时延异常。
- 告警风暴与重复事件。
- 变更后性能退化。
- 数据缺失导致证据不足。
- 工具失败、权限不足或环境不稳定时的恢复。

规模：

```text
12 Case × 2 架构 × 3 Seed = 72 Trial
```

### 8.2 正式集

目标 80 个 Case：

- Public 5G、PNI-NPN、SNPN。
- 终端、RAN、承载、5GC 控制面、5GC 用户面、MEC、应用。
- 单点故障、多点关联、渐进趋势、数据缺失、工具失败和误导证据。
- 明显故障、潜在风险、巡检、历史复盘、修复验证和未知长尾。

正式规模：

```text
80 Case × 2 架构 × 3 Seed = 480 Trial
```

建议将其中 20～30 个关键 Case 升级为 L2 Open5GS/UERANSIM 可运行场景，其余使用经过校准的 L1 数据回放。

---

## 9. 评分体系

建议基础权重：

| 指标 | 权重 | 核心含义 |
|---|---:|---|
| Task Success | 25 | 是否完成调查目标 |
| RCA Quality | 15 | 根因是否正确或合理部分命中 |
| Evidence Quality | 15 | 证据精确率、召回率和可追溯性 |
| Tool Efficiency | 15 | 工具选择、重复调用、无效查询 |
| Recovery | 15 | 工具失败、数据缺失和环境异常时能否恢复 |
| Cost | 5 | Token、调用次数和资源成本 |
| Latency | 5 | 完成时间、P95 延迟 |
| Stability | 5 | 多 Seed 结果波动 |

安全是硬门禁，不用平均分抵消：

- 越权访问。
- 未经审批执行真实写操作。
- 泄露密钥或租户数据。
- 伪造证据或把仿真冒充生产。
- 破坏性动作无法回滚。

出现严重安全事件，该 Trial 直接失败；安全集未 100% 通过，不允许发布改进结论。

---

## 10. “诊断剩余 5% Case”的准确含义

“剩余 5%”不是固定抽取数据集的 5%，也不是要求平台必须先达到 95 分。

它是高成熟度阶段长尾问题的口语化简称，正式名称应使用：

> 长尾未通过与低质量案例诊断

分析范围包括：

- 全部失败 Trial。
- 安全异常。
- RCA 部分命中但证据不足。
- 最终答案正确但中间轨迹存在危险或错误推理的 Lucky Pass。
- 置信度异常。
- 成本、延迟或工具调用显著异常。
- 同一 Case 多 Seed 结果不稳定。
- 模型 Judge 与人工复核产生分歧。
- 评测集、Ground Truth 或 Grader 本身存在问题。

诊断 Agent 必须：

1. 定位关键失败步骤。
2. 区分 Agent、Tool/MCP、Context/Knowledge、Environment、Task/Label、Grader、Policy 和 Randomness 问题。
3. 对相似失败聚类，寻找系统性根因。
4. 形成有证据引用的 Change Proposal。
5. 在隔离分支回归验证。
6. 确保修复长尾时不让原有通过集合退化。

---

## 11. Agentic EvalOS 架构

### 11.1 Agent 组织

建议角色：

- **Lead Eval Orchestrator**：理解评测目标、组织 Agent、汇总证据，不绕过可信内核。
- **Data Observer**：持续观察 Trial、日志、成本和平台异常。
- **Case Miner**：从失败、相似轨迹和盲区生成候选 Case。
- **Dataset Curator**：去重、标注、版本化和质量检查；候选 Case 未经人工审核不得进入正式集。
- **Adversarial Scenario Agent**：生成扰动、数据缺失、工具故障和组合故障。
- **Experiment Runner Agent**：制定实验计划并请求可信 Runner 执行。
- **Outcome Judge Agent**：评分最终任务结果。
- **Evidence Judge Agent**：评分证据完整性、正确性和引用质量。
- **Trajectory Judge Agent**：定位关键失败步骤和 Lucky Pass。
- **Failure Diagnosis Agent**：聚类失败、分析系统性原因。
- **Improvement Architect Agent**：生成 Prompt、Skill、MCP、知识、Harness 或 Graph 的改进建议。
- **Controlled Coding Agent**：只能在隔离分支修改允许范围的代码。
- **Regression Verifier Agent**：执行公开集、回归集、隐藏集和安全集。
- **Report Agent**：生成技术报告、管理摘要和面试证据包。
- **Meta-eval Auditor**：检查 Grader 漂移、分歧、坏题和数据泄漏。

### 11.2 可信内核

以下能力必须是确定性代码，不允许 Agent 自由改写：

- Experiment Manifest 冻结。
- Seed、顺序、预算和并发限制。
- Contestant 盲化。
- Trial 隔离与环境重置。
- Hidden Holdout 访问控制。
- 代码 Grader 和安全策略。
- 不可变评测 Ledger。
- 审批、合并和发布门禁。
- Token、成本、延迟和资源测量。

### 11.3 自治等级

首期采用 L2 受控自治：

- Agent 可以发现失败、聚类、提出建议。
- Agent 可以在隔离分支生成补丁并触发回归。
- Agent 不能自动合并到主分支。
- Agent 不能自动发布产品。
- Agent 不能修改 Hidden Holdout、Ground Truth 或正式 Grader。

---

## 12. MCP 与 Skills 边界

### MCP 工具族

- Dataset：搜索、读取、提议 Case、提交标签复核。
- Scenario：编译场景、启动/停止环境、故障注入、环境重置。
- Experiment：规划、执行、取消 Trial、读取进度。
- Trace：流式轨迹、读取工件、对比 Trial。
- Grading：代码 Grader、模型 Judge、人工复核队列。
- Analysis：失败聚类、相似 Case、关键步骤诊断。
- Change：改进建议、隔离分支补丁、回归运行。
- Release：门禁评估、审批请求、发布决策记录。
- Report：报告与证据包生成。
- Audit：Ledger、哈希、泄漏检查。

### Skills 分层

- 评测方法：case、trial、盲测、统计、rubric、人工校准。
- 5G 领域：端到端拓扑、接口、遥测模式、动作边界和不确定性。
- 失败分析：trajectory analysis、lucky pass、failure taxonomy。
- 数据治理：case authoring、label quality、contamination control。
- 改进安全：change proposal、sandbox change、safety gate。
- 沟通交付：evidence report、interview story、ADR。

原则：MCP 是结构化、可审计的外部能力；Skill 是可版本化的方法、判断标准和领域知识。不能把固定诊断流程写死在 MCP 或普通代码里。

---

## 13. 数据与基础设施隔离

### 13.1 现有阿里云资源

当前已有一台约 `2 vCPU / 8 GB / 40 GB` ECS，已部署 MySQL、Redis 等 OpsMind 数据底座。

建议继续作为：

- MySQL/Redis 权威数据层。
- EvalOS 轻量控制 API。
- Case、Experiment、Trial、Score 和人工复核数据。
- 两套产品共享的公开版本化观测数据。

不建议在该 ECS 上同时运行两套 Contestant、完整数字孪生、多 Agent Judge 和并发 Trial，否则资源争抢会污染评测结果。

### 13.2 建议命名空间

```text
MySQL
├── opsmind_shared
├── opsmind_harness
├── opsmind_langgraph
└── opsmind_eval

Redis
├── harness:*
├── langgraph:*
└── eval:*

OSS
├── harness/
├── langgraph/
└── eval/
```

### 13.3 EvalLab ECS

Pilot 可先不新增 ECS，使用现有服务器串行运行 L1 回放。

需要 L2 数字孪生或正式评测时：

- Pilot：4 vCPU / 16 GB / 100 GB ESSD。
- 正式：8 vCPU / 32 GB / 200 GB ESSD。
- Ubuntu 22.04/24.04。
- 按量付费，公网按流量计费。
- 评测结束后归档证据并释放 EvalLab。

同地域、同 VPC 使用内网连接现有 ECS，禁止 MySQL、Redis 直接暴露公网。

---

## 14. 粗略费用预算

### Pilot

```text
12 Case × 2 架构 × 3 Seed = 72 Trial
```

- 仅用现有 ECS：约 25～80 元。
- 临时增加 4 核 16 GB EvalLab 运行 2～3 天：约 80～175 元。

### 正式评测

```text
80 Case × 2 架构 × 3 Seed = 480 Trial
```

- 8 核 32 GB EvalLab 运行 7～10 天。
- ECS、云盘、流量、DeepSeek、OSS/SLS/快照合计约 420～1,130 元。
- 建议正常预算 700～900 元，账户上限预留约 1,200 元。

说明：按流量计费只针对公网出流量；ECS 计算按运行时长收费，云盘按容量和持有时间收费。大部分模型响应是入网流量，同 VPC 内网流量不收费，因此公网流量通常不是主要成本。

---

## 15. 安全与秘密管理

- 不得将 DeepSeek API Key、阿里云密码、AccessKey、SSH 私钥、数据库密码或 Token 复制进新仓库。
- 仅保存 secret reference、环境变量名称或安全配置路径。
- 新项目不得复制现有 SSH 私钥文件；通过用户级 SSH 目录、凭据管理器、OOS/KMS 或服务器角色安全引用。
- 两套 Contestant 只获得完成 Trial 必需的最小权限。
- Hidden Holdout、Ground Truth、Judge Prompt 和安全门禁使用独立服务账号。
- 所有 Trial 生成不可变 Ledger，记录 commit、镜像 digest、模型版本、工具版本、数据版本、Seed、预算和评分版本。
- 数字孪生必须明确标识为仿真，不得在报告中伪称真实生产网元。

---

## 16. 实施里程碑

### M0：方法和契约冻结

- 新仓库、架构决策记录、数据契约和目录骨架。
- Suite/Case/Experiment/Trial/Trace/Score/Ledger 数据模型。
- Contestant Adapter 契约。
- Blind ID、Seed、预算和安全边界。

### M1：12 Case Pilot

- L1 版本化数据回放。
- 72 次 A/B Trial。
- 代码 Grader、模型 Judge 和人工复核入口。
- Trial 轨迹回放和差异比较。
- 第一版管理报告与技术报告。

### M2：L2 5G 数字孪生

- Open5GS/UERANSIM。
- 故障注入、统一时钟、环境重置和健康检查。
- 20～30 个可运行 5G Case。
- 仿真真实性和因果一致性验证。

### M3：正式 80 Case A/B

- 480 次正式 Trial。
- 隐藏集、安全集、回归集。
- 置信区间、场景热图、成本和稳定性分析。
- V1/V2 适用边界报告。

### M4：Agentic 改进闭环

- Case Mining。
- 失败聚类和关键步骤诊断。
- Lucky Pass 检测。
- Change Proposal。
- 隔离分支修改与回归验证。
- 人工审批和发布门禁。

### M5：证据与面试故事包

- 一页架构演进图。
- 一页公平评测方法。
- 一张核心指标对比表。
- 3 个代表 Case 的 Trial 轨迹对比。
- 1 个长尾问题从发现、定位、修改到回归的闭环。
- 明确限制、失败案例和 ADR。

---

## 17. 核心验收标准

- 可以创建 Suite、Case、Experiment，并选择两个 Contestant。
- 72 次 Pilot 可重复运行，相同配置结果可追溯。
- 两套架构使用相同模型、工具、数据、预算和安全边界。
- 任意分数可以下钻到 Trial、Trace、Evidence、Grader 和环境状态。
- 支持多个 Seed，并展示均值、分布、置信区间和稳定性。
- 失败实验室能够聚类失败、定位关键步骤并识别 Lucky Pass。
- 正式结论必须同时包含质量、安全、成本、延迟和稳定性。
- Hidden Holdout 不可被 Contestant 和改进 Agent读取。
- 严重安全事件为零；仿真数据不冒充生产数据。
- Agent 提议的修改不能自动合并或发布。
- 最终结论能回溯到 Git Commit、镜像 Digest、模型版本、数据版本和 Ledger。

---

## 18. 尚待新项目确认的决策

1. Pilot 是否完全复用现有 ECS，还是立即购买 4 核 16 GB EvalLab。
2. DeepSeek V4 Flash 是否同时用于 Contestant 和普通 Judge；关键 Trial 是否引入 V4 Pro 或人工专家复核。
3. 80 个正式 Case 的具体场景配额和难度分布。
4. 哪 20～30 个 Case 升级为 Open5GS/UERANSIM L2 场景。
5. EvalOS 前端第一阶段采用现有 OpsMind 视觉体系还是独立设计系统。
6. OSS/SLS 是从 M1 启用还是 M3 正式评测前启用。
7. 新项目 GitHub 仓库名、可见性和分支保护策略。

这些决策不应阻塞 M0 架构与契约工作。

---

## 19. 新项目窗口建议首条指令

```text
这是 OpsMind-Agentic-EvalOS 独立项目。请首先完整阅读：

1. OpsMind_Agentic_EvalOS新项目_HANDOFF_v1.0.md
2. OpsMind_Agentic_EvalOS评测体系_PRD与技术架构_v1.0.docx
3. week10-评测.doc
4. OpsMind Agent + Harness V2 与 OpsMind-LangGraph V1 的 PRD、Handoff 和代码契约

只读审查两个被测产品，不在其仓库中进行隐式修改。EvalOS 必须以 Claude Agent SDK Agent Harness 为核心，专业能力封装为 MCP 和 Skills；公平性、安全门禁、Trial 隔离、预算、Grader 和不可变 Ledger 使用确定性可信内核。

先完成 M0：独立项目骨架、核心数据模型、Contestant Adapter、Experiment Manifest、Blind ID、Seed、预算、安全边界和 12 Case Pilot 实施计划。不要直接开始大规模仿真，不要复制任何 API Key、密码或 SSH 私钥。完成设计审查与测试后再进入 M1。
```

---

## 20. 最终原则

EvalOS 的目的不是“证明 Harness 一定获胜”，而是在同等条件下回答：

- 两种架构分别在哪些 Case 上更强？
- 优势来自架构、工具、知识、模型还是数据？
- 失败发生在什么关键步骤？
- 改进是否提升了长尾，同时没有破坏原有通过集合？
- 结论是否可复现、可解释、可审计？

只有能够回答这些问题，评测结果才既能指导产品迭代，也能成为可信的面试证据。
