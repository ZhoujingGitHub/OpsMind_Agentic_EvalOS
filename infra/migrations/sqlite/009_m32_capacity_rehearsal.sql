PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

-- Capacity rehearsals are deliberately separate from qualification/regression
-- and from the formally scored 480-Trial run. Rebuild the mutable control-plane
-- request table so existing requests and cancellation audit fields are kept.
DROP INDEX IF EXISTS idx_eval_run_requests_status;
CREATE TABLE evaluation_run_requests_m32_new (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('QUICK_VALIDATION','TARGETED_REGRESSION','CAPACITY_REHEARSAL','FORMAL')),
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
  completed_at TEXT,
  cancel_requested_at TEXT,
  cancel_reason TEXT
);

INSERT INTO evaluation_run_requests_m32_new(
  id,idempotency_key,request_hash,mode,status,source_experiment_id,created_experiment_id,
  requested_by,reason,selection_json,preflight_json,error,created_at,started_at,completed_at,
  cancel_requested_at,cancel_reason
)
SELECT
  id,idempotency_key,request_hash,mode,status,source_experiment_id,created_experiment_id,
  requested_by,reason,selection_json,preflight_json,error,created_at,started_at,completed_at,
  cancel_requested_at,cancel_reason
FROM evaluation_run_requests;

DROP TABLE evaluation_run_requests;
ALTER TABLE evaluation_run_requests_m32_new RENAME TO evaluation_run_requests;
CREATE INDEX idx_eval_run_requests_status ON evaluation_run_requests(status, created_at);

PRAGMA user_version = 36;
COMMIT;
PRAGMA foreign_keys = ON;
