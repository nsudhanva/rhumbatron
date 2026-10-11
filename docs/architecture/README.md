# Rhumbatron architecture guide

This guide uses diagrams to explain how Rhumbatron works.
Each diagram matches the code.
This guide describes the code. It records each difference from `AGENTS.md`.

## Product summary

Rhumbatron accepts a product goal for one Project.
A Root Planner model splits the goal into a Work Graph of small Tasks.
Agents run the ready Tasks in parallel, each in its own Artifacts fork and Sandbox directory.
Each Agent publishes a ChangeSet and a typed Intent.
Deterministic code compares the Intents and finds semantic conflicts that Git cannot see.
When two designs conflict, Rhumbatron composes two Candidate futures.
A Verification Workflow runs executable checks on each Candidate.
Only `checked_supported` Evidence with status `pass` can satisfy a required check.
A human approves a gated Candidate.
ProjectRootDO then advances the Canonical Generation with compare-and-swap.
The release moves the live app pointer (ADR 0020).
A Release Workflow runs the release and its smoke check.

> Many Agents can propose many futures. Only verified evidence can advance the Canonical State.

## The six planes

The code follows the six planes of `AGENTS.md` section 8.
Arrows show the main direction of calls and data.

```mermaid
flowchart LR
  subgraph Control["Control Plane"]
    API["rhumbatron-api (Hono)"]
    ROOT["ProjectRootDO + ResourceShardDO"]
    D1[("D1 control DB")]
  end
  subgraph Event["Event Plane"]
    OUTBOX["DO SQLite outbox"]
    K2[("K2: 8 streams")]
    Q[["Queues"]]
  end
  subgraph Agent["Agent Plane"]
    AGENT["AgentDO + Pi harness"]
    GW["AI Gateway"]
  end
  subgraph Exec["Execution Plane"]
    SBX["Sandbox container"]
    BR["Browser Run"]
  end
  subgraph State["State Plane"]
    ART[("Artifacts repos")]
    R2[("R2 evidence bucket")]
    VEC[("Vectorize")]
  end
  subgraph Obs["Observability Plane"]
    AE["Analytics Engine"]
    LOGS["Workers Logs"]
  end
  API --> ROOT --> OUTBOX --> K2 --> Q --> AGENT
  AGENT --> GW
  AGENT --> SBX --> ART
  AGENT --> R2
  AGENT --> VEC
  SBX --> BR
  AGENT --> AE
  API --> D1
  API -.->|"every Worker"| LOGS
```

| Plane | What the code uses | Main source |
|---|---|---|
| Control | `rhumbatron-api`, ProjectRootDO, ResourceShardDO, D1 | `workers/api`, `workers/coordinator` |
| Event | DO SQLite outbox, K2 streams, Queues, Workflows | `workers/coordinator/src/outbox.ts`, `workers/event-router` |
| Agent | AgentDO, Pi harness, AI Gateway, Workers AI (Clef-flash) | `workers/agents`, `packages/model-router` |
| Execution | Sandbox container, Browser Run | `workers/sandbox`, `workers/integration/src/candidate-sandbox.ts` |
| State | Artifacts, R2, D1, DO SQLite, KV (`CONFIG`), Vectorize | `workers/integration`, `workers/indexer` |
| Observability | Analytics Engine (`METRICS`, `EVENT_METRICS`), Workers Logs, AI Gateway logs | `workers/agents`, `workers/indexer`, `workers/event-router` |

Differences from `AGENTS.md`:

- The KV namespace `rhumbatron-config-<env>` (binding `CONFIG` on the integration Worker) holds only a 5-minute snapshot of the Project policy. D1 `project_policies` is the source of truth. No API writes it, so a Project without a row uses the default policy. Promotion and approval read the policy. Candidate verification plans with the default policy. Conflict detection, conflict review, and the Product Graph read only the stored row's `protectedResources`; without a row they protect nothing.
- No OpenTelemetry tracing is configured. Durable Object Workers set `traces.enabled = false`.

## Deployables map

There are nine Rhumbatron Workers.
`rhumbatron-apps` runs live apps (ADR 0020). The docs site is a tenth, assets-only Worker.
Each Worker is named `rhumbatron-<component>-<env>`, where `<env>` is `prod`.

The first diagram shows how the Workers call each other.
Solid arrows are service bindings or cross-script Durable Object bindings.
Dotted arrows are Queue messages or K2 records.

```mermaid
flowchart LR
  WEB["rhumbatron-web"]
  API["rhumbatron-api"]
  COORD["rhumbatron-coordinator"]
  ER["rhumbatron-event-router"]
  INT["rhumbatron-integration"]
  AG["rhumbatron-agents"]
  IDX["rhumbatron-indexer"]
  SBX["rhumbatron-sandbox"]

  WEB -->|"API service"| API
  API -->|"PROJECT_ROOT, PROJECT_VIEW"| COORD
  API -->|"INTEGRATION RPC"| INT
  API -->|"AGENTS RPC"| AG
  API -.->|"integration Queue"| INT
  COORD -->|"EVENT_ROUTER nudge"| ER
  COORD -.->|"K2 EVENTS_00..07"| ER
  ER -.->|"agent-wakeups"| AG
  ER -.->|"integration"| INT
  ER -.->|"indexing"| IDX
  INT -.->|"agent-wakeups"| AG
  AG -->|"SANDBOX"| SBX
  INT -->|"SANDBOX"| SBX
```

The second diagram shows which Worker hosts each Durable Object class and each Workflow class.

