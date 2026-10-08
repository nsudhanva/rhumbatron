# Terraform

Terraform owns every Cloudflare control-plane resource. Do not change remote infrastructure with
the dashboard, `wrangler deploy`, or direct API writes.

## Layout

| Path | State key | Purpose |
|---|---|---|
| `bootstrap/` | local, then `bootstrap/terraform.tfstate` | R2 state bucket `rhumbatron-terraform-state-global`. |
| `envs/global/` | `global/terraform.tfstate` | Zone-wide singletons for `rhumbatron.com` (TLS settings, later WAF). Owned once, never by dev or prod. Applied. |
| `envs/dev/` | `dev/terraform.tfstate` | Dev environment. Applied. |
| `envs/prod/` | `prod/terraform.tfstate` | Prod environment. Planned only until the first end-to-end Change works (AGENTS.md section 10). |
| `modules/` | - | `worker`, `durable-worker` (ADR 0005), `dns`, `state`, `async`, `security` are implemented. `ai`, `code-storage`, `observability` are placeholders. |

## Environments

| | local | dev | prod |
|---|---|---|---|
| Runs on | Miniflare via `bun run dev` | Cloudflare | Cloudflare |
| Resources | Simulated by Wrangler, stored in `.wrangler/state` | Terraform `envs/dev` | Terraform `envs/prod` |
| Name suffix | none | `-dev` | `-prod` |
| Web hostname | `localhost:5173` | `dev.rhumbatron.com` | `rhumbatron.com` |
| API hostname | `localhost:8787` | `api-dev.rhumbatron.com` | `api.rhumbatron.com` |
| R2 `events/` retention | none | 30 days | 365 days |
| R2 `evidence/` retention | none | 30 days | kept |
| R2 `tmp/` retention | none | 7 days | 7 days |
| Clerk instance | development | development | production (not configured yet) |

Hostnames stay one label deep so Universal SSL covers them.

## Binding names

Every Worker uses the same binding names in `wrangler.jsonc` (local) and Terraform (dev, prod).

| Binding | Resource | dev name |
|---|---|---|
| `DB` | D1 | `rhumbatron-control-dev` |
| `CONFIG` | KV | `rhumbatron-config-dev` |
| `EVIDENCE` | R2 | `rhumbatron-evidence-dev` |
| `MEMORY` | Vectorize (deferred, ADR 0003) | `rhumbatron-memory-dev` |
| Queue producers | Queues | `rhumbatron-<purpose>-dev` for agent-wakeups, integration, verification, indexing, release, dead-letter |

R2 lifecycle rules are prefix-based. Write objects under `events/`, `evidence/`, or `tmp/`.

## Apply order

1. `bootstrap` (once).
2. `envs/global`.
3. `envs/dev`.
4. `envs/prod` (after the first end-to-end Change).

## Credentials

Keep all credentials outside the repository.

| Variable | Use |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare provider. Account token; see Token permissions below. |
| `TF_VAR_account_id` | Cloudflare account ID. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Bucket-scoped R2 key for the S3 backend. Stored in the Keychain. |

## Bootstrap (run once)

The Terraform token and the state backend key are created with the `cf` CLI (ADR 0004).

1. Load the token: `export CLOUDFLARE_API_TOKEN=$(security find-generic-password -s rhumbatron-cloudflare-api-token -w)`.
2. `terraform -chdir=infrastructure/terraform/bootstrap init`, then `plan`, then `apply` (local state).
3. Create the bucket-scoped backend key with the `cf` CLI and store it in the Keychain.
4. Add an `s3` backend block to `bootstrap/versions.tf` with key `bootstrap/terraform.tfstate`.
5. `terraform -chdir=infrastructure/terraform/bootstrap init -migrate-state -backend-config=backend.hcl`.
6. Confirm the state object exists in R2. Then delete the local `terraform.tfstate*` files.

## Token permissions

See ADR 0004 for the exact scopes of `rhumbatron-terraform-global` and the backend key.

## Naming

See `docs/operations/naming.md`. Pattern: `rhumbatron-<component>-<env>`.

## Environment workflow

`bun run tf <root> <args>` loads credentials from the Keychain (ADR 0004) and runs Terraform in
that root. It refuses `-auto-approve`.

```sh
cp infrastructure/terraform/envs/dev/backend.example.hcl infrastructure/terraform/envs/dev/backend.hcl  # once
bun run tf dev init -backend-config=backend.hcl   # once
bun run cf:bundle                                  # when Workers change
bun run tf:plan:dev                                # writes dev.tfplan, read it
bun run tf:apply:dev                               # applies exactly that plan
bun run tf:drift                                   # global and dev must report no changes
```

## D1 migrations

`terraform_data.d1_migrations` in each env root runs `scripts/d1-migrate.ts` when `migrations/d1` changes. See `migrations/d1/README.md`.

## Static checks

`bun run tf:check` runs `terraform fmt -check`, `terraform init -backend=false`, `terraform validate`,
and `tflint` for every root. It does not contact the state backend and does not create resources.

## Provider coverage gaps (cloudflare 5.27)

No first-party resource exists yet for Vectorize, Artifacts, K2, or Sandboxes/Containers. K2 uses a
temporary adapter (ADR 0006). Follow AGENTS.md
section 11.4 when a phase needs them: write an ADR first. Never call the API directly.
