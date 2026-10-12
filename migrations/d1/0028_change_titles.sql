-- 0028_change_titles: a short display title for each Change (at most 48 characters).
-- The Root Planner writes it with the Work Graph. NULL until then; the API then shows a title
-- derived from the goal (`fallbackTitle` in packages/protocol). No decision reads it.

ALTER TABLE changes ADD COLUMN title TEXT;
