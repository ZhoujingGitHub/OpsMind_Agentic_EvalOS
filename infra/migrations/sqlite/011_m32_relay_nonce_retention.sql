PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

-- One-time nonces stop being evidence the moment they stop being checkable.
--
-- A relayed call is rejected on three grounds, in this order: the signed
-- timestamp must be within the signature window, the signature must verify,
-- and only then is the nonce looked up. A nonce older than that window can
-- therefore never be consulted again — the timestamp check refuses the request
-- long before the lookup happens. Keeping it proves nothing.
--
-- Measured on 2026-09-23, before this migration:
--   9,949,118 rows, oldest 2026-08-22
--   still inside the five-minute window: 74
--   already unusable: 9,949,044 — every single one but the last handful
-- They cost about 1.9 GB across the table and its two indexes.
--
-- The table stays append-only where that means something. Deleting a nonce
-- that is still checkable is still refused, so nobody can clear the way for a
-- replay by removing its record first. What is now permitted is deleting rows
-- that have already aged out of the window, and nothing else.
--
-- The retention floor here is one hour — twelve times the five-minute
-- signature window, so a clock skew or a long pause cannot turn a sweep into a
-- security hole. The evidence table beside this one (who called what, and the
-- hashes of what crossed the account boundary) is untouched: that is the
-- record this system exists to keep.

DROP TRIGGER IF EXISTS candidate_relay_nonces_no_delete;

CREATE TRIGGER candidate_relay_nonces_no_delete
BEFORE DELETE ON candidate_relay_nonces
WHEN OLD.received_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
BEGIN SELECT RAISE(ABORT, 'candidate relay nonces inside the replay window are append-only'); END;

-- Sweeping walks the table by arrival time; without this it is a full scan of
-- ten million rows on every pass.
CREATE INDEX IF NOT EXISTS idx_candidate_relay_nonces_received_at
  ON candidate_relay_nonces(received_at);

PRAGMA user_version = 38;
COMMIT;
