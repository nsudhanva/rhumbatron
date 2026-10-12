-- 0029_roles_and_request_review: Project roles and member request review (ADR 0028).
-- Roles: owner, admin, member, viewer. A `collaborator` row and a pending `collaborator`
-- invitation become `member`. Rank orders lists only (owner 0, admin 5, member 10, viewer 30).
-- No build decision reads a role or a rank.

-- project_members: the role CHECK changes, so the table is rebuilt. No table references it.
CREATE TABLE project_members_next (
  project_id TEXT NOT NULL REFERENCES projects (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  rank INTEGER NOT NULL CHECK (rank >= 0),
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
INSERT INTO project_members_next (project_id, user_id, role, rank, added_by, created_at)
  SELECT project_id, user_id,
    CASE WHEN role = 'owner' THEN 'owner' ELSE 'member' END,
    CASE WHEN role = 'owner' THEN 0 ELSE 10 END,
    added_by, created_at
  FROM project_members;
DROP TABLE project_members;
ALTER TABLE project_members_next RENAME TO project_members;
CREATE INDEX project_members_user ON project_members (user_id);
CREATE UNIQUE INDEX project_members_one_owner ON project_members (project_id) WHERE role = 'owner';

-- project_invitations: an invitation names the role that acceptance gives. No table references it.
CREATE TABLE project_invitations_next (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  rank INTEGER NOT NULL CHECK (rank >= 0),
  invited_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked')),
  accepted_user_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT
);
INSERT INTO project_invitations_next
  (id, project_id, email, role, rank, invited_by, status, accepted_user_id, created_at,
   expires_at, accepted_at)
  SELECT id, project_id, email, 'member', 10, invited_by, status, accepted_user_id, created_at,
    expires_at, accepted_at
  FROM project_invitations;
DROP TABLE project_invitations;
ALTER TABLE project_invitations_next RENAME TO project_invitations;
CREATE INDEX project_invitations_email ON project_invitations (email, status);
CREATE UNIQUE INDEX project_invitations_open ON project_invitations (project_id, email)
  WHERE status = 'pending';

-- 1: a member's request starts as `proposed` and waits for an owner or admin. 0: no review.
ALTER TABLE projects ADD COLUMN member_request_review INTEGER NOT NULL DEFAULT 1;

-- Review of a request. NULL review_state: no review was needed. Otherwise `proposed`,
-- `included`, or `declined`, with the person who decided, when, and the decline reason.
ALTER TABLE changes ADD COLUMN review_state TEXT;
ALTER TABLE changes ADD COLUMN review_decided_by TEXT;
ALTER TABLE changes ADD COLUMN review_decided_at TEXT;
ALTER TABLE changes ADD COLUMN review_reason TEXT;

-- Notifications `request_included` and `request_declined` read decisions of the last 7 days.
CREATE INDEX idx_changes_review_decided ON changes (review_state, review_decided_at)
  WHERE review_state IS NOT NULL;

-- The Board and the Change list read the newest Changes of one Project.
CREATE INDEX idx_changes_project_created ON changes (project_id, created_at);
