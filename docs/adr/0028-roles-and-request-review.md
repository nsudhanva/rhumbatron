# ADR 0028: Project roles and member request review

## Context

A request that needs no review starts a ChangeWorkflow at once. Then the intake gate, the
planner, and the agents spend model budget on it. Shared Projects (ADR 0023) have three needs:

- A team needs more than one person who administers the Project. With only one owner, every
  approval, promotion, and invitation waits for that one person.
- A Project owner needs people who can read the Project but not send work, for example a reviewer
  or a customer.
- The owner needs a gate before a request of a non-admin spends model budget. The system still
  decides between requests (ADR 0025), but a person decides whether a request enters the system.

## Decision

- Four roles per Project in `project_members`: `owner`, `admin`, `member`, and `viewer`. Each
  Project has one owner. Nobody can assign, change, or remove the owner role. The rank
  (`ROLE_RANK`: owner 0, admin 5, member 10, viewer 30) only orders lists. Migration
  `0029_roles_and_request_review.sql` maps every `collaborator` row and pending invitation to
  `member` and keeps all rows.
- One permission matrix, `PERMISSIONS` in `packages/protocol/src/roles.ts`. The API checks every
  action with `can(role, action)`. The web uses the same function to hide controls. A critical test
  spells out the full matrix.
  - Every role reads the Project.
  - The owner, the admins, and the members send requests and answer, withdraw, or cancel their own.
  - The owner and the admins also review requests, cancel or answer any request, raise budgets,
    compose, approve, promote, roll back, publish or remove the app, resolve stopped work, edit
    code, invite people, change the role of a member or viewer, and change the settings.
  - Only the owner makes, changes, or removes an admin, and deletes the Project.
  - Every role except the owner can leave.
- Member request review. The Project setting `memberRequestReview` (D1
  `projects.member_request_review`, default on) makes a member's request start as `proposed`. A
  `proposed` Change has no ChangeWorkflow, makes no model call, and has no admission in
  ProjectRootDO, so the request comparison never sees it. The requests of the owner
  and the admins never need review.
- An owner or admin includes (`POST /v1/changes/:changeId/include`) or declines
  (`POST /v1/changes/:changeId/decline`) a `proposed` request. Include moves it to `created` at the
  current Canonical Generation and starts the ChangeWorkflow with the Change ID as instance ID,
  the same path as a request without review. Decline makes it `declined`, a terminal status, with
  outcome `declined` and an optional reason. Both are guarded on `proposed` and idempotent. The
  requester withdraws a `proposed` request with the normal cancel.
- Events `change.proposed`, `change.included`, and `change.declined`. Notifications
  `request_proposed` (owner and admins), `request_included` and `request_declined` (requester).
- The intake gate counts a `proposed` request as open. So a later duplicate request gets a
  question with the name of the person who proposed the first request.
- The Board (`GET /v1/projects/:projectId/board`) shows the newest 100 Changes as cards in six
  columns, with the people and their counts, in one D1 batch.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| A separate `requester` role that always needs review, next to a `member` role that never does | Two roles for one difference. One `member` role and one Project setting give the same control. |
| Review by a model before a person | A model never rejects a request at intake (ADR 0025). Review is a decision about who may spend the Project's budget, which belongs to a person. |
| Start the ChangeWorkflow at create and pause it before the intake gate | The paused instance holds Workflow state for days, and a pause that fails open spends model budget. A row without an instance costs nothing. |
| Use the role or rank to decide a conflict between requests | The role of a person says nothing about which request fits the app (ADR 0025). The earlier requester chooses (ADR 0032). |

## Consequences

- The migration makes each `collaborator` a `member`, with the review setting on. A request of a
  member then waits for the owner or an admin. The owner or an admin turns the setting off in
  Settings so that member requests start at once.
- An admin can do every operational action. Only Project deletion and the admin role stay with
  the owner.
- A `proposed` request costs one D1 row and one event. Nothing else runs until a person includes
  it.
- The members response returns `joinedAt` and each role. Invitations carry their role.
