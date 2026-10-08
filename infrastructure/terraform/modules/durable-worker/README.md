# Module: durable-worker

Owns one Worker that hosts Durable Object classes. Uses `cloudflare_workers_script` (full deploy)
because Durable Object migrations cannot ship in Worker version uploads (ADR 0005).

- Keep `migrations` identical to the Worker's `wrangler.jsonc`. Add a new tag per class change.
- workers.dev is disabled. Other Workers reach it through Durable Object bindings with `script_name`.
- `cloudflare_workers_script` has no tags attribute, so grouping is by name only.
