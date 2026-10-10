# Phase 16 plan: Live Apps

Status: draft for review, 2026-10-10. Nothing in this plan is built yet.

## 1. Goal

Every Project is a live application on Cloudflare.

A user can:

1. Create a Project. Rhumbatron deploys its first version at once.
2. Give instructions. Each instruction is a Change.
3. Open a preview of every Candidate before it ships.
4. Ship. A promoted Candidate becomes the live version.
5. Roll back to any earlier version.
6. Read the code at any version, and see what each agent changed.
7. Edit a file. The edit goes through the same checks as agent work.
8. Remove the app.

This makes the "next GitHub" story complete. The familiar parts are the repo, diffs, pull requests, checks, merge and deploy. The new parts are many agents, semantic conflicts, candidate futures and evidence-gated merge.

## 2. Where we stand

| Capability | Status today |
|---|---|
| Change, Work Graph, agents, conflicts, Candidates, checks | Works |
| Approval gate, compare-and-swap promotion, auto-promotion for low risk | Works |
| Deploy after promotion | Works for one hand-wired Project (Workers Builds, Acme Shop Live on dev) |
| Deploy for any Project | Missing |
| Preview per Candidate | Missing |
| Rollback | Missing (the protocol says "rollback is a new canonical transition", section 21.3) |
| Remove app | Missing (archive deletes source, but there is no app) |
| Read code at a version | Missing (Workspace page lists file paths only) |
| Diff per ChangeSet and per Candidate | Missing |
| Human edit of a file | Missing |

## 3. Decision: Dynamic Workers

Use **Dynamic Workers** (the Worker Loader binding). One router Worker serves every app. It loads the app code for the requested version into an isolate on demand.

Why:

- It is in the frozen stack (AGENTS.md section 5.3, "Dynamic Workers or Code Mode").
- It is on our Workers Paid plan. No new product, no new subscription.
- It needs no Worker per Project, no build token, and no dashboard step.
- Deploy is "write a bundle, move a pointer". It is fast and atomic.
- Previews come free: a Candidate commit is one more version id.
- Isolation is built in: no network by default (`globalOutbound: null`), custom CPU limits, and only the bindings we pass.

Rejected options:

| Option | Why not |
|---|---|
| Workers Builds per Project | The Builds API rejects Artifacts connections (error 12065). It needs a dashboard click per Project and allows one concurrent build. |
| Workers for Platforms | $25 per month base fee. A new product. Not needed at our scale. |
| Direct script upload per Project | Needs a Workers Scripts Edit token at runtime. Creates one Worker per Project. |

### 3.1 Capacity on Workers Paid

Source: Dynamic Workers pricing page, checked 2026-10-10.

| Meter | Included per month | Our expected demo use |
|---|---|---|
| Unique Dynamic Workers created | 1,000 | About 1 per version or preview loaded per day. A demo uses 10 to 50. |
| Requests | 10 million (shared with Workers) | Hundreds |
| CPU time | 30 million ms (shared with Workers) | Small |

Answer to "is the Workers plan enough for one extra demo app": yes. It is enough for many demo apps. The limit that matters is Sandbox time for builds and checks: 5 hours per month per environment.

## 4. Architecture

```mermaid
flowchart LR
  user[User browser] -->|acme.APPS_DOMAIN| router[rhumbatron-apps Worker]
  router -->|host to project, version| d1[(D1 app_deployments)]
  router -->|LOADER.get project@commit| dyn[Dynamic Worker: the app]
  dyn -->|env.ASSETS| assets[Asset binding: R2 or KV]
  dyn -->|env.DATA| facet[(Per-app storage: DO facet)]
  router -->|bundle cache miss| r2[(R2 app bundles)]
```

```mermaid
sequenceDiagram
  participant V as CandidateVerificationWorkflow
  participant S as Sandbox
  participant R2 as R2 app bundles
  participant P as ProjectRootDO
  participant D as D1 app_deployments
  participant A as Apps router
  V->>S: build bundle (worker-bundler) for Candidate commit
  S->>R2: put apps/project/commit/ (modules, manifest, assets)
  V->>D: preview row: cand-id -> commit
  Note over A: preview live at cand-id--slug.APPS_DOMAIN
  P->>P: promotion CAS S(n) -> S(n+1)
  P->>D: production row: slug -> commit of S(n+1)
  Note over A: next request loads the new version
```

