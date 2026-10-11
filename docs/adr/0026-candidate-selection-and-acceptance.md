# ADR 0026: Candidate selection and the acceptance check

## Context
The fork rule (AGENTS.md 32.4) can give one Change several Candidates on the same base generation.
Each Candidate has its own CandidateVerificationWorkflow. When the first one passes its gate and
policy allows auto-promotion, it promotes, and its siblings go stale. The fastest Candidate wins,
not the best one. A Change that asked for a calendar with a kanban list per day shipped only the
kanban list this way: the calendar Candidate finished one second later. No check tested what the
person asked for, so no Evidence showed the loss. See `docs/architecture/source-and-verification.md`.

## Decision
- Siblings are the Candidates of one Change on one base generation. A verified Candidate does not
  promote, and a person cannot promote it (`selection_pending`), while a sibling is still
  `composing` or `verifying`.
- Each workflow selects after its gate. When a sibling is still pending, the run ends. The last run
  to settle claims the selection: one conditional `UPDATE` of `selection_json` from NULL on the
  anchor row (the earliest Candidate of the group). A retry by the claimant proceeds; every other
  run stops. No new table: the claim and the outcome live on `candidates` rows (migration 0025),
  so Project cleanup removes them with the Candidates.
- Ranking: only promotable Candidates; then most acceptance criteria met; then fewer gaps and
  optional failures; then more passing checks. Deterministic code decides whenever the Evidence
  differs.
- A tie goes to the Integration Judge (AGENTS.md 22.5): one Sonnet call that reads only the
  Evidence snapshot of the tied Candidates. The verdict is closed: `prefer_candidate`,
  `reject_candidate`, `needs_more_evidence`, `escalate_to_human`. Code validates the cited Evidence
  IDs. Only a valid `prefer_candidate` picks a winner. Anything else moves the Change to
  `awaiting_approval`, and a person promotes one Candidate.
- Verified losers become `rejected` with the comparison as the reason ("Lost to cand_x: met 3 of 3
  criteria, this met 2 of 3."). The outcome is a Decision Receipt (`CANDIDATE_SELECTION`) and the
  Event `candidate.selected`. The winner takes the unchanged promotion path: policy, approval gate,
  compare-and-swap.
- Combined Candidate: when the fork conflict is `fork_required` (the review said
  `needs_more_evidence`, not `confirmed`), the fork rule adds a third Candidate with both sides
  and the ChangeSets that need both. It is the evidence the review asked for. A `confirmed`
  conflict keeps two Candidates.
- Integrate, do not fork, complementary Tasks: a `confirmed` or `fork_required` conflict between
  two Tasks of one Change on different semantic resources (`todos:api` and `todos:ui`) has the
  fork decision `integrate`. Each side alone is incomplete, so rival Candidates would ship half
  the request. Composition makes the dependent Task (the UI, else the Task that uses the other's
  contract, else the later Task key) depend on the other Task and re-runs it once on a stacked
  workspace with the other Task's ChangeSet, before any Candidate exists. The decision is recorded
  in `review_json.integrate` and `fork_decision_json`, the Event `conflict.integrated`, and the
  Decision Receipt `CONFLICT_INTEGRATION`. Once per Task pair: a later conflict on the pair
  follows the fork rule. Only Tasks on overlapping resources with incompatible designs fork.
- Acceptance check: an optional check (kind `acceptance`) for every Candidate of a Change with
  acceptance criteria. One Haiku call judges each criterion against the Candidate patch (Sonnet
  once on invalid output). A `met` cites a path and a quote. Code keeps a citation only when the
  quote occurs in the added or context lines of a file the model received. The Evidence is `pass`
  only when every criterion is met, and `fail` with `checked_supported` otherwise. A model error
  or a refused call is a gap. Criteria that other checks cover (quality gate, latency, kept
  behavior) are not judged.
- Acceptance gates auto-promotion, not promotability. A shortfall does not reject a Candidate:
  it ranks it (criteria met is the second sort key). A winner that meets every criterion
  auto-promotes when policy allows. A winner with a criterion not met or unclear, or with no
  acceptance result, gets the human gate in its plan, the Change moves to `awaiting_approval`,
  and `approval.requested` states the reason ("Best candidate meets 2 of 3 criteria; not met:
  calendar view. Approve to ship it or cancel the change."). A failing required executable check
  still makes a Candidate unpromotable.

## Alternatives considered
| Alternative | Why it lost |
|---|---|
| Fork complementary Tasks and let the combined Candidate win | The combined Candidate only exists for `fork_required`, and a UI written against a guessed API fails it; the side Candidates then ship half the request. |
| Keep first-verified-wins and add only the acceptance check | Two Candidates that each meet some criteria still race; the result depends on timing. |
| Acceptance as a required gate check | When each fork side implements part of the request and the combined Candidate does not compose, every Candidate is rejected and nothing can ship, even with a person's consent. |
| A `candidate_selections` table keyed by Change and base | Works, but needs its own cleanup on Project deletion. The anchor row gives the same single claim. |
| A model picks the winner every time | Executable Evidence decides when it differs (AGENTS.md 44, 45). The judge only breaks a tie. |
| Run a browser session per criterion | Browser Run minutes are capped (section 7.3). A cited quote of the patch is cheap Evidence for "the code does this". |
| Sonnet for every acceptance check | Haiku is enough for a bounded, cited classification (AGENTS.md 40); Sonnet runs only on invalid output. |

## Consequences
- The fastest sibling no longer ships by default. A Change waits for its slowest sibling before it
  promotes, which adds minutes, not hours.
- Each Candidate with acceptance criteria costs one Haiku call (about $0.01). A tie costs one
  Sonnet call (about $0.02). Both count against the Change budget and the daily call cap.
- A Candidate that implements only part of the request never ships without a person. The person
  sees which criteria are missing and approves the best Candidate or cancels the Change.
- The acceptance check reads code, not behavior. A quote proves that code for a criterion exists,
  not that it works. The unit, contract, and preview checks keep proving behavior.
- An integrated pair costs one more agent run for the dependent Task (and the Tasks built on it)
  before the Change composes, instead of a second Candidate's verification.
- If the claimant's workflow fails permanently after the claim, no winner is applied
  automatically. The siblings stay verified, and a person can promote one.
