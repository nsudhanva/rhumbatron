# Events and commands

Rhumbatron keeps facts and work apart.

- An **Event** is an immutable fact, for example `task.completed`. Events travel on K2.
- A **Command** is a request for work, for example `agent.wake`. Commands travel on Queues.

No authoritative state change writes to K2 directly.
A Durable Object writes the state change and the Event in one SQLite transaction (the outbox).
A publisher sends the outbox rows to K2 later.

## Envelopes

Both envelopes are Zod schemas in `packages/protocol/src`.

| Envelope | Key fields | Stable key | File |
|---|---|---|---|
| Event | `eventId`, `eventType`, `eventVersion`, `tenantId`, `projectId`, `changeId`, `taskId`, `actor`, `resource`, `canonicalGeneration`, `causedBy`, `correlationId`, `timestamp`, `payload` | `eventId` | `event.ts` |
| Command | `commandId`, `commandType`, `projectId`, `changeId`, `taskId`, `attempt`, `createdAt`, `deadline`, `payload` | `commandId` | `command.ts` |

Most Change Events get a deterministic ID from `stableEventId` in `workers/integration/src/events.ts`.
The ID is `evt_` plus 16 bytes of SHA-256 over the Change ID, the Event type, the Task ID, and an optional key.
A retried Workflow step therefore writes the same Event again, and the outbox ignores it.
ProjectRootDO uses `crypto.randomUUID()` inside its own transaction.
This is safe because the transaction runs once.

## Transactional outbox to K2

Two Durable Object classes own an outbox: ProjectRootDO and ResourceShardDO.
ProjectRootDO writes project-wide facts (`project.created`, `artifact.promoted`, `canonical.advanced`).
ResourceShardDO writes everything else, because Change events go to the shard that owns `change:<id>`.

```mermaid
flowchart LR
  W["State change in DO SQLite"] --> T{{"Same transaction"}}
  T --> OB[("outbox row<br/>event_id UNIQUE")]
  OB --> AL["DO alarm<br/>(AlarmGuard)"]
  AL --> PUB["OutboxPublisher.publishDue<br/>max 100 rows per project"]
  PUB --> H["streamIndex =<br/>fnv1a32(projectId) mod 8"]
  H --> P["Producer binding<br/>EVENTS_00 .. EVENTS_07"]
  P --> K2[("K2 stream<br/>rhumbatron_events_NN_env")]
  PUB -->|"after a successful send"| N["EVENT_ROUTER.nudge(streamIndex)"]
  CRON["Cron every minute<br/>one stream per tick"] --> ER["rhumbatron-event-router"]
  N --> ER
  K2 --> ER
```

Rules in the code:

- There are 8 streams, named `rhumbatron_events_00_prod` through `rhumbatron_events_07_prod`. `AGENTS.md` uses hyphens. K2 names allow only letters, digits, and underscores (ADR 0006).
- Retention is 7 days (`retention_seconds = 604800`).
- One project always maps to one stream, so its Events stay in order on that stream.
- The nudge is best effort. The cron sweep is the backstop. The cron visits one stream per minute, so each stream gets a sweep every 8 minutes.
- A Terraform precondition fails the plan if the account would have more than 20 K2 streams.

### Outbox row states

```mermaid
stateDiagram-v2
  [*] --> pending: inserted with the state change
  pending --> published: K2 send succeeded
  pending --> retry_wait: send failed
  retry_wait --> pending: backoff 1 s, 2 s, 4 s ... max 5 min
  retry_wait --> failed: 10th failed attempt
  pending --> failed: no producer binding for the stream
  published --> [*]
  failed --> [*]
```

A failed row stays in the table with `last_error`, so an operator can see it.
If K2 is down, the state change is still correct. Only the dashboard lags (section 42.6).

## Event router: K2 pull consumer

The event router pulls from K2 over HTTP with `K2_CONSUMER_TOKEN`.
It runs two subscriptions per stream on every nudge and every cron tick.
The cron tick also runs the `audit-archiver` subscription.
On a tick without maintenance or the release sweep, it also runs one `analytics-projector` batch.

