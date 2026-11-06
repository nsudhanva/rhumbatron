# Events and commands

Rhumbatron keeps facts and work apart.

- An Event is an immutable fact, for example `task.completed`. Events travel on the event log: eight NATS JetStream streams.
- A Command is a request for work, for example `agent.wake`. Commands travel on queues: one JetStream work-queue stream.

An authoritative state change reaches the event log only through an outbox.
An actor writes the state change and the Event in one SQLite transaction.
A publisher then sends the outbox rows to the event log.

Core creates the streams at start (`packages/platform/src/messaging/jetstream.ts`).
The `nats` service stores them on the `nats-data` volume.

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
ProjectRootDO and ResourceShardDO use `crypto.randomUUID()` for Events of their own transactions, for example `canonical.advanced` and `claim.acquired`.
The transaction runs one time, so a retry keeps the same ID.

## Transactional outbox to the event log

Two actor classes own an outbox: ProjectRootDO and ResourceShardDO.
ProjectRootDO writes `project.created`, `artifact.promoted`, and `canonical.advanced`.
ResourceShardDO writes all other Events.
Change Events go to the shard that owns `change:<id>` (`appendChangeEvents` in `workers/integration/src/events.ts`).

```mermaid
flowchart LR
  W["State change in actor SQLite"] --> T{{"Same transaction"}}
  T --> OB[("outbox row<br/>event_id UNIQUE")]
  OB --> AL["Actor alarm<br/>(AlarmGuard)"]
  AL --> PUB["OutboxPublisher.publishDue<br/>max 100 rows per project"]
  PUB --> H["streamIndex =<br/>fnv1a32(projectId) mod 8"]
  H --> P["Producer binding<br/>EVENTS_00 .. EVENTS_07"]
  P --> JS[("JetStream stream<br/>EVENTS_NN")]
  PUB -->|"after a successful send"| N["EVENT_ROUTER.nudge(streamIndex)"]
  SWEEP["Sweep every minute<br/>one stream per tick"] --> ER["Event router"]
  N --> ER
  JS --> ER
```

Rules in the code (`workers/coordinator/src/outbox.ts`, `packages/platform/src/messaging/jetstream.ts`):

- There are 8 streams, `EVENTS_00` to `EVENTS_07`, on the subjects `events.00` to `events.07`. Core creates them at start.
- Retention is 7 days (`max_age`, limits retention, file storage).
- JetStream drops a second publish with the same `event-id` header inside a 2-hour window.
- One Project always maps to one stream. Its Events stay in order on that stream.
- The nudge is an in-process call to the event router. The sweep reads the records that a nudge does not read.
- The sweep visits one stream per minute, so each stream gets a sweep every 8 minutes.
- `AlarmGuard` (`alarm-guard.ts`) limits each actor to 2,000 alarm fires per UTC day. The guard deletes an alarm that has no due work.

### Outbox row states

```mermaid
stateDiagram-v2
  [*] --> pending: inserted with the state change
  pending --> published: stream publish succeeded
  pending --> retry_wait: send failed
  retry_wait --> pending: backoff 1 s, 2 s, 4 s ... max 5 min
  retry_wait --> failed: 10th failed attempt
  pending --> failed: no producer binding for the stream
  published --> [*]
  failed --> [*]
```

A failed row stays in the table with `last_error`, so an operator can see it.
When NATS is down, the state change stays correct. The outbox keeps the rows, and the dashboard lags.

## Event router: the event log consumer

The event router runs in core. It reads the streams through the `EVENT_LOG` binding.
`workers/event-router/src/event-log.ts` defines the consumer client type and the subscription names.
`EventLogClient` in `packages/platform/src/messaging/jetstream.ts` implements it.

- Each subscription is a durable JetStream pull consumer with explicit ack.
- One consume fetches at most 100 records.
- A nack redelivers the batch after 30 s.
- An unacknowledged batch comes back after 5 minutes.

Core calls the `scheduled` handler of the router at the start of each minute (`scheduleSweep` in `services/core/src/main.ts`).
Every nudge and every sweep tick runs two subscriptions on one stream: `project-view-projector`, then `causal-router`.
The sweep tick also runs one `audit-archiver` batch.
A sweep tick without maintenance or the release sweep also runs one `analytics-projector` batch.

