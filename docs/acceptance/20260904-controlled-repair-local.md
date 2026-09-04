# 第一、二步本地交付与候选发布审阅

2026-09-04：开发和离线验证完成；尚未提交、推送、构建、部署或运行真实 Trial。当前不能宣称真实修复链已经验收，历史低分保持原样。

## 已实现

1. 明确调查、建议、提案、审批、执行、独立验证和业务恢复的不同含义。详细合同：`docs/contracts/OpsMind任务交付与动作发现合同_v1.0_20260904.md`。
2. Agent+Harness 从真实目录发现动作、合法参数、精确目标、不可用原因和授权包登记情况。目录与提案校验同源；Trial 和预算由服务端注入，Case/Seed 不进入模型工具参数。
3. 实验目标绑定租户、调查、四元资源引用和有效租约；不借用同名生产资产。后续动作工具不能跨调查。
4. 人工批准核对提案/现场摘要，受理后走既有一次性票据、动作网关、独立验证协议。重复审批/续执行不会产生第二次副作用。
5. EvalOS 读取原生动作公共事件，验证归属后映射租户编号，保留原始 Scope。归档、报告完成和模糊事件名不能冒充执行/验证成功。
6. 外部控制的现场保留到取证完成；正常轮询、异常运行探测与最终清理都检查未决修复。
7. 已引用的明确反证可形成排除结论；严格绑定的实时服务健康观测可解析为通用健康证据。独立 Judge 获得完整任务要求，版本升为 2.2.0，仍不改正式成绩。

## 离线验证

| 检查 | 结果 |
| --- | --- |
| AH 全部 Agent Service 测试 | 311 通过、2 跳过 |
| EvalOS 运行时、内核、控制 API 测试 | 183 通过、0 失败；包含 LangGraph 连接器回归 |
| EvalOS 架构、安全检查 | 均通过 |
| EvalOS 能力保护 | 20/20 |
| 已保存公开观测的转换检查 | service_health 解析出 AMF 等健康引用；runtime_state 不冒充健康 |

两项跳过分别是 Windows 无法验证的调查级 Unix socket，以及 POSIX 所有者/权限与原子符号链接，需要在 Linux 补验。现有 FastAPI 测试客户端的弃用提示不影响本轮结论。

以上均为离线工程测试/模拟，付费模型调用为零。历史观测检查只读取 `trial_763dab5fb76c88105436` 已保存的公开证据，不是完整 Trial 重放，没有更新分数。

最后代码修改后的完整回归日志：

- AH 候选：`.test-artifacts/step12-pytest.log`。
- EvalOS 候选：`_work/step12-local-tests-20260904/step12-node-tests.log`。
- 公开观测检查：`_work/step12-local-tests-20260904/preserved-health-check.json`。

## 准确血缘

“上一轮部署”来自既有部署记录，本轮未重新检查云端；实际发布前必须复核。当前修改尚无新提交号，不能将基线提交当成本轮已交付版本。

| 产品 | 本地 main = origin/main | 本轮修复基线 / 上一轮部署候选 | 现有稳定标签 |
| --- | --- | --- | --- |
| Agent+Harness | `25b5aa5bb8f02990ba8186b6d10ee709685e2cd3` | `7426bbf1f59dadfdaf91d4116d427121ad30e9fe` | `prod-agent-harness-20260902-recommendation-reliability` → `25b5aa5` |
| EvalOS | `c43325596197ac616ca82657e3eb5cbb2e05f727` | `2bb1aa16338a86ba72d446d6d0ad25e0ce970842` | 历史标签 `prod-evalos-20260901-development-mvp` → `cd14176`，不对应当前 main/候选 |
| LangGraph，本轮无修改 | `f99d3775fb717435f9bfb5cd7b1f85bc389377f1` | `29ec3acfc9407c9c91b457ccbf031b4c6dbe5c0e` | `prod-langgraph-20260902-model-output-recovery` → `f99d377` |

Git 已核对本轮两个候选各自的 main 是 HEAD 的祖先，HEAD 正是上述修复基线。这是未验收候选的继续修复，不能提前称为最新稳定版；历史标签不移动。

| 中文候选名 | 分支 | D 盘候选工作目录（相对于用户指定的训练营项目父目录） |
| --- | --- | --- |
| AH：发现授权动作并完成修复 | `codex/agent-harness-feature-action-discovery-20260904` | `OpsMind/_work/codex-migration-20260903/candidates/lab-evidence-labels` |
| EvalOS：受控修复交付合同 | `codex/evalos-feature-controlled-repair-contract-20260904` | `OpsMind_Agentic_EvalOS/_work/codex-migration-20260903/candidates/evidence-readiness` |

父目录为 `D:/AIPM/黄钊+张和AIPM训练营/5期/从0到1打造一个Agent落地产品/`。源码、证据和长期记忆均在 D 盘。

## 下一阶段审批表

| 项目 | 提议 |
| --- | --- |
| 当前问题 | 接口和离线模拟通过；真实 Agent 能否正确使用能力、Linux/真实数据库的续执行和清理尚待验收 |
| 提交与推送 | 仅本轮审阅文件进入 `ZhoujingGitHub/OpsMind`、`ZhoujingGitHub/OpsMind_Agentic_EvalOS` 对应候选分支；排除测试数据库、运行日志、临时产物和本地记忆 |
| 保持的核心 | AH 单 Agent、LG Graph/双模型、实验场景与安全复位、Seed/预算/评分权重/75分通过线/历史 Trial/账本；LG 仓库和5G控制器无修改 |
| 发布顺序 | 获批后提交并验证祖先，推送候选；暂停新 Trial，依次构建/部署匹配的 AH 和 EvalOS；按实际公开合同重新登记候选指纹；完成 Linux 补验及 readiness |
| 首场真实验收 | 取得当次明确5G实验室独占时段；仅 AH 当前最小场景的新资格 Trial，核对调查、提案、独立批准、一次执行、独立验证、最终业务状态和复位 |
| 失败处理 | 保留失败/不确定证据，隔离未完成修复；不重放可能已发生的副作用，不靠人工改库或代操作补成绩 |
| 回滚 | 无数据库结构迁移；核对活动任务和实验状态后，按既有 current/previous 切回准确应用版本，不自动回滚数据库或改另一套产品 |
| 版本收口 | 只有准确最终提交完成真实验收，才收回 main、推送 origin/main、建立新的可读不可变生产标签并核对线上；未通过继续保留候选身份 |

需要后续明确批准才执行此表。依据：两个项目 AGENTS.md 将 Git 提交/推送/发布与开发授权分开，并要求共享实验室每次重新取得明确独占授权。
