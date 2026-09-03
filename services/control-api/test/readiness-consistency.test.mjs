import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { checkCandidateReadiness, trialToolActivity } from "../src/app.mjs";
import { CandidatePresenceRegistry, CANDIDATE_PRESENCE_CONTRACT, PHYSICAL_LAB_LEASE_CONTRACT,
  assertCandidatePreflight, candidatePresenceSignaturePayload } from "../../../packages/kernel/src/index.mjs";

test("相同开考检查贯穿真实签名、版本、空闲租约与过期，不能以配置代替就绪", async () => {
  let now = Date.parse("2026-09-03T10:00:00.000Z");
  const keys = generateKeyPairSync("ed25519");
  const config = { clock: () => now, candidates: { "langgraph-v1": { key_id: "test-presence",
    public_key_pem: keys.publicKey.export({ type: "spki", format: "pem" }) } } };
  let registry = new CandidatePresenceRegistry(config);
  const report = { contract_version: CANDIDATE_PRESENCE_CONTRACT, candidate_ref: "langgraph-v1",
    release_id: "release-current", product_boot_id: "product-boot", status: "ready",
    database_revision: "current-db", capabilities: ["investigation"],
    binding: { status: "unbound", owner_mode: null, trial_id: null, lease_id: null,
      environment_ref: null, lab_boot_id: null }, observed_at: new Date(now).toISOString(),
    expires_at: new Date(now + 180000).toISOString(), nonce: "test_nonce_01234567890123456789" };
  registry.accept({ report, headers: { "x-opsmind-key-id": "test-presence", "x-opsmind-signature":
    sign(null, Buffer.from(candidatePresenceSignaturePayload(report)), keys.privateKey).toString("base64url") } });
  const lease = { contract_version: PHYSICAL_LAB_LEASE_CONTRACT, status: "idle", owner_mode: null,
    candidate_ref: null, trial_id: null, runtime_trial_id: null, lease_id: null, expires_at: null,
    boot_id: "lab-boot", updated_at: new Date(now).toISOString() };
  let expectedRelease = "release-current";
  let productReady = true;
  const adapter = { preflight: async () => ({ ready: productReady, formal_ready: productReady,
    twin: { ready: null } }) };
  const presence = async () => assertCandidatePreflight({ registry, candidateRef: "langgraph-v1",
    lease, releaseId: expectedRelease, databaseRevision: "current-db", labBootId: "lab-boot",
    requiredCapabilities: ["investigation"] });
  const check = () => checkCandidateReadiness(adapter, { requiresTwin: true }, presence);
  const ready = await check();
  assert.equal(ready.ready, true);
  assert.equal(ready.twin.ready, true);
  productReady = false;
  assert.equal((await check()).ready, false);
  productReady = true;
  expectedRelease = "release-old";
  await assert.rejects(check(), /frozen version/);
  expectedRelease = "release-current";
  lease.status = "quarantined";
  await assert.rejects(check(), /not idle/);
  lease.status = "idle";
  lease.boot_id = "restarted-lab";
  await assert.rejects(check(), /boot changed/);
  lease.boot_id = "lab-boot";
  now += 180001;
  await assert.rejects(check(), /has not reported ready/);
  registry = new CandidatePresenceRegistry(config);
  await assert.rejects(check(), /has not reported ready/);
  assert.equal((await checkCandidateReadiness(adapter, { requiresTwin: true }, async () => null)).ready, false);
});

test("真实产品工具次数取产品记账，未知不等于零，调用不冒充完成", () => {
  const experiment = { manifest: { run_class: "REAL_CANDIDATE" } };
  const records = [{ record_type: "SPAN_END", span_kind: "TOOL" }];
  assert.equal(trialToolActivity({ usage: { tool_calls: 0 } }, experiment, records).tool_calls, null);
  for (const count of [0, 36]) {
    const view = trialToolActivity({ usage: { tool_calls: count,
      measurement: { observed_dimensions: ["tool_calls"] } } }, experiment, records);
    assert.equal(view.tool_calls, count);
    assert.equal(view.tool_results, null);
  }
  assert.equal(trialToolActivity({}, { manifest: { run_class: "ENGINEERING_TEST" } }, records).tool_results, 1);
});
