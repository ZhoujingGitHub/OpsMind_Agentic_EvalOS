PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  config_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS contestant_blinds (
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  blind_id TEXT NOT NULL,
  contestant_id TEXT NOT NULL,
  display_order INTEGER NOT NULL,
  PRIMARY KEY (experiment_id, blind_id),
  UNIQUE (experiment_id, contestant_id)
);

CREATE TABLE IF NOT EXISTS trials (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  case_id TEXT NOT NULL,
  seed INTEGER NOT NULL,
  blind_id TEXT NOT NULL,
  contestant_id TEXT NOT NULL,
  run_order INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  namespace TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  usage_json TEXT,
  outcome_json TEXT,
  score_json TEXT,
  trace_hash TEXT,
  replay_of TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_trials_queue ON trials(status, run_order, created_at);
CREATE INDEX IF NOT EXISTS idx_trials_experiment ON trials(experiment_id, case_id, seed);

CREATE TABLE IF NOT EXISTS trace_events (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  seq INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  redacted INTEGER NOT NULL,
  UNIQUE(trial_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_trace_cursor ON trace_events(trial_id, row_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  trial_id TEXT REFERENCES trials(id),
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS judge_results (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL UNIQUE REFERENCES trials(id),
  blind_id TEXT NOT NULL,
  judge_model TEXT NOT NULL,
  judge_version TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS human_review_tasks (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL UNIQUE REFERENCES trials(id),
  reason TEXT NOT NULL,
  priority TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS human_review_decisions (
  id TEXT PRIMARY KEY,
  review_task_id TEXT NOT NULL REFERENCES human_review_tasks(id),
  reviewer TEXT NOT NULL,
  decision TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_decisions_task ON human_review_decisions(review_task_id, created_at);

CREATE TABLE IF NOT EXISTS ledger_entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  timestamp TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL UNIQUE
);

CREATE TRIGGER IF NOT EXISTS ledger_no_update
BEFORE UPDATE ON ledger_entries BEGIN
  SELECT RAISE(ABORT, 'evaluation ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS ledger_no_delete
BEFORE DELETE ON ledger_entries BEGIN
  SELECT RAISE(ABORT, 'evaluation ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS judge_results_no_update
BEFORE UPDATE ON judge_results BEGIN
  SELECT RAISE(ABORT, 'judge results are append-only');
END;

CREATE TRIGGER IF NOT EXISTS judge_results_no_delete
BEFORE DELETE ON judge_results BEGIN
  SELECT RAISE(ABORT, 'judge results are append-only');
END;

CREATE TRIGGER IF NOT EXISTS human_review_tasks_no_update
BEFORE UPDATE ON human_review_tasks BEGIN
  SELECT RAISE(ABORT, 'human review tasks are append-only');
END;

CREATE TRIGGER IF NOT EXISTS human_review_tasks_no_delete
BEFORE DELETE ON human_review_tasks BEGIN
  SELECT RAISE(ABORT, 'human review tasks are append-only');
END;

CREATE TRIGGER IF NOT EXISTS human_review_decisions_no_update
BEFORE UPDATE ON human_review_decisions BEGIN
  SELECT RAISE(ABORT, 'human review decisions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS human_review_decisions_no_delete
BEFORE DELETE ON human_review_decisions BEGIN
  SELECT RAISE(ABORT, 'human review decisions are append-only');
END;
