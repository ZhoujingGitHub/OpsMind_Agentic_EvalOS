import assert from "node:assert/strict";
import test from "node:test";
import { CASES, M2_CASES, M3_CASES, M3_OBSERVATION_CASES, createEvalRegistry, createObservationDesign, casePublicView } from "../src/index.mjs";
import { publicTaskGoal } from "../../agent-runtime/src/product-connectors-v5.mjs";

test("new symptom-only case preserves old cases, tools, mode and private scenario", () => {
  const previous = JSON.stringify(M3_CASES), old = M3_CASES["M3-PUB-008"];
  const registry = createEvalRegistry({ m15Cases: CASES, m2Cases: M2_CASES, m3Cases: M3_CASES,
    observationCases: M3_OBSERVATION_CASES });
  const current = M3_OBSERVATION_CASES["M3-OBS-001"];
  assert.equal(current.environment.scenario_id, old.environment.scenario_id);
  assert.equal(current.visible.operating_mode, "human_collaboration");
  assert.equal(current.version, "3.2.0");
  assert.deepEqual(Object.keys(current.tools), Object.keys(old.tools));
  assert.deepEqual(current.ground_truth.root_causes, old.ground_truth.root_causes);
  assert.equal(registry.getCase("M3-PUB-008@3.1.0").public.goal, old.goal);
  assert.equal(registry.snapshot().suites.find((s) => s.id === "m3-formal-80").case_refs.length, 80);
  assert.equal(registry.getCase("M3-OBS-001@3.2.0").public.goal, current.goal);
  assert.equal(JSON.stringify(M3_CASES), previous);
});

test("candidate task carries symptoms, scope and authorization, not injected answers", () => {
  const current = M3_OBSERVATION_CASES["M3-OBS-001"];
  const goal = publicTaskGoal(current), visible = JSON.stringify(casePublicView(current));
  for (const value of ["SCTP", "38412", "DROP", "sctp-blocked", "网络阻断", "ground_truth",
                       "scenario_id", "observation_profile", "base_case_ref", "required_evidence"]) {
    assert.equal(goal.includes(value), false, value);
  }
  for (const value of ["sctp-blocked", "ground_truth", "scenario_id", "observation_profile",
                       "state:firewall-sctp-drop", "policy:sctp:38412:drop-rule-present"]) {
    assert.equal(visible.includes(value), false, value);
  }
  assert.match(goal, /终端无法正常注册/);
  assert.match(goal, /业务访问失败/);
  assert.match(goal, /独立审批/);
  assert.ok(current.visible.scope.resource_ids.includes("amf"));
  assert.ok(Object.values(current.tools).every((tool) => !Object.hasOwn(tool, "result")));
  assert.equal(registryGoal(current), goal);
});

function registryGoal(current) {
  const registry = createEvalRegistry({ m15Cases: CASES, m2Cases: M2_CASES, observationCases: M3_OBSERVATION_CASES });
  return publicTaskGoal(registry.getExecutionCase(current.id + "@" + current.version));
}


test("symptom design preserves frozen contracts without mutating its source", () => {
  const source = { name: "original", evaluation_mode: "FORMAL", case_refs: ["M3-PUB-008@3.1.0"],
    case_partitions: { public: ["M3-PUB-008@3.1.0"] }, environment_seeds: [17],
    contestants: [{ ref: "agent-harness-v2" }], frozen_dependencies: { grader: { version: "5.5.0" } } };
  const before = structuredClone(source), result = createObservationDesign(source);
  assert.deepEqual(source, before);
  assert.deepEqual(result.case_refs, ["M3-OBS-001@3.2.0"]);
  assert.deepEqual(result.environment_seeds, source.environment_seeds);
  assert.deepEqual(result.contestants, source.contestants);
  assert.deepEqual(result.frozen_dependencies, source.frozen_dependencies);
  assert.equal(result.evaluation_mode, source.evaluation_mode);
});
