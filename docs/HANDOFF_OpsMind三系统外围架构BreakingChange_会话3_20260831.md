# OpsMind 三系统外围架构 Breaking Change 交接（会话3）

- 日期：2026-08-31
- 适用项目：OpsMind Agentic EvalOS、LangGraph OpsMind、Agent+Harness OpsMind
- 文档用途：供产品经理审核最终外围架构方案，不是开工授权
- 当前状态：只允许阅读、复核、提出异议和修改方案；未经用户在“会话3”明确批准，不得写产品代码、部署、连接 Twin、调用 observe、创建调查或启动 Trial

---

## 1. 先用人话说结论

过去两天反复失败，不是因为某一个程序员不会修某一个 Bug，而是因为 LangGraph 外围部署方案从根上设计得太重：它想同时控制 Docker、systemd、版本切换、凭据迁移、Candidate 健康证明、远程网络和自动回滚，还想让这些东西像一次数据库事务一样“要么全部成功、要么全部恢复”。

现实中这些系统不能真正组成一个原子事务。为了掩盖这个事实，代码不断增加状态文件、pending 目录、证明文件、恢复器和校验器，最后形成了约 38 个外围文件、约 9,000 行部署逻辑。每增加一个保护条件，就多一个可能阻断发布的地方；每修一个阻断，又会暴露下一层问题。

因此，本轮不再继续打补丁，而是允许 breaking change：

1. 废弃 LangGraph 现有复杂发布主链；
2. 把“应用、数据库、EvalOS 接入、Candidate 观察”拆成彼此独立的责任域；
3. 每个责任域只保留一个权威事实来源；
4. 接受开发阶段 10–30 秒维护窗口，不建设蓝绿发布或自研编排平台；
5. Agent+Harness 不照抄 LangGraph 重构，只做必要的定向收口；
6. EvalOS 提供两套产品共用、但身份互相隔离的 Candidate Observation 合同；
7. 改造完成、只读 discovery 通过后，仍需用户明确说“启动 Trial”才能开考。

最终目标不是“所有异常都能自动处理”，而是：日常发布路径短、故障范围小、回滚方法唯一、主机重启不需要扫码登录、外围故障不会破坏 Agent 调查主链。

---

## 2. 用户必须知道的边界

### 2.0 最高优先级红线：两个 OpsMind 核心架构本质上都没有问题，绝对不能动

这是用户在交接过程中再次明确强调的最高优先级要求：

- Agent+Harness OpsMind 的核心架构本质上没有问题；
- LangGraph OpsMind 的核心架构本质上没有问题；
- 本轮所有问题均按“外围部署与接入架构问题”处理；
- 不得借外围 breaking change 之名重构、替换、简化或重新解释任何一个 OpsMind 的核心调查架构；
- 如果实施方案需要修改 Agent 如何思考、选择工具、组织调查、形成证据或停止调查，说明该方案已经越界，必须停止并重新设计外围方案。

两套核心架构分别受以下保护：

#### Agent+Harness OpsMind 核心保护范围

- 官方 Claude Agent SDK；
- 有状态 ClaudeSDKClient；
- DeepSeek V4 Flash Thinking；
- 单 Agent 自主调查循环；
- MCP、Skills、ToolSearch、SDK 原生工具和 Bash 安全边界；
- Agent 自主提出假设、选择工具、调整路径和决定停止；
- Harness、Hook、Evidence Gate、报告交付和动作安全。

#### LangGraph OpsMind 核心保护范围

- 现有调查 Graph 与 State；
- Flash/Pro 双模型分工；
- MCP 调用与 Agent 自主决策；
- Evidence Gate；
- Checkpoint、Interrupt 和恢复；
- Knowledge、报告、审批和动作安全；
- 现有业务数据库语义。

允许修改的只有外围：容器部署、版本切换、服务器管理身份、Relay/凭据刷新、Candidate Observation 传输认证、readiness、配置与 Secret 装载、回滚和 EvalOS admission。

