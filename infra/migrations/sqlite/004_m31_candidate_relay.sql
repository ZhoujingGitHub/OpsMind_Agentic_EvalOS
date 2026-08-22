PRAGMA foreign_keys = ON;
PRAGMA user_version = 31;

-- The candidate relay is a transport queue, not a candidate implementation.
-- It lets a product-side worker establish an outbound HTTPS connection to
-- EvalOS while product credentials remain on the product host.
CREATE TABLE IF NOT EXISTS candidate_relay_requests (
  id TEXT PRIMARY KEY,
  candidate_ref TEXT NOT NULL,
  credential_role TEXT NOT NULL CHECK(credential_role IN ('candidate_submitter','approval_oracle','mode_administrator')),
  method TEXT NOT NULL CHECK(method IN ('GET','POST','PUT')),
  pathname TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  request_body_json TEXT,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('QUEUED','LEASED','COMPLETED','FAILED','EXPIRED')),
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  response_status INTEGER,
  response_body_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_candidate_relay_queue
  ON candidate_relay_requests(candidate_ref,status,created_at);

CREATE TABLE IF NOT EXISTS candidate_relay_nonces (
  candidate_ref TEXT NOT NULL,
  nonce TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY(candidate_ref,nonce)
);
CREATE INDEX IF NOT EXISTS idx_candidate_relay_nonce_time
  ON candidate_relay_nonces(received_at);

-- Completed transport records are evidence. Their request/response content may
-- not be rewritten or deleted; only queue and lease fields can change before
-- completion.
CREATE TRIGGER IF NOT EXISTS candidate_relay_completed_no_update
BEFORE UPDATE ON candidate_relay_requests
WHEN OLD.status IN ('COMPLETED','FAILED','EXPIRED')
BEGIN SELECT RAISE(ABORT, 'completed candidate relay records are immutable'); END;

CREATE TRIGGER IF NOT EXISTS candidate_relay_no_delete
BEFORE DELETE ON candidate_relay_requests
BEGIN SELECT RAISE(ABORT, 'candidate relay records are append-only evidence'); END;

CREATE TRIGGER IF NOT EXISTS candidate_relay_nonces_no_update
BEFORE UPDATE ON candidate_relay_nonces
BEGIN SELECT RAISE(ABORT, 'candidate relay nonces are append-only'); END;

CREATE TRIGGER IF NOT EXISTS candidate_relay_nonces_no_delete
BEFORE DELETE ON candidate_relay_nonces
BEGIN SELECT RAISE(ABORT, 'candidate relay nonces are append-only'); END;
