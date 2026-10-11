# Protocols

The Zod schemas in `packages/protocol/src` are the protocol source of truth.

| File | Content |
|---|---|
| `event.ts` | Event envelope and Event types (AGENTS.md section 17). |
| `command.ts` | Queue command envelope (section 20). |
| `project.ts` | Project, Change, Change statuses, policies, create requests, requesters, request outcomes, and clarifications. |
| `work-graph.ts` | Work Graph, Task, and the agent wake payload. |
| `conflict.ts` | Intent, Challenge, and conflict reports (sections 26 and 32). |
| `candidate.ts` | Candidate, Evidence, Verification Plan, acceptance results, Integration Judge verdict, Candidate selection, approval, and promotion (sections 34 and 36). |
| `workspace.ts`, `context.ts` | Workspace manifest and Context Packet (section 27). |
| `common.ts`, `model.ts` | Risk, complexity, and model tiers, Canonical Generation, route requests, route decisions, and Decision Receipts (section 23). |
| `release.ts`, `api.ts` | Release records, API errors, and health responses. |
| `app.ts`, `code.ts`, `code-edit.ts` | Live app deployments and preview hosts, the code store keys, and human code edits. |
| `activity.ts`, `suggestions.ts` | The Project event feed, Claim state, run progress, Project stats, and the goal suggestion pills. |

## API routes

The API Worker (`workers/api/src`) serves `https://api.rhumbatron.com`. Every route except `/health` and `/v1/version` needs a signed-in user. The API reads the caller's role from D1 (`identity.ts`), never from the client. A caller with no access to the Project gets 404.

Access values:

- Member: the owner or a collaborator of the Project.
- Owner: the owner only. A collaborator gets 403 with a message that starts with "Only the project owner can".

