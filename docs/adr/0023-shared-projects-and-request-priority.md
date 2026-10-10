# ADR 0023: Shared Projects and request priority

## Status
Accepted, 2026-10-10. Implemented as Phase 17a (`docs/plans/phase-17a-shared-projects.md`).
It narrows `phase-17-teams.md` to one tested workflow.

## Context
Two people must work in one Project from separate accounts. Both can send requests at the same
time, and two requests can contradict each other (for example "newest first" and "oldest first").
The owner must be able to override the other user. The UI must show which requests were selected.

Before this ADR, every API route checked only `canAccessProject`, which returns a Boolean. A second
user with access could approve, promote, archive and raise budgets. The Change workflow had no
step that compares one Change with another.

Claude (Opus) wrote the first position. codex and agy reviewed it. Their critiques changed most of
the design.

## Decision
- Share per Project. Use the D1 table `project_members` (`owner` rank 0, `collaborator` rank 10).
  Do not use Clerk Organizations.
- An invitation (`project_invitations`) binds only to a Clerk-verified email of the signed-in user.
  The grant binds to the immutable user ID. An invitation expires after 7 days. Clients never send
  a role or rank. A Project has one owner.
- Access is not permission. A collaborator can view the Project, create Changes and cancel their
  own Changes. Approve, promote, roll back, archive, delete, share, code edits, budget raises and
  cancelling another user's Change are owner-only. A collaborator gets `403` with a reason.
- One Change per request. The Change stores `created_by` as the requester and `requester_rank` at
  creation. A later rank change does not rewrite history.
- Scope registration is serialized. After planning, the ChangeWorkflow calls `registerScope` on
  ProjectRootDO (`workers/coordinator/src/request-scopes.ts`) with the criteria (each has an ID)
  and the semantic resources. Root returns the earlier scoped active Changes in registration
  order. The later Change compares itself with each of them, so each pair is compared once.
- A Change that registers while an earlier Change has no scope waits for it: 10 checks, 15 seconds
  apart. After that, the unscoped Change counts as overlapping.
- Comparison (`workers/integration/src/request-policy.ts`, `request-check.ts`):
  1. A deterministic pass checks shared resource tokens and shared routes in the criteria.
  2. A pair that overlaps gets one Sonnet review of the criteria. The review returns
     `independent`, `compatible` or `conflicting`, and cites criterion IDs.
  3. Application code validates each citation. An invalid citation or an abstention counts as
     `conflicting`.
  4. Clef and Haiku never confirm a conflict alone (AGENTS.md 32.3, 34.4.2).
- Policy `priority_wins` (default): the lower rank number wins. For the same requester, the later
  request supersedes the earlier one. For different requesters with the same rank, the Change
  becomes `awaiting_owner`. Executable Evidence still gates every release.
- Partial selection: a loser that has not dispatched work and has other criteria is re-planned
  without the losing criteria. In all other cases the loser becomes `not_selected`, and running
  work is cancelled.
- The recompose guard: `recomposeDecision` refuses a `not_selected`, `cancelled` or overridden
  Change. Without it, the stale-Candidate recompose merges cleanly and ships the loser over the
  winner.
- Override (owner only) makes a new linked Change with the loser's goal, the loser's requester and
  `supersedes_change_id`. The decision record names the owner. If the old winner has not promoted,
  the API cancels it with "Replaced by owner". The comparison does not reopen a pair that has an
  owner override. Workflow instance IDs cannot restart, and history stays immutable.
- `ChangeStatus` gains `not_selected` (terminal) and `awaiting_owner`.

## Alternatives considered
| Alternative | Why it lost |
|---|---|
| Clerk Organizations and paid roles | Needs a paid Clerk feature. Adding Bob to Alice's organization exposes her other Projects. Per-Project membership gives owner rank without either cost. |
| Read other Changes at plan time, with no Root serialization | Two planners can run at the same moment and each sees the other without a scope. Both look independent and both spend model budget. Root serialization makes the order exact. |
| Haiku or Clef alone confirms a conflict | AGENTS.md 32.3 requires Sonnet review for unclear semantics and forbids Clef-flash from confirming a conflict. A cheap model also cannot stop a Change by itself (rule 45). |
| agy: promoted criteria become Project invariants, as a backstop for missed conflicts | Deferred. It needs protected tests that an agent cannot edit, and those tests do not exist yet. |
| Reject the whole Change of the loser | One request that asks for B and C2 would lose B. Partial selection keeps B. |
| Restart the loser's workflow on override | A workflow instance ID cannot restart. A new linked Change keeps the old record. |

## Consequences
- Bob never sees Alice's other Projects, and he cannot take owner actions.
- Each pair of overlapping requests costs one Sonnet call, about $0.01. The limit is 4 pairs per
  Change.
- The design adds D1 migration `0022_shared_projects.sql` and no new Cloudflare resource.
- A conflict that both requests hide behind unrelated words and unrelated resources can pass the
  review. This is a known limitation. Both Changes then ship in sequence, and the later one wins.
  The tests of the earlier Change usually fail on the later tree and stop it, but an agent can edit
  those tests. Report such a miss as an incident. Never mark both requests as satisfied without
  Evidence.
- Later work: protected obligation tests outside agent-editable source (agy's proposal), and
  rank changes among collaborators.