```mermaid
flowchart TB
  subgraph COORD["rhumbatron-coordinator"]
    PR["ProjectRootDO"]
    RS["ResourceShardDO"]
    PV["ProjectViewDO"]
  end
  subgraph AG["rhumbatron-agents"]
    ADO["AgentDO"]
  end
  subgraph SBX["rhumbatron-sandbox"]
    SB["Sandbox (container class)"]
  end
  subgraph INT["rhumbatron-integration"]
    CW["ChangeWorkflow"]
    VW["CandidateVerificationWorkflow"]
    RW["ReleaseWorkflow"]
  end
  API["rhumbatron-api"] -->|"CHANGE_WORKFLOW"| CW
  CW --> RS
  VW --> SB
  ADO --> SB
  RW --> PR
```

| Worker | Hosts | Main bindings (Terraform names) | Triggers |
|---|---|---|---|
| `rhumbatron-web` | TanStack Start app and static assets | `API` (service) | Custom domain: `rhumbatron.com` and `www` |
| `rhumbatron-api` | Hono product API | `DB`, `EVIDENCE`, `PROJECT_ROOT`, `PROJECT_VIEW`, `AGENTS`, `INTEGRATION`, `INTEGRATION_COMMANDS`, `AGENT_WAKEUPS`, `CHANGE_WORKFLOW` | Custom domain: `api.rhumbatron.com` |
| `rhumbatron-coordinator` | ProjectRootDO, ResourceShardDO, ProjectViewDO | Own DO classes, `EVENT_ROUTER` (service), K2 producers `EVENTS_00` to `EVENTS_07` | DO alarms only |
| `rhumbatron-event-router` | K2 pull consumer, causal router, dead-letter consumer | `DB`, `EVIDENCE`, `PROJECT_VIEW`, `RESOURCE_SHARD`, `AGENT_WAKEUPS`, `INTEGRATION_COMMANDS`, `INDEXING`, `AI`, `K2_STREAM_IDS`, `K2_CONSUMER_TOKEN` | Cron `* * * * *`, `nudge` RPC, `rhumbatron-dead-letter` Queue |
| `rhumbatron-integration` | ChangeWorkflow, CandidateVerificationWorkflow, ReleaseWorkflow, approval and promotion RPC | `DB`, `EVIDENCE`, `AGENT_WAKEUPS`, `RESOURCE_SHARD`, `PROJECT_ROOT`, `SANDBOX`, `CANDIDATE_WORKFLOW`, `RELEASE_WORKFLOW`, `ARTIFACTS`, `BROWSER`, AI Gateway variables | `rhumbatron-integration` Queue, RPC |
| `rhumbatron-agents` | AgentDO (Agents SDK `Agent` with Pi harness) | `DB`, `AGENT`, `SANDBOX`, `PROJECT_ROOT`, `RESOURCE_SHARD`, `ARTIFACTS`, `EVIDENCE`, `METRICS`, `AI`, `MEMORY`, AI Gateway variables | `rhumbatron-agent-wakeups` Queue, `sandboxSmoke` RPC |
| `rhumbatron-indexer` | Symbol, dependency, Product Graph, and vector indexes | `DB`, `EVIDENCE`, `PROJECT_ROOT`, `ARTIFACTS`, `MEMORY`, `AI`, `METRICS` | `rhumbatron-indexing` Queue only |
| `rhumbatron-sandbox` | `Sandbox` container class from `@cloudflare/sandbox` | Image `docker.io/cloudflare/sandbox:0.12.6`, instance type `basic`, `max_instances` 1 | Cross-script DO binding only |
| `rhumbatron-apps` | Live apps of Projects on Dynamic Workers (prod only, ADR 0020) | `LOADER` (Worker Loader), `DB`, `EVIDENCE`, `APP_DATA` (DO) | Wildcard route `<slug>.rhumbatron.com` |

Notes:

- `AGENTS.md` section 12 lists seven deployables. The code adds `rhumbatron-sandbox`, because the provider cannot attach a container to a DO class in another Worker (ADR 0012), and `rhumbatron-apps` (ADR 0020).
- A Project with a live app releases through the apps Worker (ADR 0020).

## Reading order

Read the pages in this order.
Each page uses concepts from the pages before it.

```mermaid
flowchart LR
  A["1. README (this page)"] --> B["2. Change lifecycle"]
  B --> C["3. Events and commands"]
  C --> D["4. Agents and models"]
  D --> E["5. Source and verification"]
  E --> F["6. Infrastructure and cost"]
```

1. [Change lifecycle](change-lifecycle.md): one goal from the browser to a release, plus the status state machines.
2. [Events and commands](events-and-commands.md): the outbox, K2, the event router, Queues, and idempotency.
3. [Agents and models](agents-and-models.md): AgentDO, the Pi loop, model routing, providers, and the Context Packet.
4. [Source and verification](source-and-verification.md): Artifacts repos and forks, the Sandbox, checks, coverage, and promotion.
5. [Infrastructure and cost](infrastructure-and-cost.md): Terraform roots, adapters, state, cost guards, and the pause switch.
6. [Shared Projects and simultaneous requests](shared-projects.md): membership, owner and collaborator roles, and how Rhumbatron compares requests that run at the same time.
7. [Live apps](live-apps.md): app hosts, the apps Worker, previews, the production pointer, rollback, and removal.

Related documents:

- [Tech stack](tech-stack.md): every technology in use, what it does, and where it differs from `AGENTS.md`.
- `AGENTS.md`: the authoritative build plan.
- `docs/adr/`: one record per architecture decision. This guide cites ADRs by number.
- `docs/BUILD_STATUS.md`: current phase, blockers, and caps.