```mermaid
flowchart TB
  START["nudge or cron tick for stream N"] --> SUBS["project-view-projector,<br/>then causal-router<br/>(max 2 consumes each)"]
  SUBS --> DEC["Decode envelopes"]
  DEC --> CLAIM["claimEvents: INSERT OR IGNORE<br/>processed_events (consumer, event_id)"]
  CLAIM --> FRESH{"Fresh events?"}
  FRESH -->|"projector"| PV["ProjectViewDO.applyDelta<br/>max 15 calls per run<br/>+ project_events feed rows"]
  FRESH -->|"causal-router"| CR["routeCausalBatch"]
  PV --> OK{"All applied?"}
  CR --> OK
  OK -->|"yes"| ACK["ack batch"]
  OK -->|"no"| REL["Release claims of unapplied events"]
  REL --> CNT["Count failure in k2_batch_failures"]
  CNT -->|"below 5"| NACK["nack: redeliver later"]
  CNT -->|"5th failure"| DL["dead_letters row, mark events processed, ack"]
  START --> ARC["Cron only: audit-archiver<br/>gzip NDJSON to R2 events/"]
  START --> AN["Cron only: analytics-projector<br/>1 batch, dedupe, Analytics Engine"]
```

Notes:

- The subrequest budget is at most 37 per invocation, below the Workers Free limit of 50.
- The router releases the claim rows before a nack. Without that step, a redelivery would skip the events as duplicates.
- The archive key is `events/<day>/stream-<NN>/part-<firstMs>-<hash>.ndjson.gz`. The R2 lifecycle expires `events/` after 365 days.
- Terraform creates four subscriptions: `causal-router`, `project-view-projector`, `audit-archiver`, and `analytics-projector`.
- `analytics-projector` (`workers/event-router/src/analytics.ts`) maps lifecycle Events to section 41.1 metric names (`change_created`, `task_*`, `agent_wakeup`, `model_route`, `candidate_*`, `promotion_*`, `release_completed`, and others). It writes one data point for each Event to the `rhumbatron_event_metrics_<env>` dataset (binding `EVENT_METRICS`). This separate dataset keeps these points apart from the source points in `METRICS`. Dedupe uses `processed_events` like the other consumers. It skips maintenance and release-sweep ticks, so a tick stays at 46 subrequests or fewer. The expected volume is about 1,000 points on a busy day, and the free limit is 100,000.

## Causal routing

The causal router decides which Agents wake after each fresh Event.
Deterministic rules come first. Clef-flash on Workers AI decides only an ambiguous resource overlap.

```mermaid
flowchart TB
  E["Fresh Event"] --> TR{"task.ready?"}
  TR -->|"yes"| SKIP["Ignore: the dispatcher already sent the wake"]
  TR -->|"no"| INF{"Informational type?"}
  INF -->|"yes"| NONE["No action"]
  INF -->|"no"| TYPE{"Event type"}
  TYPE -->|"task.completed"| READY["Newly ready Tasks:<br/>change.dispatch"]
  TYPE -->|"verification.started<br/>(work_graph_completed)"| COMP["candidate.create"]
  TYPE -->|"canonical.advanced"| CA["Wake active agents,<br/>mark old Candidates stale,<br/>index.build"]
  TYPE -->|"intent, challenge,<br/>changeset, claim events"| OV{"Resource overlap<br/>with an active agent"}
  OV -->|"exact"| WAKE["agent.wake"]
  OV -->|"prefix only"| CLEF{"Clef-flash<br/>(200 calls per day)"}
  CLEF -->|"wake, abstain, or cap reached"| WAKE
  CLEF -->|"skip"| NONE
  OV -->|"none"| NONE
  READY --> CAP{"1,000 commands per Change per day"}
  COMP --> CAP
  CA --> CAP
  WAKE --> CAP
```

Notes:

- Clef-flash abstains below a probability of 0.7. An abstention wakes the Agent, which is the safe default.
- `artifact.promoted` and `canonical.advanced` both queue `index.build` for the indexer.
- When a Task completes or fails, it frees an Agent slot. If a ready Task waits at the 8-agent limit, the router dispatches the Change again.
- The wake consumer checks relevance again. A stale wake ends at once and counts as a false wakeup in Analytics Engine.

## Queues

All Queues are named `rhumbatron-<purpose>-<env>`.
Terraform creates six Queues (`modules/async`) with 1 day of message retention.
All six carry traffic.

```mermaid
flowchart LR
  API["rhumbatron-api"]
  ER["rhumbatron-event-router"]
  INT["rhumbatron-integration"]
  WQ[["agent-wakeups"]]
  IQ[["integration"]]
  XQ[["indexing"]]
  VQ[["verification"]]
  RQ[["release"]]
  DLQ[["dead-letter"]]
  AG["rhumbatron-agents"]
  IDX["rhumbatron-indexer"]
  ERC["event-router<br/>dead-letter consumer"]

  INT -->|"agent.wake"| WQ
  ER -->|"agent.wake"| WQ
  API -->|"dead-letter retry"| WQ
  ER -->|"change.dispatch, candidate.create,<br/>forks.sweep, project.cleanup"| IQ
  API -->|"project.provision, project.cleanup,<br/>fixture.publish, dead-letter retry"| IQ
  ER -->|"index.build, index.purge"| XQ
  INT -->|"verification.start, release.start"| VQ
  INT --> RQ
  VQ --> INT
  RQ --> INT
  WQ --> AG
  IQ --> INT
  XQ --> IDX
  WQ -.->|"after 3 retries"| DLQ
  IQ -.->|"after 3 retries"| DLQ
  DLQ --> ERC
```

