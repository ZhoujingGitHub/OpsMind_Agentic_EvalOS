import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  CANDIDATE_PRESENCE_CONTRACT,
  CandidatePresenceRegistry,
  PHYSICAL_LAB_LEASE_CONTRACT,
  RELEASE_SWITCH_CONTRACT,
  assertCandidateBound,
  assertCandidatePreflight,
  assertPhysicalLabLeaseAcquirable,
  candidatePresenceSignaturePayload,
  validatePhysicalLabLease,
  validateReleaseSwitchPlan,
  validateRestrictedDeploymentCommand,
} from "../src/index.mjs";

const NOW = Date.parse("2026-08-31T08:00:00.000Z");
const BOOT = "lab-boot-20260831";

function idleLease(overrides = {}) {
  return { contract_version: PHYSICAL_LAB_LEASE_CONTRACT, status: "idle", owner_mode: null,
    candidate_ref: null, trial_id: null, runtime_trial_id: null, lease_id: null, expires_at: null, boot_id: BOOT,
    updated_at: "2026-08-31T07:59:00.000Z", ...overrides };
}

function activeLease(overrides = {}) {
  return { contract_version: PHYSICAL_LAB_LEASE_CONTRACT, status: "in_use", owner_mode: "evalos_trial",
    candidate_ref: "langgraph-v1", trial_id: "trial-qualification-1", runtime_trial_id: "lg-trial-qualification-1",
    lease_id: "lease-qualification-1",
    expires_at: "2026-08-31T08:10:00.000Z", boot_id: BOOT,
    updated_at: "2026-08-31T08:00:00.000Z", ...overrides };
}

function presenceFixture() {
  const langgraph = generateKeyPairSync("ed25519");
  const agent = generateKeyPairSync("ed25519");
  let now = NOW;
  const registry = new CandidatePresenceRegistry({ clock: () => now, candidates: {
    "langgraph-v1": { key_id: "lg-key-20260831",
      public_key_pem: langgraph.publicKey.export({ type: "spki", format: "pem" }) },
    "agent-harness-v2": { key_id: "ah-key-20260831",
      public_key_pem: agent.publicKey.export({ type: "spki", format: "pem" }) },
  } });
  const report = (overrides = {}) => ({ contract_version: CANDIDATE_PRESENCE_CONTRACT,
    candidate_ref: "langgraph-v1", release_id: "68289f639aa7", product_boot_id: "product-boot-lg",
    status: "ready", capabilities: ["investigation", "model_visible_result", "protocol_lab_mcp"],
    database_revision: "20260828_0011", binding: { status: "unbound", owner_mode: null, trial_id: null,
      lease_id: null, environment_ref: null, lab_boot_id: null }, observed_at: new Date(now).toISOString(),
    expires_at: new Date(now + 180_000).toISOString(), nonce: "nonce_0123456789012345678901", ...overrides });
  const submit = (value, { privateKey = langgraph.privateKey, keyId = "lg-key-20260831" } = {}) => {
    const signature = sign(null, Buffer.from(candidatePresenceSignaturePayload(value)), privateKey).toString("base64url");
    return registry.accept({ report: value, headers: { "x-opsmind-key-id": keyId,
      "x-opsmind-signature": signature } });
  };
  return { registry, report, submit, langgraph, agent, setNow: (value) => { now = value; } };
}

test("一份物理租约阻止两种模式同时占用同一个5G实验室", () => {
  assert.equal(assertPhysicalLabLeaseAcquirable(idleLease(), { bootId: BOOT, nowMs: NOW }), true);
  assert.throws(() => assertPhysicalLabLeaseAcquirable(activeLease({ owner_mode: "langgraph_direct",
    trial_id: null }), { bootId: BOOT, nowMs: NOW }), /not idle/);
  assert.throws(() => validatePhysicalLabLease(activeLease({ owner_mode: "agent_harness_direct",
    candidate_ref: "langgraph-v1", trial_id: null }), { nowMs: NOW }), /mode and candidate do not match/);
});

test("实验室重启后旧租约不能自动恢复为可用", () => {
  assert.throws(() => assertPhysicalLabLeaseAcquirable(idleLease(), { bootId: "new-lab-boot", nowMs: NOW }),
    /quarantine and reset/);
  assert.throws(() => validatePhysicalLabLease(activeLease({ expires_at: "2026-08-31T07:59:59.000Z" }),
    { nowMs: NOW }), /explicit reset is required/);
});

test("Candidate 报到使用每产品独立签名，并拒绝伪造和重放", () => {
  const fixture = presenceFixture();
  const valid = fixture.report();
  fixture.submit(valid);
  assert.throws(() => fixture.submit(valid), /replayed/);

  fixture.setNow(NOW + 1_000);
  const forged = fixture.report({ observed_at: new Date(NOW + 1_000).toISOString(),
    expires_at: new Date(NOW + 181_000).toISOString(), nonce: "nonce_0123456789012345678902" });
  assert.throws(() => fixture.submit(forged, { privateKey: fixture.agent.privateKey }), /verification failed/);
  assert.throws(() => fixture.submit(forged, { keyId: "ah-key-20260831" }), /does not match candidate_ref/);
});

