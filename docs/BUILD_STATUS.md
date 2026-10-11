# Build Status

## Current phase
Prod serves each Project as a live app at `<slug>.rhumbatron.com`. Models run on Anthropic Claude through AI Gateway.

## Completed
- Monorepo, Terraform roots (`bootstrap`, `envs/global`, `envs/prod`), and R2 remote state.
- Workers: web, api, coordinator, event-router, integration, agents, indexer, sandbox, apps, and the docs site.
- Durable Objects (`ProjectRootDO`, `ResourceShardDO`, `ProjectViewDO`, `AgentDO`), D1, transactional outbox, K2 (8 streams, 4 subscriptions), Queues, and 3 Workflows.
- Agent runtime: Pi harness behind `AgentRuntime`, model routing, Decision Receipts, escalation, and per-Task budgets.
- Context Packets with exact retrieval, indexer, Product Graph, Vectorize retrieval, and Haiku compaction of retry logs.
- Artifacts source, Workspace forks, stacked workspaces, and the capped Sandbox Worker.
- Intents, Challenges, advisory Claims, deterministic conflict detection, Sonnet conflict review, and Candidate forks.
- Candidate composition and verification (build, unit, contract, protected invariants, p95, security, browser, preview smoke), coverage states, and D1 and R2 Evidence.
- Approval policy, promotion preconditions, `ProjectRootDO` compare-and-swap, and `canonical.advanced`.
- Live apps (ADR 0020): previews, production pointer, release smoke check, version hosts, rollback, and app removal.
- Shared Projects (ADR 0023): invitations, owner and collaborator roles, cross-request check, `priority_wins`, and owner override.
- Project deletion for the owner and Leave project for a collaborator.
- UI pages, Flight Control (`/changes/<id>/flight`), and the notification bell.
- Dead-letter consumer with Retry and Dismiss, section 44 limits, and runaway-billing guards (ADR 0019).
- Authentication with the Clerk production instance (ADR 0002).
- Checks and scripts: `bun run check`, `bun run smoke:prod`, `bun run e2e`, `bun run cleanup:projects`, and `bun run cost:report`.
- CI: `.github/workflows/ci.yml` runs checks only and holds no deploy credentials.

## Active
- None.

## Blocked
- None.

## Cost
- Workers Paid account shared with other projects. Rhumbatron stays within free and included limits.
- Sandbox: 1 instance. Agent Workspaces and Candidate checks sleep after 2 idle minutes. The hard cap is 20 hours per month.
- Browser Run: 960 seconds per day.
- Anthropic: code budget of 100 USD per month. Model work stops at the budget (ADR 0021).
- Live apps: 60 app builds per day. Preview bundles expire after 7 days.
- Account budget alerts: 10, 25, and 100 USD (ADR 0019).
- Pause switch: `locals.paused` in `infrastructure/terraform/envs/prod/main.tf`.
- Cost report: `bun run cost:report`.

## Decisions
- Prod is the only remote environment. Local work uses `wrangler dev`.
- Terraform owns remote control-plane changes. Never `wrangler deploy`.
- Deployment sequence: `bun run cf:bundle`, `bun run tf:plan:prod`, `bun run tf:apply:prod`, and `bun run tf:drift:prod`.
- Artifacts is canonical source for managed Projects (ADR 0010).
- Models: Anthropic Claude Haiku 5.5 and Sonnet 5.5. The opus tier runs on Sonnet 5.5 unless `ALLOW_OPUS` is `true` (ADR 0021). Workers AI Clef-flash makes cheap bounded decisions.
- Sharing is per Project. The owner has priority. `priority_wins` decides a conflict, and the owner can override it (ADR 0023).
- CI runs checks only. Deployment runs locally through Terraform.

## Next
- Open issues of the Linear project `Rhumbatron`.
