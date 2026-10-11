# Change lifecycle

This page follows one user goal from the browser to a release in three sequence diagrams.
Then it shows the status state machines.

The path uses these stable IDs (`AGENTS.md` section 60):

| Object | ID rule | Source |
|---|---|---|
| Change | `chg_<uuid>`. Idempotent on `clientRequestId` per requester. | `workers/api/src/projects.ts` |
| ChangeWorkflow instance | The Change ID | `workers/api/src/projects.ts` |
| Task | `tsk_<change>_<key>`, where `<change>` is the Change ID without `chg_` and `<key>` is `t1`, `t2`, ... | `workers/integration/src/change-workflow.ts` |
| Agent | `agt_<task>`: one logical Agent per Task | `workers/integration/src/dispatch.ts` |
| Task run | `run_<task>_<attempt>` | `workers/agents/src/agent-do.ts` |
| ChangeSet | `cs_<run>` | `workers/agents/src/agent-do.ts` |
| Candidate | `cand_` plus the first 24 hex characters of the SHA-256 composition key | `workers/integration/src/candidate-create.ts` |
| Release | `rel_<project>_<generation>` | `workers/integration/src/release-model.ts` |

## Part 1: from goal to ready Tasks

The API stores the Change and starts one ChangeWorkflow (request field `startPlanning`, default `true`).
The API returns before any model call (section 58).
The ChangeWorkflow runs the intake gate, calls the Root Planner, and compares the plan with the other open requests.
Then it stores the Work Graph and dispatches the ready Tasks.
An unclear, duplicate, or conflicting request waits for its requester (`needs_input`).
[Shared Projects](shared-projects.md#the-intake-gate) describes the intake gate, the request comparison, and the system arbiter (ADR 0025).

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant API as rhumbatron-api
  participant Root as ProjectRootDO
  participant D1 as D1
  participant CW as ChangeWorkflow
  participant GW as AI Gateway
  participant Shard as ResourceShardDO
  participant WQ as agent-wakeups Queue

  User->>API: POST /v1/projects/:id/changes (through rhumbatron-web)
  API->>Root: getCanonical()
  API->>D1: INSERT changes (status created)
  API->>CW: CHANGE_WORKFLOW.create(id = changeId)
  API-->>User: 201 Change
  CW->>D1: status compiling
  CW->>GW: intake gate (embeddings, reranker, Clef-flash, Sonnet)
  opt unclear or duplicate
    CW->>D1: status needs_input, clarification
    User->>API: POST /v1/changes/:id/clarify
    API->>CW: integration RPC clarifyChange, event clarification
  end
  CW->>Root: admit()
  CW->>GW: Root Planner, tool submit_work_graph
  GW-->>CW: WorkGraphPlan (Zod and cycle check)
  CW->>Root: registerScope(), then compare with each earlier request
  CW->>D1: tasks, task_dependencies, status running (one batch)
  CW->>Shard: change.compiled, task.created (outbox)
  CW->>D1: pending to ready when dependencies are completed
  CW->>Shard: task.ready (outbox)
  CW->>WQ: one agent.wake per ready Task
```

Notes:

- The Root Planner routes to the `opus` tier (`taskKind = plan`, `complexity = large`). With `ALLOW_OPUS` set to `false` (the Terraform default), the `opus` tier runs on Sonnet 5.5 (ADR 0021).
- The prompt asks for 2 to 8 Tasks. The schema accepts 1 to 12 (`MAX_TASKS_PER_CHANGE`). The planner makes at most two model calls: the plan and one repair turn.
- A UI Task that calls routes of another Task must depend on that Task. The prompt states the rule. `parsePlan` (`workers/integration/src/root-planner.ts`) also repairs the plan without a model call. A UI Task and an API Task on the same area (first resource segment, `todos` in `todos:ui` and `todos:api`) with no dependency path between them get the edge UI → API.
- The Work Graph JSON goes to R2 at `work-graphs/<project>/<change>.json`.
- Change Events go to the ResourceShardDO that owns `change:<id>`. This keeps ProjectRootDO cold (section 13.1).
- The API writes the Change to ProjectViewDO directly.
- The intake gate records `change.intake.reviewed` and an `INTAKE` Decision Receipt in D1 `change_decisions`. An answer records `change.clarification.answered`.
- A `needs_input` Change waits for the event `clarification` and reads D1 once a day. After 7 days without an answer, the Change is `cancelled`. After 3 answered rounds, the Change plans without another question.

## Part 2: from a wake to a published ChangeSet

Each wake starts one AgentDO run.
The Agent works in its own Artifacts fork and Sandbox directory.
When the run ends, the Agent publishes a ChangeSet and declares a typed Intent.
The ResourceShardDO then detects conflicts.
[Agents and models](agents-and-models.md) describes the run, model routing, and the Pi loop.

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
  A->>D1: route tier, MODEL_ROUTE Decision Receipt, status running
  A->>Shard: model.route.decided, task.started, advisory Claims
  loop Pi tool loop (max 16 model calls on haiku, 32 on sonnet and opus)
    A->>GW: model call
    A->>Art: fork canonical as ws-{run} (first workspace tool call)
    A->>SBX: read_file, write_file, run_command in /workspace/{run suffix}
  end
  A->>SBX: git commit and push to ws-{run}
  A->>D1: changesets (proposed), task completed
  A->>Shard: changeset.proposed, intent.declared, task.completed
  Shard-->>ER: K2 records from the outbox
  ER->>D1: dedupe, find newly ready Tasks
  ER-->>WQ: change.dispatch on the integration Queue, which sends the next wakes
```

Notes:

- Only Task kinds `implement`, `migrate`, and `test` get a workspace. Other kinds get read-only file tools.
- A Task with dependencies starts on a stacked workspace: canonical plus the dependency ChangeSets. See [Agents and models](agents-and-models.md#stacked-workspaces).
- Conflict detection is deterministic and runs before `task.completed`. A model review (Sonnet tier, then Opus tier) runs later from a durable schedule, never on the run path.
- Conflict detection and conflict review read protected resources from the Project policy row (D1 `project_policies`, `protectedResources`). A Project without a row, or with a row that does not parse, has no protected resources there.
- When the last Task completes, AgentDO moves the Change to `verifying` and records `verification.started` with reason `work_graph_completed`.

## Part 3: from Candidates to a release

The causal router turns `verification.started` into one `candidate.create` command.
The integration Worker applies the integrate rule, then the fork rule.
It starts one CandidateVerificationWorkflow per Candidate.
Sibling Candidates on one base wait for each other. The last one to settle selects the winner (ADR 0026).
Policy or a person promotes the winner. ProjectRootDO runs the compare-and-swap.

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
  VW->>Art: fork canonical as cand-{id}
  VW->>SBX: merge ChangeSets in Work Graph order
  VW->>D1: plan_json, status verifying, candidate.composed
  loop each check in the Verification Plan
    VW->>SBX: run check (or Dynamic Worker, or acceptance model call)
    VW->>D1: Evidence row in D1, output in R2
  end
  VW->>D1: gate: verified or rejected
  VW->>D1: last sibling: claim selection, rank, reject losers, candidate.selected
  VW->>D1: approval.requested for a gated winner
  User->>INT: POST /v1/changes/:id/approve (API RPC decideApproval)
  User->>INT: POST /v1/candidates/:id/promote (API RPC promoteCandidate)
  INT->>Root: promote(): compare-and-swap
  Root->>Root: generation + 1 and canonical.advanced in one transaction
  INT->>Art: point canonical main at the composed commit
  INT->>RW: startRelease (only a Project with a live app)
  RW->>RW: move the live app pointer, then smoke check
```

Notes:

- Integrate before fork: a `confirmed` or `fork_required` conflict between two Tasks on different semantic resources (an API and its UI) creates no Candidate. The dependent Task gets a dependency edge and re-runs once on a stacked workspace with the other Task's ChangeSet. The Change returns to `running`. One Candidate then holds both ChangeSets.
- `candidate.create` waits while a conflict review reserved in the last 10 minutes is still open. The last Queue delivery composes anyway.
- A verified Candidate does not promote while a sibling on the same base still composes or verifies. A winner that does not meet every acceptance criterion never auto-promotes: the Change is `awaiting_approval`. See [Source and verification](source-and-verification.md#sibling-candidates-and-selection).
- Auto-promotion applies when the winner needs no human approval and the Project's policy `autoPromoteRiskTiers` lists the Change risk tier. The policy is the D1 `project_policies` row; without a row it is `DEFAULT_POLICY` (`policy-1` in `workers/integration/src/candidate-composer.ts`), which lists `low`. The CandidateVerificationWorkflow then calls `promoteCandidate` with actor `system:auto-promotion`, and `canonical.promotion.requested` records `trigger: "auto"`. All section 36 preconditions apply (`autoPromoteDecision` in `packages/evidence/src/promotion.ts`).
- The Change is `promoting` during the compare-and-swap. After it, the Change is `releasing` when the Project has a live app, else `completed`. The release ends the Change as `completed` (deployed or superseded) or `failed`. See [Live apps](live-apps.md#promotion-and-release).
- Every end after promotion records `change.completed` or `change.failed`. The projector maps `build.started` to `releasing`. These Events move ProjectViewDO out of `promoting` (section 13.3).
- A Change still `releasing` 45 minutes after promotion is stuck (`RELEASE_STUCK_AFTER_MS`). Every 5 minutes, the event router reads `changes` by `(status, updated_at)` and queues one `release.recover` per stuck Change (at most 10 per sweep). The integration Worker then re-checks the Change:
  1. A release that already finished settles the Change.
  2. A `queued` or `building` release becomes `failed`, and the Change becomes `failed`.
  3. A Project without a live app completes the Change.
  4. A Project with a live app but no release row gets a `failed` release row, and the Change becomes `failed`.
  The generation stays promoted. The next promotion releases as usual.
- After `canonical.advanced`, the causal router marks every other `composing`, `verifying`, or `verified` Candidate on an older base `stale`. The router does not compose. It queues one `candidates.recompose` command. Promotion runs the same sweep (`settleStaleBehind` in `workers/integration/src/recompose.ts`). The sweep takes each `verified` Candidate on an older base, and each `stale` Candidate whose Change has no other active Candidate and none on a newer base. The order against the router sweep has no effect.
- Every stale Candidate ends in one of three states: a new Candidate on the new canonical state, a `blocked` Change with a plain reason, or a closed Change. A lineage recomposes at most 2 times (`MAX_RECOMPOSES`). A Change never waits in `verifying` with nothing running.

## Status state machines

The enums are in `packages/protocol/src`.
The diagrams show only the transitions that the code writes.

### Change status

```mermaid
stateDiagram-v2
  [*] --> created: API insert
  created --> compiling: ChangeWorkflow
  compiling --> needs_input: unclear, duplicate, or undecided conflict
  needs_input --> compiling: answer or proceed anyway
  needs_input --> cancelled: withdrawn, or no answer in 7 days
  compiling --> failed: planner failed
  compiling --> not_selected: lost to an earlier request
  compiling --> running: Work Graph stored
  running --> budget_blocked: budget or limit stop
  budget_blocked --> running: person raises the budget
  running --> verifying: last Task completed
  verifying --> running: Tasks re-run after a merge conflict or an integration
  verifying --> blocked: merge conflict after 2 re-runs, or stale Candidate not rebuilt
  blocked --> verifying: budget raise recomposes the stale Candidate
  verifying --> failed: no Candidate can ship
  verifying --> awaiting_approval: winner needs a person
  awaiting_approval --> verifying: no verified Candidate left
  verifying --> promoting: promotion requested
  awaiting_approval --> promoting: promotion requested
  promoting --> verifying: compare-and-swap refused
  promoting --> releasing: advanced, live app exists
  promoting --> completed: advanced, no live app
  releasing --> completed: deployed or superseded
  releasing --> failed: release failed or stuck
```

The pure rules are in `workers/integration/src/change-status.ts`.

| Rule | Source |
|---|---|
| A person can cancel a Change in `created`, `compiling`, `needs_input`, `running`, `verifying`, `awaiting_approval`, `budget_blocked`, or `blocked`. A Change with a promoted Candidate cannot be cancelled. | `CANCELLABLE_FROM`, `cancelChange` in `change-commands.ts` |
| A later request that wins the system arbiter makes an earlier Change `not_selected` from any of these statuses, and also from `failed` or `completed`, when the earlier Change has no promoted Candidate. See [Shared Projects](shared-projects.md#the-system-arbiter). | `request-check.ts` |
| A merge conflict makes the Change re-run the conflicting Tasks on the new base. After 2 re-runs the Change is `blocked` with the reason "The request could not be merged with newer changes twice. Submit it again." | `MAX_REBASE_RERUNS` in `rebase.ts` |
| The Change ends as `failed` when every Candidate on the newest base is `rejected` for a reason other than a merge conflict or a cancel, and no Candidate of the Change is `composing`, `verifying`, `verified`, or `promoted`. `blocked_reason` starts with "No Candidate passed its required checks:" and quotes the Candidate reasons. `change.failed` records it with `phase: "verification"`. | `verificationDeadEnd` |
| A refused compare-and-swap returns the Change to its status before `promoting`. | `leavePromoting` in `promotion.ts` |
| A verified Candidate can also promote from `running` or `budget_blocked`. | `PROMOTABLE_FROM` |
| `completed`, `cancelled`, `failed`, and `not_selected` are terminal. | `TERMINAL_CHANGE_STATUSES` |

`POST /v1/changes/:changeId/cancel`:

1. Cancels the open Tasks and rejects the open Candidates (reason `change cancelled`).
2. A cancel during `compiling` stores the planned Tasks as `cancelled` and records no compile.
3. A running CandidateVerificationWorkflow checks the Change at each step boundary. It stops before it uses more Sandbox or Browser Run time.
4. Dispatch runs only for a `running` Change.
5. An active Agent run stops at its next run check (every 60 s).

`POST /v1/changes/:changeId/budget` raises `budget_usd`. The budget cannot go down.

1. A `budget_blocked` Change returns to `running`. `running` is the only status that a budget stop interrupts.
2. Its budget-stopped Tasks become `ready` again with a new attempt window, and their blocked dependents become `pending`.
3. The normal dispatch runs (section 44 rule 5).
4. On a `verifying`, `blocked`, or `awaiting_approval` Change, the same call retries a merge-conflict re-run within its bound and recomposes a stale Candidate.

### Task status

```mermaid
stateDiagram-v2
  [*] --> pending: ChangeWorkflow insert
  pending --> ready: dependencies completed
  pending --> blocked: a dependency failed or stopped
  ready --> assigned: admitAgent (slot free)
  ready --> ready: deferred at 8 active Agents
  ready --> blocked: wake dead-lettered
  assigned --> blocked: wake dead-lettered
  assigned --> running: AgentDO.start
  running --> running: retry or escalate
  running --> completed: complete_task and publish
  running --> failed: terminal failure
  running --> blocked: budget or limit stop
  blocked --> ready: dead letter retried, or budget raised
  completed --> pending: re-run after a merge conflict or an integration
```

A Change cancel moves the open Tasks (`pending`, `ready`, `assigned`, `running`, `blocked`) to `cancelled`.
A merge-conflict re-run sets a Task to `ready` directly when none of its dependencies re-runs.

### Candidate status

```mermaid
stateDiagram-v2
  [*] --> composing: candidate row inserted
  composing --> verifying: composed, plan recorded
  composing --> rejected: incompatible, merge conflict, or Sandbox budget reached
  verifying --> verified: every required check passes
  verifying --> rejected: a required check fails or has a gap
  verified --> rejected: approver rejects, or a sibling wins the selection
  verified --> promoted: compare-and-swap succeeds
  composing --> stale: canonical advanced
  verifying --> stale: canonical advanced
  verified --> stale: canonical advanced
  stale --> rejected: Change cancelled, or its Tasks re-run
  promoted --> [*]
  rejected --> [*]
```

`composed` is in the enum and in RPC results. D1 rows go from `composing` directly to `verifying`.
Rhumbatron never retries a stale Candidate blind (section 42.9). A new Candidate on the new base replaces it.

### Release status

```mermaid
stateDiagram-v2
  [*] --> queued: promotion with a live app
  queued --> building: generation still canonical
  queued --> superseded: newer generation promoted
  queued --> failed: not canonical, no app, or stuck
  building --> superseded: newer generation promoted
  building --> failed: no bundle, or the pointer did not move
  building --> deployed: smoke check passed
  building --> smoke_failed: smoke check failed
  deployed --> smoke_failed: failure injection
  failed --> [*]
  smoke_failed --> [*]
  superseded --> [*]
```

The allowed transitions are in `NEXT` (`workers/integration/src/release-model.ts`).
A failed release never deletes canonical history.
Recovery is a new canonical transition (section 42.10).
