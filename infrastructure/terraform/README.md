# Terraform

Terraform owns every Cloudflare control-plane resource. Do not change remote infrastructure with
the dashboard, `wrangler deploy`, or direct API writes. Read every plan. Never use
`-auto-approve`. `bun run tf` refuses it.

## Layout

| Path | State key | Purpose |
|---|---|---|
| `bootstrap/` | `bootstrap/terraform.tfstate` | R2 state bucket `rhumbatron-terraform-state-global` only. The first apply uses local state (see Bootstrap). |
| `envs/global/` | `global/terraform.tfstate` | Zone-wide and account-wide singletons: `rhumbatron.com` zone settings (TLS, `ssl = "strict"`) and the billing budget alerts adapter (ADR 0019). Prod does not own these. |
| `envs/prod/` | `prod/terraform.tfstate` | Prod environment, the only remote environment (ADR 0017). Switches: `paused`, `bootstrap`, `attach_apex`, `apps.routing`. |
| `modules/` | - | Shared modules. See Modules. |

All three roots use the S3 backend on R2, with `use_lockfile = true`.

```mermaid
flowchart TB
  S[("R2 bucket<br/>rhumbatron-terraform-state-global")]
  B["bootstrap"] -- "bootstrap/terraform.tfstate" --> S
  G["envs/global"] -- "global/terraform.tfstate" --> S
  P["envs/prod"] -- "prod/terraform.tfstate" --> S
  B -. creates .-> S
  G --> MG["modules: dns, security"]
  P --> ME["modules: dns, state, async, ai,<br/>worker, durable-worker"]
  P --> AD["terraform_data adapters"]
  G --> AB["terraform_data.budget_alerts"]
```

## Modules

| Module | Owns |
|---|---|
| `worker` | One Worker: version per bundle hash, 100 percent deployment, custom domains, cron triggers. |
| `durable-worker` | One Worker that hosts Durable Object classes, as a full script upload (ADR 0005). |
| `dns` | Reads the `rhumbatron.com` zone. Outputs `zone_id` and `zone_name`. Manages no records. |
| `state` | D1 `rhumbatron-control-<env>`, R2 `rhumbatron-evidence-<env>` with lifecycle rules, KV `rhumbatron-config-<env>`. |
| `async` | Six Queues `rhumbatron-<purpose>-<env>`. |
| `ai` | AI Gateway `rhumbatron-models-<env>` with the Anthropic spend limit (ADR 0021). |
| `security` | Zone settings only. |
| `observability` | No resources. Log settings are in `worker` and `durable-worker`. |

Each env root keeps some resources inline. These are the queue consumers, the Workflows, the docs Worker `rhumbatron-docs-prod` (`envs/prod/docs.tf`, assets only,
`docs.rhumbatron.com`), the live app wildcard DNS record and routes, the Clerk DNS records (prod), and
the adapters below.

## Environments

| | local | prod |
|---|---|---|
| Runs on | Miniflare via `bun run dev` | Cloudflare |
| Resources | Simulated by Wrangler, stored in `.wrangler/state` | Terraform `envs/prod` |
| Name suffix | none | `-prod` |
| Web hostname | `localhost:5173` | `rhumbatron.com` |
| API hostname | `localhost:8787` | `api.rhumbatron.com` |
| R2 `events/` retention | none | 365 days |
| R2 `evidence/` retention | none | kept |
| R2 `tmp/` retention | none | 7 days |
| R2 `app-previews/` retention | none | 7 days |
| Clerk instance | development | production (ADR 0017) |
| Anthropic budget per calendar month | - | $100 |
| `ALLOW_OPUS` | - | `false` |
| Platform admins (`PLATFORM_ADMIN_USER_IDS`, a JSON array) | `[]` | `var.platform_admin_user_ids` (ADR 0033) |
| `www` | none | Custom domain of the prod web Worker; the Worker returns 301 to the apex |

Prod is the only remote environment. Local work uses `wrangler dev`.

`var.platform_admin_user_ids` (`envs/prod/variables.tf`) lists the Rhumbatron user IDs (`usr_<Clerk user ID>`) of the platform admins. The default is `["usr_user_3KVgK2jUomozHjWQw7kPaVopRLq"]`. The value is not secret. Terraform sets it on the API Worker as the plain_text binding `PLATFORM_ADMIN_USER_IDS`. The API checks the session user ID against it. A change of the list needs a plan and an apply.

