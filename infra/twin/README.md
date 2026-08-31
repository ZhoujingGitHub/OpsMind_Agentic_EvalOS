# OpsMind M2 协议级数字孪生运行时

该目录是 M2 Twin-T1 的确定性“考场控制器”，不是被测 Agent 的诊断工作流。

- Agent 仍由 Claude Agent SDK + DeepSeek 的模型循环自主选择假设、MCP、Skill 和停止时间。
- 控制器只负责冻结版本、准备场景、隔离 Trial、故障注入、只读观测、PCAP 和确定性重置。
- 调用方只能提交经过校验的 `health/prepare/observe/snapshot/reset` 请求，不能提交 shell、路径、服务名或任意网络规则。
- `evalos-twin` 用户只有执行 `/usr/local/sbin/opsmind-twinctl` 的 sudo 权限。
- Trial 证据目录不在 reset 中删除，便于形成 append-only 证据链。
- 整个物理实验室只认 `/srv/opsmind-twin/physical-lease.json` 这一份租约。LangGraph、Agent+Harness
  和 EvalOS 都只能引用它，不能各自生成第二份租约。
- 租约持久化记录使用模式、候选产品、EvalOS Trial、内部 Trial、唯一 lease、到期时间和主机
  boot_id。主机重启、租约过期、文件损坏或首次从旧版升级都会进入 `quarantined`；管理员必须执行
  固定的 `recover` 请求，完成确定性基线复位后才能重新变为 `idle`。
- 两套真实候选产品始终使用各自原生的协议实验室 MCP 身份调查；EvalOS 不代理工具调用，
  也不把考务管理身份借给候选产品。
- EvalOS 的考务管理器只有 `status/prepare/snapshot/reset` 四个操作。它准备独占物理租约后，
  只把公开租约编号交给运行面核对，不提供候选 SSH 授权、远程观察或远程健康监督入口。
- 两套产品每 60 秒向 EvalOS HTTPS 入口发送独立 Ed25519 签名的短时状态。状态只保存在
  EvalOS 内存 180 秒，说明产品身份、版本、就绪状态及当前 Trial/租约绑定；不包含调查证据、
  Case、Seed、答案、凭据或修复权限。

组件版本、官方来源和 UERANSIM 源码哈希记录在 `stack.manifest.json`。
