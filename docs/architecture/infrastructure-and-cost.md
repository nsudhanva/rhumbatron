# Infrastructure and cost

Rhumbatron runs as one Docker Compose stack on one computer (ADR 0034).
This page lists the services, the networks, and the volumes of the stack.
It also tells what costs money and how the code limits it.

Main source files:

- `compose.yaml`, `services/*`, `containers/sandbox/Dockerfile`
- `services/core/src/main.ts` and `services/core/src/config.ts`
- `packages/platform/src/**`
- `workers/coordinator/src/alarm-guard.ts`, `workers/event-router/src/causal.ts`, `workers/agents/src/limits.ts`
- `packages/model-router/src/budget.ts`, `packages/model-router/src/spend-meter.ts`, `workers/integration/src/sandbox-meter.ts`
- ADR 0020 (live apps), ADR 0021 (Anthropic budget), ADR 0034 (the stack)

[local-stack.md](../operations/local-stack.md) tells an operator how to start, stop, and inspect the stack.

## Services

`bun run stack:up` writes `.env`, runs `docker compose up -d --build`, and reports the trust state of the local CA.
Each service is one container.

```mermaid
flowchart LR
  USER["Browser"] --> EDGE["edge (Caddy)<br/>:80, :443"]
  EDGE -->|"rhumbatron.localhost"| WEB["web<br/>:3000"]
  EDGE -->|"/live/*, api.rhumbatron.localhost"| CORE["core<br/>:8787 API, :8790 internal"]
  EDGE -->|"*.rhumbatron.localhost"| APPS["apps (workerd)<br/>:8788 apps, :8789 RPC"]
  EDGE -->|"docs.rhumbatron.localhost"| DOCS["docs files<br/>in the edge image"]
  WEB -->|"API_INTERNAL_URL"| CORE
  CORE --> NATS["nats<br/>JetStream"]
  CORE --> OBJ["objects<br/>versitygw S3"]
  CORE --> GIT["git"]
  CORE --> SBXD["sandboxd"]
  CORE -->|"RPC :8789"| APPS
  APPS -->|"DB and EVIDENCE shims :8790"| CORE
  CORE -->|"ws://browser:3000/"| BR["browser<br/>Playwright server"]
  CORE --> EMB["embed, rerank<br/>llama.cpp"]
  CORE --> ANT["Anthropic API"]
  SBXD --> PROXY["socket-proxy"] --> DOCKER["Docker Engine"]
  DOCKER --> SBX["sandbox containers"]
  SBX --> EGR["egress proxy"]
  SBX --> GIT
```

| Service | Image or build | Role |
|---|---|---|
| `edge` | `services/edge/Dockerfile` (`caddy:2.11.7-alpine`, with the docs site built on `oven/bun:1.3.14`) | TLS for every `*.rhumbatron.localhost` host from Caddy's local CA, routing by host name, WebSocket proxy. Serves the docs site from `/srv/docs`. |
| `web` | `apps/web/Dockerfile` (`oven/bun:1.3.14-debian`) | TanStack Start app on Bun 1.3.14. Calls core at `http://core:8787`. |
| `core` | `services/core/Dockerfile` (`oven/bun:1.4.4`) | One Bun 1.4.4 process. It hosts the API, the coordinator actors, the agents, integration and its Workflows, the event router, and the indexer. Playwright `connect()` to the `browser` service needs Bun 1.4. |
| `apps` | `services/apps/Dockerfile` (`workerd` 1.20261008.1) | Live apps and Candidate previews. Builds and checks app bundles for core (ADR 0020). |
| `git` | `services/git` (`oven/bun:1.3.14-debian`) | One bare Git repository per Project, Task fork, or Candidate fork. Smart HTTP with signed, scoped tokens. |
| `nats` | `nats:2.15.2-alpine` | JetStream: the command queues and the event log. |
| `objects` | `versity/versitygw:v1.10.0` | S3 bucket `rhumbatron-evidence` on plain files. |
| `browser` | `services/browser` (`mcr.microsoft.com/playwright:v1.64.1-noble`, Playwright 1.64.1 server) | Browser checks. Core connects to `ws://browser:3000/`. |
| `embed` | `ghcr.io/ggml-org/llama.cpp:server-b12110` | `bge-small-en-v1.5` embeddings, 384 dimensions. |
| `rerank` | `ghcr.io/ggml-org/llama.cpp:server-b12110` | `bge-reranker-base` reranking. |
| `sandboxd` | `services/sandboxd` (`oven/bun:1.3.14-debian`) | Makes one sibling container per Sandbox ID through the socket proxy. Listens on port 7070. |
| `socket-proxy` | `wollomatic/socket-proxy:1.13.2` | Allows only the Docker Engine calls that sandboxd uses. Rejects every bind mount. |
| `egress` | `services/sandboxd` (`bun src/egress.ts`) | HTTP(S) proxy for Sandboxes with a `host:port` allowlist: package registries, GitHub, and `git:8080`. |
| `sandbox-image` | `containers/sandbox` (`oven/bun:1.3.14-debian`) | Builds `rhumbatron/sandbox:local` and stops. |

