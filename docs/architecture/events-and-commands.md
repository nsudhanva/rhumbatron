# Events and commands

Rhumbatron keeps facts and work apart.

- An Event is an immutable fact, for example `task.completed`. Events travel on K2.
- A Command is a request for work, for example `agent.wake`. Commands travel on Queues.

No authoritative state change writes to K2 directly.
A Durable Object writes the state change and the Event in one SQLite transaction (the outbox).
A publisher sends the outbox rows to K2 later.

## Envelopes

Both envelopes are Zod schemas in `packages/protocol/src`.

| Envelope | Key fields | Stable key | File |
|---|---|---|---|
| Event | `eventId`, `eventType`, `eventVersion`, `tenantId`, `projectId`, `changeId`, `taskId`, `actor`, `resource`, `canonicalGeneration`, `causedBy`, `correlationId`, `timestamp`, `payload` | `eventId` | `event.ts` |
| Command | `commandId`, `commandType`, `projectId`, `changeId`, `taskId`, `attempt`, `createdAt`, `deadline`, `payload` | `commandId` | `command.ts` |

`EVENT_TYPES` in `event.ts` is the closed list of Event types.

Most Change Events get a deterministic ID from `stableEventId` in `workers/integration/src/events.ts`.
The ID is `evt_` plus the first 16 bytes of SHA-256 over the Change ID, the Event type, the Task ID, and an optional key.
A retried Workflow step writes the same Event ID again, and the outbox ignores the repeat.
ProjectRootDO and ResourceShardDO use `crypto.randomUUID()` for Events that they create in their own transaction (for example `canonical.advanced` and `claim.acquired`).
The transaction runs once, so a retry keeps the same ID.

## Transactional outbox to K2

Two Durable Object classes own an outbox: ProjectRootDO and ResourceShardDO.
ProjectRootDO writes `project.created`, `artifact.promoted`, and `canonical.advanced`.
ResourceShardDO writes all other Events.
Change Events go to the shard that owns `change:<id>` (`appendChangeEvents` in `workers/integration/src/events.ts`).

```mermaid
flowchart LR
  W["State change in DO SQLite"] --> T{{"Same transaction"}}
  T --> OB[("outbox row<br/>event_id UNIQUE")]
  OB --> AL["DO alarm<br/>(AlarmGuard)"]
  AL --> PUB["OutboxPublisher.publishDue<br/>max 100 rows per project"]
  PUB --> H["streamIndex =<br/>fnv1a32(projectId) mod 8"]
  H --> P["Producer binding<br/>EVENTS_00 .. EVENTS_07"]
  P --> K2[("K2 stream<br/>rhumbatron_events_NN_prod")]
  PUB -->|"after a successful send"| N["EVENT_ROUTER.nudge(streamIndex)"]
  CRON["Cron every minute<br/>one stream per tick"] --> ER["rhumbatron-event-router"]
  N --> ER
  K2 --> ER
```

Rules in the code (`workers/coordinator/src/outbox.ts`, `infrastructure/terraform/envs/prod/main.tf`):

- There are 8 streams, `rhumbatron_events_00_prod` to `rhumbatron_events_07_prod`. K2 names allow only letters, digits, and underscores (ADR 0006).
- Retention is 7 days (`retention_seconds = 604800`).
- One Project always maps to one stream. Its Events stay in order on that stream.
- The nudge is best effort. The cron sweep catches what the nudge misses. The cron visits one stream per minute, so each stream gets a sweep every 8 minutes. The pause switch removes the cron.
- A Terraform precondition fails the plan if the account would have more than 20 K2 streams (ADR 0017).
- `AlarmGuard` (`alarm-guard.ts`) limits each Durable Object to 2,000 alarm fires per UTC day. An alarm with no due work is deleted.

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
If K2 is down, the state change is still correct. Only the dashboard lags.

## Event router: K2 pull consumer

The event router pulls from K2 over HTTP with `K2_CONSUMER_TOKEN`.
Every nudge and every cron tick runs two subscriptions on one stream: `project-view-projector`, then `causal-router`.
The cron tick also runs one `audit-archiver` batch.
A cron tick without maintenance or the release sweep also runs one `analytics-projector` batch.

