-- 0008_approvals: human approval gate and promotion bookkeeping (AGENTS.md sections 36, 40.2, 53).
-- An approval binds one human decision to one Candidate and the exact composed tree the approver
-- saw. One decision per Candidate: the first decision is final (a rejected Candidate needs a new
-- Candidate). Only the API writes rows, after authentication and project membership checks.

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES candidates (id),
  change_id TEXT NOT NULL REFERENCES changes (id),
  project_id TEXT NOT NULL REFERENCES projects (id),
  decision TEXT NOT NULL CHECK (decision IN ('granted', 'rejected')),
  approver_user_id TEXT NOT NULL REFERENCES users (id),
  candidate_tree TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_approvals_change_id ON approvals (change_id);

-- Canonical tree the Candidate was composed on: the section 36 rule 7 tree check at promotion.
ALTER TABLE candidates ADD COLUMN base_tree TEXT;
-- Canonical Generation the Candidate produced, once promoted.
ALTER TABLE candidates ADD COLUMN promoted_generation INTEGER;