### 2.1 本轮要改的是“外围”，不是 Agent 大脑

不修改：

- Agent+Harness 的官方 Claude Agent SDK 单 Agent；
- DeepSeek V4 Flash、MCP、Skills、ToolSearch、SDK 原生工具；
- Agent 自主提出假设、选择工具、调整调查路径、决定何时停止；
- LangGraph 产品现有调查 Graph、模型选择、Evidence Gate、Checkpoint；
- EvalOS 的隐藏 Case、Seed、Grader、答案和历史 Trial；
- 真实生产写能力继续关闭。

要修改的是：

- 服务器如何部署和恢复；
- EvalOS 如何安全识别两套产品；
- Candidate Observation 如何长期可用；
- 三角色凭据如何自动刷新；
- 如何避免一个产品部署误碰另一个产品；
- 如何在失败时简单、诚实地回滚。

### 2.2 不追求这些昂贵目标

开发阶段明确不做：

- Kubernetes、Nomad、Consul、Vault、SPIFFE 等平台；
- 跨 Docker、systemd、数据库、远程网关的“绝对原子事务”；
- 零停机蓝绿发布；
- 多机高可用；
- 自动处理所有主机断电场景；
- 为历史错误布局保留兼容双轨。

---

## 3. 当前已确认事实与开工前待核验事实

以下是截至交接时的最后已知事实。所有云端状态在真正开工前必须通过固定 WireGuard 管理通道重新只读核验，不能把历史记录当成当前事实。

### 3.1 已确认的结构事实

#### LangGraph OpsMind

- 旧正式 API/Worker 最近一次只读核验仍可用，未启动 Trial；
- 现有外围发布包含多套 Compose、systemd runtime/boot unit、证明文件、认证迁移、安装迁移和发布事务；
- Docker 和 systemd 曾同时监督同一运行过程，产生 `active/not-found` 幽灵 unit；
- Candidate health 被设计成部署时“只能调用一次”，使普通网络或合同错误直接报废整次发布；
- 当前旧部署主链已经停止，不允许继续补丁式清理或 activate；
- 新方案批准前，不复用旧 Candidate proof。

#### Agent+Harness OpsMind

- MySQL/Redis 已经是独立 Data Runtime；
- Agent Service 是单独 Compose 服务，并使用 Docker restart policy；
- Agent 容器没有额外的 systemd runtime 监督，结构明显比 LangGraph 简单；
- 三角色短期会话自动续期 service/timer 已部署并实际轮换成功；
- 三角色续期不包含 Candidate Observer；
- Candidate Observer 当前代码仍使用最长 24 小时的短期 Bearer，并且只在服务启动时主动 health；
- 最新公开 Candidate Observer 到期时间早于当前时间，若没有后续未记录轮换，当前应为 blocked；
- 仓库 Compose/Dockerfile 使用 10001，而最近云端正式容器使用 10002，曾因此发生 Secret 权限失败；
- 三角色续期脚本仍通过 inspect Agent API 容器读取 DB 连接参数，Bridge 与应用尚未彻底解耦。

#### EvalOS

- EvalOS 是 Trial、Scope、lease、隐藏数据和评分的可信控制面；
- 当前 Agent+Harness Candidate Gateway 路径使用短期 Bearer；
- 当前 LangGraph Candidate Observer 使用永久受限 SSH 身份；
- 两套产品的 Candidate Observation 认证方式不统一；
- Adapter 5 已能发现 Candidate Observation readiness，但 readiness 的真实性仍依赖产品公开状态；
- 固定 WireGuard 管理通道已建立，未来日常运维不应依赖阿里云前端扫码。

### 3.2 开工前必须重新只读确认

