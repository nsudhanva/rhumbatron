# Infrastructure and cost

This page explains how Terraform owns the Cloudflare control plane, and how the code keeps the bill inside free and included limits.

Main source files:

- `infrastructure/terraform/bootstrap`, `envs/global`, `envs/dev`, `envs/prod`, `modules/*`
- `scripts/tf.ts`, `scripts/build-workers.ts`, and the adapter scripts in `scripts/`
- `workers/coordinator/src/alarm-guard.ts`, `workers/event-router/src/causal.ts`, `workers/agents/src/limits.ts`
- ADR 0004 (bootstrap credentials), 0005 (DO Workers), 0006 (K2 adapter), 0012 (Sandbox Worker), 0017 (prod), 0019 (billing guards)

## Terraform roots and state

There are four roots.
`bootstrap` creates only the state bucket.
`global` owns account-wide and zone-wide singletons, so dev and prod never both manage the shared zone.
`dev` and `prod` each own one full environment.
All four keep state in one R2 bucket, with one key per root.

```mermaid
flowchart TB
  subgraph R2["R2 bucket rhumbatron-terraform-state-global"]
    KB["bootstrap/terraform.tfstate"]
    KG["global/terraform.tfstate"]
    KD["dev/terraform.tfstate"]
    KP["prod/terraform.tfstate"]
  end
  BOOT["bootstrap root<br/>creates the state bucket<br/>(prevent_destroy)"] --> KB
  GLOB["envs/global<br/>zone read, TLS settings,<br/>budget alerts"] --> KG
  DEV["envs/dev<br/>dev.rhumbatron.com,<br/>api-dev.rhumbatron.com"] --> KD
  PROD["envs/prod<br/>rhumbatron.com, www,<br/>api.rhumbatron.com"] --> KP
  TF["bun run tf root args<br/>(credentials from Keychain)"] --> BOOT
  TF --> GLOB
  TF --> DEV
  TF --> PROD
```

Rules:

- The backend is the S3 backend on R2 with `use_lockfile = true`.
- The first bootstrap apply used local state. The state then moved to R2 with `terraform init -migrate-state` (section 11.2).
- `scripts/tf.ts` loads secrets from the macOS Keychain for the one root that needs them. Values already in the environment take precedence.
- Provider: `cloudflare/cloudflare ~> 5.27`. Terraform `>= 1.16.0`.
- The zone `rhumbatron.com` is a data source. No plan can delete the domain.

### Modules per root

```mermaid
flowchart LR
  GLOB["envs/global"]
  ENV["envs/dev and envs/prod"]
  DNS["modules/dns<br/>zone data source"]
  SEC["modules/security<br/>zone TLS settings"]
  ST["modules/state<br/>R2 evidence, D1, KV"]
  AS["modules/async<br/>6 Queues"]
  AI["modules/ai<br/>AI Gateway"]
  WK["modules/worker<br/>api, web, event-router,<br/>integration, indexer"]
  DW["modules/durable-worker<br/>coordinator, agents"]
  DIRECT["Direct resources:<br/>3 cloudflare_workflow,<br/>6 cloudflare_queue_consumer,<br/>cloudflare_worker acme_shop"]
  PH["modules/code-storage,<br/>modules/observability<br/>(placeholders)"]
  GLOB --> DNS
  GLOB --> SEC
  ENV --> DNS
  ENV --> ST
  ENV --> AS
  ENV --> AI
  ENV --> WK
  ENV --> DW
  ENV --> DIRECT
  ENV -.-> PH
```

Two Worker modules exist (ADR 0005):

- `modules/worker` uses `cloudflare_worker`, `cloudflare_worker_version`, and `cloudflare_workers_deployment` at 100 percent, plus custom domains and cron triggers.
- `modules/durable-worker` uses `cloudflare_workers_script`, because Cloudflare rejects Durable Object migrations in version uploads. The steady state is migration tag `v1 -> v1`.

