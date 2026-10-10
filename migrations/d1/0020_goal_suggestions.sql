-- 0020_goal_suggestions: goal suggestion pills under the new Change goal box. Runtime data, written
-- by the agents Worker. One row per Project and Canonical Generation, so ranking costs at most one
-- Clef call per generation. An empty list is cached too and retried after one hour.

CREATE TABLE goal_suggestions (
  project_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  suggestions_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, generation)
);
