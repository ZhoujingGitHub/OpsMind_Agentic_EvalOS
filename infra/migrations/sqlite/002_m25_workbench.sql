PRAGMA foreign_keys = ON;
PRAGMA user_version = 25;

-- M2.5 introduces an investigation plane.  It is deliberately separate from
-- the official Trial/Grader tables: analysis may explain a score, but it can
-- never mutate or replace the score.

CREATE TABLE IF NOT EXISTS source_snapshots (
  snapshot_ref TEXT PRIMARY KEY,
  contestant_ref TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  tree_hash TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  file_count INTEGER NOT NULL CHECK(file_count >= 0),
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(contestant_ref, source_revision, artifact_digest)
);

CREATE TABLE IF NOT EXISTS trial_source_snapshots (
  trial_id TEXT PRIMARY KEY REFERENCES trials(id),
  snapshot_ref TEXT NOT NULL REFERENCES source_snapshots(snapshot_ref),
  attached_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  source_snapshot_ref TEXT REFERENCES source_snapshots(snapshot_ref),
  requested_by TEXT NOT NULL,
  prompt TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('case_diagnosis','score_explanation','optimization_research')),
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
  sdk TEXT NOT NULL,
  model TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_analysis_trial ON analysis_runs(trial_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_queue ON analysis_runs(status, created_at);

CREATE TABLE IF NOT EXISTS analysis_results (
  id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL UNIQUE REFERENCES analysis_runs(id),
  result_json TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_events (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id),
  seq INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  redacted INTEGER NOT NULL CHECK(redacted IN (0,1)),
  UNIQUE(analysis_run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_analysis_event_cursor ON analysis_events(analysis_run_id, row_id);

CREATE TABLE IF NOT EXISTS analysis_sources (
  id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('trial','trace','grader','source_code','artifact','methodology','web')),
  uri TEXT NOT NULL,
  title TEXT NOT NULL,
  accessed_at TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  UNIQUE(analysis_run_id, source_kind, uri, sha256)
);

CREATE TABLE IF NOT EXISTS analysis_findings (
  id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id),
  severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low','info')),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_imports (
  id TEXT PRIMARY KEY,
  source_digest TEXT NOT NULL UNIQUE,
  source_label TEXT NOT NULL,
  entity_counts_json TEXT NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS source_snapshots_no_update BEFORE UPDATE ON source_snapshots BEGIN SELECT RAISE(ABORT, 'source snapshots are append-only'); END;
CREATE TRIGGER IF NOT EXISTS source_snapshots_no_delete BEFORE DELETE ON source_snapshots BEGIN SELECT RAISE(ABORT, 'source snapshots are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trial_source_snapshots_no_update BEFORE UPDATE ON trial_source_snapshots BEGIN SELECT RAISE(ABORT, 'trial source bindings are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trial_source_snapshots_no_delete BEFORE DELETE ON trial_source_snapshots BEGIN SELECT RAISE(ABORT, 'trial source bindings are immutable'); END;
CREATE TRIGGER IF NOT EXISTS analysis_results_no_update BEFORE UPDATE ON analysis_results BEGIN SELECT RAISE(ABORT, 'analysis results are append-only'); END;
CREATE TRIGGER IF NOT EXISTS analysis_results_no_delete BEFORE DELETE ON analysis_results BEGIN SELECT RAISE(ABORT, 'analysis results are append-only'); END;
CREATE TRIGGER IF NOT EXISTS analysis_events_no_update BEFORE UPDATE ON analysis_events BEGIN SELECT RAISE(ABORT, 'analysis events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS analysis_events_no_delete BEFORE DELETE ON analysis_events BEGIN SELECT RAISE(ABORT, 'analysis events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS analysis_sources_no_update BEFORE UPDATE ON analysis_sources BEGIN SELECT RAISE(ABORT, 'analysis sources are append-only'); END;
CREATE TRIGGER IF NOT EXISTS analysis_sources_no_delete BEFORE DELETE ON analysis_sources BEGIN SELECT RAISE(ABORT, 'analysis sources are append-only'); END;
CREATE TRIGGER IF NOT EXISTS analysis_findings_no_update BEFORE UPDATE ON analysis_findings BEGIN SELECT RAISE(ABORT, 'analysis findings are append-only'); END;
CREATE TRIGGER IF NOT EXISTS analysis_findings_no_delete BEFORE DELETE ON analysis_findings BEGIN SELECT RAISE(ABORT, 'analysis findings are append-only'); END;
CREATE TRIGGER IF NOT EXISTS evidence_imports_no_update BEFORE UPDATE ON evidence_imports BEGIN SELECT RAISE(ABORT, 'evidence imports are append-only'); END;
CREATE TRIGGER IF NOT EXISTS evidence_imports_no_delete BEFORE DELETE ON evidence_imports BEGIN SELECT RAISE(ABORT, 'evidence imports are append-only'); END;
