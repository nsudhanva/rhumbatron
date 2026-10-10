# Tech stack

This page lists every technology that Rhumbatron uses today and what each one does.
It comes from the code, the `wrangler.jsonc` files, the `package.json` files, `bun.lock`, and the Terraform roots, not from `AGENTS.md`.
Versions are the pinned versions of 2026-10-10.

Status values:

- **In use**: the code runs it on dev and prod.
- **Dev only**: the dev environment has it, prod does not.
- **Prod only**: the prod environment has it, dev does not.
- **Deferred**: a decision or code path exists, but nothing runs it.
- **Not built**: `AGENTS.md` names it, and the repository has no code for it.

## How the parts connect

Solid arrows are service bindings, Durable Object bindings, or direct calls.
Dotted arrows are Queue messages or K2 records.

```mermaid
flowchart LR
  USER["Browser"] --> WEB["web (TanStack Start)"]
  USER --> APPS["apps (Dynamic Workers)"]
  WEB --> API["api (Hono)"]
  API --> COORD["coordinator<br/>ProjectRootDO, ResourceShardDO,<br/>ProjectViewDO"]
  API --> INT["integration<br/>3 Workflows"]
  API --> AG["agents<br/>AgentDO + Pi"]
  COORD -.->|"K2 EVENTS_00..07"| ER["event-router"]
  ER -.->|"Queues"| AG
  ER -.->|"Queues"| INT
  ER -.->|"Queues"| IDX["indexer"]
  AG --> SBX["sandbox (container)"]
  INT --> SBX
  AG --> GW["AI Gateway"]
  INT --> GW
  GW --> ANT["Anthropic"]
  ER --> WAI["Workers AI<br/>Clef-flash"]
  IDX --> WAI
  IDX --> VEC[("Vectorize")]
  AG --> VEC
  AG --> ART[("Artifacts")]
  INT --> ART
  INT --> BR["Browser Run"]
  API --> D1[("D1")]
  INT --> D1
  INT --> R2[("R2")]
  INT --> KV[("KV CONFIG")]
  APPS --> R2
  APPS --> D1
```

## Web

| Technology | Used for | Where | Status |
|---|---|---|---|
| TanStack Start 1.168, Router 1.170 | Server-rendered React app and routes | `apps/web` | In use |
| React 19.3, Vite 8.3 | UI runtime and build | `apps/web` | In use |
| `@cloudflare/vite-plugin` 1.63 | Builds the web app as a Worker | `apps/web/vite.config.ts` | In use |
| Tailwind CSS 4.3 | Styling | `apps/web` | In use |
| `@cloudflare/kumo` 2.14 | Components (87 files import it) | `apps/web/src/components` | In use |
| TanStack Query 5.104 | Server state and polling of API reads | `apps/web/src` (31 files) | In use |
| Zustand 5.0 | Small client state (the flight view store) | `apps/web/src/components/flight/flight-store.ts` | In use |
| XYFlow (`@xyflow/react` 12.12) | Work Graph, DAG panel, and Product Graph canvas | `work-graph.tsx`, `product-graph-canvas.tsx` | In use |
| Phosphor icons, Fontsource Archivo | Icons and the font | `apps/web` | In use |
| Recharts | Charts | Not a dependency | Not built |

## API and auth

| Technology | Used for | Where | Status |
|---|---|---|---|
| Hono 4.13 | Public product API, body limits, validation | `workers/api` | In use |
| Zod 4.6 | Protocol schemas and request validation | `packages/protocol`, every Worker | In use |
| Clerk (`@clerk/backend` 3.23, `@clerk/tanstack-react-start` 1.7) | User sign-in and token check (ADR 0002). Prod uses a Clerk production instance, dev a development instance | `workers/api`, `apps/web` | In use |

## Coordination and events

