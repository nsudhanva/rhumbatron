# ADR 0022: Every Project starts from an empty repository

## Status
Accepted, 2026-10-10. Replaces the template choice of ADR 0010 and the template parts of ADR 0020.

## Context
A Project created with the "empty" template got no Artifacts repository. Every agent tool then
answered "No source repository for this Project yet": file writes were lost, test Tasks failed
twice, the Change stopped at the attempt limit, and no live app was provisioned. The owner does
not want templates or prefilled files in the product.

## Decision
- A Project is a name and a slug. `POST /v1/projects` has no `template` field (an old field is
  ignored). The create form has no template choice.
- Every new Project gets an Artifacts repository with one commit that holds only `.gitignore`
  (`node_modules`). That commit is Canonical Generation 0. `project.provision` makes it.
- Seed rule (`workers/integration/src/source-seed.ts`, critical test): seed only when the
  canonical source is unassigned at Generation 0. ProjectRootDO `assignSource` enforces the same
  rule at the write. A repeat never changes a Project with source.
- Backfill: `POST /v1/projects/:id/provision` (no body) and `POST /v1/projects/:id/app` ("Deploy
  app", prod) both create the empty repository when the source is unassigned.
  `bun scripts/seed-repo.ts <projectId> <dev|prod> [--user <Clerk user ID or email>]` calls them.
- The app conventions are instructions, not files (`APP_CONVENTIONS` in
  `packages/protocol/src/app.ts`): a Worker with `src/worker.ts`, static files in `public/`,
  `package.json` scripts `typecheck`, `test`, `contract`, and `dev`, `scripts/contract.ts`
  printing `{"routes":[...]}`, at least one test, `env.DATA` for storage, and a fake identity
  only. The Root Planner and the Context Compiler both state them.
- The Root Planner sees the canonical file list. For an empty repository (no root
  `package.json`), t1 must be an implement bootstrap Task and every other Task must depend on it.
  Application code checks this and asks for one repair turn.
- Verification on the first Change: the contract check treats a base without `package.json` as
  "no contract yet" and passes when the Candidate prints a valid route table. A missing Candidate
  table stays a gap. The browser check runs a generic flow (home page text, `GET /api/health`)
  for apps that are not the Acme Shop fixture.
- Live app: for a tree with no code file, the production row is `ready` with no bundle. The
  router answers 200 "Nothing built yet. Tell Rhumbatron what to make." The first release moves
  the pointer to a bundle.
- The Acme Shop fixture stays for internal demo and smoke scripts only:
  `POST /v1/fixtures/projects` (404 where fixtures are off).
- Goal suggestions: `GET /v1/projects/:id/suggestions`. Clef is a choice model and cannot write
  text, so `clef-flash` ranks a fixed list of short goals ("start" goals for a repository with no
  code, "extend" goals otherwise) from the Project name, up to 200 file paths, and the last 5
  goals. The top 4 show as pills under the goal box; a click fills the box. Cached per Project and
  Canonical Generation in D1 (`goal_suggestions`, migration 0020); at most 100 calls per day
  (`usage_counters` `goal-suggestions`). No pills when the cap is reached or the call fails.

## Consequences
- Agents always have a repository to write to. A blank Project's first Change must build the app
  in the conventions' shape, or the build, unit, and contract checks fail.
- Each new Project costs a few Artifacts operations at creation, also scratch and smoke Projects.
  Archive cleanup deletes the repository.
- Rolling back to Generation 0 of a blank Project builds an empty tree, which fails the build;
  the release is then recorded as failed and the pointer does not move.
