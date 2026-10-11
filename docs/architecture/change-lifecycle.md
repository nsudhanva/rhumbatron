# Change lifecycle

This page follows one user goal from the browser to a release.
It splits the path into three sequence diagrams, then shows the status state machines.

The path uses these stable IDs (section 60 of `AGENTS.md`):

| Object | ID rule | Source |
|---|---|---|
| Change | `chg_<uuid>`, idempotent on `clientRequestId` | `workers/api/src/projects.ts` |
| ChangeWorkflow instance | The Change ID | `workers/api/src/projects.ts` |
| Task | `tsk_<change>_<key>`, for example `tsk_..._t3` | `workers/integration/src/change-workflow.ts` |
| Agent | `agt_<task>`: one logical Agent per Task | `workers/integration/src/dispatch.ts` |
| Task run | `run_<task>_<attempt>` | `workers/agents/src/agent-do.ts` |
| ChangeSet | `cs_<run>` | `workers/agents/src/agent-do.ts` |
| Candidate | `cand_` plus 24 hex characters of the SHA-256 composition key | `workers/integration/src/candidate-create.ts` |
| Release | `rel_<project>_<generation>` | `migrations/d1/0015_releases.sql` |

## Part 1: from goal to ready Tasks

The API stores the Change and starts one ChangeWorkflow.
The ChangeWorkflow calls the Root Planner, stores the Work Graph, and dispatches the ready Tasks.
The API returns before any model call (section 58).

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant Web as rhumbatron-web
  participant API as rhumbatron-api
  participant Root as ProjectRootDO
  participant D1 as D1
  participant CW as ChangeWorkflow
  participant GW as AI Gateway
  participant Shard as ResourceShardDO
  participant WQ as agent-wakeups Queue

  User->>Web: Submit goal
  Web->>API: POST /v1/projects/:id/changes (service binding)
  API->>Root: getCanonical()
  API->>D1: INSERT changes (status created)
  API->>CW: CHANGE_WORKFLOW.create(id = changeId)
  API-->>User: 201 Change
  CW->>D1: status compiling
  CW->>GW: Root Planner call, tool submit_work_graph
  GW-->>CW: WorkGraphPlan (Zod and cycle check)
  CW->>D1: tasks, task_dependencies, status running (one batch)
  CW->>Shard: change.compiled, task.created (outbox)
  CW->>D1: pending to ready when dependencies are complete
  CW->>Shard: task.ready (outbox)
  CW->>WQ: one agent.wake per ready Task
```

Notes:

- The routing rules send the Root Planner to the `opus` tier (`taskKind = plan`, `complexity = large`). The prompt asks for 2 to 8 Tasks. The schema accepts 1 to 12 (`MAX_TASKS_PER_CHANGE`).
- The Work Graph JSON goes to R2 at `work-graphs/<project>/<change>.json`.
- Change events go to the ResourceShardDO that owns `change:<id>`. This keeps ProjectRootDO cold (section 13.1).
- The API updates ProjectViewDO directly with the new Change. Only an owner override emits `change.created`.

## Part 2: from a wake to a published ChangeSet

Each wake becomes one AgentDO run.
The Agent works in its own Artifacts fork and Sandbox directory.
When the run ends, the Agent publishes a ChangeSet and declares a typed Intent.
The ResourceShardDO then detects conflicts.

```mermaid
sequenceDiagram
  autonumber
  participant WQ as agent-wakeups Queue
  participant AC as Wake consumer
  participant D1 as D1
  participant A as AgentDO (Pi)
  participant GW as AI Gateway
  participant Art as Artifacts
  participant SBX as Sandbox
  participant Shard as ResourceShardDO
  participant ER as Event router

  WQ->>AC: agent.wake (task_ready)
  AC->>D1: admitAgent: ready to assigned (max 8 per Change)
  AC->>Shard: task.assigned, agent.woken
  AC->>A: start(input)
  A->>D1: route tier, choose provider, Decision Receipt, status running
  A->>Shard: model.route.decided, task.started, advisory Claims
  loop Pi tool loop (max 16 or 32 calls)
    A->>GW: model call
    A->>Art: fork canonical as ws-run (first write only)
    A->>SBX: read_file, write_file, run_command in /workspace/run
  end
  A->>SBX: git commit and push to ws-run
  A->>D1: changesets (proposed), task completed
  A->>Shard: changeset.proposed, intent.declared, task.completed
  Shard-->>ER: K2 records from the outbox
  ER->>D1: dedupe, find newly ready Tasks
  ER-->>WQ: change.dispatch to integration, then new wakes