- 三台/两台相关 ECS 的当前运行容器、镜像 digest、重启次数和磁盘空间；
- 当前 WireGuard 是否自动启动、双方地址和主机指纹是否未漂移；
- EvalOS、LangGraph、Agent+Harness 各自 Git HEAD 与远端分支；
- 是否存在 active/queued Job 或未结束 Trial；
- LangGraph 两个幽灵 unit 的当前状态；
- Agent+Harness Candidate Observer 是否确已过期；
- Relay 和三角色 timer 当前是否正常；
- 当前数据库 migration head；
- 所有检查只回传公开状态和摘要，不输出 Token、私钥、密码或环境变量正文。

---

## 4. 最终推荐架构

```text
                         固定 WireGuard 管理网
                                  │
                    受限维护身份，只允许固定命令
                                  │
          ┌───────────────────────┴───────────────────────┐
          │                                               │
      EvalOS ECS                                    产品共享 ECS
  ┌──────────────────┐                  ┌────────────────────────────┐
  │ Trial / Scope    │                  │ LangGraph Infra Compose    │
  │ lease / Grader   │                  │ PostgreSQL + Redis         │
  │                  │                  ├────────────────────────────┤
  │ Candidate        │◄──签名 HTTPS────►│ LangGraph App Compose      │
  │ Observation      │                  │ API + Worker               │
  │ Gateway          │                  ├────────────────────────────┤
  │                  │                  │ Agent+Harness Data Compose │
  │ Relay Broker     │                  │ MySQL + Redis              │
  └──────────────────┘                  ├────────────────────────────┤
                                        │ Agent+Harness App Compose  │
                                        │ Agent Service              │
                                        ├────────────────────────────┤
                                        │ 两套独立 Eval Bridge       │
                                        │ Relay + 三角色刷新         │
                                        └────────────────────────────┘
```

核心原则：

- 数据库生命周期与应用发布分开；
- API/Worker/Agent 只由 Docker 管理，不再叠加 systemd；
- systemd 只用于宿主机 Relay 和短时定时任务；
- 两个产品虽然暂时共用 ECS，但目录、Compose project、网络、Secret、部署身份和 Bridge 完全分离；
- Candidate Observation 是业务只读能力，不是容器 liveness；
- Twin/EvalOS 暂时不可用时，Candidate capability 显示 blocked，但产品核心 API 仍然 live；
- 每个领域只有一个事实源。

---

## 5. 每个领域的唯一事实源

| 领域 | 唯一权威事实 | 禁止再出现的重复事实 |
|---|---|---|
| 源码身份 | Git 40 位 commit | 手工填写的第二套 revision |
| 运行镜像 | Docker image digest/ID + OCI revision | 浮动 tag 被当作身份 |
| 应用期望版本 | 不可变 release bundle | current、pending、proof 多文件共同决定 |
| 真实运行状态 | Docker inspect + 本地 health | systemd cached unit 被当作容器真相 |
| 数据 | PostgreSQL/MySQL/Redis volume | 跟随 app release 的数据库副本 |
| 三角色凭据 | Bridge 当前 generation 指针 | tokens/current/root 三套并存读取 |
| Candidate readiness | 产品后台最近一次签名 health 的 Redis TTL 状态 | boot proof、10 分钟 attestation 文件 |
| Trial/Scope/lease | EvalOS 数据库与可信控制面 | 产品自行推断或伪造 |
| 冻结候选身份 | EvalOS 可信 Manifest | 产品 Relay 自报 attestation |

---

## 6. EvalOS 改造方案

### 6.1 统一 Candidate Observation 认证

推荐两套产品统一使用“独立 Ed25519 机器密钥 + 签名 HTTPS”，不继续维持 Agent+Harness Bearer 与 LangGraph SSH 两套长期协议。

做法：

- 每个产品各自生成独立 Candidate Observer 私钥；
- 私钥永不离开产品安全存储；
- EvalOS 只保存 candidate_ref、key_id 和公钥；
- 请求包含时间戳、nonce、method、path、body digest 和签名；
- 复用现有 Relay 已验证过的签名、防重放和审计思想，不重新发明复杂 PKI；
- Candidate Observer 与管理身份、Relay signing key、三角色 Bearer 完全分离；
- health 只返回合同、能力和安全断言，不返回 Twin 数据；
- observe 必须同时验证 Trial、slot lease、resource/service/namespace Scope 和 TTL；
- prepare/reset/snapshot 不属于 Candidate Observer 权限。

