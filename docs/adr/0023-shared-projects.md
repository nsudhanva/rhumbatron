# ADR 0023: Shared Projects

## Context

Two people work in one Project from separate accounts. Both can send requests at the same time,
and two requests can contradict each other (for example "newest first" and "oldest first").
Access to a Project does not grant each action. API routes check the role of the user. The
ChangeWorkflow compares each Change with the other requests of the Project. ADR 0025 decides how
the system chooses between requests. See
[Shared Projects](../architecture/shared-projects.md).

## Decision

- Share per Project. Use the D1 table `project_members` with the roles of ADR 0028: `owner`,
  `admin`, `member`, and `viewer`. Its `rank` only orders the members list. Do not use Clerk
  Organizations.
- An invitation (`project_invitations`) binds only to a Clerk-verified email of the signed-in
  user. The grant binds to the immutable user ID. An invitation expires after 7 days. Clients never
  send a role.
- The owner is the `owner` row of the Project or a member of the organization that owns the
  Project (`projectRole` in `workers/api/src/identity.ts`). A personal organization has one member.
- Access is not permission. A member can view the Project, create Changes, and cancel and answer
  their own Changes. A viewer can only view the Project. These actions belong to the owner and the
  admins, and the API answers `403` with a reason for any other role:
  - share the Project, manage members, and change Project settings;
  - approve a release, promote a Candidate, compose a Candidate, and roll back;
  - publish the app, remove the app, provision the Project, and run checks;
  - edit code directly, raise a budget, cancel the request of another person, resolve stopped
    work, and inject a release failure.

  Only the owner removes the Project and manages admins (ADR 0028). No role decides between
  requests.
- One Change per request. The Change stores `created_by` as the requester, and `requester_rank`,
  the role of the requester at creation, for display only.
- Scope registration is serialized. After planning, the ChangeWorkflow calls `registerScope` on
  ProjectRootDO (`workers/coordinator/src/request-scopes.ts`) with the criteria (each has an ID) and
  the semantic resources. ProjectRootDO returns the earlier active Changes with a scope, in
  registration order. The later Change compares itself with each of them. Each pair gets one
  comparison per clarification round and one per plan after a first-come wait.
- When an earlier Change has no scope yet, the later Change waits for it: 10 checks, 15 s apart.
  After that, the earlier Change without a scope counts as overlapping.
- Comparison (`workers/integration/src/request-policy.ts`, `request-check.ts`):
  1. A deterministic pass checks shared resource tokens and shared routes in the criteria.
  2. A pair that overlaps gets one Sonnet review of the criteria. The review returns
     `independent`, `compatible`, `conflicting`, or `duplicate`, and cites criterion IDs.
  3. Application code validates each citation. An invalid citation or an abstention counts as a
     conflict that is not confirmed.
  4. Clef and Haiku never confirm a conflict alone.
  5. At most 4 overlapping pairs get a review per Change.
- A supported conflict between two people follows the first-come rule of
  [ADR 0032](./0032-first-come-conflicts.md): the earlier request keeps working, and the later
  request waits for the earlier requester's choice. When one person asks twice, the later request
  replaces the earlier one. The earlier Change becomes `not_selected`, and Rhumbatron cancels its
  running work. An earlier Change with a promoted Candidate stays, and the later Change gets the
  outcome `replaces`.
- The recompose guard: `recomposeDecision` refuses a `not_selected`, `cancelled`, or `needs_input`
  Change, and a Change with the outcome `not_selected` or `duplicate`. Without the guard, the
  stale-Candidate recomposition merges without a conflict and ships the losing request over the
  winner.
- `ChangeStatus` has `not_selected` (terminal), `needs_input` (ADR 0025), and `awaiting_choice`
  and `queued` (ADR 0032).

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Clerk Organizations and paid roles | Needs a paid Clerk feature. Adding Bob to the organization of Alice shows him her other Projects. |
| Read other Changes at plan time, with no ProjectRootDO serialization | Two planners can run at the same moment, and each sees the other without a scope. Both look independent, and both spend model budget. Serialization in ProjectRootDO makes the order exact. |
| Haiku or Clef alone confirms a conflict | Unclear semantics need a Sonnet review, and Clef-flash never confirms a conflict. A cheap model also cannot stop a Change alone. |
| Promoted criteria become Project invariants, to catch missed conflicts | It needs protected tests that an agent cannot edit. |
| Remove only the losing criteria of the later request | The later requester sees a request that is rejected in part, without a person deciding (ADR 0032). |

## Consequences

- Bob never sees the other Projects of Alice. As a member, he cannot take the actions of the owner
  and the admins.
- Each pair of overlapping requests costs one Sonnet review, about $0.01. The limit is 4 pairs per
  Change.
- The design adds D1 migration `0022_shared_projects.sql` and no Cloudflare resource.
- Known limitation: a conflict that both requests hide behind unrelated words and unrelated
  resources can pass the review. Then both Changes ship in sequence, and the later one wins. The
  tests of the earlier Change usually fail on the later tree and stop it. An agent can edit those
  tests. Report such a miss as an incident. Never mark both requests as satisfied without
  Evidence.
