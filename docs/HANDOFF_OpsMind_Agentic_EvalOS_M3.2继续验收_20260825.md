# OpsMind Agentic EvalOS M3.2 继续验收 Handoff

> 交接时间：2026-08-25 11:35（Asia/Shanghai）
> 交接对象：后续新的 EvalOS Codex 任务
> 当前阶段：两套真实外部考生修复后的非正式 Product E2E 独占验收准备期
> 正式 480 Trial：`NO-GO`，继续锁定
> 本文件优先级：高于早期 `memory.md` 和 `OpsMind_Agentic_EvalOS新项目_HANDOFF_v1.0.md` 中与当前事实冲突的历史描述

## 一、一句话说明现在做到哪里

EvalOS 的考场、真实外部考生接入、证据记录、确定性评分、独立 Twin 复位、长时进展展示和 Chrome 用户路径已经完成 M3.1/M3.2 验收；两套 OpsMind 后续又分别修复了自己的产品问题，目前正在按顺序进行**非计分、非资格、独占 Twin 的 Product E2E 复验**。

当前已经为 **Agent+Harness OpsMind** 准备好一个独占 5G 数字孪生故障现场，但尚未启动 EvalOS 资格 Runner，也不能启动容量 Trial 或正式 480 Trial。

## 二、新任务开始前必须遵守的架构红线

### 2.1 EvalOS 自己的架构

- EvalOS 的智能运行时必须继续使用 **Claude Agent SDK + DeepSeek V4 Flash + MCP + Skill + SDK 原生 Bash/Edit/Write/执行代码能力**。
- 核心是一个开放的、模型驱动的“感知 → 推理 → 调工具 → 看结果 → 继续或停止”循环。
- 不得引入 LangGraph、固定节点图、按 Case 写死的故障流程或固定工具调用顺序。
- Agent 可以自主提出假设、选择工具、调整路径和决定停止时间。
- Agent 不得自行决定 Seed、预算、隔离、安全门禁、盲测身份、Grader 或账本内容；这些由确定性 Harness 管理。
- Eval Intelligence Agent 只读分析失败、解释评分、比较考生，不能修改官方成绩。

### 2.2 两套 OpsMind 是真实外部考生

- Agent+Harness OpsMind 和 LangGraph OpsMind 都必须通过各自真实产品 API、队列、Worker、数据库、MCP/Skill 或 Knowledge Pack 完成任务。
- EvalOS 内部不得再创建“参考版考生”“考生分身”或用测试替身冒充真实产品。
- EvalOS 不调用考生内部工具替考生做题；EvalOS 只负责出题、准备考场、提交任务、收公开轨迹、独立取证、评分和复位。
- 不得修改以下两个代码库：
  - `D:\AIPM\黄钊+张和AIPM训练营\5期\从0到1打造一个Agent落地产品\OpsMind`
  - `D:\AIPM\黄钊+张和AIPM训练营\5期\从0到1打造一个Agent落地产品\OpsMind-LangGraph`
- 如果考生仍有问题，只生成证据和专项交接单，由对应产品任务自行修复并冻结新版本。

### 2.3 公平与证据红线

- 每个 Trial 必须具有独立命名空间、追加式轨迹、预算账、不可变账本记录和确定性 Code Grader 结果。
- Grader 按真实证据、根因、任务终态、授权、验证、回滚、安全和预算评分，不按工具名、LangGraph 节点或固定解题顺序评分。
- 测试替身只允许进入 `ENGINEERING_TEST` 通道，并必须显著标成“模拟”；不得进入真实资格结论。
- 旧 Trial、旧分数和旧证据不得覆盖或删除；复考必须创建新 Experiment 和新 Trial。
- 不得向考生透露隐藏根因、私有因果锚点、安全载荷或 Grader 私有合同。
- 所有秘密只能通过环境变量或项目外安全引用提供，不能写进源码、Handoff、轨迹、快照或 Git。

## 三、三个系统和云资源的当前关系

