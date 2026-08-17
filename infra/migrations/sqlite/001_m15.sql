PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA user_version = 15;

-- Expert review is an optional evidence-strengthening layer. It is not an
-- acceptance, execution or ranking prerequisite.

CREATE TABLE IF NOT EXISTS dataset_versions (
  dataset_ref TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  version TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('L0','L1','L2','L3','L4')),
  classification TEXT NOT NULL,
  public_json TEXT NOT NULL,
  public_hash TEXT NOT NULL,
  private_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('DRAFT','FROZEN','RETIRED')),
  created_at TEXT NOT NULL,
  UNIQUE(dataset_id, version)
);

CREATE TABLE IF NOT EXISTS case_versions (
  case_ref TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  version TEXT NOT NULL,
  dataset_ref TEXT NOT NULL REFERENCES dataset_versions(dataset_ref),
  public_json TEXT NOT NULL,
  runtime_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  public_hash TEXT NOT NULL,
  runtime_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(case_id, version)
);

CREATE TABLE IF NOT EXISTS suite_versions (
  suite_ref TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL,
  version TEXT NOT NULL,
  suite_type TEXT NOT NULL CHECK(suite_type IN ('capability','regression','safety','calibration','hidden')),
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(suite_id, version)
);

CREATE TABLE IF NOT EXISTS grader_specs (
  grader_ref TEXT PRIMARY KEY,
  grader_id TEXT NOT NULL,
  version TEXT NOT NULL,
  grader_type TEXT NOT NULL CHECK(grader_type IN ('code','model')),
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('CALIBRATING','APPROVED','RETIRED')),
  created_at TEXT NOT NULL,
  UNIQUE(grader_id, version)
);

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
  idempotency_key TEXT NOT NULL UNIQUE,
  manifest_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  suite_ref TEXT NOT NULL REFERENCES suite_versions(suite_ref),
  dataset_ref TEXT NOT NULL REFERENCES dataset_versions(dataset_ref),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS contestant_blinds (
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  blind_id TEXT NOT NULL,
  contestant_ref TEXT NOT NULL,
  display_order INTEGER NOT NULL,
  PRIMARY KEY (experiment_id, blind_id),
  UNIQUE (experiment_id, contestant_ref)
);

