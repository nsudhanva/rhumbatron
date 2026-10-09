-- 0015_releases: release registry (AGENTS.md sections 21.3, 37, 42.10, 60; ADR 0018).
-- A release target is the Worker that Workers Builds deploys a Project's canonical `main` to.
-- A release is one promoted Canonical Generation on its way to that Worker. Releases are runtime
-- data: a failed release is marked failed, never deleted, and recovery is a new generation.

-- No foreign key to projects: the seed row below must apply in every environment's database.
CREATE TABLE release_targets (
  project_id TEXT PRIMARY KEY,
  worker_name TEXT NOT NULL,
  -- Worker tag (Builds API `external_script_id`), not the Worker name.
  worker_tag TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Idempotency key: one release per Project and generation (`rel_<project>_<generation>`).
CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  change_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  -- The promoted commit on canonical `main`; the build for this commit is the release build.
  commit_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('queued', 'building', 'deployed', 'failed', 'smoke_failed', 'superseded')),
  build_uuid TEXT,
  version_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  failure_reason TEXT,
  evidence_id TEXT,
  evidence_r2_key TEXT,
  UNIQUE (project_id, generation)
);

CREATE INDEX idx_releases_project ON releases (project_id, generation);
CREATE INDEX idx_releases_candidate ON releases (candidate_id);
-- Notifications read finished releases in a 7-day window by status.
CREATE INDEX idx_releases_status_finished ON releases (status, finished_at);

-- Acme Shop Live on dev (Artifacts repo in rhumbatron-projects-dev). Inserted only where that
-- Project exists, so prod and fresh databases get no row. Other targets: a later migration.
INSERT INTO release_targets (project_id, worker_name, worker_tag, url, created_at)
SELECT id, 'rhumbatron-acme-shop-dev', 'aa43a6b0807144f4ac022e14547b13c5',
       'https://rhumbatron-acme-shop-dev.sudhanva.workers.dev', '2026-10-09T00:00:00.000Z'
FROM projects WHERE id = 'proj_077b581d-15b3-4f6d-b68a-6a6659cc2668';
