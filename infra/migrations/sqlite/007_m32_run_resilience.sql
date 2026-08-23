PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

ALTER TABLE trials ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE trials ADD COLUMN cancel_reason TEXT;
ALTER TABLE evaluation_run_requests ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE evaluation_run_requests ADD COLUMN cancel_reason TEXT;

DROP TRIGGER IF EXISTS trial_attempt_results_no_update;
DROP TRIGGER IF EXISTS trial_attempt_results_no_delete;
ALTER TABLE trial_attempt_results RENAME TO trial_attempt_results_v5_old;

CREATE TABLE trial_attempt_results (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
  error TEXT,
  outcome_json TEXT,
  usage_json TEXT NOT NULL,
  final_state_json TEXT NOT NULL,
  trace_hash TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(trial_id,attempt)
);

INSERT INTO trial_attempt_results(
  id,trial_id,attempt,status,error,outcome_json,usage_json,final_state_json,trace_hash,result_hash,created_at
) SELECT id,trial_id,attempt,status,error,outcome_json,usage_json,final_state_json,trace_hash,result_hash,created_at
  FROM trial_attempt_results_v5_old;
DROP TABLE trial_attempt_results_v5_old;

CREATE INDEX idx_trial_attempt_results_trial ON trial_attempt_results(trial_id,attempt);
CREATE TRIGGER trial_attempt_results_no_update BEFORE UPDATE ON trial_attempt_results BEGIN SELECT RAISE(ABORT, 'trial attempt results are append-only'); END;
CREATE TRIGGER trial_attempt_results_no_delete BEFORE DELETE ON trial_attempt_results BEGIN SELECT RAISE(ABORT, 'trial attempt results are append-only'); END;

PRAGMA user_version = 34;
COMMIT;

PRAGMA foreign_keys = ON;
