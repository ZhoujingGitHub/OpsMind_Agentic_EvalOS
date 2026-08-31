# 开发期 MVP 外围合同 1.0

这份合同只管“谁在用实验室、产品怎样向 EvalOS 报到、何时允许开考、怎样切换版本”。它不规定两套 OpsMind 怎样调查，也不改变 EvalOS 和5G实验室的核心能力。

## 1. 只承认三种使用模式

1. `langgraph_direct`：LangGraph OpsMind 直接使用5G实验室；
2. `agent_harness_direct`：Agent+Harness OpsMind 直接使用5G实验室；
3. `evalos_trial`：EvalOS 为一个明确 Trial 安排一个明确候选产品使用5G实验室。

同一时刻只能有一份物理租约。产品页面、EvalOS 页面或旧状态文件都不能创建第二份“我正在使用实验室”的事实。

## 2. 物理租约

合同版本为 `opsmind-physical-lab-lease/1.0`，固定字段为：

- `status`：`idle`、`in_use` 或 `quarantined`；
- `owner_mode`：上述三种模式之一；
- `candidate_ref`：`langgraph-v1` 或 `agent-harness-v2`；
- `trial_id`：只有 `evalos_trial` 必须填写，直连必须为空；
- `runtime_trial_id`：实验控制器内部使用的 `lg-` 或 `ah-` Trial 编号，用于重启后的精确清场；
- `lease_id`、`expires_at`：本次占用的唯一编号和到期时间；
- `boot_id`：实验室本次开机身份；
- `updated_at`：最后更新时间。

机器重启、租约过期或状态不一致都不会自动变成空闲，必须先进入隔离并明确复位。这样宁可暂时不开考，也不把上一场残留带进下一场。

## 3. Candidate 报到

合同版本为 `opsmind-candidate-presence/1.0`。两套产品各用一把独立 Ed25519 私钥，每约60秒向 EvalOS 的唯一 HTTPS 入口 `POST /api/candidate-presence` 报一次短状态。

报到内容只包括：产品身份、固定版本、产品开机身份、ready/not_ready、公开能力、数据库版本、当前 Trial 绑定、观测时间、到期时间和一次性 nonce。签名覆盖固定请求方法、固定路径和规范化后的完整消息。

EvalOS 只把最近一次有效报到放在内存里：

- 最长有效期180秒；
- 候选身份与签名密钥一一绑定；
- 旧消息、伪造签名和重复 nonce 全部拒绝；
- EvalOS 一重启，旧 ready 立即消失，必须等产品重新报到；
- 心跳不写入 Ledger，不新增 Redis，不新增常驻中继服务。

这里的 “Candidate” 就是“正在接受 EvalOS 评测的那套 OpsMind”。报到不是调查内容，也不是模型思考过程。

## 4. 两次 readiness

第一次是开考前预检：确认产品活着、版本和数据库匹配、必需能力存在、没有旧 Trial 绑定，并确认物理实验室为空闲。此时没有 Trial 绑定是正常的。

第二次发生在 EvalOS 已准备实验室之后、调用产品模型之前：产品报到、物理租约、EvalOS 手里的 Trial 必须在 candidate、trial、lease、environment 和实验室 boot_id 上完全一致。任何一项不同都不能启动模型。

这个顺序消除了原来的死锁：不再要求“尚未准备实验室时，就先证明已经绑定了准备后的 Trial”。

## 5. current/previous 切换

每个产品只保留 `current` 和 `previous` 两个应用版本指针：

- `apply <固定版本>`：新版本变为 current，原 current 变为 previous；
- `rollback`：只把本产品切回记录的 previous；
- 切换不得修改、回滚或重建数据库；
- 切换不得重启或改动另一套产品；
- 数据库版本不兼容时，应用切换直接停止。

部署账号只能执行本产品固定 root 管理脚本的 `status`、`apply`、`rollback`，不能拿到通用 shell 或 Docker 权限。这不是一个发布平台，只是三条白名单命令。

## 6. 开放资源与评分

继续使用 Manifest 8.0：每套 OpsMind 使用自己公开的最大资源，Token、耗时、模型调用、工具调用和费用只记录、不进入正式成绩。预算只承担防失控的安全熔断责任，不允许 EvalOS 静默把产品资源压低到另一个水平。

正式成绩仍由确定性代码评分给出；AI Judges 和调查分析器继续作为已有的辅助评测与解释能力，不替代官方代码评分，也没有被删除。

## 7. 一次性替换规则

任务1只冻结合同和本地失败测试。任务2、3、4、5分别把租约、直连、Candidate 报到和 readiness 接到真实外围。新路径验收后，旧 Candidate relay、旧 SSH 观察入口、旧监督进程和旧凭据刷新残留必须删除，不留长期双轨兼容。