```text
第二账号：EvalOS ECS 121.40.223.202
├── EvalOS 控制 API、中文控制台、可信 Harness
├── 外部真实考生 Adapter/Relay
├── 追加式轨迹、评分、账本和 AI 只读分析
└── 正式 480 开关保持关闭

主账号：Twin ECS 114.215.189.185 / 10.30.1.135
├── Open5GS + UERANSIM 协议级数字孪生考场
├── 独占 Trial 租约、故障注入、独立快照与确定性复位
├── Agent+Harness 专属最小权限观察/动作/验证身份
└── LangGraph 专属最小权限观察/动作/验证身份

两套真实 OpsMind 产品
├── Agent+Harness：Claude Agent SDK 单 Agent 架构
└── LangGraph：LangGraph Checkpoint/Interrupt/恢复架构
```

两套考生可以有不同内部架构，但接受相同的外部评测合同、相同 Case/Seed/预算和同一把评分尺子。

## 四、2026-08-25 交接时的实时状态

### 4.1 EvalOS 云服务

本次交接只读查询 `https://121.40.223.202/health` 得到：

| 项目 | 当前结果 |
|---|---|
| 服务状态 | `ok` |
| 服务合同 | `evalos.7` |
| 里程碑标识 | `M3.1` |
| 账本 | 有效，`106847` 条记录 |
| 排队/运行请求 | `0 / 0` |
| 排队/运行 Trial | `0 / 0` |
| 未清理考场 | `0` |
| 过期运行租约 | `0` |
| Twin | 已配置 |
| 正式评测 | `enabled=false` |
| 正式开考保护 | `480_TRIAL_NOT_AUTHORIZED` |

最近文档记录的云上不可变发布版本是 `m31-20260824-ceee2d71ef`；本次交接没有通过服务器文件系统再次核对软链接，因此新任务如需发布或回滚，必须先只读验证当前 `/opt/opsmind-evalos/current`，不能只依据本文执行覆盖。

### 4.2 当前 Agent+Harness 独占 Twin

通过最小权限 Twin 管理接口实时核实：

| 项目 | 当前结果 |
|---|---|
| 考生 | `agent-harness-v2` |
| Active Trial | `ah-product-e2e-20260825-1124` |
| 独占租约 | 已存在 |
| 槽位是否可分配给其他人 | 否 |
| 控制器 | `ready` |
| 拓扑 | `ready=true` |
| 路由 | `route_present=true` |
| 运行隔离 | `runtime_isolated=true` |
| 性质 | 非正式 Product E2E，不计分、不启动资格评测 |

这是一个最小公开故障现场。**不能向 Agent+Harness 窗口提供根因、私有 Case 合同或参考解法**。给考生的通知仅应是：

> 环境已准备好。

### 4.3 LangGraph 当前看到的 Twin 状态

- LangGraph 控制器状态为 `ready`。
- 物理 Twin 当前被 `ah-product-e2e-20260825-1124` 占用。
- LangGraph 没有该 Trial 的租约，自己的拓扑未准备；这是正确的独占隔离结果，不是 LangGraph 故障。
- 必须等 Agent+Harness 复验结束、EvalOS 独立复位并证明 `clean=true` 后，才能为 LangGraph 准备下一个独占时段。

### 4.4 SSH 长期身份

本机已经建立 Twin 专用别名 `opsmind-twin`：

- 用户：`evalos-twin`
- 私钥安全引用：`C:\Users\zhoujing\.ssh\opsmind-evalos-twin-ed25519`
- 独立 known_hosts：`C:\Users\zhoujing\.ssh\opsmind-evalos-twin-known_hosts`
- SSH 配置：`C:\Users\zhoujing\.ssh\config`
- 服务器强制进入 `/usr/local/sbin/opsmind-twin-ssh-gateway`；这是受限操作身份，不提供普通 Shell。

这些文件都在项目目录外。**只可引用路径，不得读取、复制、提交或输出私钥内容。**

当前 Wi-Fi 出口可能变化。本机临时 SSH 白名单是动态运维入口，不应成为正式 Runner 的依赖。正式评测应由固定 EvalOS ECS `121.40.223.202/32` 访问 Twin，使操作人员切换 Wi-Fi 不影响 Trial。

## 五、已经完成且必须保留的能力