Every long-running service has `restart: unless-stopped`.
`core` waits for a healthy `nats`, a healthy `git`, and a started `objects`.
`web` waits for a healthy `core`.
`apps` has `depends_on: core { condition: service_healthy, restart: true }`. It waits for a healthy `core`, and Compose restarts it when `core` restarts.

### Host names

| Host | Service |
|---|---|
| `https://rhumbatron.localhost` | `web`. The path `/live/*` goes to `core`. |
| `https://api.rhumbatron.localhost` | `core` |
| `https://docs.rhumbatron.localhost` | The docs site in `edge` |
| `https://rhumbatron.com` | The public docs site: the Cloudflare Worker `rhumbatron-docs`, with static assets only |
| `https://<slug>.rhumbatron.localhost`, `https://<previewId>--<slug>.rhumbatron.localhost` | `apps` |

### Networks

| Network | Members | Rule |
|---|---|---|
| `default` | All services except `socket-proxy` and `sandbox-image` | Normal Compose network with a route out, subnet `172.31.240.0/24`. `core` has the fixed address `172.31.240.10`. workerd in `apps` resolves `core` once, at start, so the address stays the same when `core` restarts. |
| `rhumbatron_sbx` (`sbx`) | Sandboxes, `sandboxd`, `egress`, `git` | `internal: true`. A Sandbox reaches only `egress:4750`, `git:8080`, `sandboxd`, and other Sandboxes. |
| `rhumbatron_docker` (`docker`) | `sandboxd`, `socket-proxy` | `internal: true`. Only sandboxd reaches the socket proxy. |

Only `socket-proxy` mounts the Docker socket. `bun run check:guardrails` fails when another Compose service mounts it.

### Volumes

| Volume | Service | Contents |
|---|---|---|
| `core-data` | `core` | `rhumbatron.sqlite` (product tables, `CONFIG`, `MEMORY`, metrics), `workflows.sqlite`, and `actors/` (one SQLite file per actor and `registry.sqlite`) |
| `git-data` | `git` | Bare repositories and `_meta/git.sqlite` (repository metadata and tokens) |
| `objects-data` | `objects` | The objects of the `rhumbatron-evidence` bucket |
| `nats-data` | `nats` | JetStream streams and consumers (at most 10 GB file store, `services/nats/nats.conf`) |
| `apps-data` | `apps` | `AppDataDO` storage of each live app (`/data/do`) |
| `caddy-data`, `caddy-config` | `edge` | The local CA, certificates, and Caddy state |
| `models` | `embed`, `rerank` | The downloaded model files, about 300 MB |

`docker compose down` keeps the volumes. `docker compose down -v` deletes all data.

### Bindings in core

`services/core/src/main.ts` builds one environment and gives it to every module in core.
The application code uses the binding names below.
`packages/platform` implements each binding.
Each module has a tracked `src/bindings.d.ts` with the binding types that it compiles against.
`packages/platform/types/runtime.d.ts` holds the shared runtime interface types that the platform implements.

