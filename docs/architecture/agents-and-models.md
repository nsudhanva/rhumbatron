# Agents and models

This page covers the Agent Plane: AgentDO, the Pi harness loop, model routing, the model provider, escalation, the Context Packet, and stacked workspaces.

Main source files:

- `workers/agents/src/agent-do.ts`: AgentDO, run start, run end, budgets.
- `workers/agents/src/wake-consumer.ts`: the `rhumbatron-agent-wakeups` consumer.
- `workers/agents/src/limits.ts`: Change limits and budget-stop text.
- `workers/agents/src/workspace.ts`: the Task workspace and the command allowlist.
- `packages/model-router/src`: routing rules, Clef-flash routing, escalation, budgets, prices, the spend meter, and the gateway client.
- `packages/context-compiler/src`: Context Packet assembly and retrieval order.

## AgentDO

AgentDO is one durable logical Agent.
It extends the Agents SDK `Agent` class and implements the `AgentRuntime` interface (`start`, `resume`, `cancel`, `getState`).
`resume` records the event and starts no work.
Pi types stay inside `agent-do.ts`, `models.ts`, and `task-tools.ts` in `workers/agents/src`.
There is one Agent per Task. The Agent ID is `agt_<task>`.

AgentDO keeps its run state in DO SQLite (`agent_runs`, `run_tool_logs`, `run_meter`, `run_workspaces`).
D1 holds the shared view (`tasks`, `task_runs`, `decision_receipts`).
AgentDO sleeps when no run is active.
While a run is active, an interval schedule checks it every 60 seconds.
After 15 checks, AgentDO treats the run as stuck and ends it as `timeout`.
A check that finds the Task `cancelled` stops the run.

### Run start pipeline

`start()` runs deterministic steps before the first model call.
A refusal fails or blocks the Task and names the exact reason.

```mermaid
flowchart TB
  W["agent.wake (task_ready)"] --> AD{"admitAgent (wake consumer):<br/>fewer than 8 active<br/>agents in the Change?"}
  AD -->|"no"| DEF["Task stays ready<br/>(blocked_limit noted)"]
  AD -->|"yes"| BUD["Task budget =<br/>(Change budget - spent) / open Tasks"]
  BUD --> RT{"First attempt?"}
  RT -->|"yes"| ROUTE["routeStep: rules, then Clef-flash"]
  RT -->|"no"| ESC["nextStep + limitAttempts:<br/>retry, escalate, or stop"]
  ROUTE --> CMP["Compact prior failure logs<br/>(haiku tier, above 6,000 tokens)"]
  ESC --> CMP
  CMP --> PROV["Monthly Anthropic budget:<br/>room for one call?<br/>Opus off: opus runs on Sonnet"]
  PROV --> STACK["Dependency stack:<br/>ChangeSets to merge"]
  STACK --> PKT["compilePacket,<br/>store in R2 by hash"]
  PKT --> REC["D1 batch: Decision Receipt,<br/>task_runs row, status running"]
  REC --> CLM["Advisory Claims on<br/>the Task resources"]
  CLM --> PI["Pi: reset session,<br/>set model, submit"]
```

Notes:

- `spent` is the cost of the Change's Task runs plus its conflict reviews.
- A Change with spend and no budget left stops the Task with limit `change_budget`.
- A run starts only when every meter of the Change has room for its first call (`refusedMeter`). Otherwise, the Task stops with the limit of the full meter.
- Claims are advisory (ADR 0015). A Claim that another Agent holds does not block the run. The shard records `claim.contended`, and conflict detection uses that signal.
- A Claim lease lasts 120 seconds. The one-minute run check and each model call renew a lease at half-life. Every run end releases the Claims of the run.

### Pi harness loop

Pi runs the model and tool loop.
AgentDO gates every model request and records every failed response.

```mermaid
sequenceDiagram
  autonumber
  participant A as AgentDO
  participant Pi as PiHarness
  participant GW as AI Gateway
  participant T as Task tools
  participant SBX as Sandbox and Artifacts

  A->>Pi: submit(prompt from Context Packet)
  loop until complete_task or fail_task
    Pi->>A: beforeModelCall(tier)
    A-->>Pi: allow and reserve on the monthly meter, or throw at a cap
    Pi->>GW: Messages API call (Anthropic)
    GW-->>Pi: tool call
    Pi->>T: list_files, read_file, write_file, delete_file, or run_command
    T->>SBX: read source, write file, run allowlisted command
    SBX-->>T: output (max 12,000 characters)
    T-->>Pi: result plus remaining model calls
  end
  Pi->>T: complete_task(intent) or fail_task(reason)
  T->>A: finishRun
  A->>SBX: publish ChangeSet, close workspace
```

