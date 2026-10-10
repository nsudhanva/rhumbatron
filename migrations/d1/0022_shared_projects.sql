-- 0022_shared_projects: a Project shared between users (docs/plans/phase-17a-shared-projects.md).
-- Membership is per Project, not per organization, so a collaborator sees only the shared Project.
-- Rank orders requesters for the priority_wins conflict policy: the owner is 0, a collaborator 10.

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'collaborator')),
  rank INTEGER NOT NULL CHECK (rank >= 0),
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user ON project_members (user_id);
CREATE UNIQUE INDEX project_members_one_owner ON project_members (project_id) WHERE role = 'owner';

-- An invitation binds only to a Clerk-verified email of the signed-in user (decision S-02).
CREATE TABLE project_invitations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role = 'collaborator'),
  rank INTEGER NOT NULL CHECK (rank >= 0),
  invited_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked')),
  accepted_user_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT
);
CREATE INDEX project_invitations_email ON project_invitations (email, status);
CREATE UNIQUE INDEX project_invitations_open ON project_invitations (project_id, email)
  WHERE status = 'pending';

ALTER TABLE users ADD COLUMN display_name TEXT;

-- Requester and outcome of each request. created_by is the requester.
ALTER TABLE changes ADD COLUMN requester_rank INTEGER;
ALTER TABLE changes ADD COLUMN scope_registered_at TEXT;
ALTER TABLE changes ADD COLUMN outcome TEXT;
ALTER TABLE changes ADD COLUMN outcome_reason TEXT;
ALTER TABLE changes ADD COLUMN outcome_winner_change_id TEXT;
ALTER TABLE changes ADD COLUMN outcome_decided_by TEXT;
ALTER TABLE changes ADD COLUMN supersedes_change_id TEXT;

-- One row per compared pair of requests in one Project. change_a < change_b.
CREATE TABLE request_conflicts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  change_a TEXT NOT NULL,
  change_b TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('independent', 'compatible', 'conflicting')),
  criteria_json TEXT NOT NULL DEFAULT '[]',
  review_json TEXT,
  policy TEXT,
  winner_change_id TEXT,
  loser_change_id TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (change_a, change_b)
);
CREATE INDEX request_conflicts_project ON request_conflicts (project_id, created_at);

-- Backfill: the owner of each existing Project is the owner of its organization.
INSERT OR IGNORE INTO project_members (project_id, user_id, role, rank, added_by, created_at)
  SELECT p.id, m.user_id, 'owner', 0, 'migration-0022', p.created_at
  FROM projects p JOIN memberships m ON m.org_id = p.org_id AND m.role = 'owner';
