-- 0001_init: product metadata (AGENTS.md section 14).
-- D1 holds searchable metadata only. Hot coordination state lives in Durable Object SQLite.
-- Timestamps are ISO-8601 UTC strings. IDs are application-generated strings.

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  auth_subject TEXT NOT NULL UNIQUE, -- Clerk user ID
  email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memberships (
  org_id TEXT NOT NULL REFERENCES organizations (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  canonical_generation INTEGER NOT NULL DEFAULT 0 CHECK (canonical_generation >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, slug)
);

CREATE TABLE changes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  base_generation INTEGER NOT NULL CHECK (base_generation >= 0),
  risk_tier TEXT CHECK (risk_tier IN ('low', 'medium', 'high', 'critical')),
  budget_usd REAL NOT NULL CHECK (budget_usd >= 0),
  client_request_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, client_request_id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES changes (id),
  parent_task_id TEXT REFERENCES tasks (id),
  kind TEXT NOT NULL,
  semantic_resource TEXT,
  status TEXT NOT NULL,
  assigned_agent_id TEXT,
  complexity TEXT CHECK (complexity IN ('small', 'medium', 'large')),
  risk_tier TEXT CHECK (risk_tier IN ('low', 'medium', 'high', 'critical')),
  model_policy TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_active_at TEXT
);

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES changes (id),
  base_generation INTEGER NOT NULL CHECK (base_generation >= 0),
  artifact_ref TEXT,
  status TEXT NOT NULL,
  score_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE changesets (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES changes (id),
  agent_id TEXT NOT NULL,
  base_generation INTEGER NOT NULL CHECK (base_generation >= 0),
  artifact_ref TEXT,
  intent_json TEXT NOT NULL,
  resources_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE evidence_index (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates (id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'error', 'skipped')),
  summary TEXT NOT NULL,
  r2_key TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Indexes from AGENTS.md section 14.2.
CREATE INDEX idx_projects_org_id ON projects (org_id);
CREATE INDEX idx_changes_project_id ON changes (project_id);
CREATE INDEX idx_changes_status ON changes (status);
CREATE INDEX idx_tasks_change_id ON tasks (change_id);
CREATE INDEX idx_tasks_status ON tasks (status);
CREATE INDEX idx_tasks_assigned_agent_id ON tasks (assigned_agent_id);
CREATE INDEX idx_candidates_change_id ON candidates (change_id);
CREATE INDEX idx_changesets_change_id ON changesets (change_id);
CREATE INDEX idx_evidence_index_candidate_id ON evidence_index (candidate_id);