1. 真实外部考生接入，不再在 EvalOS 内部复制考生。
2. Candidate Adapter 4.0 与 Product Run Binding 2.0。
3. Trial 独立 Twin 命名空间和独占租约。
4. 原始产品事件保留，再翻译为 EvalOS 通用事件；翻译层不得补造证据。
5. 失败归属区分考生能力、考生可靠性、平台、配置、操作员和瞬态基础设施。
6. 只有冻结合同允许的瞬态错误可以重试，原失败 Attempt 永久保留。
7. 考生侧清场失败与 EvalOS 独立 Twin 复位分开记录。
8. 是否开放下一场，只由 EvalOS 独立证明 `ok=true && clean=true` 决定。
9. 长任务页面展示心跳、实质进展、阶段、预算和停滞原因，但不展示隐藏思维链。
10. Trial 机器日志使用“中文主术语 + 英文辅助解释”，Raw JSON 可以展开。
11. 新建评测、按原配置重新评测、仅重新评分、AI 调查均有独立入口和审计原因。
12. 确定性 Code Grader 是官方成绩；AI Grader/Agent Judge/人工专家只能辅助解释和校准。
13. 首页、数据集、实验、评测任务、轨迹、评分器、AI 调查等真实 Chrome 路径曾完成 M3.1/M3.2 点击验收。
14. 正式 480 Trial 有后端硬开关，不得通过前端或接口绕开。

## 六、历史问题及已经确认的处理原则

### 6.1 EvalOS 曾经存在但已经修复的问题

- Agent+Harness 公开复位接口曾未进入中继精确白名单。
- Runner 曾把“考生自己的清场失败”错误等同于“真实 Twin 未复位”，导致串行考场自锁。
- 云上 40GB 系统盘曾因重复 SQLite 全量备份占满；部署器已经增加空间预检、两代备份和代码/Systemd/数据库一体回滚。
- Chrome 控制曾因浏览器桥接或 Windows 沙箱异常不可用；不能用 API 冒烟代替真实按钮点击。

这些问题的证据和修复历史必须保留，但不得在没有新证据时重复判定为当前根因。

### 6.2 两名考生此前的资格结论

- Agent+Harness 旧资格：`NO-GO`，主要是协议实验槽位状态不一致和正式报告交付不可靠。
- LangGraph 旧资格：`NO-GO`，主要是能稳定交卷但证据没有收敛成正确根因和真实任务结果。
- 两个产品窗口随后均声明已完成非共享环境修复和端到端自测，正在等待 Twin 独占复验。
- 产品团队的“已修复”只代表可以复验，不能自动覆盖旧资格结论。

## 七、新任务接手后的精确执行顺序

### 第一步：接续 Agent+Harness 非正式 Product E2E

1. 不重新 prepare 当前 Trial，不改变故障，不泄露根因。
2. 不启动 EvalOS 资格 Runner，不创建计分 Experiment。
3. 等待 Agent+Harness 产品窗口使用自己的真实产品链路完成调查、审批/动作（若适用）、验证、报告和归档。
4. 收到产品窗口“已完成”后，先采集考生公开结果与 EvalOS 独立快照。
5. 无论考生成功还是失败，都保留原始产品日志、轨迹、报告、动作票据、验证、用量和失败原因。
6. 最后由 EvalOS 使用当前 Trial ID 独立 reset；只有 `ok=true && clean=true` 才能释放下一个时段。

### 第二步：为 LangGraph 准备同等级非正式 Product E2E

1. 必须确认 Agent+Harness Trial 已收口且 Twin 干净。
2. 使用 LangGraph 自己的隔离控制器、身份和新 Trial ID。
3. 布置同等级最小公开故障，但不得让其读取 Agent+Harness 的轨迹或结果。
4. 同样只通知“环境已准备好”，不启动资格评测。
5. 完成后采集证据并独立复位。

### 第三步：形成双考生非正式 Product E2E 结论

- 这一步只回答“真实产品链路是否能进入考场、完成、交卷、归档并释放”，不比较正式胜负。
- 如果发现问题，先判断属于 EvalOS/Twin、Adapter、考生产品还是配置，不能仅凭分数甩锅。
- 不修改两个 OpsMind 源码；生成专项证据交接单。

### 第四步：满足前置条件后再恢复评测门禁顺序

```text
两个考生提交新的不可变版本与材料
  ↓
同一公开 Case × 3 Seed 最小回归
  ↓
12～20 个不计分资格 Trial
  ↓
24～48 个容量 Trial（先验证 4 并发，再验证 8 并发；Twin 当前仍按安全容量串行）
  ↓
共同评审是否解锁 480 个正式 Trial
```