| Binding | Backend |
|---|---|
| `DB` | `SqlDatabase`: `rhumbatron.sqlite` through `bun:sqlite`. Core applies each unapplied file of `migrations/d1` at start and records it in `d1_migrations`. |
| `CONFIG` | `KeyValueStore`: table `platform_kv` in the same file |
| `MEMORY` | `VectorIndex`: 384-dimension vectors in the same file. Exact cosine search inside one Project. |
| `METRICS`, `EVENT_METRICS` | `MetricsDataset`: table `platform_metrics`. Core deletes rows older than 30 days at start. |
| `EVIDENCE` | `ObjectBucket` on the `objects` service |
| `PROJECT_ROOT`, `RESOURCE_SHARD`, `PROJECT_VIEW`, `AGENT` | Actor namespaces of the actor host |
| `CHANGE_WORKFLOW`, `CANDIDATE_WORKFLOW`, `RELEASE_WORKFLOW` | The workflow engine |
| `AGENT_WAKEUPS`, `INTEGRATION_COMMANDS`, `VERIFICATION_COMMANDS`, `INDEXING`, `RELEASE_COMMANDS` | JetStream queue producers |
| `EVENTS_00` to `EVENTS_07` | JetStream event stream producers |
| `EVENT_LOG` | `client(index)` returns the JetStream consumer client of one event stream. `streams` is 8. The event router reads it in `workers/event-router/src/event-log.ts`. |
| `ARTIFACTS` | `GitServiceClient` for the `git` service |
| `SANDBOX` | The sandboxd client |
| `APPS` | The RPC client for the `apps` service |
| `BROWSER` | `{ wsEndpoint }`: the WebSocket endpoint of the `browser` service, `BROWSER_WS_URL` (`ws://browser:3000/`) |
| `AI` | `SmallModels`: `embed`, `rerank`, and Clef-flash questions to Claude Haiku |
| `EVENT_ROUTER`, `INTEGRATION`, `AGENTS` | In-process entrypoint objects |

## What costs money

Only model calls to the Anthropic API cost money.
All other services run on the local computer without a usage charge.
The public docs site at `https://rhumbatron.com` is a Cloudflare Worker with static assets only. Requests for static assets are free.

| Item | Limit | Where |
|---|---|---|
| Anthropic spend | `ANTHROPIC_MONTHLY_BUDGET_USD` per calendar month, default 100 USD. Each call reserves an estimate on the meter, then settles to its exact cost. A refused reservation stops the call. | `packages/model-router/src/spend-meter.ts`, `usage_counters` row `anthropic-usd-micro` |
| Agent model calls | 1,000 per UTC day, 16 per run (Haiku), 32 per run (Sonnet, Opus) | `packages/model-router/src/budget.ts` |
| Clef-flash questions | 200 per UTC day, one shared `clef-flash` counter. Each question is one Claude Haiku call with a forced tool call. The spend meter does not record these calls. | `causal.ts`, `agent-do.ts`, `workers/integration/src/intake.ts`, `packages/platform/src/ai/models.ts` |
| Opus | `ALLOW_OPUS` is `false` by default. Each opus decision then runs on Sonnet (ADR 0021). | `.env`, `compose.yaml` |

Compose passes `ANTHROPIC_MONTHLY_BUDGET_USD` and `ALLOW_OPUS` from `.env`.
Code without the budget binding uses 10 USD per month (`ANTHROPIC_MONTHLY_BUDGET_FALLBACK_USD`). Core always sets the binding.

### Local caps

The local caps protect the computer, not a bill.
`compose.yaml` sets each cap from `.env`, with the defaults below.

| Variable | Default | Meaning |
|---|---|---|
| `SANDBOX_MONTHLY_SECONDS` | 72,000 (20 h) | Awake Sandbox time per calendar month, on the `sandbox-seconds` meter. A use reserves seconds first. At the cap, new Sandbox work stops. |
| `BROWSER_DAILY_SECONDS` | 3,600 | Browser check time per UTC day, on the `browser-seconds` meter. One session lasts at most 120 s. A Candidate gets at most 2 runs. |
| `SANDBOX_MAX` | 4 | Live Sandbox containers in sandboxd. A call that needs one more container fails with `ContainerUnavailableError`. |
| `SANDBOX_IDLE_MS` | 120,000 | sandboxd removes a Sandbox after this idle time, with its disk. |
| `SANDBOX_CPUS`, `SANDBOX_MEMORY_MB` | 2, 2048 | Resources of one Sandbox container. |

