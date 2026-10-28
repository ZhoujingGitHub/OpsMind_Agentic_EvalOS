// Register a frozen candidate source snapshot on the exam host.
//
//   node scripts/register-candidate-source.mjs <snapshot-dir>
//
// <snapshot-dir> is what scripts/freeze-candidate-source.mjs produced:
// manifest.json plus files/. Every file is re-hashed against the manifest
// before the snapshot is copied into the service's snapshot root and
// registered; a mismatch refuses the whole snapshot. Registration binds no
// trial by itself — the API binds a trial when an investigation starts, and
// only to the snapshot whose revision and artifact digest ran that trial.
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { openControlStore } from "../packages/kernel/src/index.mjs";

const source = path.resolve(process.argv[2] ?? "");
const manifestPath = path.join(source, "manifest.json");
if (!existsSync(manifestPath)) throw new Error("usage: register-candidate-source.mjs <snapshot-dir with manifest.json>");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.contract !== "evalos-source-snapshot.1") throw new Error("not an EvalOS source snapshot");
for (const file of manifest.files) {
  const content = readFileSync(path.join(source, "files", ...file.path.split("/")));
  if (createHash("sha256").update(content).digest("hex") !== file.sha256) throw new Error(`snapshot file changed: ${file.path}`);
}
const runtimeRoot = path.resolve(process.env.EVALOS_RUNTIME_ROOT ?? "/var/lib/opsmind-evalos/runtime");
const databasePath = path.resolve(process.env.EVALOS_DATABASE_PATH ?? "/var/lib/opsmind-evalos/control/control.sqlite");
const destination = path.join(path.resolve(process.env.EVALOS_SOURCE_SNAPSHOT_ROOT ?? path.join(runtimeRoot, "source-snapshots")),
  manifest.tree_hash);
if (!existsSync(destination)) cpSync(source, destination, { recursive: true });
const store = openControlStore({ databasePath, runtimeRoot });
try {
  const registered = store.registerSourceSnapshot({ contestantRef: manifest.contestant_ref, sourceRevision: manifest.source_revision,
    artifactDigest: manifest.artifact_digest, treeHash: manifest.tree_hash, storagePath: destination, files: manifest.files });
  console.log(JSON.stringify({ status: "REGISTERED", snapshot_ref: registered.snapshot_ref, contestant_ref: registered.contestant_ref,
    source_revision: registered.source_revision, file_count: registered.file_count, storage_path: destination }, null, 2));
} finally {
  store.close();
}
