-- 0017_project_policies: the stored Project policy (AGENTS.md sections 14 and 53, HOM-202). D1 is
-- the source of truth; the integration Worker reads it through a short-TTL KV snapshot (CONFIG). A
-- Project without a row uses the default policy (`policy-1`), so this table changes nothing until a
-- row exists. One row per Project; `policy_json` is a ProjectPolicy (packages/protocol).

CREATE TABLE project_policies (
  project_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
