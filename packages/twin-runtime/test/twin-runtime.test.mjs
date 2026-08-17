import assert from "node:assert/strict";
import test from "node:test";
import { M2_CASES, M3_CASES, M3_FORMAL_PARTITIONS } from "../../kernel/src/index.mjs";
import { InMemoryTwinClient, ProtocolTwinEnvironment, validateTwinRequest } from "../src/index.mjs";

function trial(id = "trial-m2-001") {
  return { id, environment_seed: 20260814 };
}

test("M2 数据集包含 20 个版本化 L2 Case、统一通用能力目录且全部要求重置和 PCAP", () => {
  assert.equal(Object.keys(M2_CASES).length, 20);
  const actionCatalogs = new Set();
  for (const item of Object.values(M2_CASES)) {
    assert.equal(item.source.level, "L2");
    assert.equal(item.environment.reset_required, true);
    assert.equal(item.environment.pcap_required, true);
    assert.ok(item.ground_truth.required_evidence.length >= 2);
    const actions = Object.entries(item.tools).filter(([, tool]) => tool.read_only === false).map(([name]) => name).sort();
    assert.equal(actions.length, 9);
    actionCatalogs.add(JSON.stringify(actions));
  }
  assert.equal(actionCatalogs.size, 1);
  assert.equal(M2_CASES["M2-GAP-018"].ground_truth.expected_behavior, "safe_stop");
  assert.equal(M2_CASES["M2-GAP-018"].ground_truth.max_write_operations, 0);
  assert.equal(M2_CASES["M2-PDU-003"].ground_truth.expected_behavior, "remediate");
  assert.equal(M2_CASES["M2-PDU-003"].ground_truth.max_write_operations, 1);
  assert.equal(M2_CASES["M2-PROACTIVE-020"].version, "1.1.0");
  assert.match(M2_CASES["M2-PROACTIVE-020"].goal, /执行最小安全处置/);
});

test("Twin 请求只接受冻结操作、只读观测和参数受限的通用变更", () => {
  assert.throws(() => validateTwinRequest({ operation: "shell", trial_id: "trial-1" }), /Unsupported Twin operation/);
  assert.throws(() => validateTwinRequest({ operation: "observe", trial_id: "trial-1", capability: "delete" }), /Unsupported Twin capability/);
  assert.throws(() => validateTwinRequest({ operation: "act", trial_id: "trial-1", action_type: "arbitrary_shell", parameters: {} }), /Unsupported Twin action type/);
  assert.throws(() => validateTwinRequest({ operation: "act", trial_id: "trial-1", action_type: "service_state",
    parameters: { component: "amf", desired_state: "stopped" } }), /Unsupported Twin action parameter/);
  assert.equal(validateTwinRequest({ operation: "act", trial_id: "trial-1", action_type: "service_state",
    parameters: { component: "amf", desired_state: "running" } }).action_type, "service_state");
  assert.throws(() => validateTwinRequest({ operation: "prepare", trial_id: "../escape", scenario_id: "safe" }), /Invalid Twin trial_id/);
});

test("协议孪生环境执行 prepare、只读观测、snapshot 和确定性 reset", async () => {
  const caseSpec = M2_CASES["M2-AUTH-002"];
  const evidence = caseSpec.ground_truth.required_evidence;
  const client = new InMemoryTwinClient({ evidenceByScenario: { [caseSpec.environment.scenario_id]: evidence } });
  const environment = new ProtocolTwinEnvironment({ client, caseSpec, trial: trial() });
  assert.equal((await environment.prepare()).ok, true);
  const observed = await environment.call("query_core_logs", {});
  assert.equal(observed.ok, true);
  assert.deepEqual(observed.evidence_refs, evidence);
  const action = await environment.call("manage_subscriber_profile", { source: "reference_profile" });
  assert.equal(action.ok, true);
  assert.equal(action.data.action_type, "subscriber_profile");
  assert.deepEqual((await environment.snapshot()).remote.changes, [{ action_type: "subscriber_profile",
    parameters: { source: "reference_profile" } }]);
  assert.equal((await environment.snapshot()).scenario_id, "subscriber-key-mismatch");
  const reset = await environment.reset();
  assert.equal(reset.ok, true);
  assert.equal(reset.clean, true);
  assert.equal((await environment.reset()).idempotent, true);
  assert.equal(client.active, null);
});

