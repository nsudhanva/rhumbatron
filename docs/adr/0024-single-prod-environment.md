# ADR 0024: Prod is the only remote environment

## Decision

Prod is the only remote environment.
Terraform root `infrastructure/terraform/envs/prod` owns it.
Terraform root `envs/global` owns the account-wide and zone-wide singletons.
No remote `dev` environment, no `dev` Terraform root, and no `-dev` Cloudflare resource exist.

Local work uses `wrangler dev`.
Every change passes the local checks first. Then Terraform deploys it to prod.
The deploy sequence is `bun run cf:bundle`, `bun run tf:plan:prod`, `bun run tf:apply:prod`, and `bun run tf:drift:prod`.

Destroy-time teardowns exist for the Vectorize index, the Sandbox Worker and container application, and the apps Worker.
K2 streams and the R2 evidence bucket have no destroy-time deletion in prod.
`k2-sync.ts` refuses its destroy mode for prod streams.

## Reason

One environment halves the account-wide use of the free and included limits.

## Consequences

- No shared remote development environment exists.
- Prod uses the whole Sandbox and Anthropic caps that ADR 0011 and ADR 0021 state.
- The binding drift check compares `wrangler.jsonc` with prod only.
- `scripts/cleanup-projects.ts` targets prod. It reads `CLERK_SECRET_KEY` and `CLERK_SMOKE_USER_ID` from the environment, for the prod Clerk instance.
- Critical tests prove each injected fault. No script injects a fault into a remote environment.