Each hostname is one label deep, so Universal SSL covers it.

## Binding names

Every Worker uses the same binding names in `wrangler.jsonc` (local) and Terraform (prod).

| Binding | Resource | Name pattern |
|---|---|---|
| `DB` | D1 | `rhumbatron-control-<env>` |
| `EVIDENCE` | R2 | `rhumbatron-evidence-<env>` |
| `CONFIG` | KV | `rhumbatron-config-<env>` (integration Worker) |
| `MEMORY` | Vectorize (API adapter, ADR 0003) | `rhumbatron-memory-<env>` |
| `EVENTS_00` .. `EVENTS_07` | K2 producers (coordinator) | `rhumbatron_events_NN_<env>` |
| `ARTIFACTS` | Artifacts namespace (created on first use, ADR 0010) | `rhumbatron-projects-<env>` |
| `SANDBOX` | Sandbox class in the Sandbox Worker (ADR 0012) | `rhumbatron-sandbox-<env>` |
| `METRICS` | Analytics Engine dataset (agents, indexer) | `rhumbatron_metrics_<env>` |
| `EVENT_METRICS` | Analytics Engine dataset (event router) | `rhumbatron_event_metrics_<env>` |
| `LOADER`, `APP_DATA` | Dynamic Worker loader and app data Durable Object, in the apps Worker (ADR 0020) | `rhumbatron-apps-<env>` |
| Queue producers | Queues | `rhumbatron-<purpose>-<env>` for agent-wakeups, integration, verification, indexing, release, dead-letter |

The R2 lifecycle rules use prefixes. Write expiring objects under `events/`, `evidence/`, or
`tmp/`.

## Wrapper and credentials

`bun run tf <bootstrap|global|prod> <terraform args...>` (`scripts/tf.ts`) loads credentials
from the macOS Keychain (ADR 0004) and runs Terraform in that root. A value that is already set
in the environment wins. The wrapper refuses `-auto-approve`.

| Variable | Keychain item | Roots |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `rhumbatron-cloudflare-api-token` | all |
| `TF_VAR_account_id` | `rhumbatron-cloudflare-account-id` | all |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `rhumbatron-r2-state-access-key-id` / `rhumbatron-r2-state-secret-access-key` (bucket-scoped R2 key) | all |
| `TF_VAR_alert_email` | `rhumbatron-alert-email` | global |
| `TF_VAR_clerk_secret_key` | `rhumbatron-clerk-secret-key-prod` | prod |
| `TF_VAR_clerk_publishable_key` | `rhumbatron-clerk-publishable-key-prod` | prod |
| `TF_VAR_k2_consumer_token` | `rhumbatron-k2-consumer-token-dev` | prod |
| `TF_VAR_anthropic_api_key` | `rhumbatron-anthropic-api-key` | prod |
| `TF_VAR_anthropic_workspace_id` | `rhumbatron-anthropic-workspace-id` (not secret) | prod |

Prod uses the K2 item (ADR 0017) and the Anthropic items (ADR 0021). See ADR 0004 for token scopes.

## Backend configuration

Each root reads the bucket and the R2 endpoint from `backend.hcl`. Git ignores this file. Copy it from
`backend.example.hcl` once per root, and write the account ID in it.

```hcl
bucket    = "rhumbatron-terraform-state-global"
endpoints = { s3 = "https://<ACCOUNT_ID>.r2.cloudflarestorage.com" }
```

The state key and the other backend settings are in each root's `versions.tf`.

## Environment workflow

```sh
cp infrastructure/terraform/envs/prod/backend.example.hcl infrastructure/terraform/envs/prod/backend.hcl  # once
bun run tf prod init -backend-config=backend.hcl   # once
bun run cf:bundle                                  # before every plan (writes dist/bundles/manifest.json)
bun run tf:plan:prod                               # writes prod.tfplan; read it
bun run tf:apply:prod                              # applies exactly that plan
bun run tf:drift:prod                              # prod must report no changes
```

`bun run tf:drift` checks global and prod together. For global, run
`bun run tf global plan -out=global.tfplan`, then `bun run tf global apply global.tfplan`.

