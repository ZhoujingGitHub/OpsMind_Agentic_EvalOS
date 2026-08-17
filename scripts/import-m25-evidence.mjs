import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CASES, M2_CASES, EvalStore, EvaluationLedger, PrivateLabelStore, createEvalRegistry, entityId, isoNow, stableStringify,
} from "../packages/kernel/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.resolve(process.env.M25_RUNTIME_ROOT ?? path.join(ROOT, "runtime", "m25"));
const databasePath = path.resolve(process.env.M25_DATABASE_PATH ?? path.join(runtimeRoot, "control.sqlite"));
const labelPath = path.resolve(process.env.M25_PRIVATE_LABEL_DATABASE_PATH ?? path.join(runtimeRoot, "private", "labels.sqlite"));
const sources = JSON.parse(process.env.M25_SOURCE_DATABASES ?? "[]");
if (!Array.isArray(sources) || !sources.length) throw new Error("M25_SOURCE_DATABASES must be a JSON array of {label,path}");

const digestFile = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const store = new EvalStore({ databasePath, runtimeRoot,
  migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m15.sql"),
  migrationPaths: [path.join(ROOT, "infra", "migrations", "sqlite", "002_m25_workbench.sql")] });
const labels = new PrivateLabelStore({ databasePath: labelPath,
  migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_private_labels.sql") });
const ledger = new EvaluationLedger(store);

const copyPlans = [
  ["dataset_versions", "dataset_ref,dataset_id,version,level,classification,public_json,public_hash,private_hash,status,created_at"],
  ["case_versions", "case_ref,case_id,version,dataset_ref,public_json,runtime_json,metadata_json,public_hash,runtime_hash,created_at"],
  ["suite_versions", "suite_ref,suite_id,version,suite_type,definition_json,definition_hash,created_at"],
  ["grader_specs", "grader_ref,grader_id,version,grader_type,definition_json,definition_hash,status,created_at"],
  ["experiments", "id,name,status,idempotency_key,manifest_hash,manifest_json,suite_ref,dataset_ref,created_at,updated_at,started_at,completed_at"],
  ["contestant_blinds", "experiment_id,blind_id,contestant_ref,display_order"],
  ["trials", "id,idempotency_key,experiment_id,case_ref,environment_seed,replicate_id,blind_id,contestant_ref,run_order,trial_kind,replay_of,status,attempt,lease_owner,lease_expires_at,namespace,budget_json,error,created_at,started_at,completed_at"],
  ["trial_results", "id,trial_id,outcome_json,usage_json,final_state_json,trace_hash,result_hash,created_at"],
  ["trace_records", "record_id,trial_id,trace_id,seq,timestamp,record_type,span_id,parent_span_id,name,span_kind,actor,status,payload_json,payload_hash,redacted"],
  ["grader_runs", "id,trial_id,grader_ref,grader_type,dimension,result_json,result_hash,created_at"],
  ["judge_runs", "id,trial_id,blind_id,judge_role,judge_model,judge_ref,prompt_hash,result_json,result_hash,created_at"],
  ["artifacts", "id,trial_id,kind,path,sha256,size_bytes,created_at"],
];
const conflictPlans = [
  ["dataset_versions", "dataset_ref", "public_hash"], ["case_versions", "case_ref", "runtime_hash"],
  ["suite_versions", "suite_ref", "definition_hash"], ["grader_specs", "grader_ref", "definition_hash"],
  ["experiments", "id", "manifest_hash"], ["trial_results", "trial_id", "result_hash"],
  ["trace_records", "record_id", "payload_hash"], ["grader_runs", "id", "result_hash"],
  ["judge_runs", "id", "result_hash"], ["artifacts", "id", "sha256"],
];

try {
  const registry = createEvalRegistry({ m15Cases: CASES, m2Cases: M2_CASES });
  store.publishRegistry(registry, { privateLabelHash: labels.publishRegistry(registry) });
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    if (!source?.label || !source?.path) throw new Error("each M2.5 evidence source requires label and path");
    const absolute = path.resolve(source.path);
    const sourceDigest = digestFile(absolute);
    const prior = store.db.prepare("SELECT * FROM evidence_imports WHERE source_digest=?").get(sourceDigest);
    if (prior) { console.log(JSON.stringify({ source: source.label, status: "ALREADY_IMPORTED", digest: sourceDigest })); continue; }
    const schema = `src_${index}`;
    store.db.exec(`ATTACH DATABASE '${absolute.replaceAll("'", "''")}' AS ${schema}`);
    try {
      const sourceLedger = store.db.prepare(`SELECT entry_hash FROM ${schema}.ledger_entries ORDER BY seq DESC LIMIT 1`).get();
      for (const [table, key, digest] of conflictPlans) {
        const sourceTable = store.db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(table);
        if (!sourceTable) continue;
        const conflict = store.db.prepare(`SELECT target.${key} id FROM ${table} target JOIN ${schema}.${table} source
          ON target.${key}=source.${key} WHERE target.${digest}<>source.${digest} LIMIT 1`).get();
        if (conflict) throw new Error(`immutable evidence conflict in ${table}: ${conflict.id}`);
      }
      const counts = {};
      store.transaction(() => {
        for (const [table, columns] of copyPlans) {
          const sourceTable = store.db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(table);
          if (!sourceTable) continue;
          const before = Number(store.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count);
          store.db.exec(`INSERT OR IGNORE INTO ${table}(${columns}) SELECT ${columns} FROM ${schema}.${table}`);
          counts[table] = Number(store.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count) - before;
        }
        const id = entityId("evidence-import", sourceDigest);
        store.db.prepare("INSERT INTO evidence_imports(id,source_digest,source_label,entity_counts_json,imported_at) VALUES(?,?,?,?,?)")
          .run(id, sourceDigest, source.label, stableStringify(counts), isoNow());
      });
      ledger.append({ entityType: "evidence_import", entityId: entityId("evidence-import", sourceDigest), action: "evidence.imported",
        payload: { source_label: source.label, source_digest: sourceDigest, source_ledger_head: sourceLedger?.entry_hash ?? null,
          counts, provenance: "immutable M2 control-plane database" } });
      console.log(JSON.stringify({ source: source.label, status: "IMPORTED", digest: sourceDigest, counts }));
    } finally {
      store.db.exec(`DETACH DATABASE ${schema}`);
    }
  }
  console.log(JSON.stringify({ status: "PASSED", database_path: databasePath, experiments: store.listExperiments().length,
    trials: store.listTrials().length, trace_records: Number(store.db.prepare("SELECT COUNT(*) count FROM trace_records").get().count),
    ledger: ledger.verify() }, null, 2));
} finally {
  labels.close();
  store.close();
}
