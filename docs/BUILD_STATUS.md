# Build Status

## Current phase
Phase 5 complete on dev; Phase 6 - Agent runtime and model routing next

## Completed
- P0-01 through P0-10
- P1-01 through P1-09, P1-11, P1-12
- P2-01, P2-02, P2-04 through P2-11
- P3-01 through P3-03: schemas, first migration, Terraform-run migrations (applied to dev)
- P4-01 to P4-12: envelopes, outbox, K2 publisher, event router (nudge + 1-min cron), D1 dedupe,
  projector, R2 audit archive (gzipped NDJSON), duplicate-event and K2-outage critical tests
  - verified on dev: project.created reaches the live view in about 3 s and is archived to R2
  - 8 K2 streams x 4 subscriptions on dev (ADR 0006)
- P3-04, P3-06 to P3-12: Durable Objects, Clerk-authenticated Project and Change API, live on dev
  - `bun run smoke:dev`: 16 checks including the authenticated flow (Clerk smoke user): web and API live on dev via Terraform
  - https://dev.rhumbatron.com, https://api-dev.rhumbatron.com (`bun run smoke:dev`)
- Clerk authentication in apps/web (local development instance)
- Model access (pulled forward from Phase 6 for P5-02): P6-04 AI Gateway `rhumbatron-models-dev`,
  P6-05 OpenRouter free-model client, P6-06 deterministic routing rules (`packages/model-router`)
  - `bun run smoke:models`: one tool call per tier through the gateway ($0), plus one Vertex fallback call
  - Gemini on Vertex AI is the paid backup, capped at $9 per 30 days by the gateway (ADR 0007)

- P5-01 to P5-10: ChangeWorkflow, Root Planner, D1 Work Graph, scheduler, Causal Router, Clef-flash
  (capped), wake consumer, false-wakeup metric (ADR 0008)
  - verified on dev: the Wishlist goal compiled into 7 Tasks; only the root Task was dispatched and assigned
  - `bun run smoke:plan` runs this end to end (1 to 4 free model calls)

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
- Current Change model spend: $0.00 (OpenRouter `:free` models only; 50 requests/day until $10 lifetime credits)

## Decisions
- Terraform owns remote control-plane changes.
- Artifacts is canonical source for managed Projects.
- Repository tooling: docs/adr/0001-repository-tooling.md.
- User authentication: Clerk, docs/adr/0002-clerk-authentication.md.
- Naming rhumbatron-<component>-<env>; bootstrap credentials via cf CLI: docs/adr/0004.
- Provider cloudflare 5.27 has no Vectorize, Artifacts, K2, Containers, or resource-tagging resource. Section 11.4 applies.
- Durable Object Workers deploy via cloudflare_workers_script: docs/adr/0005.
- ChangeWorkflow, Work Graph persistence, causal routing: docs/adr/0008.
- envs/global owns zone-wide settings. Prod is planned only until the first E2E Change.
- Models: OpenRouter free models through AI Gateway, Gemini (Vertex, GCP credit) as a capped backup: docs/adr/0007.
- P1-11: Analytics Engine datasets are created on first write and Workers Logs are per-Worker, so no standalone resource exists yet.

## Next
- Phase 6: AgentRuntime, PiAgentRuntime, AgentDO, Decision Receipts, budgets, escalation.
- Tracking: Linear project Rhumbatron (AGENTS.md rule 49).
