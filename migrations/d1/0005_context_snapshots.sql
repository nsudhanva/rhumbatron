-- 0005_context_snapshots: each Task run records the Context Packet it received (AGENTS.md 27.5).
-- The packet itself is in R2 under context/<project>/<change>/<task>/<hash>.json.

ALTER TABLE task_runs ADD COLUMN context_hash TEXT;
ALTER TABLE task_runs ADD COLUMN context_tokens INTEGER;
