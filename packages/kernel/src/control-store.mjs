import path from "node:path";
import { fileURLToPath } from "node:url";
import { EvalStore } from "./store.mjs";

// The control database's schema, in order. The service and every operator
// script open the store through this one list, so a script can never run
// against a schema the service has already moved past.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const CONTROL_MIGRATIONS = Object.freeze(["001_m15.sql", "002_m25_workbench.sql", "003_m26_run_control.sql",
  "004_m31_candidate_relay.sql", "005_m31_seed_identity.sql", "006_m31_trial_attempt_audit.sql",
  "007_m32_run_resilience.sql", "008_m32_cleanup_reconciliation.sql", "009_m32_capacity_rehearsal.sql",
  "010_m32_relay_transport_buffer.sql", "011_m32_relay_nonce_retention.sql", "012_m33_trial_annotations.sql"]
  .map((name) => path.join(ROOT, "infra", "migrations", "sqlite", name)));

export function openControlStore({ databasePath, runtimeRoot }) {
  return new EvalStore({ databasePath, runtimeRoot, migrationPath: CONTROL_MIGRATIONS[0],
    migrationPaths: CONTROL_MIGRATIONS.slice(1) });
}
