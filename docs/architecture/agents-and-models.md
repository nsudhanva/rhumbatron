# Agents and models

This page explains the Agent Plane: AgentDO, the Pi harness loop, model routing, providers, escalation, the Context Packet, and stacked workspaces.

Main source files:

- `workers/agents/src/agent-do.ts`: AgentDO, run start, run end, budgets.
- `workers/agents/src/wake-consumer.ts`: the `agent-wakeups` consumer.
- `workers/agents/src/limits.ts`: section 44 limits and provider choice.
- `packages/model-router/src`: routing rules, Clef, escalation, budgets, providers, gateway client.
- `packages/context-compiler/src`: Context Packet assembly and retrieval order.

## AgentDO

AgentDO is one durable logical agent.
It extends the Agents SDK `Agent` class and implements the `AgentRuntime` interface (`start`, `resume`, `cancel`, `getState`).
Pi types stay inside AgentDO and `workers/agents/src/models.ts` (section 25).
There is one agent per Task today: the agent ID is `agt_<task>`.

AgentDO stores its own run rows in DO SQLite (`agent_runs`, `run_tool_logs`).
D1 holds the shared view (`task_runs`, `decision_receipts`, `tasks`).
AgentDO sleeps when no run is active.
While a run is active, one interval schedule checks it every 60 seconds.
After 15 checks the run is stuck and ends as `timeout`.

### Run start pipeline

`start()` runs deterministic steps before the first model call.
Each refusal fails or blocks the Task with an exact reason.

```mermaid
flowchart TB
  W["agent.wake (task_ready)"] --> AD{"admitAgent:<br/>fewer than 8 active<br/>agents in the Change?"}
  AD -->|"no"| DEF["Task stays ready<br/>(blocked_limit noted)"]
  AD -->|"yes"| BUD["Task budget =<br/>(Change budget - spent) / open Tasks"]
  BUD --> RT{"First attempt?"}
  RT -->|"yes"| ROUTE["routeStep: rules, then Clef-flash"]
  RT -->|"no"| ESC["nextStep + limitAttempts:<br/>retry, escalate, or stop"]
  ROUTE --> CMP["Compact prior failure logs<br/>(haiku tier, retries only)"]
  ESC --> CMP
  CMP --> PROV["chooseProvider:<br/>OpenRouter or Vertex"]
  PROV --> STACK["Dependency stack:<br/>ChangeSets to merge"]
  STACK --> PKT["compilePacket<br/>store in R2 by hash"]
  PKT --> REC["D1 batch: Decision Receipt,<br/>task_runs row, status running"]
  REC --> CLM["Advisory Claims on<br/>the Task resources"]
  CLM --> PI["Pi: reset session,<br/>set model, submit"]
```

Claims are advisory (ADR 0015).
A Claim held by another agent does not block the run.
The shard records `claim.contended`, and conflict detection uses that signal.
A Claim lease is 120 seconds and renews at half-life, on the one-minute run check.

### Pi harness loop

Pi runs the model and tool loop.
AgentDO wraps every model request with a budget gate and records every failure.

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
    Pi->>A: beforeModelCall(tier, provider)
    A-->>Pi: allow, or throw at a cap
    Pi->>GW: chat completion
    GW-->>Pi: tool call
    Pi->>T: list_files, read_file, write_file, or run_command
    T->>SBX: read source, write file, run allowlisted command
    SBX-->>T: output (max 12,000 chars)
    T-->>Pi: result plus remaining call budget
  end
  Pi->>T: complete_task(intent) or fail_task(reason)
  T->>A: finishRun
  A->>SBX: publish ChangeSet, close workspace