```mermaid
flowchart TB
  START["nudge or cron tick for stream N"] --> SUBS["project-view-projector,<br/>then causal-router<br/>(max 2 consumes each)"]
  SUBS --> DEC["Decode envelopes"]
  DEC --> CLAIM["claimEvents: INSERT OR IGNORE<br/>processed_events (consumer, event_id)<br/>projector: + project_events feed rows"]
  CLAIM --> FRESH{"Subscription"}
  FRESH -->|"projector"| PV["ProjectViewDO.applyDelta<br/>max 15 calls per run"]
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

Notes (`workers/event-router/src/index.ts`):

- A nudge uses at most 37 subrequests. A cron tick uses at most 46. The Workers Free limit is 50.
- The router releases the claim rows before a nack. Otherwise a redelivery skips the events as duplicates.
- Events that the 15-call `applyDelta` cap defers lose their claim and come back with the next delivery. A deferral does not count as a failure.
- A dead-lettered K2 batch gets a `dead_letters` row with queue `k2-<consumer>`. An operator can only dismiss it (`poison-batch.ts`).
- The archive key is `events/<yyyy>/<mm>/<dd>/stream-<NN>/part-<firstMs>-<hash>.ndjson.gz`. The R2 lifecycle deletes `events/` objects after 365 days.
- Terraform creates four subscriptions: `causal-router`, `project-view-projector`, `audit-archiver`, and `analytics-projector`.
- `analytics-projector` (`analytics.ts`) maps lifecycle Events to metric names (`change_created`, `task_*`, `agent_wakeup`, `model_route`, `candidate_*`, `promotion_*`, `release_completed`, and others). It writes one data point per fresh Event, at most 100 per tick, to the `rhumbatron_event_metrics_prod` dataset (binding `EVENT_METRICS`). Other Workers write their own data points to `METRICS`.

### Cron housekeeping

The same every-minute cron runs two bounded sweeps (`workers/event-router/src/maintenance.ts`):

| Tick | Work |
|---|---|
| 04:17 UTC, once a day | Queues one `forks.sweep`. Queues `project.cleanup` and `index.purge` for up to 10 archived Projects. Queues an `index.build` backfill for up to 10 active Projects without a ready index. Deletes at most 5,000 `processed_events` rows older than 14 days. |
| Minute 4, 9, 14 ... of each hour | Queues one `release.recover` for each Change still `releasing` 45 minutes after promotion, at most 10 per sweep. See [Change lifecycle](change-lifecycle.md#part-3-from-candidates-to-a-release). |

## Causal routing

The causal router decides which Agents wake after each fresh Event (`workers/event-router/src/causal.ts`, `packages/causal-router`).
Deterministic rules run first. Clef-flash on Workers AI decides only a prefix resource overlap.

```mermaid
flowchart TB
  E["Fresh Event"] --> TR{"task.ready?"}
  TR -->|"yes"| SKIP["Ignore: the dispatcher already sent the wake"]
  TR -->|"no"| INF{"Informational type?"}
  INF -->|"yes"| NONE["No action"]
  INF -->|"no"| TYPE{"Event type"}
  TYPE -->|"task.completed"| READY["Newly ready Tasks:<br/>change.dispatch"]
  TYPE -->|"verification.started<br/>(work_graph_completed)"| COMP["candidate.create"]
  TYPE -->|"canonical.advanced"| CA["Wake active agents,<br/>mark older Candidates stale,<br/>candidates.recompose"]
  TYPE -->|"resource Event"| OV{"Resource overlap<br/>with an active agent"}
  OV -->|"exact"| WAKE["agent.wake"]
  OV -->|"prefix only"| CLEF{"Clef-flash<br/>(200 calls per day)"}
  CLEF -->|"wake, abstain, or cap reached"| WAKE
  CLEF -->|"skip"| NONE
  OV -->|"none"| NONE
  READY --> CAP{"1,000 commands per Change per day"}
  COMP --> CAP
  WAKE --> CAP
```

Notes:

- Resource Events are `intent.declared`, `intent.changed`, `challenge.created`, `changeset.proposed`, `claim.released`, and `claim.expired`.
- Clef-flash abstains below a probability of 0.7. An abstention wakes the Agent.
- The 1,000-command cap counts `change.dispatch`, `candidate.create`, and `agent.wake`. The router logs the dropped commands as errors.
- `artifact.promoted` and `canonical.advanced` both queue `index.build` for the indexer. The cap does not count `index.build` or `candidates.recompose`.
- After `canonical.advanced`, the router marks the promoted Candidate `promoted` and every other open Candidate on an older base `stale`. A Change in `awaiting_approval` with no verified Candidate returns to `verifying`. The `candidates.recompose` command then settles each stale Candidate. See [Change lifecycle](change-lifecycle.md#part-3-from-candidates-to-a-release).
- `task.completed` and `task.failed` free an Agent slot. When a ready Task waits at the 8-agent limit, the router dispatches the Change again.
- The wake consumer checks relevance again. A stale wake ends at once and counts as a false wakeup in Analytics Engine (`workers/agents/src/wake-consumer.ts`).

## Queues

All Queues are named `rhumbatron-<purpose>-prod`.
Terraform creates six Queues (`modules/async`) with 1 day of message retention.

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

  INT -->|"agent.wake"| WQ
  ER -->|"agent.wake"| WQ
  ER -->|"change.dispatch, candidate.create,<br/>candidates.recompose, forks.sweep,<br/>project.cleanup, release.recover"| IQ
  API -->|"project.provision, project.cleanup,<br/>app.provision, app.remove,<br/>fixture.publish"| IQ
  ER -->|"index.build, index.purge"| XQ
  INT -->|"verification.start,<br/>candidate.create after a rebase"| VQ
  INT -->|"release.start"| RQ
  WQ --> AG
  IQ --> INT
  VQ --> INT
  RQ --> INT
  XQ --> IDX
  WQ & IQ & VQ & RQ -.->|"after 3 retries"| DLQ
  DLQ --> ER
```

