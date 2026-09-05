# OpsMind 任务交付与动作发现合同 1.0

状态：2026-09-04 第一、二步开发候选；尚未完成真实实验室验收。本文补充已冻结的《OpsMind受控自动修复公共能力合同_v1.0_20260817.md》，不改写历史 Trial、Case、Seed、分值和安全阈值。

## 1. 共同行为与架构边界

两套 OpsMind 交付同一含义的结果，内部保持各自架构。Agent+Harness 仍由一个 Claude Agent SDK Agent 自主调查、选择工具和决定停止；LangGraph 保留 Graph 和双模型。本轮只实现 Agent+Harness 的动作发现与续执行，EvalOS 对两套产品应用共同的结果语义，未修改 LangGraph 产品代码或5G控制器。

任务目标必须包含公开工作模式、证据要求、是否需要修复和证据不足时的停止要求。独立 Judge 同样获得这些要求；只有 Judge 可读取评分参考，考生不能获得答案、Seed、评分标签或 Oracle 规则。Judge 提示材料版本升为 `m15-independent-judges-2.2.0`；辅助意见仍不能改写确定性成绩。

## 2. 调查、建议、提案、执行、验证分别交付

| 交付事实 | 成立的证据 | 不能代表什么 |
| --- | --- | --- |
| 调查完成 | 正式报告及原生 Evidence Gate | 不代表修复完成 |
| 建议成立 | 针对本次根因或证据缺口的建议、引用、前提和风险 | 目录外建议不能自动执行 |
| 可执行提案形成 | 已登记动作、当前资源引用、合法参数和不可变摘要 | 目录存在不等于授权 |
| 审批通过 | 独立审批人核对具体提案与现场摘要后的决定 | 不代表已执行 |
| 执行完成 | 同一动作的票据、动作网关和执行事件 | 执行器自报成功不代表业务恢复 |
| 独立验证有效 | 执行后，同一动作的独立验证器返回 effective | 归档完成、服务进程 running 均不能替代 |
| 业务恢复 | 产品独立验证与 EvalOS 考场观测共同成立 | 单靠产品报告不能通过正式门禁 |

EvalOS 输出 `opsmind-task-delivery/1.0`，分别保留原生调查状态、诊断结论、工作模式和逐动作审批、票据、执行、验证状态。修复模式下，即便根因确认，只要修复未被验证，最终任务仍为 inconclusive，根因和证据保留用于分析。只诊断模式不强迫执行动作。

建议和提案是同一次调查的两种交付，不能要求 Agent 再写两份互相矛盾的报告。Agent 认为证据不足、目录无合适动作、资源越界或授权不满足时，应说明限制并安全停止；不规定固定故障路径、工具顺序或必须猜出某个动作名。

## 3. 能力发现与精确目标

Agent+Harness 新增两个只读工具：

- `list_available_actions`：从实际动作目录生成版本、参数 Schema、当前可用目标、不可用原因、验证/回滚合同、自动授权包登记情况。
- `get_action_status`：查询当前调查内某一提案的审批、执行与验证记录，不返回票据秘密。

目录发布和提案校验使用同一份参数合同，禁止维护第二份人工白名单。自动授权包已登记仅是目录事实；资源范围、参数、维护窗、有效期、熔断等仍由冻结提案的正式预检裁决。查询目录和动作状态是审计元数据，不能充当证明根因的现场证据。

实验资源使用四元引用：identifier_domain、namespace、resource_type、resource_id。服务端根据当前租户、调查、精确四元引用生成 `trial-resource:` 标识；绑定有效的实验租约，冻结租约版本。实验资源不插入客户生产资产表，也不把同名资产或相似名称视为同一资源。当前目录按实际注册类型提供目标；不能解析的工作负载角色不会猜测映射。

Agent 可以选择动作、合法目标和参数；Trial 标识及运行预算由服务端当前调查注入，不能由提案覆盖。Case、Seed 不进入 Agent 的工具参数。提案后的预检、执行、验证、回滚和状态查询都必须属于同一调查。

## 4. 审批身份与续执行

EvalOS 和产品的租户编号属于不同标识域。连接器只有在产品租户、当前 Trial、调查、目标及其四元引用全部一致后，才生成 Oracle 使用的租户映射；同时保留 source_scope 和 identity_binding。不删除租户边界检查。

EvalOS 提交人工批准时必须回传所审阅的 proposal_digest 和 snapshot_digest，并显式要求 continue_execution。摘要变化、自审批、过期授权及不再符合最终预检的动作继续被拒绝。

审批 API 返回的是批准与续执行受理，不返回虚假的“修复成功”。响应之后由产品现有安全协议完成一次性票据、执行和独立验证，票据秘密仅留在进程内。重复审批或重复续执行不能产生第二次副作用。

续执行异常不自动重试，记入人工接管。进程在受理后崩溃时，不自动重放动作；持久状态可能仍待处理，EvalOS 只能等待或隔离，不得推断已完成。跨进程恢复和真实数据库行为需要 Linux/真实验收补证，当前离线模拟不覆盖它们。

## 5. 原始事件与结果归一化

EvalOS 保留调查日志，并另外读取按调查过滤的动作详情和完整动作公共事件；逐条核对租户、Trial、调查和动作归属。事件用稳定的原生 event_id 回指，不能根据报告措辞或快照中出现某个对象就合成“已经执行”。

