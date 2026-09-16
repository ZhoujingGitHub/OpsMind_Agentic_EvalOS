# 发给 Claude Code 的接管提示词

请接管 OpsMind 智能运维 Agent 项目。先完整阅读：

`D:\AIPM\黄钊+张和AIPM训练营\5期\从0到1打造一个Agent落地产品\OpsMind_Agentic_EvalOS\docs\HANDOFF_智能运维Agent全景接管_ClaudeCode_20260911.md`

随后按该文件第 8 节读取总 HANDOFF、三个产品的 AGENTS.md/长期记忆、LG 正确候选工作树以及 direct04 完整证据。先做只读复核，不要把 LG 顶层旧工作树当成当前代码，不要清理任何未提交或未跟踪文件。

当前重点不是 AH。AH → 5G、AH → EvalOS → 5G 已通过，AH 代码暂时不改。未完成的是：

1. LG → 5G：最新 direct04 中第一个 N2 动作确实成功，但 Ping/DNS/HTTP 数据通路仍不通；LG 外围错误地把实验室的局部 `task_success` 当成全局恢复，导致第二个 N6/路由动作被拒绝。
2. LG → EvalOS → 5G：最近正式 Trial 仍是旧版本组合，只有 42.86 分、12/15 硬门；当前 LG `e34773b` + EvalOS `41d99bc` 尚未完成同一准确组合的正式资格 Trial。旧轮次还存在修复后未复核根因、最终根因为空、EvalOS 接收端按最后动作推断整体结果的问题。

请先从代码和证据中确认以下准确路径：

- `task_success → health → fault_still_present → policy` 如何使修复循环提前结束；
- `repair_delivery`、最终报告和 EvalOS LG receiver 如何使用最后一个 proposal/action 推断任务结果；
- LG 普通探测与实验室 verifier 是否使用不同源接口；
- direct04 的 N6/NAT/返回路由只能作为待验证假设，必须靠同一 Trial 的 PCAP、conntrack、NAT 计数和路由证据确认。

期望方案是一次轻薄的 break change：只保留 action、issue、task 三层结果；动作历史追加保存；任务恢复只由修复后的统一业务验证决定；每个写动作后回到只读调查；过时或证据冲突的提案关闭后继续调查；安全停止仍立即终止；EvalOS 校验 LG 发布的任务级结果和完整动作历史，不再通过最后动作猜结果。删除旧冲突语义，不增加兼容层。可可靠回滚就登记逆动作，不可可靠回滚则回滚为空，禁止假回滚。

不要修改 AH，不要改评分权重或历史账本，不要用旧 Trial 加新提交局部测试冒充最新版端到端验收。若确需修改 EvalOS，仅限 LG 候选登记或 LG 结果接收合同，并先按仓库 AGENTS.md 取得本任务明确批准。

任何代码、配置、迁移、分支、构建、部署或真实实验室 Trial 前，先给产品经理一张人话审批表：当前 accepted main、线上准确提交/标签、问题、拟改内容、不动核心、分支、测试、部署和回滚。得到明确批准后再执行。共享实验室必须独占串行；每轮封存证据并复位。最终目标是在准确最终版本上依次验收 LG → 5G 和 LG → EvalOS → 5G，再完成 main、origin/main、生产标签和线上版本核对。
