// Local release preparation only: no network, database, deployment, or file writes.
// Expected identity is generated once; observed deployment proof must be supplied independently.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { validateCandidateResourceContract } from "../packages/kernel/src/budget-profile.mjs";
import { trustedDeploymentAttestation } from "../packages/kernel/src/peripheral-mvp-contracts.mjs";
import { containsSensitiveMaterial, redact } from "../packages/kernel/src/redaction.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const FILES = Object.freeze({
  manifest: "config/m3-formal-agent-capability.manifest.json",
  relay: "config/candidate-relay-public-keys.json",
  presence: "config/candidate-presence-public-keys.json",
});
const FINGERPRINTS = ["source_revision", "artifact_digest", "runtime_digest",
  "runtime_manifest_digest", "capability_contract_digest"];

function releaseId(revision) {
  assert.match(revision ?? "", /^[a-f0-9]{40}$/, "必须提供完整的 Git 提交号");
  return revision.slice(0, 12);
}

export function validateCandidateRegistration({ manifest, relay, presence }) {
  assert.equal(manifest.manifest_version, "8.0", "新真实评测只接受当前 Manifest 8");
  assert.equal(containsSensitiveMaterial({ manifest, relay, presence }), false, "公开配置中禁止出现凭据");
  assert.equal(redact({ relay, presence }).changed, false, "身份配置只能保存公开身份，禁止保存凭据");
  validateCandidateResourceContract(manifest);
  for (const candidate of manifest.contestants) {
    assert.equal(candidate.kind, "REAL_PRODUCT");
    assert.equal(candidate.adapter_contract_version, "5.0");
    const expectedRelease = releaseId(candidate.source_revision);
    const observed = trustedDeploymentAttestation(relay.candidates?.[candidate.ref]?.deployment_attestation);
    assert.equal(observed.source_revision, candidate.source_revision, `${candidate.ref} 实测提交与冻结版本不一致`);
    assert.equal(observed.artifact_digest, candidate.artifact_digest, `${candidate.ref} 实测镜像与冻结版本不一致`);
    const identity = presence.candidates?.[candidate.ref];
    assert.equal(identity?.expected_release_id, expectedRelease, `${candidate.ref} 签名报到的预期版本漏填或不一致`);
    assert.ok(identity.key_id && identity.public_key_pem && identity.expected_database_revision,
      `${candidate.ref} 签名身份或数据库版本缺失`);
    // Native runtime admission already validates active time plus terminalization reserve.
    // Version registration must not redefine those two durations as one value.
    assert.equal(redact(candidate.candidate_runtime).changed, false, "公开运行合同中禁止出现凭据");
    for (const name of FINGERPRINTS.slice(1)) assert.match(candidate[name] ?? "", /^sha256:[a-f0-9]{64}$/);
  }
  return true;
}

