-- 0032_change_assumptions: the small product details the Root Planner decided for a Change
-- (colors, sizes, labels, defaults), as a JSON array of plain sentences. The planner writes it
-- with the Work Graph. NULL until then. The Change page shows it as "Assumptions". No decision
-- reads it.

ALTER TABLE changes ADD COLUMN assumptions_json TEXT;
