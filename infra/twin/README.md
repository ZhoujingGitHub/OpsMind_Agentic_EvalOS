# OpsMind M2 协议级数字孪生运行时

该目录是 M2 Twin-T1 的确定性“考场控制器”，不是被测 Agent 的诊断工作流。

- Agent 仍由 Claude Agent SDK + DeepSeek 的模型循环自主选择假设、MCP、Skill 和停止时间。
- 控制器只负责冻结版本、准备场景、隔离 Trial、故障注入、只读观测、PCAP 和确定性重置。
- 调用方只能提交经过校验的 `health/prepare/observe/snapshot/reset` 请求，不能提交 shell、路径、服务名或任意网络规则。
- `evalos-twin` 用户只有执行 `/usr/local/sbin/opsmind-twinctl` 的 sudo 权限。
- Trial 证据目录不在 reset 中删除，便于形成 append-only 证据链。

组件版本、官方来源和 UERANSIM 源码哈希记录在 `stack.manifest.json`。
