# ADR 0023: Shared Projects

## Context
Two people work in one Project from separate accounts. Both can send requests at the same time, and
two requests can contradict each other (for example "newest first" and "oldest first"). Access to a
Project does not grant every action: API routes check the role of the user. The Change workflow
compares each Change with the other requests of the Project. ADR 0025 decides how the system
chooses between requests. See `docs/architecture/shared-projects.md`.

## Decision
- Share per Project. Use the D1 table `project_members` (`owner`, `collaborator`; `rank` 0 and 10
  only orders the members list). Do not use Clerk Organizations.
- An invitation (`project_invitations`) binds only to a Clerk-verified email of the signed-in user.
  The grant binds to the immutable user ID. An invitation expires after 7 days. Clients never send
  a role. A Project has one owner.
- Access is not permission. A collaborator can view the Project, create Changes, and cancel and
  answer their own Changes. Approve, promote, roll back, archive, delete, share, settings, code
  edits, budget raises and cancelling another user's Change are owner-only. A collaborator gets
  `403` with a reason. No owner-only action decides between requests.
- One Change per request. The Change stores `created_by` as the requester and `requester_rank`, the
  requester's role at creation, for display.
- Scope registration is serialized. After planning, the ChangeWorkflow calls `registerScope` on
  ProjectRootDO (`workers/coordinator/src/request-scopes.ts`) with the criteria (each has an ID)
  and the semantic resources. Root returns the earlier scoped active Changes in registration
  order. The later Change compares itself with each of them, so each pair is compared once per
  clarification round.
- A Change that registers while an earlier Change has no scope waits for it: 10 checks, 15 seconds
  apart. After that, the unscoped Change counts as overlapping.
- Comparison (`workers/integration/src/request-policy.ts`, `request-check.ts`):
  1. A deterministic pass checks shared resource tokens and shared routes in the criteria.
  2. A pair that overlaps gets one Sonnet review of the criteria. The review returns
     `independent`, `compatible`, `conflicting` or `duplicate`, and cites criterion IDs.
  3. Application code validates each citation. An invalid citation or an abstention counts as an
     unconfirmed conflict.
  4. Clef and Haiku never confirm a conflict alone (AGENTS.md 32.3, 34.4.2).
- Partial selection: a loser that has not dispatched work and has other criteria is re-planned
  without the losing criteria. In all other cases the loser becomes `not_selected`, and running
  work is cancelled.
- The recompose guard: `recomposeDecision` refuses a `not_selected`, `cancelled` or `needs_input`
  Change and a Change with outcome `not_selected` or `duplicate`. Without it, the stale-Candidate
  recompose merges cleanly and ships the loser over the winner.
- `ChangeStatus` has `not_selected` (terminal) and `needs_input` (ADR 0025).

## Alternatives considered
| Alternative | Why it lost |
|---|---|
| Clerk Organizations and paid roles | Needs a paid Clerk feature. Adding Bob to Alice's organization exposes her other Projects. |
| Read other Changes at plan time, with no Root serialization | Two planners can run at the same moment and each sees the other without a scope. Both look independent and both spend model budget. Root serialization makes the order exact. |
| Haiku or Clef alone confirms a conflict | AGENTS.md 32.3 requires Sonnet review for unclear semantics and forbids Clef-flash from confirming a conflict. A cheap model also cannot stop a Change by itself (rule 45). |
| Promoted criteria become Project invariants, as a backstop for missed conflicts | It needs protected tests that an agent cannot edit. |
| Reject the whole Change of the loser | One request that asks for B and C2 would lose B. Partial selection keeps B. |

## Consequences
- Bob never sees Alice's other Projects, and he cannot take owner actions.
- Each pair of overlapping requests costs one Sonnet review, about $0.01. The limit is 4 pairs per
  Change.
- The design adds D1 migration `0022_shared_projects.sql` and no new Cloudflare resource.
- A conflict that both requests hide behind unrelated words and unrelated resources can pass the
  review. This is a known limitation. Both Changes then ship in sequence, and the later one wins.
  The tests of the earlier Change usually fail on the later tree and stop it, but an agent can edit
  those tests. Report such a miss as an incident. Never mark both requests as satisfied without
  Evidence.
