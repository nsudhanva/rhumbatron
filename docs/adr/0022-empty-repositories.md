# ADR 0022: Every Project starts from an empty repository

## Context

Agent tools need a repository to write to. A Project without an Artifacts repository gives agents
no place for files. Its test Tasks fail, and no live app can start. The product has no templates and no
prefilled files.

## Decision

- A Project is a name and a slug. `POST /v1/projects` has no `template` field (the API ignores
  unknown fields). The create form has no template choice.
- Each Project gets an Artifacts repository with one commit that holds only `.gitignore`
  (`node_modules`). That commit is Canonical Generation 0. `project.provision` makes it.
- Seed rule (`workers/integration/src/source-seed.ts`, critical test): seed only when the
  canonical source is unassigned at Generation 0. ProjectRootDO `assignSource` enforces the same
  rule at the write. A repeat never changes a Project that has source.
- Backfill: `POST /v1/projects/:id/provision` (no body) and `POST /v1/projects/:id/app` ("Deploy
  app", prod) both create the empty repository when the source is unassigned.
  `bun scripts/seed-repo.ts <projectId> prod [--user <Clerk user ID or email>]` calls them.
- The app conventions are model instructions (`APP_CONVENTIONS` in
  `packages/protocol/src/app.ts`), and they add no files. They ask for these items:
  - a Worker with `src/worker.ts` and a Hono app from `src/app.ts`;
  - static files in `public/`;
  - the `package.json` scripts `typecheck`, `test`, `contract`, and `dev`;
  - a `scripts/contract.ts` that prints `{"routes":[...]}`;
  - at least one test;
  - `env.DATA` for storage;
  - a fake identity only.

  The Root Planner and the Context Compiler both give the conventions to the model.
- The Root Planner sees the canonical file list. For an empty repository (no root
  `package.json`), t1 must be an implement bootstrap Task, and every other Task must depend on it.
  Application code checks this and asks for one repair turn when the plan breaks the rule.
- Verification of the first Change: the contract check treats a base without `package.json` as a
  base with no contract. It passes when the Candidate prints a valid route table. A missing
  Candidate table is a gap. The browser check runs a generic flow (home page text,
  `GET /api/health`).
- Live app: for a tree with no code file, the production row is `ready` with no bundle. The
  router answers 200 "Nothing built yet. Tell Rhumbatron what to make." The first release moves
  the pointer to a bundle.
- Goal suggestions (`GET /v1/projects/:id/suggestions`, `workers/agents/src/suggestions.ts`).
  Clef is a choice model and cannot write text. So `clef-flash` ranks a fixed list of short goals
  ("start" goals for a repository with no code, "extend" goals for other repositories). The inputs
  are the Project name, up to 200 file paths, and the last 5 goals. The top 4 goals show as pills
  under the goal box. A click puts the goal in the box. D1 caches the result per Project and
  Canonical Generation (`goal_suggestions`, migration 0020). The cap is 100 calls per UTC day
  (`usage_counters` `goal-suggestions`). When the cap is reached or the call fails, no pills show.

## Consequences

- Agents always have a repository to write to. A blank Project's first Change must build the app
  in the conventions' shape, or the build, unit, and contract checks fail.
- Each Project costs a few Artifacts operations at creation. This includes scratch and smoke
  Projects.
  Archive cleanup deletes the repository.
- A rollback to Generation 0 of a blank Project builds an empty tree, and the build fails. The
  release is `failed`, and the pointer does not move.
