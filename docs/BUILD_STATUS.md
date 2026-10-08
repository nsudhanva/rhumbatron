# Build Status

## Current phase
Phase 4 - Event and command fabric

## Completed
- P0-01 through P0-10
- P1-01 through P1-09, P1-11, P1-12
- P2-01, P2-02, P2-04 through P2-11
- P3-01 through P3-03: schemas, first migration, Terraform-run migrations (applied to dev)
- P4-01 to P4-05, P4-07: envelopes, transactional outbox, alarm publisher to K2 (verified: project.created on dev)
  - 8 K2 streams x 4 subscriptions on dev (ADR 0006)
- P3-04, P3-06 to P3-12: Durable Objects, Clerk-authenticated Project and Change API, live on dev
  - `bun run smoke:dev`: 16 checks including the authenticated flow (Clerk smoke user): web and API live on dev via Terraform
  - https://dev.rhumbatron.com, https://api-dev.rhumbatron.com (`bun run smoke:dev`)
- Clerk authentication in apps/web (local development instance)

## Active
- P3-05 ResourceShardDO in review: deployed, first live use is Phase 9 claims
- P2-03 Zustand (add with the first client-state page)

## Blocked
- P1-10 Vectorize deferred to Phase 7 (ADR 0003).

## Cost
- Cloudflare plan: account is Workers Paid for other projects; Rhumbatron budget is free-tier limits only
- Rhumbatron monthly cost target: $0
- Remote resources: state bucket (global); 4 zone settings (global); dev D1, KV, R2 + lifecycle, 6 Queues; dev web and API Workers with custom domains
- Prod: planned, not applied
- Current Change model spend: $0.00

## Decisions
- Terraform owns remote control-plane changes.
- Artifacts is canonical source for managed Projects.
- Repository tooling: docs/adr/0001-repository-tooling.md.
- User authentication: Clerk, docs/adr/0002-clerk-authentication.md.
- Naming rhumbatron-<component>-<env>; bootstrap credentials via cf CLI: docs/adr/0004.
- Provider cloudflare 5.27 has no Vectorize, Artifacts, K2, Containers, or resource-tagging resource. Section 11.4 applies.
- Durable Object Workers deploy via cloudflare_workers_script: docs/adr/0005.
- envs/global owns zone-wide settings. Prod is planned only until the first E2E Change.
- P1-11: Analytics Engine datasets are created on first write and Workers Logs are per-Worker, so no standalone resource exists yet.

## Next
- P4-06 dedupe, P4-08 event router (K2 pull consumer), P4-09 projector, P4-10 R2 archive, P4-11/12 fault tests.
- Phase 3 (Project and Change state, Durable Objects).
- Tracking: Linear project Rhumbatron (AGENTS.md rule 49).