```

Notes:

- Only Task kinds `implement`, `migrate`, and `test` get a workspace. Other kinds get read-only file tools.
- A Task with dependencies starts on a stacked workspace: canonical plus the dependency ChangeSets. See [Agents and models](agents-and-models.md#stacked-workspaces).
- Conflict detection is deterministic. A model review (Sonnet tier, then Opus tier) runs later from a durable schedule, never on the run path.
- When the last Task completes, AgentDO moves the Change to `verifying` and records `verification.started` with reason `work_graph_completed`.

## Part 3: from Candidates to a release

The causal router turns `verification.started` into one `candidate.create` command.
The integration Worker applies the fork rule and starts one CandidateVerificationWorkflow per Candidate.
A human approves and promotes. ProjectRootDO runs the compare-and-swap.

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant ER as Event router
  participant INT as Integration Worker
  participant VW as CandidateVerificationWorkflow
  participant SBX as Sandbox
  participant D1 as D1 and R2
  participant Root as ProjectRootDO
  participant Art as Artifacts
  participant RW as ReleaseWorkflow

  ER->>INT: candidate.create (integration Queue)
  INT->>D1: fork rule, INSERT candidates (composing, max 3)
  INT->>VW: create(id = candidateId)
  VW->>Art: fork canonical as cand-id
  VW->>SBX: merge ChangeSets in Work Graph order
  VW->>D1: plan_json, status verifying, candidate.composed
  loop each check in the Verification Plan
    VW->>SBX: run check command
    VW->>D1: Evidence row in D1, output in R2
  end
  VW->>D1: gate: verified or rejected, approval.requested
  User->>INT: approve (API RPC decideApproval)
  User->>INT: promote (API RPC promoteCandidate)
  INT->>Root: promote(): compare-and-swap
  Root->>Root: generation + 1 and canonical.advanced in one transaction
  INT->>Art: fast-forward canonical main to the composed commit
  INT->>RW: startRelease (Projects with a release target only)
  RW->>RW: move the live app pointer, or poll Workers Builds, then smoke check
```

Notes:

- Promotion is a human action in the UI, except under policy `autoPromoteRiskTiers`. Auto-promotion applies when the verified Candidate needs no human approval and `autoPromoteRiskTiers` lists the Change risk tier (`low` in `policy-1`). Then the CandidateVerificationWorkflow calls the same `promoteCandidate` path with actor `system:auto-promotion`. `canonical.promotion.requested` then records `trigger: "auto"`. All section 36 preconditions still apply. A Candidate that needs approval never promotes automatically (`autoPromoteDecision` in `packages/evidence/src/promotion.ts`).
- A Project has a release target when it has a live app or a `release_targets` row. See [Live apps](live-apps.md).
- The Change is `promoting` during the compare-and-swap. After it, the Change is `releasing` when the Project has a release target, else `completed`. The release then ends the Change as `completed` (deployed or superseded) or `failed`.
- Every end after promotion records `change.completed` or `change.failed`. `build.started` records `releasing`. These Events move ProjectViewDO out of `promoting` (section 13.3).
- A Change still `releasing` 45 minutes after promotion is stuck (`RELEASE_STUCK_AFTER_MS`). Every 5 minutes the event router reads `changes` by `(status, updated_at)` and queues one `release.recover` per stuck Change. The integration Worker then marks a queued or building release `failed`. It records a release that never started as a `failed` release row. Then it fails the Change. If the Project has no release target, the Worker completes the Change instead. The reason is on the release row and in the Event. The generation stays promoted. The next promotion releases as usual.
- After `canonical.advanced`, the causal router marks every other in-flight Candidate on an older base `stale`.

## Status state machines

The enums are in `packages/protocol/src`.
The diagrams show only the transitions that the code writes.

### Change status

