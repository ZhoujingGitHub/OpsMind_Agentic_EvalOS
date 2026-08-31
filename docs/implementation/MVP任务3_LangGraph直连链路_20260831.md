# MVP任务3：LangGraph 直连真实5G实验室

- 日期：2026-08-31
- 状态：已完成
- 范围：LangGraph 的外围部署、版本切换和一次真实直连验收；未经过 EvalOS，未创建 EvalOS Trial，未产生正式成绩

## 产品经理结论

LangGraph OpsMind 已经能单独连接真实5G实验室，完成一次真实模型自主调查、真实工具取证、Evidence Gate、Checkpoint、报告归档和实验室复位。

本次也把最危险的外围问题收掉了：API 和后台进程不再同时受 systemd 与 Docker 两套机制监督；日常版本切换只允许受限账号调用固定的 `status`、`apply`、`rollback`，普通部署账号不能控制整台共享主机，也不能修改数据库或另一套产品。

这证明“LangGraph OpsMind + 真实5G实验室”链路已经跑通。它不代表 EvalOS 评测链已经跑通，也不代表真实生产写操作已经开放。

## 1. 这一步要解决什么

- 消除 LangGraph API/后台进程的双重监督和断电恢复风险；
- 保住已有数据库、Checkpoint、Redis、OSS、Relay 和调查核心；
- 把版本切换缩成一条可人工控制、可真实回滚的最小路径；
- 用一次真实5G故障证明 LangGraph 可以独立完成端到端调查；
- 调查结束后把唯一物理实验环境恢复为空闲且干净。

## 2. 实际改了什么

### 单一运行监督

- 精确停止并移除了已经“文件不存在但进程仍存活”的旧 systemd 监督实例；
- API 和后台进程现在只由现有 Docker Compose 管理，重启策略统一为 `unless-stopped`；
- PostgreSQL、MySQL、Redis 没有随应用重建，Relay 和凭据也没有随应用发布重装。

### 固定版本切换

- 建立独立的 LangGraph 部署账号；该账号不在 Docker 管理组中；
- SSH 入口只接受 `status`、`apply <已批准版本>`、`rollback` 三种固定命令；
- root 保护的发布程序把目录、Compose project、API/后台进程和版本格式全部写死，不接受任意路径或上传脚本；
- 每次切换前先确认目标版本在白名单、镜像存在、代码要求的数据库版本与当前数据库完全一致；
- 普通切换只重建 API 和后台进程，不执行数据库迁移；
- 只保留 `current` 和 `previous` 两个活动切换指针。

首次安装这条受限通道和首次把新镜像加入白名单，仍由管理身份完成一次性引导；日常 `apply` 和 `rollback` 已不再使用 root 登录或任意远程脚本。

### 真实耗时记录修复

真实调查暴露了一个外围记账缺陷：调查实际运行约952秒，但正常完成事件里的 `elapsed_seconds` 仍为0。Token、模型调用、工具调用、费用和结果大小记录是正常的，问题仅在“实际经过时间”没有在正常完成路径回写。

修复后，预算记录会在正常模型和工具调用路径持续更新真实墙钟时间，最后一次长模型调用结束后也会再更新一次。高位安全熔断、Token/调用量规则和 Graph 调查逻辑没有改变。修复已通过本地全量测试，并在云端新容器中验证 `elapsed_recording=true`。

历史调查的只追加事件没有被篡改；文档同时保留“原字段为0”和“外部实测约952秒”两个事实。

## 3. 哪些核心明确没动

- LangGraph Graph 5.0 和 State 5.0；
- Flash/Pro 双模型分工与 Agent 自主判断；
- MCP 工具发现、选择和真实取证；
- Evidence Gate、Checkpoint、Interrupt 和恢复；
- Knowledge、报告、审批、动作目录和安全门；
- MySQL 业务语义、PostgreSQL Checkpoint 语义和 Redis 语义；
- 默认 `diagnosis_only`，真实生产写连接器仍未注册。

本次没有给 Agent 固定工具顺序、固定调查轮数或固定根因答案，也没有引入第二个调查 Agent。

## 4. 六类凭证

### 版本凭证

- 真实调查所用 LangGraph 发布版本：`68289f639aa7`；
- 调查后启用的耗时记账修复版本：`802e9265fc27`；
- 当前镜像摘要：`sha256:e38c30c629662d6d2d152f067be2ca9fa0a5d2ce08c36717518921fda6a895e4`；
- 当前数据库版本：`20260828_0011`，切换和回滚前后均未变化；
- 新镜像运行用户：`10001:10001`，不是 root。

### 准备凭证