```mermaid
flowchart TB
  START["nudge or sweep tick for stream N"] --> SUBS["project-view-projector,<br/>then causal-router<br/>(max 2 consumes each)"]
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
  START --> ARC["Sweep only: audit-archiver<br/>gzip NDJSON to the bucket, events/"]
  START --> AN["Sweep only: analytics-projector<br/>1 batch, dedupe, EVENT_METRICS"]
```

Notes (`workers/event-router/src/index.ts`):

- The router releases the claim rows before a nack, so a redelivery applies the events.
- The 15-call `applyDelta` cap can defer events. A deferred event loses its claim and comes back with the next delivery. A deferral is not a failure.
- A skipped event batch gets a `dead_letters` row. An operator can only dismiss it (`poison-batch.ts`).
- A dead letter closes with the resolution `succeeded` when the same command succeeds later.
- A dead letter closes with the resolution `superseded` when a later `change.settle` of the same Change runs.
- The 5-minute sweep closes the dead letters of `completed`, `failed`, `cancelled`, `not_selected`, and `declined` Changes.
- The archive key is `events/<yyyy>/<mm>/<dd>/stream-<NN>/part-<firstMs>-<hash>.ndjson.gz` in the `rhumbatron-evidence` bucket.
- Core deletes archive objects 365 days after their upload (the object expiry in `services/core/src/expiry.ts`).
- Each stream has four subscriptions: `causal-router`, `project-view-projector`, `audit-archiver`, and `analytics-projector`. The client creates each durable consumer at its first read.
- `analytics-projector` (`analytics.ts`) maps lifecycle Events to metric names, for example `change_created`, `task_*`, `agent_wakeup`, `model_route`, `candidate_*`, `promotion_*`, and `release_completed`.
- It writes one data point per fresh Event to `EVENT_METRICS`, at most 100 per tick.
- Other modules write their own data points to `METRICS`. Both bindings write rows to the `platform_metrics` table.

### Sweep housekeeping

The every-minute sweep also runs two bounded housekeeping jobs (`workers/event-router/src/maintenance.ts`):

