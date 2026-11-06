# Build Status

## Current phase
Phase 17a - Shared Projects

## Completed
- Phases 0 to 13: the monorepo, the application modules (api, coordinator, agents, event-router, integration, indexer, apps), the web app, and the docs site.
- The Docker Compose stack behind Caddy at `https://rhumbatron.localhost` (ADR 0034): `core` hosts the API, the coordinator, the agents, integration, the event router, and the indexer in one Bun process. The other services are `web`, `apps`, `git`, `nats`, `objects`, `browser`, `embed`, `rerank`, `sandboxd`, `egress`, and `socket-proxy`.
- Actors (`ProjectRootDO`, `ResourceShardDO`, `ProjectViewDO`, `AgentDO`) on the actor host, the SQLite product database, the transactional outbox, the JetStream event log (8 streams, 4 subscriptions), 6 command queues, and 3 workflows on the workflow engine.
- Agent runtime: the Pi harness behind `AgentRuntime`, model routing, Decision Receipts, escalation, and per-Task budgets.
- Context Packets with exact retrieval, the indexer, the Product Graph, vector retrieval, and Haiku compaction of retry logs.
- Project source on the git service, Workspace forks, and capped Sandboxes on sandboxd.
- Intents, Challenges, advisory Claims, deterministic conflict detection, Sonnet conflict review, and Candidate forks. Complementary Tasks integrate into one Candidate.
- Candidate composition and verification (build, unit, contract, protected invariants, performance, security, browser, acceptance, preview smoke), coverage states, and Evidence in the product database and the object store.
- Candidate selection (ADR 0026). Sibling Candidates wait for each other, and Evidence ranks them. The Integration Judge breaks ties with cited Evidence. The acceptance check gates auto-promotion.
- Approval policy, promotion preconditions, `ProjectRootDO` compare-and-swap, `canonical.advanced`, and stale Candidate recomposition. The default policy auto-promotes `low` and `medium` risk. A Candidate that waits for a person gets an inbox item and the Ship action on the Change page.
- Phase 14, CI: `.github/workflows/ci.yml` checks each pull request. No workflow deploys.
- Phase 16, live apps (ADR 0020): previews, the production pointer, the release smoke check, version hosts, rollback, and app removal, on workerd with the Worker Loader.
- Phase 17a, shared Projects (ADR 0023, ADR 0025, ADR 0028): invitations, the owner, admin, member, and viewer roles, and member request review. The intake gate reads each request against the current app, asks at most one round of questions, and sends small details to the Root Planner as assumptions. `needs_input` takes clarify answers. First-come conflicts between people (ADR 0032). Project deletion for the owner, Leave project for the other roles, and the Settings page.
- The dead-letter consumer with Retry and Dismiss, the per-Change limits on Agents, Sandboxes, and attempts, and the daily call quotas.
- Authentication with a Clerk development instance (ADR 0002).

## Active
- None.

## Blocked
- None.

## Cost
- Fixed monthly cost: none. Every service is open source and runs in Docker.
- Anthropic: 100 USD per calendar month (`ANTHROPIC_MONTHLY_BUDGET_USD`). Model work stops at the budget (ADR 0021).
- Sandbox: at most 4 live, each removed after 2 idle minutes. The cap is 20 hours per month (`SANDBOX_MONTHLY_SECONDS`).
- Browser checks: 960 seconds per day (`BROWSER_DAILY_SECONDS`).
- Live apps: 60 app builds per day. Preview rows and data stores expire after 7 days.
- Pause: `bun run stack:down`.
- Spend: `/admin` in the web app.

## Decisions
- The stack is one Docker Compose project on open-source backends (ADR 0034). `bun run stack:up` starts it.
- The git service holds the canonical source of managed Projects (ADR 0010).
- Models: Anthropic Claude Haiku 5.5 and Sonnet 5.5, called on the Anthropic API. The opus tier runs on Sonnet 5.5 unless `ALLOW_OPUS` is `true` (ADR 0021). Clef-flash questions go to Claude Haiku with a forced tool call.
- The owner and admin roles cover administration only. The system decides between requests and asks the requester when it cannot decide (ADR 0025). In a conflict between two people, the earlier requester chooses (ADR 0032).

## Next
- None.
