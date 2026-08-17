PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA user_version = 15;

CREATE TABLE IF NOT EXISTS private_case_labels (
  case_ref TEXT PRIMARY KEY,
  label_json TEXT NOT NULL,
  label_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS private_case_labels_no_update
BEFORE UPDATE ON private_case_labels BEGIN SELECT RAISE(ABORT, 'private labels are append-only'); END;
CREATE TRIGGER IF NOT EXISTS private_case_labels_no_delete
BEFORE DELETE ON private_case_labels BEGIN SELECT RAISE(ABORT, 'private labels are append-only'); END;
