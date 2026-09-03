import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { prepareCandidateRegistration, registrationPatch, validateCandidateRegistration }
  from "../../../scripts/candidate-release-registration.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const FILES = { manifest: "config/m3-formal-agent-capability.manifest.json",
  relay: "config/candidate-relay-public-keys.json", presence: "config/candidate-presence-public-keys.json" };
const texts = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, readFileSync(path.join(ROOT, file), "utf8")]));
const current = () => Object.fromEntries(Object.entries(texts).map(([key, value]) => [key, JSON.parse(value)]));

function fixture(ref = "agent-harness-v2") {
  const configuration = current();
  const candidate = configuration.manifest.contestants.find((item) => item.ref === ref);
  const profile = configuration.manifest.candidate_resource_contract.profiles.find((item) => item.contestant_ref === ref);
  const revision = "b".repeat(40);
  const artifact = `sha256:${"c".repeat(64)}`;
  return { candidate_ref: ref, expected_source_revision: revision,
    deployment_attestation: { ...configuration.relay.candidates[ref].deployment_attestation,
      source_revision: revision, artifact_digest: artifact, verified_evidence_ref: "test-fixture-only:deployment-proof" },
    discovery: { ...candidate, candidate_kind: "REAL_PRODUCT", production_writes_available: false,
      source_revision: revision, artifact_digest: artifact, runtime_digest: `sha256:${"d".repeat(64)}`,
      runtime_manifest_digest: `sha256:${"e".repeat(64)}`, capability_contract_digest: `sha256:${"f".repeat(64)}` },
    public_resource_limits: structuredClone(profile.candidate_resources),
    public_resource_enforcement: structuredClone(profile.enforcement),
    resource_evidence_ref: "test-fixture-only:public-runtime-contract",
    database_revision: configuration.presence.candidates[ref].expected_database_revision };
}

test("当前三个公开配置一致；只读检查不写配置，也不表示线上验收通过", () => {
  assert.equal(validateCandidateRegistration(current()), true);
  const result = spawnSync(process.execPath, ["scripts/candidate-release-registration.mjs", "--check"],
    { cwd: ROOT, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /不代表线上就绪/);
  for (const [key, file] of Object.entries(FILES)) assert.equal(readFileSync(path.join(ROOT, file), "utf8"), texts[key]);
});

for (const ref of ["agent-harness-v2", "langgraph-v1"]) {
  test(`${ref} 一次准备全部版本字段，不改变其他产品、模型架构、资源、密钥或历史记录`, () => {
    const before = current();
    const input = fixture(ref);
    const inputCopy = structuredClone(input);
    const expected = structuredClone(before);
    const candidate = expected.manifest.contestants.find((item) => item.ref === ref);
    for (const field of ["source_revision", "artifact_digest", "runtime_digest", "runtime_manifest_digest", "capability_contract_digest"])
      candidate[field] = input.discovery[field];
    candidate.candidate_runtime = structuredClone(input.discovery.candidate_runtime);
    const profile = expected.manifest.candidate_resource_contract.profiles.find((item) => item.contestant_ref === ref);
    profile.provenance = { ...profile.provenance, source_revision: input.expected_source_revision,
      artifact_digest: input.deployment_attestation.artifact_digest, evidence_ref: input.resource_evidence_ref };
    expected.relay.candidates[ref].deployment_attestation = structuredClone(input.deployment_attestation);
    expected.presence.candidates[ref].expected_release_id = input.expected_source_revision.slice(0, 12);
    const updated = prepareCandidateRegistration(before, input);
    assert.deepEqual(updated, expected);
    assert.deepEqual(before, current(), "不原地修改输入配置");
    assert.deepEqual(input, inputCopy, "不改写独立证明或产品发现结果");
    const patch = registrationPatch(texts, updated);
    const targets = [...patch.matchAll(/^\*\*\* Update File: (.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(targets, Object.values(FILES), "只产生三个明确目标的待审补丁");
    assert.match(patch, /^\*\*\* Begin Patch\n/);
    assert.match(patch, /\*\*\* End Patch\n$/);
  });
}

test("只改冻结清单却漏改证明、资源来源或签名报到版本，全部阻断", () => {
  for (const mutate of [
    (value) => { value.relay.candidates["agent-harness-v2"].deployment_attestation.source_revision = "d".repeat(40); },
    (value) => { delete value.presence.candidates["agent-harness-v2"].expected_release_id; },
    (value) => { value.presence.candidates["agent-harness-v2"].expected_release_id = "d".repeat(12); },
    (value) => { value.manifest.candidate_resource_contract.profiles[0].provenance.artifact_digest = `sha256:${"d".repeat(64)}`; },
    (value) => { delete value.presence.candidates["langgraph-v1"].expected_database_revision; },
  ]) {
    const value = current();
    mutate(value);
    assert.throws(() => validateCandidateRegistration(value));
  }
});

test("版本登记不把调查时间与包含安全结束余量的总时间强制判为相等", () => {
  const value = current();
  const profile = value.manifest.candidate_resource_contract.profiles.find((item) => item.contestant_ref === "langgraph-v1");
  value.relay.candidates["langgraph-v1"].evaluation_limits.max_run_ms = profile.candidate_resources.max_duration_seconds * 1000 + 300000;
  assert.equal(validateCandidateRegistration(value), true);
});

test("缺少独立证明、批准版本不一致或产品发现不一致时，不能从旧清单补一个证明", () => {
  for (const mutate of [
    (value) => { delete value.deployment_attestation; },
    (value) => { value.deployment_attestation.source_revision = "d".repeat(40); },
    (value) => { value.deployment_attestation.verification_method = "copied_from_manifest"; },
    (value) => { value.discovery.artifact_digest = `sha256:${"d".repeat(64)}`; },
    (value) => { value.discovery.source_revision = "d".repeat(40); },
    (value) => { value.expected_source_revision = "b".repeat(12); },
    (value) => { value.candidate_ref = "guess-a-product"; },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => prepareCandidateRegistration(current(), input));
  }
});

test("版本登记不批准架构、数据库或资源安全熔断变化，也不丢失运行合同", () => {
  for (const mutate of [
    (value) => { value.discovery.architecture = "LANGGRAPH"; },
    (value) => { value.discovery.production_writes_available = true; },
    (value) => { value.discovery.candidate_runtime.models = []; },
    (value) => { value.discovery.candidate_runtime.versions = {}; },
    (value) => { value.discovery.runtime_digest = "invented"; },
    (value) => { delete value.public_resource_limits; },
    (value) => { value.public_resource_limits.max_turns += 1; },
    (value) => { value.public_resource_enforcement.max_turns = "observe_only"; },
    (value) => { value.database_revision = "unapproved-migration"; },
    (value) => { value.resource_evidence_ref = ""; },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => prepareCandidateRegistration(current(), input));
  }
});

test("公开运行合同和证明禁止夹带凭据；命令报错也不回显材料内容", () => {
  for (const mutate of [
    (value) => { value.discovery.candidate_runtime.password = "fixture-password"; },
    (value) => { value.deployment_attestation.password = "fixture-password"; },
    (value) => { value.resource_evidence_ref = "sk-fixture-credential-not-real"; },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => prepareCandidateRegistration(current(), input));
  }
  const result = spawnSync(process.execPath, ["scripts/candidate-release-registration.mjs", "--prepare", "sk-fixture-credential-not-real.json"],
    { cwd: ROOT, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /没有写入文件/);
  assert.doesNotMatch(result.stderr, /sk-fixture|ENOENT|stack/);
});
