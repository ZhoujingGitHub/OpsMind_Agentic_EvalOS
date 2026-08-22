PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS trial_attempt_results (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('COMPLETED','FAILED')),
  error TEXT,
  outcome_json TEXT,
  usage_json TEXT NOT NULL,
  final_state_json TEXT NOT NULL,
  trace_hash TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(trial_id,attempt)
);
CREATE INDEX IF NOT EXISTS idx_trial_attempt_results_trial ON trial_attempt_results(trial_id,attempt);
CREATE TRIGGER IF NOT EXISTS trial_attempt_results_no_update BEFORE UPDATE ON trial_attempt_results BEGIN SELECT RAISE(ABORT, 'trial attempt results are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trial_attempt_results_no_delete BEFORE DELETE ON trial_attempt_results BEGIN SELECT RAISE(ABORT, 'trial attempt results are append-only'); END;

PRAGMA user_version = 33;
COMMIT;

PRAGMA foreign_keys = ON;