Apply order for a fresh account: `bootstrap`, `envs/global`, `envs/prod`. A fresh
environment applies twice. The first apply uses `local.bootstrap = true`. This value breaks the coordinator and event
router binding cycle and creates the first Durable Object migrations. The second apply uses `false`
(ADR 0012, ADR 0017).

## Temporary adapters

Provider 5.27 has no first-party resource for these items. For each adapter, a `terraform_data`
resource runs a script from `scripts/`. Only `terraform apply` invokes an adapter. Each script refuses to run unless
`RHUMBATRON_INVOKED_BY=terraform`. Each script reads before it writes and is safe to run again. Never call
these scripts or the API directly.

| Adapter | Resource | Script | Roots | ADR |
|---|---|---|---|---|
| K2 streams and subscriptions | `terraform_data.k2_streams`, `data.external.k2_streams` | `k2-sync.ts`, `k2-read.ts` | prod | 0006 |
| K2 account limit check (plan time) | `data.external.k2_inventory` | `k2-read.ts` (`mode = inventory`) | prod | 0017 |
| Vectorize index | `terraform_data.vectorize_index`, `terraform_data.vectorize_index_teardown` | `vectorize-sync.ts` | prod | 0003 |
| Sandbox Worker and container application | `terraform_data.sandbox_worker`, `terraform_data.sandbox_worker_teardown` | `sandbox-deploy.ts` | prod | 0012 |
| Apps Worker (Dynamic Worker loader binding) | `terraform_data.apps_worker`, `terraform_data.apps_worker_teardown` | `apps-deploy.ts` | prod | 0020 |
| D1 schema migrations | `terraform_data.d1_migrations` | `d1-migrate.ts` | prod | - |
| Billing budget alerts | `terraform_data.budget_alerts` | `budget-alerts.ts` (operator `cf` CLI login) | global | 0019 |

The K2 adapter never deletes streams. The Vectorize, Sandbox Worker, and apps Worker adapters delete only on a real destroy, through
their teardown resources. Artifacts has no adapter. The `ARTIFACTS` binding creates the namespace on first use
(ADR 0010).

```mermaid
flowchart LR
  A["terraform apply"] --> T["terraform_data<br/>(triggers_replace hash)"]
  T --> X["local-exec: bun scripts/*.ts<br/>RHUMBATRON_INVOKED_BY=terraform"]
  X --> R["Read live state<br/>(Cloudflare API)"]
  R --> W["Create or patch<br/>only what differs"]
```

## D1 migrations

`terraform_data.d1_migrations` in the prod root runs `scripts/d1-migrate.ts` when any
file in `migrations/d1` changes. See [`migrations/d1/README.md`](../../migrations/d1/README.md).

## Static checks

`bun run tf:check` runs `terraform fmt -check`, `terraform init -backend=false`,
`terraform validate`, and `tflint` for the bootstrap, global, and prod roots. It also
validates `modules/worker` and `modules/durable-worker` directly. It does not contact the state
backend, and it creates no resources.

## Bootstrap

A fresh account needs these steps once. The operator creates the Terraform token and the backend key with the
`cf` CLI (ADR 0004).

1. Apply `bootstrap/` with local state. It creates only the state bucket (`prevent_destroy`).
2. Create the bucket-scoped backend key with the `cf` CLI and store it in the Keychain.
3. Add the `s3` backend block with key `bootstrap/terraform.tfstate` to `bootstrap/versions.tf`.
4. `bun run tf bootstrap init -migrate-state -backend-config=backend.hcl`.
5. Confirm the state object exists in R2. Then delete the local `terraform.tfstate*` files.

## References

- Naming: [`docs/operations/naming.md`](../../docs/operations/naming.md). Pattern:
  `rhumbatron-<component>-<env>`.
- Credentials and token scopes: [ADR 0004](../../docs/adr/0004-resource-organization-and-bootstrap-credentials.md).
- Durable Object Workers: [ADR 0005](../../docs/adr/0005-durable-object-worker-deploys.md).
- Prod environment: [ADR 0017](../../docs/adr/0017-prod-environment.md).
- Runaway-billing guards: [ADR 0019](../../docs/adr/0019-runaway-billing-guards.md).
