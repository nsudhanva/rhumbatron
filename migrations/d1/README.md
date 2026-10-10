# D1 migrations

SQL migrations for the control database (`rhumbatron-control-<env>`). Files `0001_init.sql`
through `0018_app_deployments.sql` exist today.

- Name files `NNNN_description.sql` (lowercase letters, digits, and underscores). The runner
  rejects other names.
- Never edit an applied migration: the runner stores each file's SHA-256 and stops if an applied
  file changes or is missing. Add a new migration instead.
- Remote: `terraform apply` in `envs/dev` or `envs/prod` runs `scripts/d1-migrate.ts` through
  `terraform_data.d1_migrations` whenever a file here changes (AGENTS.md section 11.6). The
  script refuses to run unless `RHUMBATRON_INVOKED_BY=terraform`.
- The API and integration Workers depend on this resource, so new code deploys after its tables
  exist.
- Bookkeeping table: `d1_migrations` (Wrangler-compatible, plus a `sha256` column).
- Each migration and its bookkeeping row run in one D1 query request.
- Local: `bunx wrangler d1 migrations apply DB --local` from a Worker that binds `DB` (its
  `wrangler.jsonc` sets `migrations_dir` to this directory).

```mermaid
flowchart TD
  A["bun run tf:apply:env"] --> H{"Hash of all *.sql files<br/>or database ID changed?"}
  H -- no --> N["No change"]
  H -- yes --> S["terraform_data.d1_migrations<br/>runs scripts/d1-migrate.ts"]
  S --> T["CREATE TABLE IF NOT EXISTS d1_migrations"]
  T --> P{"Bad name, or an applied file<br/>edited or missing?"}
  P -- yes --> F["Stop: apply fails"]
  P -- no --> L["For each pending file, in name order:<br/>SQL plus INSERT into d1_migrations,<br/>one request"]
  L --> W["Workers that depend on<br/>d1_migrations deploy"]
```