CREATE TABLE IF NOT EXISTS trials (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  case_ref TEXT NOT NULL REFERENCES case_versions(case_ref),
  environment_seed INTEGER NOT NULL,
  replicate_id INTEGER NOT NULL CHECK(replicate_id > 0),
  blind_id TEXT NOT NULL,
  contestant_ref TEXT NOT NULL,
  run_order INTEGER NOT NULL,
  trial_kind TEXT NOT NULL CHECK(trial_kind IN ('PRIMARY','REPLAY')),
  replay_of TEXT REFERENCES trials(id),
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  namespace TEXT NOT NULL UNIQUE,
  budget_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_trials_queue ON trials(status, run_order, created_at);
CREATE INDEX IF NOT EXISTS idx_trials_pair ON trials(experiment_id, case_ref, replicate_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_primary_trial ON trials(experiment_id,case_ref,replicate_id,blind_id) WHERE trial_kind='PRIMARY';

CREATE TABLE IF NOT EXISTS trial_results (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL UNIQUE REFERENCES trials(id),
  outcome_json TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  final_state_json TEXT NOT NULL,
  trace_hash TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trace_records (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL UNIQUE,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  trace_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK(record_type IN ('SPAN_START','SPAN_EVENT','SPAN_END')),
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  span_kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  status TEXT,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  redacted INTEGER NOT NULL CHECK(redacted IN (0,1)),
  UNIQUE(trial_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_trace_cursor ON trace_records(trial_id, row_id);
CREATE INDEX IF NOT EXISTS idx_trace_span ON trace_records(trace_id, span_id, seq);

CREATE TABLE IF NOT EXISTS grader_runs (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  grader_ref TEXT NOT NULL,
  grader_type TEXT NOT NULL CHECK(grader_type IN ('code','model')),
  dimension TEXT NOT NULL,
  result_json TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(trial_id, grader_ref, dimension)
);

CREATE TABLE IF NOT EXISTS judge_runs (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  blind_id TEXT NOT NULL,
  judge_role TEXT NOT NULL CHECK(judge_role IN ('outcome','evidence','trajectory')),
  judge_model TEXT NOT NULL,
  judge_ref TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(trial_id, judge_role, judge_ref)
);

CREATE TABLE IF NOT EXISTS reviewers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  qualification_ref TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS human_review_tasks (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  rubric_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  priority TEXT NOT NULL CHECK(priority IN ('normal','high','critical')),
  created_at TEXT NOT NULL,
  UNIQUE(trial_id, rubric_ref, reason)
);

CREATE TABLE IF NOT EXISTS review_assignments (
  id TEXT PRIMARY KEY,
  review_task_id TEXT NOT NULL REFERENCES human_review_tasks(id),
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  assignment_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(review_task_id, reviewer_id),
  UNIQUE(review_task_id, assignment_order)
);

CREATE TABLE IF NOT EXISTS human_review_decisions (
  id TEXT PRIMARY KEY,
  review_task_id TEXT NOT NULL REFERENCES human_review_tasks(id),
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  verdict TEXT NOT NULL CHECK(verdict IN ('pass','fail','unknown','bad_case','bad_grader')),
  dimension_labels_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(review_task_id, reviewer_id)
);

CREATE TABLE IF NOT EXISTS calibration_runs (
  id TEXT PRIMARY KEY,
  judge_ref TEXT NOT NULL,
  calibration_dataset_ref TEXT NOT NULL,
  sample_count INTEGER NOT NULL,
  metrics_json TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK(passed IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calibration_latest ON calibration_runs(judge_ref,calibration_dataset_ref,created_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  trial_id TEXT REFERENCES trials(id),
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(trial_id, kind, sha256)
);

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

CREATE TRIGGER IF NOT EXISTS dataset_versions_no_update BEFORE UPDATE ON dataset_versions BEGIN SELECT RAISE(ABORT, 'dataset versions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS dataset_versions_no_delete BEFORE DELETE ON dataset_versions BEGIN SELECT RAISE(ABORT, 'dataset versions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS case_versions_no_update BEFORE UPDATE ON case_versions BEGIN SELECT RAISE(ABORT, 'case versions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS case_versions_no_delete BEFORE DELETE ON case_versions BEGIN SELECT RAISE(ABORT, 'case versions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS suite_versions_no_update BEFORE UPDATE ON suite_versions BEGIN SELECT RAISE(ABORT, 'suite versions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS suite_versions_no_delete BEFORE DELETE ON suite_versions BEGIN SELECT RAISE(ABORT, 'suite versions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS grader_specs_no_update BEFORE UPDATE ON grader_specs BEGIN SELECT RAISE(ABORT, 'grader specs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS grader_specs_no_delete BEFORE DELETE ON grader_specs BEGIN SELECT RAISE(ABORT, 'grader specs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS contestant_blinds_no_update BEFORE UPDATE ON contestant_blinds BEGIN SELECT RAISE(ABORT, 'blind maps are immutable'); END;
CREATE TRIGGER IF NOT EXISTS contestant_blinds_no_delete BEFORE DELETE ON contestant_blinds BEGIN SELECT RAISE(ABORT, 'blind maps are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trial_results_no_update BEFORE UPDATE ON trial_results BEGIN SELECT RAISE(ABORT, 'trial results are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trial_results_no_delete BEFORE DELETE ON trial_results BEGIN SELECT RAISE(ABORT, 'trial results are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trace_records_no_update BEFORE UPDATE ON trace_records BEGIN SELECT RAISE(ABORT, 'trace records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trace_records_no_delete BEFORE DELETE ON trace_records BEGIN SELECT RAISE(ABORT, 'trace records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS grader_runs_no_update BEFORE UPDATE ON grader_runs BEGIN SELECT RAISE(ABORT, 'grader runs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS grader_runs_no_delete BEFORE DELETE ON grader_runs BEGIN SELECT RAISE(ABORT, 'grader runs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS judge_runs_no_update BEFORE UPDATE ON judge_runs BEGIN SELECT RAISE(ABORT, 'judge runs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS judge_runs_no_delete BEFORE DELETE ON judge_runs BEGIN SELECT RAISE(ABORT, 'judge runs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reviewers_no_update BEFORE UPDATE ON reviewers BEGIN SELECT RAISE(ABORT, 'verified reviewer identities are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reviewers_no_delete BEFORE DELETE ON reviewers BEGIN SELECT RAISE(ABORT, 'verified reviewer identities are immutable'); END;
CREATE TRIGGER IF NOT EXISTS human_review_tasks_no_update BEFORE UPDATE ON human_review_tasks BEGIN SELECT RAISE(ABORT, 'review tasks are append-only'); END;
CREATE TRIGGER IF NOT EXISTS human_review_tasks_no_delete BEFORE DELETE ON human_review_tasks BEGIN SELECT RAISE(ABORT, 'review tasks are append-only'); END;
CREATE TRIGGER IF NOT EXISTS review_assignments_no_update BEFORE UPDATE ON review_assignments BEGIN SELECT RAISE(ABORT, 'review assignments are append-only'); END;
CREATE TRIGGER IF NOT EXISTS review_assignments_no_delete BEFORE DELETE ON review_assignments BEGIN SELECT RAISE(ABORT, 'review assignments are append-only'); END;
CREATE TRIGGER IF NOT EXISTS human_review_decisions_no_update BEFORE UPDATE ON human_review_decisions BEGIN SELECT RAISE(ABORT, 'human review decisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS human_review_decisions_no_delete BEFORE DELETE ON human_review_decisions BEGIN SELECT RAISE(ABORT, 'human review decisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS calibration_runs_no_update BEFORE UPDATE ON calibration_runs BEGIN SELECT RAISE(ABORT, 'calibration runs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS calibration_runs_no_delete BEFORE DELETE ON calibration_runs BEGIN SELECT RAISE(ABORT, 'calibration runs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS artifacts_no_update BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT, 'artifacts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS artifacts_no_delete BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT, 'artifacts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'evaluation ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'evaluation ledger is append-only'); END;