## Guard layers

The code stacks independent guards, from the inner code paths out to the meters.

```mermaid
flowchart TB
  L1["1. Actor alarms<br/>AlarmGuard: no work, no alarm,<br/>reschedule at least 1 s, backoff to 5 min,<br/>2,000 fires per actor per day"]
  L2["2. Outbox retries<br/>max 10 attempts, backoff to 5 min,<br/>unbound stream fails at once"]
  L3["3. Causal caps<br/>1,000 commands per Change per day,<br/>Clef-flash 200 calls per day"]
  L4["4. Change limits<br/>8 agents, 4 Sandboxes, 3 Candidates,<br/>2 attempts per tier, 2 browser runs"]
  L5["5. Queue and event bounds<br/>3 retries, then dead-letter,<br/>event batch skipped after 5 failures"]
  L6["6. Meters in the product database<br/>Sandbox 20 h per month,<br/>browser 3,600 s per day,<br/>1,000 agent model calls per day,<br/>Anthropic budget per month"]
  L1 --> L2 --> L3 --> L4 --> L5 --> L6
```

| Layer | Cap | Where |
|---|---|---|
| Actor alarm guard | 2,000 fires per actor per UTC day | `workers/coordinator/src/alarm-guard.ts` (ProjectRootDO, ResourceShardDO, AgentDO schedules) |
| Outbox | 10 publish attempts per row | `workers/coordinator/src/outbox.ts` |
| Causal router | 1,000 commands per Change per day | `workers/event-router/src/causal.ts` |
| Clef-flash | 200 calls per day, shared by the causal router, agent routing, and the intake gate | `causal.ts`, `agent-do.ts`, `intake.ts` |
| Active agents | 8 per Change | `workers/agents/src/limits.ts` |
| Coding Sandboxes | 4 open per Change | `limits.ts` |
| Candidates | 3 per Change | `workers/integration/src/candidate-create.ts` |
| Attempts | 2 per Task per tier | `limits.ts` |
| Model calls | 16 per run (Haiku) or 32 per run (Sonnet, Opus), 1,000 agent calls per day | `packages/model-router/src/budget.ts` |
| Change budget | `budgetUsd`, default 3 USD, max 100 USD | `packages/protocol/src/project.ts` |
| Queues | 3 retries, then `dead-letter`. The `indexing` queue records its last failed delivery in `project_indexes`. The `dead-letter` queue gets 5 retries. | `services/core/src/consumers.ts` |
| Event batches | A batch that fails 5 times is skipped and recorded | `workers/event-router/src/poison-batch.ts` |
| Sandbox time | 72,000 s (20 h) per month | `SANDBOX_MONTHLY_SECONDS` |
| Browser checks | 3,600 s per day, 120 s per session, 2 runs per Candidate | `BROWSER_DAILY_SECONDS`, `check-semantics.ts` |
| Embeddings | 2,000 texts per day, 10,000 vectors in total | `workers/indexer/src/handler.ts` |
| Vector queries | 1,000 query embeddings per day | `workers/agents/src/retrieval.ts` |
| Anthropic spend | `ANTHROPIC_MONTHLY_BUDGET_USD` per calendar month | `spend-meter.ts` |

A guard that trips stops further expensive work and keeps all state.
A concurrency limit applies backpressure. The work waits for a free slot.
A budget limit stops the work. The Task becomes `blocked`, and the Change becomes `budget_blocked` and names the exact limit.

## Scale

Core owns all strong state: the actors, the workflows, and the product database.
One process owns every actor, so single-writer ownership needs no lease.
The stack runs on one host. The actor host and the database are local to that host.

## Logs and metrics

- Each service writes one JSON line per log event to stdout. Docker keeps the logs. `bun run stack:logs` follows them.
- `METRICS` and `EVENT_METRICS` rows stay in `platform_metrics` for 30 days.
- `GET /v1/projects/:projectId/cost` reports the meters of a Project and of the stack (`workers/api/src/cost.ts`).
- Logs and metrics are the observability data. The stack has no trace collector.
