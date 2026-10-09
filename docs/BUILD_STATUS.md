# Build Status

## Current phase
Phase 7 completion (indexer, stored Product Graph, Vectorize) and the production environment. Phases 12 and 13 are complete except items that need the parked release.

## Completed
- P0 through P6: Monorepo skeleton, base Cloudflare infrastructure, Workers, Durable Objects, D1, K2 event plane, workflows, and agent runtime with AI Gateway.
- P7: Exact retrieval Context Packets per agent run.
- P8: Artifacts canonical source and workspace forks, and capped Sandbox Worker.
- P9: Intents, Challenges, deterministic semantic conflict detection, model conflict review (Sonnet and Opus escalation), and Candidate forks.
- P10: Sandbox Candidate composition and verification (build, unit, contract, Cart invariant, p95, security), coverage states, D1 and R2 Evidence.
- P11-01 through P11-06, P11-09, P11-10: Approval policy and dialog, promotion preconditions, ProjectRootDO compare-and-swap, `canonical.advanced`, and stale-promotion checks.
- P12: All UI pages, Flight Control (`/changes/<id>/flight`), and notification bell.
- P13: Dead-letter consumer with Retry and Dismiss, section 44 limits, advisory Claims, failure injection (`bun run inject`), smoke checks (`bun run smoke:dev`, `bun run smoke:sandbox`), and cleanup (`bun run cleanup:projects`).
- P14: `.github/workflows/ci.yml` (checks only; no deploy credentials).
- Milestone: A real model-driven Change ran end to end on dev (`https://dev.rhumbatron.com`). The Root Planner and four agents on Gemini via Vertex (`MODEL_PROVIDER=vertex`) built shared wishlists on stacked workspaces. The Candidate composed automatically, passed build, 26 unit tests, contract tests, the Cart invariant check, p95 performance, and 9 authorization security tests. It was approved and promoted from S0 to S1. Model cost was about 0.91 USD.

## Active
- Phase 7 indexer, stored Product Graph, and Vectorize semantic retrieval.
- Production environment Terraform.

## Blocked
- P11-07 and P11-08: Release via Workers Builds (parked; ADR 0014).
- P13 deployment-failure injection (depends on the parked release workflow).

## Cost
- Workers Paid account shared with other projects. Rhumbatron stays within free and included limits.
- Sandbox: 1 instance; agent workspaces sleep after 10 idle minutes, Candidate checks after 2; hard cap at 10 hours per month.
- Browser Run: Capped at 500 seconds per day.
- Gemini on Vertex: Capped by AI Gateway at 9 USD per 30 days.
- Dev pause switch: `locals.paused` in `infrastructure/terraform/envs/dev/main.tf`.
- Cost reporting: `bun run cost:report`.

## Decisions
- Terraform owns remote control-plane changes. Never `wrangler deploy`.
- Deployment sequence: `bun run cf:bundle`, `bun run tf:plan:dev`, `bun run tf:apply:dev`, and `bun run tf:drift`.
- Artifacts is canonical source for managed Projects (ADR 0010).
- Release via Workers Builds remains parked (ADR 0014).
- CI runs checks only and needs no credentials. Deployment stays local through Terraform.

## Next
- Complete Phase 7 stored Product Graph and indexer.
- Complete production environment Terraform.
- Unpark P11-07 and P11-08 release workflow when the release path is ready.
