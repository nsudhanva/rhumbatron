# Demo runbook

This runbook maps the Rhumbatron demo to the prod UI (`https://rhumbatron.com`) and the API (`https://api.rhumbatron.com`).

The demo starts from a blank Project. Rhumbatron has no templates: the Project gets an empty repository, and the agents build the app. Two people use the Project at the same time. Alice owns the Project. Bob is a member. They build a play-money prediction market. The demo shows parallel requests, one real design conflict, one duplicate request, one unclear request, and one change that needs approval.

Prod is the only remote environment. [deploy.md](../operations/deploy.md) describes the deployment. The design of shared Projects is in [shared-projects.md](../architecture/shared-projects.md). The API is in [protocols](../protocols/README.md).

## Before the demo

1. Make sure that `locals.paused = false` in `infrastructure/terraform/envs/prod/main.tf`. If prod is paused, resume it ([pause-resume.md](../operations/pause-resume.md)).
2. Run `bun run smoke:prod`.
3. Run `bun run cost:report` ([costs.md](../operations/costs.md)). The caps are 20 Sandbox hours per month, 960 Browser Run seconds per day, and 100 USD of Anthropic spend per calendar month. The demo builds about five requests. Each build uses about 15 model calls and a few Sandbox minutes.
4. Prepare two accounts with different email addresses, and two browser profiles. Alice uses one profile. Bob uses the other profile.
5. Optional: to remove smoke Projects, run `bun run cleanup:projects --dry-run`, then `bun run cleanup:projects`. The command keeps every Project that is not a smoke Project.

## Requests

| Name | Requester | Text |
|---|---|---|
| R1 | Alice | `Make a play-money prediction market. People create yes/no markets and bet coins on yes or no. Each person starts with 1000 coins.` |
| R2 | Alice | `Add a leaderboard that ranks people by their coins.` |
| R3 | Bob | `Show a chart of the yes probability of each market over time.` |
| R4 | Alice | `Price each market with an automated market maker, so that each bet moves the price.` |
| R5 | Bob | `Match bets with an order book. People post a price and wait for someone to take the other side.` |
| R6 | Bob | `Show who's winning the most coins.` |
| R7 | Bob | `Make it more fun.` |
| R8 | Alice | `Admins can void a market and refund every bet in it.` |

R2 and R3 change different parts of the app, so they build in parallel. R4 and R5 ask for two different pricing designs, so they conflict. R6 repeats R2. R7 is not clear. R8 changes who may do what, so it needs approval.

## Sequence

