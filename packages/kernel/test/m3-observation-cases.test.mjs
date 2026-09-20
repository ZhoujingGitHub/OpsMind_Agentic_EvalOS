import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { CASES, M2_CASES, M3_CASES, M3_OBSERVATION_CASES, createEvalRegistry, createObservationDesign, casePublicView, sha256 } from "../src/index.mjs";
import { publicTaskGoal } from "../../agent-runtime/src/product-connectors-v5.mjs";

test("new symptom-only case preserves old cases, tools, mode and private scenario", () => {
  const previous = JSON.stringify(M3_CASES), old = M3_CASES["M3-PUB-008"];
  const registry = createEvalRegistry({ m15Cases: CASES, m2Cases: M2_CASES, m3Cases: M3_CASES,
    observationCases: M3_OBSERVATION_CASES });
  const current = M3_OBSERVATION_CASES["M3-OBS-001"];
  assert.equal(current.environment.scenario_id, old.environment.scenario_id);
  assert.equal(current.visible.operating_mode, "human_collaboration");
  assert.equal(current.version, "3.2.2");
  assert.deepEqual(Object.keys(current.tools), Object.keys(old.tools));
  assert.deepEqual(current.ground_truth.root_causes, old.ground_truth.root_causes);
  // Every case must carry a discriminative fact, in the live vocabulary, and
  // must never show the candidate which partition it is in.
  for (const item of Object.values(M3_OBSERVATION_CASES)) {
    assert.ok((item.ground_truth.root_cause_fact_refs ?? []).length > 0, item.id);
    assert.equal(JSON.stringify(item.ground_truth.required_evidence).includes("state:firewall-"), false, item.id);
    assert.equal(Object.hasOwn(item.visible.scope, "observation_profile"), false, item.id);
    assert.equal(Object.hasOwn(item.visible, "test_condition"), false, item.id);
    assert.ok(item.environment.observation_profile, item.id);
    assert.equal(item.goal.includes(item.environment.scenario_id), false, item.id);
    for (const ref of item.ground_truth.required_evidence) {
      assert.equal(item.goal.includes(ref), false, `${item.id} ${ref}`);
    }
  }
  assert.equal(registry.getCase("M3-PUB-008@3.1.0").public.goal, old.goal);
  assert.equal(registry.snapshot().suites.find((s) => s.id === "m3-formal-80").case_refs.length, 80);
  assert.equal(registry.getCase("M3-OBS-001@3.2.2").public.goal, current.goal);
  assert.equal(JSON.stringify(M3_CASES), previous);
});

test("冻结的观测题库一改内容就必须换版本号，旧版本不许被悄悄覆盖", () => {
  // 2026-09-20 的部署事故：这套题从 1 道扩到 80 道、可见任务契约也多了一条，
  // 但版本号还是 3.2.0。考场库里那条 3.2.0 的套件定义是冻结的、只会被忽略，
  // 于是控制面一启动就报「case_ref 不属于这个套件」，整次发布自动回滚。
  //
  // 这两个指纹就是防这件事的：改了内容而没换版本，这条测试先炸，而不是等到
  // 线上启动失败。换版本时把指纹一起更新，并确认题面文字确实该变。
  const registry = createEvalRegistry({ m15Cases: CASES, m2Cases: M2_CASES, m3Cases: M3_CASES,
    observationCases: M3_OBSERVATION_CASES });
  const snapshot = registry.snapshot({ includeRuntime: true });
  const suite = snapshot.suites.find((item) => item.id === "m3-symptom-acceptance");
  assert.equal(`${suite.id}@${suite.version}`, "m3-symptom-acceptance@3.2.2");
  assert.equal(suite.case_refs.length, 80);
  assert.equal(sha256(suite), "b263b8ce9a14a52ff9d6f9bdd6d691b46df4e720d44605899706bce1c6674799");
  const observed = snapshot.cases.find((item) => item.key === "M3-OBS-001@3.2.2");
  assert.equal(observed.dataset_ref, "m3-l2-symptom-observations@3.2.2");
  assert.equal(sha256(observed.public), "ba122fffab20d7db0df872f425ed07fd8d08d08ad3b91e89285eab55ea10d1b6");
  // 3.2.2 在题面后面接了一句「答卷要长什么样」。**症状那一段一个字都没动**：
  // 下面这个指纹与 3.2.0/3.2.1 钉的是同一个值，所以四条链路逐字节对照的前提
  // 仍然成立，变的只是对答卷形式的要求。
  const current = M3_OBSERVATION_CASES["M3-OBS-001"];
  const instruction = current.visible.task_contract.root_cause_state_claim_instruction;
  assert.equal(current.goal.endsWith(` ${instruction}`), true);
  const symptom = current.goal.slice(0, current.goal.length - instruction.length - 1);
  assert.equal(createHash("sha256").update(symptom, "utf8").digest("hex"),
    "edfad684aee84a3ae0adbb1b81b978207fc40f47e2bbdbc451d7af42bcae2b8b");
  assert.equal(createHash("sha256").update(current.goal, "utf8").digest("hex"),
    "c6eb203e03c1578a04961dab9240effc056bd34584b306e2f4de343961eba24b");
  // 设计里引用的套件、数据集与题号三者版本必须一致，缺一个就会重演这次事故。
  const design = createObservationDesign({ name: "x", suite_ref: "", dataset_ref: "", case_refs: [] });
  assert.equal(design.suite_ref, "m3-symptom-acceptance@3.2.2");
  assert.equal(design.dataset_ref, "m3-l2-symptom-observations@3.2.2");
  assert.ok(design.case_refs.every((ref) => ref.endsWith("@3.2.2")));
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
  // 2026-09-19: all four partitions are enabled. The legacy id stays in the
  // public partition so the already-registered frozen source still resolves.
  assert.equal(result.case_refs.length, 80);
  assert.ok(result.case_refs.includes("M3-OBS-001@3.2.2"));
  assert.deepEqual(Object.fromEntries(Object.entries(result.case_partitions)
    .map(([name, refs]) => [name, refs.length])),
  { public: 20, hidden: 20, safety: 20, regression: 20 });
  assert.equal(new Set(result.case_refs).size, result.case_refs.length);
  assert.deepEqual([...result.case_refs].sort(),
    Object.values(result.case_partitions).flat().sort());
  assert.deepEqual(result.environment_seeds, source.environment_seeds);
  assert.deepEqual(result.contestants, source.contestants);
  assert.deepEqual(result.frozen_dependencies, source.frozen_dependencies);
  assert.equal(result.evaluation_mode, source.evaluation_mode);
});