```

Caps inside one run:

| Cap | Value | Source |
|---|---|---|
| Model calls per run | haiku 16, sonnet 32, opus 32 | `MAX_CALLS_PER_RUN` |
| File reads per run | 12 reads, 24,000 characters each | `agent-do.ts` |
| Command output | 12,000 characters, 180 s timeout | `workspace.ts` |
| Pi retries | 1 retry for a transient error, 2 s base delay | `agent-do.ts` |
| Run spend | Must stay at or below the Task budget share | `checkRunBudget` |

Commands must match an allowlist: `bun install`, `bun test`, `bun run typecheck|test|bench`, `bunx tsc --noEmit`, `git status|diff|log`, and `ls`.
Shell metacharacters are refused.

## Model routing

The code keeps the tier names `haiku`, `sonnet`, and `opus` from `AGENTS.md`.
The models behind them differ from `AGENTS.md`: the code does not call Claude.
A tier maps to OpenRouter free models, with Gemini on Vertex AI as the paid overflow (ADR 0007, ADR 0016).

### Deterministic rules, then Clef-flash

`routeByRules` (section 23.2) picks a base tier and applies floors.
Clef-flash runs only when the rules fell through to `default` on a first attempt.
A Clef choice can never go below the floor.

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
  LG -->|"planning kind"| OPUS1
  LG -->|"other kind"| SONNET
  LG -->|"no: default"| CLEF{"Clef-flash<br/>(abstain below 0.6)"}
  CLEF -->|"abstain"| SONNET
  CLEF -->|"choice, raised to floor"| FLOOR["Floor: sonnet for billing<br/>or non-trivial authorization"]
```

The floor applies to the rule path too: billing and non-trivial authorization raise the tier to at least `sonnet`.
Every route writes a Decision Receipt (`decision_receipts` in D1) and a `model.route.decided` Event.
A receipt has no private reasoning.

### Tiers and providers

```mermaid
flowchart LR
  subgraph Tier["Tier from the router"]
    H["haiku"]
    S["sonnet"]
    O["opus"]
  end
  CH{"chooseProvider<br/>once per run"}
  H --> CH
  S --> CH
  O --> CH
  CH -->|"openrouter_free"| OR["AI Gateway<br/>/openrouter/v1/chat/completions<br/>:free models, $0"]
  CH -->|"vertex_preferred or<br/>OpenRouter used up"| VX["AI Gateway<br/>/compat/chat/completions<br/>google-vertex-ai Gemini"]
  CH -->|"Vertex spend limit hit today"| STOP["No provider:<br/>Task blocked (vertex_spend_limit)"]
  OR --> CAP["Gateway: 20 requests per minute,<br/>2 retries, 10,000 logs"]
  VX --> SPEND["Gateway spend limit on Vertex:<br/>dev $40, prod $10 per 30 days"]
```

| Tier | OpenRouter free models (in order) | Vertex overflow model |
|---|---|---|
| haiku | `poolside/laguna-xs-2.1:free`, `nvidia/nemotron-3.5-lightning:free`, `cohere/north-mini-code:free` | `google/gemini-3.5-flash-lite` |
| sonnet | `poolside/laguna-s-2.1:free`, `cohere/north-mini-code:free`, `nvidia/nemotron-3-super-120b-a12b:free` | `google/gemini-3.8-flash` |
| opus | `nvidia/nemotron-3-ultra-550b-a55b:free`, `poolside/laguna-s-2.1:free` | `google/gemini-3.8-flash` |

Provider rules (`selectProvider` in `packages/model-router/src/provider.ts`):

1. `MODEL_PROVIDER = vertex` sends every agent call to Gemini. The dev default is `vertex`. The prod default is `openrouter`.
2. Otherwise OpenRouter goes first, until 45 OpenRouter calls today or a quota error today.
3. Then Gemini on Vertex, if a Vertex credential is bound.
4. If Vertex is needed and the gateway already rejected it for its spend limit today, nothing runs.

