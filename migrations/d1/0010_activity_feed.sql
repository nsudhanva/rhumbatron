-- 0010_activity_feed: per-Project event feed and live run progress (AGENTS.md sections 16.1, 39, 41).
--
-- `project_events` is a read projection of K2 events, written by the event-router
-- `project-view-projector` consumer in the same D1 batch as its dedupe claims. It is not the audit
-- log (the R2 archive is). `seq` is AUTOINCREMENT, so it never repeats or moves backward and an
-- `after` cursor cannot skip a row. `event_id` is UNIQUE, so a redelivered event is ignored.
-- Retention: the writer keeps the newest rows only (a global row cap, deleted by `seq` range).
-- Payloads are not stored: `data_json` holds a short allow-list of scalar fields.

CREATE TABLE project_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  change_id TEXT,
  task_id TEXT,
  candidate_id TEXT,
  resource TEXT,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_project_events_project_seq ON project_events (project_id, seq);
CREATE INDEX idx_project_events_change_seq ON project_events (change_id, seq)
  WHERE change_id IS NOT NULL;
-- Claims feed of one Change. Queries must repeat this WHERE term exactly to use the index.
CREATE INDEX idx_project_events_change_claims ON project_events (change_id, seq)
  WHERE event_type IN ('claim.acquired', 'claim.renewed', 'claim.released', 'claim.expired');

-- Live progress of a running attempt. AgentDO writes these at most once per model call, which is
-- already capped per run (MAX_CALLS_PER_RUN) and per day (AGENT_DAILY_CALL_CAP).
ALTER TABLE task_runs ADD COLUMN last_step TEXT;
ALTER TABLE task_runs ADD COLUMN progress_at TEXT;
