# ADR 0032: First-come conflicts between requests of different people

## Context

Two people send conflicting requests to one Project. A case on prod sets the requirements:

- In the Project "Place", Sudhanva asks "build a canvas like r/place". The planner chooses a
  palette of 4 colors.
- While that request builds, Maanasa asks "Change to 16 color palette".
- The request comparison finds a conflict: 4 colors against 16 colors. A model then picks one
  request. Its rationale says "Build A first. B can follow as a separate change", but no code can
  do that. Maanasa's criterion is removed, and she sees her request as rejected.
- Her request also planned against the empty repository, because the canvas was not promoted yet.
  It bootstrapped a second app, and its Task failed with `dependency_merge_conflict`.

The person who asked first owns the outcome of their own request. A model must not cancel that
request, and must not silently drop the request of the second person. A request that changes what
an earlier request creates must plan on the tree that has that work.

## Decision

- Scope: a supported `conflicting` review (cited criteria, ADR 0023) between requests of two
  different people. The deterministic rule is `conflictPolicy` in
  `packages/protocol/src/first-come.ts`.
  - Same requester: the later request replaces the earlier one (`system:same_requester`).
  - Unsupported review, review limit, or a cited duplicate: the later requester gets a question
    (`needs_input`, ADR 0025).
  - Independent or compatible: both requests continue (ADR 0026 integrates their Tasks).
- First come. The earlier request keeps working, untouched. The later request waits with status
  `awaiting_choice`. It does not plan again, build, or spend while it waits. No model chooses.
- The question goes to the earlier requester only. Not to the owner, not to an admin, and not to
  the later requester. `canChooseFirstCome` checks the caller and the role (`change.manageOwn`).
  There is no admin override.
- `POST /v1/changes/:changeId/choose`, where `:changeId` is the waiting (later) request, with
  `{ "choice": "keep_mine" | "apply_theirs" }`:
  - `keep_mine`: the later request ends as `not_selected` with outcome `not_selected`. The reason
    names the choice: `Not selected: Sudhanva chose to keep their version of "Canvas".` The later
    requester gets `request_not_selected`.
  - `apply_theirs`: the later request becomes `queued` with outcome `follows`. When the earlier
    request promotes or ends, the later request returns to `compiling` at the current Canonical
    Generation. It plans again on the current canonical tree, without a new intake round. Its
    detail wins, because it is a follow-up Change, not a rival. The later requester gets
    `request_choice_made`.
- Without a choice within 7 days (`CHOICE_DAYS`), the earlier version stays: the choice is
  `expired`, and the later request ends as `not_selected`.
- When the earlier request ends without a build (cancelled, failed before promotion, not
  selected) before anybody chooses, the question is `moot`, and the later request plans at once.
- A request that waits after another request never plans against a stale base. It plans only
  after the earlier request has a promoted Candidate or a terminal status, and it reads the
  canonical tree at planning time.
- Durable state: D1 table `request_choices` (migration `0033_first_come_choices.sql`), one row per
  earlier and later pair. `advanceFirstCome` (`workers/integration/src/first-come.ts`) is the one
  writer of the transitions. It applies `firstComeStep`, a pure function, with guarded updates.
  The choose command, the end of the earlier request (`releaseRequestScope`), and the waiting
  ChangeWorkflow each call it and reach the same state. A retry of any of them is safe.
- The ChangeWorkflow of the later request waits with `step.waitForEvent` (type `first_come`):
  6 hours while the choice is open, 1 hour while queued. A choice or the end of the earlier
  request sends the event. When the waiting instance has ended, the end of the earlier request
  starts the instance `<changeId>_f<n>`.
- Events: `change.choice.requested`, `change.choice.made`, and `change.resumed`. Notifications:
  `request_choice_needed` (an action item for the earlier requester) and `request_choice_made`
  (the later requester).

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| A model arbiter picks the request that fits the app | It cancels the work of one person on a model opinion. The prod case shows a rationale that the code cannot carry out. |
| Remove the conflicting criteria from the later request | The later requester sees a request that is rejected in part, without a person deciding. The remaining criteria plan against a stale base. |
| An admin or the owner decides | The role of a person says nothing about two requests (ADR 0025). The earlier requester knows what their request needs. |
| The later requester decides | They would override work that started first. |
| Build both and let promotion order decide | The later build plans against the empty or old tree and fails to merge, as in the prod case. |
| A separate queue or scheduler service | D1, the existing ChangeWorkflow, and workflow events cover the wait. |

## Consequences

- A conflict between two people costs no model call after the review. The waiting request holds
  no compute: a Workflow wait is free, and each re-check is two Workflow steps.
- A choice that is never made ends the later request after 7 days. The later requester can
  withdraw (cancel) their request at any time while it waits.
- The Board shows `awaiting_choice` in "Needs answer" and `queued` in "Building", each with
  "Waiting for Sudhanva to choose" or "Waiting for "Canvas" to finish".
- `request_conflicts.policy` records `first_come`, with the earlier requester in `decided_by`.
- Compatible requests still plan at the same time. A compatible later request on an empty
  repository can still bootstrap a second app; the comparison does not sequence it.
