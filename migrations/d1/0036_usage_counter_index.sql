-- All-time spend per user and per Project sums one meter over every month (ADR 0033).
CREATE INDEX IF NOT EXISTS idx_usage_counters_counter ON usage_counters (counter);
