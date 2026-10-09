-- 0006_conflicts: semantic conflicts between Intents of one Change (AGENTS.md sections 32 and 38.2).
-- The row ID is a hash of the sorted Intent IDs and the resource, so a repeated detection of the
-- same pair is `INSERT ... ON CONFLICT DO NOTHING`. Only `suspected` and `confirmed` pairs are
-- stored; benign overlaps are dismissed by the deterministic first pass.

CREATE TABLE conflicts (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES changes (id),
  resource TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('suspected', 'confirmed', 'fork_required', 'resolved')),
  recommended_action TEXT NOT NULL CHECK (recommended_action IN ('dismiss', 'review', 'fork_candidates')),
  -- The ConflictReport from packages/conflict (intent IDs, signals, state, action).
  report_json TEXT NOT NULL,
  -- The two Intents in report order: task, agent, summary, assumptions, resources.
  intents_json TEXT NOT NULL,
  -- Who decided the state: `rules` today; Sonnet or Opus review later (P9-05, P9-06).
  review_json TEXT NOT NULL,
  -- forkDecision() at detection time (section 32.4).
  fork_decision_json TEXT NOT NULL,
  -- The Challenge recorded on the ResourceShardDO for a confirmed conflict.
  challenge_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_conflicts_change_id ON conflicts (change_id);
