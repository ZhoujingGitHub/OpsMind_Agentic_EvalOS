# OpsMind Agentic EvalOS

OpsMind Agentic EvalOS is an independent evaluation control plane for fair, reproducible, explainable comparison of operations agents. M1 delivers the trusted evaluation kernel, a Codex-style autonomous Agent Harness, the DeepSeek/Claude Agent SDK integration seam, a control API, a minimal Web Console, and an automated G1 acceptance suite.

## M1 architecture

- `packages/kernel`: deterministic manifest freeze, blind identity mapping, seeded scheduling, budgets, Trial isolation, Trace, code grader, and hash-chained append-only Ledger.
- `packages/agent-runtime`: a model-driven tool loop. The harness does not encode a graph or a tool sequence. A live adapter uses Claude Agent SDK with DeepSeek V4 Flash; a deterministic replay brain is used only for offline M1 acceptance.
- `services/control-api`: experiment, Trial, Trace/SSE, Ledger, and acceptance endpoints.
- `apps/console`: M1 experiment and Trace console.
- `scripts/run-m1-acceptance.mjs`: creates and completes 2 smoke cases x 2 mock contestants x 3 seeds = 12 Trials, replays 2 Trials, and writes the G1 evidence bundle.

## Run locally

Prerequisite: Node.js 24 or newer.

```text
npm test
npm run adapter:check
npm run console:build
npm run api
```

The API listens on `http://127.0.0.1:8787` by default. For a version-bound acceptance run, set `M1_RUN_ID` to the frozen Git commit and run `npm run accept:m1`; evidence is written to `artifacts/m1/` and the runtime database to `runtime/m1/evalos.sqlite`.

## Live DeepSeek execution

Install the locked dependencies in `packages/agent-runtime`, then provide secrets only at runtime:

```text
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=<DeepSeek API key>
ANTHROPIC_MODEL=deepseek-v4-flash
```

`DEEPSEEK_API_KEY` is also accepted and is mapped in memory to `ANTHROPIC_AUTH_TOKEN`. No secret is persisted. M1 acceptance deliberately uses the replay model because an external API key is not a prerequisite for validating the trusted kernel.

## G1 definition

G1 passes only when all 12 smoke Trials complete, at least 10% are replayed deterministically, Runner recovery/idempotency/isolation pass, blind/random/budget/Ledger controls are verifiable, Trace first event is under 2 seconds, heartbeat policy is at most 10 seconds, and secret redaction passes.
