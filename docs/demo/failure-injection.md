# Failure injection

Phase 13 (P13-05 to P13-12) and AGENTS.md section 42. Each fault must have an observable recovery
path, and no fault may silently corrupt the Canonical State.

Two kinds of proof exist:

- **Critical tests** run the real decision code with the fault applied. They run in
  `bun run test:critical` and in CI.
- **Live injection** (`bun run inject`) applies faults through the public dev API, as the Clerk
  smoke user, and reports pass or fail per fault.

A fault that needs an internal hook is not injected live. The hook it needs is listed below.
Nobody added these hooks: each one is a test-only path into production code and needs its own
review.

## Run live injection

```sh
bun run inject                      # default faults: no Sandbox, no model calls, ~15 D1 rows
bun run inject --sandbox            # adds the Candidate faults: one Sandbox verification
bun run inject --only=stale-candidate,promotion-double-submit --sandbox
bun run inject --keep               # do not archive the Projects it created
```

- Credentials: the same Keychain items as `bun run smoke:dev`
  (`rhumbatron-clerk-secret-key-dev`, `rhumbatron-clerk-smoke-user-id-dev`). No new secret.
- Target: dev only (`https://api-dev.rhumbatron.com`). Dev must be running (not paused).
- Model calls: none. Every Change is created with `startPlanning: false`.
- Sandbox: none by default. `--sandbox` runs one Acme Shop baseline Candidate verification (a few
  minutes of the 10 h monthly Sandbox cap, ADR 0011). The stale Candidate stops at workflow step 1
  and never opens the Sandbox.
- Cleanup: every Project the run created is archived with `DELETE /v1/projects/:id`, which deletes
  its Artifacts repos. Evidence and D1 rows stay.
- A fault that could not run is reported as `FAIL`, never as a skipped pass (section 34.4.1).

| Fault ID | Default | What it does | Expected recovery |
|---|---|---|---|
| `change-retry` | yes | Creates a Change twice with one `clientRequestId`. | `201`, then `200` with the same Change ID. |
| `change-double-submit` | yes | Sends the two creates concurrently. | Both succeed with one Change ID; the Project stores one Change. |
| `project-double-submit` | yes | Creates two Projects with one slug concurrently. | Exactly one `201` and one `409`. |
| `budget-limit` | yes | Creates Changes with budget `$1000` and `$0`. | Both `400`. |
| `candidate-without-source` | yes | Asks for a Candidate on a Project with no source. | `409`; no Candidate row; no Sandbox. |
| `candidate-double-submit` | `--sandbox` | Three concurrent Candidate creates for one composition. | All `202`, one Candidate ID, one Candidate row, one verification. |
| `early-promotion` | `--sandbox` | Promotes while the Candidate still verifies. | `409 blocked`; the Canonical Generation does not move. |
| `approval-cross-change` | `--sandbox` | Approves a Candidate through another Change's path. | `404`; no decision recorded. |
| `approval-double-submit` | `--sandbox` | Two concurrent approvals, then a conflicting reject. | Without a gate: both `409 not_required`. With a gate: one decision, identical repeat accepted, reject `409 already_decided`. |
| `promotion-double-submit` | `--sandbox` | Two concurrent promotions of the verified Candidate. | Both `200`; exactly one first promotion; generation advances once. |
| `stale-candidate` | `--sandbox` | Promotes a Candidate built on the old base. | `409 stale`; Candidate marked `stale`; generation does not move. |

### Known risk found while writing `change-double-submit`

`POST /v1/projects/:projectId/changes` reads by `clientRequestId` and then inserts. Two concurrent
requests can both miss the read; the second insert then hits the `UNIQUE (project_id,
client_request_id)` constraint (migration 0001) and the request fails with `500` instead of
returning the first Change. The table cannot hold a duplicate, so state stays correct, but the
retry contract (section 60) is broken for that caller. Expected fix in `workers/api/src/projects.ts`:
`INSERT ... ON CONFLICT (project_id, client_request_id) DO NOTHING`, then read the row and return
`200` when the insert changed nothing. The live fault reports `FAIL` until that ships.

