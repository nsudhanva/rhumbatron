-- 0019_app_releases: live app previews, releases, rollback, and stale recomposition (Phase 16
-- milestone B, ADR 0020). Runtime data only. Dev applies it too; its app_deployments stays empty.

-- Preview rows name their Candidate and Change, so previews are bounded per Change (3, the
-- Candidate limit) and expire with their bundles. Version rows (`preview:v<generation>`) and the
-- production row leave both NULL.
ALTER TABLE app_deployments ADD COLUMN candidate_id TEXT;
ALTER TABLE app_deployments ADD COLUMN change_id TEXT;
-- Size of the stored bundle (modules plus assets), for the cost report. NULL before this column.
ALTER TABLE app_deployments ADD COLUMN bundle_bytes INTEGER;
CREATE INDEX idx_app_deployments_change ON app_deployments (change_id)
  WHERE change_id IS NOT NULL;

-- P16-14: a Candidate composed again on a newer canonical state after it went stale. Its root
-- Candidate is `recomposed_from` (transitively); `recompose_count` is its depth (at most 2).
-- Recomposed Candidates do not count against the per-Change Candidate limit.
ALTER TABLE candidates ADD COLUMN recomposed_from TEXT;
ALTER TABLE candidates ADD COLUMN recompose_count INTEGER NOT NULL DEFAULT 0;
-- P16-13: a rollback Candidate whose tree equals the tree of this earlier generation.
ALTER TABLE candidates ADD COLUMN rollback_of_generation INTEGER;
