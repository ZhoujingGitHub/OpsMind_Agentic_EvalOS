PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

-- A relay row is append-only evidence: who called what, with which credential
-- role, and the hashes of what crossed the boundary. A large response body is
-- transport payload, not evidence, and it is what made the evidence table grow
-- to roughly 257 KB per row.
--
-- Large bodies now live here instead. This buffer is deliberately mutable and
-- deletable: the consumer removes a body as soon as it has read it, and a sweep
-- removes anything a consumer never collected. The append-only evidence row
-- keeps the SHA-256 and the original length, so the boundary record stays whole.
-- No existing row is read, changed or removed by this migration.
CREATE TABLE IF NOT EXISTS candidate_relay_response_bodies (
  request_id TEXT PRIMARY KEY REFERENCES candidate_relay_requests(id),
  body_json TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_candidate_relay_response_bodies_created_at
  ON candidate_relay_response_bodies(created_at);

PRAGMA user_version = 37;
COMMIT;
