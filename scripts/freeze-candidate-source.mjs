// Freeze the source of the exact candidate version the exam registered, for
// the read-only AI investigator.
//
//   node scripts/freeze-candidate-source.mjs agent-harness-v2 [out-dir]
//   node scripts/freeze-candidate-source.mjs langgraph-v1 [out-dir]
//
// The revision comes from the frozen exam manifest, and the files come from
// `git archive <revision>` of the product repository — never from a working
// tree, which may hold uncommitted edits or Windows line endings. The output is
// a content-addressed directory (manifest.json + files/) that
// scripts/register-candidate-source.mjs registers on the exam host; the API
// then binds each trial to the snapshot whose revision and artifact digest are
// exactly the ones that ran it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { freezeSourceSnapshot } from "../packages/kernel/src/index.mjs";

const root = path.resolve(import.meta.dirname, "..");
const productParent = path.resolve(root, "..");
const PRODUCTS = Object.freeze({
  "agent-harness-v2": { repository: process.env.EVALOS_AGENT_HARNESS_SOURCE_ROOT ?? path.join(productParent, "OpsMind"),
    roots: [["services/agent-service/src", "agent-harness/services/agent-service/src"],
      ["services/agent-service/opsmind-plugin", "agent-harness/opsmind-plugin"],
      ["shared/opsmind_data", "agent-harness/shared/opsmind_data"]] },
  // The LangGraph code lives in its migrated candidate tree, not the outer clone.
  "langgraph-v1": { repository: process.env.EVALOS_LANGGRAPH_SOURCE_ROOT
      ?? path.join(productParent, "OpsMind-LangGraph", "runtime", "codex-migration-20260903", "candidates", "report-evidence"),
    roots: [["src", "langgraph/src"], ["knowledge_packs", "langgraph/knowledge_packs"]] },
});

const [contestantRef, outDir = path.join(root, ".deploy", "source-snapshots")] = process.argv.slice(2);
const product = PRODUCTS[contestantRef];
if (!product) throw new Error(`usage: freeze-candidate-source.mjs <${Object.keys(PRODUCTS).join("|")}> [out-dir]`);
const manifest = JSON.parse(readFileSync(path.join(root, "config", "m3-formal-agent-capability.manifest.json"), "utf8"));
const contestant = manifest.contestants.find((item) => item.ref === contestantRef);
if (!contestant?.source_revision || !contestant?.artifact_digest) throw new Error(`${contestantRef} is not registered in the frozen manifest`);

const checkout = mkdtempSync(path.join(os.tmpdir(), "evalos-candidate-source-"));
try {
  const archive = execFileSync("git", ["-C", product.repository, "archive", "--format=tar", contestant.source_revision,
    ...product.roots.map(([source]) => source)], { maxBuffer: 256 * 1024 * 1024 });
  // Extract from stdin with a relative target: GNU tar reads "D:..." as host:path.
  execFileSync("tar", ["-xf", "-"], { cwd: checkout, input: archive });
  const snapshot = freezeSourceSnapshot({ roots: product.roots.map(([source, prefix]) => ({ path: path.join(checkout, source), prefix })),
    storageRoot: outDir, contestantRef, sourceRevision: contestant.source_revision, artifactDigest: contestant.artifact_digest });
  console.log(JSON.stringify({ status: "FROZEN", contestant_ref: contestantRef, source_revision: contestant.source_revision,
    artifact_digest: contestant.artifact_digest, tree_hash: snapshot.tree_hash, file_count: snapshot.file_count,
    size_bytes: snapshot.size_bytes, storage_path: snapshot.storage_path }, null, 2));
} finally {
  rmSync(checkout, { recursive: true, force: true });
}
