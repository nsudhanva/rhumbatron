-- 0016_k2_batch_failures: bounded delivery for a K2 batch that keeps failing (AGENTS.md sections
-- 20 and 42.7). The event router counts failed deliveries per (consumer, batch key). The batch key
-- is the SHA-256 of the batch's first record: K2 redelivers from the oldest unacknowledged record,
-- so a batch that keeps failing keeps that key. At the limit the router records the batch in
-- `dead_letters` (queue `k2-<consumer>`), marks its events processed, and acknowledges it.
-- Rows are written only on a failure, so the table stays small.

CREATE TABLE k2_batch_failures (
  consumer TEXT NOT NULL,
  batch_key TEXT NOT NULL,
  failures INTEGER NOT NULL,
  first_failed_at TEXT NOT NULL,
  last_failed_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (consumer, batch_key)
);
