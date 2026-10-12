# Protocols

The Zod schemas in `packages/protocol/src` are the protocol source of truth.

| File | Content |
|---|---|
| `event.ts` | Event envelope and Event types. |
| `command.ts` | Queue command envelope. |
| `project.ts` | Project, Change, Change statuses, policies, create requests, requesters, request outcomes, clarifications, and the request review (`ChangeReview`, `DeclineChangeRequest`, `ReviewChangeOutcome`). |
| `roles.ts` | Project roles, the permission matrix (`PERMISSIONS`, `can`), the review rule (`needsReview`), invitation and role-change rules, and the members response. |
| `board.ts` | The Board response and the column of each Change status (`BOARD_COLUMN_OF`). |
| `first-come.ts` | First-come conflicts (ADR 0032): `conflictPolicy`, `firstComeStep`, `canChooseFirstCome`, `RequestWait`, `ChooseRequest`, and `ChooseOutcome`. |
| `change-title.ts` | Short Change titles: `clampTitle` for the Root Planner title and `fallbackTitle` for a title from the goal. |
| `work-graph.ts` | Work Graph, Task, and the agent wake payload. |
| `conflict.ts` | Intent, Challenge, and conflict reports. |
| `candidate.ts` | Candidate, Evidence, Verification Plan, acceptance results, Integration Judge verdict, Candidate selection, approval, and promotion. |
| `workspace.ts`, `context.ts` | Workspace manifest and Context Packet. |
| `common.ts`, `model.ts` | Risk, complexity, and model tiers, Canonical Generation, route requests, route decisions, and Decision Receipts. |
| `release.ts`, `api.ts` | Release records, API errors, and health responses. |
| `app.ts`, `code.ts`, `code-edit.ts` | Live app deployments and preview hosts, the code store keys, and human code edits. |
| `code-session.ts` | Code page edit sessions: limits, expiry, requests, responses, and refusal reasons (ADR 0029). |
| `activity.ts`, `suggestions.ts` | The Project event feed, Claim state, run progress, Project stats, and the goal suggestion pills. |

## API routes

The API Worker (`workers/api/src`) serves `https://api.rhumbatron.com`. Every route except `/health` and `/v1/version` needs a signed-in user. The API reads the role of the caller from D1 (`identity.ts`). It never reads the role from the client. A caller with no access to the Project gets 404.

