-- 0021_task_attempts_reset: a person's budget raise on a Task stopped for repeated failures
-- (section 44) gives the Task a new attempt window. Runs started before this time do not count
-- toward the per-tier attempt limit. NULL means every run counts.

ALTER TABLE tasks ADD COLUMN attempts_reset_at TEXT;
