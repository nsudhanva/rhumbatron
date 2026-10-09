# Build Status

## Current phase
Phase 12 - Product UX and demo narrative (in progress). Phase 13 and Phase 14 (`ci.yml` only) started.

## Completed
- P0-01 through P0-10: Bun and Turborepo monorepo, Biome, protocol package, Terraform skeleton
- P1-01 through P1-09, P1-11, P1-12: R2 remote state, DNS, dev D1, KV, R2, six Queues
- P2-01, P2-02, P2-04 through P2-11: web and API Workers on dev through Terraform
- P3-01 through P3-12: Project and Change API (Clerk), ProjectRootDO, ResourceShardDO,
  ProjectViewDO, Terraform-run D1 migrations, CAS test
- P4-01 through P4-12: Event envelope, transactional outbox, 8 K2 streams x 4 subscriptions
  (ADR 0006), event router, projector, R2 archive, duplicate-Event and K2-outage tests
- P5-01 through P5-10: ChangeWorkflow, Root Planner, Work Graph, Causal Router, Clef-flash (ADR 0008)
- P6-01 through P6-12: AgentDO with the Pi harness, tier routing, Decision Receipts, budgets,
  escalation (ADR 0009); models through AI Gateway (ADR 0007)
- P7: Context Packet per agent run (exact retrieval first; Vectorize still deferred, ADR 0003)
- P8: Artifacts canonical source and forks (ADR 0010), capped Sandbox in its own Worker
  (ADR 0011, ADR 0012)
- P9: Intents, Challenges, deterministic semantic conflict detection, Candidate fork decision
- P10: Candidate composition and verification in the Sandbox (build, unit, contract,
  Cart invariant, p95), coverage states, citation validation, R2 Evidence
- P11-01 through P11-06, P11-09, P11-10: approval policy and dialog, promotion preconditions
  (ADR 0013), ProjectRootDO compare-and-swap, `canonical.advanced`, stale-promotion smoke check
- P12-01, P12-02, P12-04: Kumo theme and app shell, Project overview, Change page with agent
  activity, Candidate page, Candidate comparison

## Active
- P12: Product Graph, Agents, Events, Verification, Workspace, and Costs pages; demo reset
  (`bun run demo:wishlist`); convergence animation
- P13: failure injection. Critical tests cover every fault except deployment failure;
  `bun run inject` runs the faults the public API can reach (docs/demo/failure-injection.md)
- P14: `.github/workflows/ci.yml` (lint, typecheck, critical tests, build, bundle, Terraform fmt
  and validate; no secrets, no deploy). `terraform-plan.yml` and `production.yml` not started

## Blocked
- P11-07, P11-08 Release (Workers Builds, ReleaseWorkflow): parked. Workers Builds has no
  Terraform resource and needs a one-time dashboard connection (ADR 0014)
- P13-12 deployment failure: needs the ReleaseWorkflow
- P1-10 Vectorize: deferred (ADR 0003)

## Cost
- Cloudflare plan: Workers Paid (account-wide, for other projects); Rhumbatron stays inside included usage
- Cloudflare fixed monthly base: $5 (shared account plan, not added by Rhumbatron)
- Sandbox: 1 instance, sleeps after 2 minutes, hard stop at 10 hours per month
- Dev pause switch: `locals.paused` in `infrastructure/terraform/envs/dev/main.tf`
- Prod: planned, not applied
- Current Change model spend: $0.00 (OpenRouter free models; Gemini on Vertex capped, ADR 0007)

## Decisions
- Terraform owns remote control-plane changes. Never `wrangler deploy`.
- Artifacts is canonical source for managed Projects (ADR 0010).
- Workers Builds connection is the one documented dashboard step (ADR 0014).
- CI runs checks only and needs no credentials. Deployment stays local through Terraform.
- Faults that need internal hooks are documented, not hooked (docs/demo/failure-injection.md).

## Next
- Finish P12 pages and `demo:wishlist`; run the section 55 runbook end to end (docs/demo/runbook.md)
- Fix the concurrent Change create race (`change-double-submit` in docs/demo/failure-injection.md)
- Dead-letter consumer and blocked Task state (section 42.7)
- Unpark P11-07/08 when the release path is chosen
