# Cloudflare resource naming and grouping

Every Cloudflare resource must show which project, environment, and component it belongs to.

## Name pattern

```text
rhumbatron-<component>-<env>
```

- `component`: lowercase kebab-case purpose, for example `control`, `evidence`, `agent-wakeups`, `api`.
- `env`: `prod` or `global` (shared account-wide, for example Terraform state).

`bun run check:guardrails` rejects Terraform resource names that break this pattern.

## Current and planned names

| Resource | prod | global |
|---|---|---|
| Terraform state bucket (R2) | | `rhumbatron-terraform-state-global` |
| Terraform token | | `rhumbatron-terraform-global` |
| State backend key | | `rhumbatron-terraform-state-backend-global` |
| D1 control database | `rhumbatron-control-prod` | |
| KV config namespace | `rhumbatron-config-prod` | |
| R2 evidence bucket | `rhumbatron-evidence-prod` | |
| Queues | `rhumbatron-<purpose>-prod` | |
| Vectorize index | `rhumbatron-memory-prod` | |
| AI Gateway | `rhumbatron-models-prod` | |
| Artifacts namespace | `rhumbatron-projects-prod` | |
| Workers | `rhumbatron-<component>-prod` | |
| Release target Worker | `rhumbatron-acme-shop-prod` | |
| K2 streams | `rhumbatron_events_00_prod`..`07` | |

K2 streams are the one exception: K2 names allow only letters, digits, and underscores, so they
use `rhumbatron_events_NN_<env>` (ADR 0006).

Queue purposes: `agent-wakeups`, `integration`, `verification`, `indexing`, `release`, `dead-letter`.

## Tags

Terraform applies these standard tags wherever it supports them.

| Key | Values |
|---|---|
| `project` | `rhumbatron` |
| `env` | `prod`, `global` |
| `component` | the name's component part |
| `managed-by` | `terraform` |

- Workers: Terraform applies them now as `key:value` strings through `cloudflare_worker.tags`.
- D1, KV, R2, Queues, AI Gateway, Vectorize, Durable Object namespaces: Cloudflare Resource Tagging
  supports them, but provider 5.27 has no resource for it. Apply the tags when first-party support
  exists (ADR 0004).

## Local

Wrangler local resources use binding names only (`DB`, `CONFIG`, `EVIDENCE`, `MEMORY`). Local data
lives in each package's `.wrangler/state` directory.
