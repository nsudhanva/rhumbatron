-- sandbox_awake: the awake time already charged to the monthly Sandbox meter, per container
-- (`proj-<project>`). Agents, Candidate checks, and code sessions share one container per
-- Project; a use charges only the time it adds beyond this block, so overlapping uses count once.
-- Times are epoch milliseconds.
CREATE TABLE sandbox_awake (
  container TEXT PRIMARY KEY,
  awake_from INTEGER NOT NULL,
  awake_until INTEGER NOT NULL
);
