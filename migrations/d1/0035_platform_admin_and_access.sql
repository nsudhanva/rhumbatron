-- 0035_platform_admin_and_access: sign-up approval, the platform admin audit, and the indexes of the
-- admin and user cost reads (ADR 0033).
--
-- platform_settings: one row per platform setting. Key `signup_approval_required` holds "true" or
-- "false". A missing row means false. Only `PATCH /v1/admin/settings` writes it.
CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- Access of a person to Rhumbatron: `approved`, `pending`, or `declined`. Existing users stay
-- `approved`. The API access gate creates a new user row as `pending` while sign-up approval is on.
ALTER TABLE users ADD COLUMN access_status TEXT NOT NULL DEFAULT 'approved'
  CHECK (access_status IN ('approved', 'pending', 'declined'));
ALTER TABLE users ADD COLUMN access_decided_by TEXT;
ALTER TABLE users ADD COLUMN access_decided_at TEXT;
-- Last authenticated request, written at most once per hour per user by the access gate.
ALTER TABLE users ADD COLUMN last_seen_at TEXT;

-- The pending list, the status filter, and the newest-first user list.
CREATE INDEX idx_users_access_created ON users (access_status, created_at);
CREATE INDEX idx_users_created ON users (created_at);

-- One row per admin read or write. Retention: the API deletes rows older than 365 days.
CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  at TEXT NOT NULL
);
CREATE INDEX idx_admin_audit_at ON admin_audit (at);

-- Requests of one person, newest first: user costs, the admin user list, and the user detail.
CREATE INDEX idx_changes_created_by_created ON changes (created_by, created_at);
-- The newest-first Project list of the admin.
CREATE INDEX idx_projects_created ON projects (created_at);
-- Agent attempts in a date range: the admin cost report.
CREATE INDEX idx_task_runs_started ON task_runs (started_at);
-- The admin event filters by actor and by Event type, newest first.
CREATE INDEX idx_project_events_actor_seq ON project_events (actor_id, seq);
CREATE INDEX idx_project_events_type_seq ON project_events (event_type, seq);