export function prepareCandidateRegistration(current, input) {
  validateCandidateRegistration(current);
  const updated = structuredClone(current);
  const candidate = updated.manifest.contestants.find((item) => item.ref === input.candidate_ref);
  assert.ok(candidate, "只能登记已有的明确产品，不能猜名称或添加产品");
  const expectedRelease = releaseId(input.expected_source_revision);
  // Never fill observed identity using the expected revision or the old Manifest.
  const proof = trustedDeploymentAttestation(input.deployment_attestation);
  assert.equal(proof.source_revision, input.expected_source_revision, "独立部署证明不是本次批准的版本");
  const discovered = input.discovery;
  assert.equal(discovered?.candidate_kind, "REAL_PRODUCT");
  assert.equal(discovered.architecture, candidate.architecture, "版本登记不能改变产品架构");
  assert.equal(discovered.production_writes_available, false);
  assert.equal(discovered.source_revision, proof.source_revision, "产品发现与独立部署证明提交不一致");
  assert.equal(discovered.artifact_digest, proof.artifact_digest, "产品发现与独立部署证明镜像不一致");
  for (const name of FINGERPRINTS.slice(1)) assert.match(discovered[name] ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.ok(discovered.candidate_runtime?.contract_version === "1.0" &&
    Array.isArray(discovered.candidate_runtime.models) && discovered.candidate_runtime.models.length &&
    discovered.candidate_runtime.versions && !Array.isArray(discovered.candidate_runtime.versions) &&
    Object.keys(discovered.candidate_runtime.versions).length &&
    Object.values(discovered.candidate_runtime.versions).every((value) => typeof value === "string" && value.trim()),
    "必须提交产品实际公开的模型与运行合同");
  assert.equal(redact(discovered.candidate_runtime).changed, false, "公开运行合同中禁止出现凭据");
  assert.equal(redact(input.deployment_attestation).changed, false, "部署证明中禁止出现凭据");
  assert.equal(containsSensitiveMaterial(input.resource_evidence_ref), false, "资源来源中禁止出现凭据");

  const profile = updated.manifest.candidate_resource_contract.profiles.find((item) => item.contestant_ref === candidate.ref);
  // This command is a version registration, not permission to silently change safety fuses or databases.
  assert.ok(isDeepStrictEqual(input.public_resource_limits, profile.candidate_resources), "产品资源发生变化，需单独审核，不能沿用旧资源");
  assert.ok(isDeepStrictEqual(input.public_resource_enforcement, profile.enforcement), "产品资源执行方式发生变化，需单独审核");
  assert.equal(input.database_revision, updated.presence.candidates[candidate.ref].expected_database_revision,
    "数据库版本发生变化，版本登记不能批准迁移");
  assert.ok(typeof input.resource_evidence_ref === "string" && input.resource_evidence_ref.trim(),
    "必须提供本版本真实公开资源的来源");

  for (const name of FINGERPRINTS) candidate[name] = discovered[name];
  candidate.candidate_runtime = structuredClone(discovered.candidate_runtime);
  profile.provenance = { ...profile.provenance, source_revision: proof.source_revision,
    artifact_digest: proof.artifact_digest, evidence_ref: input.resource_evidence_ref };
  updated.relay.candidates[candidate.ref].deployment_attestation = {
    contract_version: input.deployment_attestation.contract_version, ...proof,
    verification_method: input.deployment_attestation.verification_method,
    verified_evidence_ref: input.deployment_attestation.verified_evidence_ref,
  };
  updated.presence.candidates[candidate.ref].expected_release_id = expectedRelease;
  validateCandidateRegistration(updated);
  return updated;
}

export function registrationPatch(beforeTexts, updated) {
  validateCandidateRegistration(updated);
  assert.equal(containsSensitiveMaterial(Object.values(beforeTexts)), false, "原配置中有凭据，禁止输出补丁");
  const changes = [];
  for (const [name, file] of Object.entries(FILES)) {
    const before = beforeTexts[name].replaceAll("\r\n", "\n").trimEnd();
    const after = JSON.stringify(updated[name], null, 2);
    if (before === after) continue;
    changes.push(`*** Update File: ${file}\n@@\n` +
      before.split("\n").map((line) => `-${line}`).join("\n") + "\n" +
      after.split("\n").map((line) => `+${line}`).join("\n"));
  }
  return changes.length ? `*** Begin Patch\n${changes.join("\n")}\n*** End Patch\n` : "";
}

function main() {
  const texts = Object.fromEntries(Object.entries(FILES).map(([name, file]) =>
    [name, readFileSync(path.join(ROOT, file), "utf8")]));
  const current = Object.fromEntries(Object.entries(texts).map(([name, value]) => [name, JSON.parse(value)]));
  if (process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === "--check") {
    validateCandidateRegistration(current);
    console.log("版本登记一致：冻结清单、独立部署证明、资源来源和签名报到要求已核对；不代表线上就绪。");
  } else if (process.argv.length === 4 && process.argv[2] === "--prepare") {
    const input = JSON.parse(readFileSync(path.resolve(process.argv[3]), "utf8"));
    process.stdout.write(registrationPatch(texts, prepareCandidateRegistration(current, input)));
  } else {
    throw new Error("用法：--check，或 --prepare 已审核的公开版本材料.json（仅输出待审补丁，不写文件）");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch {
    // Do not print input values or assertion diffs: even invalid input may contain a credential.
    console.error("版本登记被拒绝：请检查公开材料中的版本、独立部署证明、资源和身份配置；没有写入文件。");
    process.exitCode = 1;
  }
}