| Tick | Work |
|---|---|
| 04:17 UTC, once a day | Queues one `forks.sweep`. Queues `project.cleanup` and `index.purge` for up to 10 archived Projects. Queues an `index.build` backfill for up to 10 active Projects without a ready index. Deletes at most 5,000 `processed_events` rows after 14 days. |
| Minute 4, 9, 14 ... of each hour | Queues one `release.recover` for each Change still `releasing` 45 minutes after promotion, at most 10 per sweep. Queues one `change.settle` for each open Change that is quiet for 3 minutes to 6 hours and cannot move on its own, at most 10 per sweep. Closes the dead letters of ended Changes. Queues one `index.purge` for each deleted Project that still has index rows, at most 10 per sweep. See [Change lifecycle](change-lifecycle.md#part-3-from-candidates-to-a-release). |

## Causal routing

The causal router decides which Agents wake after each fresh Event (`workers/event-router/src/causal.ts`, `packages/causal-router`).
Deterministic rules run first. Clef-flash decides only a prefix resource overlap.
A Clef-flash question is one Claude Haiku call with a forced tool call (`packages/platform/src/ai/models.ts`).

```mermaid
flowchart TB
  E["Fresh Event"] --> TR{"task.ready?"}
  TR -->|"yes"| SKIP["Ignore: the dispatcher already sent the wake"]
  TR -->|"no"| INF{"Informational type?"}
  INF -->|"yes"| NONE["No action"]
  INF -->|"no"| TYPE{"Event type"}
  TYPE -->|"task.completed"| READY["Newly ready Tasks:<br/>change.dispatch"]
  TYPE -->|"verification.started<br/>(work_graph_completed)"| COMP["candidate.create"]
  TYPE -->|"task.failed"| SETTLE["change.settle"]
  TYPE -->|"canonical.advanced"| CA["Wake active agents,<br/>mark Candidates on an earlier base stale,<br/>candidates.recompose"]
  TYPE -->|"resource Event"| OV{"Resource overlap<br/>with an active agent"}
  OV -->|"exact"| WAKE["agent.wake"]
  OV -->|"prefix only"| CLEF{"Clef-flash<br/>(200 calls per day)"}
  CLEF -->|"wake, abstain, or cap reached"| WAKE
  CLEF -->|"skip"| NONE
  OV -->|"none"| NONE
  READY --> CAP{"1,000 commands per Change per day"}
  COMP --> CAP
  SETTLE --> CAP
  WAKE --> CAP
```

Notes:

- Resource Events are `intent.declared`, `intent.changed`, `challenge.created`, `changeset.proposed`, `claim.released`, and `claim.expired`.
- Clef-flash abstains below a probability of 0.7. An abstention wakes the Agent.
- The 1,000-command cap counts `change.dispatch`, `candidate.create`, `change.settle`, and `agent.wake`. The router logs the dropped commands as errors.
- `artifact.promoted` and `canonical.advanced` both queue `index.build` for the indexer. The cap does not count `index.build` or `candidates.recompose`.
- After `canonical.advanced`, the router marks the promoted Candidate `promoted`.
- It marks every other open Candidate on an earlier base `stale`.
- A Change in `awaiting_approval` with no verified Candidate goes back to `verifying`.
- The `candidates.recompose` command then settles each stale Candidate. See [Change lifecycle](change-lifecycle.md#part-3-from-candidates-to-a-release).
- `task.completed` and `task.failed` free an Agent slot. When a ready Task waits at the 8-agent limit, the router dispatches the Change again.
- The wake consumer checks relevance again. A stale wake ends at once and counts as a false wakeup in `METRICS` (`workers/agents/src/wake-consumer.ts`).

## Queues

Each queue is one subject, `cmd.<queue>`, on the JetStream work-queue stream `COMMANDS`.
Core runs one durable consumer, `q-<queue>`, per queue (`runQueueConsumer` in `packages/platform/src/messaging/jetstream.ts`).
One table, `QUEUE_CONSUMERS` in `services/core/src/consumers.ts`, sets the batch size, retries, dead-letter queue, and concurrency of each consumer.
`scripts/inject/dead-letter.critical.test.ts` tests that table.

- Delivery is at least once, with explicit ack.
- A send with a `commandId` carries the message ID `<queue>:<commandId>`. JetStream drops a repeat inside a 2-hour window.
- A message stays in the stream for at most 14 days.
- A handler that throws, or that calls `retry`, gets a redelivery after the delay that the handler sets.
- After the last retry, the consumer sends the message to `dead-letter` and terminates it.
- A handler can hold a batch for up to 15 minutes. The consumer extends the ack deadline every 30 s while the handler runs.

```mermaid
flowchart LR
  API["api"]
  ER["event router"]
  INT["integration"]
  WQ[["agent-wakeups"]]
  IQ[["integration"]]
  XQ[["indexing"]]
  VQ[["verification"]]
  RQ[["release"]]
  DLQ[["dead-letter"]]
  AG["agents"]
  IDX["indexer"]

  INT -->|"agent.wake"| WQ
  ER -->|"agent.wake"| WQ
  ER -->|"change.dispatch, candidate.create,<br/>change.settle, candidates.recompose,<br/>forks.sweep, project.cleanup,<br/>release.recover"| IQ
  API -->|"project.provision, project.cleanup,<br/>app.provision, app.remove"| IQ
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

| Queue | Consumer | Batch | Concurrency | Retries | Retry delay | Dead-letter queue |
|---|---|---|---|---|---|---|
| `agent-wakeups` | agents | 10 | 2 | 3 | 30 s | `dead-letter` |
| `integration` | integration | 10 | 2 | 3 | 30 s | `dead-letter` |
| `verification` | integration | 5 | 2 | 3 | 30 s | `dead-letter` |
| `release` | integration | 5 | 2 | 3 | 30 s | `dead-letter` |
| `indexing` | indexer | 1 | 1 | 3 | 30 s | none (the indexer records the failure in `project_indexes`) |
| `dead-letter` | event router | 5 | 1 | 5 | 60 s | none (the consumer logs the message and terminates it) |

The integration module consumes the `integration`, `verification`, and `release` queues with one handler.

Two commands start Workflows: `verification.start` (one per Candidate) and `release.start` (one per promoted generation with a live app).
Each command carries a stable `commandId` and the idempotency key (Candidate ID or release ID).
The consumer uses that key as the Workflow instance ID, so a redelivery finds the existing instance.
The producer starts the Workflow directly only when the send fails (`workers/integration/src/workflow-commands.ts`).

The integration consumer also limits its own work (`MAX_DELIVERIES = 4` in `workers/integration/src/index.ts`):

1. A bounded command with more work asks for another delivery after 10 s.
2. A `candidate.create` that waits for a conflict review asks for another delivery after 45 s. Its last delivery composes anyway.
3. A thrown error retries after 30 s. After 3 retries, the message goes to the dead-letter queue.
4. A bounded or waiting command gets at most 4 deliveries. On the 4th delivery, the consumer acknowledges it.

The daily 04:17 UTC tick queues `forks.sweep` and `project.cleanup` again.

### Dead-letter path

```mermaid
sequenceDiagram
  autonumber
  participant Q as Origin queue
  participant C as Consumer module
  participant DLQ as dead-letter queue
  participant ER as Event router
  participant DB as Product database
  participant Shard as ResourceShardDO
  actor Op as Operator

  Q->>C: deliver command
  C-->>Q: throw, retry in 30 s (3 times)
  Q->>DLQ: move poison command
  DLQ->>ER: deliver
  ER->>DB: dead_letters row (idempotent on command_id)
  ER->>DB: ready or assigned Task to blocked (blocked_limit dead_letter)
  ER->>Shard: task.failed (outbox)
  Op->>DB: Retry or Dismiss in the UI (API)
  DB-->>Q: Retry sends the command again with attempt + 1
```

Notes (`workers/event-router/src/dead-letter.ts`, `workers/api/src/dead-letters.ts`):

- A command without a Task, or with a Task that runs, puts the reason on the Change. Only a blocked Task records `task.failed`.
- Retry sends `agent.wake` to `agent-wakeups` and every other command to `integration`.
- The dead-letter consumer never sends a command again. Only an operator action sends it again.

## Idempotency and dedupe

Every retry boundary has a stable key, so a retry never creates a second logical result.

| Boundary | Key | Where the code enforces it |
|---|---|---|
| Event publish | `eventId` | `outbox.event_id UNIQUE`; shard `appendEvents` uses `INSERT OR IGNORE` |
| Event consume | `(consumer, event_id)` | `processed_events`, `INSERT OR IGNORE`, kept 14 days |
| Wake command | `cmd_<task>_ready` (dispatch), `cmd_<event>_<task>` (router) | Wake consumer treats a ready wake for a Task that the same Agent holds as a duplicate; `admitAgent` assigns once |
| Dead-letter record | `command_id` | `dead_letters`, `UNIQUE` |
| Change creation | `(project_id, client_request_id)` | Unique constraint and `ON CONFLICT DO NOTHING` |
| Workflow start | Instance ID = Change ID, Candidate ID, or release ID | The workflow engine rejects a second instance with the same ID |
| Workflow start command | `cmd_<candidate>_verify`, `cmd_<release>_release` | `workflowStartFor` maps the command to that instance ID |
| Candidate composition | SHA-256 composition key | Candidate ID derives from the key |
| Promotion | Candidate ID + expected generation | `decidePromotion` returns `already_promoted` |
| Release | `rel_<project>_<generation>` | `releases` primary key |
| Event batch failure | `(consumer, batch_key)` | `k2_batch_failures` |
| Event archive object | Event IDs of the batch | Same key, so a redelivery overwrites the same object |
| Command publish | `<queue>:<commandId>` | JetStream message ID, 2-hour duplicate window |
| Event stream publish | `event-id` header | JetStream message ID, 2-hour duplicate window |

This sequence shows a duplicate event delivery.
The second delivery finds the claim row and applies nothing.

```mermaid
sequenceDiagram
  autonumber
  participant JS as JetStream stream
  participant ER as Event router
  participant DB as processed_events
  participant PV as ProjectViewDO

  JS->>ER: batch with event E
  ER->>DB: INSERT OR IGNORE (projector, E)
  DB-->>ER: 1 row changed: E is fresh
  ER->>PV: applyDelta(E)
  ER->>JS: ack
  JS->>ER: same batch again (at least once)
  ER->>DB: INSERT OR IGNORE (projector, E)
  DB-->>ER: 0 rows changed: duplicate
  ER->>JS: ack, no side effect
```