### 4.1 Components

| Component | Kind | Responsibility |
|---|---|---|
| `workers/apps` (new) | Worker with `worker_loaders` binding | Maps host to Project and version. Loads the app. Serves previews and production. Returns a clear page for "no app yet" and "app removed". |
| `AppHostDO` (new, in `workers/apps`) | Durable Object, SQLite | Supervisor per app. Runs the app as a facet so it gets its own SQLite storage (Durable Object Facets). |
| App bundle builder | Step in the verification and release paths | Bundles the Project in the Sandbox. Stores modules, manifest and static assets in R2. |
| `app_deployments` (new D1 table) | Runtime data | `project_id, slug, channel (production or preview id), commit, generation, bundle_key, status, created_at`. |
| Code service (API) | Routes in `workers/api` | File tree, file content, ChangeSet diff, Candidate diff, version history. |
| Code viewer (web) | Pages in `apps/web` | File browser, file view, diffs, history. Built in the existing design. |

### 4.2 Domain

Apps run code that agents wrote, so they must not share cookies with rhumbatron.com. The Clerk production session lives on rhumbatron.com.

| Option | Cookie isolation | Cost | Notes |
|---|---|---|---|
| **A. Separate zone**, for example `rhumbatron.app` | Full | About $10 to $15 per year for registration | Recommended. Universal SSL covers `*.rhumbatron.app`. Terraform owns the zone, DNS and Worker route. |
| B. `<slug>.rhumbatron.com` | Weak: Clerk cookies on the parent domain are readable by app pages | None | Not recommended. |
| C. `apps.<workers.dev>/<slug>/` (path based) | Good | None | The app must handle a path prefix. Absolute paths like `/api/...` break. Good only as a stopgap. |

**Decision needed (D1):** register a separate zone (A), or use the stopgap (C) for the demo.

Host format with option A:

- Production: `<slug>.rhumbatron.app`
- Preview: `<candidate-short-id>--<slug>.rhumbatron.app`
- Dev environment: `<slug>.dev.rhumbatron.app`, or a second zone.

## 5. User flows

### 5.1 Create app

1. User creates a Project from a template (Acme Shop today; "empty Worker app" later).
2. Rhumbatron provisions the Artifacts repo (exists today).
3. A new `app.provision` command builds the S0 bundle and writes the production row.
4. The Project overview shows "Live at acme.rhumbatron.app" with an **Open app** link.

### 5.2 Instruction to live feature

1. User types an instruction. It becomes a Change (exists).
2. Agents work; a Candidate composes; checks run (exists).
3. **New:** the verification workflow builds the app bundle and publishes a preview. The Candidate page shows **Open preview**.
4. Promotion runs (exists). **New:** the production pointer moves in the same step that records `canonical.advanced`. Section 37 says the release is a data-plane operation, so no Terraform is involved.
5. Smoke check on the production host (reuse `release-model.ts` probes). On failure the release is `smoke_failed` and the pointer moves back to the previous version, as a new transition.

### 5.3 Many instructions at once

- Independent Changes run in parallel and promote one after another.
- A Candidate whose base generation is out of date becomes `stale` (exists). **New:** auto-recompose on the new canonical state and re-verify, up to 2 times. Then mark it blocked.

### 5.4 Rollback

- The Versions page lists S0..Sn, each with its commit, its Change, its time and an "Open" link to that version's live bundle (it is still in R2).
- **Roll back to Sk** creates a new canonical transition Sn -> Sn+1, whose tree equals Sk's tree. It needs approval if policy requires it. It never deletes history (sections 21.3 and 42.10).
- The production pointer moves to the bundle for Sk's commit. No rebuild is needed.

### 5.5 Remove app

- **Remove app** on Settings sets the app status to `removed`. The router answers 410 with a plain page.
- The existing archive flow then cleans up the source. It also deletes bundles (R2 prefix), facet storage (`facets.delete`) and deployment rows. The data is gone after cleanup; say so in the UI.

### 5.6 View code

