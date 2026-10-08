# Terraform

Terraform owns every Cloudflare control-plane resource. Do not change remote infrastructure with
the dashboard, `wrangler deploy`, or direct API writes.

## Layout

| Path | Purpose |
|---|---|
| `bootstrap/` | Creates the R2 state bucket. Local state first, then migrated to R2. |
| `envs/dev/` | Dev environment root. State key `dev/terraform.tfstate`. |
| `envs/prod/` | Prod environment root. State key `prod/terraform.tfstate`. Create after the first end-to-end Change works. |
| `modules/` | Reusable modules (`worker`, `dns`, `state`, `async`, `ai`, `code-storage`, `observability`, `security`). |

## Credentials

Keep all credentials outside the repository.

| Variable | Use |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare provider. |
| `TF_VAR_account_id` | Cloudflare account ID. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Bucket-scoped R2 key for the S3 backend. |

## Bootstrap (run once)

1. `terraform -chdir=infrastructure/terraform/bootstrap init`
2. `terraform -chdir=infrastructure/terraform/bootstrap plan`
3. `terraform -chdir=infrastructure/terraform/bootstrap apply`
4. Create a bucket-scoped R2 API token for `rhumbatron-terraform-state`. Export its keys.
5. Add a `backend "s3"` block to `bootstrap/versions.tf` with key `bootstrap/terraform.tfstate`
   and the same settings as `envs/dev/versions.tf`.
6. `terraform -chdir=infrastructure/terraform/bootstrap init -migrate-state -backend-config=../envs/dev/backend.hcl`
7. Confirm the state object exists in R2. Then delete the local `terraform.tfstate*` files.

## Environment workflow

```sh
cp infrastructure/terraform/envs/dev/backend.example.hcl infrastructure/terraform/envs/dev/backend.hcl
terraform -chdir=infrastructure/terraform/envs/dev init -backend-config=backend.hcl
bun run cf:bundle
terraform -chdir=infrastructure/terraform/envs/dev plan
terraform -chdir=infrastructure/terraform/envs/dev apply   # never -auto-approve
terraform -chdir=infrastructure/terraform/envs/dev plan -detailed-exitcode   # must be clean
```

## Static checks

`bun run tf:check` runs `terraform fmt -check`, `terraform init -backend=false`, `terraform validate`,
and `tflint` for every root. It does not contact the state backend and does not create resources.

## Provider coverage gaps (cloudflare 5.27)

No first-party resource exists yet for Artifacts, K2, or Sandboxes/Containers. Follow AGENTS.md
section 11.4 when a phase needs them: write an ADR first. Never call the API directly.
