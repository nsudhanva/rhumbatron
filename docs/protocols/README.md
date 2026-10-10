# Protocols

The Zod schemas in `packages/protocol/src` are the protocol source of truth. No separate protocol
documents exist yet.

| File | Content |
|---|---|
| `event.ts` | Event envelope and Event types (AGENTS.md section 17). |
| `command.ts` | Queue command envelope (section 20). |
| `project.ts` | Project, Change, policies, and create requests. |
| `work-graph.ts` | Work Graph and Task. |
| `conflict.ts` | Intent, Challenge, and conflict reports (sections 26 and 32). |
| `candidate.ts` | Candidate, Evidence, Verification Plan, approval, and promotion (sections 34 and 36). |
| `workspace.ts`, `context.ts` | Workspace manifest and Context Packet (section 27). |
| `release.ts`, `api.ts` | Release records, API errors, and health responses. |

## Shared Projects

An owner shares a Project with a collaborator by email. The design is in [phase-17a-shared-projects.md](../plans/phase-17a-shared-projects.md). The routes are in `workers/api/src/members.ts`. All routes need a signed-in user. The API never reads a role or rank from the client.

The owner has rank 0. A collaborator has rank 10. The `priority_wins` policy uses the rank to decide between two conflicting requests.

### Routes

| Method | Path | Who may call | Result | Main errors |
|---|---|---|---|---|
| GET | `/v1/projects/:projectId/members` | Owner or collaborator | `role`, `members`, and `invitations`. Only the owner gets the pending invitations and the email of each member. | 404 |
| POST | `/v1/projects/:projectId/invitations` | Owner | `201` with the new invitation (`id`, `email`, `createdAt`, `expiresAt`). An invitation is valid for 7 days. | 403, 404, 409 (archived Project, or the email already has access) |
| DELETE | `/v1/projects/:projectId/invitations/:invitationId` | Owner | The invitation with status `revoked`. A repeat is safe. | 403, 404 |
| DELETE | `/v1/projects/:projectId/members/:userId` | Owner | `removed: true` or `false`. The owner row cannot be removed. | 403, 404 |
| GET | `/v1/invitations` | Any signed-in user | Pending invitations for the verified emails of the caller. Each item has `projectName` and `invitedBy`. | None |
| POST | `/v1/invitations/:invitationId/accept` | The invited user | `projectId` and `role`. A repeat by the same user is safe. | 404, 409 |
| GET | `/v1/changes/:changeId/request-conflicts` | Owner or collaborator | The cross-request conflicts of the Change: both goals, both requesters, the cited criteria, the policy, and the winner. | 404 |
| POST | `/v1/changes/:changeId/override` | Owner | `202` with the outcome. The API creates a new linked Change with the goal of the request that was not selected. | 403, 404, 409 |

An invitation binds to a verified email of the signed-in user. If the email is not the user's email, `accept` returns the same 404 as for a missing invitation. The membership binds to the user ID, not to the email.

`override` returns 409 if the Change status is not `not_selected` or `awaiting_owner`. It also returns 409 when the integration Worker refuses the override.

### Owner-only actions

Access to a Project does not give permission for each action. A collaborator can view the Project, create Changes, and cancel their own Changes. These routes return 403 with a message that starts with "Only the project owner can" when a collaborator calls them:

- Share, revoke an invitation, and remove a member.
- Override a request.
- Cancel the Change of another person.
- Raise a Change budget.
- Compose a Candidate, approve a release, and promote a Candidate.
- Publish an app, remove an app, and roll back.
- Edit code directly.
- Provision the Project, run checks, and remove the Project.
- Retry or dismiss stopped work (dead letters).

### New fields on existing responses

| Response | Field | Meaning |
|---|---|---|
| `GET /v1/projects` and `GET /v1/projects/:projectId` | `role` | `owner` or `collaborator`. The caller's role in the Project. |
| Change list and `GET /v1/changes/:changeId` | `requester` | Who asked for the Change: `userId`, `name`, `rank`, and `isYou`. |
| Change list and `GET /v1/changes/:changeId` | `outcome` | How the request ended after the cross-request check. Null when no check decided it. |
| Change list and `GET /v1/changes/:changeId` | `supersedesChangeId` | The ID of the Change that an override replaced. Null for a normal request. |

`POST /v1/projects/:projectId/changes` makes the `clientRequestId` unique for each requester. Two users can send the same `clientRequestId` without a collision.

### New Change statuses

| Status | Meaning |
|---|---|
| `not_selected` | A conflicting request lost to a request with a higher priority. The Change does no more work. The owner can override it. |
| `awaiting_owner` | Two conflicting requests have the same rank. The Change waits until the owner decides. |

### Request outcome kinds

`outcome.kind` has one of these values. The outcome also has `reason`, `winnerChangeId`, and `decidedBy`.

| Kind | Meaning |
|---|---|
| `selected` | The request won the conflict check, or it has no conflict. |
| `partially_selected` | The request lost one criterion. The planner made a new plan without that criterion. |
| `not_selected` | The request lost the conflict check. `winnerChangeId` names the request that won. |
| `replaces` | The request is a new Change that an owner override made. It replaces `supersedesChangeId`. |
| `overridden` | The owner chose another request. This request lost. |
