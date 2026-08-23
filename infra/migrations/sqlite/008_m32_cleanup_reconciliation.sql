PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS trial_cleanup_reconciliations (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  attempt INTEGER NOT NULL,
  candidate_run_ref TEXT NOT NULL,
  candidate_terminal_status TEXT,
  twin_reset_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('RESOLVED','FAILED')),
  error TEXT,
  evidence_json TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(trial_id,attempt,status,record_hash)
);

CREATE INDEX IF NOT EXISTS idx_trial_cleanup_reconciliations_trial
  ON trial_cleanup_reconciliations(trial_id,attempt,created_at);
CREATE TRIGGER IF NOT EXISTS trial_cleanup_reconciliations_no_update
  BEFORE UPDATE ON trial_cleanup_reconciliations
  BEGIN SELECT RAISE(ABORT, 'trial cleanup reconciliations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trial_cleanup_reconciliations_no_delete
  BEFORE DELETE ON trial_cleanup_reconciliations
  BEGIN SELECT RAISE(ABORT, 'trial cleanup reconciliations are append-only'); END;

PRAGMA user_version = 35;
COMMIT;
