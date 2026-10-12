# ADR 0026: Candidate selection and the acceptance check

## Context

The fork rule can give one Change several Candidates on the same base generation. Each Candidate
has its own CandidateVerificationWorkflow. If the first Candidate that passes its gate promotes,
its siblings go stale. Then the fastest Candidate wins, even when a sibling is better. For example,
a Change asks for a calendar with a kanban list per day. The kanban Candidate verifies one second
before the calendar Candidate and ships alone. Without a check of the request, no Evidence shows
the loss. See [Source and verification](../architecture/source-and-verification.md).

## Decision

- Siblings are the Candidates of one Change on one base generation. While a sibling is still
  `composing`, `composed`, or `verifying`, a verified Candidate does not promote, and a person
  cannot promote it (`selection_pending`).
- Each workflow runs the selection after its gate (`workers/integration/src/candidate-selection.ts`).
  When a sibling is still pending, the run ends. The last run to settle claims the selection with one
  conditional `UPDATE` of `selection_json` from NULL on the anchor row (the earliest Candidate of
  the group). A retry by the claimant continues. Each other run stops. The claim and the outcome
  are on the `candidates` rows (migration 0025), so Project cleanup removes them with the
  Candidates. No separate table exists.
- Ranking: only promotable Candidates; then the most acceptance criteria met; then fewer gaps and
  optional failures; then more passing checks. Deterministic code decides when the Evidence
  differs.
- A tie goes to the Integration Judge. The judge is one Sonnet call that reads only the Evidence
  snapshot of the tied Candidates. The verdict is closed: `prefer_candidate`,
  `reject_candidate`, `needs_more_evidence`, or `escalate_to_human`. Code validates the cited
  Evidence IDs. Only a valid `prefer_candidate` picks a winner. Any other result moves the Change
  to `awaiting_approval`, and a person promotes one Candidate.
- Verified losers become `rejected` with the comparison as the reason ("Lost to cand_x: met 3 of 3
  criteria, this met 2 of 3."). The outcome is a Decision Receipt (`CANDIDATE_SELECTION`) and the
  Event `candidate.selected`. The winner takes the unchanged promotion path: policy, approval gate,
  compare-and-swap.
- Combined Candidate (`workers/integration/src/candidate-create.ts`): when the fork conflict is
  `fork_required` (the review said `needs_more_evidence`), the fork rule adds a third Candidate
  with both sides and the ChangeSets that need both. This Candidate gives the Evidence that the
  review asks for. A `confirmed` conflict keeps two Candidates.
- Complementary Tasks integrate and never fork (`packages/conflict/src/integrate.ts`). A
  `confirmed` or `fork_required` conflict between two Tasks of one Change, where no resource of one
  equals, contains, or is contained in a resource of the other (`todos:api` and `todos:ui`), has
  the fork decision `integrate`. Each side alone is incomplete, so rival Candidates ship half of
  the request.
  - Composition makes the dependent Task depend on the other Task. The dependent Task is chosen in
    this order: an existing dependency path decides; else the UI Task; else the Task whose Intent
    uses the contract of the other; else the higher Task key.
  - The dependent Task runs again once on a stacked workspace with the ChangeSet of the other
    Task, before any Candidate exists.
  - The decision is in `review_json.integrate` and `fork_decision_json`, the Event
    `conflict.integrated`, and the Decision Receipt `CONFLICT_INTEGRATION`.
  - This occurs once per Task pair. A later conflict on the pair follows the fork rule. Only Tasks
    on overlapping resources with incompatible designs fork.
- Acceptance check (`workers/integration/src/acceptance-check.ts`): an optional check (kind
  `acceptance`) for each Candidate of a Change with acceptance criteria.
  - One Haiku call judges each criterion against the app after the change. One Sonnet call
    follows only when the Haiku output is invalid.
  - The model receives the Candidate patch first. Then it receives the full text of the relevant
    files of the composed tree: the changed files, `public/index.html`, the scripts and styles that
    it references, `src/app.ts`, and `src/worker.ts`. The limit is 24 files and about 60 KB in
    total. A cut file is marked `truncated`.
  - A criterion that code in the base already satisfies is `met`, with a quote of the composed
    file.
  - A `met` cites a path and a quote. Code keeps a citation only when the quote occurs in a
    composed file that the model received, or in the added or context lines of its patch.
  - The Evidence is `pass` only when each criterion is met. In all other cases it is `fail` with
    `checked_supported`. A model error or a refused call is a gap.
  - Criteria that other checks cover (quality gate, latency, kept behavior) are not judged.
- Acceptance gates auto-promotion. It does not decide whether a Candidate can promote. A shortfall
  does not reject a Candidate. It ranks the Candidate (criteria met is the second sort key). A winner that meets each criterion auto-promotes
  when policy allows (the default policy `policy-1` allows `low` and `medium` risk). A winner
  with a criterion that is not met or unclear, or with no acceptance result, gets the human gate
  in its plan. The Change moves to `awaiting_approval`, and
  `approval.requested` states the reason ("Best candidate meets 2 of 3 criteria; not met: calendar
  view. Approve to ship it or cancel the change."). A failed required executable check makes a
  Candidate unpromotable.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Fork complementary Tasks and let the combined Candidate win | The combined Candidate exists only for `fork_required`, and a UI written against a guessed API fails it. The side Candidates then ship half of the request. |
| First verified Candidate wins, plus the acceptance check | Two Candidates that each meet some criteria still race. The result depends on timing. |
| Acceptance as a required gate check | When each fork side implements part of the request and the combined Candidate does not compose, each Candidate is rejected and nothing can ship, also with the consent of a person. |
| A `candidate_selections` table keyed by Change and base | It works, but it needs its own cleanup on Project deletion. The anchor row gives the same single claim. |
| A model picks the winner every time | Executable Evidence decides when it differs. The judge only breaks a tie. |
| Run a browser session per criterion | Browser Run minutes have a cap. A cited quote of the patch is cheap Evidence for "the code does this". |
| Sonnet for every acceptance check | Haiku is enough for a bounded, cited classification. Sonnet runs only on invalid output. |

## Consequences

- The fastest sibling does not ship by default. A Change waits for its slowest sibling before it
  promotes. This adds minutes.
- Each Candidate with acceptance criteria costs one Haiku call (about $0.01). A tie costs one
  Sonnet call (about $0.02). Both count against the Change budget and the daily call cap.
- A Candidate that implements only part of the request never ships without a person. The person
  sees which criteria are missing and approves the best Candidate or cancels the Change.
- The acceptance check reads code. A quote proves that code for a criterion exists. It does not
  prove that the code works. The unit, contract, and preview checks prove behavior.
- An integrated pair costs one more agent run for the dependent Task (and the Tasks built on it)
  before the Change composes. It adds no verification of a second Candidate.
- If the workflow of the claimant fails permanently after the claim, no winner is applied
  automatically. The siblings stay verified, and a person can promote one.