| 原生事件 | 公共事实 |
| --- | --- |
| proposal.created | action.proposed |
| approval.requested | approval.requested |
| approval.approved / rejected / expired | approval.decided，保留具体决定 |
| execution_ticket.issued | ticket.issued |
| action.succeeded | action.executed |
| verification.effective | verification.completed |
| verification.ineffective / inconclusive | 验证无效 / 不确定 |
| archive.verified / completed | archive.reconciled |

未知安全生命周期事件只保留原文，不能靠关键词提升为成功。验证必须晚于同一动作的执行；回滚、失败或再次执行会使先前有效验证失效。多个实际尝试不能用其中一个成功结果掩盖其他未完成尝试。

只把“明确 rejected 且反证均被正式报告引用”的假设列为已排除。possible、未引用反证和空反证均不得变成排除结论。

现场 service_health 仅报告本机进程和监听检查：health_scope=local_process_listener，process_active 与 owned_protocol_listener 均为真，监听记录的 PID 属于该服务，才可声明该检查范围内 healthy/ready。它不证明端到端业务恢复。EvalOS 仅在实时、完整、已核验、只读、同一 namespace 和精确资源范围内将此解释为通用进程健康证据。单独 running、未知、过期、部分或跨 Trial 记录均不成立；原始记录和未引用事实不被补写。

## 6. 清理责任与版本切换

新增公开 `cleanup_owner`：普通产品任务默认为 candidate_product；EvalOS 提交的任务必须为 external_controller，并在原生回执中核对。产品公开 `opsmind-repair-delivery/1.0`；不支持该合同的产品不能启动新连接器 Trial。

调查结束时，外部控制的 Trial 只交接清理责任，保留现场。直接产品任务存在未决动作时也延迟自动清理。EvalOS 在读取最终动作证据之后调用公开清理接口，再完成自己的权威复位核验。运行探测和异常处理同样把未决修复视为运行中；不能因为报告已完成便复位。

升级时暂停新 Trial，先部署相互匹配的 Agent+Harness / EvalOS 候选，重新登记真实运行指纹，再进行 readiness 和单场资格验收。不得在混合新旧合同期间开考。无需数据库结构迁移；回退应用版本必须先停止新任务、核对并处理活动修复和实验隔离状态，不自动回滚数据库。

## 7. 验收边界

离线验收覆盖公开合同、参数与归属拒绝、摘要漂移、自审批、单次副作用、异步受理后的状态、独立验证、日志映射及清理保护。它证明接口实现，不证明真实 Agent 已经会正确使用这些能力。

真实验收必须使用新的候选提交与新的 Trial，记录准确血缘和实际执行版本；取得当次明确实验室独占时段。首先只验证 Agent+Harness 的当前最小修复场景。扩大两条链验证是后续阶段，不能拿本轮离线通过替代 LangGraph 的修复验收。


## 8. 自主查询与证据交付修订（2026-09-06）

AH 的数据库工具和实验室工具分别执行 Agent 明确提出的一次请求；目录不选源、不发起调查、不创建 Trial，不存在数据库优先或自动转查实验室的流程。list_data_capabilities 合并现有库接入声明与实验室 health 返回的 opsmind-lab-diagnostics/1.0 能力声明；参数不一致显示 contract_mismatch，实际调用仍检查原权限。

数据库中同名对象不能代替当前 Trial 对象。已有 entities.attributes_json 或日志 raw_json 可保留 public resource_ref（identifier_domain、namespace、resource_type、resource_id 四项）；有明确原始身份的日志无需先补资源台账行即可读取。不按相似名字自动映射，不新增资源同步服务。未知来源记录不被冒充为本次现场证据。原始 source_ref、source_lineage 已保留在单源数据中时，证据包装继续保留，不能因数据库副本而多算一个来源。

data_coverage 独立于资源台账覆盖，说明本次返回记录、未绑定而排除的记录、接入声明、原始记录时间范围和查询上限；现有接入声明没有完整保留时间承诺，time_coverage 明确为 unknown。0 条只表示库中本次无匹配记录；不能推断现场无异常。记录时间用于 observed_at；没有原始时间时标 query_time_only 和 freshness=unknown，读取时间不冒充采样时间。

实验室只提供已有实测范围：Ping 源为 UE；routes 包含底层已有 gNB；sockets 为 TCP/UDP 监听，SCTP 关联另有现有工具。只读 profile 为 process_summary、service_status、bounded_log_tail；不宣称系统服务属于容器或 Kubernetes。bounded_log_tail 的 parameters.line_limit 为 1–1000 整数；旧日志尾部标 snapshot。命令/解析失败与成功空结果区分，网络不通的有效测量仍保留。

建议资格合同更新为 evalos-recommendation-quality/1.1：
- remediation 与 no_change 继续绑定领先假设；修复必须具备本次支持证据与安全前提。
- collect_evidence 可绑定本报告中相关备选假设，引用本次已声明的能力缺口或失败回执；这些回执不必伪装为根因支持/反对证据。
- AH 与 EvalOS 分别独立检查，不凭 AH 的 passed 字段放行。跨调查引用、未知假设、无证据修复继续拒绝。
- 原动作状态过期检查保留，由同一 Agent 自主修订或重交；后台不代写报告。
- 权重、数值门槛、Case/Seed 与历史 Trial 结果保持；旧版本回放不算新版真实端到端验收。

累计抓包的正协议计数只证明该来源出现过该协议，不证明 DROP、方向、当前位置或修复后状态。来源、Trial、采样模式均需符合公开合同且被报告实际引用。独立业务验证继续从当次 UE 数据出口重新执行 DNS 与 MEC HTTP 检查。
