import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { entityId, isoNow, parseJson, seedFromString, seededShuffle, sha256, stableStringify } from "./utils.mjs";
import { redact } from "./redaction.mjs";

function hydrateExperiment(row) {
  if (!row) return null;
  return { ...row, manifest: parseJson(row.manifest_json) };
}

function hydrateTrial(row) {
  if (!row) return null;
  return {
    ...row,
    budget: parseJson(row.budget_json, {}),
    usage: parseJson(row.usage_json, null),
    outcome: parseJson(row.outcome_json, null),
    score: parseJson(row.score_json, null),
  };
}

export class EvalStore {
  constructor({ databasePath, migrationPath, runtimeRoot }) {
    this.databasePath = path.resolve(databasePath);
    this.runtimeRoot = path.resolve(runtimeRoot);
    mkdirSync(path.dirname(this.databasePath), { recursive: true });
    mkdirSync(this.runtimeRoot, { recursive: true });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec(readFileSync(migrationPath, "utf8"));
  }

  close() {
    this.db.close();
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createExperiment(manifest, idempotencyKey) {
    const configHash = sha256(manifest);
    const existing = this.db.prepare("SELECT * FROM experiments WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) {
      if (existing.config_hash !== configHash) throw new Error("idempotency key reused with different manifest");
      return { experiment: hydrateExperiment(existing), created: false };
    }

    return this.transaction(() => {
      const now = isoNow();
      const id = entityId("exp", `${idempotencyKey}:${configHash}`);
      this.db.prepare(`
        INSERT INTO experiments(id,name,status,idempotency_key,config_hash,manifest_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)
      `).run(id, manifest.name, "QUEUED", idempotencyKey, configHash, stableStringify(manifest), now, now);

      const contestantOrder = seededShuffle(manifest.contestants, seedFromString(`${id}:blind-map`));
      const blindLabels = ["candidate-amber", "candidate-cobalt"];
      contestantOrder.forEach((contestant, index) => {
        this.db.prepare(`
          INSERT INTO contestant_blinds(experiment_id,blind_id,contestant_id,display_order)
          VALUES(?,?,?,?)
        `).run(id, blindLabels[index], contestant.id, index + 1);
      });
      const blinds = this.listBlinds(id);

      const pairs = [];
      for (const caseId of manifest.cases) {
        for (const seed of manifest.seeds) pairs.push({ caseId, seed });
      }
      const scheduledPairs = seededShuffle(pairs, seedFromString(`${id}:pair-order`));
      let runOrder = 1;
      for (const pair of scheduledPairs) {
        const orderedBlinds = seededShuffle(blinds, seedFromString(`${id}:${pair.caseId}:${pair.seed}:ab-order`));
        for (const blind of orderedBlinds) {
          const trialKey = `${id}:${pair.caseId}:${pair.seed}:${blind.blind_id}`;
          const trialId = entityId("trial", trialKey);
          const namespace = path.join(this.runtimeRoot, "experiments", id, "trials", trialId);
          this.db.prepare(`
            INSERT INTO trials(
              id,idempotency_key,experiment_id,case_id,seed,blind_id,contestant_id,run_order,status,
              namespace,budget_json,created_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            trialId,
            trialKey,
            id,
            pair.caseId,
            pair.seed,
            blind.blind_id,
            blind.contestant_id,
            runOrder,
            "QUEUED",
            namespace,
            stableStringify(manifest.budget),
            now,
          );
          runOrder += 1;
        }
      }
      return { experiment: this.getExperiment(id), created: true };
    });
  }

  getExperiment(id) {
    return hydrateExperiment(this.db.prepare("SELECT * FROM experiments WHERE id = ?").get(id));
  }

  listExperiments() {
    return this.db.prepare("SELECT * FROM experiments ORDER BY created_at DESC").all().map(hydrateExperiment);
  }

  setExperimentStatus(id, status) {
    const now = isoNow();
    const startedAt = status === "RUNNING" ? now : null;
    const completedAt = ["COMPLETED", "FAILED"].includes(status) ? now : null;
    this.db.prepare(`
      UPDATE experiments SET status=?, updated_at=?,
        started_at=COALESCE(started_at, ?), completed_at=COALESCE(?, completed_at)
      WHERE id=?
    `).run(status, now, startedAt, completedAt, id);
  }

  listBlinds(experimentId) {
    return this.db.prepare(`
      SELECT experiment_id,blind_id,contestant_id,display_order
      FROM contestant_blinds WHERE experiment_id=? ORDER BY display_order
    `).all(experimentId);
  }

  revealContestant(experimentId, blindId, authorized = false) {
    if (!authorized) throw new Error("blind identity reveal requires authorized=true");
    return this.db.prepare("SELECT contestant_id FROM contestant_blinds WHERE experiment_id=? AND blind_id=?").get(experimentId, blindId)?.contestant_id;
  }

  listTrials(experimentId = null, { includeReplays = true } = {}) {
    const filters = [];
    const params = [];
    if (experimentId) {
      filters.push("experiment_id = ?");
      params.push(experimentId);
    }
    if (!includeReplays) filters.push("replay_of IS NULL");
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM trials ${where} ORDER BY run_order, created_at`).all(...params).map(hydrateTrial);
  }

  getTrial(id) {
    return hydrateTrial(this.db.prepare("SELECT * FROM trials WHERE id=?").get(id));
  }

  recoverExpiredLeases(now = isoNow()) {
    const expired = this.db.prepare(`
      SELECT id FROM trials WHERE status='RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
    `).all(now).map((row) => row.id);
    if (expired.length) {
      this.db.prepare(`
        UPDATE trials SET status='QUEUED', lease_owner=NULL, lease_expires_at=NULL, error='recovered expired runner lease'
        WHERE status='RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
      `).run(now);
    }
    return expired;
  }

  claimNext(workerId, leaseMs = 30000) {
    return this.transaction(() => {
      this.recoverExpiredLeases();
      const row = this.db.prepare(`
        SELECT * FROM trials WHERE status='QUEUED' ORDER BY run_order, created_at LIMIT 1
      `).get();
      if (!row) return null;
      const now = isoNow();
      const expires = new Date(Date.now() + leaseMs).toISOString();
      this.db.prepare(`
        UPDATE trials SET status='RUNNING', lease_owner=?, lease_expires_at=?, attempt=attempt+1,
          started_at=COALESCE(started_at, ?), error=NULL WHERE id=? AND status='QUEUED'
      `).run(workerId, expires, now, row.id);
      return this.getTrial(row.id);
    });
  }

  heartbeat(trialId, workerId, leaseMs = 30000) {
    const expires = new Date(Date.now() + leaseMs).toISOString();
    const result = this.db.prepare(`
      UPDATE trials SET lease_expires_at=? WHERE id=? AND status='RUNNING' AND lease_owner=?
    `).run(expires, trialId, workerId);
    if (result.changes !== 1) throw new Error(`trial lease lost: ${trialId}`);
  }

  forceExpireLease(trialId) {
    this.db.prepare("UPDATE trials SET lease_expires_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", trialId);
  }

  appendTrace(trialId, kind, actor, payload) {
    const seq = Number(this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM trace_events WHERE trial_id=?").get(trialId).seq);
    const sanitized = redact(payload);
    const payloadHash = sha256(sanitized.value);
    const timestamp = isoNow();
    const eventId = entityId("evt", `${trialId}:${seq}:${kind}:${payloadHash}`);
    const result = this.db.prepare(`
      INSERT INTO trace_events(event_id,trial_id,seq,timestamp,kind,actor,payload_json,payload_hash,redacted)
      VALUES(?,?,?,?,?,?,?,?,?)
    `).run(eventId, trialId, seq, timestamp, kind, actor, stableStringify(sanitized.value), payloadHash, sanitized.changed ? 1 : 0);
    return {
      row_id: Number(result.lastInsertRowid),
      event_id: eventId,
      trial_id: trialId,
      seq,
      timestamp,
      kind,
      actor,
      payload: sanitized.value,
      payload_hash: payloadHash,
      redacted: sanitized.changed,
    };
  }

  getTrace(trialId, { after = 0, limit = 1000 } = {}) {
    return this.db.prepare(`
      SELECT * FROM trace_events WHERE trial_id=? AND row_id>? ORDER BY row_id LIMIT ?
    `).all(trialId, after, limit).map((row) => ({
      ...row,
      payload: parseJson(row.payload_json, {}),
      redacted: Boolean(row.redacted),
    }));
  }

  traceSemanticHash(trialId) {
    const semantic = this.getTrace(trialId).map((event) => ({
      seq: event.seq,
      kind: event.kind,
      actor: event.actor,
      payload: event.payload,
      redacted: event.redacted,
    }));
    return sha256(semantic);
  }

  completeTrial(trialId, { usage, outcome, score, traceHash }) {
    this.db.prepare(`
      UPDATE trials SET status='COMPLETED', usage_json=?, outcome_json=?, score_json=?, trace_hash=?,
        completed_at=?, lease_owner=NULL, lease_expires_at=NULL WHERE id=?
    `).run(stableStringify(usage), stableStringify(outcome), stableStringify(score), traceHash, isoNow(), trialId);
  }

  failTrial(trialId, error, usage = null) {
    this.db.prepare(`
      UPDATE trials SET status='FAILED', error=?, usage_json=?, completed_at=?, lease_owner=NULL, lease_expires_at=NULL
      WHERE id=?
    `).run(String(error), usage ? stableStringify(usage) : null, isoNow(), trialId);
  }

  addArtifact(trialId, kind, artifactPath, digest, sizeBytes) {
    const id = entityId("artifact", `${trialId}:${kind}:${digest}`);
    this.db.prepare(`
      INSERT OR IGNORE INTO artifacts(id,trial_id,kind,path,sha256,size_bytes,created_at) VALUES(?,?,?,?,?,?,?)
    `).run(id, trialId, kind, artifactPath, digest, sizeBytes, isoNow());
    return id;
  }

  createReplay(sourceTrialId, replayIndex = 1) {
    const source = this.getTrial(sourceTrialId);
    if (!source) throw new Error(`source trial not found: ${sourceTrialId}`);
    const key = `replay:${sourceTrialId}:${replayIndex}`;
    const existing = this.db.prepare("SELECT * FROM trials WHERE idempotency_key=?").get(key);
    if (existing) return hydrateTrial(existing);
    const id = entityId("replay", key);
    const namespace = path.join(this.runtimeRoot, "experiments", source.experiment_id, "replays", id);
    const nextOrder = Number(this.db.prepare("SELECT COALESCE(MAX(run_order),0)+1 AS value FROM trials").get().value);
    this.db.prepare(`
      INSERT INTO trials(
        id,idempotency_key,experiment_id,case_id,seed,blind_id,contestant_id,run_order,status,namespace,
        budget_json,replay_of,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      key,
      source.experiment_id,
      source.case_id,
      source.seed,
      source.blind_id,
      source.contestant_id,
      nextOrder,
      "QUEUED",
      namespace,
      source.budget_json,
      sourceTrialId,
      isoNow(),
    );
    return this.getTrial(id);
  }

  experimentSummary(experimentId) {
    const trials = this.listTrials(experimentId);
    const originals = trials.filter((trial) => !trial.replay_of);
    const replays = trials.filter((trial) => trial.replay_of);
    const completed = originals.filter((trial) => trial.status === "COMPLETED").length;
    return {
      experiment: this.getExperiment(experimentId),
      trial_count: originals.length,
      completed_trials: completed,
      failed_trials: originals.filter((trial) => trial.status === "FAILED").length,
      completion_rate: originals.length ? completed / originals.length : 0,
      replay_count: replays.length,
      replay_rate: originals.length ? replays.length / originals.length : 0,
      average_score: originals.length
        ? originals.reduce((sum, trial) => sum + Number(trial.score?.total ?? 0), 0) / originals.length
        : 0,
    };
  }
}

