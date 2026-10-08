# Rhumbatron

A new way for hundreds of thousands of agents to work concurrently.

> Rhumbatron is Git, CI, and a distributed task scheduler for autonomous software developers.

`AGENTS.md` is the authoritative build plan. `docs/BUILD_STATUS.md` tracks progress.

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Bun | >= 1.3.14 | `brew install oven-sh/bun/bun` |
| Terraform | >= 1.16 | `brew install hashicorp/tap/terraform` |
| tflint | latest | `brew install tflint` |
| gitleaks | latest | `brew install gitleaks` |

Wrangler is a dev dependency. Use the repository copy through `bunx wrangler`. Do not use a global install.

## Setup

```sh
bun install          # also installs Git hooks via lefthook
bun run typecheck
bun run build
```

## Layout

```text
apps/web                 TanStack Start UI (rhumbatron.com)
workers/<name>           One Cloudflare Worker per directory, each with its own wrangler.jsonc
packages/protocol        Shared Zod schemas (events, commands, core types)
containers/coding-agent  Sandbox image (Phase 8)
infrastructure/terraform Bootstrap, env roots (dev, prod), modules
migrations/d1            D1 SQL migrations
docs/                    ADRs, protocols, operations, demo, build status
scripts/                 Bundle, guardrail, and Terraform check scripts
```

## Commands

| Command | Purpose |
|---|---|
| `bun run dev` | Run all apps and Workers locally. |
| `bun run build` | Build every package. |
| `bun run typecheck` | Generate Worker types and run `tsc` everywhere. |
| `bun run lint` / `lint:fix` | Biome lint and format check. |
| `bun run check` | Every local quality gate (lint, types, guardrails, deps, secrets, Terraform). |
| `bun run check:secrets` | gitleaks scan of the working tree. |
| `bun run check:guardrails` | Enforce the Terraform-only and no-`wrangler deploy` policy. |
| `bun run check:deps` | knip (unused code and dependencies) and sherif (monorepo hygiene). |
| `bun run tf:check` | `terraform fmt`, `validate`, and tflint on every root. No remote access. |
| `bun run cf:bundle` | Build Worker bundles and `dist/bundles/manifest.json` for Terraform. |

## Git hooks

- pre-commit: Biome (auto-fix), gitleaks on staged changes, `terraform fmt`, guardrails.
- commit-msg: Conventional Commits through commitlint.
- pre-push: typecheck, dependency checks, Terraform checks.

## Deployment

Terraform is the only way to change Cloudflare. Never run `wrangler deploy`. See
`infrastructure/terraform/README.md`.
