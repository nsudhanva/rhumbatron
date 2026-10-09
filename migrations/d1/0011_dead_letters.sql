-- 0011_dead_letters: poison commands and section 44 limit stops (AGENTS.md sections 20, 42.7, 44, 61).
--
-- `dead_letters` holds one row per command that reached `rhumbatron-dead-letter-<env>` after its
-- consumer's bounded retries. The event-router dead-letter consumer writes it; `command_id` is
-- UNIQUE, so a redelivered dead-letter message never becomes a second row. An operator retries
-- (the same command, same `command_id`, back to its original Queue) or dismisses it through the
-- API. A retried command that fails again reopens the same row (`attempt` is higher, `dead_count`
-- counts the occurrences). `payload_json` is the command envelope as received: commands carry IDs
-- and small payloads only, never secrets.

CREATE TABLE dead_letters (
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
  resolution TEXT CHECK (resolution IN ('retried', 'dismissed'))
);

-- Operator banner reads: open rows of one Project, and rows of one Change.
CREATE INDEX idx_dead_letters_project_open ON dead_letters (project_id, first_seen_at)
  WHERE resolved_at IS NULL;
CREATE INDEX idx_dead_letters_change ON dead_letters (change_id) WHERE change_id IS NOT NULL;

-- Why a Task or Change stopped or waits, named exactly (section 44 step 4).
-- `blocked_limit` is a machine key (`dead_letter`, `max_active_agents_per_change`,
-- `max_active_sandboxes_per_change`, `max_attempts_per_tier`, `daily_model_calls`);
-- `blocked_reason` is the sentence the UI shows. Both are NULL when nothing blocks the row.
ALTER TABLE tasks ADD COLUMN blocked_limit TEXT;
ALTER TABLE tasks ADD COLUMN blocked_reason TEXT;
ALTER TABLE changes ADD COLUMN blocked_limit TEXT;
ALTER TABLE changes ADD COLUMN blocked_reason TEXT;

CREATE INDEX idx_tasks_blocked_limit ON tasks (change_id) WHERE blocked_limit IS NOT NULL;
CREATE INDEX idx_changes_blocked_limit ON changes (project_id) WHERE blocked_limit IS NOT NULL;

-- Open coding workspaces per Change (section 44: max active coding Sandboxes per Change). A run's
-- workspace is open while `workspace_opened_at` is set and `workspace_closed_at` is NULL.
ALTER TABLE task_runs ADD COLUMN workspace_opened_at TEXT;
ALTER TABLE task_runs ADD COLUMN workspace_closed_at TEXT;
