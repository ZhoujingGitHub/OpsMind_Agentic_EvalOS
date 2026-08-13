# M1 技术架构

## 架构决策

运行时采用强大编码 Agent 常见的高层控制模式：持久会话接收目标和可用工具，模型自主选择下一步行动，环境在受约束边界内执行该行动，并把结果追加回上下文；模型据此继续判断，直到能够给出最终结果。系统不使用静态状态图，也不预先规定工具调用顺序。

```mermaid
flowchart LR
  Goal["目标与可见证据"] --> Model["DeepSeek V4 Flash<br/>通过 Claude Agent SDK 调用"]
  Model -->|"模型自主选择工具调用"| Policy["策略与预算门禁"]
  Policy --> Sandbox["Trial 独立命名空间"]
  Sandbox --> MCP["运维 MCP 工具"]
  MCP --> Observation["脱敏后的工具结果"]
  Observation --> Model
  Model -->|"最终结论"| Grader["确定性评分器"]
  Grader --> Ledger["只追加哈希链账本"]
```

生产环境使用 Claude Agent SDK 作为 Agent 运行框架。DeepSeek V4 提供 Anthropic 兼容接口，因此 Claude Agent SDK 负责会话、工具和上下文管理，DeepSeek V4 Flash 负责模型推理。领域能力以进程内 MCP 工具和 Skills 的形式提供。确定性重放模型实现相同的行动协议，只用于无需密钥、结果可复现的 M1 测试。

## 信任边界

模型可以决定：

- 生成和修正假设；
- 调用哪个已授权的 MCP 工具，以及提交哪些通过校验的参数；
- 当前证据是否足以停止；
- 叙述性结论和结构化候选结果。

确定性内核负责决定：

- 冻结后的实验清单与配置哈希；
- 盲测身份映射和基于种子的 A/B 顺序；
- Trial 队列、租约、重启恢复、幂等与命名空间；
- 允许调用的工具、审批级别、预算、脱敏和产物哈希；
- 代码评分、Ledger 追加、重放对比和 G1 判定。

## M1 范围约束

- G1 工程门禁继续使用两个带版本的 L0 冒烟夹具和两个模拟参评适配器；它只证明可信内核，不冒充真实模型评测。
- 真实 M1 Pilot 使用 12 个冻结 L1 Case、两个真实参评适配器和 3 个 Seed，共 72 个付费模型 Trial。V2 是 Claude Agent SDK + DeepSeek V4 Flash；V1 是实际 LangGraph StateGraph + 同一 DeepSeek V4 Flash。
- Claude Agent SDK V2 保留 Bash、Read、Write、Edit、代码执行、Skill、MCP 等原生能力；写操作受 Trial 命名空间、预算和策略门禁约束。V2 不包含 LangGraph、静态状态图或固定工具顺序。
- LangGraph 仅存在于被评的历史 V1 对照实现和它的评测适配器中，不进入 V2 核心 Agent 运行时。
- 真实 Pilot 之后由独立盲评 Judge 复核最终 Outcome，并生成可追加人工决定的复核队列。Judge 不接收架构身份。
- DeepSeek 凭据仅由部署环境变量提供，不进入代码、Trace、快照或交付材料。
- SQLite 是 M1 可执行的本地数据存储；同时提供等价的 MySQL 迁移约定，供 ECS 部署使用。M1 的队列与租约抽象在 SQLite 中具备持久性，后续可以替换为 Redis，且无需改变 Runner 语义。

## 参考架构对齐

- Claude Agent SDK 提供自主循环、会话、内置安全边界、MCP、权限和上下文管理。
- DeepSeek V4 Flash 通过 `https://api.deepseek.com/anthropic` 的 Anthropic 兼容接口提供模型与工具调用能力。
- 架构吸收了 Codex 的关键边界设计：可恢复会话、显式工具、工作区隔离、审批与策略检查、受限资源、完整事件轨迹，以及可重放证据。