- **Code** tab on the Project: a file tree for any version (default: live), with file content and syntax highlighting.
- **Files changed** tab on the Change page and the Candidate page: a unified diff against the base generation.
- **History**: versions with their Changes and ChangeSets. Each ChangeSet shows its agent, Intent and diff.

### 5.7 Edit code

- **Edit** on a file opens an editor. **Save** creates a human ChangeSet on a new Change ("Edit src/catalog.ts by Sudhanva").
- That Change goes through the same Candidate and checks. Human edits never bypass evidence. This is the core invariant: only verified evidence advances the Canonical State.

## 6. Work breakdown

Each task is small and verifiable. The model column follows AGENTS.md section 22.

### Milestone P16-A: Apps runtime (deploy any Project)

| ID | Task | Model | Acceptance |
|---|---|---|---|
| P16-01 | ADR 0020: live apps on Dynamic Workers, domain choice, data model, security | Opus | ADR merged; decision D1 recorded |
| P16-02 | Terraform: apps zone or route, wildcard DNS, R2 prefix lifecycle, D1 migration `app_deployments` | Sonnet | Plan shows only these; no drift after apply |
| P16-03 | Terraform adapter for the `workers/apps` deploy: provider 5.27 has no `worker_loader` binding type; same pattern as `sandbox-deploy.ts` | Sonnet | `terraform apply` deploys it; re-run is a no-op |
| P16-04 | `workers/apps` router: host parse, pointer lookup (cached), `LOADER.get(project@commit)`, 404, 410 and "building" pages | Sonnet | Unit tests for host parsing; live request serves S0 |
| P16-05 | Security defaults: `globalOutbound: null`, CPU and subrequest limits, no Rhumbatron bindings, response header hardening | Opus review | Test app cannot fetch the Internet; limit hit returns 503 |
| P16-06 | Bundle builder: Sandbox step with `@cloudflare/worker-bundler`, upload modules, manifest and assets to R2, content-addressed | Sonnet | Bundle for Acme S0 is stored and loads |
| P16-07 | Static assets: asset binding passed to the app (per the Dynamic Workers static assets guide) | Sonnet | Acme `public/` files serve from the app host |
| P16-08 | `app.provision` command on Project create; Project overview shows "Live at …" and **Open app** | Sonnet | New Project is live in under 2 minutes |
| P16-09 | Per-app storage through Durable Object facets (`AppHostDO`). Acme keeps its in-memory store for the demo. | Opus design, Sonnet | Facet data survives an isolate restart |

### Milestone P16-B: Previews, promotion and rollback

| ID | Task | Model | Acceptance |
|---|---|---|---|
| P16-10 | Verification builds the Candidate bundle and writes the preview row; **Open preview** on the Candidate page | Sonnet | Two Candidates show two different live previews |
| P16-11 | Promotion moves the production pointer; release record and smoke reuse `release-model.ts` | Opus review | Promote S1 -> S2 serves S2 within seconds |
| P16-12 | Smoke failure rolls the pointer back as a new transition | Sonnet | Injected smoke failure leaves the old version live |
| P16-13 | Versions page and **Roll back to Sk** (new canonical transition, approval by policy) | Sonnet | Rollback S5 -> S6 (= S3 tree) serves S3 code |
| P16-14 | Stale Candidate auto-recompose and re-verify (max 2) | Opus design, Sonnet | Two parallel Changes both ship without manual steps |
| P16-15 | Retire the Workers Builds path for Acme Shop Live, or keep it as an optional export | Sonnet | One deploy path in docs |

### Milestone P16-C: Code view and edit

| ID | Task | Model | Acceptance |
|---|---|---|---|
| P16-16 | Code store: file contents per tree in R2, content-addressed by blob, written by the indexer or the bundle step | Sonnet | Any promoted tree is readable |
| P16-17 | API: `GET /v1/projects/:id/code?tree=&path=`, `GET /v1/changesets/:id/diff`, `GET /v1/candidates/:id/diff`, `GET /v1/projects/:id/versions` | Sonnet | e2e covers each route |
| P16-18 | Web: Code tab (tree, file view), Files changed tabs, History, in the existing design | Sonnet | Manual check on dev and prod |
| P16-19 | Edit flow: file editor; save creates a human ChangeSet and Change; it goes through checks | Opus review, Sonnet | Human edit ships only after checks pass |

