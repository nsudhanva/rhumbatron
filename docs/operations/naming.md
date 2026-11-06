# Resource naming

Each name in the stack shows that it belongs to Rhumbatron. The Compose project name is `rhumbatron` (`compose.yaml`), so Docker prefixes its containers, volumes, and default network with `rhumbatron`.

## Services and images

| Kind | Names |
|---|---|
| Compose services | `edge`, `web`, `core`, `apps`, `git`, `nats`, `objects`, `browser`, `embed`, `rerank`, `sandbox-image`, `socket-proxy`, `egress`, `sandboxd` |
| Local images | `rhumbatron/sandbox:local` (the Sandbox image), `rhumbatron/sandboxd:local` (sandboxd and the egress proxy). Compose names the other built images after the project and the service. |
| Volumes | `caddy-data`, `caddy-config`, `core-data`, `apps-data`, `git-data`, `nats-data`, `objects-data`, `models` |
| Networks | `default`, `rhumbatron_sbx` (internal, Sandboxes), `rhumbatron_docker` (internal, sandboxd to the socket proxy) |
| Application modules in `core` | `SERVICE_NAME` is `rhumbatron-<module>`: `api`, `coordinator`, `agents`, `event-router`, `integration`, `indexer` |

## Data names

| Resource | Name |
|---|---|
| Product database | `rhumbatron.sqlite` in the `core-data` volume |
| Workflow database | `workflows.sqlite` in the `core-data` volume |
| Actor storage | `actors/<class>/<id>.sqlite` in the `core-data` volume |
| Object bucket | `rhumbatron-evidence` |
| Git namespace | `rhumbatron` |
| Project repository | The Project ID |
| Task, Candidate, and code edit session forks | `ws-*`, `cand-*`, `edit-*` |
| Command stream | `COMMANDS`, subjects `cmd.<queue>`, durable consumers `q-<queue>` |
| Command queues | `agent-wakeups`, `integration`, `verification`, `indexing`, `release`, `dead-letter` |
| Event streams | `EVENTS_00` to `EVENTS_07`, subjects `events.00` to `events.07` |
| Event subscriptions | `causal-router`, `project-view-projector`, `audit-archiver`, `analytics-projector` |
| Sandbox container | `rhumbatron-sbx-<id>`, label `rhumbatron.sandbox=<id>`. The ID of a Project's Sandbox is `proj-<project>`. |

## Guardrails

`bun run check:guardrails` (`scripts/check-guardrails.ts`) enforces two repository rules:

- Git never tracks a local secret file (`.env`, `.env.*`, `.dev.vars`), except an `.example` file.
- In a tracked Compose file, only the `socket-proxy` service mounts `/var/run/docker.sock`.
