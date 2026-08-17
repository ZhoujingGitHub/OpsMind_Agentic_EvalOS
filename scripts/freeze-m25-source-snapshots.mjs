import path from "node:path";
import { fileURLToPath } from "node:url";
import { EvalStore, freezeSourceSnapshot } from "../packages/kernel/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.resolve(process.env.M25_RUNTIME_ROOT ?? path.join(ROOT, "runtime", "m25"));
const databasePath = path.resolve(process.env.M25_DATABASE_PATH ?? path.join(runtimeRoot, "control.sqlite"));
const storageRoot = path.resolve(process.env.M25_SOURCE_SNAPSHOT_ROOT ?? path.join(runtimeRoot, "source-snapshots"));
const store = new EvalStore({ databasePath, runtimeRoot,
  migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m15.sql"),
  migrationPaths: [path.join(ROOT, "infra", "migrations", "sqlite", "002_m25_workbench.sql")] });

function rootsFor(contestantRef) {
  const envName = contestantRef === "agent-harness-v2" ? "M25_AGENT_SOURCE_ROOTS" : "M25_LANGGRAPH_SOURCE_ROOTS";
  if (process.env[envName]) return JSON.parse(process.env[envName]);
  if (contestantRef === "agent-harness-v2") return [
    { path: path.join(ROOT, "packages", "agent-runtime", "src"), prefix: "agent-runtime/src" },
    { path: path.join(ROOT, "packages", "agent-runtime", "opsmind-plugin"), prefix: "opsmind-plugin" },
  ];
  if (contestantRef === "langgraph-v1" && process.env.OPSMIND_LANGGRAPH_ROOT) return [
    { path: process.env.OPSMIND_LANGGRAPH_ROOT, prefix: "langgraph-opsmind" },
    { path: path.join(ROOT, "packages", "agent-runtime", "python"), prefix: "evalos-adapter" },
  ];
  if (contestantRef === "langgraph-v1") return [
    { path: path.join(ROOT, "packages", "agent-runtime", "python"), prefix: "langgraph-opsmind" },
  ];
  throw new Error(`no explicit source roots configured for contestant: ${contestantRef}`);
}

try {
  const bindings = [];
  for (const experiment of store.listExperiments().filter((item) => item.status === "COMPLETED")) {
    for (const contestant of experiment.manifest.contestants ?? []) {
      if (!contestant.source_revision || !/^sha256:[a-f0-9]{64}$/.test(contestant.artifact_digest ?? "")) {
        throw new Error(`experiment ${experiment.id} has an unfrozen contestant artifact`);
      }
      const snapshot = freezeSourceSnapshot({ roots: rootsFor(contestant.ref), storageRoot, contestantRef: contestant.ref,
        sourceRevision: contestant.source_revision, artifactDigest: contestant.artifact_digest });
      const registered = store.registerSourceSnapshot({ contestantRef: contestant.ref, sourceRevision: contestant.source_revision,
        artifactDigest: contestant.artifact_digest, treeHash: snapshot.tree_hash, storagePath: snapshot.storage_path, files: snapshot.files });
      const trials = store.listTrials(experiment.id).filter((trial) => trial.contestant_ref === contestant.ref);
      for (const trial of trials) {
        store.attachTrialSourceSnapshot(trial.id, registered.snapshot_ref);
        bindings.push({ trial_id: trial.id, contestant_ref: contestant.ref, snapshot_ref: registered.snapshot_ref });
      }
    }
  }
  console.log(JSON.stringify({ status: "PASSED", snapshots: store.listSourceSnapshots().map((item) => ({
    snapshot_ref: item.snapshot_ref, contestant_ref: item.contestant_ref, tree_hash: item.tree_hash,
    file_count: item.file_count, size_bytes: item.size_bytes })), bindings }, null, 2));
} finally {
  store.close();
}