| Queue | Consumer | Batch | Retries | Retry delay | Dead-letter Queue |
|---|---|---|---|---|---|
| `agent-wakeups` | `rhumbatron-agents` | 10 | 3 | 30 s | `dead-letter` |
| `integration` | `rhumbatron-integration` | 10 | 3 | 30 s | `dead-letter` |
| `verification` | `rhumbatron-integration` | 5 | 3 | 30 s | `dead-letter` |
| `release` | `rhumbatron-integration` | 5 | 3 | 30 s | `dead-letter` |
| `indexing` | `rhumbatron-indexer` | 1, concurrency 1 | 3 | 30 s | none (the indexer records the failure in `project_indexes`) |
| `dead-letter` | `rhumbatron-event-router` | 5 | 5 | 60 s | none (dropped and logged) |

The integration Worker consumes the `integration`, `verification`, and `release` Queues with one handler.

Two commands start Workflows: `verification.start` (one per Candidate) and `release.start` (one per promoted generation with a live app).
Each command carries a stable `commandId` and the idempotency key (Candidate ID or release ID).
The consumer uses that key as the Workflow instance ID, so a redelivery finds the existing instance.
The producer starts the Workflow directly only if the send fails (`workers/integration/src/workflow-commands.ts`).

The integration consumer also limits its own work (`MAX_DELIVERIES = 4` in `workers/integration/src/index.ts`):

1. A bounded command with more work asks for another delivery after 10 s.
2. A `candidate.create` that waits for a conflict review asks for another delivery after 45 s. Its last delivery composes anyway.
3. A thrown error retries after 30 s.
4. On the 4th delivery the consumer acknowledges the message. It does not send it to the dead-letter Queue.

The daily 04:17 UTC tick queues `forks.sweep` and `project.cleanup` again.

### Dead-letter path

```mermaid
sequenceDiagram
  autonumber
  participant Q as Origin Queue
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
  ER->>D1: ready or assigned Task to blocked (blocked_limit dead_letter)
  ER->>Shard: task.failed (outbox)
  Op->>D1: Retry or Dismiss in the UI (API)
  D1-->>Q: Retry sends the command again with attempt + 1
```

Notes (`workers/event-router/src/dead-letter.ts`, `workers/api/src/dead-letters.ts`):

- A command without a Task, or with a Task that already runs, puts the reason on the Change instead. Only a blocked Task records `task.failed`.
- Retry sends `agent.wake` to `agent-wakeups` and every other command to `integration`.
- The dead-letter consumer never re-sends a command. Only an operator action re-sends it (ADR 0019).

## Idempotency and dedupe

Every retry boundary has a stable key, so a retry never creates a second logical result.

| Boundary | Key | Where the code enforces it |
|---|---|---|
| Event publish | `eventId` | `outbox.event_id UNIQUE`; shard `appendEvents` uses `INSERT OR IGNORE` |
| Event consume | `(consumer, event_id)` | D1 `processed_events`, `INSERT OR IGNORE`, kept 14 days |
| Wake command | `cmd_<task>_ready` (dispatch), `cmd_<event>_<task>` (router) | Wake consumer treats a ready wake for a Task that the same Agent holds as a duplicate; `admitAgent` assigns once |
| Dead-letter record | `command_id` | D1 `dead_letters`, `UNIQUE` |
| Change creation | `(project_id, client_request_id)` | D1 unique constraint and `ON CONFLICT DO NOTHING` |
| Workflow start | Instance ID = Change ID, Candidate ID, or release ID | Workflows reject a second instance with the same ID |
| Workflow start command | `cmd_<candidate>_verify`, `cmd_<release>_release` | `workflowStartFor` maps the command to that instance ID |
| Candidate composition | SHA-256 composition key | Candidate ID derives from the key |
| Promotion | Candidate ID + expected generation | `decidePromotion` returns `already_promoted` |
| Release | `rel_<project>_<generation>` | D1 `releases` primary key |
| K2 batch failure | `(consumer, batch_key)` | D1 `k2_batch_failures` |
| K2 archive object | Event IDs of the batch | Same key, so a redelivery overwrites the same R2 object |

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
