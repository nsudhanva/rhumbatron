# Demo runbook

This runbook maps the AGENTS.md section 55 sequence to the prod UI (`https://rhumbatron.com`) and API (`https://api.rhumbatron.com`).

Prod is the only remote environment. Run the sequence in the prod UI with a real model-driven Change. For a repeatable conflict, publish the fixture Designs A and B on an unplanned Change ([wishlist-fixture.md](wishlist-fixture.md)). Deployment is in [deploy.md](../operations/deploy.md).

## Before the demo

1. Make sure that `locals.paused = false` in `infrastructure/terraform/envs/prod/main.tf`. If prod is paused, resume it ([pause-resume.md](../operations/pause-resume.md)).
2. Run `bun run smoke:prod`.
3. Create the `Acme Shop` Project. The UI creates empty Projects only. Send `POST /v1/fixtures/projects` with `{"name": "Acme Shop", "slug": "acme-shop-demo"}` and a session token. The route seeds the Acme Shop baseline at Canonical Generation `S0`. It answers 404 unless `FIXTURES_ENABLED` is `true`. Terraform sets `FIXTURES_ENABLED = "true"` on the prod API.
4. Optional: run `bun run cleanup:projects --dry-run`, then `bun run cleanup:projects`, to remove smoke Projects. The command keeps `acme-shop-demo`.
5. Run `bun run cost:report` ([costs.md](../operations/costs.md)). The caps are 20 Sandbox hours per month, 960 Browser Run seconds per day, and 100 USD of Anthropic spend per calendar month.
6. After the demo, pause prod if you do not need it.

## Sequence

| # | Section 55 step | Where | What to show |
|---|---|---|---|
| 1 | Open `rhumbatron.com` | `/` | The Projects table and the notification bell. |
| 2 | Open `Acme Shop` | `/projects/$projectId` | The Project overview. |
| 3 | Show Canonical Generation `S1841` | `/projects/$projectId` | The stat strip "Canonical generation" and "Canonical source". A Project starts at `S0`, and each promotion adds one. `S1841` is the AGENTS.md example. The demo shows the real number. |
| 4 | Show production health | `/projects/$projectId` | "Live at" with the app URL. Open the app. |
| 5 | Enter the shared Wishlist goal | `/projects/$projectId`, "New change" | Goal: `Add shared wishlists. Users can create a wishlist, share it with a link, and let collaborators add or remove products. Keep existing cart behavior unchanged. Keep API p95 below 200 ms.` |
| 6 | Show generated acceptance criteria | `/changes/$changeId` | "Acceptance criteria", from the Root Planner. |
| 7 | Show protected Cart invariant | `/changes/$changeId` | "Protected invariants". |
| 8 | Show p95 constraint | `/changes/$changeId` | The p95 criterion: below 200 ms. |
| 9 | Show Work Graph creation | `/changes/$changeId` or `/changes/$changeId/flight` | The Work Graph. In Flight Control, the execution DAG. |
| 10 | Show selected Agents | `/changes/$changeId/flight` or `/projects/$projectId/agents` | The agent swimlanes show the agents of woken Tasks. |
| 11 | Show that the full Agent pool does not wake | `/changes/$changeId/flight` | Only ready Tasks have active lanes. Pending Tasks stay idle. |
| 12 | Show Artifact Workspace creation | `/changes/$changeId/flight` or `/projects/$projectId/workspace` | The workspace lanes show one Artifacts fork for each active Task. |
| 13 | Show parallel implementation progress | `/changes/$changeId/flight` | The agent swimlanes, workspace lanes, and codebase heatmap. |
| 14 | Show the design conflict | `/changes/$changeId` | "Design conflict" on the semantic resource `wishlist:membership`. The deterministic detector finds it. Sonnet reviews it. |
| 15 | Open conflict details | `/changes/$changeId`, or the Decisions panel of Flight Control | The conflict card: the resource, both Intents, and the Candidate fork decision. |
| 16 | Show the two incompatible assumptions | `/changes/$changeId`, conflict card | A mutable membership table (`mutable_table`) and an append-only membership event log (`append_only`). |
| 17 | Show two Candidate futures | `/changes/$changeId` Candidates, or the Candidate arena of Flight Control | One Candidate for Design A and one for Design B. |
| 18 | Run Candidate verification | `/candidates/$candidateId` | The Sandbox verification status and the Evidence rows. |
| 19 | Show Candidate A fail p95 | `/compare/$changeId` | Candidate A fails p95 (above 200 ms). It cannot promote. |
| 20 | Show Candidate B pass required checks | `/compare/$changeId`, then `/candidates/$candidateId` | Candidate B passes build, unit, contract, the Cart invariant, performance, security, and browser. |
| 21 | Open Browser Run evidence | `/candidates/$candidateId` | The browser Evidence row and its screenshots. |
| 22 to 25 | Wishlist share, collaborator add, revoke, denied write | `/candidates/$candidateId` | The browser check steps and their Evidence. |
| 26 | Show Cart invariant pass | `/candidates/$candidateId` | The `protected-invariant-cart` row: pass. |
| 27 | Show human approval gate | `/candidates/$candidateId` | The Candidate touches authorization, so the plan requires approval. |
| 28 | Approve | Approval dialog | The dialog shows the Candidate, composed tree, transition, policy, approver, and required checks. Approve with a reason. |
| 29 | Show CAS promotion | `/candidates/$candidateId` | Click "Promote S(N) → S(N+1)". `ProjectRootDO` runs the compare-and-swap. |
| 30 | Show `canonical.advanced` Event | `/projects/$projectId/events`, or the Events panel of Flight Control | The Canonical Generation advances by one. |
| 31 to 32 | Show build start and deployment complete | `/candidates/$candidateId` | The release panel shows the build, then `deployed` with the version and the smoke result ([release.md](../operations/release.md)). |
| 33 to 34 | Open production app; shared Wishlist works | `<slug>.rhumbatron.com` | Click "Open app" on the Project overview. |
| 35 | End on the convergence visualization | `/changes/$changeId` | The agent activity view: the declared Intents (possible changes), the Candidates, and "S(N) → S(N+1). Canonical advanced. One verified future merged." |

## Troubleshooting

- A failed queue command goes to the dead-letter Queue. The Project shows it with Retry and Dismiss.
- Section 44 limits: 8 active agents and 4 Sandboxes per Change, 2 attempts per model tier (`workers/agents/src/limits.ts`).
- Claims are advisory. They show Intent on a semantic resource and do not block.
- If another Candidate advanced the Canonical State first, the compare-and-swap rejects the promotion. The Candidate becomes `stale` and is recomposed.
- A check that did not run or timed out is `not_checked`. It never counts as a pass.
- Run `bun run cost:report` to find active resources and spend.
