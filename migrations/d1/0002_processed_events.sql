-- 0002_processed_events: consumer-side deduplication (AGENTS.md sections 17.4 and 42.1).
-- K2 delivers at least once. Each consumer group records the event IDs it has applied.

CREATE TABLE processed_events (
  consumer TEXT NOT NULL,
  event_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (consumer, event_id)
);

CREATE INDEX idx_processed_events_processed_at ON processed_events (processed_at);
