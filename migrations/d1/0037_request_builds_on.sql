-- destructive: reviewed
-- request_conflicts: the verdict adds `builds_on` (the later request builds on what the earlier
-- request creates, so it waits and plans on the tree that has that work). SQLite cannot change a
-- CHECK constraint in place: the table is rebuilt with every row. No table references this one.
CREATE TABLE request_conflicts_next (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  change_a TEXT NOT NULL,
  change_b TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0 CHECK (round >= 0),
  verdict TEXT NOT NULL CHECK (
    verdict IN ('independent', 'compatible', 'builds_on', 'conflicting', 'duplicate')
  ),
  criteria_json TEXT NOT NULL DEFAULT '[]',
  review_json TEXT,
  policy TEXT,
  winner_change_id TEXT,
  loser_change_id TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (change_a, change_b, round)
);
INSERT INTO request_conflicts_next
  (id, project_id, change_a, change_b, round, verdict, criteria_json, review_json, policy,
   winner_change_id, loser_change_id, decided_by, decided_at, created_at)
  SELECT id, project_id, change_a, change_b, round, verdict, criteria_json, review_json, policy,
    winner_change_id, loser_change_id, decided_by, decided_at, created_at
  FROM request_conflicts;
DROP TABLE request_conflicts;
ALTER TABLE request_conflicts_next RENAME TO request_conflicts;
CREATE INDEX request_conflicts_project ON request_conflicts (project_id, created_at);
