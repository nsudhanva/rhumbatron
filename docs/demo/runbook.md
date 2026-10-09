# Demo runbook

The AGENTS.md section 55 sequence, mapped to the dev UI (`https://dev.rhumbatron.com`) and the
commands that prepare it. Prod is planned but not applied; the demo runs on dev until it is.

## Before the demo

1. Make sure dev is running: `locals.paused = false` in `infrastructure/terraform/envs/dev/main.tf`
   and applied through `bun run tf:plan:dev` and `bun run tf:apply:dev`. Pause it again afterwards.
2. `bun run smoke:dev`: API, web, and the authenticated Project and Change flow.
3. `bun run demo:project`: creates (or reuses) the `acme-shop-demo` Project with its seeded Acme
   Shop source in Artifacts, and prints the Project ID and canonical commit.
4. `bun run demo:wishlist`: prepares the Wishlist story (the two designs, their conflict, and
   their Candidates). This command is being added now; until it lands, run the Change live from
   step 5 below.
5. Optional: `bun run inject` to show recovery from injected faults
   (docs/demo/failure-injection.md).

Budget: the Wishlist Change runs on free models (50 requests per day). One Candidate verification
uses a few minutes of the 10 h monthly Sandbox cap.

## Sequence

| # | Section 55 step | Where | What to show |
|---|---|---|---|
| 1 | Open `rhumbatron.com` | `/` | Projects list. Sign in first; the tagline shows when signed out. |
| 2 | Open `Acme Shop` | `/` -> `/projects/$projectId` | Click Acme Shop in the Projects table. |
| 3 | Show Canonical Generation `S1841` | `/projects/$projectId` | Stat strip "Canonical generation" and the "Canonical source" section (Generation, Artifact, Tree). `S1841` needs the demo reset (`demo:wishlist`, P12-12); a fresh `demo:project` starts at `S0`. |
| 4 | Show production health | `/projects/$projectId` | Project status and the live pill. Release health needs P11-07/08 (parked). |
| 5 | Enter the shared Wishlist goal | `/projects/$projectId`, "New change" | Paste the goal from section 4, keep budget `$3`, submit. The page opens the Change. |
| 6 | Show generated acceptance criteria | `/changes/$changeId` | "Acceptance criteria" section, filled when the Root Planner finishes. |
| 7 | Show protected Cart invariant | `/changes/$changeId` | "Protected invariants" section. |
| 8 | Show p95 constraint | `/changes/$changeId` | Same sections: the p95 criterion; later the p95 column on the Candidates table. |
| 9 | Show Work Graph creation | `/changes/$changeId` | "Work graph" section (XYFlow). "Root Planner is compiling the Work Graph" while compiling. |
| 10 | Show selected Agents | `/changes/$changeId` | Agent activity view: one lane per woken Task agent. |
| 11 | Show that the full Agent pool does not wake | `/changes/$changeId` | Agent activity: only ready Tasks have lanes; pending Tasks stay grey in the Work graph. |
| 12 | Show Artifact Workspace creation | `/changes/$changeId`, Task details | Select a Task: its run, fork, and Intent. Project Workspace page: `/projects/$projectId/workspace` (in progress). |
| 13 | Show parallel implementation progress | `/changes/$changeId` | Agent activity lanes, Intents on the Workspace bus, Task status pills. |
| 14 | Show the design conflict | `/changes/$changeId` | "Conflicts" section: one open ConflictCard; the activity view holds an accent connector between the two lanes. |
| 15 | Open conflict details | `/changes/$changeId` | The ConflictCard: semantic resource `wishlist:membership`, both Intents, the fork decision. |
| 16 | Show the two incompatible assumptions | `/changes/$changeId` | ConflictCard: mutable membership table vs append-only membership. |
| 17 | Show two Candidate futures | `/changes/$changeId`, "Candidates" | Two rows; "Compare candidates" appears with two or more. "Verify a Candidate" composes one if needed. |
| 18 | Run Candidate verification | `/changes/$changeId` -> `/candidates/$candidateId` | Banner "Verifying in the Sandbox"; checks fill under "Verification evidence". |
| 19 | Show Candidate A fail p95 | `/compare/$changeId` | Evidence matrix: Candidate A p95 over 200 ms, "Not promotable · required checks not satisfied". |
| 20 | Show Candidate B pass required checks | `/compare/$changeId` -> `/candidates/$candidateId` | Banner "Verified · all required checks pass with evidence"; "Required checks met: All met". |
| 21 | Open Browser Run evidence | `/candidates/$candidateId`, "Verification evidence" | Browser check row and its output. The Browser Run check is in progress. |
| 22 to 25 | Wishlist share, collaborator add, revoke, denied write | `/candidates/$candidateId` | Browser check screenshots and steps, once the Browser Run check lands. |
| 26 | Show Cart invariant pass | `/candidates/$candidateId` | `protected-invariant-cart` row: pass, `checked_supported`. |
| 27 | Show human approval gate | `/candidates/$candidateId`, "Approval and promotion" | "Review and approve" and "Reject". The gate applies to high-risk and authorization-touching plans. |
| 28 | Approve | Approval dialog | The dialog shows Candidate, composed tree, transition, policy, approver, and the required checks. Approve with a reason. |
| 29 | Show `S1841 -> S1842` promotion | `/candidates/$candidateId` | "Promote S1841 → S1842", then the banner "Promoted · S1841 → S1842". A second click is idempotent. |
| 30 | Show `canonical.advanced` Event | `/changes/$changeId` agent activity, or `/projects/$projectId/events` (in progress) | The winner merges back to the trunk and the generation ticks over. |
| 31 to 32 | Show build start and deployment complete | none yet | Blocked: release (P11-07/08) is parked (ADR 0014). |
| 33 to 34 | Open production app; shared Wishlist works | none yet | Blocked on the release path. |
| 35 | End on the convergence visualization | `/changes/$changeId` | Agent activity "Replay": `12 possible changes -> 2 candidates -> 1 verified future -> S1842` (P12-11 in progress). |

## If something goes wrong

- A Candidate shows "Stale · the canonical state moved": another promotion won. It cannot promote
  (section 36). Verify a new Candidate on the new base.
- A check shows `not_checked`: it timed out or did not run. It is a gap, never a pass.
- The Change shows `budget_blocked`: the daily model-call cap was reached. State stays readable.
- `bun run cost:report` lists leftover compute and spend.
