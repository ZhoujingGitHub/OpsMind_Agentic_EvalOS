# OpsMind Agentic EvalOS engineering rules

- The agent runtime is a model-driven perceive/reason/tool/observe loop. Do not introduce LangGraph, a static state graph, or a hard-coded node workflow.
- Production model execution uses Claude Agent SDK with DeepSeek V4 Flash through DeepSeek's Anthropic-compatible endpoint.
- The model may choose hypotheses, tools, and stopping time. It may not choose seeds, budgets, isolation, safety gates, blind identities, graders, or ledger contents.
- Deterministic replay brains are test doubles only. Reports must label them as simulations and never present them as paid model calls.
- Every Trial must have an isolated namespace, append-only trace, budget accounting, immutable ledger record, and deterministic code grade.
- Secrets are supplied only through environment variables and must never be written to source, traces, snapshots, or artifacts.