```mermaid
stateDiagram-v2
  [*] --> created: API insert
  created --> compiling: ChangeWorkflow
  compiling --> running: Work Graph stored
  compiling --> failed: planner failed
  compiling --> not_selected: lost a request conflict
  compiling --> awaiting_owner: conflict needs the owner
  running --> verifying: last Task completed
  running --> budget_blocked: budget or limit stop
  budget_blocked --> running: person raises the budget
  verifying --> awaiting_approval: verified Candidate needs approval
  awaiting_approval --> verifying: no verified Candidate left
  verifying --> running: merge conflict, Tasks re-run on the new base
  verifying --> blocked: second merge conflict
  verifying --> promoting: promotion requested
  awaiting_approval --> promoting: promotion requested
  promoting --> verifying: compare-and-swap refused
  promoting --> releasing: advanced, release target exists
  promoting --> completed: advanced, no release target
  releasing --> completed: deployed or superseded
  releasing --> failed: release failed or stuck
  created --> cancelled: person cancels
  compiling --> cancelled: person cancels
  running --> cancelled: person cancels
  verifying --> cancelled: person cancels
  awaiting_approval --> cancelled: person cancels
  budget_blocked --> cancelled: person cancels
  completed --> [*]
  failed --> [*]
  cancelled --> [*]
```

A Candidate that fails on a merge conflict makes the Change re-run the conflicting Tasks on the new base (`workers/integration/src/rebase.ts`). After two such re-runs the Change becomes `blocked` with the reason "The request could not be merged with newer changes twice. Submit it again."
The pure rules are in `workers/integration/src/change-status.ts`.
A refused compare-and-swap returns the Change to its status before `promoting`.
A verified Candidate can also promote from `running` or `budget_blocked`.

- `POST /v1/changes/:changeId/cancel` works until promotion starts.
  It cancels the open Tasks and rejects the open Candidates (reason `change cancelled`).
  A cancel during `compiling` stores the planned Tasks as `cancelled` and records no compile.
  A running CandidateVerificationWorkflow checks the Change at each step boundary and stops before it uses more Sandbox or Browser Run time.
  Dispatch runs only for a `running` Change.
  An active Agent run stops at its next one-minute run check.
- `POST /v1/changes/:changeId/budget` raises `budget_usd`. The budget can never go down.
  A `budget_blocked` Change returns to `running`, because `running` is the only status that a budget stop interrupts.
  Its budget-stopped Tasks become ready again, and their blocked dependents become pending.
  Then the normal dispatch runs (section 44 rule 5).

### Task status

```mermaid
stateDiagram-v2
  [*] --> pending: ChangeWorkflow insert
  pending --> ready: dependencies completed
  pending --> blocked: a dependency failed
  ready --> assigned: admitAgent (slot free)
  ready --> ready: deferred at 8 active agents
  ready --> blocked: wake dead-lettered
  assigned --> running: AgentDO.start
  assigned --> blocked: wake dead-lettered
  running --> running: retry or escalate
  running --> completed: complete_task and publish
  running --> failed: terminal failure
  running --> blocked: budget or limit stop
  blocked --> ready: operator retries dead letter
  completed --> [*]
  failed --> [*]
```

A Change cancel moves the open Tasks to `cancelled`. A budget raise moves the budget-stopped Tasks from `blocked` back to `ready`.

### Candidate status

```mermaid
stateDiagram-v2
  [*] --> composing: candidate row inserted
  composing --> verifying: composed, plan recorded
  composing --> rejected: incompatible, merge conflict, or no Sandbox budget
  composing --> stale: base behind canonical
  verifying --> verified: every required check passes
  verifying --> rejected: a required check has a gap
  verified --> rejected: approver rejects
  verified --> promoted: compare-and-swap succeeds
  verified --> stale: canonical advanced first
  verifying --> stale: canonical advanced
  promoted --> [*]
  rejected --> [*]
  stale --> [*]
```

`composed` is in the enum and in RPC results, but D1 rows go from `composing` directly to `verifying`.
Rhumbatron never retries a stale Candidate blind (section 42.9). A new Candidate on the new base replaces it.

### Release status

```mermaid
stateDiagram-v2
  [*] --> queued: promotion with a release target
  queued --> building: generation still canonical
  queued --> superseded: newer generation promoted
  building --> superseded: newer generation promoted
  building --> failed: no build, build failed, or deploy unconfirmed
  building --> deployed: smoke check passed
  building --> smoke_failed: smoke check failed
  deployed --> [*]
  failed --> [*]
  smoke_failed --> [*]
  superseded --> [*]
```

A failed release never deletes canonical history.
Recovery is a new canonical transition (section 42.10).
