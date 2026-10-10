# Module: state

Owns the data stores of one environment:

- D1 `rhumbatron-control-<env>` (read replication disabled).
- R2 `rhumbatron-evidence-<env>` and its lifecycle rules (AGENTS.md section 43): abort stale
  multipart uploads after one day, and expire each prefix in `evidence_retention_days`.
- KV `rhumbatron-config-<env>`.

| Input | Meaning |
|---|---|
| `account_id` | Cloudflare account ID. |
| `environment` | `dev` or `prod`. |
| `evidence_retention_days` | Days per prefix: `events`, `evidence`, `tmp` (default 7). Null keeps objects forever. |

Outputs: `evidence_bucket_name`, `d1_database_id`, `d1_database_name`, `kv_namespace_id`, and
`bindings` (`DB`, `CONFIG`, `EVIDENCE`, with names that match every `wrangler.jsonc`).

Not in this module: the Vectorize index uses a temporary adapter in each env root (ADR 0003).
Durable Object namespaces come from Worker migrations.
