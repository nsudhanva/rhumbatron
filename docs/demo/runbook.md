# Demo runbook

This runbook maps the AGENTS.md section 55 sequence to the prod UI (`https://rhumbatron.com`) and API (`https://api.rhumbatron.com`).

Prod is the only remote environment. Run the sequence by hand in the prod UI, with a real model-driven Change. For a repeatable conflict, publish the fixture Designs A and B on an unplanned Change ([wishlist-fixture.md](wishlist-fixture.md)).

Deploys use Terraform only: `bun run cf:bundle`, `bun run tf:plan:prod`, `bun run tf:apply:prod`, and `bun run tf:drift:prod`.

## Before the demo

1. Make sure that prod is not paused. The value must be `locals.paused = false` in `infrastructure/terraform/envs/prod/main.tf`.
2. If prod is paused, set the value to `false` and apply with Terraform ([pause-resume.md](../operations/pause-resume.md)).
3. Run `bun run smoke:prod`.
4. Create the `Acme Shop` Project. The UI creates empty Projects only. Send `POST /v1/fixtures/projects` with `{"name": "Acme Shop", "slug": "acme-shop-demo"}` and a session token. The route seeds the Acme Shop baseline at Canonical Generation `S0`. It answers 404 where `FIXTURES_ENABLED` is not `true`. Terraform sets it to `true` in prod.
5. Optional: Run `bun run cleanup:projects --dry-run`, then `bun run cleanup:projects`, to remove smoke-test Projects. The command keeps `acme-shop-demo`.
6. After testing, pause compute if it is not needed.

Cost and limits:
- Sandbox: 20 hours per month in prod.
- Browser Run: 960 seconds per day.
- Claude (Anthropic): code stops model work at 100 USD per calendar month (ADR 0021).
- Check usage with `bun run cost:report` ([costs.md](../operations/costs.md)).

## UI routes

- `/`: Projects list. Header contains notification bell.
- `/projects/<id>`: Project overview.
- `/changes/<id>`: Change details, acceptance criteria, invariants, candidates.
- `/changes/<id>/flight`: Flight Control (execution DAG, agent swimlanes, workspace lanes, codebase heatmap, candidate arena, preview wall, evidence explorer, decisions, events, time machine, command palette Cmd+K).
- `/candidates/<id>`: Candidate verification evidence, approval, promotion.
- `/compare/<changeId>`: Candidate comparison matrix.
- `/projects/<id>/{agents,events,verification,workspace,costs,graph}`: Dedicated project management and monitoring views.

## Sequence