The Task tools are `list_files`, `read_file`, `write_file`, `delete_file`, `run_command`, `complete_task`, and `fail_task`.
Only Task kinds `implement`, `migrate`, and `test` get a workspace.
For other kinds, `write_file`, `delete_file`, and `run_command` return "This Task has no workspace".
The first workspace tool call forks the canonical Artifact and opens a Sandbox checkout.
A Project without source gets only `complete_task` and `fail_task`.

Caps inside one run:

| Cap | Value | Source |
|---|---|---|
| Model calls per run | haiku 16, sonnet 32, opus 32 | `MAX_CALLS_PER_RUN` in `packages/model-router/src/budget.ts` |
| Run spend | At most the Task budget | `checkRunBudget` in `budget.ts` |
| File reads per run | 12 reads, 24,000 characters each | `agent-do.ts` |
| Command output | 12,000 characters, 180 s timeout | `workspace.ts` |
| Open Sandboxes per Change | 4 | `CHANGE_LIMITS` in `limits.ts` |
| Pi retries | 1 retry for a transient error, 2 s base delay | `agent-do.ts` |

A run that reaches its call cap or its spend cap ends as `run_call_cap`.
This end counts as a failure at the tier (see [Escalation](#escalation)).

Commands must match the allowlist (`commandAllowed` in `workspace.ts`): `bun install`, `bun install --frozen-lockfile`, `bun test [paths]`, `bun run typecheck|test|bench|contract|build`, `bun run <name>` when `<name>` is a script in the workspace `package.json`, `bunx tsc --noEmit`, `git status|diff|log`, and `ls`.
The command tool refuses shell metacharacters and a script name that starts with `-`.
A script runs in the same Sandbox, with the same network policy, as `bun test`.
With `bun run build`, an agent checks that its UI builds. The workspace then discards the files that the build wrote, so the ChangeSet holds no build output. Candidate composition builds the app again (see [Live apps](live-apps.md#client-assets-built-by-the-app)).

## Model routing

The code uses three tier names: `haiku`, `sonnet`, and `opus`.
Every tier calls Anthropic Claude through the AI Gateway (ADR 0021).
Opus is off by default. The `opus` tier runs on Sonnet unless `ALLOW_OPUS` is `"true"`.
Terraform sets `ALLOW_OPUS` from `var.allow_opus` (default `false`).

### Deterministic rules, then Clef-flash

`routeByRules` picks a base tier and applies floors.
Clef-flash runs only on a first attempt, and only when the rules end at `default`.
Clef-flash calls count against the shared `clef-flash` counter of 200 calls per UTC day.
A Clef-flash answer never goes below the floor.

```mermaid
flowchart TB
  R["RouteRequest"] --> DM{"destructiveMigration?"}
  DM -->|"yes"| OPUS1["opus"]
  DM -->|"no"| DC{"design conflict across<br/>more than 1 resource?"}
  DC -->|"yes"| OPUS1
  DC -->|"no"| MK{"summarize, classify,<br/>compact, or transform?"}
  MK -->|"yes"| HAIKU["haiku"]
  MK -->|"no"| SM{"small, low risk,<br/>attempt 1?"}
  SM -->|"yes"| HAIKU
  SM -->|"no"| MED{"medium complexity,<br/>risk at most medium?"}
  MED -->|"yes"| SONNET["sonnet"]
  MED -->|"no"| LG{"large?"}
  LG -->|"plan, architecture,<br/>or arbitration"| OPUS1
  LG -->|"other kind"| SONNET
  LG -->|"no: default"| CLEF{"Clef-flash<br/>(abstain below 0.6)"}
  CLEF -->|"abstain"| SONNET
  CLEF -->|"choice, raised to floor"| FLOOR["Floor: sonnet for billing<br/>or non-trivial authorization"]
```

The floor also applies on the rule path.
Billing and non-trivial authorization raise the tier to at least `sonnet`.
A small, low-risk Task is trivial.
Every route writes a Decision Receipt (`decision_receipts` in D1) and a `model.route.decided` Event.
A receipt holds no private reasoning.

### Tiers and the provider

```mermaid
flowchart LR
  subgraph Tier["Tier from the router"]
    H["haiku"]
    S["sonnet"]
    O["opus"]
  end
  O --> OP{"ALLOW_OPUS<br/>= true?"}
  OP -->|"no (default):<br/>receipt records opus_disabled"| S
  OP -->|"yes"| OPUS["claude-opus-5-5"]
  H --> HM["claude-haiku-5-5"]
  S --> SM["claude-sonnet-5-5"]
  HM --> RES{"Reserve on every<br/>meter of the Change"}
  SM --> RES
  OPUS --> RES
  RES -->|"over budget"| STOP["No call: Change budget_blocked<br/>(the budget that ran out)"]
  RES -->|"reserved"| GW["AI Gateway /anthropic/v1/messages<br/>x-api-key + anthropic-workspace-id<br/>20 requests per minute"]
  GW --> SETTLE["Settle the meter to the<br/>exact cost from usage"]
```

| Tier | Model | Thinking | Pi output cap |
|---|---|---|---|
| haiku | `claude-haiku-5-5` | Off in `complete()`. Adaptive, low effort in Pi. | 4,000 tokens |
| sonnet | `claude-sonnet-5-5` | Adaptive, medium effort, text omitted | 8,000 tokens |
| opus | `claude-sonnet-5-5` while Opus is off. `claude-opus-5-5` when `ALLOW_OPUS` is `"true"`. | Adaptive, high effort, text omitted | 8,000 tokens |

Two call paths use the same gateway, headers, prices, and meter:

- Pi agent runs (`workers/agents/src/models.ts`) use Pi's Anthropic Messages API. Pi puts `cache_control` on the system prompt, the tool definitions, and the latest message. Pi prices each response from its usage fields.
- `complete()` (`packages/model-router/src/gateway-client.ts`) serves the Root Planner, the intake gate, the request review, conflict review, context compaction, the acceptance check, and the Integration Judge. Each caller goes through `meteredComplete()`. `complete()` caches the system prompt. On a follow-up call, it replays a whole assistant turn, with its thinking blocks. The caller sets the output cap.

The intake gate and the request comparison use their own fixed models and fixed rules. See [Shared Projects](shared-projects.md).

### Spend limits

Rhumbatron computes the exact cost of each call. The cost includes uncached input, output with thinking, cache reads, and cache writes at Anthropic list prices (`ANTHROPIC_PRICES` in `packages/model-router/src/models.ts`).

| Limit | Value | Where |
|---|---|---|
| Monthly Anthropic budget | `ANTHROPIC_MONTHLY_BUDGET_USD`: $100 in prod (Terraform maximum $100, code fallback $10) | D1 `usage_counters`, counter `anthropic-usd-micro`, one row per `YYYY-MM`. The AI Gateway spend limit has the same value. |
| Model calls per UTC day | 400 for agent runs, conflict review, compaction, and the acceptance check | D1 `usage_counters`, counter `agent-model-calls` |
| Clef-flash calls per UTC day | 200, shared by routing, intake, and the causal router | D1 `usage_counters`, counter `clef-flash` |
| Request, Project, and user budgets | `changes.budget_usd`, `projects.monthly_budget_usd`, `users.monthly_budget_usd` (ADR 0030) | D1 `usage_counters`, counters `change-usd-micro:<id>`, `project-usd-micro:<id>`, `user-usd-micro:<id>` |

Before each call that a Change pays for, Rhumbatron reserves an estimate on every meter of the Change. One D1 batch writes all the reservations or none of them. After the call, each meter settles to its exact cost (`reserveMeters`, `settleMeters` in `packages/model-router/src/budget-meters.ts`). See [Costs runbook, Budget scopes](../operations/costs.md#budget-scopes).
A refused reservation, a gateway spend-limit 429, and an Anthropic billing error are `spend_limited` events.
`spend_limited` is a budget stop. It never retries and never tries another provider.

## Escalation

`nextAttempt` (`workers/agents/src/limits.ts`) decides what happens after a failed run.
It applies `nextStep` and then `limitAttempts` to the whole failure history of the Task in D1 `task_runs`.
Transport failures never escalate.
Two intelligence failures at one tier move the Task up one tier.

```mermaid
stateDiagram-v2
  [*] --> haiku: routed
  [*] --> sonnet: routed
  [*] --> opus: routed
  haiku --> haiku: 1st failure, retry
  haiku --> sonnet: 2nd failure at haiku
  sonnet --> sonnet: 1st failure, retry
  sonnet --> opus: 2nd failure at sonnet (ALLOW_OPUS only)
  sonnet --> replan: 2nd failure at sonnet (Opus off)
  opus --> opus: 1st failure, retry
  opus --> replan: 2nd failure at opus
  haiku --> stopped: budget or spend limit
  sonnet --> stopped: budget or spend limit
  opus --> stopped: budget or spend limit
  replan --> [*]
  stopped --> [*]
```

Rules:

- A failed run reads every failure of the Task in the current attempt window, its own included. A retry or escalation schedules the next attempt 5 seconds later. An escalation emits `agent.escalated` with `from`, `to`, and `reason`.
- The next `start()` reads the same rows, applies the same rules, and routes to the same tier.
- When a person raises a budget after a stop, a new attempt window opens (`tasks.attempts_reset_at`, `restoreAfterBudgetRaise`). This applies after a repeated-failure stop and after a request, Project, or user budget stop. A run that exceeds its share of the request budget ends as `run_cost_cap`. A run whose call a budget refused ends with the name of that budget. Without the new window, these old runs would stop the Task again before any new run.
- When the attempt limit stops a Task and its latest failure is `run_cost_cap`, the stop is a request budget stop (`change_budget`).
- A transport failure (`rate_limited`, `timeout`, `transient`) retries once at the same tier. A second transport failure in a row fails the Task. When the latest failure is a transport failure and the tier has no attempts left, the Task stops without escalation.
- The daily call cap and the monthly, Project, user, and request budgets stop the Task at once. The Task becomes `blocked`, and the Change becomes `budget_blocked` with the exact limit.
- `replan` is a budget stop with limit `max_attempts_per_tier`. No automatic re-plan runs. The Task becomes `blocked`, and the Change becomes `budget_blocked`.
- `limitAttempts` allows at most 2 attempts per tier and counts every earlier run at that tier.
- Conflicting dependency ChangeSets fail the Task at once (`dependency_merge_conflict`).
- When a Task fails or stops, its pending dependents become `blocked`.
- The Decision Receipt of the next run records an escalation (reason `two_failures_at_<tier>` or `max_attempts_at_<tier>`).
- Every attempt gets a fresh Pi session.

## Context Packet assembly

The Context Compiler is deterministic and does no I/O.
`workers/agents/src/retrieval.ts` loads the inputs.
`compilePacket` orders, trims, and renders them.
The model never chooses its own scope.

```mermaid
flowchart TB
  subgraph Fixed["Fixed by code"]
    C["Change goal, criteria, invariants"]
    TK["Task objective, resources, risk"]
    SRC["Repository file list, app conventions,<br/>stacked ChangeSets, prior failures"]
    TOOLS["Allowed tools and budget"]
  end
  subgraph Exact["Exact retrieval, in order"]
    D1["1. Declared files"]
    D2["2. Dependency neighbors"]
    D3["3. Resource owners<br/>(Product Graph)"]
    D4["4. Dependency and nearby Intents,<br/>prior failures"]
  end
  V["5. Vectorize: max 5 matches,<br/>score at least 0.6"]
  PKT["ContextPacket (packetVersion 1)<br/>max 12,000 tokens"]
  R2[("R2 context/project/change/task/hash.json")]
  Fixed --> PKT
  D1 --> D2 --> D3 --> D4 --> V --> PKT
  PKT --> R2
```

Rules:

- Every item carries `itemId`, `source`, `sourceVersion`, and `capturedAt`.
- Over the token limit, `compilePacket` drops the lowest-priority items first. Vectorize matches are the first to go.
- AgentDO stores the packet hash on the `task_runs` row (`context_hash`). Two runs with the same hash have the same inputs.
- Vectorize gets at most 1,000 query embeddings per UTC day. It adds only files of the same Project that exist in the indexed tree.
- `rhumbatron-indexer` builds the exact indexes once per canonical tree, on the `index.build` command.
- Tool inputs and outputs go to R2 at `context/<project>/<change>/<task>/tools-<run>.json`. Model reasoning never goes there.

## Stacked workspaces

A Task with dependencies starts from canonical source plus the published ChangeSets of every Task it depends on (`stackFor` in `workers/agents/src/stack.ts`).
The order is topological, with dependencies first. ChangeSet creation time breaks a tie, then the Task ID.
The merge order is fixed for the whole run, so a Sandbox restore repeats the same merges.

```mermaid
gitGraph
  commit id: "S0 canonical"
  branch ws-t1
  checkout ws-t1
  commit id: "t1 schema"
  checkout main
  branch ws-t2
  checkout ws-t2
  commit id: "t2 API"
  checkout main
  branch ws-t3
  checkout ws-t3
  merge ws-t1 id: "stack t1"
  merge ws-t2 id: "stack t2"
  commit id: "t3 UI edits"
```

The ChangeSet records this lineage in `intent_json.changeSet` (`ChangeSetIntent` in `packages/protocol/src/candidate.ts`):

| Field | Meaning |
|---|---|
| `fork`, `commit` | Artifacts fork and commit of the ChangeSet |
| `baseCommit` | Canonical commit the fork started from |
| `stackedOn` | Dependency ChangeSet IDs merged before the first edit |
| `startCommit` | HEAD after the stacked merges |
| `files` | Every file that differs from `baseCommit` |
| `ownFiles` | Files this Task changed on top of its stack |
| `patchRef` | R2 key of the stored `git diff`, from `startCommit` when stacked, else from `baseCommit` |

`ws-t3` descends from `ws-t1` and `ws-t2`, so Candidate composition merges them as shared history.
The integrate rule can reopen a Task (`route_json.integrate`, [Source and verification](source-and-verification.md#sibling-candidates-and-selection)).
The reopened Task gets a dependency edge to the other Task, so its re-run stacks on the other Task's ChangeSet.
Its Context Packet tells it to build against the real routes, field names, and data shapes of that ChangeSet.
