# Cloudflare resource naming and grouping

The name of each Cloudflare resource shows its project, environment, and component.

## Name pattern

```text
rhumbatron-<component>-<env>
```

- `component`: the purpose in lowercase kebab-case, for example `control`, `evidence`, `agent-wakeups`, `api`.
- `env`: `prod`, or `global` for account-wide resources such as the Terraform state bucket.

`bun run check:guardrails` rejects a `name`, `queue_name`, `title`, or `bucket_name` in Terraform that breaks this pattern.

## Names

| Resource | Name |
|---|---|
| Terraform state bucket (R2) | `rhumbatron-terraform-state-global` |
| D1 database | `rhumbatron-control-prod` |
| KV namespace | `rhumbatron-config-prod` |
| R2 evidence bucket | `rhumbatron-evidence-prod` |
| Queues | `rhumbatron-<purpose>-prod` |
| Vectorize index | `rhumbatron-memory-prod` |
| AI Gateway | `rhumbatron-models-prod` |
| Artifacts namespace | `rhumbatron-projects-prod` |
| Workers | `rhumbatron-<component>-prod`: `web`, `api`, `coordinator`, `agents`, `event-router`, `integration`, `indexer`, `sandbox`, `apps`, `docs` |
| Workflows | `rhumbatron-change-workflow-prod`, `rhumbatron-candidate-verification-prod`, `rhumbatron-release-prod` |
| K2 streams | `rhumbatron_events_00_prod` to `rhumbatron_events_07_prod` |
| Analytics Engine datasets | `rhumbatron_metrics_prod`, `rhumbatron_event_metrics_prod` |

Queue purposes: `agent-wakeups`, `integration`, `verification`, `indexing`, `release`, `dead-letter`.

K2 stream names and Analytics Engine dataset names allow only letters, digits, and underscores. They use underscores (ADR 0004, ADR 0006).

## Tags

| Key | Values |
|---|---|
| `project` | `rhumbatron` |
| `env` | `prod` |
| `component` | the component part of the name |
| `managed-by` | `terraform` |

- `modules/worker` and the docs Worker set these tags as `key:value` strings in `cloudflare_worker.tags`. These are the web, api, event-router, integration, indexer, and docs Workers.
- The coordinator and agents Workers deploy through `cloudflare_workers_script` (`modules/durable-worker`), and the sandbox and apps Workers deploy through adapters. They have no tags. Their names group them.
- D1, KV, R2, Queues, AI Gateway, Vectorize, and Durable Object namespaces have no tags. Provider 5.27 has no tagging resource for them (ADR 0004).

## Local

Each `wrangler.jsonc` names its local resources `rhumbatron-<component>-local`, for example `rhumbatron-evidence-local`. The binding names are the same as in Terraform (`bun run check:bindings`). Local data is in the `.wrangler/state` directory of each package.
