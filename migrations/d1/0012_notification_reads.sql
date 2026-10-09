-- 0012_notification_reads: in-app inbox read state (AGENTS.md sections 38, 40.1, 59).
--
-- Notifications are not stored: workers/api notifications.ts derives them on each read from the
-- authoritative D1 rows (Candidates, approvals, dead letters, Changes, conflicts). Only the
-- per-user "read" mark is stored here. `notification_id` is `<kind>:<entity id>` (plus an
-- occurrence suffix for items that can reopen, such as a dead letter), so a mark never moves to
-- another entity. A mark never hides an action item: it only clears the unread dot.
-- Retention: the API deletes a user's marks older than 30 days when that user marks items read.

CREATE TABLE notification_reads (
  user_id TEXT NOT NULL REFERENCES users (id),
  notification_id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (user_id, notification_id)
);

-- Derivation reads start from rare states and recent windows, then join to the caller's
-- memberships. These indexes keep each query a range scan instead of a table scan.
-- memberships has PRIMARY KEY (org_id, user_id); a lookup by user alone needs its own index.
CREATE INDEX idx_memberships_user_id ON memberships (user_id);
-- Verified Candidates, and rejected / promoted Candidates of the last 7 days.
CREATE INDEX idx_candidates_status_updated ON candidates (status, updated_at);
-- Completed Changes of the last 7 days, and budget-blocked Changes.
CREATE INDEX idx_changes_status_updated ON changes (status, updated_at);
-- Open confirmed or fork-required conflicts. Queries must repeat the same IN list to use the index.
CREATE INDEX idx_conflicts_confirmed ON conflicts (updated_at) WHERE state IN ('confirmed', 'fork_required');
