-- MySQL 8 deployment contract for M1. The local executable profile uses the
-- equivalent SQLite migration so G1 has no external-service prerequisite.
CREATE TABLE IF NOT EXISTS experiments (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL,
  idempotency_key VARCHAR(191) NOT NULL UNIQUE,
  config_hash CHAR(64) NOT NULL,
  manifest_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  started_at DATETIME(6),
  completed_at DATETIME(6)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS contestant_blinds (
  experiment_id VARCHAR(64) NOT NULL,
  blind_id VARCHAR(64) NOT NULL,
  contestant_id VARCHAR(128) NOT NULL,
  display_order INT NOT NULL,
  PRIMARY KEY (experiment_id, blind_id),
  UNIQUE KEY uq_blind_contestant (experiment_id, contestant_id),
  CONSTRAINT fk_blind_experiment FOREIGN KEY (experiment_id) REFERENCES experiments(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trials (
  id VARCHAR(64) PRIMARY KEY,
  idempotency_key VARCHAR(191) NOT NULL UNIQUE,
  experiment_id VARCHAR(64) NOT NULL,
  case_id VARCHAR(128) NOT NULL,
  seed BIGINT NOT NULL,
  blind_id VARCHAR(64) NOT NULL,
  contestant_id VARCHAR(128) NOT NULL,
  run_order INT NOT NULL,
  status VARCHAR(32) NOT NULL,
  attempt INT NOT NULL DEFAULT 0,
  lease_owner VARCHAR(128),
  lease_expires_at DATETIME(6),
  namespace VARCHAR(255) NOT NULL,
  budget_json JSON NOT NULL,
  usage_json JSON,
  outcome_json JSON,
  score_json JSON,
  trace_hash CHAR(64),
  replay_of VARCHAR(64),
  error TEXT,
  created_at DATETIME(6) NOT NULL,
  started_at DATETIME(6),
  completed_at DATETIME(6),
  UNIQUE KEY uq_trial_idempotency (idempotency_key),
  KEY idx_trials_queue (status, run_order, created_at),
  CONSTRAINT fk_trial_experiment FOREIGN KEY (experiment_id) REFERENCES experiments(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trace_events (
  row_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(64) NOT NULL UNIQUE,
  trial_id VARCHAR(64) NOT NULL,
  seq INT NOT NULL,
  timestamp DATETIME(6) NOT NULL,
  kind VARCHAR(64) NOT NULL,
  actor VARCHAR(64) NOT NULL,
  payload_json JSON NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  redacted BOOLEAN NOT NULL,
  UNIQUE KEY uq_trace_seq (trial_id, seq),
  KEY idx_trace_cursor (trial_id, row_id),
  CONSTRAINT fk_trace_trial FOREIGN KEY (trial_id) REFERENCES trials(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS artifacts (
  id VARCHAR(64) PRIMARY KEY,
  trial_id VARCHAR(64),
  kind VARCHAR(64) NOT NULL,
  path TEXT NOT NULL,
  sha256 CHAR(64) NOT NULL,
  size_bytes BIGINT NOT NULL,
  created_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_artifact_trial FOREIGN KEY (trial_id) REFERENCES trials(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ledger_entries (
  seq BIGINT AUTO_INCREMENT PRIMARY KEY,
  id VARCHAR(64) NOT NULL UNIQUE,
  timestamp DATETIME(6) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  action VARCHAR(64) NOT NULL,
  payload_json JSON NOT NULL,
  prev_hash CHAR(64) NOT NULL,
  entry_hash CHAR(64) NOT NULL UNIQUE
) ENGINE=InnoDB;

-- Production DB role grants INSERT and SELECT only on ledger_entries. UPDATE
-- and DELETE are deliberately absent; immutable backup/object-lock is the
-- second enforcement layer.