The roles are `owner`, `admin`, `member`, and `viewer`. `can(role, action)` in `packages/protocol/src/roles.ts` is the one permission matrix (see [Roles and permissions](#roles-and-permissions)). The Access column uses these values:

- Any role: every role of the Project.
- Contributor: the owner, an admin, or a member. A viewer gets 403.
- Manager: the owner or an admin. A member or a viewer gets 403 with a message that starts with "Only the project owner or an admin can".
- Owner: the owner only. Anyone else gets 403 with a message that starts with "Only the project owner can".

| Method | Path | Access | File |
|---|---|---|---|
| GET | `/health`, `/v1/version` | Public | `index.ts` |
| POST | `/v1/projects` | Signed-in user | `projects.ts` |
| GET | `/v1/projects` | Signed-in user | `projects.ts` |
| GET | `/v1/projects/:projectId`, `/snapshot`, `/changes` | Any role | `projects.ts` |
| POST | `/v1/projects/:projectId/changes` | Contributor. A member's request can start as `proposed` (see [Request review](#request-review)). | `projects.ts` |
| POST | `/v1/projects/:projectId/provision`, `/sandbox-smoke` | Manager | `projects.ts` |
| DELETE | `/v1/projects/:projectId` | Owner | `projects.ts` |
| GET | `/v1/changes/:changeId/tasks` | Any role | `projects.ts` |
| GET, PATCH | `/v1/projects/:projectId/settings`, `/v1/projects/:projectId` | Any role (GET), Manager (PATCH) | `project-settings.ts` |
| GET | `/v1/me` | Signed-in user | `budgets.ts` |
| PATCH | `/v1/me/budget` | Signed-in user (their own budget) | `budgets.ts` |
| GET | `/v1/changes/:changeId` | Any role | `changes.ts` |
| POST | `/v1/changes/:changeId/cancel` | Manager, or the requester of the Change (Contributor) | `changes.ts` |
| POST | `/v1/changes/:changeId/budget` | Manager | `changes.ts` |
| POST | `/v1/changes/:changeId/include`, `/v1/changes/:changeId/decline` | Manager | `changes.ts` |
| POST | `/v1/changes/:changeId/clarify` | Manager, or the requester of the Change (Contributor) | `clarify.ts` |
| GET, POST, DELETE | Members and invitations (see [Shared Projects](#shared-projects)) | See the table there | `members.ts` |
| GET | `/v1/changes/:changeId/request-conflicts` | Any role | `members.ts` |
| GET | `/v1/changes/:changeId/request-waits` | Any role | `first-come.ts` |
| POST | `/v1/changes/:changeId/choose` | Only the requester of the earlier, conflicting request | `first-come.ts` |
| GET | `/v1/projects/:projectId/board` | Any role | `board.ts` |
| GET, POST | `/v1/changes/:changeId/candidates` | Any role (GET), Manager (POST) | `candidates.ts` |
| GET | `/v1/candidates/:candidateId`, `/evidence`, `/evidence/:checkId/output` | Any role | `candidates.ts` |
| GET | `/v1/candidates/:candidateId/evidence/:checkId/screenshots/:n` | Any role | `screenshots.ts` |
| POST | `/v1/changes/:changeId/approve` | Manager | `candidates.ts` |
| POST | `/v1/candidates/:candidateId/promote` | Manager | `candidates.ts` |
| GET | `/v1/changes/:changeId/conflicts` | Any role | `conflicts.ts` |
| GET | `/v1/changes/:changeId/decisions` | Any role | `decisions.ts` |
| GET | `/v1/changes/:changeId/events`, `/claims`, `/progress` | Any role | `activity.ts` |
| GET | `/v1/projects/:projectId/events`, `/stats` | Any role | `activity.ts` |
| GET | `/v1/projects/:projectId/live` (WebSocket) | Any role | `live.ts` |
| GET | `/v1/projects/:projectId/agents` | Any role | `agents.ts` |
| GET | `/v1/projects/:projectId/cost` | Any role | `cost.ts` |
| GET | `/v1/projects/:projectId/verification` | Any role | `verification.ts` |
| GET | `/v1/projects/:projectId/workspace`, `/workspace/files` | Any role | `workspace.ts` |
| GET | `/v1/tasks/:taskId/workspace` | Any role | `workspace-manifest.ts` |
| GET | `/v1/projects/:projectId/code`, `/versions` | Any role | `code.ts` |
| GET | `/v1/changes/:changeId/changesets`, `/v1/changesets/:changeSetId/diff`, `/v1/candidates/:candidateId/diff` | Any role | `code.ts` |
| POST | `/v1/projects/:projectId/code/edits` | Manager | `code-edit.ts` |
| POST | `/v1/projects/:projectId/code/sessions` | Manager | `code-sessions.ts` |
| GET, PUT, POST, DELETE | `/v1/code/sessions/:sessionId` and its `/file`, `/rename`, `/exec`, `/submit` routes (see [Code edit sessions](#code-edit-sessions)) | Manager who opened the session | `code-sessions.ts` |
| GET | `/v1/projects/:projectId/product-graph` | Any role | `product-graph.ts` |
| GET | `/v1/projects/:projectId/suggestions` | Any role | `suggestions.ts` |
| GET | `/v1/projects/:projectId/dead-letters` | Any role | `dead-letters.ts` |
| POST | `/v1/dead-letters/:id/retry`, `/v1/dead-letters/:id/dismiss` | Manager | `dead-letters.ts` |
| GET | `/v1/projects/:projectId/releases` | Any role | `releases.ts` |
| POST | `/v1/projects/:projectId/releases/inject-failure` | Manager | `releases.ts` |
| GET | `/v1/projects/:projectId/app`, `/v1/candidates/:candidateId/preview` | Any role | `apps.ts` |
| POST, DELETE | `/v1/projects/:projectId/app` | Manager | `apps.ts` |
| POST | `/v1/projects/:projectId/rollback` | Manager | `apps.ts` |
| GET, POST | `/v1/notifications`, `/v1/notifications/count`, `/v1/notifications/read` | Signed-in user | `notifications.ts` |

`approval.requested` has `candidateId`, `policyVersion`, `reason` (why the Candidate waits for a person, one sentence), and `trigger`: `policy` (a plan gate or a policy hold) or `acceptance` (an acceptance shortfall, ADR 0026). A plan gate also has `riskTier`.

`GET /v1/notifications` lists `approval_required` and `promotion_ready` for a verified Candidate to the Project owner, the admins (severity `action`), and the requester (severity `attention`). The body has the reason, and `href` is the Change page.

`POST /v1/projects/:projectId/changes` makes the `clientRequestId` unique for each requester. Two users can send the same `clientRequestId` without a collision. A request without `budgetUsd` gets the Project default budget (see [Project settings](#project-settings)).

## Shared Projects

The owner or an admin shares a Project by email with a role (`workers/api/src/members.ts`). A role decides who can act. The system decides between requests, and a role never does (ADR 0025, ADR 0028).

| Method | Path | Access | Result | Main errors |
|---|---|---|---|---|
| GET | `/v1/projects/:projectId/members` | Any role | `MembersResponse`: `role` (the caller's role), `members` (`userId`, `name`, `email`, `role`, `joinedAt`, `isYou`, ordered by rank), and `invitations` (`id`, `email`, `role`, `createdAt`, `expiresAt`). A manager gets the pending invitations and the email of each member. Anyone else gets an empty `invitations` list and only their own email. | 404 |
| POST | `/v1/projects/:projectId/invitations` | Manager. Only the owner invites an admin. | `201` with the invitation (`id`, `email`, `role`, `createdAt`, `expiresAt`). Body: `email` and `role` (`admin`, `member`, or `viewer`; default `member`). An invitation is valid for 7 days. A repeat for the same pending email returns that invitation, with the new role. | 400, 403, 404, 409 (archived Project, or the email already has access) |
| DELETE | `/v1/projects/:projectId/invitations/:invitationId` | Manager. Only the owner revokes an admin invitation. | The invitation with status `revoked`. A repeat is safe. | 403, 404 |
| PATCH | `/v1/projects/:projectId/members/:userId` | Manager for a member or viewer. The owner for a change to or from `admin`. | `userId` and `role`. Body: `role` (`admin`, `member`, or `viewer`). The owner role never changes. The same role again writes nothing. | 400, 403, 404 (no such member) |
| DELETE | `/v1/projects/:projectId/members/:userId` | Manager for a member or viewer, the owner for an admin, or any role except the owner for their own user ID (leave) | `userId` and `removed: true`. The owner row cannot be removed. A person who leaves gets their open requests cancelled first. A removed person gets their `proposed` requests cancelled. | 403, 404 (no such member) |
| GET | `/v1/invitations` | Signed-in user | Up to 20 pending invitations for the verified emails of the caller. Each item has `projectName` and `invitedBy`. | None |
| POST | `/v1/invitations/:invitationId/accept` | The invited user | `projectId` and `role` (the role of the invitation). A repeat by the same user is safe. | 404, 409 (revoked or expired) |
| GET | `/v1/changes/:changeId/request-conflicts` | Any role | Up to 10 cross-request conflicts and duplicates of the Change: verdict, round, both goals and titles, both requesters, the cited criteria or covered quotes, the policy, and the winner. | 404 |
| POST | `/v1/changes/:changeId/clarify` | Manager, or the requester of the Change (Contributor) | `ClarifyChangeOutcome`: `recorded` with `changeStatus`, `action`, `round`, and `repeated`. | 400 (malformed body, unknown question), 403, 404, 409 (not waiting for an answer) |

An invitation binds to a verified email of the signed-in user. If the email is not a verified email of the user, `accept` returns the same 404 as for a missing invitation. The membership binds to the user ID, not to the email.

`clarify` takes one of these bodies:

- `{ answers: [{ questionId, text }] }`: 1 to 3 answers to questions of the open round. The text is a picked option or free text. The Root Planner decides the part that an unanswered question leaves open. The Change returns to `compiling` with the answers in its goal context.
- `{ action: "proceed_anyway" }`: the Change plans without the intake gate and without another question.
- `{ action: "withdraw" }`: the Change is cancelled with the reason "Withdrawn by the requester".

A repeat of the caller's last command returns `repeated: true`. The intake gate asks at most one round. A Change gets at most 3 rounds of questions in total. A Change that gets no answer for 7 days is cancelled.

### Roles and permissions

Access to a Project does not give permission for every action. `PERMISSIONS` in `packages/protocol/src/roles.ts` lists the roles for each action, and the API checks it with `can(role, action)`. The rank of each role (`ROLE_RANK`: owner 0, admin 5, member 10, viewer 30) only orders lists.

| Action | Roles |
|---|---|
| Read the Project pages | owner, admin, member, viewer |
| Send a request | owner, admin, member |
| Answer, withdraw, or cancel your own request | owner, admin, member |
| Answer or cancel the request of another person | owner, admin |
| Include or decline a `proposed` request | owner, admin |
| Raise a Change budget; compose, approve, and promote a Candidate | owner, admin |
| Publish an app, remove an app, roll back, and inject a release failure | owner, admin |
| Edit code directly; retry or dismiss stopped work (dead letters) | owner, admin |
| Provision the Project and run checks | owner, admin |
| Invite people; change the role of, or remove, a member or a viewer | owner, admin |
| Invite an admin; change the role of, or remove, an admin; make an admin | owner |
| Change the settings: name, default Change budget, member request review | owner, admin |
| Remove the Project | owner |
| Leave the Project | admin, member, viewer |

### Request review

| Method | Path | Access | Result | Main errors |
|---|---|---|---|---|
| POST | `/v1/changes/:changeId/include` | Manager | `changeId`, `status` (`created`, or the later status on a repeat), and `repeated`. Body `{}`. The ChangeWorkflow starts once, with the Change ID as instance ID. | 403, 404, 409 (not `proposed`) |
| POST | `/v1/changes/:changeId/decline` | Manager | `changeId`, `status` (`declined`), and `repeated`. Body `{ reason? }`, at most 500 characters. | 400, 403, 404, 409 (not `proposed`) |
| GET | `/v1/projects/:projectId/board` | Any role | `BoardResponse`: `people` (`userId`, `name`, `role`, `isYou`, `counts` with `proposed`, `active`, `shipped`, `notBuilt`), `cards` (`changeId`, `title`, `goal`, `status`, `column`, `requester` with `role`, `tasks` with `done` and `total`, `agents` with `agentId`, `taskTitle`, `tier`, `state`, `review`, `createdAt`, `updatedAt`, `generation`, and `waiting` for an `awaiting_choice` or `queued` Change: `state` (`choosing` or `after_first`), `firstChangeId`, `firstTitle`, `firstRequester`), and `canReview`. The newest 100 Changes; the `shipped` and `not_built` columns show the newest 20 each. | 404 |

While the Project setting `memberRequestReview` is `true` (the default), `POST /v1/projects/:projectId/changes` by a member creates the Change with status `proposed`. It starts no ChangeWorkflow and makes no model call. The requests of the owner and the admins never need review. The requester withdraws a `proposed` request with `POST /v1/changes/:changeId/cancel`. [Shared Projects](../architecture/shared-projects.md#request-review) describes the flow and the Board columns.

### Fields on Project and Change responses

| Response | Field | Meaning |
|---|---|---|
| `GET /v1/projects` and `GET /v1/projects/:projectId` | `role` | `owner`, `admin`, `member`, or `viewer`. The caller's role in the Project. |
| Every response that names a Change | `title` | Short display title, at most 48 characters. The Root Planner writes it with the Work Graph (D1 `changes.title`, migration `0028_change_titles.sql`). Before planning, after a planning failure, and for a Change created with `startPlanning: false`, it is `fallbackTitle(goal)`: the first sentence or clause of the goal without opening filler such as "please" or "I want", at most 6 words. The responses are the Change, the Change list, the request-conflict sides, the cost, verification, workspace, and Product Graph Change lists, and the code version `change`. Agent tasks carry it as `changeTitle`. Notification bodies use it in place of the goal. `goal` stays the full request text. |
| Change list and `GET /v1/changes/:changeId` | `requester` | Who asked for the Change: `userId`, `name`, `rank` (the rank of the requester's role at request time, display order only), `role` (the requester's current role, null after they left), and `isYou`. |
| `POST /v1/projects/:projectId/changes`, the Change list, and `GET /v1/changes/:changeId` | `review` | `state` (`not_needed`, `proposed`, `included`, or `declined`), `decidedBy` (`userId`, `name`, or null), `decidedAt`, and `reason` (the decline reason). A withdrawn `proposed` request keeps `state: proposed`. |
| Change list and `GET /v1/changes/:changeId` | `outcome` | How the request ended after the intake gate or the cross-request check. Null when no check decided it. |
| Change list and `GET /v1/changes/:changeId` | `supersedesChangeId` | Null for every request the API creates. |
| Change list and `GET /v1/changes/:changeId` | `clarification` | `ChangeClarification` while the Change is `needs_input`, else null: `kind` (`unclear`, `duplicate`, `conflict`), `summary`, `questions` (`id`, `text`, optional `options`: 2 to 4 readings), `relatedChangeId`, `relatedGoal`, `relatedTitle` (the related Change's title, added on read), `askedAt`, `round` (1 to 3). Each question asks one thing and has its own answer. |
| `GET /v1/changes/:changeId` | `assumptions` | The small product details that the Root Planner decided because the goal left them open, as plain sentences (D1 `changes.assumptions_json`, migration `0032_change_assumptions.sql`). Empty before planning. |

### Change statuses for requests

| Status | Meaning |
|---|---|
| `proposed` | A member's request waits for an owner or admin to include it. No ChangeWorkflow runs and no model call is made. |
| `declined` | An owner or admin declined the proposed request. Terminal. |
| `not_selected` | The request lost a conflict. The earlier requester kept their version (or did not choose within 7 days), or the same requester asked again and the later request replaces the earlier one. The Change does no more work. |
| `awaiting_choice` | The request conflicts with an earlier request of another person. It waits for that person to choose. No planning spend. |
| `queued` | The earlier requester chose to apply this request after theirs. It plans again when the earlier request promotes or ends. |
| `needs_input` | The request is unclear, repeats another request or the current app, or conflicts and the system could not decide. The Change waits for an answer (`clarification`). |

### Request outcome kinds

`outcome.kind` has one of these values. The outcome also has `reason`, `winnerChangeId`, and `decidedBy` (`system:same_requester`, `system:first_come` for a choice that expired, or the user ID of the person who declined or chose).

| Kind | Meaning |
|---|---|
| `selected` | The request won the conflict check, or it has no conflict. |
| `not_selected` | The request lost the conflict check. `winnerChangeId` names the request that won. |
| `replaces` | The request won against an earlier request that had already promoted. |
| `duplicate` | The request closed as a duplicate. `winnerChangeId` names the related request. It is null when the current app already delivers the request. |
| `declined` | An owner or admin declined the proposed request. `reason` is the decline reason, or null. |
| `follows` | The earlier requester chose to apply this request after theirs. `winnerChangeId` names the earlier request. |

### First-come conflicts

A supported conflict between requests of two people makes the later request wait for the earlier requester (ADR 0032, [Shared Projects](../architecture/shared-projects.md#first-come-requests-of-two-people)).

| Method | Path | Access | Result | Main errors |
|---|---|---|---|---|
| GET | `/v1/changes/:changeId/request-waits` | Any role | Up to 10 `RequestWait` items where the Change is the earlier or the later request, newest first: `id`, `firstChangeId`, `firstTitle`, `firstRequester`, `laterChangeId`, `laterTitle`, `laterGoal`, `laterRequester`, `conflicts` (up to 3 criterion pairs as text), `choice` (`keep_mine`, `apply_theirs`, `expired`, `moot`, or null), `chosenAt`, `askedAt`, `expiresAt`, `laterStatus`, and `canChoose` (true only for the earlier requester while the choice is open). | 404 |
| POST | `/v1/changes/:changeId/choose` | The requester of the earlier request, while they belong to the Project. The owner, the admins, and the later requester get 403. | `ChooseOutcome`: `recorded` with `changeId`, `choice`, `status` (the later request's status after the choice), and `repeated`. Body `{ "choice": "keep_mine" }` or `{ "choice": "apply_theirs" }`. `:changeId` is the waiting (later) request. | 400, 403, 404 (no wait), 409 (another choice recorded, or the request does not wait) |

Events on the later request:

| Event | Payload |
|---|---|
| `change.choice.requested` | `choiceId`, `firstChangeId`, `askedUserId`, `conflictId`, `status: "awaiting_choice"` |
| `change.choice.made` | `choiceId`, `firstChangeId`, `choice` (`keep_mine`, `apply_theirs`, `expired`, `moot`), `status` (the next status) |
| `change.resumed` | `choiceId`, `firstChangeId`, `baseGeneration`: the request plans again on the current canonical tree |

Notifications: `request_choice_needed` (an action item for the earlier requester only) and `request_choice_made` (the later requester, after `apply_theirs`). After `keep_mine` or an expired choice, the later requester gets `request_not_selected`.

## Project settings

The routes are in `workers/api/src/project-settings.ts`. The web page is `/projects/:projectId/settings`.

| Method | Path | Access | Result | Main errors |
|---|---|---|---|---|
| GET | `/v1/projects/:projectId/settings` | Any role | `name`, `slug`, `createdAt`, `role`, `defaultBudgetUsd`, `effectiveDefaultBudgetUsd`, `limits` (`minBudgetUsd`, `maxBudgetUsd`), `memberRequestReview`, `monthlyBudgetUsd` (the Project monthly budget, or `null`), and `monthSpendUsd` (this month's model spend of the Project, read only). | 404 |
| PATCH | `/v1/projects/:projectId` | Manager | The same body as the GET. Request body: one or more of `name` (1 to 80 characters), `defaultBudgetUsd` (0.5 to 25 USD, or `null` for the built-in default of 3 USD), `memberRequestReview` (boolean), and `monthlyBudgetUsd` (1 to 100 USD, or `null` for no Project cap). The same values again write nothing. A higher or removed `monthlyBudgetUsd` resumes the Changes that the Project budget stopped. | 400, 403, 404, 409 (archived Project) |

`projects.default_budget_usd` (migration `0027_project_settings.sql`) stores the default budget. `projects.member_request_review` (migration `0029_roles_and_request_review.sql`, default 1) stores the review setting. `projects.monthly_budget_usd` (migration `0031_budget_scopes.sql`) stores the Project monthly budget.

## Budgets

The routes and helpers are in `workers/api/src/budgets.ts`. The schemas are in `packages/protocol/src/budget.ts`. See [Costs runbook, Budget scopes](../operations/costs.md#budget-scopes) and [ADR 0030](../adr/0030-budget-scopes.md).

| Method | Path | Result | Main errors |
|---|---|---|---|
| POST | `/v1/projects/:projectId/changes` | The body can set `budgetScope`: `change` (default), `project`, or `account`. `budgetUsd` caps only scope `change`; without it the Project default applies. Scope `project` needs a Project monthly budget, and scope `account` needs a monthly budget of the requester. | 400 with `details.reason` `no_budget_set` |
| GET | `/v1/changes/:changeId` | The Change has `budget`: `scope`, `capUsd` (null for `project` and `account`), `spentUsd`, and `blockedBy` (`change_budget`, `project_budget`, `account_budget`, `monthly_model_spend`, or null). | 404 |
| GET | `/v1/projects/:projectId/cost` | Adds `projectBudget`: `capUsd` (or null), `spentUsd`, and `month` (`YYYY-MM`). Each Change row has `budgetScope`. | 404 |
| GET | `/v1/me` | `userId`, `name`, `email`, `monthlyBudgetUsd` (or null), `monthSpendUsd` (this month, across every Project), and `month`. | 401 |
| PATCH | `/v1/me/budget` | Body `{ monthlyBudgetUsd: number \| null }` (1 to 100 USD). Returns the same body as `GET /v1/me`. A higher or removed budget resumes the caller's Changes that their budget stopped. | 400 |

`users.monthly_budget_usd` and `changes.budget_scope` (migration `0031_budget_scopes.sql`) store the user budget and the scope.

## Code edit sessions

The owner or an admin (`can(role, "code.edit")`) opens an edit session on the Code page (ADR 0029). The routes are in `workers/api/src/code-sessions.ts`. The API calls the integration Worker through the `INTEGRATION` service binding (`workers/integration/src/code-sessions.ts`). A session belongs to the person who opened it. Any other caller gets 404 for it. A caller without `code.edit` gets 403.

| Method | Path | Result | Main errors |
|---|---|---|---|
| POST | `/v1/projects/:projectId/code/sessions` | `201` with `CodeSessionView`: `sessionId`, `projectId`, `baseGeneration`, `baseCommit`, `baseTree`, `createdAt`, `expiresAt` (the earlier of the idle and 2-hour limits), `hardExpiresAt`, `idleTimeoutMs`, and `changedFiles`. One open session per person per Project: a repeat returns the open session. The Sandbox does not start. | 403, 404, 409 (archived Project, no source) |
| GET | `/v1/code/sessions/:sessionId` | `CodeSessionDetail`: the view plus `files` (`path`, `size`, `changed`) and `deletedFiles`. | 404, 410 (ended or expired) |
| GET | `/v1/code/sessions/:sessionId/file?path=` | `path`, `content`, `size`, `encoding: "utf8"`, `changed`. | 400 (path), 404, 410, 413 (over 256 KB), 415 (binary) |
| PUT | `/v1/code/sessions/:sessionId/file` | Body `{ path, content }`: creates or changes the file. Returns `changedFiles` and `expiresAt`. | 400 (path), 409 (a command runs), 410, 413 (over 256 KB, or more than 200 changed files), 415 (binary) |
| DELETE | `/v1/code/sessions/:sessionId/file?path=` | Deletes the file. Same result as PUT. | 400, 404, 409, 410 |
| POST | `/v1/code/sessions/:sessionId/rename` | Body `{ from, to }`. Same result as PUT. | 400, 404, 409 (target exists, a command runs), 410 |
| POST | `/v1/code/sessions/:sessionId/exec` | Body `{ command (1 to 2,000 characters), cwd? }`. Returns `exitCode` (124 at the timeout), `stdout`, `stderr`, `durationMs`, `truncated`, `timedOut`, `changedFiles`, and `expiresAt`. | 400, 409 (a command runs), 410, 429 `sandbox_cap`, 503 `sandbox_busy`, 503 `sandbox_unavailable` |
| POST | `/v1/code/sessions/:sessionId/submit` | Body `{ message (1 to 200 characters), authorName? }`. `201` with `changeId`, `changeSetId`, `candidateIds`, and `status: "created"`; a repeat returns `200` with `status: "existing"`. The session ends. | 409 (`no_change`, `stale_base`, a command runs), 410 |
| DELETE | `/v1/code/sessions/:sessionId` | `sessionId` and `status`. Ends the session and deletes the fork and the edits. A repeat is safe. | 404 |

Every refusal has `error.details.reason`, one of `CodeSessionRefusalReason` in `code-session.ts`.

A path must be under the repository root. It must have no `..` part and no `.git` part at any depth. A file must be text (no NUL byte, valid UTF-8) and at most 256 KB.

A terminal command runs in the session checkout `/workspace/edit-<hex>` of the Project Sandbox. It runs as an unprivileged user of the session, with no token or secret in its environment. The network policy of the Project Sandbox applies. The timeout is 120 s. Each output stream keeps its last 64 KB. After the command, every process of the session stops. The files that the command changed become session edits. Each command reserves 480 s on the monthly Sandbox meter (`SANDBOX_MONTHLY_SECONDS`). The reservation then settles to the time that the command used plus a 120 s idle tail.

Sandbox refusals of a command:

| Reason | HTTP | Cause |
|---|---|---|
| `sandbox_cap` | 429 | The monthly Sandbox meter is used up. |
| `sandbox_busy` | 503 | The Sandbox did not start (`ContainerUnavailableError`), or the readiness probe got no answer in 120 s. The account runs one Sandbox container at a time, and agents or Candidate checks of another Project can use it. The message is "The Sandbox is busy with work for another Project. Only one runs at a time. Try again in a few minutes." |
| `sandbox_unavailable` | 503 | The Sandbox cannot run commands as an unprivileged user, or the command failed in the Sandbox. |

The first command of a session can cold-start the container, so it probes the checkout with the 120 s setup timeout. A failed probe writes `code_session.probe_failed` to Workers Logs with the session, the Project, and the error. The Code page terminal shows the message of the server for each refusal.

A session ends 10 minutes after its last request (`CODE_SESSION_IDLE_MS`) or 2 hours after it opened (`CODE_SESSION_MAX_MS`). Each request checks the limits first. The daily maintenance sweep ends the overdue sessions of all Projects. When a session ends, Rhumbatron deletes its fork and the edits that are not submitted.

D1 tables (migration `0030_code_sessions.sql`):

| Table | Content |
|---|---|
| `code_sessions` | One row per session: `id`, `project_id`, `user_id`, `base_generation`, `base_commit`, `base_tree`, `repo`, `status` (`open`, `submitted`, `closed`, `expired`), `close_reason`, `revision`, `exec_started_at` (the command lock), `sandbox_awake_until`, `created_at`, `last_used_at`, `expires_at` (the 2-hour limit), `closed_at`, `change_id`, and `fork_deleted_at`. |
| `code_session_files` | The edits of an open session: the full text of a written file, or a deleted path. The end of the session deletes them. |
| `code_session_commands` | Audit log: `session_id`, `command`, `cwd`, `exit_code`, `duration_ms`, and `at`. It never holds the output. |

Events: `code.session.opened` (`baseGeneration`, `baseTree`), `code.session.closed` (`reason`: `discarded`, `idle`, `max_age`, or `archived`; `status`), and `code.session.submitted` (`changeId`). The causal router treats them as informational.
