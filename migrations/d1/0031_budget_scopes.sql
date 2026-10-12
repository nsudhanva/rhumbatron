-- 0031_budget_scopes: monthly budgets of a Project and of a user, and the budget scope of a
-- Change (ADR 0030). The month's spend lives in `usage_counters` (`project-usd-micro:<id>`,
-- `user-usd-micro:<id>`, `change-usd-micro:<id>`); no new table.

-- USD per calendar month. NULL: no own cap. The owner or an admin sets it (1 to 100).
ALTER TABLE projects ADD COLUMN monthly_budget_usd REAL;

-- USD per calendar month across every Project. NULL: no own cap. Each user sets their own.
ALTER TABLE users ADD COLUMN monthly_budget_usd REAL;

-- `change`: `budget_usd` caps the Change. `project` and `account`: the Change draws on the
-- Project or the requester monthly budget; `budget_usd` holds a ceiling of 100.
ALTER TABLE changes ADD COLUMN budget_scope TEXT NOT NULL DEFAULT 'change'
  CHECK (budget_scope IN ('change', 'project', 'account'));

-- A raise of a Project or a user budget resumes the Changes that budget stopped.
CREATE INDEX idx_changes_budget_blocked_project ON changes (project_id, blocked_limit)
  WHERE status = 'budget_blocked';
CREATE INDEX idx_changes_budget_blocked_requester ON changes (created_by, blocked_limit)
  WHERE status = 'budget_blocked';
