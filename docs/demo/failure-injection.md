# Failure injection

This page covers Phase 13 (P13-05 to P13-12) and AGENTS.md section 42. Each fault must have an
observable recovery path. No fault may silently corrupt the Canonical State.

Two kinds of proof exist:

- **Critical tests** run the real decision code with the fault applied. They run in
  `bun run test:critical` and in CI.
- **Live injection** has no script. See [Live injection](#live-injection).

The live run does not inject a fault that needs an internal hook. This page lists each needed
hook. No one has added these hooks yet. Each hook is a test-only path into production code and
needs its own review.

## Live injection

No script injects faults live. Prod is the only remote environment
([ADR 0024](../adr/0024-retire-dev-environment.md)), and a fault run must not touch prod data. The
critical tests are the proof for every fault below.

## Fault map

| P13 | Fault (section) | Proven by critical tests | Live | Gap or hook needed |
|---|---|---|---|---|
| P13-01 to 04 | Budget stop (24, 44) | `packages/model-router/src/budget.critical.test.ts` (per-run call cap per tier, cost cap, Task share never negative, budget stop ends the Task without escalation); `route.critical.test.ts` (`budget_exhausted` stops) | `budget-limit` | See [budget stop](#budget-stop). |
| P13-05 | Duplicate delivery (42.1, 42.2, 60) | `workers/event-router/src/dedupe.critical.test.ts` (Event applied once per consumer group); `workers/coordinator/src/view-model.critical.test.ts` (duplicate Event ID ignored); `workers/event-router/src/archive.critical.test.ts` (redelivered batch, same R2 key); `workers/event-router/src/projector.critical.test.ts` (out-of-order generation); `workers/agents/src/wake-consumer.critical.test.ts` (redelivered and concurrent wake: one assignment, one run); `workers/coordinator/src/promotion-cas.critical.test.ts` (promotion retry); `workers/agents/src/conflicts.critical.test.ts` (one conflict from either detector) | `change-retry`, `change-double-submit`, `project-double-submit`, `candidate-double-submit`, `approval-double-submit`, `promotion-double-submit` | Live K2 redelivery needs a replay hook. See [duplicate Event](#duplicate-event). |
| P13-06 | Expired Claim (42.3) | `workers/coordinator/src/claims.critical.test.ts` (expired claim does not block and is reported overdue, renew after expiry rejected, alarm at the earliest lease); `packages/protocol/src/activity.critical.test.ts` (a lapsed lease shows as expired) | none | Claims are internal RPC only. See [expired Claim](#expired-claim). |
| P13-07 | Sandbox loss (30.1, 42.5) | `workers/integration/src/sandbox-loss.critical.test.ts` (a check after Sandbox loss restores the checkout from the Candidate fork at the composed commit; an intact checkout is reused; a missing commit fails, never checks the wrong tree; repo tokens are revoked) | none | See [Sandbox loss](#sandbox-loss). |
| P13-08 | K2 publication outage (18, 42.6) | `workers/coordinator/src/outbox-recovery.critical.test.ts` (Events kept during the outage and published once K2 recovers; attempt limit keeps the row visible as failed); `outbox.critical.test.ts` (capped backoff) | none | See [K2 outage](#k2-outage). |
| P13-09 | Model timeout (42.8) | `packages/model-router/src/route.critical.test.ts` (timeout retries once at the same tier, a second transport failure stops, never escalates); `decision.critical.test.ts` (Clef abstains on malformed output); `workers/integration/src/root-planner.critical.test.ts` (planner repairs once, then gives up) | none | See [model timeout](#model-timeout). |
| P13-10 | Poison command (20, 42.7) | `workers/agents/src/queue-poison.critical.test.ts` (a failing wake is retried, never acked; the rest of the batch is acked; invalid and stale wakes are acked); `scripts/inject/dead-letter.critical.test.ts` (every Terraform and local Queue consumer has a dead-letter Queue and 1 to 5 retries) | none | The event router consumes the dead-letter Queue (`workers/event-router/src/dead-letter.ts`, tested in `dead-letter.critical.test.ts`): the Task becomes blocked and the Project and Change pages show Retry and Dismiss. A live poison hook is still to build. See [poison command](#poison-command). |
| P13-11 | Stale Candidate (36, 42.9) | `workers/coordinator/src/promotion-cas.critical.test.ts` (stale expected generation, changed tree, race loser marked stale); `packages/evidence/src/promotion.critical.test.ts` (base behind canonical reports stale) | `stale-candidate`, `promotion-double-submit`, `early-promotion`; also `bun run smoke:sandbox` | None. |
| P13-12 | Deployment failure (21.3, 42.10) | `workers/integration/src/release.critical.test.ts` (one release per generation; a newer promotion supersedes an in-flight release, which can never deploy afterwards; a 404 feature probe or a probe without a response never marks a release deployed; only the build of the promoted commit counts); `promotion-cas.critical.test.ts` (generations only advance) | `release-smoke-failure` (`--only`) | See [deployment failure](#deployment-failure). |

## Hooks needed

### Budget stop

OpenRouter free models cost $0. On that path, `checkRunBudget` receives `spentUsd: 0` in
`AgentDO.beforeModelCall`. The cost cap cannot fire live without spending Vertex credit, so the
live stop is the call cap. The per-run cap fails the Task. The daily cap (`AGENT_DAILY_CALL_CAP`,
D1 `usage_counters` row `agent-model-calls`) ends the run with `budget_exhausted`. `failTask`
turns that into Change status `budget_blocked`.

Hook: A dev-only internal RPC on the agents Worker that sets today's `agent-model-calls` counter
to the cap for the inject run. Expected: The first agent run of a planned Change stops with
`budget_exhausted`. The Change shows `budget_blocked`, and the existing state stays readable.
This costs at most one Root Planner call.

Of the section 44 limits, `workers/agents/src/limits.ts` enforces `max_active_agents_per_change`
(8), `max_active_sandboxes_per_change` (4), and the attempt limit per tier (2). `packages/conflict`
enforces `maxCandidates` (3). Nothing enforces the per-Change `max_sandbox_seconds_per_change` and
`max_browser_seconds_per_change`. The monthly Sandbox cap and the daily Browser Run cap per
environment apply instead.

### Duplicate Event

Hook: a replay command for the event router that re-consumes one K2 offset range for one
subscription (for example a `k2.replay` integration command with stream, subscription, and offset
range). Expected: `claimEvents` reports every Event as a duplicate. The live view sequence does
not advance, and no second R2 archive object appears.

### Expired Claim

Claims are `ResourceShardDO` RPCs (`acquireClaim`, `renewClaim`, `releaseClaim`) with no public
route. Hook: a dev-only internal RPC that acquires a Claim for a test agent with `ttlMs: 5000` and
never renews it. Expected: After the lease ends, the shard alarm emits `claim.expired`. The
activity feed shows the Claim as expired, and a second agent can acquire the resource.

### Sandbox loss

Hook: a dev-only internal RPC on the agents Worker that calls `destroy()` on a Project's Sandbox
(`getSandbox(SANDBOX, "proj-<id>")`). Run it between Candidate composition and the first check,
then let `CandidateVerificationWorkflow` continue. Expected: The checks pass on a checkout restored
from the Candidate fork, and the Candidate verifies. Task Workspaces need the same proof.
`openWorkspace` reuses an existing fork on a retried run, but no test covers that path yet.

### K2 outage

Hook: a dev-only runtime flag (for example KV key `inject:k2-down-until` in `rhumbatron-config-prod`)
that `OutboxPublisher` checks before each send and treats as a retryable K2 failure. KV values are
runtime data, not Terraform configuration. Expected: Mutations still commit, and unpublished
outbox rows grow. The dashboard lags. After the flag expires, every Event publishes once.

### Model timeout

Hook: a dev-only per-Change flag that makes the gateway client abort the next model call after
1 ms. Expected: One same-tier retry, and then the Task stops with `repeated_transport_failure`.
No escalation to a stronger tier occurs. Live injection spends free-tier model calls (50 per day).

### Poison command

Consumers retry a failure. After 3 retries, the Queue moves it to `rhumbatron-dead-letter-prod`.
The event router consumes the dead-letter Queue (`workers/event-router/src/dead-letter.ts`). It
records `task.failed` and blocks the Task. The Project and Change pages then show Retry and
Dismiss (section 42.7).

Still needed for a live proof: a dev-only internal RPC that sends one schema-valid command whose
handler always throws (the public API cannot enqueue arbitrary commands, by design).

### Deployment failure

ReleaseWorkflow (ADR 0018) observes the Workers Build of each promoted commit, confirms the
deployment, and smoke checks the release URL. Injection:

```sh
# No script calls the route. It answers where FIXTURES_ENABLED is set, or locally.
```

- The fault needs a deployed release. That is the smoke user's `acme-shop-live` Project
  (created by a live run) with its Workers Builds connection and one promotion that deployed. The
  fault never runs by default, because it changes the demo Project's release state.
- What happens: `POST /v1/projects/:projectId/releases/inject-failure` answers only where
  `FIXTURES_ENABLED` is set, or in dev and local. It probes the live release URL with the normal
  smoke probes plus `/__rhumbatron/injected-missing-route`. The app returns a real 404, so the
  smoke check fails through the normal path. The result is release `smoke_failed`, event
  `release.smoke_failed` with `injected: true`, and Evidence `release-s<N>-injected` in R2 and D1.
- Expected: The Candidate page and the inbox show the failed release. The Canonical Generation
  stays, and nothing is deleted.
- Recovery is a new canonical transition (section 42.10). Run a new Change and promote it. Its
  release (`S<N+1>`) builds, deploys, and passes the smoke check.
- A real build failure (a promoted commit whose build fails) takes the `failed` path with
  `deployment.failed`. The live run does not inject it, because it needs a broken commit on
  canonical `main`.