| Technology | Used for | Where | Status |
|---|---|---|---|
| Durable Objects with SQLite | `ProjectRootDO` (Canonical State and CAS), `ResourceShardDO` (Claims, Intents, outbox), `ProjectViewDO` (live read model) | `workers/coordinator` | In use |
| Transactional outbox in DO SQLite | Atomic state change plus Event | `workers/coordinator/src/outbox.ts` | In use |
| K2 | Durable Event log: 8 streams, 4 subscriptions, 7-day retention. Terraform creates it through a temporary adapter (ADR 0006) | `workers/event-router`, `scripts/k2-sync.ts` | In use |
| Queues | Commands: agent wake-ups, integration, verification, indexing, release, dead letter | `workers/event-router`, `workers/integration`, `workers/agents` | In use |
| Workflows | `ChangeWorkflow`, `CandidateVerificationWorkflow`, `ReleaseWorkflow` | `workers/integration` | In use |
| Cron Triggers | Event router sweep every minute. Once a day the same tick queues fork and Project cleanup. The `paused` switch turns it off | `workers/event-router` | In use |
| Service bindings and DO RPC | Internal calls between Workers | every `wrangler.jsonc` | In use |

## Agents and models

| Technology | Used for | Where | Status |
|---|---|---|---|
| Agents SDK (`agents` 0.27) | `AgentDO` base class and `PiHarness` | `workers/agents/src/agent-do.ts` | In use |
| Pi (`@earendil-works/pi-durable` 1.1, `pi-ai` 1.1) | Durable model and tool loop, behind `AgentRuntime` | `workers/agents/src` | In use |
| AI Gateway `rhumbatron-models-<env>` | Proxy for every Anthropic call, with logs and a request rate limit | `infrastructure/terraform/modules/ai` | In use |
| Anthropic (Claude Haiku 5.5, Sonnet 5.5, Opus 5.5) | Root Planner, Agents, conflict review, compaction. See the routing table below | `packages/model-router` | In use |
| `@anthropic-ai/sdk` 0.129 | Client for `complete()` calls (Root Planner, conflict review, compaction) through the gateway | `packages/model-router` | In use |
| Workers AI, Clef-flash | Cheap bounded decisions: ambiguous wake-ups, goal suggestion pills, model route when rules end at `default` | `workers/event-router/src/causal.ts`, `workers/agents/src/suggestions.ts` | In use |
| Workers AI, `bge-small-en-v1.5` | 384-dimension embeddings for Vectorize | `workers/indexer`, `workers/agents/src/retrieval.ts` | In use |
| Clef (the larger model) | Richer bounded decisions | Defined in `decision.ts`, no caller | Deferred |
| Jev | Decision adapter | Only a code comment, no adapter | Not built |
| Context Compiler | Deterministic Context Packet | `packages/context-compiler` | In use |
| Causal Router | Deterministic wake-up decision | `packages/causal-router` | In use |
| Conflict detector | Overlap and compatibility rules | `packages/conflict` | In use |

## Execution and verification

| Technology | Used for | Where | Status |
|---|---|---|---|
| Cloudflare Sandbox (`@cloudflare/sandbox` 0.12.6) | Linux shell for agents and Candidate checks. One container instance, 2-minute sleep, hour caps | `workers/sandbox`, `workers/agents`, `workers/integration` | In use |
| Containers (image `docker.io/cloudflare/sandbox:0.12.6`) | Runs the Sandbox. Terraform deploys it through a temporary adapter (ADR 0012) | `scripts/sandbox-deploy.ts` | In use |
| Browser Run (`@cloudflare/puppeteer` 1.4) | Browser check of a Candidate, with a daily seconds cap | `workers/integration/src/browser-check.ts` | In use |
| Bun test and project checks | Build, test, contract, security, performance, and invariant checks inside the Sandbox | `workers/integration` | In use |
| `@rhumbatron/evidence` | Coverage states and citation validation | `packages/evidence` | In use |
| Dynamic Workers (Worker Loader, `@cloudflare/worker-bundler` 0.2.6) | Run the generated app of a Project at `<slug>.rhumbatron.com` (ADR 0020) | `workers/apps` | Prod only |
| Workers Builds | Release of the Acme Shop Live Worker. Legacy path (ADR 0018) | `workers/integration/src/release.ts` | Dev only |

## Storage

