-- 0025_candidate_selection: acceptance results and sibling selection of Candidates (ADR 0026).
--
-- `acceptance_json`: the acceptance check result per criterion, as
--   [{ "criterion", "status": "met" | "not_met" | "unclear", "citations": [{ "path", "quote" }] }].
--   Null until the check ran, or when the Candidate has no acceptance check.
-- `selection_json`: sibling selection of the Candidates of one Change on one base generation.
--   The earliest Candidate of the group (created_at, id) is the anchor: one conditional UPDATE of
--   its `selection_json` from NULL claims the selection, so exactly one workflow selects. After the
--   decision every Candidate of the group holds the outcome:
--   { "status": "decided" | "escalated", "winnerCandidateId", "reason", "verdict", ... }.

ALTER TABLE candidates ADD COLUMN acceptance_json TEXT;
ALTER TABLE candidates ADD COLUMN selection_json TEXT;

CREATE INDEX idx_candidates_change_base ON candidates (change_id, base_generation);