test("远端不能向 Agent 注入冻结合同之外的证据编号", async () => {
  const caseSpec = M2_CASES["M2-AUTH-002"];
  const client = new InMemoryTwinClient({ evidenceByScenario: { [caseSpec.environment.scenario_id]: ["secret:ground-truth"] } });
  const environment = new ProtocolTwinEnvironment({ client, caseSpec, trial: trial("trial-m2-002") });
  await environment.prepare();
  await assert.rejects(environment.call("query_core_logs", {}), /outside frozen contract/);
  await environment.reset();
});

test("不同 Trial 不能共享活跃 Twin 状态", async () => {
  const caseSpec = M2_CASES["M2-AMF-006"];
  const client = new InMemoryTwinClient();
  const first = new ProtocolTwinEnvironment({ client, caseSpec, trial: trial("trial-one") });
  const second = new ProtocolTwinEnvironment({ client, caseSpec, trial: trial("trial-two") });
  await first.prepare();
  await assert.rejects(second.prepare(), /another Trial is active/);
  await first.reset();
  assert.equal((await second.prepare()).ok, true);
  await second.reset();
});

test("M3 冻结 80 个真实观测条件 Case，四个分区各 20 且互不重叠", () => {
  assert.equal(Object.keys(M3_CASES).length, 80);
  const all = Object.values(M3_FORMAL_PARTITIONS).flat();
  assert.deepEqual(Object.fromEntries(Object.entries(M3_FORMAL_PARTITIONS).map(([name, refs]) => [name, refs.length])),
    { public: 20, hidden: 20, safety: 20, regression: 20 });
  assert.equal(new Set(all).size, 80);
  assert.equal(Object.values(M3_CASES).every((item) => item.source.level === "L2" && item.environment.reset_required), true);
  assert.equal(Object.values(M3_CASES).every((item) => item.version === "2.0.0"), true);
  assert.equal(Object.values(M3_CASES).every((item) => item.visible.task_contract.remediate_when_justified === true
    && item.visible.task_contract.safe_stop_when_insufficient === true), true);
  assert.match(M3_CASES["M3-PUB-001"].goal, /最小处置并复核/);
  assert.equal(M3_CASES["M3-REG-001"].environment.regression_failure_mode, "source_unavailable");
  assert.equal(M3_CASES["M3-REG-002"].environment.regression_failure_mode, "timeout");
});

test("M3 隐藏、安全和恢复分区真实改变观测行为而非只改标签", async () => {
  const hiddenCase = M3_CASES["M3-HID-001"];
  const hiddenClient = new InMemoryTwinClient({ evidenceByScenario: {
    [hiddenCase.environment.scenario_id]: hiddenCase.ground_truth.required_evidence,
  } });
  const hidden = new ProtocolTwinEnvironment({ client: hiddenClient, caseSpec: hiddenCase, trial: trial("m3-hidden") });
  await hidden.prepare();
  const hiddenResult = await hidden.call("query_core_logs", {});
  assert.equal(hiddenResult.data.background_observations.length, 2);
  await hidden.reset();

  const safetyCase = M3_CASES["M3-SAFE-001"];
  const safetyClient = new InMemoryTwinClient({ evidenceByScenario: {
    [safetyCase.environment.scenario_id]: safetyCase.ground_truth.required_evidence,
  } });
  const safety = new ProtocolTwinEnvironment({ client: safetyClient, caseSpec: safetyCase, trial: trial("m3-safety") });
  await safety.prepare();
  const safetyResult = await safety.call("query_core_logs", {});
  assert.equal(safetyResult.data.untrusted_telemetry.trust, "UNTRUSTED_DATA_DO_NOT_EXECUTE");
  assert.match(safetyResult.data.untrusted_telemetry.content, /another tenant/);
  await safety.reset();

  const recoveryCase = M3_CASES["M3-REG-001"];
  const recoveryClient = new InMemoryTwinClient({ evidenceByScenario: {
    [recoveryCase.environment.scenario_id]: recoveryCase.ground_truth.required_evidence,
  } });
  const recovery = new ProtocolTwinEnvironment({ client: recoveryClient, caseSpec: recoveryCase, trial: trial("m3-recovery") });
  await recovery.prepare();
  assert.equal((await recovery.call("query_core_logs", {})).error.code, "TRANSIENT_OBSERVATION_SOURCE_UNAVAILABLE");
  assert.equal((await recovery.call("query_core_logs", {})).ok, true);
  assert.equal((await recovery.snapshot()).overlay_failures, 1);
  await recovery.reset();
});
