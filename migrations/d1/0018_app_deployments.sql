-- 0018_app_deployments: live app pointers (Phase 16, ADR 0020). Runtime data, written by the
-- integration Worker and read by the apps router (prod). Dev applies it too and leaves it empty:
-- dev hosts no apps.
--
-- One row per Project and channel. `production` serves `<slug>.rhumbatron.com`; a preview channel
-- `preview:<id>` serves `<id>--<slug>.rhumbatron.com` (milestone B). Moving a pointer is one
-- UPDATE of `commit_sha` and `bundle_key`. Bundles stay in R2 under `bundle_key`, so a rollback
-- needs no rebuild.

CREATE TABLE app_deployments (
  project_id TEXT NOT NULL,
  -- Host label. Unique per channel across all Projects (slugs are unique per organization only).
  slug TEXT NOT NULL,
  channel TEXT NOT NULL,
  -- The commit that the pointer serves, or that is building when no bundle exists yet.
  commit_sha TEXT,
  generation INTEGER,
  -- R2 prefix of the bundle: `apps/<project>/<commit>`. Null until the first build succeeds.
  bundle_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed', 'removed')),
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, channel)
);

-- The router's only query: host label plus channel.
CREATE UNIQUE INDEX idx_app_deployments_host ON app_deployments (slug, channel);
