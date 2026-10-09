-- 0007_candidates: Candidate composition and Evidence records (AGENTS.md sections 15.5, 33, 34).
-- A Candidate is keyed by its composition (base generation + ChangeSet IDs), so a retried request
-- cannot create a second logical Candidate (section 60).

ALTER TABLE candidates ADD COLUMN composition_key TEXT;
ALTER TABLE candidates ADD COLUMN change_set_ids_json TEXT NOT NULL DEFAULT '[]';
-- Commit and tree of the composed source in the Candidate fork (`artifact_ref`).
ALTER TABLE candidates ADD COLUMN composed_commit TEXT;
ALTER TABLE candidates ADD COLUMN composed_tree TEXT;
-- The Verification Plan (section 34.2) the Candidate was checked against.
ALTER TABLE candidates ADD COLUMN plan_json TEXT;
-- Why the Candidate is rejected or stale, for example a merge conflict. Free text for humans.
ALTER TABLE candidates ADD COLUMN status_reason TEXT;

CREATE UNIQUE INDEX idx_candidates_composition ON candidates (change_id, composition_key);

-- Section 34.3 fields the first table did not carry. Only `checked_supported` + `pass` can satisfy
-- a required check (section 34.4.1); rows written before this migration default to a gap.
ALTER TABLE evidence_index ADD COLUMN check_id TEXT;
ALTER TABLE evidence_index ADD COLUMN coverage TEXT NOT NULL DEFAULT 'not_checked'
  CHECK (coverage IN ('not_checked', 'checked_no_signal', 'checked_supported'));
ALTER TABLE evidence_index ADD COLUMN started_at TEXT;
ALTER TABLE evidence_index ADD COLUMN completed_at TEXT;
ALTER TABLE evidence_index ADD COLUMN metrics_json TEXT;
ALTER TABLE evidence_index ADD COLUMN source_refs_json TEXT NOT NULL DEFAULT '[]';
