# ADR 0025: The system decides requests, and asks before it builds

## Context

Several people send requests to one Project. A request can be unclear, can repeat a request that is
open or already built, or can contradict another request. Two cases set the requirements:

- Change C1 ("gta6 mission planner, calendar ..., each day has a kanban list") runs. A
  collaborator sends C2 "Add kanban feature". A request review that says `compatible` builds both.
  C2 repeats the bootstrap, the merge conflicts, and each Task runs again.
- C3 (AngularJS) and C4 (React) conflict. A rule that uses the role of the requester picks the
  request to build.

The role of a person says nothing about which request fits the app. People do not own features.
Build decisions belong to the system. An unclear or repeated request needs a question, not a
build.

Research on model cascades and model judges sets the method:

- Cheap model first, escalate on uncertainty: FrugalGPT (arXiv 2305.05176), RouteLLM
  (lmsys.org/blog/2024-07-01-routellm), Trust or Escalate (arXiv 2407.18370).
- Agreement of independent judges carries information. Agreement inside one model family is close
  to one vote, because their errors correlate: PoLL (arXiv 2404.18796), correlated errors
  (arXiv 2506.07962).
- A judge prefers the item it reads first: position bias (arXiv 2305.17926).
- The stated confidence of a model is poorly calibrated (arXiv 2306.13063). Gate on probabilities
  from a decision model or on agreement across runs.
- Ambiguity needs a clarifying question that names the readings: CLAMBER (arXiv 2405.12063).
- Clef and Clef-flash are Workers AI choice models. They return probabilities and have no
  built-in abstain, so Rhumbatron sets the thresholds (blog.cloudflare.com/clef-decision-models,
  developers.cloudflare.com/workers-ai/models/clef).

## Decision

- The Project owner role is for administration only: share, members, settings, delete Project,
  budget raise, and the other owner-only routes. No build decision reads a role or `requester_rank`.
- Intake gate, a ChangeWorkflow step before the Root Planner (`workers/integration/src/intake.ts`):
  1. Retrieval (deterministic): the open Changes plus the 20 latest completed Changes. Each is
     embedded as goal plus acceptance criteria (`@cf/baai/bge-small-en-v1.5`). Up to 10 with
     cosine >= 0.55 stay. When embeddings fail, shared product words select them.
     `@cf/baai/bge-reranker-base` orders them, and 5 go on. The current app (canonical file list,
     `package.json` dependency names, stack hints) is always one more item. Cosine never decides.
  2. Clef-flash, one call inside the shared counter of 200 calls per UTC day: per pair, a choice
     over `duplicate`, `already_covered`, `extends`, `overlaps`, and `unrelated`, plus "buildable
     as stated". Clef-flash is a different model family from Claude, so its agreement counts. It
     can only clear a pair: the pair drops when P(`unrelated`) >= 0.9.
  3. Duplicates: Sonnet answers "which criteria of the existing request, or which features of the
     app, already deliver the new request?" with quotes. It runs twice with the order swapped. Code
     drops an answer with a quote that is not in the packet. When Clef and both Sonnet orders say
     covered, the kind is `duplicate`. When one or both Sonnet orders say covered without that full
     agreement, the kind is `unclear`, with the quoted criteria. Clef alone never marks a
     duplicate. Haiku is not a confirming vote.
  4. Clarity: a rule first (fewer than two words that name a product object: ask). Then
     Clef-flash: P(buildable) >= 0.9 plans, and P(buildable) <= 0.4 asks. Between the two, one
     Sonnet call lists the distinct readings, each with a quote of the goal. Two or more valid
     readings ask, with the readings as options.

  A model never rejects a request. The worst outcome is a question.
- A question makes the Change `needs_input`, with a `ChangeClarification` in
  `changes.clarification_json`. The ChangeWorkflow waits for the event `clarification`. It reads D1
  after each event and once a day. It cancels the Change after 7 days without an answer. The
  requester or the owner answers with `POST /v1/changes/:changeId/clarify`:
  - answers, which go to `clarification_answers_json` and to the goal that the next intake and
    planner read;
  - `proceed_anyway`;
  - `withdraw`.

  At most 3 rounds occur. After the third answer, the Change plans.
- Request comparison after planning (`request-check.ts`) keeps the deterministic overlap pass, the
  Sonnet review with criterion citations, and the review limit (ADR 0023). The review can return
  `duplicate`, which must quote the earlier criterion that delivers each later criterion. A
  `duplicate` makes the later Change `needs_input` (kind `duplicate`). An unsupported review or the
  review limit makes the later Change `needs_input` (kind `conflict`).
- A supported conflict between different requesters goes to the system arbiter:
  `arbitrate_requests` on Sonnet, run twice with A and B swapped. Its input is both goals, both
  criteria lists, the cited conflicts, and the current app. The verdict is closed: `prefer_a`,
  `prefer_b`, or `ask`. The rationale cites criterion IDs and packet item IDs, and code validates
  them. A preference applies only when both runs agree and both are valid. Then the losing-request
  handling of ADR 0023 runs with `decided_by = system:arbiter`. Any other result makes the later
  Change `needs_input` (kind `conflict`).
- Two conflicting requests from the same requester are not a conflict between people. The later
  request replaces the earlier one (`system:same_requester`).
- Each intake decision and each arbitration is a Decision Receipt in D1 `change_decisions`
  (`INTAKE`, `REQUEST_ARBITER`), without private reasoning. Intake also records
  `change.intake.reviewed`. An answer records `change.clarification.answered`. Model cost counts
  against the Change budget.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Owner rank decides conflicts | People do not own features. Rank says nothing about which request fits the app. |
| Haiku reviews, Sonnet confirms | Same model family: correlated errors make Haiku agreeing with Sonnet close to one vote. Clef-flash is independent and cheaper. |
| One Sonnet run per decision | Position bias: the model prefers the request it reads first. Two swapped runs that agree remove it. |
| Gate on the model's stated confidence | Verbal confidence is poorly calibrated. Clef probabilities and cross-run agreement are measurable. |
| Cosine similarity decides duplicates | Short goals such as "Add kanban feature" embed badly. Cosine only shortlists. |
| Reject a duplicate automatically | A wrong rejection loses a request. A question costs one answer. |
| A separate review service or vector store | Workers AI, D1 and the existing Workflow cover it (AGENTS.md rules 13, 15, 22). |

## Consequences

- An unclear or repeated request waits for its requester before any planning spend. The C1 and C2
  case stops at intake as a duplicate.
- A request with no related items and a clear goal costs one embedding call, one Clef-flash call,
  and no Claude call. A pair that Clef-flash cannot clear adds two Sonnet calls (about $0.02). The
  middle clarity band adds one Sonnet call. A supported conflict adds two arbiter calls.
- Workers AI adds one `AI` binding to the integration Worker (Terraform and `wrangler.jsonc`).
  Embeddings and the reranker cost much less than 1 Neuron per request. Clef-flash stays inside
  the shared counter of 200 calls per day. The free 10,000 Neurons per day cover it.
- D1 migration `0024_intake_and_system_decisions.sql` adds the clarification columns, the
  `duplicate` verdict and the pair `round`, and `change_decisions`.
- A waiting Workflow instance holds no compute. An answer to a Change whose first instance has
  ended starts the instance `<changeId>_r<round>`.
