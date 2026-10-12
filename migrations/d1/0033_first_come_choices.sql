-- 0033_first_come_choices: first-come conflicts between requests of different people (ADR 0032).
-- One row per earlier and later request pair. The earlier request keeps working. The later request
-- waits (`awaiting_choice`, then `queued`) until the earlier requester chooses.
--
-- choice: NULL while open; `keep_mine` or `apply_theirs` from the earlier requester; `expired`
-- after 7 days without a choice; `moot` when the earlier request ended without a build first.
-- workflow_instance_id: the ChangeWorkflow instance of the later request that waits, so a choice
-- or the end of the earlier request wakes it.
CREATE TABLE request_choices (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  first_change_id TEXT NOT NULL,
  later_change_id TEXT NOT NULL,
  conflict_id TEXT NOT NULL,
  asked_user_id TEXT NOT NULL,
  choice TEXT CHECK (choice IN ('keep_mine', 'apply_theirs', 'expired', 'moot')),
  chosen_by TEXT,
  chosen_at TEXT,
  workflow_instance_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (first_change_id, later_change_id)
);
-- The earlier requester's open questions (inbox) and the waits that follow one earlier request.
CREATE INDEX idx_request_choices_asked ON request_choices (asked_user_id, choice);
CREATE INDEX idx_request_choices_first ON request_choices (first_change_id);
CREATE INDEX idx_request_choices_later ON request_choices (later_change_id, created_at);