为什么不用永久 Bearer：Bearer 被复制后，在有效期内任何人都能使用。非对称签名只暴露公钥，私钥留在产品主机。

为什么暂不做完整 mTLS：mTLS 很安全，但需要 CA、证书签发、续期和吊销体系；当前开发阶段会明显增加组件。本轮先使用已有 Ed25519 签名模型。

### 6.2 Candidate readiness

- EvalOS 不替考生调用 observe；
- EvalOS discovery 读取产品公开的最近 health 状态；
- readiness 超过 TTL、签名失败、能力缺失或 Scope 合同不一致时，Trial admission fail-closed；
- readiness blocked 只阻止 Candidate 相关 Trial，不把产品 API 判死；
- readiness 不能包含 Case、Seed、Grader、答案或其他候选轨迹。

### 6.3 冻结 Manifest

- 产品部署完成后，EvalOS 可信侧只读读取 source revision、image digest 和公开合同；
- EvalOS 自动生成新的候选冻结记录；
- 产品 Relay 不能自行改 Manifest；
- 发现 drift 时拒绝 Trial，不做相似匹配或人工假填。

### 6.4 EvalOS 部署入口

- 固定 WireGuard；
- `opsmind-maint` 受限身份；
- 只允许 `status/upload/deploy/rollback`；
- 禁止交互 Shell、PTY、SFTP、端口转发；
- root 只用于一次性安装和紧急恢复。

---

## 7. LangGraph OpsMind 改造方案

### 7.1 三个独立生命周期

#### LangGraph Infra Compose

只包含：

- PostgreSQL；
- Redis；
- 数据卷；
- healthcheck；
- restart policy。

普通应用发布永不执行 `down`、永不重建 Infra。

#### LangGraph App Compose

只包含：

- API；
- Worker。

规则：

- 固定 Compose project；
- 使用不可变 image digest/ID；
- 非 root、read-only、cap_drop；
- Docker restart policy；
- 不再创建 `opsmind-langgraph-runtime.service`；
- 不再创建 Candidate boot systemd service；
- 不再用 systemd 监督 Docker Compose。

#### LangGraph Eval Bridge

独立管理：

- LangGraph Relay；
- submitter/approver/administrator 三角色凭据刷新；
- 独立 token generation；
- 独立配置与审计。

App 发布不得枚举、停止、迁移或删除 Bridge unit。

### 7.2 Candidate readiness

- Candidate 私钥只挂载给 Worker，不给 API；
- Worker 启动后和运行期间每约 60 秒调用一次只读 health；
- health 是幂等操作，不再要求“只能一次”；
- Worker 将无秘密结果写入 Redis，TTL 约 180 秒；
- API 只从 Redis 投影 ready/blocked、checked_at、能力和错误码；
- 网关不可用不会触发 API/Worker 重启；
- observe 仍必须绑定 Trial/lease/Scope。

不再需要：

- Candidate attestation 文件；
- 600 秒 boot proof；
- per-image proof 目录；
- boot state；
- `candidate-attestation-boot.service`。

### 7.3 发布路径

仅保留一个命令入口和四个阶段：

1. `build`
   - 干净 commit；
   - 不可变归档；
   - 构建一次；
   - 校验 OCI revision 和 digest；
   - 不改变线上。

2. `preflight`
   - 零写入；
   - 检查配置、Secret 权限、Infra 健康、数据库 migration head、active/queued；
   - 不启动完整 API，不创建 Job，不同步业务数据。

3. `activate`
   - 只替换 API/Worker；
   - 等待 API 本地 liveness、Worker heartbeat、Relay/三角色、Candidate readiness；
   - 成功后才记录 current 和 last-known-good。

4. `rollback`
   - 用同一 App Compose 切回 last-known-good digest；
   - 不碰 Infra、Bridge、EvalOS、Twin。

