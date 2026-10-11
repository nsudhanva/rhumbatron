-- 0024_intake_and_system_decisions: the system decides between requests (ADR 0025).
-- A Change can wait for its requester (`needs_input`) before or after planning. The question is
-- in `clarification_json` (ChangeClarification); answers append to `clarification_answers_json`.
-- `requester_rank` stays as a display snapshot of the requester's role. No decision reads it.

ALTER TABLE changes ADD COLUMN clarification_json TEXT;
ALTER TABLE changes ADD COLUMN clarification_answers_json TEXT NOT NULL DEFAULT '[]';

-- A Change that waited for an owner choice now waits for its requester, as a conflict question
-- about the request it conflicts with.
UPDATE changes SET
  status = 'needs_input',
  clarification_json = json_object(
    'kind', 'conflict',
    'summary', COALESCE(outcome_reason, 'This request may conflict with another request.'),
    'questions', json_array(json_object(
      'id', 'q1',
      'text', 'This request conflicts with another request. How should your request change so both fit?'
    )),
    'relatedChangeId', (
      SELECT CASE WHEN r.change_a = changes.id THEN r.change_b ELSE r.change_a END
      FROM request_conflicts r
      WHERE (r.change_a = changes.id OR r.change_b = changes.id) AND r.verdict = 'conflicting'
      ORDER BY r.created_at DESC LIMIT 1
    ),
    'relatedGoal', (
      SELECT o.goal FROM request_conflicts r
      JOIN changes o ON o.id = CASE WHEN r.change_a = changes.id THEN r.change_b ELSE r.change_a END
      WHERE (r.change_a = changes.id OR r.change_b = changes.id) AND r.verdict = 'conflicting'
      ORDER BY r.created_at DESC LIMIT 1
    ),
    'askedAt', updated_at,
    'round', 1
  )
WHERE status = 'awaiting_owner';

-- An owner choice is a not-selected outcome of the replaced request.
UPDATE changes SET outcome = 'not_selected' WHERE outcome = 'overridden';

-- request_conflicts: the verdict adds `duplicate`, and a pair is compared once per clarification
-- round of the later request (`round` 0 is the first comparison). No table references this one.
CREATE TABLE request_conflicts_next (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  change_a TEXT NOT NULL,
  change_b TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0 CHECK (round >= 0),
  verdict TEXT NOT NULL CHECK (verdict IN ('independent', 'compatible', 'conflicting', 'duplicate')),
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
  SELECT id, project_id, change_a, change_b, 0, verdict, criteria_json, review_json, policy,
    winner_change_id, loser_change_id, decided_by, decided_at, created_at
  FROM request_conflicts;
DROP TABLE request_conflicts;
ALTER TABLE request_conflicts_next RENAME TO request_conflicts;
CREATE INDEX request_conflicts_project ON request_conflicts (project_id, created_at);

-- Decision Receipts of decisions about a whole Change (no Task): the intake gate (`INTAKE`) and
-- the request arbiter (`REQUEST_ARBITER`). Inputs, votes, and citations only, never reasoning.
CREATE TABLE change_decisions (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES changes (id),
  decision_type TEXT NOT NULL CHECK (decision_type IN ('INTAKE', 'REQUEST_ARBITER')),
  round INTEGER NOT NULL CHECK (round >= 0),
  verdict TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX change_decisions_change ON change_decisions (change_id, created_at);
