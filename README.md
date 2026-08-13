# OpsMind Agentic EvalOS

OpsMind Agentic EvalOS 是一个独立的智能运维 Agent 评测控制平台，用于公平、可复现、可解释地比较不同运维 Agent。M1 已交付可信评测内核、Codex 风格的自主 Agent 运行框架、DeepSeek 与 Claude Agent SDK 的集成接口、控制 API、最小可用 Web 控制台，以及自动化 G1 验收套件。

## M1 架构

- `packages/kernel`：负责清单冻结、盲测身份映射、基于种子的调度、预算控制、Trial 隔离、Trace、代码评分，以及带哈希链的只追加 Ledger。
- `packages/agent-runtime`：采用模型驱动的工具循环。运行框架不编码固定图结构或工具调用顺序；生产适配器使用 Claude Agent SDK 接入 DeepSeek V4 Flash，确定性重放模型仅用于离线 M1 验收。
- `services/control-api`：提供实验、Trial、Trace/SSE、Ledger 和验收结果接口。
- `apps/console`：提供 M1 实验与 Trace 查看控制台。
- `scripts/run-m1-acceptance.mjs`：运行 2 个冒烟用例 × 2 个模拟参评 Agent × 3 个随机种子，共 12 个 Trial；另重放 2 个 Trial，并生成 G1 验收证据包。

## 本地运行

前置条件：Node.js 24 或更高版本。

```text
npm test
npm run adapter:check
npm run console:build
npm run api
```

API 默认监听 `http://127.0.0.1:8787`。如需执行与代码版本绑定的验收，请先将 `M1_RUN_ID` 设置为冻结后的 Git 提交号，再运行 `npm run accept:m1`。验收证据写入 `artifacts/m1/`，运行数据库写入 `runtime/m1/evalos.sqlite`。

## 使用 DeepSeek 实际执行

先在 `packages/agent-runtime` 中安装锁定版本的依赖，然后只在运行时提供密钥：

```text
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=<DeepSeek API 密钥>
ANTHROPIC_MODEL=deepseek-v4-flash
```

也可以提供 `DEEPSEEK_API_KEY`，运行时会在内存中将其映射为 `ANTHROPIC_AUTH_TOKEN`。任何密钥都不会被持久化。M1 验收特意使用确定性重放模型，因为可信内核的验收不应依赖外部 API 密钥。

## G1 通过标准

只有在以下条件全部满足时，G1 才算通过：12 个冒烟 Trial 全部完成；至少 10% 的 Trial 完成确定性重放；Runner 恢复、幂等、隔离、盲测、随机顺序、预算与 Ledger 控制均可验证；首条 Trace 事件在 2 秒内产生；心跳间隔不超过 10 秒；敏感信息脱敏检查通过。

## 中文交付材料

- [M1 技术架构](docs/M1_ARCHITECTURE.md)
- [M1 / G1 验收报告](artifacts/m1/M1_G1验收报告.md)
- [M1 交付材料索引](artifacts/m1/交付材料索引.md)