在前面任何一步未通过时，后面的步骤都不得启动。

## 八、新任务必须先做的只读检查

1. 完整阅读仓库根目录 `AGENTS.md`。
2. 阅读本 Handoff，不要把早期 Handoff 当作当前状态。
3. 运行 `git status --short`，保留用户和历史未提交成果。
4. 查询 EvalOS `/health`，确认账本、请求、Trial、清场和正式开关。
5. 通过 `opsmind-twin` 受限身份查询 Agent+Harness 和 LangGraph 的 manager status。
6. 如果 `ah-product-e2e-20260825-1124` 已不再 active，不得重新制造现场；先查证是谁、何时、以什么结果完成了 snapshot/reset。
7. 如果需要真实 Chrome 验收，必须使用浏览器控制完成真实点击；不得只凭接口 200 或静态 HTML 宣布页面通过。
8. 在执行任何 reset、重新 prepare、发布、数据库迁移或安全组变更前，先精确确认目标和回滚边界。

## 九、关键资料索引

- 当前统一裁判基线：`docs/qualification-handoff/OpsMind双考生资格评测总控审计与统一验收基线_20260824.md`
- Agent+Harness 旧资格问题：`docs/qualification-handoff/AgentHarness_OpsMind资格失败专项问题交接单_20260824.md`
- LangGraph 旧资格问题：`docs/qualification-handoff/LangGraph_OpsMind资格失败专项问题交接单_20260824.md`
- M3.2 验收报告：`docs/M3.2_长时任务可观察性与真实资格Trial端到端验收报告_20260823.md`
- M3.1 加固记录：`docs/OpsMind_Agentic_EvalOS_M3.1三组生产级加固与验收记录_20260823.md`
- M3.1 升级方案：`docs/OpsMind_Agentic_EvalOS_M3.1受控闭环评测内核升级方案_20260820.md`
- M3.0 冻结说明：`docs/M3.0_Adapter2.0与正式评测设计冻结说明.md`
- 公共闭环合同：`docs/contracts/OpsMind受控自动修复公共能力合同_v1.0_20260817.md`
- Twin 控制说明：`infra/twin/README.md`
- 生产历史评测升级方向：`docs/OpsMind生产历史评测与EvalOS_M4持续改进闭环升级方案_20260824.md`

## 十、交接时的 Git 状态

- 当前分支：`main`
- 交接前 HEAD：`4a5beab`（与 `origin/main` 一致）
- 交接前未跟踪目录：`docs/qualification-handoff/`
- 本次 Handoff 会与上述三份资格交接文档一起纳入版本控制；新任务仍必须自行运行 `git status`，不能假设工作区永远干净。

## 十一、新任务的完成定义

本次后续任务不能以“服务能打开”作为完成标准。至少需要：

- Agent+Harness 非正式 Product E2E 有真实外部产品证据、明确终态和独立干净复位；
- LangGraph 非正式 Product E2E 有同等级真实证据、明确终态和独立干净复位；
- 两套考生没有串用身份、现场、轨迹或结果；
- EvalOS 平台错误、Adapter 错误和考生错误被分开归属；
- 没有启动资格 Trial、容量 Trial 或正式 480 Trial，除非用户后来明确批准且所有前置门禁已经通过；
- 最后使用真实 Chrome 从首页按产品经理/运维用户路径点击验收相关页面；
- 形成中文、人话、证据可追溯的验收报告。

## 十二、可以直接给新任务的一句话

> 先完整阅读 `AGENTS.md` 和 `docs/HANDOFF_OpsMind_Agentic_EvalOS_M3.2继续验收_20260825.md`，以 Handoff 的 2026-08-25 实时快照为当前事实；不要修改两套 OpsMind 源码，不要重新制造或泄露当前 Agent+Harness Twin 故障，不要启动资格/容量/480 Trial，从受限 SSH 和 EvalOS 健康接口只读复核后，接续 `ah-product-e2e-20260825-1124` 的非正式 Product E2E 证据收口与独立复位，再按文档顺序为 LangGraph 准备独占复验，最后完成真实 Chrome 端到端点击验收。