### 7.4 数据库迁移规则

- 本轮外围重构原则上不修改业务数据库结构；
- 如果未来必须迁移，只允许向后兼容的“先增加、后删除”方式；
- 不在自动回滚时倒迁数据库；
- 破坏性字段删除必须单独版本、单独审批。

### 7.5 一次性 breaking cutover

- 新 App 栈在不影响旧服务时先构建并完成 preflight；
- 确认 active=0、queued=0；
- 进入 10–30 秒维护窗口；
- 精确停止并 reset 两个历史幽灵 unit，daemon-reload；
- 用新 App Compose 启动 API/Worker；
- 验证后再更新 current；
- 失败则用同一个 App Compose 启动旧 digest；
- 不先清理旧服务再慢慢开发；
- 旧复杂部署脚本从活动源码删除，Git 历史作为审计记录。

### 7.6 必须删除的旧主链

- LangGraph runtime systemd service；
- Candidate boot systemd service；
- runtime unit baseline reconciler；
- legacy runtime bootstrap；
- auth migration 与 app activate 的耦合；
- release/auth/installer 三层 transaction 状态机；
- proof/boot-state/pending 目录体系；
- 多层 Compose 叠加；
- “Candidate health 恰好一次”的限制；
- 全主机 systemd unit 扫描；
- 旧兼容分支和第二部署入口。

---

## 8. Agent+Harness OpsMind 改造方案

Agent+Harness 不做整体重建，只做四项定向收口。

### 8.1 保留不动

- Claude Agent SDK 单 Agent 调查架构；
- Agent Service 单容器；
- 独立 MySQL/Redis Data Runtime；
- Docker restart policy；
- 已验收的三角色续期业务算法；
- Relay 与角色权限分离；
- MCP、Skills、ToolSearch、Bash 安全边界和 Candidate observation 工具合同。

### 8.2 Candidate Observer 改为永久签名身份

- 删除最长 24 小时短期 Bearer 文件合同；
- 使用 Agent+Harness 独立 Ed25519 Candidate Observer 私钥；
- 与 EvalOS 统一使用签名 HTTPS；
- Agent Service 启动后和每约 60 秒执行 health；
- 无秘密 readiness 写 Redis TTL；
- discovery 动态读取，不依赖容器重启；
- observe 仍强制 Trial/lease/Scope；
- 不增加第二 Agent 或专门 Worker。

### 8.3 统一运行 UID/GID

- 当前仓库 10001 与云端 10002 必须收敛；
- 为减少现场 Secret 迁移，推荐固定 Agent+Harness 为 10002:10002；
- 镜像定义运行用户，Compose 不再覆盖 `user:`；
- Secret 固定 root:10002/0640；
- preflight 实际验证容器用户可读；
- 禁止通过放宽 Secret 为 world-readable 解决权限问题。

### 8.4 Bridge 与 Agent API 解耦

- 保留现有续期算法；
- 构建独立小型 renewal image，按 digest 固定；
- Bridge 自己持有非秘密 DB endpoint 配置和只读 Secret 路径；
- 不再通过 `docker inspect` Agent API 容器读取 DB 参数；
- Agent 容器改名、升级或暂时重启，不改变 Bridge 配置事实；
- App 发布不安装或迁移 timer。

### 8.5 轻量应用发布入口

与 LangGraph 共享概念，不共享复杂状态机：

- `build`：构建并锁定 digest；
- `preflight`：零写入检查；
- `activate`：只替换 Agent Service；
- `rollback`：切回 last-known-good digest；
- 永不触碰 MySQL/Redis/Relay/timer。

### 8.6 受限管理身份

- 固定 WireGuard；
- `opsmind-ah-deploy` 只允许 status/build/preflight/activate/rollback；
- 不能访问 LangGraph、EvalOS、Twin 或共享 root 路径；
- root 只用于一次性安装和紧急恢复。

---

## 9. 三套系统共同遵守的防“屎山”红线

