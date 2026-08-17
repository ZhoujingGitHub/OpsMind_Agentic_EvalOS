-- Deploy into a separate MySQL database owned by the grading service identity.
CREATE TABLE IF NOT EXISTS private_case_labels (
  case_ref VARCHAR(191) PRIMARY KEY,
  label_json JSON NOT NULL,
  label_hash CHAR(64) NOT NULL UNIQUE,
  created_at DATETIME(6) NOT NULL
) ENGINE=InnoDB;

-- Contestants, the control API and improvement Agents receive no grants here.
-- Grading service receives SELECT/INSERT only; UPDATE and DELETE are denied.