test("报到过期或 EvalOS 重启后，ready 一律变为未知", () => {
  const fixture = presenceFixture();
  fixture.submit(fixture.report());
  fixture.setNow(NOW + 180_000);
  assert.equal(fixture.registry.current("langgraph-v1"), null);

  const restarted = new CandidatePresenceRegistry({ clock: () => NOW, candidates: {
    "langgraph-v1": { key_id: "new-lg", public_key_pem: fixture.langgraph.publicKey.export({ type: "spki", format: "pem" }) },
  } });
  assert.equal(restarted.current("langgraph-v1"), null);
});

test("readiness 先允许未绑定预检，模型启动前必须再次核对精确 Trial 和租约", () => {
  const fixture = presenceFixture();
  fixture.submit(fixture.report());
  const preflight = assertCandidatePreflight({ registry: fixture.registry, candidateRef: "langgraph-v1",
    lease: idleLease(), releaseId: "68289f639aa7", databaseRevision: "20260828_0011",
    requiredCapabilities: ["investigation", "model_visible_result", "protocol_lab_mcp"], labBootId: BOOT });
  assert.equal(preflight.stage, "preflight");
  assert.throws(() => assertCandidateBound({ registry: fixture.registry, candidateRef: "langgraph-v1",
    lease: activeLease(), trialId: "trial-qualification-1", leaseId: "lease-qualification-1",
    environmentRef: "evalos-twin:trial-qualification-1", labBootId: BOOT, nowMs: NOW }),
  /does not confirm the exact EvalOS Trial binding/);

  fixture.setNow(NOW + 1_000);
  fixture.submit(fixture.report({ observed_at: new Date(NOW + 1_000).toISOString(),
    expires_at: new Date(NOW + 181_000).toISOString(), nonce: "nonce_0123456789012345678903",
    binding: { status: "bound", owner_mode: "evalos_trial", trial_id: "trial-qualification-1",
      lease_id: "lease-qualification-1", environment_ref: "evalos-twin:trial-qualification-1", lab_boot_id: BOOT } }));
  const bound = assertCandidateBound({ registry: fixture.registry, candidateRef: "langgraph-v1",
    lease: activeLease(), trialId: "trial-qualification-1", leaseId: "lease-qualification-1",
    environmentRef: "evalos-twin:trial-qualification-1", releaseId: "68289f639aa7",
    databaseRevision: "20260828_0011", requiredCapabilities: ["protocol_lab_mcp"],
    labBootId: BOOT, nowMs: NOW + 1_000 });
  assert.equal(bound.stage, "bound");
});

test("Trial、租约、数据库版本任一不匹配都阻断", () => {
  const fixture = presenceFixture();
  fixture.submit(fixture.report());
  assert.throws(() => assertCandidatePreflight({ registry: fixture.registry, candidateRef: "langgraph-v1",
    lease: idleLease(), databaseRevision: "wrong-head", labBootId: BOOT }), /database revision is incompatible/);
  assert.throws(() => assertCandidateBound({ registry: fixture.registry, candidateRef: "langgraph-v1",
    lease: activeLease(), trialId: "another-trial", leaseId: "lease-qualification-1",
    environmentRef: "evalos-twin:another-trial", labBootId: BOOT, nowMs: NOW }),
  /physical lab lease does not match/);
});

test("受限部署账号只有 status、apply 和 rollback，没有通用 Docker 或 shell 权限", () => {
  assert.deepEqual(validateRestrictedDeploymentCommand("langgraph-v1",
    ["/usr/local/sbin/opsmind-langgraph-release", "status"]),
  ["/usr/local/sbin/opsmind-langgraph-release", "status"]);
  assert.throws(() => validateRestrictedDeploymentCommand("langgraph-v1", ["docker", "ps"]), /fixed product helper/);
  assert.throws(() => validateRestrictedDeploymentCommand("agent-harness-v2",
    ["/usr/local/sbin/opsmind-agent-harness-release", "shell"]), /outside the fixed/);
});

test("应用版本切换只动本产品 current/previous，禁止顺带修改或回滚数据库", () => {
  const plan = { contract_version: RELEASE_SWITCH_CONTRACT, candidate_ref: "agent-harness-v2", action: "rollback",
    current_release: "585f804-current", previous_release: "fc6acf6-previous", target_release: "fc6acf6-previous",
    current_database_revision: "017_native_run_context_budget", target_database_revision: "017_native_run_context_budget",
    database_action: "none", other_product_action: "none",
    argv: ["/usr/local/sbin/opsmind-agent-harness-release", "rollback"] };
  assert.equal(validateReleaseSwitchPlan(plan).target_release, "fc6acf6-previous");
  assert.throws(() => validateReleaseSwitchPlan({ ...plan, target_database_revision: "016_protocol_trial_reconciliation" }),
    /must not migrate or roll back the database/);
  assert.throws(() => validateReleaseSwitchPlan({ ...plan, other_product_action: "restart" }),
    /must not touch the other product/);
});
