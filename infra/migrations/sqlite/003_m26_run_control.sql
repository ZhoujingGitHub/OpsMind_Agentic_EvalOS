PRAGMA foreign_keys = ON;
PRAGMA user_version = 26;

-- M2.6 adds an operator control plane. A run request may change state while it
-- is being executed; every transition is also written to the immutable ledger.
-- Trial evidence and official grader records remain append-only and separate.

CREATE TABLE IF NOT EXISTS evaluation_run_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('QUICK_VALIDATION','TARGETED_REGRESSION','FORMAL')),
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
  source_experiment_id TEXT NOT NULL REFERENCES experiments(id),
  created_experiment_id TEXT REFERENCES experiments(id),
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  selection_json TEXT NOT NULL,
  preflight_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_run_requests_status ON evaluation_run_requests(status, created_at);

CREATE TABLE IF NOT EXISTS evaluation_run_items (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES evaluation_run_requests(id),
  case_ref TEXT NOT NULL REFERENCES case_versions(case_ref),
  contestant_ref TEXT NOT NULL,
  repeat_index INTEGER NOT NULL CHECK(repeat_index > 0),
  source_trial_id TEXT REFERENCES trials(id),
  trial_id TEXT REFERENCES trials(id),
  created_at TEXT NOT NULL,
  UNIQUE(request_id, case_ref, contestant_ref, repeat_index)
);
CREATE INDEX IF NOT EXISTS idx_eval_run_items_request ON evaluation_run_items(request_id, case_ref);

CREATE TABLE IF NOT EXISTS case_selection_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dataset_ref TEXT NOT NULL REFERENCES dataset_versions(dataset_ref),
  case_refs_json TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  definition_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS regrade_requests (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  grader_ref TEXT NOT NULL,
  original_grader_run_id TEXT REFERENCES grader_runs(id),
  result_json TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_regrade_trial ON regrade_requests(trial_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS case_selection_sets_no_update BEFORE UPDATE ON case_selection_sets BEGIN SELECT RAISE(ABORT, 'case selection sets are append-only'); END;
CREATE TRIGGER IF NOT EXISTS case_selection_sets_no_delete BEFORE DELETE ON case_selection_sets BEGIN SELECT RAISE(ABORT, 'case selection sets are append-only'); END;
CREATE TRIGGER IF NOT EXISTS regrade_requests_no_update BEFORE UPDATE ON regrade_requests BEGIN SELECT RAISE(ABORT, 'regrade requests are append-only'); END;
CREATE TRIGGER IF NOT EXISTS regrade_requests_no_delete BEFORE DELETE ON regrade_requests BEGIN SELECT RAISE(ABORT, 'regrade requests are append-only'); END;
