#!/usr/bin/env node
// 把两个考生的新版本登记进三份配置（本机，只改 config/ 下三个文件，改完看 git diff 审）。
//
//   node register-candidates.mjs <discovery.json> <proof.json> <proof-ref-prefix> <discovery-ref> [--lg-resources-changed]
//
//   discovery.json   考场只读发现的原样输出（evalos-discover.sh 落在考场 /tmp/evalos-discover.json）
//   proof.json       产品机只读部署证明（product-deployment-proof.sh 封存的那份，取回本机）
//   proof-ref-prefix 证明的封存位置与摘要，例如 m33-release-20261029:deployment-proof:<sha256>
//   discovery-ref    发现结果的封存位置与摘要，作为资源来源
//
// 指纹只从这两份材料来：提交号与镜像 ID 取部署证明，其余三个取考场自己算的发现结果。
// 资源上限默认必须与冻结清单逐项相等（脚本的规矩：登记不顺带改资源）。
// --lg-resources-changed 是例外开关，只给 2026-10-29 这一次用：LG 按决策 7 加了有限的
// 默认熔断（70 次模型 / 120 次工具 / 300 万 token），清单里那份档案要先改成产品现在公开的值。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { prepareCandidateRegistration, validateCandidateRegistration } from "../../../scripts/candidate-release-registration.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const FILES = { manifest: "config/m3-formal-agent-capability.manifest.json",
  relay: "config/candidate-relay-public-keys.json", presence: "config/candidate-presence-public-keys.json" };
const [discoveryFile, proofFile, proofRef, discoveryRef] = process.argv.slice(2);
if (!discoveryFile || !proofFile || !proofRef || !discoveryRef) {
  console.error("usage: register-candidates.mjs <discovery.json> <proof.json> <proof-ref-prefix> <discovery-ref> [--lg-resources-changed]");
  process.exit(2);
}
const discovery = JSON.parse(readFileSync(discoveryFile, "utf8"));
const proofText = readFileSync(proofFile, "utf8");
const proof = JSON.parse(proofText);
const proofSha = createHash("sha256").update(proofText).digest("hex");
if (!proofRef.includes(proofSha)) throw new Error(`proof ref must carry the proof's sha256 ${proofSha}`);
let current = Object.fromEntries(Object.entries(FILES).map(([name, file]) =>
  [name, JSON.parse(readFileSync(path.join(ROOT, file), "utf8"))]));

// Product budget limits → manifest resource vocabulary.
const DIMENSIONS = { active_duration: "max_duration_seconds", model_calls: "max_model_calls", tool_calls: "max_tool_calls",
  tokens: "max_tokens", cost: "max_cost_microunits", result_bytes: "max_result_bytes" };
function publicResources(ref, runtime) {
  if (runtime.product_budget_limits) {
    const limits = runtime.product_budget_limits;
    return { limits: { max_duration_seconds: limits.max_duration_seconds, max_model_calls: limits.max_model_calls,
      max_tool_calls: limits.max_tool_calls, max_tokens: limits.max_tokens, max_cost_microunits: limits.max_cost_microunits,
      max_result_bytes: limits.max_result_bytes },
    enforcement: Object.fromEntries(Object.values(DIMENSIONS).map((key) => [key, "enforced"])) };
  }
  const dims = runtime.job_runtime_limits?.budget_dimensions;
  if (!dims) throw new Error(`${ref}: discovery carries no public resource contract`);
  const limits = {};
  const enforcement = {};
  for (const [dimension, key] of Object.entries(DIMENSIONS)) {
    limits[key] = dims[dimension]?.limit ?? null;
    enforcement[key] = dims[dimension]?.native_enforcement ? "enforced" : "observed_only";
  }
  return { limits, enforcement };
}

const report = [];
for (const item of discovery.items) {
  const ref = item.ref;
  const observed = proof.candidates[ref];
  if (!observed) throw new Error(`${ref}: no deployment proof`);
  const sourceRevision = observed.label_revision;
  const artifactDigest = observed.image_id;
  const resources = publicResources(ref, item.discovery.runtime);
  const profile = current.manifest.candidate_resource_contract.profiles.find((entry) => entry.contestant_ref === ref);
  const resourcesChanged = !isDeepStrictEqual(profile.candidate_resources, resources.limits)
    || !isDeepStrictEqual(profile.enforcement, resources.enforcement);
  if (resourcesChanged) {
    if (!(ref === "langgraph-v1" && process.argv.includes("--lg-resources-changed"))) {
      throw new Error(`${ref}: public resources changed; this needs its own review`);
    }
    profile.candidate_resources = resources.limits;
    profile.enforcement = resources.enforcement;
    validateCandidateRegistration(current);
  }
  current = prepareCandidateRegistration(current, {
    candidate_ref: ref,
    expected_source_revision: sourceRevision,
    deployment_attestation: { contract_version: proof.contract_version, source_revision: sourceRevision,
      artifact_digest: artifactDigest, verification_method: "evalos_trusted_read_only_git_oci",
      verified_evidence_ref: `${proofRef}:${ref}` },
    discovery: { ...item.discovery, source_revision: sourceRevision, artifact_digest: artifactDigest },
    public_resource_limits: resources.limits,
    public_resource_enforcement: resources.enforcement,
    database_revision: current.presence.candidates[ref].expected_database_revision,
    resource_evidence_ref: `${discoveryRef}:${ref}${resourcesChanged ? ":public-resource-contract-changed" : ":public-resource-contract-unchanged"}`,
  });
  report.push({ ref, source_revision: sourceRevision, artifact_digest: artifactDigest, resources_changed: resourcesChanged });
}
validateCandidateRegistration(current);
for (const [name, file] of Object.entries(FILES)) {
  writeFileSync(path.join(ROOT, file), `${JSON.stringify(current[name], null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 1));
