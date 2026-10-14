-- live_removals: the live requests that the live-removal check named for a request
-- (`live-removal.ts`). When the requester answers "Remove them", the criteria of these requests
-- are not kept for that request (`kept-criteria.ts`).
CREATE TABLE live_removals (
  change_id TEXT NOT NULL REFERENCES changes (id),
  removed_change_id TEXT NOT NULL REFERENCES changes (id),
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (change_id, removed_change_id)
);