| Technology | Used for | Where | Status |
|---|---|---|---|
| Artifacts | Source of every Project: canonical repo, Task forks, Candidate forks (namespace `rhumbatron-projects-<env>`) | `workers/agents`, `workers/integration`, `workers/indexer` | In use |
| `isomorphic-git` 1.43, `memfs` 4.80 | Read and write Artifacts repos inside Workers | `workers/integration`, `workers/agents`, `workers/indexer` | In use |
| D1 `rhumbatron-control-<env>` | Product metadata, receipts, counters, app pointers. SQL migrations in `migrations/d1` | `agents`, `api`, `apps`, `event-router`, `indexer`, `integration` | In use |
| R2 `rhumbatron-evidence-<env>` | Evidence, context snapshots, indexes, event archive, app bundles | most Workers | In use |
| KV `rhumbatron-config-<env>` | 5-minute cache of the Project policy (`CONFIG`). D1 is the source of truth | `workers/integration/src/policy.ts` | In use |
| Vectorize `rhumbatron-memory-<env>` | Semantic retrieval after exact lookup (ADR 0003). Terraform creates it through an adapter | `workers/indexer`, `workers/agents/src/retrieval.ts` | In use |
| `@babel/parser` 8.0 | Symbol index of changed files | `workers/indexer` | In use |

## Observability

| Technology | Used for | Where | Status |
|---|---|---|---|
| Workers Logs | Runtime logs. `observability.enabled` is on for every Worker | every `wrangler.jsonc` | In use |
| Analytics Engine | Model calls, Event metrics, wake-ups (`METRICS`, `EVENT_METRICS`) | `workers/agents`, `workers/indexer`, `workers/event-router` | In use |
| AI Gateway logs | Model request logs and cost | AI Gateway | In use |
| OpenTelemetry traces | Tracing | Traces are off. No exporter | Not built |
| `scripts/cost-report.ts`, `scripts/budget-alerts.ts` | Usage report and account budget alerts | `scripts` | In use |

## Infrastructure

| Technology | Used for | Where | Status |
|---|---|---|---|
| Terraform (Cloudflare provider `~> 5.27`, `external` `~> 2.4`) | Every remote Cloudflare change. Three roots: `envs/global`, `envs/dev`, `envs/prod` | `infrastructure/terraform` | In use |
| R2 remote state | Terraform state backend | `backend.hcl` per root | In use |
| `terraform_data` adapters | K2, Vectorize, Sandbox Worker, apps Worker, D1 migrations, budget alerts (temporary, ADR 0006, 0003, 0012) | `scripts/*.ts` | In use |
| Cloudflare DNS | `rhumbatron.com`, `dev`, `api`, `docs`, wildcard for apps, Clerk records | `modules/dns`, `envs/prod` | In use |
| Zone settings | HTTPS, TLS 1.3, strict SSL | `modules/security` | In use |
| WAF, rate limits, Turnstile, Access | Edge protection | `modules/security` is a stub for these | Not built |
| Wrangler 4.149 | Local development, type generation, bundling only | `apps/*`, `workers/*` | In use |
| Pause switch | `locals.paused` stops crons and container work | `envs/dev`, `envs/prod` | In use |

## Tooling and docs

| Technology | Used for | Where | Status |
|---|---|---|---|
| Bun 1.3.14 | Package manager, workspaces, script runner | root `package.json` | In use |
| TypeScript 7.0.2 | Language and typecheck | all packages | In use |
| Turborepo 2.11 | Task runner for build, typecheck, tests | `turbo.json` | In use |
| Biome 2.5 | Lint and format | `biome.json` | In use |
| Vitest 5.0 | Critical tests (`*.critical.test.ts`) | packages and Workers | In use |
| Knip 6.40, Sherif 1.13 | Unused code and dependency checks | `bun run check:deps` | In use |
| Lefthook 2.2, commitlint 21 | Pre-commit, commit-msg, and pre-push hooks | `lefthook.yml` | In use |
| Gitleaks | Secret scan in the hook and `bun run check:secrets` | `lefthook.yml` | In use |
| `scripts/check-guardrails.ts` | Enforces Terraform-only and no `wrangler deploy` | `scripts` | In use |
| GitHub Actions | One `ci` workflow: lint, typecheck, critical tests, build, bundle, Terraform validate. It never deploys | `.github/workflows/ci.yml` | In use |
| Astro 7.3, Starlight 0.42, Mermaid 12.1 | This documentation site at `docs.rhumbatron.com` | `apps/docs` | Prod only |
| Playwright | Local browser tests | Not a dependency | Not built |