| Queue | Consumer | Batch | Retries | Retry delay | Dead-letter Queue |
|---|---|---|---|---|---|
| `agent-wakeups` | `rhumbatron-agents` | 10 | 3 | 30 s | `dead-letter` |
| `integration` | `rhumbatron-integration` | 10 | 3 | 30 s | `dead-letter` |
| `indexing` | `rhumbatron-indexer` | 1, concurrency 1 | 3 | 30 s | none (failure recorded in `project_indexes`) |
| `dead-letter` | `rhumbatron-event-router` | 5 | 5 | 60 s | none (dropped and logged) |
| `verification` | `rhumbatron-integration` | 5 | 3 | 30 s | `dead-letter` |
| `release` | `rhumbatron-integration` | 5 | 3 | 30 s | `dead-letter` |

Two commands start Workflows: `verification.start` (one per Candidate) and `release.start` (one per promoted generation with a live app).
Each command carries a stable `commandId` and the idempotency key (Candidate ID or release ID).
The consumer starts the existing Workflow with that key as the instance ID, so a redelivery finds the running instance.
The producer starts the Workflow directly only if the send fails (`workers/integration/src/workflow-commands.ts`).

The integration consumer also limits its own work.
A command that has more work asks for another delivery, at most 4 deliveries in total.
On the last delivery it acknowledges the message instead of sending it to the dead-letter Queue.
The daily maintenance tick at 04:17 UTC queues the bounded work again.

### Dead-letter path

```mermaid
sequenceDiagram
  autonumber
  participant Q as agent-wakeups or integration
  participant C as Consumer Worker
  participant DLQ as dead-letter Queue
  participant ER as Event router
  participant D1 as D1
  participant Shard as ResourceShardDO
  actor Op as Operator

  Q->>C: deliver command
  C-->>Q: throw, retry in 30 s (3 times)
  Q->>DLQ: move poison command
  DLQ->>ER: deliver
  ER->>D1: dead_letters row (idempotent on command_id)
  ER->>D1: Task blocked, blocked_limit dead_letter
  ER->>Shard: task.failed (outbox)
  Op->>D1: Retry or Dismiss in the UI (API)
  D1-->>Q: Retry sends the command back to its origin Queue
```

The dead-letter consumer never re-sends a command by itself.
Only an operator action re-sends it (ADR 0019).

## Idempotency and dedupe

Every retry boundary has a stable key, so a retry never creates a second logical result.

| Boundary | Key | Where the code enforces it |
|---|---|---|
| Event publish | `eventId` | `outbox.event_id UNIQUE`; shard `appendEvents` ignores a repeat |
| Event consume | `(consumer, event_id)` | D1 `processed_events`, `INSERT OR IGNORE` |
| Wake command | `cmd_<task>_ready` | Wake consumer treats a Task that the same Agent already holds as a duplicate |
| Dead-letter record | `command_id` | D1 `dead_letters` |
| Change creation | `(project_id, client_request_id)` | D1 unique constraint and `ON CONFLICT DO NOTHING` |
| Workflow start | Instance ID = Change ID, Candidate ID, or release ID | Workflows reject a second instance with the same ID |
| Workflow start command | `cmd_<candidate>_verify`, `cmd_<release>_release` | `workflowStartFor` maps the command to that instance ID |
| Candidate composition | SHA-256 composition key | Candidate ID derives from the key |
| Promotion | Candidate ID + expected generation | `decidePromotion` returns `already_promoted` |
| Release | `rel_<project>_<generation>` | D1 `releases` primary key |
| K2 batch failure | `(consumer, batch_key)` | D1 `k2_batch_failures` |

This sequence shows a duplicate K2 delivery.
The second delivery finds the claim row and applies nothing.

```mermaid
sequenceDiagram
  autonumber
  participant K2 as K2 stream
  participant ER as Event router
  participant D1 as D1 processed_events
  participant PV as ProjectViewDO

  K2->>ER: batch with event E
  ER->>D1: INSERT OR IGNORE (projector, E)
  D1-->>ER: 1 row changed: E is fresh
  ER->>PV: applyDelta(E)
  ER->>K2: ack
  K2->>ER: same batch again (at least once)
  ER->>D1: INSERT OR IGNORE (projector, E)
  D1-->>ER: 0 rows changed: duplicate
  ER->>K2: ack, no side effect
```