- 直连运行标识：`lg-direct-mvp-20260831-01`；
- 真实故障场景：`amf-process-down`；
- 物理租约模式：`langgraph_direct`；
- 产品：`langgraph-v1`；
- 唯一物理租约：`lease-23Jdqam5IBDjbIG4Pxp5ccayTZneHZo_`；
- 准备后产品 readiness 的六个真实连接均为健康，包括共享只读 MySQL、业务 MySQL、PostgreSQL Checkpoint、Redis、OSS 和 Open5GS/UERANSIM。

### 直连身份与范围凭证

这是产品直连，不需要 EvalOS Candidate 报到或 EvalOS Trial 绑定。底层唯一物理租约中的模式、产品和产品运行标识与 LangGraph 本次运行完全一致；租约不包含 EvalOS Trial 标识，避免把直连调查伪装成评测。

### 核心运行凭证

- Candidate：`cand-ac454acda6514aa8ab17c7aa`；
- Investigation：`inv-66907e257fd143bf990701be`；
- Thread：`thread-2f0f7c562dc346d0a77f5786`；
- Run：`run-28b5b9797c98430cb6e588c2`；
- 真实运行约952秒；
- 76条调查事件、12次真实模型调用、19次工具调用并全部完成、19条证据、4个假设、5次 Evidence Gate 判断、32个 PostgreSQL Checkpoint；
- 实际使用的工具覆盖协议摘要、SCTP、用户认证、套接字、路由、IP可达性、路径跟踪、DNS、HTTP、TCP等，由 Agent 动态选择；
- Token、模型/工具调用、费用和结果大小均有记录，不参与本次任何评分。

调查结果确认了两条有证据支持的故障链：gNB 与 AMF 没有建立 SCTP/NGAP，UE 未注册、没有 PDU；同时 UE 命名空间缺少默认路由和 `10.46.0.0/24` 路由，导致业务网络不可达。报告也如实保留了不确定性：控制面最精确的底层原因仍需更直接证据确认，PFCP/GTP 没有被完全排除。

### 结束凭证

- 任务终态：`completed / root_cause_confirmed`；
- Evidence Gate：5.0通过；置信度0.9；
- Product E2E 摘要：`149b3d9a66dfef5bc4317918e23bb495f263c9c95152bfefd5be96a1c392f17d`；
- OSS 不可变归档内容摘要：`46f40f40b1a13749bb1baa0e3b7f3e92518b66205809192ce949c52ba92aadb7`；
- 本次保持 `diagnosis_only`，`production_write=false`，没有动作提案或真实生产写入。

本次没有经过 EvalOS，所以没有 Code Grader、AI Judge 或 Ledger；这不是缺失，而是直连链路的正确边界。

### 清场凭证

- 产品运行结束快照摘要：`52efee33c6f2561f31b51cb05193e16db59cf066baa7857b319253cc648fb43f`；
- 复位结果摘要：`131e7332ace33bef3fda458a60fd4ac189da8b25a370068687e4fcb90a3c5609`；
- 复位后九项基线检查全部通过；
- 最终物理租约为 `idle`，没有产品、Trial、运行标识、租约或到期时间；
- 最终 `active_trials=0`、`slot_available=true`、`recovery_required=false`，开机标识与租约记录一致。

## 5. 部署、备份和回滚证明

- 切换前备份保存在 `/srv/opsmind-langgraph/backups/pre-migration-20260831T104237Z`，包含业务 MySQL、PostgreSQL Checkpoint 和 Redis，并有校验值；
- 最终 API 和后台进程均运行 `802e9265fc27`，重启次数为0；
- 旧 systemd 单元最终为 `not-found / inactive / dead`，主进程为0；
- 受限账号的任意命令尝试被拒绝为 `command_not_allowed`；
- 已真实执行一次回滚演练：`802e9265fc27 → 68289f639aa7 → 802e9265fc27`；两次都只替换 API/后台进程，数据库始终为 `20260828_0011`；
- 回滚后 API、后台进程、六个真实连接和5G实验室最终状态再次通过检查；
- 本次上传临时目录已经删除，恢复备份和两个正式发布版本保留。

## 6. 还剩什么风险

- 这次真实调查没有提出动作，因此证明了“动作安全保持关闭”，没有证明审批后执行、验证和回滚的完整动作链；该能力的既有核心与回归测试保持不变，不能把本次直连验收扩大解释成动作链验收。
- 真实调查事件里的耗时0是已经冻结的历史错误字段；后续新运行会记录真实耗时，但不能伪造修改旧证据。
- 旧 Candidate SSH 报到路径暂时仍在产品配置中，仅供任务5一次性切换；它不参与本次直连，也不拥有物理租约。新签名报到验证后必须删除，不能长期双轨。
- 当前仍是开发期单机、单实例和人工版本批准，不是商用高可用。

## 7. 建议继续还是停止

建议继续任务4：收口 Agent+Harness 的外围部署并完成一次真实直连调查。

如果任务4暴露 Agent+Harness 核心缺陷，应停在任务4如实诊断；不能修改 LangGraph 或 EvalOS 来掩盖。
