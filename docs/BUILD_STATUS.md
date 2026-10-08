# Build Status

## Current phase
Phase 1 - Terraform bootstrap and Cloudflare foundation (complete for dev)

## Completed
- P0-01 through P0-10
- P1-01 through P1-09, P1-11, P1-12
- Partial Phase 2: TanStack Start web app, Hono API `/health`, Worker build script, Terraform `worker` module (not applied)
- Clerk authentication in apps/web (local development instance)

## Active
- None

## Blocked
- P1-10 Vectorize deferred to Phase 7 (ADR 0003).

## Cost
- Cloudflare plan: Workers Free
- Cloudflare fixed monthly base: $0
- Remote resources: state bucket (global); 4 zone settings (global); dev D1, KV, R2 + lifecycle, 6 Queues
- Prod: planned, not applied
- Current Change model spend: $0.00

## Decisions
- Terraform owns remote control-plane changes.
- Artifacts is canonical source for managed Projects.
- Repository tooling: docs/adr/0001-repository-tooling.md.
- User authentication: Clerk, docs/adr/0002-clerk-authentication.md.
- Naming rhumbatron-<component>-<env>; bootstrap credentials via cf CLI: docs/adr/0004.
- Provider cloudflare 5.27 has no Vectorize, Artifacts, K2, Containers, or resource-tagging resource. Section 11.4 applies.
- envs/global owns zone-wide settings. Prod is planned only until the first E2E Change.
- P1-11: Analytics Engine datasets are created on first write and Workers Logs are per-Worker, so no standalone resource exists yet.

## Next
- Phase 2: deploy web and API Workers to dev through Terraform (dev.rhumbatron.com, api-dev.rhumbatron.com).