## Fault map

| P13 | Fault (section) | Proven by critical tests | Live (`bun run inject`) | Gap or hook needed |
|---|---|---|---|---|
| P13-01 to 04 | Budget stop (24, 44) | `packages/model-router/src/budget.critical.test.ts` (per-run call cap per tier, cost cap, Task share never negative, budget stop ends the Task without escalation); `route.critical.test.ts` (`budget_exhausted` stops) | `budget-limit` | See [budget stop](#budget-stop). |
| P13-05 | Duplicate delivery (42.1, 42.2, 60) | `workers/event-router/src/dedupe.critical.test.ts` (Event applied once per consumer group); `workers/coordinator/src/view-model.critical.test.ts` (duplicate Event ID ignored); `workers/event-router/src/archive.critical.test.ts` (redelivered batch, same R2 key); `workers/event-router/src/projector.critical.test.ts` (out-of-order generation); `workers/agents/src/wake-consumer.critical.test.ts` (redelivered and concurrent wake: one assignment, one run); `workers/coordinator/src/promotion-cas.critical.test.ts` (promotion retry); `workers/agents/src/conflicts.critical.test.ts` (one conflict from either detector) | `change-retry`, `change-double-submit`, `project-double-submit`, `candidate-double-submit`, `approval-double-submit`, `promotion-double-submit` | Live K2 redelivery needs a replay hook. See [duplicate Event](#duplicate-event). |
| P13-06 | Expired Claim (42.3) | `workers/coordinator/src/claims.critical.test.ts` (expired claim does not block and is reported overdue, renew after expiry rejected, alarm at the earliest lease); `packages/protocol/src/activity.critical.test.ts` (a lapsed lease shows as expired) | none | Claims are internal RPC only. See [expired Claim](#expired-claim). |
| P13-07 | Sandbox loss (30.1, 42.5) | `workers/integration/src/sandbox-loss.critical.test.ts` (a check after Sandbox loss restores the checkout from the Candidate fork at the composed commit; an intact checkout is reused; a missing commit fails, never checks the wrong tree; repo tokens are revoked) | none | See [Sandbox loss](#sandbox-loss). |
| P13-08 | K2 publication outage (18, 42.6) | `workers/coordinator/src/outbox-recovery.critical.test.ts` (Events kept during the outage and published once K2 recovers; attempt limit keeps the row visible as failed); `outbox.critical.test.ts` (capped backoff) | none | See [K2 outage](#k2-outage). |
| P13-09 | Model timeout (42.8) | `packages/model-router/src/route.critical.test.ts` (timeout retries once at the same tier, a second transport failure stops, never escalates); `decision.critical.test.ts` (Clef abstains on malformed output); `workers/integration/src/root-planner.critical.test.ts` (planner repairs once, then gives up) | none | See [model timeout](#model-timeout). |
| P13-10 | Poison command (20, 42.7) | `workers/agents/src/queue-poison.critical.test.ts` (a failing wake is retried, never acked; the rest of the batch is acked; invalid and stale wakes are acked); `scripts/inject/dead-letter.critical.test.ts` (every Terraform and local Queue consumer has a dead-letter Queue and 1 to 5 retries) | none | No dead-letter consumer yet. See [poison command](#poison-command). |
| P13-11 | Stale Candidate (36, 42.9) | `workers/coordinator/src/promotion-cas.critical.test.ts` (stale expected generation, changed tree, race loser marked stale); `packages/evidence/src/promotion.critical.test.ts` (base behind canonical reports stale) | `stale-candidate`, `promotion-double-submit`, `early-promotion`; also `bun run smoke:sandbox` | None. |
| P13-12 | Deployment failure (21.3, 42.10) | Promotion never deletes history: `promotion-cas.critical.test.ts` only advances generations | none | Release is parked (P11-07/08). See [deployment failure](#deployment-failure). |

## Hooks needed

### Budget stop

Free models cost $0, so `checkRunBudget` receives `spentUsd: 0` in `AgentDO.beforeModelCall` and
the cost cap cannot fire live. The live stop is the call cap: the per-run cap fails the Task, and
the daily cap (`AGENT_DAILY_CALL_CAP`, D1 `usage_counters` row `agent-model-calls`) ends the run
with `budget_exhausted`, which `failTask` turns into Change status `budget_blocked`.

Hook: a dev-only internal RPC on the agents Worker that sets today's `agent-model-calls` counter to
the cap for the inject run. Then a planned Change's first agent run must stop with
`budget_exhausted`, the Change must show `budget_blocked`, and the existing state must stay readable.
This costs at most one Root Planner call. The section 44 limits (`max_sandbox_seconds_per_change`,
`max_active_agents_per_change`, and the others) are not enforced per Change yet; only the monthly
Sandbox cap and `maxCandidates` are.

### Duplicate Event

Hook: a replay command for the event router that re-consumes one K2 offset range for one
subscription (for example a `k2.replay` integration command with stream, subscription, and offset
range). Expected: `claimEvents` reports every Event as a duplicate, the live view sequence does not
advance, and no second R2 archive object appears.

### Expired Claim

Claims are `ResourceShardDO` RPCs (`acquireClaim`, `renewClaim`, `releaseClaim`) with no public
route. Hook: a dev-only internal RPC that acquires a Claim for a test agent with `ttlMs: 5000` and
never renews it. Expected: after the lease, the shard alarm emits `claim.expired`, the activity feed
shows the Claim as expired, and a second agent can acquire the resource.

### Sandbox loss

Hook: a dev-only internal RPC on the agents Worker that calls `destroy()` on a Project's Sandbox
(`getSandbox(SANDBOX, "proj-<id>")`). Run it between Candidate composition and the first check,
then let `CandidateVerificationWorkflow` continue. Expected: the checks pass on a checkout restored
from the Candidate fork, and the Candidate verifies. Task workspaces need the same proof:
`openWorkspace` reuses an existing fork on a retried run, but no test covers that path yet.

### K2 outage

Hook: a dev-only runtime flag (for example KV key `inject:k2-down-until` in `rhumbatron-config-dev`)
that `OutboxPublisher` checks before each send and treats as a retryable K2 failure. KV values are
runtime data, not Terraform configuration. Expected: mutations still commit, unpublished outbox
rows grow, the dashboard lags, and every Event publishes once after the flag expires.

### Model timeout

Hook: a dev-only per-Change flag that makes the gateway client abort the next model call after
1 ms. Expected: one same-tier retry, then the Task stops with `repeated_transport_failure`; no
escalation to a stronger tier. Live injection spends free-tier model calls (50 per day).

### Poison command

Consumers retry a failure and Queues move it to `rhumbatron-dead-letter-dev` after 3 retries. But
nothing consumes the dead-letter Queue, so section 42.7 ("mark the related Task blocked, show an
operator action in the UI") is not implemented. Needed:

1. A dead-letter consumer that marks the Task `blocked` (or `failed` with reason `dead_lettered`)
   and emits `task.failed`.
2. A blocked state with an operator action in the Change page.
3. Hook: a dev-only internal RPC that sends one schema-valid command whose handler always throws
   (the public API cannot enqueue arbitrary commands, by design).

### Deployment failure

The ReleaseWorkflow (P11-07/08) is parked: Workers Builds needs a one-time dashboard connection to
the Artifacts repo (ADR 0014). Needed first: ReleaseWorkflow with a smoke step. Injection then is a
promoted fixture commit whose `bun run build` fails. Expected: the release is marked failed, the
Canonical Generation stays, and recovery is a new canonical transition, not a deleted one.
