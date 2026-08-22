// Engineering-only deterministic test double. This file is never registered
// in a REAL_CANDIDATE evaluation lane and must never be described as OpsMind.
function unique(values) {
  return [...new Set(values)];
}

class EvidenceSeekingReplayBrain {
  constructor(style) {
    this.style = style;
  }

  decide({ caseSpec, observations, attemptedTools }) {
    const successes = observations.filter((item) => item.result.ok);
    const evidenceRefs = unique(successes.flatMap((item) => item.result.data?.evidence_refs ?? []));
    const sources = unique(evidenceRefs.map((ref) => ref.split(":")[0]));
    const minimumSources = caseSpec.visible.success_criteria.minimum_evidence_sources ?? 3;
    const hasFailure = observations.some((item) => !item.result.ok);
    const recovered = !hasFailure || observations.some((item, index) =>
      !item.result.ok && observations.slice(index + 1).some((later) => later.result.ok),
    );

    if (sources.length >= minimumSources && recovered) {
      const signals = successes.flatMap((item) => item.result.data?.signals ?? []);
      const confidenceByComponent = new Map();
      for (const signal of signals) {
        const score = Number(signal.confidence ?? 0) * (signal.exclusion ? -0.25 : 1);
        confidenceByComponent.set(signal.component, (confidenceByComponent.get(signal.component) ?? 0) + score);
      }
      const [rootCause, aggregateConfidence] = [...confidenceByComponent.entries()].sort((a, b) => b[1] - a[1])[0];
      const exclusions = signals.filter((signal) => signal.exclusion).map((signal) => signal.component);
      return {
        type: "final",
        rationale: "Evidence spans the required independent sources and supports a stable causal hypothesis.",
        outcome: {
          status: "resolved",
          root_cause: rootCause,
          confidence: Number(Math.min(0.99, aggregateConfidence / Math.max(1, signals.length / 2)).toFixed(2)),
          evidence_refs: evidenceRefs,
          exclusions: unique(exclusions),
          tool_failures_recovered: observations.filter((item) => !item.result.ok).map((item) => item.tool),
          next_checks: ["Verify the proposed root cause after remediation", "Retain the evidence window for regression replay"],
          summary: `The strongest evidence points to ${rootCause}.`,
        },
      };
    }

    const candidates = Object.entries(caseSpec.tools)
      .filter(([name]) => !attemptedTools.has(name))
      .map(([name, definition]) => ({
        name,
        informationGain:
          (name === "get_alerts" && observations.length === 0 ? 100 : 0) +
          (name === "query_logs" ? (this.style === "context-first" ? 40 : 32) : 0) +
          (name === "query_metrics" ? (this.style === "metric-first" ? 42 : 35) : 0) +
          (name === "run_probe" ? (hasFailure ? 80 : 25) : 0) +
          (definition.result?.evidence_refs?.length ?? 0),
      }))
      .sort((a, b) => b.informationGain - a.informationGain || a.name.localeCompare(b.name));

    if (!candidates.length) {
      return {
        type: "final",
        rationale: "No untried safe tools remain; return a bounded uncertain outcome.",
        outcome: {
          status: "inconclusive",
          root_cause: "unknown",
          confidence: 0.2,
          evidence_refs: evidenceRefs,
          exclusions: [],
          next_checks: ["Escalate for human review"],
          summary: "Available evidence is insufficient.",
        },
      };
    }
    const selected = candidates[0];
    return {
      type: "tool",
      name: selected.name,
      args: { tenant: caseSpec.visible.tenant, time_window: caseSpec.visible.time_window },
      rationale: `Select ${selected.name} because it has the highest expected information gain among untried safe tools.`,
    };
  }
}

export function createTestDouble(id, style = "context-first") {
  return {
    id,
    adapterVersion: "test-double-adapter-3.0.0",
    adapterContractVersion: "3.0",
    supportedEvaluationLanes: ["ENGINEERING_TEST"],
    runtime: "explicit-engineering-test-double",
    async execute({ caseSpec, toolExecutor, emit, maxTurns = 10 }) {
      const brain = new EvidenceSeekingReplayBrain(style);
      const observations = [];
      const attemptedTools = new Set();
      for (let turn = 1; turn <= maxTurns; turn += 1) {
        const decision = brain.decide({ caseSpec, observations, attemptedTools });
        await emit("model.decision", "contestant", {
          turn,
          action: decision.type,
          tool: decision.name ?? null,
          rationale_summary: decision.rationale,
          test_double: true,
        }, { input_tokens: 90, output_tokens: 45 });
        if (decision.type === "final") return decision.outcome;
        attemptedTools.add(decision.name);
        const result = await toolExecutor(decision.name, decision.args);
        observations.push({ tool: decision.name, result });
      }
      throw new Error(`contestant exceeded max turns: ${maxTurns}`);
    },
  };
}
