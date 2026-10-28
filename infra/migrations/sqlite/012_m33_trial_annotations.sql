PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

-- Error analysis notes on finished trials ("讲评标注").
--
-- This is open coding, not an expert verdict: who looked at a trial, whether
-- they would call it a pass, the first step it broke down in (one of the
-- grader's funnel stages), free tags and a sentence why. A first pass may be
-- written by the AI ("ai_first_pass"); a human reviewer's note on the same
-- trial is a separate row, so agreement between the two can be measured and
-- the human rows become the gold labels a future LLM judge is calibrated on.
--
-- Append-only: a later note from the same annotator supersedes an earlier
-- one when read, the earlier one is never rewritten.
CREATE TABLE IF NOT EXISTS trial_annotations (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  annotator TEXT NOT NULL,
  annotator_kind TEXT NOT NULL CHECK (annotator_kind IN ('human', 'ai_first_pass')),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'pending')),
  first_failure_gate TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trial_annotations_trial ON trial_annotations(trial_id, created_at);

CREATE TRIGGER IF NOT EXISTS trial_annotations_no_update BEFORE UPDATE ON trial_annotations
BEGIN SELECT RAISE(ABORT, 'trial annotations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trial_annotations_no_delete BEFORE DELETE ON trial_annotations
BEGIN SELECT RAISE(ABORT, 'trial annotations are append-only'); END;

PRAGMA user_version = 39;
COMMIT;