### Milestone P16-D: Remove, cost and hardening

| ID | Task | Model | Acceptance |
|---|---|---|---|
| P16-20 | **Remove app**: 410 at once; cleanup deletes bundles, facets and rows | Sonnet | Host returns 410; R2 prefix empty after sweep |
| P16-21 | Cost: count Dynamic Workers created, requests and CPU in `cost:report`; daily caps; alert at 80% | Haiku | Cost report shows the apps meters |
| P16-22 | Bundle retention: keep bundles for each promoted generation; delete preview bundles after 7 days | Haiku | Lifecycle rule in Terraform |
| P16-23 | Extend `bun run e2e` and the smoke tests: provision, preview, promote, rollback, remove, code routes | Sonnet | e2e passes on dev and prod |
| P16-24 | Docs: architecture page "Live apps", runbook updates, diagrams | Haiku | Diagrams parse |

### Order and parallel work

```mermaid
flowchart LR
  A1[P16-01 ADR] --> A2[P16-02/03 infra]
  A2 --> A4[P16-04 router] --> A6[P16-06/07 bundles] --> A8[P16-08 provision]
  A8 --> B10[P16-10 previews] --> B11[P16-11/12 promote] --> B13[P16-13 rollback]
  A1 --> C16[P16-16/17 code API] --> C18[P16-18 code UI] --> C19[P16-19 edit]
  B13 --> D20[P16-20..24 remove, cost, tests, docs]
  C19 --> D20
```

Streams A/B and C can run in parallel with separate file ownership. C touches `workers/api` routes, `workers/indexer` and `apps/web`. A/B touch `workers/apps`, `workers/integration` and `infrastructure`.

## 7. Demo script (target)

1. Create Project "Acme Shop". It is live at `acme.rhumbatron.app` in under 2 minutes.
2. Open the Code tab. Show `src/catalog.ts`.
3. Give 5 instructions at once. Two collide on purpose (wishlist and cart sharing).
4. Show agents working, the conflict card, and two Candidates with two live previews.
5. Candidate A fails p95; B passes. Open both previews.
6. Approve. S2 goes live. Refresh the app: the feature is there.
7. Show the Files changed tab for the shipped Candidate.
8. Roll back to S1. The app returns to the old version. Roll forward again.
9. Edit one line of copy in the Code tab. It ships after checks.
10. End on the convergence view.

## 8. Cost and limits

| Item | Expected | Guard |
|---|---|---|
| Dynamic Workers created | Under 100 per month | Count in `cost:report`; cap previews per Change (3, matches max Candidates) |
| Requests and CPU | Small | Per-app CPU limit; existing Workers meters |
| Sandbox build time | About 30 to 60 seconds per bundle | Reuse the verification Sandbox session; existing 5 h per month cap |
| R2 bundle storage | Under 100 MB | Lifecycle rule for previews |
| Domain | About $10 to $15 per year if option A | Needs your approval |
| Model spend | Unchanged per Change | Existing caps |

## 9. Risks

| Risk | Mitigation |
|---|---|
| Agent-written app reads Rhumbatron cookies | Separate zone (decision D1) |
| App code runs too long or loops | Dynamic Worker CPU limits; `globalOutbound: null` |
| Terraform provider lacks the `worker_loader` binding | Adapter (P16-03) under section 11.4, with an ADR; replace when the provider adds it |
| Bundling fails for an app that is not Worker-shaped | Templates are Worker-shaped; the check fails with a clear message, never a silent pass |
| Dynamic Worker eviction adds cold-start latency | Stable ids per commit; bundle in R2 near the router |
| Rollback to a version whose data schema differs | Facet data is per app, not per version; rollback warns when a migration ran in between (follow-up) |

## 10. Decisions needed before building

- **D1, domain:** separate zone such as `rhumbatron.app` (recommended; about $10 to $15 per year), or the path-based stopgap on workers.dev.
- **D2, edit in v1:** yes (P16-19 in this phase), or view only first.
- **D3, Workers Builds path:** retire it (one deploy path), or keep it for Acme Shop Live.
- **D4, tracking:** load this plan into Linear as milestone "P16 Live Apps" with one issue per task.