## Model routing today

`routeByRules` in `packages/model-router/src/rules.ts` picks the tier.
`resolveTier` then maps the tier to a model.
ADR 0021 sets `ALLOW_OPUS` to `false` on dev and prod, so every opus decision runs on Sonnet and the receipt records `opus_disabled`.

| Work | Tier chosen | Model that runs | Source |
|---|---|---|---|
| Root Planner (`plan`, large) | opus | `claude-sonnet-5-5` | `workers/integration/src/root-planner.ts` |
| Destructive migration, design conflict across resources | opus | `claude-sonnet-5-5` | `rules.ts` |
| Normal implementation (medium) and the default | sonnet | `claude-sonnet-5-5` | `rules.ts` |
| Large child implementation | sonnet | `claude-sonnet-5-5` | `rules.ts` |
| Billing and non-trivial authorization floor | sonnet at least | `claude-sonnet-5-5` | `rules.ts` |
| Conflict review and request comparison | sonnet, then opus | `claude-sonnet-5-5` | `workers/agents/src/conflict-review.ts` |
| Small, low-risk first attempt, and summarize, classify, compact, transform | haiku | `claude-haiku-5-5` | `rules.ts` |
| Context compaction of long failure logs | haiku | `claude-haiku-5-5` | `workers/agents/src/context-compaction.ts` |
| Ambiguous wake-up, goal suggestion pills | Clef-flash | `@cf/cloudflare/clef-flash` | `workers/event-router/src/causal.ts` |
| Release authorization | No model | Deterministic policy | `workers/integration/src/release-model.ts` |

Thinking effort is low for haiku, medium for sonnet, and high for opus.
Output caps are 4,000 tokens for haiku and 8,000 for sonnet and opus.
Two failures at one tier escalate the Task one tier.
The caps are 400 agent model calls per day and a monthly Anthropic budget of 15 USD on dev and 10 USD on prod.

## Planned in AGENTS.md but not in use

- Clef (the larger model): the client supports it, and no code path asks it a question.
- Jev: no adapter exists.
- Recharts: not installed.
- OpenTelemetry tracing: off.
- WAF, rate-limit, Turnstile, and Access resources: `modules/security` holds only zone settings.
- Playwright: not installed. Browser Run covers browser checks.
- Terraform modules `code-storage` and `observability`: empty placeholders. The Worker and Durable Worker modules hold those bindings.
- Workers Builds through Terraform: the provider has no resource, so a person made the one connection (ADR 0014, 0018).
- GitHub Actions deploy and Terraform plan workflows: only `ci.yml` exists.

## Differences from AGENTS.md section 5

| AGENTS.md says | The code does |
|---|---|
| Claude Opus 5.5 plans and arbitrates | Sonnet 5.5 does this while `ALLOW_OPUS` is `false` (ADR 0021) |
| Model providers: Anthropic or OpenAI | Anthropic only. OpenRouter and Gemini on Vertex AI ran earlier (ADR 0007, 0016) and are removed |
| Seven deployables | Nine Workers: the seven, plus `rhumbatron-sandbox` (ADR 0012) and `rhumbatron-apps` (ADR 0020, prod). The docs site is a tenth, assets-only Worker |
| First-party Terraform resources for new products | Temporary `terraform_data` adapters for K2, Vectorize, the Sandbox Worker, and the apps Worker |
| Workers Builds releases every Project | Dynamic Workers release every Project on prod. Workers Builds serves only Acme Shop Live on dev (ADR 0018, 0020) |
| Vectorize index in Phase 1 | Created in Phase 7 through an adapter (ADR 0003). Embeddings are 384-dimension `bge-small-en-v1.5` |
| New Projects start from a template | Every Project starts from an empty repository (ADR 0022) |
| Clerk for authentication | Clerk is in use. Prod uses a production instance |
| Component library and charts: kumo and Recharts | kumo is in use. Recharts is not |
| Several GitHub Actions workflows | One `ci.yml`. Deployment stays local through Terraform |
| Pi agent loop through `AgentRuntime` | Pi runs through `PiHarness` of the Agents SDK inside `AgentDO` |