| # | Step | Who | Where | What to show |
|---|---|---|---|---|
| 1 | Open `rhumbatron.com` | Alice | `/` | The Projects table and the notification bell. |
| 2 | Create the Project `Prediction Market` | Alice | `/`, "New project" | The Project opens at Canonical Generation `S0`. The repository has one commit with a `.gitignore`. The live app host shows "Nothing built yet". |
| 3 | Share the Project with Bob | Alice | `/projects/$projectId`, Share | The Share dialog shows a pending invitation for Bob. |
| 4 | Accept the invitation | Bob | `/`, "Shared with you" | The Project opens and shows Members, not Share. Bob sees no Approve, Promote, Share, or Remove button. |
| 5 | Turn off member review | Alice | `/projects/$projectId/settings` | Turn off "Member requests need review", so the requests of Bob go to the system at once (ADR 0028). |
| 6 | Send R1 | Alice | `/projects/$projectId`, "New change" | The New change box is at the top of the Overview. The Project has no Changes, so the box is open and shows goal suggestions under the goal. Send R1. |
| 7 | Show the Work Graph | Alice | `/changes/$changeId` | "Acceptance criteria" and "Protected invariants" from the Root Planner. The first Task bootstraps the app, and every other Task depends on it (ADR 0022). |
| 8 | Show the agents | Alice | `/changes/$changeId/flight` | Only ready Tasks have active lanes. Pending Tasks stay idle. Each active Task has one Artifacts fork. |
| 9 | Show Candidate verification | Alice | `/candidates/$candidateId` | The Evidence rows: build, unit, contract, and preview smoke. A check that did not run is a gap, never a pass. |
| 10 | Promote R1 | Alice | `/candidates/$candidateId` | Policy promotes a low or medium risk Candidate. Otherwise click "Promote S0 → S1". `ProjectRootDO` runs the compare-and-swap. The Canonical Generation advances to `S1`. |
| 11 | Open the live app | Alice | `<slug>.rhumbatron.com` | Click "Open app" on the Project overview. Create a market and bet coins. |
| 12 | Send R2 and R3 at the same time | Alice sends R2. Bob sends R3. | `/projects/$projectId`, "New change" | Two Changes build in parallel. The "Requested by" column names each requester. |
| 13 | Show the parallel work | Alice | `/projects/$projectId/board` | Both Changes move through the Board. The request comparison finds no conflict. |
| 14 | Show both features | Alice | The live app | The leaderboard and the probability chart. Each promotion advances the Canonical Generation by one. |
| 15 | Send R4, then R5 | Alice sends R4. Bob sends R5 while R4 builds. | `/projects/$projectId`, "New change" | The request comparison finds a conflict between the two pricing designs. |
| 16 | Show the conflict | Bob | `/changes/$changeId` of R5 | R5 reads "Waiting for Alice to choose". It has status `awaiting_choice` and no Task. No model chooses, and no role decides (ADR 0032). |
| 17 | Show the choice | Alice | `/changes/$changeId` of R4 | The card "Bob's request conflicts with yours" shows both goals, both requesters, and the criteria that conflict. Only Alice sees the buttons "Keep mine" and "Apply theirs after mine". |
| 18 | Choose | Alice | Same card | "Keep mine": R5 ends as `not_selected`, and Bob gets `request_not_selected`. "Apply theirs after mine": R5 is `queued`, then it plans on the tree that has R4. |
| 19 | Send R6 | Bob | `/projects/$projectId`, "New change" | The intake gate stops R6 before planning. R6 has status `needs_input` with kind `duplicate`. The question quotes the leaderboard criterion of R2. R6 has no Task. |
| 20 | Send R7 | Bob | `/projects/$projectId`, "New change" | R7 has status `needs_input` with kind `unclear`. The question asks what "more fun" means. R7 has no Task and no spend. |
| 21 | Answer the questions | Bob | `/changes/$changeId` of R6 and R7 | Withdraw R6. R6 is `cancelled` with the reason "Withdrawn by the requester". Answer R7 with a precise goal, or withdraw it. |
| 22 | Send R8 | Alice | `/projects/$projectId`, "New change" | The plan touches authorization: only an admin may void a market. |
| 23 | Show the approval gate | Alice | `/candidates/$candidateId` | The Candidate passes its checks, including the security check for the denied action. The plan requires human approval, so policy does not promote it. |
| 24 | Approve | Alice | Approval dialog | The dialog shows the Candidate, composed tree, transition, policy, approver, and required checks. Approve with a reason. |
| 25 | Promote | Alice | `/candidates/$candidateId` | Click "Promote S(N) → S(N+1)". |
| 26 | Show `canonical.advanced` | Alice | `/projects/$projectId/events` | The Canonical Generation advances by one. |
| 27 | Show the release | Alice | `/candidates/$candidateId` | The release panel shows the build, then `deployed` with the version and the smoke result ([release.md](../operations/release.md)). |
| 28 | Void a market | Alice | The live app | Void a market. Every bet in it goes back to its owner. |
| 29 | End on the convergence view | Alice | `/changes/$changeId` | The agent activity view shows the declared Intents, the Candidates, and "S(N) → S(N+1). Canonical advanced. One verified future merged." |

## Expected result

| Request | Result |
|---|---|
| R1 | Ships. The app exists. |
| R2 | Ships. |
| R3 | Ships. |
| R4 | Ships. It is the earlier request, so it keeps building. |
| R5 | `awaiting_choice` until Alice chooses. Then `not_selected`, or `queued` and later ships on top of R4. |
| R6 | `needs_input` (`duplicate`) before planning, then `cancelled` after Bob withdraws it. |
| R7 | `needs_input` (`unclear`) before planning. |
| R8 | Ships after Alice approves and promotes. |

If Bob calls a route for the owner and the admins, the API returns 403. Bob cannot choose for R5, approve R8, raise a budget, or cancel a Change of Alice.

## Troubleshooting

- Rhumbatron moves a failed Queue command to the dead-letter Queue. The Project shows the command with Retry and Dismiss.
- Change limits: 8 active Agents and 4 Sandboxes per Change, and 2 attempts per model tier (`workers/agents/src/limits.ts`).
- Claims are advisory. A Claim shows an Intent on a semantic resource and blocks no other Agent.
- When another Candidate advances the Canonical State first, the compare-and-swap rejects the promotion. The Candidate becomes `stale`, and Rhumbatron composes it again.
- A check that did not run or timed out is `not_checked`. It never counts as a pass.
- The intake gate asks at most one round for a request. A Change gets at most 3 rounds of questions in total. Rhumbatron cancels a Change that gets no answer for 7 days.
- To find active resources and spend, run `bun run cost:report`.

## Cleanup

1. Sign in as Alice. Open the Share dialog. Remove Bob from the members list.
2. Revoke each invitation that is still pending.
3. Delete the demo Project when you do not need it. Only the owner can do this ([cleanup.md](../operations/cleanup.md)).
4. Run `bun run cost:report`. Make sure that no compute is active.
5. Pause prod if you do not need it.
