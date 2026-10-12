-- 0030_code_sessions: Code page edit sessions with a terminal (ADR 0029).
-- One open session per user per Project. A session forks the canonical tree into the Artifacts
-- repo `edit-<hex>` for session `edit_<hex>`. Its edits live in `code_session_files` until the
-- person submits them as one Change with one human ChangeSet, discards them, or the session expires.

CREATE TABLE code_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  user_id TEXT NOT NULL,
  base_generation INTEGER NOT NULL,
  base_commit TEXT NOT NULL,
  base_tree TEXT NOT NULL,
  -- Artifacts repo name, derived from `id` (`edit-<hex>`). Cleanup derives it again from `id`.
  repo TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'submitted', 'closed', 'expired')),
  -- `discarded`, `idle`, `max_age`, `archived`, or `submitted`.
  close_reason TEXT,
  -- Increments on each file write, delete, or rename. The Sandbox checkout syncs when it differs.
  revision INTEGER NOT NULL DEFAULT 0,
  -- Set while a command runs; file edits and a second command wait.
  exec_started_at TEXT,
  -- Epoch ms until which the Sandbox stays awake after the last command (meter settlement).
  sandbox_awake_until INTEGER,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  -- The 2-hour limit. The idle limit (10 minutes after `last_used_at`) is computed.
  expires_at TEXT NOT NULL,
  closed_at TEXT,
  change_id TEXT,
  fork_deleted_at TEXT
);

CREATE UNIQUE INDEX code_sessions_one_open ON code_sessions (project_id, user_id)
  WHERE status = 'open';
-- The expiry sweep reads open sessions only.
CREATE INDEX code_sessions_open_used ON code_sessions (last_used_at) WHERE status = 'open';
CREATE INDEX code_sessions_project ON code_sessions (project_id);

-- The edits of one session: the whole new text of a written file, or a deleted path.
CREATE TABLE code_session_files (
  session_id TEXT NOT NULL REFERENCES code_sessions (id),
  path TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('written', 'deleted')),
  content TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  -- Git blob ID of `content`. A command result with the same blob ID needs no read.
  blob TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, path)
);

-- Audit log of terminal commands. The output is never stored.
CREATE TABLE code_session_commands (
  session_id TEXT NOT NULL REFERENCES code_sessions (id),
  command TEXT NOT NULL,
  cwd TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  duration_ms INTEGER NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX code_session_commands_session ON code_session_commands (session_id, at);
