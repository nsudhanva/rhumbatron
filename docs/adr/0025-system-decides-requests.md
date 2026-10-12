# ADR 0025: The system decides requests, and asks before it builds

## Context

Several people send requests to one Project. A request can be unclear, can repeat a request that is
open or already built, or can contradict another request. Two cases set the requirements:

- Change C1 ("gta6 mission planner, calendar ..., each day has a kanban list") runs. A
  member sends C2 "Add kanban feature". A request review that says `compatible` builds both.
  C2 repeats the bootstrap, the merge conflicts, and each Task runs again.
- C3 (AngularJS) and C4 (React) conflict. A rule that uses the role of the requester then picks
  the request to build.

The role of a person says nothing about which request fits the app. People do not own features.
Build decisions belong to the system. An unclear or repeated request needs a question before any
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

- The owner and admin roles are for administration only (ADR 0028). This covers share, members,
  settings, budget raise, Project deletion, and the other management routes. No build decision
  reads a role or `requester_rank`.
- Intake gate, a ChangeWorkflow step before the Root Planner (`workers/integration/src/intake.ts`):
  1. Retrieval (deterministic): the open Changes plus the 20 latest completed Changes. Each is
     embedded as goal plus acceptance criteria (`@cf/baai/bge-small-en-v1.5`). Up to 10 with
     cosine >= 0.55 stay. When embeddings fail, shared product words select them.
     `@cf/baai/bge-reranker-base` orders them, and 5 go on. The current app (canonical file list,
     `package.json` dependency names, stack hints) is always one more item. Cosine never decides.
  2. Clef-flash, one call inside the shared counter of 200 calls per UTC day: per pair, a choice
     over `duplicate`, `already_covered`, `extends`, `overlaps`, and `unrelated`, plus "buildable
     as stated". Clef-flash is a different model family from Claude, so its agreement counts. It
     can only clear a pair. The pair drops when P(`unrelated`) >= 0.9.
  3. Duplicates: Sonnet answers "which criteria of the existing request, or which features of the
     app, already deliver the new request?" with quotes. It runs twice with the order swapped. Code
     drops an answer with a quote that is not in the packet. When Clef and both Sonnet orders say
     covered, the kind is `duplicate`. When one or both Sonnet orders say covered without that full
     agreement, the kind is `unclear`, with the quoted criteria. Clef alone never marks a
     duplicate. Haiku is not a confirming vote.
  4. Clarity, read against the app. The app context is deterministic and small: up to 60
     canonical file paths, the `package.json` name and description, the first 600 characters of
     `README.md`, and up to 10 titles of in-flight and shipped requests of the Project. A rule
     runs first. A goal with fewer than two words that name a product object gets a question.
     Then Clef-flash runs with the app context. P(buildable) >= 0.9 plans with no Claude call.
     Otherwise one Sonnet call (`review_clarity`) reads the request and the app context. It
     returns questions only for a part that two readings build as materially different products,
     each with a quote of the goal and 2 to 4 readings as options. It returns small open details
     (colors, sizes, labels, defaults) as assumptions. Code keeps a question only when its quote
     is in the goal, it asks one thing, and it has two distinct options. One or more questions
     ask. No question plans, and the assumptions go to the Root Planner.

  A model never rejects a request. The worst outcome is a question. Clef-flash can only clear a
  request or a pair. It never asks alone.
- Small details are assumptions, not questions. The Root Planner decides each open detail and
  records it in `assumptions` of the Work Graph. The ChangeWorkflow stores them in
  `changes.assumptions_json`. The Change page shows them as "Assumptions". A follow-up request
  changes one.
- A question makes the Change `needs_input`, with a `ChangeClarification` in
  `changes.clarification_json`. The ChangeWorkflow waits for the event `clarification`. It reads D1
  after each event and once a day. It cancels the Change after 7 days without an answer. The
  requester, the owner, or an admin answers with `POST /v1/changes/:changeId/clarify`:
  - answers, one for each answered question (a picked reading or free text), which go to
    `clarification_answers_json` and to the goal that the planner reads;
  - `proceed_anyway`;
  - `withdraw`.

  The intake gate asks at most one round for a request. After any answer, or after
  `proceed_anyway`, the request plans and the intake gate does not run again. A duplicate question
  also asks once. The request comparison after planning can ask more rounds. A Change gets at most
  3 rounds in total. After the third answer, the Change plans.
- Request comparison after planning (`request-check.ts`) keeps the deterministic overlap pass, the
  Sonnet review with criterion citations, and the review limit (ADR 0023). The review can return
  `duplicate`, which must quote the earlier criterion that delivers each later criterion. A
  `duplicate` makes the later Change `needs_input` (kind `duplicate`). An unsupported review or the
  review limit makes the later Change `needs_input` (kind `conflict`).
- A supported conflict between different requesters follows the first-come rule of
  [ADR 0032](./0032-first-come-conflicts.md). The earlier request keeps working. The later request
  waits (`awaiting_choice`) until the earlier requester chooses: keep their version, or apply the
  later request after theirs. No model and no role chooses between two people.
- Two conflicting requests from the same requester are not a conflict between people. The later
  request replaces the earlier one (`system:same_requester`).
- Each intake decision is a Decision Receipt in D1 `change_decisions` (`INTAKE`), without
  private reasoning. Intake also records
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
| Clarity check on the request text only | Without the app, a model reads most requests as open and asks about each product decision. "Change to 16 color palette" is clear in a canvas app with a palette. |
| A question for each open product decision | Most decisions are small details that the planner can decide. Questions about them delay the build, and people answer "any". Assumptions keep them visible and changeable. |
| Several decisions in one question | One text box for "a; b; c" gets one vague answer. Each question has its own answer and options. |
| A new intake round after each answer | The answer starts a second round of questions about the same request. One round is enough: the planner decides what stays open. |
| A separate review service or vector store | Workers AI, D1, and the existing Workflow cover it. |

## Consequences

- An unclear or repeated request waits for its requester before any planning spend. The C1 and C2
  case stops at intake as a duplicate.
- A request with no related items and a clear goal costs one embedding call, one Clef-flash call,
  and no Claude call. A pair that Clef-flash cannot clear adds two Sonnet calls (about $0.02). A
  request that Clef-flash does not clear adds one Sonnet clarity call. The app context adds at
  most one R2 read (`README.md`) and about 1,000 input tokens. A supported conflict adds no
  model call: the earlier requester chooses (ADR 0032).
- Workers AI adds one `AI` binding to the integration Worker (Terraform and `wrangler.jsonc`).
  Embeddings and the reranker cost much less than 1 Neuron per request. Clef-flash stays inside
  the shared counter of 200 calls per day. The free 10,000 Neurons per day cover it.
- D1 migration `0024_intake_and_system_decisions.sql` adds the clarification columns, the
  `duplicate` verdict and the pair `round`, and `change_decisions`. D1 migration
  `0032_change_assumptions.sql` adds `changes.assumptions_json`.
- A waiting Workflow instance holds no compute. An answer to a Change whose first instance has
  ended starts the instance `<changeId>_r<round>`.
