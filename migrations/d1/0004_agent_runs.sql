-- 0004_agent_runs: Decision Receipts and Task run outcomes (AGENTS.md sections 23.5, 24, P6-08).
-- Receipts hold routing inputs and outputs only, never private model reasoning.

CREATE TABLE decision_receipts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  agent_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  decided_by TEXT NOT NULL CHECK (decided_by IN ('rules', 'clef')),
  selected_tier TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_decision_receipts_task_id ON decision_receipts (task_id);

-- One row per attempt. `outcome_json` is the typed Intent or the failure; usage is for the Cost page.
CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  agent_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  tier TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  failure_kind TEXT,
  outcome_json TEXT,
  model_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (task_id, attempt)
);

CREATE INDEX idx_task_runs_task_id ON task_runs (task_id);
