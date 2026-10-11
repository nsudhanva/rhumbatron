# Protocols

The Zod schemas in `packages/protocol/src` are the protocol source of truth.

| File | Content |
|---|---|
| `event.ts` | Event envelope and Event types (AGENTS.md section 17). |
| `command.ts` | Queue command envelope (section 20). |
| `project.ts` | Project, Change, policies, and create requests. |
| `work-graph.ts` | Work Graph and Task. |
| `conflict.ts` | Intent, Challenge, and conflict reports (sections 26 and 32). |
| `candidate.ts` | Candidate, Evidence, Verification Plan, approval, and promotion (sections 34 and 36). |
| `workspace.ts`, `context.ts` | Workspace manifest and Context Packet (section 27). |
| `common.ts`, `model.ts` | Risk, complexity, and model tiers, Canonical Generation, route requests, route decisions, and Decision Receipts (section 23). |
| `release.ts`, `api.ts` | Release records, API errors, and health responses. |
| `app.ts`, `code.ts`, `code-edit.ts` | Live app deployments and preview hosts, the code store keys, and human code edits. |
| `activity.ts`, `suggestions.ts` | The Project event feed and the goal suggestion pills. |

## Shared Projects

An owner shares a Project with a collaborator by email. The routes are in `workers/api/src/members.ts` and `workers/api/src/clarify.ts`. All routes need a signed-in user. The API never reads a role from the client.

The owner role is for administration. The system decides between requests (ADR 0025): no role or rank is a decision input.

### Routes

| Method | Path | Who may call | Result | Main errors |
|---|---|---|---|---|
| GET | `/v1/projects/:projectId/members` | Owner or collaborator | `role`, `members`, and `invitations`. Only the owner gets the pending invitations and the email of each member. | 404 |
| POST | `/v1/projects/:projectId/invitations` | Owner | `201` with the new invitation (`id`, `email`, `createdAt`, `expiresAt`). An invitation is valid for 7 days. | 403, 404, 409 (archived Project, or the email already has access) |
| DELETE | `/v1/projects/:projectId/invitations/:invitationId` | Owner | The invitation with status `revoked`. A repeat is safe. | 403, 404 |
| DELETE | `/v1/projects/:projectId/members/:userId` | Owner | `removed: true` or `false`. The owner row cannot be removed. | 403, 404 |
| GET | `/v1/invitations` | Any signed-in user | Pending invitations for the verified emails of the caller. Each item has `projectName` and `invitedBy`. | None |
| POST | `/v1/invitations/:invitationId/accept` | The invited user | `projectId` and `role`. A repeat by the same user is safe. | 404, 409 |
| GET | `/v1/changes/:changeId/request-conflicts` | Owner or collaborator | The cross-request conflicts and duplicates of the Change: verdict, round, both goals, both requesters, the cited criteria or covered quotes, the policy, and the winner. | 404 |
| POST | `/v1/changes/:changeId/clarify` | The requester or the owner | `ClarifyChangeOutcome`: `recorded` with `changeStatus`, `action`, `round`, and `repeated`. | 400 (malformed body, unknown question), 403, 404, 409 (not waiting for an answer) |

An invitation binds to a verified email of the signed-in user. If the email is not the user's email, `accept` returns the same 404 as for a missing invitation. The membership binds to the user ID, not to the email.

`clarify` takes `{ answers: [{ questionId, text }] }` (1 to 3 answers to questions of the open round), `{ action: "proceed_anyway" }`, or `{ action: "withdraw" }`. Answers return the Change to `compiling` with the answers in its goal context. `proceed_anyway` plans without another question. `withdraw` cancels the Change with the reason "Withdrawn by the requester". A repeat of the caller's last command returns `repeated: true`.

### Owner-only actions

Access to a Project does not give permission for each action. A collaborator can view the Project, create Changes, and cancel their own Changes. These routes return 403 with a message that starts with "Only the project owner can" when a collaborator calls them:

- Share, revoke an invitation, and remove a member.
- Cancel the Change of another person.
- Raise a Change budget.
- Compose a Candidate, approve a release, and promote a Candidate.
- Publish an app, remove an app, and roll back.
- Edit code directly.
- Provision the Project, run checks, and remove the Project.
- Rename the Project and set its default Change budget.
- Retry or dismiss stopped work (dead letters).

### Fields on Project and Change responses

| Response | Field | Meaning |
|---|---|---|
| `GET /v1/projects` and `GET /v1/projects/:projectId` | `role` | `owner` or `collaborator`. The caller's role in the Project. |
| Change list and `GET /v1/changes/:changeId` | `requester` | Who asked for the Change: `userId`, `name`, `rank` (the requester's role at request time, display only), and `isYou`. |
| Change list and `GET /v1/changes/:changeId` | `outcome` | How the request ended after the intake gate or the cross-request check. Null when no check decided it. |
| Change list and `GET /v1/changes/:changeId` | `supersedesChangeId` | Null for every request the API creates. |
| Change list and `GET /v1/changes/:changeId` | `clarification` | `ChangeClarification` while the Change is `needs_input`, else null: `kind` (`unclear`, `duplicate`, `conflict`), `summary`, `questions` (`id`, `text`, optional `options`), `relatedChangeId`, `relatedGoal`, `askedAt`, `round` (1 to 3). |

`POST /v1/projects/:projectId/changes` makes the `clientRequestId` unique for each requester. Two users can send the same `clientRequestId` without a collision.

### Change statuses for requests

| Status | Meaning |
|---|---|
| `not_selected` | A conflicting request lost to the request that the system arbiter chose, or the same requester asked again. The Change does no more work. |
| `needs_input` | The request is unclear, repeats another request or the current app, or conflicts and the system could not decide. The Change waits for the requester (`clarification`). |

### Request outcome kinds

`outcome.kind` has one of these values. The outcome also has `reason`, `winnerChangeId`, and `decidedBy`.

| Kind | Meaning |
|---|---|
| `selected` | The request won the conflict check, or it has no conflict. |
| `partially_selected` | The request lost one criterion. The planner made a new plan without that criterion. |
| `not_selected` | The request lost the conflict check. `winnerChangeId` names the request that won. |
| `replaces` | The request won against an earlier request that had already promoted. |
| `duplicate` | The request closed as a duplicate. `winnerChangeId` names the related request; null when the current app already delivers it. |

## Project settings

The routes are in `workers/api/src/project-settings.ts`. Both routes need a signed-in user. The web page is `/projects/:projectId/settings`.

| Method | Path | Who may call | Result | Main errors |
|---|---|---|---|---|
| GET | `/v1/projects/:projectId/settings` | Owner or collaborator | `name`, `slug`, `createdAt`, `role`, `defaultBudgetUsd`, `effectiveDefaultBudgetUsd`, and `limits` (`minBudgetUsd`, `maxBudgetUsd`). | 404 |
| PATCH | `/v1/projects/:projectId` | Owner | The same body as the GET. Request body: `name` (1 to 80 characters) and `defaultBudgetUsd` (0.5 to 25 USD, or `null` for the built-in default of 3 USD). Send one or both. The same values again write nothing. | 400, 403, 404, 409 (archived Project) |

`projects.default_budget_usd` (migration `0027_project_settings.sql`) stores the default. `POST /v1/projects/:projectId/changes` without `budgetUsd` gives the new Change this default. A request with `budgetUsd` keeps its own budget.
