// Freeze the formal exam manifest onto the current case bank and grader.
//
//   node scripts/freeze-exam-manifest.mjs           rewrite the two manifests
//   node scripts/freeze-exam-manifest.mjs --check   exit 1 if either is stale
//
// The manifest is the frozen contract an experiment is created from: which
// cases, which seeds, which grader (by source digest). Hand-editing it is how a
// release ends up claiming one grader while running another, so the fields it
// owns are derived here and checked by scripts/check-m31-architecture.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { GRADER_REF, OPS_CASE_PARTITIONS, OPS_CASE_REFS, OPS_DATASET_REF, OPS_SUITE_REF }
  from "../packages/kernel/src/index.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

// Every file that decides a verdict is in the digest. Leaving one out lets a
// changed criterion ride on an old digest.
export const GRADER_SOURCES = Object.freeze(["packages/kernel/src/grader.mjs",
  "packages/kernel/src/product-evidence-semantics.mjs", "packages/kernel/src/fault-delta.mjs"]);

export function graderSourceDigest() {
  return "sha256:" + createHash("sha256").update(GRADER_SOURCES
    .map((name) => read(name).replaceAll("\r\n", "\n")).join("\n")).digest("hex");
}

// One seed: every case runs once per candidate, 40 x 2 = 80 trials.
const EXAM_SEEDS = [2026102901];

function frozenFormal(manifest) {
  return { ...manifest,
    milestone: "M3.3",
    name: "M3.3 运维大类真注入考试冻结源（22 道 × 6 种考法 = 每考生 40 场）",
    suite_ref: OPS_SUITE_REF,
    dataset_ref: OPS_DATASET_REF,
    case_refs: [...OPS_CASE_REFS],
    case_partitions: Object.fromEntries(Object.entries(OPS_CASE_PARTITIONS).map(([key, refs]) => [key, [...refs]])),
    environment_seeds: EXAM_SEEDS,
    replicates_per_seed: 1,
    model: { ...manifest.model, id: "deepseek-flash" },
    capacity_policy: { ...manifest.capacity_policy, max_queue_depth: OPS_CASE_REFS.length * manifest.contestants.length },
    frozen_dependencies: { ...manifest.frozen_dependencies,
      grader: { ref: GRADER_REF, digest: graderSourceDigest() } } };
}

function frozenSmoke(manifest) {
  return { ...manifest, model: { ...manifest.model, id: "deepseek-flash" },
    frozen_dependencies: { ...manifest.frozen_dependencies,
    grader: { ref: GRADER_REF, digest: graderSourceDigest() } } };
}

const targets = [["config/m3-formal-agent-capability.manifest.json", frozenFormal],
  ["config/m15-smoke.manifest.json", frozenSmoke]];
const check = process.argv.includes("--check");
let stale = false;
for (const [file, freeze] of targets) {
  const current = read(file);
  const next = `${JSON.stringify(freeze(JSON.parse(current)), null, 2)}\n`;
  if (current.replaceAll("\r\n", "\n") === next) continue;
  stale = true;
  if (check) console.error(`${file} is not frozen onto the current bank and grader`);
  else writeFileSync(path.join(root, file), next);
}
if (check && stale) process.exit(1);
console.log(check ? "冻结清单与当前题库、判分代码一致" : stale ? "已重新冻结考试清单" : "考试清单本来就是最新的");