Prod mirrors dev resource for resource, with `-prod` names.
Prod also has Clerk DNS records, a Clerk key check, and a K2 account-limit precondition.
Operators update the two files together by hand.

### Temporary adapters

Provider 5.27 has no resource for K2 streams, Vectorize indexes, a container on a DO class, D1 schema migrations, or billing budget alerts.
Section 11.4 allows a `terraform_data` adapter as the last option.
Each adapter runs a Bun script, and only `terraform apply` can run it.
The shared API helper refuses to run unless `RHUMBATRON_INVOKED_BY=terraform`.

```mermaid
flowchart LR
  APPLY["terraform apply"] --> K2D["terraform_data.k2_streams"]
  APPLY --> VEC["terraform_data.vectorize_index<br/>(+ teardown on destroy)"]
  APPLY --> SBX["terraform_data.sandbox_worker<br/>(+ teardown on destroy)"]
  APPLY --> MIG["terraform_data.d1_migrations"]
  APPLY --> BUD["terraform_data.budget_alerts<br/>(global root)"]
  K2D --> S1["scripts/k2-sync.ts<br/>8 streams, 4 subscriptions"]
  VEC --> S2["scripts/vectorize-sync.ts<br/>384 dims, cosine"]
  SBX --> S3["scripts/sandbox-deploy.ts<br/>Worker + container app"]
  MIG --> S4["scripts/d1-migrate.ts<br/>unapplied files only"]
  BUD --> S5["scripts/budget-alerts.ts<br/>$10, $25, $100"]
  READ["data.external k2_streams<br/>scripts/k2-read.ts"] -->|"stream IDs"| BIND["EVENTS_NN bindings,<br/>K2_STREAM_IDS"]
```

Each adapter re-runs when its content hash changes.
The D1 migration adapter keys on the hash of every file in `migrations/d1`.
A teardown runs only on a real destroy, so a config change never deletes a live resource.

### Deployment loop

There is no deploy CI. `.github/workflows/ci.yml` runs checks only.
The project never uses `wrangler deploy`.

```mermaid
flowchart LR
  A["bun run cf:bundle"] --> B["dist/bundles/manifest.json<br/>(modules, sha256)"]
  B --> C["bun run tf:plan:dev<br/>-out=dev.tfplan"]
  C --> D["Read the plan"]
  D --> E["bun run tf:apply:dev"]
  E --> F["bun run tf:drift<br/>plan -detailed-exitcode"]
  F --> G["bun run smoke:dev"]
```

A new bundle hash creates a new Worker version (`modules/worker`) or a new full script upload (`modules/durable-worker`).
The same bundles serve dev and prod. Bindings carry the environment configuration.

## Cost guard layers

Cloudflare has no hard spend cap (ADR 0019).
The code stacks several independent guards, from the inner code paths out to the account.

```mermaid
flowchart TB
  L1["1. Durable Object alarms<br/>AlarmGuard: no work, no alarm,<br/>reschedule at least 1 s, backoff to 5 min,<br/>2,000 fires per object per day"]
  L2["2. Outbox retries<br/>max 10 attempts, backoff to 5 min,<br/>unbound stream fails at once"]
  L3["3. Causal caps<br/>1,000 commands per Change per day,<br/>Clef-flash 200 calls per day"]
  L4["4. Section 44 limits<br/>8 agents, 4 Sandboxes, 3 Candidates,<br/>2 attempts per tier, 2 browser runs"]
  L5["5. Queue and K2 bounds<br/>3 retries then dead-letter,<br/>K2 batch dead-lettered after 5 failures"]
  L6["6. Metered caps in D1<br/>Sandbox 5 h dev, 15 h prod per month,<br/>Browser 250 s per day,<br/>400 model calls per day,<br/>Anthropic $15 dev, $10 prod per month"]
  L7["7. AI Gateway<br/>20 requests per minute,<br/>Anthropic spend limit (best effort)"]
  L8["8. Account budget alerts<br/>email at $10, $25, $100"]
  L9["Pause switch<br/>locals.paused"]
  L1 --> L2 --> L3 --> L4 --> L5 --> L6 --> L7 --> L8
  L9 -.->|"stops cron and Sandbox starts"| L6
```

