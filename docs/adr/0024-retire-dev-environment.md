# ADR 0024: Prod is the only remote environment

Status: Accepted

## Decision

Prod is the only remote environment.
Terraform root `infrastructure/terraform/envs/prod` owns it.
Terraform root `envs/global` owns the account-wide and zone-wide singletons.
There is no remote `dev` environment, no `dev` Terraform root, and no `-dev` Cloudflare resource.

Local work uses `wrangler dev`.
Every change passes the local checks first. Then Terraform deploys it to prod.
The deploy sequence is `bun run cf:bundle`, `bun run tf:plan:prod`, `bun run tf:apply:prod`, and `bun run tf:drift:prod`.

Destroy-time teardowns exist for the K2 streams and for the R2 evidence bucket.
A Terraform destroy therefore removes them without a manual step.

## Reason

The owner decided to work on prod only.
One environment halves the account-wide use of the free and included limits.

## Consequences

- No shared remote development environment exists.
- Local `wrangler dev` stays for local work.
- The Sandbox and Anthropic budgets are not split between environments. Prod uses its own caps.
- The binding drift check compares `wrangler.jsonc` with prod only.
- `scripts/cleanup-projects.ts` targets prod. It reads `CLERK_SECRET_KEY` and `CLERK_SMOKE_USER_ID` from the environment, for the prod Clerk instance.
- Live fault injection against a remote environment has no script. Critical tests prove each fault.
