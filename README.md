# OpsMind Agentic EvalOS

## M2.6 评测操作与可理解性工作台

M2.6 在 M2.5 动态评测与 AI 调查工作台之上，补齐了面向操作者的术语解释、机器日志翻译、Case 单选/多选、单个/批量重新评测、异步任务中心、运行前检查、逐 Case 新旧结果对比与只追加重新评分。页面以中文为主、英文术语辅助；原始机器事件、Trial、官方成绩与冻结证据均不被覆盖。

- 云端工作台：`http://121.40.223.202`
- 人工评测操作：支持从数据集、实验和 Trial 发起；每次都创建新实验和新 Trial
- 仅重新评分：只重算冻结证据，结果单独追加，绝不改写原官方分数
- 正式口径隔离：快速验证与定向回归只用于诊断，不进入正式排行榜
- 正式评分：只来自确定性 Code Grader；工具名和固定调用顺序不计分
- AI 调查：诊断与改进权，不拥有评分权
- M2.5 云端证据：2 个真实 M2 实验、7 个已完成 Trial、864 条轨迹、7 份确定性评分、3 份成功的真实 Claude Agent SDK + DeepSeek 调查
- 跨架构覆盖：Agent+Harness 与 LangGraph 外部参评 Trial 均已成功分析
- 权威网络研究：实际抓取并哈希 OpenTelemetry、Arize Phoenix 页面；手写 URL 不算抓取证据
- 下一阶段：M3 正式独立盲测和 A/B 统计比较

OpsMind Agentic EvalOS 是面向 Agent 时代的智能运维评测与改进操作系统。它不把 Agent 当作“生成一段答案的模型”，而是测量完整的任务结果、执行轨迹、环境终态、安全行为和多次运行可靠性。

## 当前状态

- **M2 协议级数字孪生：已正式收口。** 协议孪生考场、通用变更执行器、Claude Agent SDK 核心 Agent 端到端、双架构适配资格四道不可补偿门禁全部通过；M2 只证明考场和接入可信，不产生两套 OpsMind 的排名。
- **云端验收界面：已开放。** `http://121.40.223.202`，仅允许当前操作员公网 IP 的 `/32` 白名单访问；控制 API 继续只监听服务器本机，不直接暴露公网。
- **M1.5 正式验收：已通过。** 新内核已完成自动化测试、架构检查、安全扫描、12 条隔离 Test Double Trial 和独立完整性审计。
- **正式 L1 v2 Pilot：已完成。** 90/90 条真实 DeepSeek Trial 完成，失败和重试均为 0；45 对配对比较中 V2 平均领先 13.45 分，按 Case 聚类的 95% 区间为 `[5.21, 22.77]`。
- **专家盲审：可选。** 专家功能保留为证据增强层；没有专家不阻塞 M1.5、正式 Pilot 或排名。专家结论与三路模型 Judge 都不能改写确定性 Code Grader 的官方分数。
- **历史 M1：只读证据。** 72 条真实 DeepSeek Trial 保留用于审计早期趋势，但旧 L1 v1 工具结果含 `signals.component/confidence` 合成提示，不能替代无提示 L1 v2 的正式结果。

## 架构原则

- 被测 V2 和 EvalOS Lead Agent 均以 `@anthropic-ai/claude-agent-sdk` 为核心，通过 DeepSeek Anthropic 兼容端点运行 `deepseek-v4-flash`。
- V2 保留 Bash、Read、Write、Edit、代码执行、MCP、Skills 和按需工具发现；模型自主决定假设、工具、恢复策略和停止时机。
- Eval Harness 只固定不可协商的考场条件：数据版本、环境种子、重复次数、盲态身份、隔离、预算、安全策略、评分器和不可变账本。
- EvalOS 与 V2 内核不使用 LangGraph、LangChain、静态状态图或固定工具顺序。LangGraph 仅作为被测的历史 V1 外部对照。
- 私有参考标签位于独立数据库；执行面、公开 API、控制台和参评 Agent 均不能读取。
- 确定性 Code Grader 是唯一官方评分来源；Outcome、Evidence、Trajectory 三路模型 Judge 只生成辅助诊断和注意信号。

## 数据与正式 Pilot

- L0：2 个确定性 Test Double Case，仅验证平台内核。
- L1 v2：15 个无答案式 `signals` 提示的状态化仿真 Case，包括 12 个诊断/开放世界 Case、2 个安全对抗 Case和 1 个主动发现 Case。
- 正式清单模板：15 Case × 2 架构 × 3 次独立重复 = 90 Trial。
- L1 v2 仍属于状态化仿真；M2 已在独立 Twin ECS 上使用 Open5GS 2.8.0、MongoDB 8.0.29 和 UERANSIM 3.2.7 建成协议级数字孪生考场，但仍不是生产网元。
- L1 v2 合成仿真基准排名只描述当时的仿真表现，不能外推为真实生产网络能力。M2 不排名；下一阶段是 M3 正式独立盲测与 A/B 统计比较。

## 本地验收

要求 Node.js 24 或更高版本。

```text
npm run m2:verify
```

该命令依次执行内核/API 测试、Claude Agent SDK 适配检查、禁用图工作流检查、密钥扫描、M2 技术验收、控制台检查与构建。云端公开验收证据已归档到 `artifacts/m2-final/`。

启动界面与 API：

```text
npm run api
npm run console:dev
```

API 默认监听 `http://127.0.0.1:8787`，控制台默认监听 `http://127.0.0.1:3000`。任何写操作都要求先设置 `EVALOS_API_TOKEN`；DeepSeek 凭据只能通过环境变量提供。

## 中文交付材料

- [M1.5 Agent 时代评测架构](docs/M1.5_测量系统加固架构.md)
- [M1.5 验收矩阵](docs/M1.5_验收矩阵.md)
- [可选专家盲审操作手册](docs/M1.5_专家盲审与Judge校准操作手册.md)
- [正式 L1 v2 Pilot 清单模板](config/m15-pilot.manifest.json)
- [最新自动验收报告](artifacts/m15/M1.5测量系统加固验收报告.md)
- [M1.5 L1 v2 正式 Pilot 收口报告](docs/M1.5_L1_v2正式Pilot收口报告.md)
- [M2 协议级数字孪生架构与验收说明](docs/M2_协议级数字孪生架构与验收说明.md)
- [M2 正式收口报告](artifacts/m2-final/m2-closure/m2-final-closure-report.zh-CN.md)
- [M2 正式收口机器结论](artifacts/m2-final/m2-closure/m2-final-closure-result.json)
- [M2.5 动态评测与 AI 调查工作台架构及验收说明](docs/M2.5_动态评测与AI调查工作台架构及验收说明.md)
- [M2.5 云端验收报告](artifacts/m25-final/M2.5云端验收报告.md)
- [M2.5 云端验收机器结论](artifacts/m25-final/M2.5云端验收结论.json)
- [M2.5 界面交互验收报告](artifacts/m25-final/M2.5界面交互验收报告.md)
- [M2.5 界面交互机器结论](artifacts/m25-final/M2.5界面交互验收结论.json)
- [M2.6 评测操作与可理解性改造及验收说明](docs/M2.6_评测操作与可理解性改造及验收说明.md)

## 参考方法

- Anthropic：<https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents>
- Hamel Husain：<https://hamel.dev/blog/posts/evals-faq/>
- Arize Phoenix：<https://arize.com/docs/phoenix/tracing/how-to-tracing/instrumentation>
- Claude Agent SDK：<https://code.claude.com/docs/en/agent-sdk/overview>
