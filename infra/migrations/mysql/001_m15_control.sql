-- OpsMind EvalOS M1.5 control-plane schema for MySQL 8.
-- Private labels MUST use a separate database/user and 001_m15_private_labels.sql.

CREATE TABLE IF NOT EXISTS dataset_versions (
  dataset_ref VARCHAR(191) PRIMARY KEY, dataset_id VARCHAR(128) NOT NULL, version VARCHAR(64) NOT NULL,
  level ENUM('L0','L1','L2','L3','L4') NOT NULL, classification VARCHAR(64) NOT NULL,
  public_json JSON NOT NULL, public_hash CHAR(64) NOT NULL, private_hash CHAR(64) NOT NULL,
  status ENUM('DRAFT','FROZEN','RETIRED') NOT NULL, created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uq_dataset_version(dataset_id,version)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS case_versions (
  case_ref VARCHAR(191) PRIMARY KEY, case_id VARCHAR(128) NOT NULL, version VARCHAR(64) NOT NULL,
  dataset_ref VARCHAR(191) NOT NULL, public_json JSON NOT NULL, runtime_json JSON NOT NULL, metadata_json JSON NOT NULL,
  public_hash CHAR(64) NOT NULL, runtime_hash CHAR(64) NOT NULL, created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uq_case_version(case_id,version), CONSTRAINT fk_case_dataset FOREIGN KEY(dataset_ref) REFERENCES dataset_versions(dataset_ref)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS suite_versions (
  suite_ref VARCHAR(191) PRIMARY KEY, suite_id VARCHAR(128) NOT NULL, version VARCHAR(64) NOT NULL,
  suite_type ENUM('capability','regression','safety','calibration','hidden') NOT NULL,
  definition_json JSON NOT NULL, definition_hash CHAR(64) NOT NULL, created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uq_suite_version(suite_id,version)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS grader_specs (
  grader_ref VARCHAR(191) PRIMARY KEY, grader_id VARCHAR(128) NOT NULL, version VARCHAR(64) NOT NULL,
  grader_type ENUM('code','model') NOT NULL, definition_json JSON NOT NULL, definition_hash CHAR(64) NOT NULL,
  status ENUM('CALIBRATING','APPROVED','RETIRED') NOT NULL, created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uq_grader_version(grader_id,version)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS experiments (
  id VARCHAR(64) PRIMARY KEY, name VARCHAR(255) NOT NULL,
  status ENUM('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED') NOT NULL,
  idempotency_key VARCHAR(191) NOT NULL UNIQUE, manifest_hash CHAR(64) NOT NULL, manifest_json JSON NOT NULL,
  suite_ref VARCHAR(191) NOT NULL, dataset_ref VARCHAR(191) NOT NULL, created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL, started_at DATETIME(6), completed_at DATETIME(6),
  CONSTRAINT fk_experiment_suite FOREIGN KEY(suite_ref) REFERENCES suite_versions(suite_ref),
  CONSTRAINT fk_experiment_dataset FOREIGN KEY(dataset_ref) REFERENCES dataset_versions(dataset_ref)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS contestant_blinds (
  experiment_id VARCHAR(64) NOT NULL, blind_id VARCHAR(64) NOT NULL, contestant_ref VARCHAR(191) NOT NULL, display_order INT NOT NULL,
  PRIMARY KEY(experiment_id,blind_id), UNIQUE KEY uq_blind_contestant(experiment_id,contestant_ref),
  CONSTRAINT fk_blind_experiment FOREIGN KEY(experiment_id) REFERENCES experiments(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trials (
  id VARCHAR(64) PRIMARY KEY, idempotency_key VARCHAR(191) NOT NULL UNIQUE, experiment_id VARCHAR(64) NOT NULL,
  case_ref VARCHAR(191) NOT NULL, environment_seed BIGINT NOT NULL, replicate_id INT NOT NULL,
  blind_id VARCHAR(64) NOT NULL, contestant_ref VARCHAR(191) NOT NULL, run_order INT NOT NULL,
  trial_kind ENUM('PRIMARY','REPLAY') NOT NULL, replay_of VARCHAR(64),
  status ENUM('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED') NOT NULL, attempt INT NOT NULL DEFAULT 0,
  lease_owner VARCHAR(128), lease_expires_at DATETIME(6), namespace VARCHAR(768) NOT NULL, budget_json JSON NOT NULL,
  error TEXT, created_at DATETIME(6) NOT NULL, started_at DATETIME(6), completed_at DATETIME(6),
  UNIQUE KEY uq_trial_namespace(namespace),
  KEY idx_trials_queue(status,run_order,created_at), KEY idx_trials_pair(experiment_id,case_ref,replicate_id),
  CONSTRAINT fk_trial_experiment FOREIGN KEY(experiment_id) REFERENCES experiments(id),
  CONSTRAINT fk_trial_case FOREIGN KEY(case_ref) REFERENCES case_versions(case_ref),
  CONSTRAINT fk_trial_replay FOREIGN KEY(replay_of) REFERENCES trials(id), CHECK(replicate_id > 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trial_results (
  id VARCHAR(64) PRIMARY KEY, trial_id VARCHAR(64) NOT NULL UNIQUE, outcome_json JSON NOT NULL, usage_json JSON NOT NULL,
  final_state_json JSON NOT NULL, trace_hash CHAR(64) NOT NULL, result_hash CHAR(64) NOT NULL, created_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_result_trial FOREIGN KEY(trial_id) REFERENCES trials(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trace_records (
  row_id BIGINT AUTO_INCREMENT PRIMARY KEY, record_id VARCHAR(64) NOT NULL UNIQUE, trial_id VARCHAR(64) NOT NULL,
  trace_id VARCHAR(64) NOT NULL, seq INT NOT NULL, timestamp DATETIME(6) NOT NULL,
  record_type ENUM('SPAN_START','SPAN_EVENT','SPAN_END') NOT NULL, span_id VARCHAR(64) NOT NULL, parent_span_id VARCHAR(64),
  name VARCHAR(191) NOT NULL, span_kind ENUM('CHAIN','AGENT','TOOL','EVALUATOR','INTERNAL') NOT NULL,
  actor VARCHAR(128) NOT NULL, status VARCHAR(32), payload_json JSON NOT NULL, payload_hash CHAR(64) NOT NULL, redacted BOOLEAN NOT NULL,
  UNIQUE KEY uq_trace_seq(trial_id,seq), KEY idx_trace_cursor(trial_id,row_id), KEY idx_trace_span(trace_id,span_id,seq),
  CONSTRAINT fk_trace_trial FOREIGN KEY(trial_id) REFERENCES trials(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS grader_runs (
  id VARCHAR(64) PRIMARY KEY, trial_id VARCHAR(64) NOT NULL, grader_ref VARCHAR(191) NOT NULL,
  grader_type ENUM('code','model') NOT NULL, dimension VARCHAR(64) NOT NULL,
  result_json JSON NOT NULL, result_hash CHAR(64) NOT NULL, created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uq_grader_run(trial_id,grader_ref,dimension), CONSTRAINT fk_grader_trial FOREIGN KEY(trial_id) REFERENCES trials(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS judge_runs (
  id VARCHAR(64) PRIMARY KEY, trial_id VARCHAR(64) NOT NULL, blind_id VARCHAR(64) NOT NULL,
  judge_role ENUM('outcome','evidence','trajectory') NOT NULL, judge_model VARCHAR(128) NOT NULL, judge_ref VARCHAR(191) NOT NULL,
  prompt_hash CHAR(64) NOT NULL, result_json JSON NOT NULL, result_hash CHAR(64) NOT NULL, created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uq_judge_run(trial_id,judge_role,judge_ref), CONSTRAINT fk_judge_trial FOREIGN KEY(trial_id) REFERENCES trials(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS reviewers (
  id VARCHAR(64) PRIMARY KEY, display_name VARCHAR(128) NOT NULL, role VARCHAR(64) NOT NULL,
  qualification_ref VARCHAR(255) NOT NULL, verified_by VARCHAR(128) NOT NULL, verified_at DATETIME(6) NOT NULL,
  credential_hash VARCHAR(191) NOT NULL UNIQUE, active BOOLEAN NOT NULL DEFAULT TRUE, created_at DATETIME(6) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS human_review_tasks (
  id VARCHAR(64) PRIMARY KEY, trial_id VARCHAR(64) NOT NULL, rubric_ref VARCHAR(191) NOT NULL, reason TEXT NOT NULL,
  priority ENUM('normal','high','critical') NOT NULL, created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uq_review_task(trial_id,rubric_ref,reason(128)), CONSTRAINT fk_review_trial FOREIGN KEY(trial_id) REFERENCES trials(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS review_assignments (
  id VARCHAR(64) PRIMARY KEY, review_task_id VARCHAR(64) NOT NULL, reviewer_id VARCHAR(64) NOT NULL,
  assignment_order INT NOT NULL, created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uq_review_reviewer(review_task_id,reviewer_id), UNIQUE KEY uq_review_order(review_task_id,assignment_order),
  CONSTRAINT fk_assignment_task FOREIGN KEY(review_task_id) REFERENCES human_review_tasks(id),
  CONSTRAINT fk_assignment_reviewer FOREIGN KEY(reviewer_id) REFERENCES reviewers(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS human_review_decisions (
  id VARCHAR(64) PRIMARY KEY, review_task_id VARCHAR(64) NOT NULL, reviewer_id VARCHAR(64) NOT NULL,
  verdict ENUM('pass','fail','unknown','bad_case','bad_grader') NOT NULL, dimension_labels_json JSON NOT NULL,
  evidence_refs_json JSON NOT NULL, rationale TEXT NOT NULL, created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uq_review_decision(review_task_id,reviewer_id),
  CONSTRAINT fk_decision_task FOREIGN KEY(review_task_id) REFERENCES human_review_tasks(id),
  CONSTRAINT fk_decision_reviewer FOREIGN KEY(reviewer_id) REFERENCES reviewers(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS calibration_runs (
  id VARCHAR(64) PRIMARY KEY, judge_ref VARCHAR(191) NOT NULL, calibration_dataset_ref VARCHAR(191) NOT NULL,
  sample_count INT NOT NULL, metrics_json JSON NOT NULL, passed BOOLEAN NOT NULL, created_at DATETIME(6) NOT NULL,
  KEY idx_calibration_latest(judge_ref,calibration_dataset_ref,created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS artifacts (
  id VARCHAR(64) PRIMARY KEY, trial_id VARCHAR(64), kind VARCHAR(64) NOT NULL, path TEXT NOT NULL,
  sha256 CHAR(64) NOT NULL, size_bytes BIGINT NOT NULL, created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uq_artifact(trial_id,kind,sha256), CONSTRAINT fk_artifact_trial FOREIGN KEY(trial_id) REFERENCES trials(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ledger_entries (
  seq BIGINT AUTO_INCREMENT PRIMARY KEY, id VARCHAR(64) NOT NULL UNIQUE, timestamp DATETIME(6) NOT NULL,
  entity_type VARCHAR(64) NOT NULL, entity_id VARCHAR(64) NOT NULL, action VARCHAR(128) NOT NULL,
  payload_json JSON NOT NULL, prev_hash CHAR(64) NOT NULL, entry_hash CHAR(64) NOT NULL UNIQUE
) ENGINE=InnoDB;

-- Production grants MUST deny UPDATE/DELETE on all version, result, trace, grader,
-- judge, optional expert review, calibration, artifact and ledger tables. MySQL permissions are
-- the authority; application code receives INSERT/SELECT only for append-only data.
