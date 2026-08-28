# OpsMind M2 协议级数字孪生运行时

该目录是 M2 Twin-T1 的确定性“考场控制器”，不是被测 Agent 的诊断工作流。

- Agent 仍由 Claude Agent SDK + DeepSeek 的模型循环自主选择假设、MCP、Skill 和停止时间。
- 控制器只负责冻结版本、准备场景、隔离 Trial、故障注入、只读观测、PCAP 和确定性重置。
- 调用方只能提交经过校验的 `health/prepare/observe/snapshot/reset` 请求，不能提交 shell、路径、服务名或任意网络规则。
- `evalos-twin` 用户只有执行 `/usr/local/sbin/opsmind-twinctl` 的 sudo 权限。
- Trial 证据目录不在 reset 中删除，便于形成 append-only 证据链。
- 真实候选产品的 `runtime_state/service_health/sandboxed_readonly_diagnostic` 通过
  `opsmind-candidate-observation-gateway/1.0` 访问。它复用同一个独占 Trial 租约，
  严格绑定上下文摘要和四元资源 Scope，不接受任意 shell、路径、主机、端口或服务名。
- Agent+Harness 使用 EvalOS HTTPS 短期身份入口；LangGraph 使用独立 SSH
  forced-command 短期身份。两条入口落到同一 Twin 只读后端，管理身份不会下发给考生。
- LangGraph 只把公开 Ed25519 公钥交给 EvalOS；`candidate_authorize` 仅在没有活动 Trial
  时原子安装最长 24 小时的 forced-command 授权。私钥始终留在产品安全存储中。

组件版本、官方来源和 UERANSIM 源码哈希记录在 `stack.manifest.json`。