Daily caps in D1 `usage_counters`: 400 agent model calls per day on all providers, 45 OpenRouter calls, and 200 Clef-flash calls.
The Root Planner and the conflict reviewer call `complete()` directly.
That function goes to Vertex first when `MODEL_PROVIDER = vertex`.
Otherwise it tries OpenRouter and falls back to Vertex on a rate limit, an outage, or a timeout.

## Escalation

`nextStep` (section 23.3) decides what happens after a failed run.
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
  sonnet --> opus: 2nd failure at sonnet
  opus --> opus: 1st failure, retry
  opus --> replan: 2nd failure at opus
  haiku --> stopped: budget or spend limit
  sonnet --> stopped: budget or spend limit
  opus --> stopped: budget or spend limit
  replan --> [*]
  stopped --> [*]
```

Other rules:

- A transport failure (`rate_limited`, `timeout`, `transient`) retries once at the same tier. A second one in a row fails the Task.
- `budget_exhausted` and `spend_limited` stop at once. The Task becomes `blocked`, and the Change becomes `budget_blocked` with the exact limit.
- `replan` has no automatic re-plan today. It is a budget stop with limit `max_attempts_per_tier`: the Task becomes `blocked`, and the Change becomes `budget_blocked`.
- `limitAttempts` also caps attempts at 2 per tier (section 44), counting every earlier run at that tier.
- When a Task fails or stops, its pending dependents become `blocked`.
- An escalation records `agent.escalated`. Every retry gets a fresh Pi session (section 23.3).

## Context Packet assembly

The Context Compiler is deterministic and does no I/O.
`workers/agents/src/retrieval.ts` loads the inputs; `compilePacket` orders, trims, and renders them.
The model never chooses its own scope (section 27.5).

```mermaid
flowchart TB
  subgraph Fixed["Fixed by code"]
    C["Change goal, criteria, invariants"]
    TK["Task objective, resources, risk"]
    TOOLS["Allowed tools by Task kind"]
    B["Budget: max calls, USD"]
  end
  subgraph Exact["Exact retrieval, in order"]
    D1["1. Declared files"]
    D2["2. Dependency neighbors"]
    D3["3. Resource owners<br/>(Product Graph)"]
    D4["4. Dependency and nearby Intents,<br/>prior failures, compaction"]
  end
  V["5. Vectorize: max 5 matches,<br/>score at least 0.6"]
  PKT["ContextPacket v1<br/>max 12,000 tokens"]
  R2[("R2 context/project/change/task/hash.json")]
  Fixed --> PKT
  D1 --> D2 --> D3 --> D4 --> V --> PKT
  PKT --> R2
```

Rules:

- Every item carries `itemId`, `source`, `sourceVersion`, and `capturedAt`.
- The packet hash is stored on the `task_runs` row (`context_hash`). Two runs with the same hash had the same inputs.
- Vectorize gets at most 1,000 query embeddings per day. It only adds files that exist in the indexed tree.
- `rhumbatron-indexer` builds the exact indexes once per canonical tree, on `index.build`.
- Tool inputs and outputs (never model reasoning) go to R2 at `context/<project>/<change>/<task>/tools-<run>.json`.

## Stacked workspaces

A Task with dependencies does not start from bare canonical source.
Its workspace starts from canonical plus the published ChangeSets of every Task it depends on, in topological order (`stackFor` in `workers/agents/src/stack.ts`).
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

The ChangeSet records this lineage in `intent_json.changeSet`:

| Field | Meaning |
|---|---|
| `baseCommit` | Canonical commit the fork started from |
| `stackedOn` | Dependency ChangeSet IDs merged before the first edit |
| `startCommit` | HEAD after the stacked merges |
| `files` | Every file that differs from `baseCommit` |
| `ownFiles` | Files this Task changed on top of its stack |

Because `ws-t3` descends from `ws-t1` and `ws-t2`, Candidate composition merges them as shared history, not as concurrent edits.
Conflicting dependency ChangeSets fail the Task at once (`dependency_merge_conflict`): no retry or tier can fix them.
