# M1 Trace 轨迹样例（中文解读）

> 本文档是 `trace-sample.json` 的中文可读版。原始 JSON 保留完整事件载荷，本文档用于快速验收。

- Trial 编号：`trial_bb0d68ef5028e30c5a05`
- 事件总数：15
- 已脱敏事件数：1

| 序号 | 事件 | 执行方 | 时间 | 是否脱敏 | 中文摘要 |
|---:|---|---|---|---:|---|
| 1 | Trial 已启动（`trial.started`） | runner | 2026-08-13T03:09:49.143Z | 否 | 用例 SMOKE-RCA-001，种子 303，盲测身份 candidate-cobalt |
| 2 | Runner 心跳（`runner.heartbeat`） | runner | 2026-08-13T03:09:49.144Z | 否 | 心跳间隔 5000 毫秒 |
| 3 | 环境快照（`environment.snapshot`） | kernel | 2026-08-13T03:09:49.145Z | 是 | 已记录独立命名空间，敏感配置已脱敏 |
| 4 | 模型决策（`model.decision`） | contestant | 2026-08-13T03:09:49.146Z | 否 | 模型自主选择工具 get_alerts |
| 5 | 工具调用（`tool.call`） | contestant | 2026-08-13T03:09:49.147Z | 否 | 调用 get_alerts |
| 6 | 工具结果（`tool.result`） | environment | 2026-08-13T03:09:49.149Z | 否 | get_alerts 返回成功 |
| 7 | 模型决策（`model.decision`） | contestant | 2026-08-13T03:09:49.150Z | 否 | 模型自主选择工具 query_metrics |
| 8 | 工具调用（`tool.call`） | contestant | 2026-08-13T03:09:49.151Z | 否 | 调用 query_metrics |
| 9 | 工具结果（`tool.result`） | environment | 2026-08-13T03:09:49.153Z | 否 | query_metrics 返回成功 |
| 10 | 模型决策（`model.decision`） | contestant | 2026-08-13T03:09:49.155Z | 否 | 模型自主选择工具 query_logs |
| 11 | 工具调用（`tool.call`） | contestant | 2026-08-13T03:09:49.156Z | 否 | 调用 query_logs |
| 12 | 工具结果（`tool.result`） | environment | 2026-08-13T03:09:49.157Z | 否 | query_logs 返回成功 |
| 13 | 模型决策（`model.decision`） | contestant | 2026-08-13T03:09:49.159Z | 否 | 模型判断证据已充分，准备输出最终结论 |
| 14 | 评分结果（`grader.result`） | code-grader | 2026-08-13T03:09:49.160Z | 否 | 确定性评分 100 分，通过 |
| 15 | Trial 已完成（`trial.completed`） | runner | 2026-08-13T03:09:49.161Z | 否 | Trial 状态 COMPLETED，得分 100 |
