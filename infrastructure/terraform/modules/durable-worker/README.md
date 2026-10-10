# Module: durable-worker

Owns one Worker that hosts Durable Object classes. Uses `cloudflare_workers_script` (full deploy)
because Durable Object migrations cannot ship in Worker version uploads (ADR 0005). Used by the
coordinator and agents Workers.

Inputs: `account_id`, `component`, `environment`, `main_module`, `modules`, `compatibility_date`,
`compatibility_flags`, `bindings`, `migrations`, `logs_head_sampling_rate` (default 1). The Worker
is named `rhumbatron-<component>-<environment>`. Output: `name`.

- `migrations` is a transition: `old_tag` must equal the live tag or Cloudflare returns 412.
  First deploy: `{ new_tag = "v1", new_sqlite_classes = [...] }`. Steady state: `{ old_tag = "v1", new_tag = "v1" }`.
  Class change: `{ old_tag = "v1", new_tag = "v2", ... }`, plus the same entry in `wrangler.jsonc`.
- workers.dev is disabled (`cloudflare_workers_script_subdomain`). Other Workers reach it through
  Durable Object bindings with `script_name`.
- `cloudflare_workers_script` has no tags attribute, so grouping is by name only.
