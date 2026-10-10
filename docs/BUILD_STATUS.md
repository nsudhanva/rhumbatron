# Build Status

## Current phase
Reliability and cost hardening on dev and prod. Phases 0 through 13 are complete except the live release (blocked).

## Completed
- P0 through P6: Monorepo skeleton, base Cloudflare infrastructure, Workers, Durable Objects, D1, K2 event plane, workflows, and agent runtime with AI Gateway.
- P7: Exact retrieval Context Packets, indexer, stored Product Graph, Vectorize retrieval, and Haiku retry-log compaction (deployed).
- P8: Artifacts canonical source, workspace forks, workspace manifest per run (P8-03), and capped Sandbox Worker.
- P9: Intents, Challenges, deterministic semantic conflict detection, model conflict review (Sonnet and Opus escalation), and Candidate forks.
- P10: Sandbox Candidate composition and verification (build, unit, contract, Cart invariant, p95, security), coverage states, D1 and R2 Evidence.
- P11-01 through P11-10 (release through Workers Builds is built and applied, ADR 0018): Approval policy and dialog, promotion preconditions, ProjectRootDO compare-and-swap, `canonical.advanced`, and stale-promotion checks.
- P12: All UI pages, Flight Control (`/changes/<id>/flight`), and notification bell.
- P13: Dead-letter consumer with Retry and Dismiss, section 44 limits, advisory Claims, failure injection (`bun run inject`), smoke checks (`bun run smoke:dev`, `bun run smoke:sandbox`), and cleanup (`bun run cleanup:projects`).
- P14: `.github/workflows/ci.yml` (checks only; no deploy credentials). CI/CD is otherwise skipped by choice.
- Production: `https://rhumbatron.com` is served by Terraform from `envs/prod` (ADR 0017). Smoke: `bun run smoke:prod`.
- Runaway-billing guards (ADR 0019): Durable Object alarm caps, causal wakeup caps, and account budget alerts at 10, 25, and 100 USD.
- Milestone: A real model-driven Change ran end to end on dev (`https://dev.rhumbatron.com`). The Root Planner and four agents on Gemini via Vertex (`MODEL_PROVIDER=vertex`) built shared wishlists on stacked workspaces. The Candidate composed automatically, passed build, 26 unit tests, contract tests, the Cart invariant check, p95 performance, and 9 authorization security tests. It was approved and promoted from S0 to S1. Model cost was about 0.91 USD.

## Active
- None.

## Blocked
- Live release of Acme Shop Live (P11-07, P11-08, P13-12 live run): the Workers Builds connection for
  `rhumbatron-acme-shop-dev` has no build configuration or trigger.
- Google sign-in on prod: the Clerk production instance (rhumbatron.com) has email and password only
  until a Google Cloud OAuth client exists.

## Cost
- Workers Paid account shared with other projects. Rhumbatron stays within free and included limits.
- Sandbox: 1 instance; agent workspaces sleep after 10 idle minutes, Candidate checks after 2; hard cap at 5 hours per month per environment.
- Browser Run: Capped at 250 seconds per day per environment.
- Gemini on Vertex: Capped by AI Gateway at 40 USD (dev) and 10 USD (prod) per 30 days.
- Pause switch: `locals.paused` in `infrastructure/terraform/envs/{dev,prod}/main.tf`.
- Cost reporting: `bun run cost:report`.

## Decisions
- Terraform owns remote control-plane changes. Never `wrangler deploy`.
- Deployment sequence: `bun run cf:bundle`, `bun run tf:plan:dev`, `bun run tf:apply:dev`, and `bun run tf:drift`.
- Artifacts is canonical source for managed Projects (ADR 0010).
- Release via Workers Builds: promotion push, observed by ReleaseWorkflow (ADR 0018).
- CI runs checks only and needs no credentials. Deployment stays local through Terraform.

## Next
- Connect Workers Builds for Acme Shop Live, promote once, run `bun run smoke:release`.
