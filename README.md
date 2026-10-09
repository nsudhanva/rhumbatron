# Rhumbatron

> Rhumbatron is Git, CI, and a distributed task scheduler for autonomous software developers.

Many agents can propose many futures of one codebase. Only verified evidence can advance the canonical state.

`AGENTS.md` is the authoritative build plan. `docs/BUILD_STATUS.md` tracks progress. `docs/demo/runbook.md` is the demo sequence.

## Live Status

- Dev environment: `https://dev.rhumbatron.com`
- Dev API: `https://api-dev.rhumbatron.com`
- Production environment: Terraform in progress.

A real model-driven Change ran end to end on dev. The Root Planner and four agents on Gemini via Vertex (`MODEL_PROVIDER=vertex`) built shared wishlists on stacked workspaces. The Candidate composed automatically, passed build, 26 unit tests, contract tests, the Cart invariant check, p95 performance, and 9 authorization security tests. It was approved and promoted from S0 to S1. Model cost was about 0.91 USD.

## Architecture

A user submits a goal for a Project. The Root Planner compiles it into a Work Graph of Tasks (`ChangeWorkflow`). The Causal Router wakes only the agents whose Tasks are ready.

Each agent (`AgentDO` with the Pi harness, models through AI Gateway) declares a typed Intent, works in an Artifacts workspace inside a capped Sandbox, and publishes a ChangeSet.

Durable Objects hold authoritative state:
- `ProjectRootDO`: Holds Canonical Generation and compare-and-swap promotion.
- `ResourceShardDO`: Holds Claims and Intents.
- `ProjectViewDO`: Holds live read-model and socket state.

Every mutation writes a transactional outbox row published to K2. The event router projects Events into the live view and archives them to R2.

Deterministic conflict detection checks Intents on semantic resources. Model conflict review resolves ambiguous overlaps using Sonnet, with escalation to Opus. Conflicting paths fork into Candidates.

Each Candidate is composed and verified in the Sandbox (build, unit, contract, Cart invariant, p95, security). Verification Evidence is recorded in D1 and R2.

When required checks pass and policy approvals are granted, a compare-and-swap operation atomically promotes the winning Candidate and advances the Canonical Generation.

Reliability safeguards:
- Dead-letter consumer with Retry and Dismiss.
- Section 44 concurrency limits: 8 active agents, 4 Sandboxes per Change, 2 attempts per tier.
- Advisory Claims to avoid overlapping writes without rigid locking.

## UI Routes

- `/`: Projects list. Header includes notification bell.
- `/projects/<id>`: Project overview.
- `/changes/<id>`: Change details, acceptance criteria, invariants, candidates.
- `/changes/<id>/flight`: Flight Control (execution DAG, agent swimlanes, workspace lanes, codebase heatmap, candidate arena, preview wall, evidence explorer, decisions, events, time machine, command palette Cmd+K).
- `/candidates/<id>`: Candidate verification evidence, approval, promotion.
- `/compare/<changeId>`: Candidate comparison matrix.
- `/projects/<id>/{agents,events,verification,workspace,costs,graph}`: Dedicated project management and monitoring views.

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Bun | 1.3.14 (`packageManager` in `package.json`) | `brew install oven-sh/bun/bun` |
| Terraform | >= 1.16 | `brew install hashicorp/tap/terraform` |
| tflint | latest | `brew install tflint` |
| gitleaks | latest | `brew install gitleaks` |

Wrangler is a dev dependency. Use the repository copy through `bunx wrangler` for local development and type generation only. Do not use a global install.

## Setup

```sh
bun install          # installs dependencies and Git hooks via lefthook
bun run typecheck
bun run build
bun run dev          # runs all apps and Workers locally
```

For the web app, copy `apps/web/.env.example` to `apps/web/.env.local` and add Clerk development keys.

## Layout

```text
apps/web                 TanStack Start UI (rhumbatron.com)
workers/<name>           One Cloudflare Worker per directory, each with its own wrangler.jsonc
packages/                Shared logic: protocol (Zod schemas), evidence, conflict, model-router, ...
containers/coding-agent  Sandbox image
fixtures/                Demo Project source (Acme Shop) and its Wishlist designs
infrastructure/terraform Bootstrap, env roots (global, dev, prod), modules
migrations/d1            D1 SQL migrations (applied by Terraform)
docs/                    ADRs, protocols, operations, demo, build status
scripts/                 Bundle, checks, smoke, demo, failure injection, cost report
```

## Commands

| Command | Purpose |
|---|---|
| `bun run dev` | Run all apps and Workers locally. |
| `bun run build` | Build every package. |
| `bun run typecheck` | Generate Worker types and run `tsc` across workspaces. |
| `bun run lint` / `lint:fix` | Biome lint and format check. |
| `bun run test:critical` | Critical tests only: protocols, invariants, failure modes (no coverage target). |
| `bun run check` | Run all local quality gates (lint, types, guardrails, fixtures, deps, secrets, Terraform). |
| `bun run check:guardrails` | Enforce Terraform-only and no-`wrangler deploy` policy. |
| `bun run check:deps` | Run knip and sherif monorepo hygiene checks. |
| `bun run check:secrets` | Run gitleaks scan on history and staged changes. |
| `bun run tf:check` | Run `terraform fmt`, `validate`, and tflint on all roots without remote access. |
| `bun run cf:bundle` | Build Worker bundles and `dist/bundles/manifest.json` for Terraform. |
| `bun run tf:plan:dev` / `tf:apply:dev` | Plan and apply dev infrastructure. |
| `bun run tf:drift` | Post-apply plan that must show zero changes. |
| `bun run smoke:dev` | Remote smoke check of dev API and web flows. |
| `bun run smoke:sandbox` | Remote smoke check of Sandbox execution. |
| `bun run demo:project` | Create or reuse the Acme Shop demo Project on dev. |
| `bun run demo:wishlist` | Run the scripted Wishlist demo (Designs A vs B, conflict, verification, promotion). |
| `bun run inject` | Run failure injection against public dev APIs. |
| `bun run cleanup:projects` | Remove test projects and reset state. |
| `bun run cost:report` | Report Cloudflare usage, spend, and active resources. |

Remote scripts read credentials from the macOS Keychain.

## Deployment

Terraform is the only way to change Cloudflare control-plane configuration. Never run `wrangler deploy`, make manual dashboard edits, or issue direct REST writes (one documented exception: ADR 0014).

Dev deployment sequence:

```sh
bun run cf:bundle
bun run tf:plan:dev
bun run tf:apply:dev
bun run tf:drift
bun run smoke:dev
```

See `infrastructure/terraform/README.md`.

Cost controls:
- Rhumbatron runs on a shared Workers Paid account within included allowances.
- Sandbox is capped at 10 hours per month.
- Browser Run is capped at 500 seconds per day.
- Gemini on Vertex is capped by AI Gateway at 9 USD per 30 days.
- Dev compute can be paused via `locals.paused` in `infrastructure/terraform/envs/dev/main.tf`.
- Application release via Workers Builds (P11-07/08) is currently parked.

## CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`: install, lint, typecheck, critical tests, build, Worker bundles, and Terraform `fmt -check` and `validate` with `-backend=false`. It requires no secrets and does not deploy.

## Git hooks

- pre-commit: Biome (auto-fix), gitleaks on staged changes, `terraform fmt`, guardrails.
- commit-msg: Conventional Commits via commitlint.
- pre-push: typecheck, dependency checks, Terraform checks.
