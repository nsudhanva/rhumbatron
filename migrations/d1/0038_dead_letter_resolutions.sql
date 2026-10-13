-- destructive: reviewed
-- dead_letters: the resolution adds `succeeded` (the same command later succeeded) and `superseded`
-- (a later command of the same kind succeeded, or its Change ended). The auto-close wrote
-- `succeeded`, which the CHECK refused. SQLite cannot change a CHECK in place: the table is rebuilt
-- with every row. No table references this one.
CREATE TABLE dead_letters_next (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE,
  command_type TEXT NOT NULL,
  -- Original Queue key (`agent-wakeups` or `integration`); a retry goes back to it.
  queue TEXT NOT NULL,
  project_id TEXT,
  change_id TEXT,
  task_id TEXT,
  payload_json TEXT NOT NULL,
  error TEXT NOT NULL,
  -- Envelope `attempt` of the newest dead-lettered copy. A copy with the same or a lower attempt is
  -- a redelivery, not a new failure.
  attempt INTEGER NOT NULL DEFAULT 0,
  dead_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution TEXT CHECK (resolution IN ('retried', 'dismissed', 'succeeded', 'superseded'))
);
INSERT INTO dead_letters_next
  (id, command_id, command_type, queue, project_id, change_id, task_id, payload_json, error,
   attempt, dead_count, first_seen_at, last_seen_at, resolved_at, resolved_by, resolution)
  SELECT id, command_id, command_type, queue, project_id, change_id, task_id, payload_json, error,
    attempt, dead_count, first_seen_at, last_seen_at, resolved_at, resolved_by, resolution
  FROM dead_letters;
DROP TABLE dead_letters;
ALTER TABLE dead_letters_next RENAME TO dead_letters;
CREATE INDEX idx_dead_letters_project_open ON dead_letters (project_id, first_seen_at)
  WHERE resolved_at IS NULL;
CREATE INDEX idx_dead_letters_change ON dead_letters (change_id) WHERE change_id IS NOT NULL;
