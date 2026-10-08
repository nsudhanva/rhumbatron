# D1 migrations

SQL migrations for the control database (`rhumbatron-control-<env>`).

- Name files `NNNN_description.sql`. Never edit an applied migration: the runner stores each
  file's SHA-256 and stops if an applied file changes. Add a new migration instead.
- Remote: `terraform apply` runs `scripts/d1-migrate.ts` through `terraform_data.d1_migrations`
  whenever a file here changes (AGENTS.md section 11.6). The script refuses direct calls.
- Bookkeeping table: `d1_migrations` (Wrangler-compatible, plus a `sha256` column).
- Local: `bunx wrangler d1 migrations apply DB --local` from a Worker that binds `DB`.
