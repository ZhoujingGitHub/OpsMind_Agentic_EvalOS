# OpsMind Agentic EvalOS 资格 Trial 前置交接（2026-08-29）

## 当前结论

EvalOS 与两套最新版 OpsMind 的 Adapter 5 公开合同已重新冻结并完成部署后只读重发现；两套候选均为 `drift=[]`。EvalOS、账本、任务队列、Trial 队列和共享 Twin 清场状态健康，但 **候选专用 Twin 观察入口尚未启用**，因此不得启动 Canary、资格 Trial、容量 Trial或正式 480 Trial。

这不是候选源码漂移，也不是预算问题。实时验证表明 Twin 主机仍运行旧受限控制器，新的 `candidate_health` 命令被旧 SSH 网关拒绝。升级 Twin 控制器需要第一账号管理员通道；当前保存的 `opsmind-main` 只是已过期的 STS 会话，不能自动刷新，也不能由第二账号越权替代。

## 已完成且已冻结

- EvalOS Git 提交：`a80926e`（仅更新两套候选的可信部署身份、公开运行合同与资源合同来源）。
- EvalOS 云端发布：`m31-20260829-036997b105`。
- 发布包 SHA-256：`e3e1054bc868bfe3a8aea29e18570f924e9052cb53442efd6afc22c4cc1ab5b7`。
- 云端 API、控制台和 Nginx 均为 active；`/health` 返回 200。
- 账本有效：271723 条，错误为 0，部署后头哈希为 `565e35bd12ab310311c5a7785b4eb8d2434516d0dbbe230841c90bb5ecb2ff62`。
- 无排队/运行中的请求，无运行中的 Trial，无过期租约，无未解决清场。
- 正式 480 开关继续关闭：`480_TRIAL_NOT_AUTHORIZED`。
- Twin 当前没有 active Trial、没有租约，两套独占槽位均可用。
- 磁盘扩容后为约 99 GiB，总体使用 46 GiB、可用 49 GiB；当前发布和两份 2026-08-29 回滚备份均完整保留。

## 两套最新版候选

### Agent+Harness OpsMind

- source revision：`e9e298c7d719c33244c34246a86d6b70e02590a8`
- image digest：`sha256:3a02938427b5263144e99298ebf4558519ff35c432e08681a91749c2567aa80c`
- service：2.7.2
- Adapter 5 只读发现：`ready=true`、`drift=[]`
- 架构保持官方有状态 ClaudeSDKClient + DeepSeek V4 Flash Thinking high + MCP + Skill + ToolSearch + SDK 原生工具的开放式单 Agent。
- 当前候选观察状态：`binding_status=blocked`，原因是外部候选观察网关尚未启用；不是候选调查能力假通过。

### LangGraph OpsMind

- source revision：`f827428cc0aeb40a8d5b185c99a8838b1375e40d`
- image digest：`sha256:fa6d87776a45f037008f2f937bf78e6e2f1bd0fd36ba586cf611cb47387a1c8c`
- MCP 合同：`observation+protocol-lab:3.4.0`
- Adapter 5 只读发现：`ready=true`、`drift=[]`
- 双模型合同保持 DeepSeek V4 Flash + DeepSeek V4 Pro。
- 当前候选观察状态：`binding_status=disabled`，协议实验室 Connector 未安装独立候选身份；不能冒充 ready。

## 下一次恢复后的严格顺序

1. 恢复第一账号管理员通道。若仍需从当前执行出口 SSH，按用户已明确批准的边界，仅为 Twin 实例 `i-bp19u0lim79nhh4y7fkg` 临时增加 `18.181.224.99/32 -> TCP 22`，完成安装后立即删除；不得扩大来源网段。
2. 以 root 在 Twin 主机部署仓库当前 `infra/twin/install-controller.sh` 及其受限候选观察组件，不改 Twin 场景、Case、Seed、旧 Trial 或旧证据。
3. 用 EvalOS 最小权限身份只读验证两套 `candidate_health`：必须同时满足 candidate-scoped Trial、只读、审计、Scope 隔离、非管理身份、非 root、无隐藏评测数据暴露。
4. 为 Agent+Harness 轮换独立 HTTPS 短期候选观察身份；为 LangGraph 安装其产品侧生成的独立 Ed25519 公钥 forced-command 短期身份。私钥留在产品安全存储，Token/私钥不回传聊天或日志。
5. 两套产品分别从自身公开 readiness 真实校验远端观察入口；EvalOS 再次只读核验 candidate readiness。任何一项不是 `ready=true` 都不得开考。
6. 先串行执行 2 个非计分 Canary（每套 1 个）。每个 Trial 均独立 prepare、运行、终态 snapshot、EvalOS reset，并且必须确认 `ok=true && clean=true` 后才释放考场。
7. 两个 Canary 均通过后，按已确认设计串行完成 16 个非计分资格 Trial（Agent+Harness 8 个、LangGraph 8 个）。两套产品不得共享 Trial、身份、轨迹或结果。
8. 本轮不启动容量 Trial，不启动正式 480 Trial。

## 禁止事项

- 不得为了赶进度绕过候选观察门禁或让 EvalOS 替考生调用 Twin 内部工具。
- 不得把本地 Bash 伪装成远程 Twin 观察；Bash 保留为候选原生开放工具，但远程权限必须来自受控候选观察入口。
- 不得修改两套 OpsMind 源码。
- 不得泄露隐藏 Case、答案、Seed、Grader 私有合同、安全载荷或任何凭据。
- 不得删除或覆盖历史 Trial、成绩、轨迹、账本与不可变档案。
