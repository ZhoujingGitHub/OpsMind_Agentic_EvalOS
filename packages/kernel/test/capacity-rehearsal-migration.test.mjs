import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CASES, EvalStore, PrivateLabelStore, createM15Registry } from "../src/index.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const manifest = JSON.parse(readFileSync(path.join(ROOT, "config", "m15-smoke.manifest.json"), "utf8"));
const OLD_MIGRATIONS = ["002_m25_workbench.sql", "003_m26_run_control.sql", "004_m31_candidate_relay.sql",
  "005_m31_seed_identity.sql", "006_m31_trial_attempt_audit.sql", "007_m32_run_resilience.sql",
  "008_m32_cleanup_reconciliation.sql"];

function openStore(databasePath, runtimeRoot, migrations) {
  return new EvalStore({ databasePath, runtimeRoot,
    migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m15.sql"),
    migrationPaths: migrations.map((name) => path.join(ROOT, "infra", "migrations", "sqlite", name)) });
}

test("容量演练迁移保留旧请求和子项并允许新模式", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-capacity-migration-"));
  const databasePath = path.join(root, "control.sqlite");
  const labels = new PrivateLabelStore({ databasePath: path.join(root, "private.sqlite"),
    migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_private_labels.sql") });
  const registry = createM15Registry(CASES);
  let store = openStore(databasePath, root, OLD_MIGRATIONS);
  try {
    store.publishRegistry(registry, { privateLabelHash: labels.publishRegistry(registry) });
    const source = store.createExperiment(manifest, "capacity-migration-source", { scheduleTrials: false }).experiment;
    const selection = { case_refs: [manifest.case_refs[0]], contestant_refs: [manifest.contestants[0].ref],
      environment_seeds: [manifest.environment_seeds[0]], repetitions: 1 };
    const oldRequest = store.createEvaluationRunRequest({ idempotencyKey: "before-capacity-migration",
      mode: "QUICK_VALIDATION", sourceExperimentId: source.id, requestedBy: "migration-test",
      reason: "prove old audit rows survive", selection, preflight: { ready: true } }).request;
    store.close();

    store = openStore(databasePath, root, [...OLD_MIGRATIONS, "009_m32_capacity_rehearsal.sql"]);
    const preserved = store.getEvaluationRunRequest(oldRequest.id);
    assert.equal(preserved.mode, "QUICK_VALIDATION");
    assert.equal(preserved.items.length, 1);
    const capacity = store.createEvaluationRunRequest({ idempotencyKey: "after-capacity-migration",
      mode: "CAPACITY_REHEARSAL", sourceExperimentId: source.id, requestedBy: "migration-test",
      reason: "prove the new non-scoring mode is accepted", selection,
      preflight: { ready: true, budget: { requested_concurrency: 4, effective_concurrency: 1 } } }).request;
    assert.equal(capacity.mode, "CAPACITY_REHEARSAL");
    assert.equal(capacity.items.length, 1);
  } finally {
    store.close();
    labels.close();
  }
});

