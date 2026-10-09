-- 0009_project_cleanup: archived Projects and Artifacts fork retention (AGENTS.md section 43).
-- `archived_at` is set once by `DELETE /v1/projects/:id`. `cleaned_at` is set by the integration
-- Worker after the Project's Artifacts repos and R2 source/context objects are gone; an archived
-- Project with no `cleaned_at` still has leftovers (cost report).
-- `fork_deleted_at` marks a workspace fork (`ws-<run>`) or Candidate fork (`cand-<candidate>`) as
-- deleted, so a cleanup or sweep never spends an Artifacts operation on the same fork twice.

ALTER TABLE projects ADD COLUMN archived_at TEXT;
ALTER TABLE projects ADD COLUMN cleaned_at TEXT;
ALTER TABLE task_runs ADD COLUMN fork_deleted_at TEXT;
ALTER TABLE candidates ADD COLUMN fork_deleted_at TEXT;

CREATE INDEX idx_projects_status ON projects (status);
CREATE INDEX idx_candidates_status ON candidates (status);