| Layer | Cap | Where |
|---|---|---|
| DO alarm guard | 2,000 fires per object per UTC day | `workers/coordinator/src/alarm-guard.ts` (ProjectRootDO, ResourceShardDO, AgentDO schedules) |
| Outbox | 10 publish attempts per row | `workers/coordinator/src/outbox.ts` |
| Causal router | 1,000 commands per Change per day | `workers/event-router/src/causal.ts` |
| Clef-flash | 200 calls per day, one `clef-flash` counter shared by the router and agent routing | `causal.ts`, `agent-do.ts` |
| Active agents | 8 per Change | `workers/agents/src/limits.ts` |
| Coding Sandboxes | 4 open per Change, 1 container instance | `limits.ts`, Terraform `max_instances` |
| Candidates | 3 per Change | `workers/integration/src/candidate-create.ts` |
| Attempts | 2 per Task per tier | `limits.ts` |
| Model calls | 16 or 32 per run, 400 per day | `packages/model-router/src/budget.ts` |
| Change budget | `budgetUsd`, default 3 USD, max 100 | `packages/protocol/src/project.ts` |
| Sandbox time | 18,000 s per month per environment | `SANDBOX_MONTHLY_SECONDS` binding |
| Browser Run | 250 s per day per environment, 55 s per session, 2 runs per Candidate | `BROWSER_DAILY_SECONDS` binding, `check-semantics.ts` |
| Embeddings | 2,000 texts per day, 10,000 vectors per account | `workers/indexer/src/handler.ts` |
| Vectorize queries | 1,000 per day | `workers/agents/src/retrieval.ts` |
| Anthropic spend | 15 USD dev, 10 USD prod per calendar month, reserve then settle on the D1 meter | `ANTHROPIC_MONTHLY_BUDGET_USD` binding, `packages/model-router/src/spend-meter.ts` |
| Account | Alerts at 10, 25, 100 USD | `envs/global` |

A guard that trips stops new expensive work and keeps all state.
A concurrency limit applies backpressure. The work waits for a free slot.
A budget limit stops the work. The Task becomes `blocked`, and the Change becomes `budget_blocked` with the exact limit named.

### How the approved caps split between environments

ADR 0017 split the approved budgets evenly between dev and prod. ADR 0021 split the $25 Anthropic budget unevenly.
Each Worker reads its share from a binding and meters it in its own D1 database.

```mermaid
pie showData
  title Anthropic budget per calendar month (USD)
  "dev" : 15
  "prod" : 10
```

```mermaid
pie showData
  title Sandbox hours per month
  "dev" : 5
  "prod" : 15
```

```mermaid
pie showData
  title Browser Run seconds per day
  "dev" : 250
  "prod" : 250
```

The two Browser Run shares add up to 500 s, below the free 10 minutes per day.
The two Sandbox shares add up to the approved 20 hours per month.

## Pause switch

Each environment has `locals.paused` in `envs/<env>/main.tf`.
To pause, set it to `true`.
Then plan and apply.
All data stays.

```mermaid
flowchart LR
  P["locals.paused = true"] --> C1["event-router cron_schedules = []<br/>no safety-net sweep"]
  P --> C2["Sandbox max_instances = 0<br/>no container starts"]
  C1 --> STILL["Still active:<br/>publish nudges deliver events,<br/>API requests, DO alarms (guarded)"]
  C2 --> STILL
```

The pause switch does not stop Durable Object alarms.
The alarm guard limits them (ADR 0019).
To resume, set `paused` to `false` and apply again.
See `docs/operations/pause-resume.md` for the full steps.
