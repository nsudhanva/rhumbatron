# ADR 0005: Deploy Durable Object Workers with cloudflare_workers_script

## Context

For Worker deploys, Rhumbatron prefers `cloudflare_worker` + `cloudflare_worker_version` +
`cloudflare_workers_deployment`. Cloudflare rejects Durable Object class migrations
(`new_sqlite_classes`, renames, deletes) in version uploads. They need a full script deploy.

## Decision

- Workers that host Durable Object classes use `modules/durable-worker`, built on
  `cloudflare_workers_script` (full deploy, supports `migrations`). These are `rhumbatron-coordinator`
  (`ProjectRootDO`, `ResourceShardDO`, `ProjectViewDO`) and `rhumbatron-agents` (`AgentDO`).
- The api, web, event-router, integration, and indexer Workers use `modules/worker` (version and
  deployment). The docs Worker uses the same three resources in `envs/prod/docs.tf`, because it
  has no main module.
- Two Workers deploy through adapters that do full uploads: `rhumbatron-sandbox-prod` (ADR 0012)
  and `rhumbatron-apps-prod` (ADR 0020).
- Each migration is a transition from the live tag to the target tag. `old_tag` must equal the live
  tag, or Cloudflare rejects the upload (412, code 10079). The steady state is
  `old_tag = new_tag = v1` with no class changes. An applied tag never changes.
- `local.bootstrap` in `envs/prod` is `false`. When it is `true`, the coordinator has no
  `EVENT_ROUTER` binding (the event router binds the coordinator classes, so the binding makes a
  cycle), and the first upload uses `new_tag = "v1"` with the classes. A fresh root needs two
  applies.

## Consequences

- `cloudflare_workers_script` has no tags attribute. Durable Object Workers have name grouping only.
- Gradual rollout does not apply to Durable Object Workers. Each release is a full deploy.
- The module declares observability and compatibility flags in full, so the post-apply plan is
  clean.

## Diagram

Migration tags on a Durable Object Worker (`old_tag`, `new_tag`):

```mermaid
stateDiagram-v2
  [*] --> v1: fresh root, new_tag v1 with new_sqlite_classes
  v1 --> v1: steady state, old_tag v1 and new_tag v1
  v1 --> v2: add a class, old_tag v1 and new_tag v2 with new_sqlite_classes
  v1 --> rejected: old_tag differs from the live tag
  rejected: 412, code 10079
```

First apply of a fresh root (`local.bootstrap = true`), then the second apply:

```mermaid
flowchart TD
  k2["terraform_data.k2_streams, then data.external.k2_streams"] --> coord["coordinator (durable-worker)<br/>v1: ProjectRootDO, ResourceShardDO, ProjectViewDO<br/>no EVENT_ROUTER binding"]
  coord --> api["api (worker)"]
  coord --> router["event-router (worker)"]
  coord --> integ["integration (worker)"]
  sbx["terraform_data.sandbox_worker<br/>scripts/sandbox-deploy.ts (ADR 0012)"] --> agents["agents (durable-worker)<br/>v1: AgentDO"]
  coord --> agents
  router --> second["Second apply, local.bootstrap = false:<br/>coordinator gets EVENT_ROUTER, migrations v1 to v1"]
```
