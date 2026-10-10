# Module: worker

Owns one Worker without Durable Object classes: `cloudflare_worker`, one `cloudflare_worker_version`
per bundle hash, a 100 percent `cloudflare_workers_deployment`, custom domains, and an optional cron
trigger. The Worker is named `rhumbatron-<component>-<environment>` and gets the standard tags.

Inputs come from `bun run cf:bundle`, which writes `dist/bundles/manifest.json` with module paths
and a content hash for each Worker. Build bundles before `terraform plan`.

| Input | Default | Meaning |
|---|---|---|
| `account_id`, `component`, `environment` | - | Identity and name. |
| `main_module`, `modules`, `bundle_sha256` | - | Bundle from the manifest. A new hash creates a new version. |
| `compatibility_date`, `compatibility_flags` | -, `[]` | Keep equal to `wrangler.jsonc`. |
| `assets_directory` | `null` | Static assets (web Worker). |
| `bindings` | `[]` | Names must match the Worker's `wrangler.jsonc`. |
| `migrations` | `null` | No root sets it. Durable Object Workers use `durable-worker`. |
| `custom_domains` | `[]` | `{ hostname, zone_id }` entries. |
| `enable_workers_dev` | `false` | workers.dev subdomain. |
| `logs_head_sampling_rate` | `1` | Fraction of successful invocations logged. |
| `extra_tags` | `[]` | Tags in addition to the standard ones. |
| `cron_schedules` | `null` | Null: no trigger resource. `[]` clears the schedules remotely. |

Outputs: `name`, `worker_id`, `version_id`.
