import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BudgetExceededError,
  BudgetTracker,
  CASES,
  DATASET_HASH,
  EvalStore,
  EvaluationLedger,
  TrialRunner,
  containsSensitiveMaterial,
  createMockContestant,
  redact,
  seededShuffle,
  sha256,
} from "../src/index.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const manifest = JSON.parse(readFileSync(path.join(ROOT, "config", "m1-smoke.manifest.json"), "utf8"));

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-kernel-"));
  const store = new EvalStore({
    databasePath: path.join(root, "evalos.sqlite"),
    runtimeRoot: root,
    migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m1.sql"),
  });
  const ledger = new EvaluationLedger(store);
  return { root, store, ledger };
}

test("dataset hash is frozen in the M1 manifest", () => {
  assert.equal(manifest.dataset.sha256, DATASET_HASH);
});

test("seeded scheduling is deterministic and seed-dependent", () => {
  const items = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(seededShuffle(items, 101), seededShuffle(items, 101));
  assert.notDeepEqual(seededShuffle(items, 101), seededShuffle(items, 202));
});

test("budget emits one soft warning and blocks at the hard limit", () => {
  const tracker = new BudgetTracker({ tool_calls: 10 });
  assert.deepEqual(tracker.consume({ tool_calls: 7 }), []);
  assert.equal(tracker.consume({ tool_calls: 1 }).length, 1);
  assert.deepEqual(tracker.consume({ tool_calls: 1 }), []);
  assert.throws(() => tracker.consume({ tool_calls: 1 }), BudgetExceededError);
  assert.equal(tracker.snapshot().usage.tool_calls, 9);
});

test("redaction removes secrets from nested payloads", () => {
  const input = { authorization: "Bearer top-secret-value", nested: { api_key: "fixture-secret-value", message: "use Bearer abcdefghijk" } };
  const output = redact(input);
  assert.equal(output.changed, true);
  assert.equal(containsSensitiveMaterial(output.value), false);
  assert.match(JSON.stringify(output.value), /REDACTED/);
});

test("experiment creation is idempotent, blinded, randomized, and creates 12 unique namespaces", () => {
  const { store } = fixture();
  try {
    const first = store.createExperiment(manifest, "idem-1");
    const second = store.createExperiment(manifest, "idem-1");
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.experiment.id, second.experiment.id);
    const trials = store.listTrials(first.experiment.id);
    assert.equal(trials.length, 12);
    assert.equal(new Set(trials.map((trial) => trial.namespace)).size, 12);
    assert.equal(new Set(trials.map((trial) => trial.blind_id)).size, 2);
    assert.equal(store.revealContestant(first.experiment.id, trials[0].blind_id, true).startsWith("mock-contestant"), true);
    assert.throws(() => store.revealContestant(first.experiment.id, trials[0].blind_id), /authorized/);
    const perPair = new Map();
    for (const trial of trials) {
      const key = `${trial.case_id}:${trial.seed}`;
      perPair.set(key, [...(perPair.get(key) ?? []), trial.blind_id]);
    }
    assert.equal(perPair.size, 6);
    assert.ok([...perPair.values()].every((order) => order.length === 2));
    assert.ok(new Set([...perPair.values()].map((order) => order.join(","))).size >= 2);
  } finally {
    store.close();
  }
});

test("runner recovers an expired lease and preserves attempt history", () => {
  const { store, ledger } = fixture();
  try {
    const { experiment } = store.createExperiment(manifest, "recovery-1");
    const claimed = store.claimNext("dead-runner", 1);
    store.forceExpireLease(claimed.id);
    const runner = new TrialRunner({ store, ledger, adapters: {}, cases: CASES, workerId: "new-runner" });
    assert.deepEqual(runner.recover(), [claimed.id]);
    const reclaimed = store.claimNext("new-runner", 1000);
    assert.equal(reclaimed.id, claimed.id);
    assert.equal(reclaimed.attempt, 2);
    assert.equal(store.getExperiment(experiment.id).id, experiment.id);
  } finally {
    store.close();
  }
});

test("ledger is hash-chained and database triggers reject mutation", () => {
  const { store, ledger } = fixture();
  try {
    ledger.append({ entityType: "test", entityId: "one", action: "created", payload: { value: 1 } });
    ledger.append({ entityType: "test", entityId: "two", action: "created", payload: { value: 2 } });
    assert.deepEqual(ledger.verify().valid, true);
    assert.throws(() => store.db.prepare("UPDATE ledger_entries SET action='tampered' WHERE seq=1").run(), /append-only/);
    assert.throws(() => store.db.prepare("DELETE FROM ledger_entries WHERE seq=1").run(), /append-only/);
  } finally {
    store.close();
  }
});

test("dynamic replay brain recovers from tool failure and produces a trace without a fixed sequence", async () => {
  const { store, ledger } = fixture();
  try {
    const { experiment } = store.createExperiment(manifest, "run-one");
    const trials = store.listTrials(experiment.id);
    const target = trials.find((trial) => trial.case_id === "SMOKE-RECOVERY-001");
    for (const trial of trials.filter((item) => item.id !== target.id)) {
      store.db.prepare("UPDATE trials SET status='CANCELLED' WHERE id=?").run(trial.id);
    }
    const runner = new TrialRunner({
      store,
      ledger,
      adapters: {
        "mock-contestant-a": createMockContestant("mock-contestant-a", "context-first"),
        "mock-contestant-b": createMockContestant("mock-contestant-b", "metric-first"),
      },
      cases: CASES,
    });
    await runner.runUntilIdle();
    const completed = store.getTrial(target.id);
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.score.passed, true);
    const trace = store.getTrace(target.id);
    assert.ok(trace.some((event) => event.kind === "tool.result" && event.payload.ok === false));
    assert.ok(trace.some((event) => event.kind === "tool.result" && event.payload.ok === true));
    assert.equal(containsSensitiveMaterial(trace), false);
    assert.ok(trace.some((event) => event.redacted));
    assert.equal(completed.trace_hash, store.traceSemanticHash(target.id));
    const artifact = JSON.parse(readFileSync(path.join(target.namespace, "trial-result.json"), "utf8"));
    assert.equal(artifact.model.id, "deepseek-v4-flash");
  } finally {
    store.close();
  }
});

test("Trial namespaces do not share files", () => {
  const { store } = fixture();
  try {
    const { experiment } = store.createExperiment(manifest, "isolation-1");
    const [one, two] = store.listTrials(experiment.id);
    mkdirSync(one.namespace, { recursive: true });
    mkdirSync(two.namespace, { recursive: true });
    writeFileSync(path.join(one.namespace, "sentinel.txt"), "trial-one-only");
    assert.notEqual(one.namespace, two.namespace);
    assert.notEqual(sha256(one.namespace), sha256(two.namespace));
    assert.equal(existsSync(path.join(two.namespace, "sentinel.txt")), false);
  } finally {
    store.close();
  }
});
