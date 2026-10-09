-- 0003_work_graph: Work Graph persistence (AGENTS.md sections 15.3 and 21.1, P5-03).
-- Task status changes are conditional updates (`WHERE status = ?`), so a retried step is a no-op.

ALTER TABLE changes ADD COLUMN acceptance_criteria_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE changes ADD COLUMN invariants_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE changes ADD COLUMN work_graph_ref TEXT;

ALTER TABLE tasks ADD COLUMN task_key TEXT;
ALTER TABLE tasks ADD COLUMN title TEXT;
ALTER TABLE tasks ADD COLUMN objective TEXT;
ALTER TABLE tasks ADD COLUMN acceptance_criteria_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN semantic_resources_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN route_json TEXT;
-- Set after the wake command is sent. A crash before this write resends the wake (at least once).
ALTER TABLE tasks ADD COLUMN wake_sent_at TEXT;

-- Exact dependency edges. `depends_on_task_id` must complete before `task_id` is ready.
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks (id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks (id),
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE INDEX idx_task_dependencies_depends_on ON task_dependencies (depends_on_task_id);
CREATE UNIQUE INDEX idx_tasks_change_key ON tasks (change_id, task_key);

-- Daily caps on calls that could bill past free allowances (rule 50), for example Clef calls.
CREATE TABLE usage_counters (
  day TEXT NOT NULL,
  counter TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, counter)
);