| # | Section 55 step | Where | What to show |
|---|---|---|---|
| 1 | Open `rhumbatron.com` | `/` | Projects table. Header shows notification bell. |
| 2 | Open `Acme Shop` | `/` -> `/projects/$projectId` | Click Acme Shop to open the Project overview. |
| 3 | Show Canonical Generation `S1841` | `/projects/$projectId` | Stat strip "Canonical generation" and "Canonical source". Projects start at `S0`, and each promotion adds one. `S1841` is the AGENTS.md example. The live demo shows the real number. |
| 4 | Show production health | `/projects/$projectId` | The overview shows "Live at" with the app URL. Open the app to show it serves. |
| 5 | Enter the shared Wishlist goal | `/projects/$projectId`, "New change" | Submit goal: `Add shared wishlists. Users can create a wishlist, share it with a link, and let collaborators add or remove products. Keep existing cart behavior unchanged. Keep API p95 below 200 ms.` |
| 6 | Show generated acceptance criteria | `/changes/$changeId` or `/changes/$changeId/flight` | "Acceptance criteria" section, which the Root Planner fills. |
| 7 | Show protected Cart invariant | `/changes/$changeId` or `/changes/$changeId/flight` | "Protected invariants" section. |
| 8 | Show p95 constraint | `/changes/$changeId` or `/changes/$changeId/flight` | p95 criterion: under 200 ms. |
| 9 | Show Work Graph creation | `/changes/$changeId/flight` | Execution DAG in Flight Control. |
| 10 | Show selected Agents | `/changes/$changeId/flight` or `/projects/$projectId/agents` | Agent swimlanes show woken Task agents. |
| 11 | Show that the full Agent pool does not wake | `/changes/$changeId/flight` | Only ready Tasks have active lanes. Pending Tasks stay idle. |
| 12 | Show Artifact Workspace creation | `/changes/$changeId/flight` or `/projects/$projectId/workspace` | Workspace lanes show isolated Artifact forks for active Tasks. |
| 13 | Show parallel implementation progress | `/changes/$changeId/flight` | Agent swimlanes, workspace lanes, and codebase heatmap show live progress. |
| 14 | Show the design conflict | `/changes/$changeId` or `/changes/$changeId/flight` | Conflict detected on semantic resource `wishlist:membership`. Model conflict review (Sonnet and Opus escalation). |
| 15 | Open conflict details | `/changes/$changeId` or `/changes/$changeId/flight` Decisions | Conflict card: semantic resource `wishlist:membership`, both Intents, and the Candidate fork decision. |
| 16 | Show the two incompatible assumptions | `/changes/$changeId` Conflict card | Mutable membership table (`mutable_table`) vs append-only membership event log (`append_only`). |
| 17 | Show two Candidate futures | `/changes/$changeId/flight` Candidate arena, or `/changes/$changeId` Candidates | Candidate rows for Design A and Design B. |
| 18 | Run Candidate verification | `/candidates/$candidateId` | Sandbox verification status and verification evidence. |
| 19 | Show Candidate A fail p95 | `/compare/$changeId` | Candidate A fails p95 (> 200 ms) by design. It cannot promote. |
| 20 | Show Candidate B pass required checks | `/compare/$changeId` -> `/candidates/$candidateId` | Candidate B passes build, unit, contract, Cart invariant, p95, and authorization security checks. |
| 21 | Open Browser Run evidence | `/candidates/$candidateId` | Browser Run verification evidence row. |
| 22 to 25 | Wishlist share, collaborator add, revoke, denied write | `/candidates/$candidateId` | Browser verification steps and evidence artifacts. |
| 26 | Show Cart invariant pass | `/candidates/$candidateId` | `protected-invariant-cart` row: pass. |
| 27 | Show human approval gate | `/candidates/$candidateId` | The approval policy requires approval for authorization-sensitive actions. |
| 28 | Approve | Approval dialog | Dialog shows Candidate, composed tree, transition, policy, approver, and required checks. Submit approval with reason. |
| 29 | Show CAS promotion | `/candidates/$candidateId` | Click "Promote S(N) → S(N+1)". ProjectRootDO runs compare-and-swap. |
| 30 | Show `canonical.advanced` Event | `/projects/$projectId/events` or `/changes/$changeId/flight` Events | Canonical generation advances by one. |
| 31 to 32 | Show build start and deployment complete | Candidate page | The release panel shows the build, then "deployed" with the version and the smoke result ([release.md](../operations/release.md)). |
| 33 to 34 | Open production app; shared Wishlist works | `<slug>.rhumbatron.com` | Click "Open app" on the Project overview or the Candidate page. |
| 35 | End on the convergence visualization | `/changes/$changeId/flight` | Flight Control time machine and replay: `12 possible changes -> 2 candidates -> 1 verified future -> S1842`. |

## Reliability and troubleshooting

- Dead-letter queue: The dead-letter consumer has Retry and Dismiss actions for failed Tasks.
- Concurrency limits: Section 44 caps Change execution at 8 active agents, 4 Sandboxes per Change, and 2 attempts per tier.
- Advisory Claims: Agents use advisory Claims to signal intent on semantic resources without blocking.
- Stale promotions: If another Candidate advanced the Canonical State first, compare-and-swap rejects the promotion.
- Missing checks: Rhumbatron never treats an incomplete or timed-out check (`not_checked`) as a pass.
- Spend cap: code stops Claude spend at 100 USD per calendar month (ADR 0021). The Sandbox cap is 20 hours per month.
- Leftover compute: Run `bun run cost:report` to check active resources and spend. Run `bun run cleanup:projects` to remove test Projects.
