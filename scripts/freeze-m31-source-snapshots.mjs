import path from "node:path";
import { fileURLToPath } from "node:url";
import { EvalStore, freezeSourceSnapshot } from "../packages/kernel/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCT_ROOT = path.resolve(ROOT, "..");
const runtimeRoot = path.resolve(process.env.EVALOS_RUNTIME_ROOT ?? path.join(ROOT, "runtime", "evalos"));
const databasePath = path.resolve(process.env.EVALOS_DATABASE_PATH ?? path.join(runtimeRoot, "control.sqlite"));
const storageRoot = path.resolve(process.env.EVALOS_SOURCE_SNAPSHOT_ROOT ?? path.join(runtimeRoot, "source-snapshots"));
const store = new EvalStore({ databasePath, runtimeRoot,
  migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m15.sql"),
  migrationPaths: [path.join(ROOT, "infra", "migrations", "sqlite", "002_m25_workbench.sql"),
    path.join(ROOT, "infra", "migrations", "sqlite", "003_m26_run_control.sql")] });

function existingRoots(items) {
  return items.map((item) => ({ ...item, path: path.resolve(item.path) }));
}

function rootsFor(contestantRef) {
  if (contestantRef === "agent-harness-v2") {
    const product = path.resolve(process.env.EVALOS_AGENT_HARNESS_SOURCE_ROOT ?? path.join(PRODUCT_ROOT, "OpsMind"));
    return existingRoots([
      { path: path.join(product, "services", "agent-service", "src"), prefix: "agent-harness/services/agent-service/src" },
      { path: path.join(product, "services", "agent-service", "opsmind-plugin"), prefix: "agent-harness/opsmind-plugin" },
      { path: path.join(product, "shared", "opsmind_data"), prefix: "agent-harness/shared/opsmind_data" },
    ]);
  }
  if (contestantRef === "langgraph-v1") {
    const product = path.resolve(process.env.EVALOS_LANGGRAPH_SOURCE_ROOT ?? path.join(PRODUCT_ROOT, "OpsMind-LangGraph"));
    return existingRoots([
      { path: path.join(product, "src"), prefix: "langgraph/src" },
      { path: path.join(product, "knowledge_packs"), prefix: "langgraph/knowledge_packs" },
    ]);
  }
  throw new Error(`M3.1 real-product snapshot refuses unknown contestant: ${contestantRef}`);
}

try {
  const bindings = [];
  for (const experiment of store.listExperiments().filter((item) => item.status === "COMPLETED"
    && item.manifest.run_class === "REAL_CANDIDATE")) {
    for (const contestant of experiment.manifest.contestants ?? []) {
      if (contestant.kind !== "REAL_PRODUCT") throw new Error("real-product snapshot cannot bind a test double");
      const snapshot = freezeSourceSnapshot({ roots: rootsFor(contestant.ref), storageRoot, contestantRef: contestant.ref,
        sourceRevision: contestant.source_revision, artifactDigest: contestant.artifact_digest });
      const registered = store.registerSourceSnapshot({ contestantRef: contestant.ref, sourceRevision: contestant.source_revision,
        artifactDigest: contestant.artifact_digest, treeHash: snapshot.tree_hash, storagePath: snapshot.storage_path, files: snapshot.files });
      for (const trial of store.listTrials(experiment.id).filter((item) => item.contestant_ref === contestant.ref)) {
        store.attachTrialSourceSnapshot(trial.id, registered.snapshot_ref);
        bindings.push({ trial_id: trial.id, contestant_ref: contestant.ref, snapshot_ref: registered.snapshot_ref });
      }
    }
  }
  console.log(JSON.stringify({ status: "PASSED", source_access: "READ_ONLY_EXTERNAL_PRODUCTS",
    product_code_modified: false, bindings }, null, 2));
} finally {
  store.close();
}
