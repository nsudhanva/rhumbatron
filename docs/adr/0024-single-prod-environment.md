# ADR 0024: Prod is the only remote environment

## Context

Each remote environment uses its own share of the account-wide free and included limits. The
account shares these limits with other projects (ADR 0017).

## Decision

- Prod is the only remote environment. The Terraform root `infrastructure/terraform/envs/prod`
  owns it. The Terraform root `envs/global` owns the account-wide and zone-wide singletons.
- Each Rhumbatron Cloudflare resource has the `-prod` suffix or is a singleton in `envs/global`.
- Local work uses the local servers (`bun run dev`: Wrangler and Vite).
- Each change passes the local checks first. Then Terraform deploys it to prod with this sequence:
  1. `bun run cf:bundle`
  2. `bun run tf:plan:prod`
  3. `bun run tf:apply:prod`
  4. `bun run tf:drift:prod`
- Destroy-time teardowns exist for the Vectorize index, the Sandbox Worker and container
  application, and the apps Worker. The K2 streams and the R2 evidence bucket have no destroy-time
  deletion. `k2-sync.ts` refuses its destroy mode for prod streams.

## Consequences

- One environment uses half of the account-wide limits that two environments use.
- Prod holds the Sandbox and Anthropic caps that ADR 0011 and ADR 0021 state.
- The binding drift check compares `wrangler.jsonc` with prod only.
- `scripts/cleanup-projects.ts` targets prod. It reads `CLERK_SECRET_KEY` and
  `CLERK_SMOKE_USER_ID` of the prod Clerk instance from the environment.
- Critical tests prove each injected fault. The only fault path on prod is the release failure
  injection route. It needs the Project owner or an admin (ADR 0020).
