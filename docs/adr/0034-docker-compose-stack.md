# ADR 0034: One Docker Compose stack on open-source backends

## Context

Rhumbatron runs on one computer, at no fixed monthly cost, with one command. The operator uses
it seldom. These requirements apply:

- It runs on a Mac with Docker Desktop (arm64) and on one Linux server.
- It needs no cloud account. The only paid service is the model provider (ADR 0021), with a
  monthly cap.
- The application code has these behaviors: actors with single-writer state, durable workflows,
  queues with retries and a dead-letter queue, an event log with replay, Git source with forks,
  isolated Sandboxes, and generated apps on their own subdomains.
- Each backing service is open source, maintained, and small at idle.

Six research passes (November 2026) compared the options for each function. The table gives the
choice and the main reason.

## Decision

| Function | Choice | Reason |
|---|---|---|
| Edge, TLS, routing | Caddy 2.11 (`local_certs`) | One container. Its local CA signs every `*.rhumbatron.localhost` host. Proxies WebSockets. |
| API, coordinator, agents, integration, event router, indexer | One Bun 1.4.4 process, the `core` service | One host. Calls between modules are in-process calls. Playwright `connect()` to the `browser` service needs Bun 1.4. The other Bun images and the repository toolchain use Bun 1.3.14. |
| Actors | The actor host in `packages/platform` | One instance per ID, one SQLite file per actor, persisted alarms with retries, input gates, hibernatable WebSockets. One process owns every actor, so single-writer needs no lease. |
| Durable workflows | The workflow engine in `packages/platform` | Replay with stored step results, retries with backoff, timeouts, sleeps and events, all in SQLite. |
| Queues and event log | NATS JetStream 2.15 (CNCF) | One 12 MB server. A work-queue stream for commands, eight limit streams for events, dedupe by ID, redelivery with delay, durable consumers. |
| Product database, key-value, vectors, metrics | SQLite through `bun:sqlite` in `core` | The SQL files in `migrations/d1` use the SQLite dialect. Vector search is exact and per Project. |
| Object storage | versitygw 1.10 (S3 gateway) | Apache-2.0, 15 MB, plain files on a volume. Core runs the object expiry by key prefix (`services/core/src/expiry.ts`). |
| Source repositories | The `git` service (Bun and the git CLI) | One bare repository per Project, Task fork or Candidate fork. Forks share objects through alternates. Smart HTTP with signed, scoped, expiring tokens. |
| Sandboxes | `sandboxd` with sibling containers | Works inside Compose on Docker Desktop. A socket proxy allows only the Engine calls it needs. Sandboxes sit on an internal network with an egress allowlist. |
| Generated apps | `workerd` (open source) with the Worker Loader | The apps router, builder, and checker run on it. Loaded apps have no network access. |
| Browser checks | Playwright 1.64.1 server, the `browser` service | One container. Core connects to `ws://browser:3000/` with `playwright-core` 1.64.1. Request interception sends the browser network only to the Candidate preview. |
| Embeddings and rerank | llama.cpp server, bge-small-en-v1.5 (384 dimensions) and bge-reranker-base | Small models, about 300 MB together. |
| Bounded routing questions (Clef) | Claude Haiku through a forced tool call | No open model has the same interface. The caller abstains when it cannot parse an answer. |
| Model calls | The Anthropic API, direct | The in-app meter reserves and settles each call. |
| Authentication | Clerk development instance | It accepts `rhumbatron.localhost`. |

The application code uses binding interfaces: SQL statements with `prepare().bind()`, bucket
objects, queue sends, actor stubs, and workflow steps. `packages/platform` implements them with the
backends above. `packages/platform/types/runtime.d.ts` holds the shared runtime interface types.
Each module has a tracked `src/bindings.d.ts` with the binding types that it compiles against.
`services/core/src/main.ts` builds one environment and gives it to every module in core.
`services/core/src/consumers.ts` holds the table of queue consumers. A Bun preload maps the
`cloudflare:workers` module specifier, which the code and the Agents SDK import, to the classes of
the platform.

Hostnames:

| Host | Service |
|---|---|
| `rhumbatron.localhost` | web; `/live/*` goes to core |
| `api.rhumbatron.localhost` | core |
| `docs.rhumbatron.localhost` | the docs site, served by Caddy |
| `<slug>.rhumbatron.localhost`, `<previewId>--<slug>.rhumbatron.localhost` | apps |

Network and restarts:

- The Compose `default` network has the subnet `172.31.240.0/24`.
- `core` has the fixed address `172.31.240.10`. workerd in `apps` resolves `core` once, at start.
- `apps` has `depends_on: core { condition: service_healthy, restart: true }`.

HTTPS:

- Caddy signs every `*.rhumbatron.localhost` host with its local CA. The CA is in the
  `caddy-data` volume.
- `bun run stack:trust` copies the root certificate to `.local-ca.crt`. On macOS, it adds the
  certificate to the login keychain as a trusted root, without `sudo`.
- `bun run stack:up` ends with `scripts/trust-local-ca.ts --check`, which reports the trust state.
- Bun and Node scripts use `NODE_EXTRA_CA_CERTS=.local-ca.crt`.

## Consequences

- `bun run stack:up` starts everything. Only model calls cost money, and the monthly cap limits
  them.
- Each service is one container. Core owns all strong state, so the stack runs on one host.
- The live socket authenticates with the Clerk session cookie. Core checks the Origin header, so
  another site cannot open the socket.
- Sandboxes run under `runc` on the Mac. On a Linux server, set `SANDBOX_RUNTIME=runsc` (gVisor).
- A `core` restart keeps its address, and Compose restarts `apps` with it.
- A `docker compose down -v` deletes the CA. Run `bun run stack:trust` again after it.
- Firefox reads the macOS keychain only when `security.enterprise_roots.enabled` is `true`.

## Alternatives

| Option | Reason for rejection |
|---|---|
| Rivet 3.0 | Four days old in November 2026. |
| Restate | BSL license. It keeps key-value state only. |
| Temporal, DBOS, Hatchet | Each needs Postgres. |
| Kafka, Redpanda | Too heavy for one host. |
| libSQL server | No versioned release since February 2025. |
| Forgejo, Gitea | Each stores a fork as a full repository. |
| MinIO | The project is archived. |
| Docker Sandboxes, E2B, microsandbox, Kata | Each needs a host hypervisor. |
| Daytona OSS, Soft Serve | Each project is archived. |
