-- 0013_indexes: stored indexes of canonical trees (AGENTS.md sections 12.7, 27, 28; P7-02 to P7-05).
--
-- The indexer Worker builds one index per (Project, canonical tree) and writes three JSON objects
-- under R2 `index/<project>/<tree>/` (symbols, deps, product-graph). `project_indexes` points at
-- them once all three exist (`status = 'ready'`). The tree SHA is content-addressed, so a ready row
-- is never rebuilt: a redelivered or repeated build command is a no-op.
-- `project_vectors` counts the Vectorize vectors each Project holds, so the indexer can keep the
-- account under the Vectorize free stored-dimension allowance before it upserts.

CREATE TABLE project_indexes (
  project_id TEXT NOT NULL REFERENCES projects (id),
  tree_sha TEXT NOT NULL,
  commit_sha TEXT,
  status TEXT NOT NULL CHECK (status IN ('ready', 'failed', 'purged')),
  r2_prefix TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  -- ok, unchanged, skipped_cap, skipped_quota, unbound, or error: semantic memory is optional.
  vector_status TEXT NOT NULL DEFAULT 'unbound',
  error TEXT,
  built_at TEXT NOT NULL,
  PRIMARY KEY (project_id, tree_sha)
);

-- Newest ready index of a Project (Product Graph fallback when the canonical tree is not indexed).
CREATE INDEX idx_project_indexes_project_built ON project_indexes (project_id, status, built_at);

CREATE TABLE project_vectors (
  project_id TEXT PRIMARY KEY REFERENCES projects (id),
  tree_sha TEXT NOT NULL,
  vector_count INTEGER NOT NULL CHECK (vector_count >= 0),
  updated_at TEXT NOT NULL
);
