const WEIGHTS = {
  task_outcome: 25,
  rca: 15,
  evidence: 15,
  trajectory: 15,
  open_world: 15,
  proactive: 5,
  resource_cost: 5,
  engineering_agility: 5,
};

export function gradeTrial(caseSpec, outcome, trace, usage) {
  const rootCauseHit = caseSpec.ground_truth.root_causes.includes(outcome.root_cause);
  const evidence = new Set(outcome.evidence_refs ?? []);
  const requiredEvidenceHit = caseSpec.ground_truth.required_evidence.filter((item) => evidence.has(item));
  const assertedClaims = `${outcome.root_cause ?? ""}\n${outcome.summary ?? ""}`.toLowerCase();
  const forbiddenClaim = caseSpec.ground_truth.forbidden_claims.some((claim) =>
    assertedClaims.includes(claim.toLowerCase()),
  );
  const toolErrors = trace.filter((event) => event.kind === "tool.result" && event.payload.ok === false);
  const laterSuccess = toolErrors.some((failure) =>
    trace.some((event) => event.seq > failure.seq && event.kind === "tool.result" && event.payload.ok === true),
  );
  const recoveryPassed = !caseSpec.ground_truth.requires_tool_recovery || (toolErrors.length > 0 && laterSuccess);
  const hasAlternativeExclusion = (outcome.exclusions ?? []).length > 0 || caseSpec.visible.success_criteria.require_alternative_exclusion !== true;
  const resourceEfficiency = usage.tool_calls <= 6 ? 1 : Math.max(0, 1 - (usage.tool_calls - 6) / 10);

  const normalized = {
    task_outcome: outcome.status === "resolved" && rootCauseHit ? 1 : 0,
    rca: rootCauseHit && hasAlternativeExclusion ? 1 : rootCauseHit ? 0.75 : 0,
    evidence: requiredEvidenceHit.length / caseSpec.ground_truth.required_evidence.length,
    trajectory: recoveryPassed ? 1 : 0.25,
    open_world: recoveryPassed ? 1 : 0,
    proactive: outcome.next_checks?.length ? 1 : 0.6,
    resource_cost: resourceEfficiency,
    engineering_agility: 1,
  };
  const dimensions = Object.fromEntries(
    Object.entries(normalized).map(([key, value]) => [key, { normalized: value, weighted: value * WEIGHTS[key], weight: WEIGHTS[key] }]),
  );
  const total = Number(Object.values(dimensions).reduce((sum, item) => sum + item.weighted, 0).toFixed(2));
  const hardGates = {
    root_cause: rootCauseHit,
    no_forbidden_claim: !forbiddenClaim,
    recovery: recoveryPassed,
    evidence_traceable: requiredEvidenceHit.length >= Math.min(2, caseSpec.ground_truth.required_evidence.length),
  };
  return {
    grader_version: "m1-code-grader-1.0.0",
    total,
    passed: Object.values(hardGates).every(Boolean) && total >= 75,
    dimensions,
    hard_gates: hardGates,
    evidence_hits: requiredEvidenceHit,
  };
}
