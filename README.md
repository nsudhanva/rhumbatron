# Rhumbatron

> Rhumbatron is Git, CI, and a distributed task scheduler for autonomous software developers.

Many agents can propose many futures of one codebase. Only verified evidence can advance the
canonical state.

`AGENTS.md` is the authoritative build plan. `docs/BUILD_STATUS.md` tracks progress.
`docs/demo/runbook.md` is the demo sequence.

## Architecture

A user submits a goal for a Project. The Root Planner compiles it into a Work Graph of Tasks
(`ChangeWorkflow`), and the Causal Router wakes only the agents whose Tasks are ready. Each agent
(`AgentDO` with the Pi harness, models through AI Gateway) declares a typed Intent, works in an
Artifacts fork inside a capped Sandbox, and publishes a ChangeSet. Durable Objects own strong
state: `ProjectRootDO` holds the Canonical Generation, `ResourceShardDO` holds Claims and Intents,
`ProjectViewDO` holds the live view. Every mutation writes a transactional outbox row, published
to K2; the event router projects Events into the live view and archives them to R2. Semantic
conflicts between Intents fork Candidates. Each Candidate is composed and verified in the Sandbox
(build, tests, contract, Cart invariant, p95), with Evidence in D1 and R2. A verified Candidate,
with human approval when policy requires it, promotes through a compare-and-swap that advances
the Canonical Generation exactly once.

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Bun | 1.3.14 (`packageManager` in `package.json`) | `brew install oven-sh/bun/bun` |
| Terraform | >= 1.16 | `brew install hashicorp/tap/terraform` |
| tflint | latest | `brew install tflint` |
| gitleaks | latest | `brew install gitleaks` |

Wrangler is a dev dependency. Use the repository copy through `bunx wrangler`, for local
development and type generation only. Do not use a global install.

## Setup

```sh
bun install          # also installs Git hooks via lefthook
bun run typecheck
bun run build
bun run dev          # all apps and Workers locally
```

For the web app, copy `apps/web/.env.example` to `apps/web/.env.local` and fill the Clerk
development keys.

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
| `bun run typecheck` | Generate Worker types and run `tsc` everywhere. |
| `bun run lint` / `lint:fix` | Biome lint and format check. |
| `bun run test:critical` | Critical tests only: protocols, invariants, failure modes (no coverage target). |
| `bun run check` | Every local quality gate (lint, types, guardrails, fixtures, deps, secrets, Terraform). |
| `bun run check:guardrails` | Enforce the Terraform-only and no-`wrangler deploy` policy. |
| `bun run check:deps` | knip (unused code and dependencies) and sherif (monorepo hygiene). |
| `bun run check:secrets` | gitleaks scan of history and staged changes. |
| `bun run tf:check` | `terraform fmt`, `validate`, and tflint on every root. No remote access. |
| `bun run cf:bundle` | Build Worker bundles and `dist/bundles/manifest.json` for Terraform. |
| `bun run tf:plan:dev` / `tf:apply:dev` | Plan, then apply the saved dev plan. |
| `bun run tf:drift` | Post-apply plan that must show no changes. |
| `bun run smoke:dev` | Remote smoke check of dev (`--plan` and `--sandbox` variants: `smoke:plan`, `smoke:sandbox`). |
| `bun run demo:project` | Create or reuse the Acme Shop demo Project on dev. |
| `bun run inject` | Failure injection through the public dev API (`--sandbox` adds Candidate faults). |
| `bun run cost:report` | Read-only Cloudflare usage, spend, and leftover report. |

Remote scripts read their credentials from the macOS Keychain (see `package.json`).

## Deployment

Terraform is the only way to change Cloudflare. Never run `wrangler deploy`, the dashboard, or a
direct API write (one documented exception: ADR 0014).

```sh
bun run cf:bundle
bun run tf:plan:dev     # read the plan
bun run tf:apply:dev
bun run tf:drift
bun run smoke:dev
```

See `infrastructure/terraform/README.md`. Stay inside the Cloudflare free and included limits
(AGENTS.md section 7.3); pause dev compute with `locals.paused` in `envs/dev/main.tf`.

## CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`: install, lint, typecheck,
critical tests, build, Worker bundles, and Terraform `fmt -check` and `validate` with
`-backend=false`. It needs no secrets and never deploys.

## Git hooks

- pre-commit: Biome (auto-fix), gitleaks on staged changes, `terraform fmt`, guardrails.
- commit-msg: Conventional Commits through commitlint.
- pre-push: typecheck, dependency checks, Terraform checks.