| Method | Path | Access | File |
|---|---|---|---|
| GET | `/health`, `/v1/version` | Public | `index.ts` |
| POST | `/v1/projects` | Signed-in user | `projects.ts` |
| POST | `/v1/fixtures/projects` | Signed-in user. 404 unless `FIXTURES_ENABLED` is `true`. | `projects.ts` |
| GET | `/v1/projects` | Signed-in user | `projects.ts` |
| GET | `/v1/projects/:projectId`, `/snapshot`, `/changes` | Member | `projects.ts` |
| POST | `/v1/projects/:projectId/changes` | Member | `projects.ts` |
| POST | `/v1/projects/:projectId/provision`, `/sandbox-smoke` | Owner | `projects.ts` |
| DELETE | `/v1/projects/:projectId` | Owner | `projects.ts` |
| GET | `/v1/changes/:changeId/tasks` | Member | `projects.ts` |
| GET, PATCH | `/v1/projects/:projectId/settings`, `/v1/projects/:projectId` | Member (GET), Owner (PATCH) | `project-settings.ts` |
| GET | `/v1/changes/:changeId` | Member | `changes.ts` |
| POST | `/v1/changes/:changeId/cancel` | Owner, or the requester of the Change | `changes.ts` |
| POST | `/v1/changes/:changeId/budget` | Owner | `changes.ts` |
| POST | `/v1/changes/:changeId/clarify` | Owner, or the requester of the Change | `clarify.ts` |
| GET, POST, DELETE | Members and invitations (see [Shared Projects](#shared-projects)) | See the table there | `members.ts` |
| GET | `/v1/changes/:changeId/request-conflicts` | Member | `members.ts` |
| GET, POST | `/v1/changes/:changeId/candidates` | Member (GET), Owner (POST) | `candidates.ts` |
| GET | `/v1/candidates/:candidateId`, `/evidence`, `/evidence/:checkId/output` | Member | `candidates.ts` |
| GET | `/v1/candidates/:candidateId/evidence/:checkId/screenshots/:n` | Member | `screenshots.ts` |
| POST | `/v1/changes/:changeId/approve` | Owner | `candidates.ts` |
| POST | `/v1/candidates/:candidateId/promote` | Owner | `candidates.ts` |
| GET, POST | `/v1/changes/:changeId/fixture-changesets` | Member. 404 unless `FIXTURES_ENABLED` is `true`. | `fixtures.ts` |
| GET | `/v1/changes/:changeId/conflicts` | Member | `conflicts.ts` |
| GET | `/v1/changes/:changeId/decisions` | Member | `decisions.ts` |
| GET | `/v1/changes/:changeId/events`, `/claims`, `/progress` | Member | `activity.ts` |
| GET | `/v1/projects/:projectId/events`, `/stats` | Member | `activity.ts` |
| GET | `/v1/projects/:projectId/live` (WebSocket) | Member | `live.ts` |
| GET | `/v1/projects/:projectId/agents` | Member | `agents.ts` |
| GET | `/v1/projects/:projectId/cost` | Member | `cost.ts` |
| GET | `/v1/projects/:projectId/verification` | Member | `verification.ts` |
| GET | `/v1/projects/:projectId/workspace`, `/workspace/files` | Member | `workspace.ts` |
| GET | `/v1/tasks/:taskId/workspace` | Member | `workspace-manifest.ts` |
| GET | `/v1/projects/:projectId/code`, `/versions` | Member | `code.ts` |
| GET | `/v1/changes/:changeId/changesets`, `/v1/changesets/:changeSetId/diff`, `/v1/candidates/:candidateId/diff` | Member | `code.ts` |
| POST | `/v1/projects/:projectId/code/edits` | Owner | `code-edit.ts` |
| GET | `/v1/projects/:projectId/product-graph` | Member | `product-graph.ts` |
| GET | `/v1/projects/:projectId/suggestions` | Member | `suggestions.ts` |
| GET | `/v1/projects/:projectId/dead-letters` | Member | `dead-letters.ts` |
| POST | `/v1/dead-letters/:id/retry`, `/v1/dead-letters/:id/dismiss` | Owner | `dead-letters.ts` |
| GET | `/v1/projects/:projectId/releases` | Member | `releases.ts` |
| POST | `/v1/projects/:projectId/releases/inject-failure` | Owner. 404 unless `FIXTURES_ENABLED` is `true`. | `releases.ts` |
| GET | `/v1/projects/:projectId/app`, `/v1/candidates/:candidateId/preview` | Member | `apps.ts` |
| POST, DELETE | `/v1/projects/:projectId/app` | Owner | `apps.ts` |
| POST | `/v1/projects/:projectId/rollback` | Owner | `apps.ts` |
| GET, POST | `/v1/notifications`, `/v1/notifications/count`, `/v1/notifications/read` | Signed-in user | `notifications.ts` |

`POST /v1/projects/:projectId/changes` makes the `clientRequestId` unique for each requester. Two users can send the same `clientRequestId` without a collision. A request without `budgetUsd` gets the Project default budget (see [Project settings](#project-settings)).

## Shared Projects

An owner shares a Project with a collaborator by email (`workers/api/src/members.ts`). The owner role covers administration only. The system decides between requests (ADR 0025). No role or rank is a decision input.

| Method | Path | Access | Result | Main errors |
|---|---|---|---|---|
| GET | `/v1/projects/:projectId/members` | Member | `role`, `members`, and `invitations`. The owner gets the pending invitations and the email of each member. A collaborator gets an empty `invitations` list and only their own email. | 404 |
| POST | `/v1/projects/:projectId/invitations` | Owner | `201` with the invitation (`id`, `email`, `createdAt`, `expiresAt`). An invitation is valid for 7 days. A repeat for the same pending email returns that invitation. | 400, 403, 404, 409 (archived Project, or the email already has access) |
| DELETE | `/v1/projects/:projectId/invitations/:invitationId` | Owner | The invitation with status `revoked`. A repeat is safe. | 403, 404 |
| DELETE | `/v1/projects/:projectId/members/:userId` | Owner, or a collaborator for their own user ID (leave) | `userId` and `removed: true`. The owner row cannot be removed. A collaborator who leaves gets their open requests cancelled first. | 403, 404 (no such collaborator) |
| GET | `/v1/invitations` | Signed-in user | Up to 20 pending invitations for the verified emails of the caller. Each item has `projectName` and `invitedBy`. | None |
| POST | `/v1/invitations/:invitationId/accept` | The invited user | `projectId` and `role`. A repeat by the same user is safe. | 404, 409 (revoked or expired) |
| GET | `/v1/changes/:changeId/request-conflicts` | Member | Up to 10 cross-request conflicts and duplicates of the Change: verdict, round, both goals, both requesters, the cited criteria or covered quotes, the policy, and the winner. | 404 |
| POST | `/v1/changes/:changeId/clarify` | Owner, or the requester of the Change | `ClarifyChangeOutcome`: `recorded` with `changeStatus`, `action`, `round`, and `repeated`. | 400 (malformed body, unknown question), 403, 404, 409 (not waiting for an answer) |

An invitation binds to a verified email of the signed-in user. If the email is not a verified email of the user, `accept` returns the same 404 as for a missing invitation. The membership binds to the user ID, not to the email.

`clarify` takes one of these bodies:

- `{ answers: [{ questionId, text }] }`: 1 to 3 answers to questions of the open round. The Change returns to `compiling` with the answers in its goal context.
- `{ action: "proceed_anyway" }`: the Change plans without another question in this round.
- `{ action: "withdraw" }`: the Change is cancelled with the reason "Withdrawn by the requester".

A repeat of the caller's last command returns `repeated: true`. A Change gets at most 3 rounds of questions. A Change that gets no answer for 7 days is cancelled.

### Owner-only actions

Access to a Project does not give permission for each action. A collaborator can view the Project, create Changes, cancel and answer their own Changes, and leave the Project. These actions are owner-only (`ownerOnlyMessage` in `workers/api/src/identity.ts`):

- Share, revoke an invitation, and remove a member.
- Cancel the Change of another person.
- Raise a Change budget.
- Compose a Candidate, approve a release, and promote a Candidate.
- Publish an app, remove an app, roll back, and inject a release failure.
- Edit code directly.
- Provision the Project, run checks, and remove the Project.
- Rename the Project and set its default Change budget.
- Retry or dismiss stopped work (dead letters).

### Fields on Project and Change responses

| Response | Field | Meaning |
|---|---|---|
| `GET /v1/projects` and `GET /v1/projects/:projectId` | `role` | `owner` or `collaborator`. The caller's role in the Project. |
| Change list and `GET /v1/changes/:changeId` | `requester` | Who asked for the Change: `userId`, `name`, `rank` (display order only: owner 0, collaborator 10), and `isYou`. |
| Change list and `GET /v1/changes/:changeId` | `outcome` | How the request ended after the intake gate or the cross-request check. Null when no check decided it. |
| Change list and `GET /v1/changes/:changeId` | `supersedesChangeId` | Null for every request the API creates. |
| Change list and `GET /v1/changes/:changeId` | `clarification` | `ChangeClarification` while the Change is `needs_input`, else null: `kind` (`unclear`, `duplicate`, `conflict`), `summary`, `questions` (`id`, `text`, optional `options`), `relatedChangeId`, `relatedGoal`, `askedAt`, `round` (1 to 3). |

### Change statuses for requests

| Status | Meaning |
|---|---|
| `not_selected` | The request lost a conflict. The system arbiter chose the other request, or the same requester asked again and the later request replaces the earlier one. The Change does no more work. |
| `needs_input` | The request is unclear, repeats another request or the current app, or conflicts and the system could not decide. The Change waits for an answer (`clarification`). |

### Request outcome kinds

`outcome.kind` has one of these values. The outcome also has `reason`, `winnerChangeId`, and `decidedBy` (`system:arbiter` or `system:same_requester`).

| Kind | Meaning |
|---|---|
| `selected` | The request won the conflict check, or it has no conflict. |
| `partially_selected` | The request lost one or more criteria. The planner plans again without them. |
| `not_selected` | The request lost the conflict check. `winnerChangeId` names the request that won. |
| `replaces` | The request won against an earlier request that had already promoted. |
| `duplicate` | The request closed as a duplicate. `winnerChangeId` names the related request. It is null when the current app already delivers the request. |

## Project settings

The routes are in `workers/api/src/project-settings.ts`. The web page is `/projects/:projectId/settings`.

| Method | Path | Access | Result | Main errors |
|---|---|---|---|---|
| GET | `/v1/projects/:projectId/settings` | Member | `name`, `slug`, `createdAt`, `role`, `defaultBudgetUsd`, `effectiveDefaultBudgetUsd`, and `limits` (`minBudgetUsd`, `maxBudgetUsd`). | 404 |
| PATCH | `/v1/projects/:projectId` | Owner | The same body as the GET. Request body: `name` (1 to 80 characters), `defaultBudgetUsd` (0.5 to 25 USD, or `null` for the built-in default of 3 USD), or both. The same values again write nothing. | 400, 403, 404, 409 (archived Project) |

`projects.default_budget_usd` (migration `0027_project_settings.sql`) stores the default.
