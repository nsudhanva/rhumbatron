# ADR 0034: One Docker Compose stack on open-source backends

## Context

Rhumbatron must run on one computer, at no fixed monthly cost, with one command. The operator
uses it seldom. These requirements apply:

- It runs on a Mac with Docker Desktop (arm64) and on one Linux server.
- It needs no cloud account. The only paid service is the model provider (ADR 0021), with a
  monthly cap.
- The application code keeps its behavior: actors with single-writer state, durable workflows,
  queues with retries and a dead-letter queue, an event log with replay, Git source with forks,
  isolated sandboxes, and generated apps on their own subdomains.
- Each backing service is open source, maintained, and small at idle.

Six research passes (November 2026) compared candidates for each function. The table gives the
choice and the main reason.

## Decision

| Function | Choice | Reason |
|---|---|---|
| Edge, TLS, routing | Caddy 2.11 (`local_certs`) | One container. Wildcard certificate from its own CA. Proxies WebSockets. |
| API, coordinator, agents, integration, event router, indexer | One Bun process, the `core` service | One host. Calls between services are in-process calls. |
| Actors | The actor host in `packages/platform` | One instance per ID, one SQLite file per actor, persisted alarms with retries, input gates, hibernatable WebSockets. One process owns every actor, so single-writer needs no lease. |
| Durable workflows | The workflow engine in `packages/platform` | Replay with stored step results, retries with backoff, timeouts, sleeps and events, all in SQLite. |
| Queues and event log | NATS JetStream 2.15 (CNCF) | One 12 MB server. A work-queue stream for commands, eight limit streams for events, dedupe by ID, redelivery with delay, durable consumers. |
| Product database, key-value, vectors, metrics | SQLite through `bun:sqlite` in `core` | The SQLite dialect of the 40 migrations stays. Vector search is exact and per Project. |
| Object storage | versitygw 1.10 (S3 gateway) | Apache-2.0, 15 MB, plain files on a volume. MinIO is archived. |
| Source repositories | The `git` service (Bun and the git CLI) | One bare repository per Project, Task fork or Candidate fork. Forks share objects through alternates. Smart HTTP with signed, scoped, expiring tokens. |
| Sandboxes | `sandboxd` with sibling containers | Works inside Compose on Docker Desktop. A socket proxy allows only the Engine calls it needs. Sandboxes sit on an internal network with an egress allowlist. |
| Generated apps | `workerd` (open source) with the Worker Loader | The apps router, builder and checker run unchanged. Loaded apps have no network. |
| Browser checks | Playwright 1.64 server | One container. Core connects over WebSocket. |
| Embeddings and rerank | llama.cpp server, bge-small-en-v1.5 (384 dimensions) and bge-reranker-base | The same models, about 300 MB together. |
| Bounded routing questions (Clef) | Claude Haiku through a forced tool call | No open model has the same interface. The caller abstains when it cannot parse an answer. |
| Model calls | The Anthropic API, direct | The in-app meter already reserves and settles each call. |
| Authentication | Clerk development instance | It accepts `rhumbatron.localhost`. |

The application code keeps its binding interfaces: SQL statements with `prepare().bind()`,
bucket objects, queue sends, actor stubs, workflow steps. `packages/platform` implements them
with the backends above. `services/core/src/main.ts` builds one environment and gives it to every
service. A Bun preload maps the runtime module that the code and the Agents SDK import to the
platform's classes.

Hostnames:

| Host | Service |
|---|---|
| `rhumbatron.localhost` | web; `/live/*` goes to core |
| `api.rhumbatron.localhost` | core |
| `docs.rhumbatron.localhost` | the docs site, served by Caddy |
| `<slug>.rhumbatron.localhost`, `<previewId>--<slug>.rhumbatron.localhost` | apps |

## Consequences

- `bun run stack:up` starts everything. Nothing bills except model calls, which the monthly cap
  limits.
- Each service is one container. Core owns all strong state, so the stack does not scale past one
  host without a change to the actor host and the database.
- The live socket authenticates with the Clerk session cookie. Core checks the Origin header, so
  another site cannot open the socket.
- Sandboxes run under `runc` on the Mac. On a Linux server, set `SANDBOX_RUNTIME=runsc` (gVisor).
- The rejected options and their reasons:
  - Rivet 3.0 was four days old.
  - Restate is BSL and keeps key-value state only.
  - Temporal, DBOS and Hatchet need Postgres.
  - Kafka and Redpanda are too heavy for one host.
  - libSQL server has had no versioned release since February 2025.
  - Forgejo and Gitea store forks as full repositories.
  - Docker Sandboxes, E2B, microsandbox and Kata need a host hypervisor.
  - Daytona OSS and Soft Serve are archived.
