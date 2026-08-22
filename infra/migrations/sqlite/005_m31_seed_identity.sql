PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

-- A Trial is identified by Case + Seed + replicate + blind contestant.  The
-- earlier index accidentally omitted Seed, so two legitimate environments
-- were treated as the same Trial.
DROP INDEX IF EXISTS uq_primary_trial;
DROP INDEX IF EXISTS idx_trials_pair;
CREATE INDEX idx_trials_pair ON trials(experiment_id, case_ref, environment_seed, replicate_id);
CREATE UNIQUE INDEX uq_primary_trial
  ON trials(experiment_id, case_ref, environment_seed, replicate_id, blind_id)
  WHERE trial_kind='PRIMARY';

-- Run-request items must also keep Seed separate from replicate.  Rebuild the
-- M2.6 table once so old audit records are preserved while new multi-Seed
-- requests can materialize every promised Trial.
DROP INDEX IF EXISTS idx_eval_run_items_request;
ALTER TABLE evaluation_run_items RENAME TO evaluation_run_items_m26;
CREATE TABLE evaluation_run_items (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES evaluation_run_requests(id),
  case_ref TEXT NOT NULL REFERENCES case_versions(case_ref),
  contestant_ref TEXT NOT NULL,
  environment_seed INTEGER NOT NULL,
  repeat_index INTEGER NOT NULL CHECK(repeat_index > 0),
  source_trial_id TEXT REFERENCES trials(id),
  trial_id TEXT REFERENCES trials(id),
  created_at TEXT NOT NULL,
  UNIQUE(request_id, case_ref, contestant_ref, environment_seed, repeat_index)
);
INSERT INTO evaluation_run_items(
  id,request_id,case_ref,contestant_ref,environment_seed,repeat_index,source_trial_id,trial_id,created_at
)
SELECT old.id,old.request_id,old.case_ref,old.contestant_ref,
  COALESCE(
    (SELECT t.environment_seed FROM trials t WHERE t.id=old.trial_id),
    (SELECT t.environment_seed FROM trials t WHERE t.id=old.source_trial_id),
    0
  ),
  old.repeat_index,old.source_trial_id,old.trial_id,old.created_at
FROM evaluation_run_items_m26 old;
DROP TABLE evaluation_run_items_m26;
CREATE INDEX idx_eval_run_items_request
  ON evaluation_run_items(request_id, case_ref, environment_seed, repeat_index);

PRAGMA user_version = 32;
COMMIT;

PRAGMA foreign_keys = ON;
