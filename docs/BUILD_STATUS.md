# Build Status

## Current phase
Phase 17a - Shared Projects

## Completed
- Phases 0 to 13: the monorepo, the Terraform roots (`bootstrap`, `envs/global`, `envs/prod`), the R2 remote state, and the Workers web, api, coordinator, event-router, integration, agents, indexer, sandbox, apps, and docs.
- Durable Objects (`ProjectRootDO`, `ResourceShardDO`, `ProjectViewDO`, `AgentDO`), D1, the transactional outbox, K2 (8 streams, 4 subscriptions), 6 Queues, and 3 Workflows.
- Agent runtime: the Pi harness behind `AgentRuntime`, model routing, Decision Receipts, escalation, and per-Task budgets.
- Context Packets with exact retrieval, the indexer, the Product Graph, Vectorize retrieval, and Haiku compaction of retry logs.
- Artifacts source, Workspace forks, and the capped Sandbox Worker.
- Intents, Challenges, advisory Claims, deterministic conflict detection, Sonnet conflict review, and Candidate forks. Complementary Tasks integrate into one Candidate.
- Candidate composition and verification (build, unit, contract, protected invariants, performance, security, browser, acceptance, preview smoke), coverage states, and D1 and R2 Evidence.
- Candidate selection (ADR 0026). Sibling Candidates wait for each other, and Evidence ranks them. The Integration Judge breaks ties with cited Evidence. The acceptance check gates auto-promotion.
- Approval policy, promotion preconditions, `ProjectRootDO` compare-and-swap, `canonical.advanced`, and stale Candidate recomposition. The default policy auto-promotes `low` and `medium` risk. A Candidate that waits for a person gets an inbox item and the Ship action on the Change page.
- Phase 14, CI/CD (ADR 0031): `ci.yml` checks each pull request. `production.yml` deploys each push to `main` through Terraform, with a plan guard, a drift check, and the smoke checks.
- Phase 16, live apps (ADR 0020): previews, the production pointer, the release smoke check, version hosts, rollback, and app removal.
- Phase 17a, shared Projects (ADR 0023, ADR 0025, ADR 0028): invitations, the owner, admin, member, and viewer roles, and member request review. The intake gate reads each request against the current app, asks at most one round of questions, and sends small details to the Root Planner as assumptions. `needs_input` takes clarify answers. First-come conflicts between people (ADR 0032). Project deletion for the owner, Leave project for the other roles, and the Settings page.
- The dead-letter consumer with Retry and Dismiss, the per-Change limits on Agents, Sandboxes, and attempts, and the runaway-billing guards (ADR 0019).
- Authentication with the Clerk production instance (ADR 0002).

## Active
- P17a-13 Remove all user Projects on prod (HOM-243).

## Blocked
- None.

## Cost
- Cloudflare plan: Workers Paid, shared with other projects. Rhumbatron stays within the free and included limits.
- Cloudflare fixed monthly base: $5.
- Sandbox: 1 instance. It sleeps after 2 idle minutes. The cap is 20 hours per month.
- Browser Run: 960 seconds per day.
- Anthropic: 100 USD per calendar month. Model work stops at the budget (ADR 0021).
- Live apps: 60 app builds per day. Preview bundles expire after 7 days.
- Account budget alerts: 10, 25, and 100 USD (ADR 0019).
- Pause switch: `locals.paused` in `infrastructure/terraform/envs/prod/main.tf`.
- Cost report: `bun run cost:report`.

## Decisions
- Prod is the only remote environment (ADR 0024). Local work uses `wrangler dev`.
- Terraform owns remote control-plane changes. Nobody runs `wrangler deploy`.
- Artifacts holds the canonical source of managed Projects (ADR 0010).
- Models: Anthropic Claude Haiku 5.5 and Sonnet 5.5. The opus tier runs on Sonnet 5.5 unless `ALLOW_OPUS` is `true` (ADR 0021). Workers AI Clef-flash makes cheap bounded decisions.
- The owner and admin roles cover administration only. The system decides between requests and asks the requester when it cannot decide (ADR 0025). In a conflict between two people, the earlier requester chooses (ADR 0032).
- Each push to `main` deploys through Terraform in GitHub Actions. The deploy secrets are in the `production` environment, which only `main` can use.

## Next
- Open issues of the Linear project `Rhumbatron`.