1. 一个领域只能有一个事实源；
2. 应用发布不能操作数据库容器和 Relay；
3. 不允许 systemd 与 Docker 同时监督 API/Worker/Agent；
4. 不允许为了兼容旧错误保留双路径；
5. Candidate health 必须幂等，可重复，不能成为部署一次性炸点；
6. 外部网关故障只能影响 readiness，不能影响核心 liveness；
7. 预检必须零写入，不允许通过完整业务 API 启动代替预检；
8. 激活只接受已经构建好的不可变镜像，不在切换阶段重新构建；
9. 回滚只能有一条路径；
10. 共享主机上任何产品不得枚举或修改另一个产品资产；
11. 不允许普通自动化长期使用 root；
12. 任何新外围脚本加入前，必须说明它属于哪个责任域、替代什么旧事实源；
13. 活动部署代码若再次接近约 1,500 行，必须先做架构复审，不能继续堆状态机；
14. Graph/Agent/Prompt/MCP 等核心调查逻辑与部署外围必须分别评审；
15. 未经用户明确批准，不得启动 Trial。

---

## 10. 实施顺序

### 阶段 A：方案审核

- 新“会话3”只阅读本 HANDOFF；
- 复核代码和现场事实；
- 用人话指出方案漏洞、遗漏和不合理假设；
- 输出修订版架构；
- 用户明确批准前不写代码。

### 阶段 B：先完成 EvalOS 共用合同

- Candidate 签名 HTTPS 合同；
- 两套独立公钥与角色映射；
- nonce/时间戳防重放；
- health/observe 权限隔离；
- readiness admission；
- 完整测试，但不连接 Twin、不启动 Trial。

### 阶段 C：重建 LangGraph 外围

- 删除旧发布主链；
- 建立 Infra/App/Bridge 边界；
- Worker readiness；
- 零写入 preflight；
- 单一路径部署和回滚；
- 本地真实 Docker 演练；
- 云端一次性 breaking cutover。

### 阶段 D：Agent+Harness 定向收口

- Candidate 永久签名身份；
- 周期 readiness；
- UID/GID 单一事实；
- Bridge 脱离 API inspect；
- 轻量应用部署入口；
- 不重写 Agent 主链。

### 阶段 E：EvalOS 只读验收

- 两产品 source revision/image digest 无漂移；
- 三角色和管理身份互相隔离；
- Candidate readiness fresh；
- 网关断开时产品核心仍 live；
- host reboot 后不需要扫码；
- Adapter 5 discovery 通过；
- active=0、queued=0、production writes=false；
- 仍不启动 Trial。

### 阶段 F：等待用户批准 Trial

建议顺序：

1. 每个产品先 1 个非计分资格 Trial；
2. 审查完整日志、报告正文、隐藏答案和 Grader；
3. 确认无无效循环、证据缺口和环境问题；
4. 再各做第 2 个验证可重复性；
5. 未建立真实资源分布前，不启动容量 Trial 或 480 Trial。

---

## 11. 验收标准

### 11.1 服务器与发布

- 主机重启后无需浏览器/OAuth，服务自动恢复；
- App 部署不会重建数据库或 Redis；
- Bridge 不因 App 容器改名而失效；
- 部署与回滚各只有一个命令入口；
- 新镜像失败能切回 last-known-good；
- 两个产品互相不能访问对方目录、Compose project、Secret 和 unit；
- 不存在 active/not-found 的产品 runtime unit；
- 活动源码中不存在旧部署第二路径。

### 11.2 Candidate Observation

- 私钥只在对应产品安全存储；
- EvalOS 只保存公钥；
- 重放、错误 candidate_ref、错误 key、过期时间戳全部拒绝；
- health 不需要 Trial，也不返回 Twin 数据；
- observe 缺 Trial、lease 或任一 Scope 均拒绝；
- 跨 Trial、跨 namespace 拒绝；
- Gateway 故障只令 Candidate blocked，不重启产品；
- readiness 超时自动失效；
- 日志不含 Token、私钥、Authorization、Case、Seed、Grader 或答案。

