# ADR 0025: The system decides requests, and asks before it builds

## Context
Several people send requests to one Project. A request can be unclear, can repeat a request that is
open or already built, or can contradict another request. Two production failures set the
requirements:

- Change C1 ("gta6 mission planner, calendar ..., each day has a kanban list") was running. A
  collaborator sent C2 "Add kanban feature". The request review said `compatible`, both built, C2
  repeated the bootstrap, merge-conflicted, and every Task ran again.
- C3 (AngularJS) and C4 (React) conflicted, and the role of the requester decided which one built.

A person's role says nothing about which request fits the app. People do not own features. Build
decisions belong to the system, and an unclear or repeated request needs a question, not a build.

Research on model cascades and model judges sets the method:

- Cheap model first, escalate on uncertainty: FrugalGPT (arXiv 2305.05176), RouteLLM
  (lmsys.org/blog/2024-07-01-routellm), Trust or Escalate (arXiv 2407.18370).
- Agreement of independent judges is informative; agreement inside one model family is close to one
  vote, because their errors correlate: PoLL (arXiv 2404.18796), correlated errors
  (arXiv 2506.07962).
- A judge prefers the item it reads first: position bias (arXiv 2305.17926).
- A model's stated confidence is poorly calibrated (arXiv 2306.13063); gate on probabilities from a
  decision model or on cross-run agreement.
- Ambiguity needs a clarifying question that names the readings: CLAMBER (arXiv 2405.12063).
- Clef and Clef-flash are Workers AI choice models that return probabilities and have no built-in
  abstain, so thresholds are ours (blog.cloudflare.com/clef-decision-models,
  developers.cloudflare.com/workers-ai/models/clef).

## Decision
- The Project owner role is for administration only: share, members, settings, delete Project,
  budget raise, and the other owner-only routes. No build decision reads a role or `requester_rank`.
- Intake gate, a ChangeWorkflow step before the Root Planner (`workers/integration/src/intake.ts`):
  1. Retrieval, deterministic: open Changes plus the 20 latest completed ones, each embedded as
     goal plus acceptance criteria (`@cf/baai/bge-small-en-v1.5`); cosine >= 0.55, top 10; shared
     product words when embeddings fail; `@cf/baai/bge-reranker-base` orders; 5 go on. The current
     app (canonical file listing, `package.json` dependency names, stack hints) is one more
     candidate. Cosine never decides.
  2. Clef-flash, one call inside the shared 200 per day counter: per pair a choice over
     `duplicate`, `already_covered`, `extends`, `overlaps`, `unrelated`, plus "buildable as stated".
     Clef-flash is a different model family from Claude, so its agreement counts. It can only clear:
     a pair drops when P(`unrelated`) >= 0.9.
  3. Duplicates: Sonnet answers "which criteria of the existing request, or which features of the
     app, already deliver the new request?" with quotes. It runs twice with the order swapped. Code
     drops any quote that is not in the packet. Clef and both orders say covered: kind `duplicate`.
     One or two Sonnet orders say covered: kind `unclear` with the quoted criteria. Clef alone never
     marks a duplicate. Haiku is not a confirming vote.
  4. Clarity: a rule first (fewer than two words that name a product object: ask). Then Clef-flash:
     P(buildable) >= 0.9 plans, <= 0.4 asks. Between, one Sonnet call lists distinct readings, each
     quoting the goal; two or more valid readings ask, with the readings as options.
  A model never rejects a request: the worst outcome is a question.
- A question makes the Change `needs_input` with a `ChangeClarification` in
  `changes.clarification_json`. The ChangeWorkflow waits for the event `clarification`, reads D1
  after each event and once a day, and cancels the Change after 7 days without an answer. The
  requester or the owner answers with `POST /v1/changes/:changeId/clarify`: answers (appended to
  `clarification_answers_json` and to the goal the next intake and planner read), `proceed_anyway`,
  or `withdraw`. At most 3 rounds; after the third answer the Change plans.
- Request comparison after planning (`request-check.ts`) keeps the deterministic overlap pass, the
  Sonnet review with criterion citations, and the review limit. The review adds `duplicate`, which
  must quote the earlier criterion that delivers each later criterion; it makes the later Change
  `needs_input` (kind `duplicate`). An unsupported review or the review limit makes the later Change
  `needs_input` (kind `conflict`).
- A supported conflict between different requesters goes to the system arbiter: `arbitrate_requests`
  on Sonnet, run twice with A and B swapped, over both goals, criteria, the cited conflicts and the
  current app. Closed verdict `prefer_a`, `prefer_b`, `ask`; the rationale cites criterion IDs and
  packet item IDs, which code validates. A preference applies only when both runs agree and both are
  valid; the existing loser handling then runs with `decided_by = system:arbiter`. Anything else
  makes the later Change `needs_input` (kind `conflict`). The same requester asking twice is no
  conflict between people: the later request replaces the earlier one (`system:same_requester`).
- Every intake decision and every arbitration is a Decision Receipt in D1 `change_decisions`
  (`INTAKE`, `REQUEST_ARBITER`) without private reasoning. Intake also records
  `change.intake.reviewed`; an answer records `change.clarification.answered`. Model cost counts
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
  and no Claude call. A pair that Clef-flash cannot clear adds two Sonnet calls (about $0.02); the
  middle clarity band adds one. A supported conflict adds two arbiter calls.
- Workers AI adds one `AI` binding to the integration Worker (Terraform and `wrangler.jsonc`).
  Embeddings and the reranker cost well under 1 Neuron per request; Clef-flash stays inside the
  shared 200 per day counter. The free 10,000 Neurons per day cover it.
- D1 migration `0024_intake_and_system_decisions.sql` adds the clarification columns, the
  `duplicate` verdict and the pair `round`, and `change_decisions`.
- A waiting Workflow instance holds no compute. An answer to a Change whose first instance already
  ended starts the instance `<changeId>_r<round>`.