### 11.3 Agent 与评测

- Agent+Harness 仍是开放单 Agent；
- LangGraph 调查核心不因外围重构改变；
- EvalOS 不代考、不伪造证据；
- 资源限制仍只是高位安全熔断；
- production write=false；
- 未经批准没有 Trial/Twin 操作。

---

## 12. 已知风险与诚实限制

| 风险 | 处理方式 |
|---|---|
| 两产品仍共用一台 ECS，整机故障会同时影响两者 | 开发阶段接受；通过目录、账号、Compose project、网络和 Secret 隔离降低误操作，正式商用再拆主机 |
| 永久机器私钥被盗 | 独立最小权限密钥、只允许 health/observe、请求签名、防重放、可人工吊销；不复用管理或 Relay key |
| Redis 故障导致 readiness 丢失 | fail-closed 为 blocked；Redis 恢复后后台 health 自动重建状态 |
| 发布瞬间主机断电 | Docker 按最后成功创建的容器恢复；运行一次简单 status/reconcile，不建设跨系统事务引擎 |
| 接受 10–30 秒维护窗口 | 开发阶段合理，换取大幅降低发布复杂度 |
| 当前不建设镜像仓库/CI | 激活输入仍是不可变 digest；未来改为 CI/ACR 时不改变部署合同 |
| Breaking change 删除旧兼容路径 | Git 历史保留审计；云端只保留 last-known-good 镜像，不把旧代码留在活动主链 |

---

## 13. 工期估计

这是三套系统的联合外围改造，不能再承诺“马上半小时完成”。合理估计：

| 工作 | 预计时间 |
|---|---:|
| 会话3复核、修订与用户审核 | 1–2 小时 |
| EvalOS 签名 Candidate Gateway 与 admission | 2–4 小时 |
| LangGraph 删除旧主链、重建与真实 Docker 演练 | 5–7 小时 |
| Agent+Harness 定向收口 | 3–5 小时 |
| 云端切换、回滚演练、双产品只读 discovery | 2–3 小时 |
| 总计 | 约 13–21 小时专注工作，通常为 1–2 个工作日 |

这只是达到“可以申请启动非计分资格 Trial”的条件，不包括 Trial 自身运行和结果审查时间。

---

## 14. 会话3必须先回答的审核问题

会话3不得直接开工，必须先给用户一份不带代码细节的审核意见，逐项回答：

1. 是否同意接受 10–30 秒维护窗口，换取删除复杂状态机？
2. 是否同意两产品开发阶段继续共用 ECS，但严格隔离？
3. 签名 HTTPS 是否确实比当前 Bearer + SSH 双协议更简单、安全？
4. EvalOS、LangGraph、Agent+Harness 的责任边界是否还有重叠？
5. 哪些旧组件必须删除，是否还有遗漏？
6. 哪些方案看似简单但可能造成新技术债？
7. 数据库迁移和断电场景是否已经诚实处理？
8. 是否存在产品经理不容易发现的安全漏洞？
9. 实施顺序能否保证任何时点都不影响现有可用旧服务？
10. 是否能用更少组件实现同样目标？

只有用户在会话3明确表示方案通过，才能把方案拆成可执行任务并开始编码。

---

## 15. 给会话3的工作纪律

- 先完整阅读本文件、项目根目录 AGENTS.md、现有长期记忆和最新 Git 状态；
- 不因为旧文档写了“已完成”就相信动态云端状态；
- 不把计划说成实现；
- 不为了让门禁变绿而增加兼容分支；
- 不新增窗口；
- 不读取或泄露秘密；
- 不连接/prepare/reset Twin；
- 不创建调查或 Trial；
- 不改 Case、Seed、Grader、隐藏答案或历史 Trial；
- 先用人话审核方案，指出问题，不迎合用户或沿用旧结论；
- 用户批准后，实施过程中每个阶段都要给出可验证结果、未完成项和副作用。
