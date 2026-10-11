# Source and verification

This page explains where Project source lives, how agents and Candidates get isolated copies, how the Sandbox runs code, how checks become Evidence, how one Candidate is selected among siblings, and what promotion requires.

Main source files:

- `workers/integration/src/provision.ts`, `canonical-source.ts`, `repo-names.ts`, `project-cleanup.ts`
- `workers/agents/src/workspace.ts`, `stack.ts`
- `workers/integration/src/verification-workflow.ts`, `candidate-sandbox.ts`, `browser-check.ts`, `runner-selection.ts`
- `workers/integration/src/candidate-create.ts` (fork rule), `acceptance-check.ts`, `candidate-selection.ts`
- `packages/evidence/src`: `plan.ts`, `gate.ts`, `promotion.ts`, `compatibility.ts`
- `workers/coordinator/src/promotion-cas.ts`, `project-root-do.ts`

## Artifacts repositories

Cloudflare Artifacts is the canonical source store (ADR 0010).
The namespace is `rhumbatron-projects-<env>`, where `<env>` is `prod`.
The code creates the namespace on first use. Terraform has no resource for it.

```mermaid
flowchart TB
  subgraph NS["Artifacts namespace rhumbatron-projects-env"]
    CAN[("proj_uuid<br/>canonical repo, branch main")]
    WS1[("ws-run<br/>Task workspace fork")]
    WS2[("ws-run<br/>Task workspace fork")]
    CA[("cand-id<br/>Candidate fork")]
  end
  PROV["project.provision<br/>(integration Worker)"] -->|"create, seed empty repo"| CAN
  AG["AgentDO run"] -->|"fork on first write"| WS1
  AG --> WS2
  VW["CandidateVerificationWorkflow"] -->|"fork, merge ChangeSets"| CA
  CA -->|"fast-forward main<br/>after the CAS"| CAN
  SWEEP["forks.sweep, daily"] -.->|"delete after 30 days"| WS1
  SWEEP -.-> CA
  IDX["rhumbatron-indexer"] -->|"read-only token"| CAN
```

Rules:

- Repo names derive from D1 row IDs only: the Project ID, `ws-<run>` for run `run_<run>`, and `cand-<id>` for Candidate `cand_<id>`.
- Cleanup never lists the namespace. It deletes only names it derives from one Project's rows, so it cannot reach another Project.
- Every git access uses a short-lived repo token (600 s). The code revokes the token after use.
- Provisioning stores a file index at `source/<project>/<tree>/index.json` in R2. Agents read that index instead of walking the repo.
- The same step fills the code store. `source/<project>/<tree>/code.json` maps paths to Git blob IDs. The step copies each blob once to `source/<project>/blobs/<blob>`. A promotion copies only the blobs that its previous tree did not have. The code store lists files over 1 MB but does not copy them.
- The code view uses stored patches. An Agent publish stores the `git diff` of its own work at `source/<project>/patches/changesets/<cs>.patch` and sets `patchRef`. A Candidate composition stores the Candidate-vs-base diff at `source/<project>/patches/candidates/<cand>.patch`. Each patch stops at 512 KB, at a line boundary. R2 metadata records `truncated` and the full size.
- All of these objects are under `source/<project>/`. No lifecycle rule expires them, and archive cleanup removes them. Archive cleanup also removes `context/`, `evidence/`, `work-graphs/`, `workspace/`, `apps/`, and `app-previews/` objects of the Project, the D1 content rows, and the Durable Object storage of its shards and agents (see `docs/operations/cleanup.md`).
- A new Project starts at Canonical Generation 0. `AGENTS.md` shows `S1841` for the demo. The code starts at `S0`.

## Composition and promotion in Git terms

A Candidate fork starts at the canonical base commit.
The CandidateVerificationWorkflow merges the ChangeSets in Work Graph order.
Promotion moves canonical `main` forward to the composed commit, fast-forward only.

```mermaid
gitGraph
  commit id: "S0 base"
  branch ws-t1
  checkout ws-t1
  commit id: "t1"
  checkout main
  branch ws-t2
  checkout ws-t2
  merge ws-t1 id: "stack t1"
  commit id: "t2"
  checkout main
  branch cand-a
  checkout cand-a
  merge ws-t1 id: "compose t1"
  merge ws-t2 id: "compose t2"
  checkout main
  merge cand-a id: "S1 promoted" tag: "S1"
```

Notes:

- `gitGraph` draws the last step as a merge. In the code it is a fast-forward push of the composed commit (`canonical-source.ts`). There is no force push.
- The push runs inside the integration Worker with `isomorphic-git` on an in-memory file system. It uses no Sandbox time.
- If the push fails, the CAS still holds. A retry of the promotion repairs the source sync.

## Sandbox lifecycle

The `Sandbox` class is in `rhumbatron-sandbox` (ADR 0012).
There is one Sandbox per Project, with the ID `proj-<uuid>`.
Agent runs and Candidate checks use separate directories in it.
The container application allows one instance.

```mermaid
sequenceDiagram
  autonumber
  participant A as AgentDO
  participant D1 as D1 usage_counters
  participant Art as Artifacts
  participant SBX as Sandbox proj-id

  A->>D1: admitSandbox: fewer than 4 open per Change?
  A->>D1: reserve 300 s on the monthly meter
  D1-->>A: refused when the cap would pass
  A->>Art: fork canonical as ws-run, read token
  A->>SBX: git clone into /workspace/run (token in env, not config)
  A->>SBX: checkout base, merge stacked ChangeSets
  loop agent tools
    A->>SBX: write_file, run_command (allowlist, 180 s)
  end
  A->>Art: write token (600 s)
  A->>SBX: git commit, push to ws-run
  A->>Art: revoke token
  A->>D1: settle: wall time + 600 s sleep tail
  A->>SBX: remove the run directory
  Note over SBX: Sleeps after 2 idle minutes
```

| Guard | Agent workspace | Candidate checks |
|---|---|---|
| Directory | `/workspace/<run>` | `/workspace/cand-<id>` |
| Reservation on open | 300 s | 900 s |
| Idle tail before sleep | 120 s (`sleepAfter` 2 min) | 120 s (`sleepAfter` 2 min) |
| Concurrency | 4 open workspaces per Change | Checks run one after another in one workflow |
| Monthly meter | `SANDBOX_MONTHLY_SECONDS` (72,000 s = 20 h) | Same meter |

A Sandbox loss does not lose committed work.
The workspace restores from the same fork, base, and stacked merges, and checks the recorded start commit (section 42.5).
Uncommitted edits are lost.
A publish after a loss therefore fails the run instead of publishing partial work.
The Sandbox never receives Terraform, Cloudflare API, or model credentials.

## Verification workflow

CandidateVerificationWorkflow has one instance per Candidate.
Every step is idempotent, and every check is its own step with its own timeout.
It makes model calls in two places only: the acceptance check (Haiku, and Sonnet once when the Haiku output is invalid) and the Integration Judge on a tie between sibling Candidates (one Sonnet call).
Both calls go through the metered gateway, the daily call cap, and the Change budget.

```mermaid
flowchart TB
  L["Load Candidate, Change,<br/>ChangeSets, canonical"] --> F{"Final status already?"}
  F -->|"yes"| SKIP["Skip"]
  F -->|"no"| G{"Base = canonical generation?"}
  G -->|"no"| ST["stale"]
  G -->|"yes"| CC{"checkCompatibility<br/>(deterministic)"}
  CC -->|"incompatible"| RJ["rejected + composition Evidence"]
  CC -->|"ok or shared file"| FK["Fork cand-id"]
  FK --> RS{"Reserve Sandbox seconds"}
  RS -->|"no budget"| RJ
  RS -->|"ok"| CM{"Merge ChangeSets<br/>in the Sandbox"}
  CM -->|"merge conflict"| RJ
  CM -->|"merged"| PL["Build Verification Plan,<br/>status verifying, candidate.composed"]
  PL --> CK["One step per check:<br/>Evidence to D1 and R2"]
  CK --> AC["acceptance: criteria vs patch,<br/>citations checked in code"]
  AC --> GT{"gateRequiredChecks"}
  GT -->|"promotable"| VF["verified"]
  GT -->|"gaps"| RJ
  VF --> SEL["Sibling selection<br/>(see below)"]
  RJ --> SEL
```

A check that throws or times out records an `error` with coverage `not_checked`.
That is a gap, never a pass (section 34.4.1).
The Sandbox meter settles after the last Sandbox check, before preview publication and the gate.

### Where checks run

`build`, `unit`, and `contract` run in a Dynamic Worker through the `APPS.check` RPC when the integration Worker has the `APPS` binding (`isAppCheckerEligible` in `runner-selection.ts`).
The AppChecker reads the composed tree from the R2 code store. Each check has at most 30 s, no network, and no binding.
When AppChecker answers `supported: false` (for example no code store, a bundler error, or a deadline), the check runs in the Sandbox instead.
A completed Dynamic Worker failure is final. It never falls back to the Sandbox for a second try.
`protected-invariant-cart`, `performance`, `security`, and `browser` always run in the Sandbox.
`acceptance` and `preview-smoke` use no Sandbox.
The Evidence summary of a check that ran in a Dynamic Worker or the Sandbox ends with `(runner: dynamic-worker)` or `(runner: sandbox)`.

### Which checks run

`buildVerificationPlan` picks checks from the policy tier and from what the ChangeSets touch.
Verification plans with `DEFAULT_POLICY` (`policy-1`) in `workers/integration/src/candidate-composer.ts`.
D1 `project_policies` (migration 0017) can store a per-Project policy. Promotion and approval read it. Verification does not.

```mermaid
flowchart LR
  RISK["Change risk tier"] --> POL{"requiredChecksByRisk"}
  POL -->|"low"| LOW["build, targeted"]
  POL -->|"medium"| MED["build, targeted, contract"]
  POL -->|"high or critical"| HIGH["build, targeted, contract,<br/>security, browser"]
  T1["Invariant names the Cart"] --> CART["protected-invariant-cart"]
  T2["Goal sets a p95 limit"] --> PERF["performance: p95Ms below 200"]
  T3["Touches authorization"] --> SEC["security"]
  T4["Touches UI and risk at least high"] --> BRW["browser"]
```

| Check ID | Kind | Command or procedure | Timeout |
|---|---|---|---|
| `build` | build | Dynamic Worker: bundle the app with `@cloudflare/worker-bundler` and load it. Sandbox fallback: `bun run typecheck` | 120 s (30 s in the Dynamic Worker) |
| `unit` | unit | Dynamic Worker: the project tests. Sandbox fallback: `bun test` | 180 s (30 s in the Dynamic Worker) |
| `contract` | contract | Diff the route table of the base and the Candidate against declared contract changes. Dynamic Worker extraction, Sandbox fallback `bun run contract` | 120 s (30 s in the Dynamic Worker) |
| `protected-invariant-cart` | protected-invariant | `bun test test/cart.invariant.test.ts` | 120 s |
| `performance` | performance | `bun run bench`, expects metric `p95Ms` below 200 | 120 s |
| `security` | security | `bun test --test-name-pattern authorization` | 180 s |
| `browser` | browser | Section 35 Wishlist flow, or a cart flow, in one Browser Run session | 90 s |
| `acceptance` | acceptance | Optional. Haiku judges each acceptance criterion against the Candidate patch; code validates every citation | 180 s |
| `preview-smoke` | smoke | Publish the Candidate preview and run the release probes against it | 30 s |

The policy check `targeted` runs the `unit` check. Every plan has `build` and `unit`.
An invariant that keeps existing endpoint behavior adds `contract` and `unit`. Another app-behavior invariant adds `unit`. An invariant that no test can prove becomes a required procedure check, and it stays a visible gap.
A Project with a live app also gets `contract` and a `preview-smoke` check. The smoke check publishes the Candidate preview and runs the release probes against it.
A Change with acceptance criteria gets the optional `acceptance` check (see below).

The browser check opens the composed app through request interception.
The preview host has no public URL.
The check blocks every other request.
One session lasts at most 55 s. A Candidate gets at most 2 browser runs.

The policy does not list the `critical` risk tier, so a `critical` Change uses the strictest listed tier.
A gap in policy never lowers verification.

### Acceptance check

The acceptance check tests what the person asked for. Every Candidate of a Change that has acceptance criteria gets it.
It is not a gate check: it does not make a Candidate unpromotable and does not reject it. It ranks sibling Candidates, and it gates auto-promotion.
A failing required executable check (`build`, `unit`, `contract`, `preview-smoke`, and the others in the table) still makes a Candidate unpromotable.

- Criteria: the Change acceptance criteria, without the ones other checks cover (`acceptanceCriteriaToJudge` in `candidate-composer.ts`): a criterion that only restates the quality gate ("typecheck and tests pass"), a latency limit (the `performance` check), or kept behavior ("unchanged", the invariant checks). With none left, the plan has no `acceptance` check.
- Input: the Candidate patch that composition stored at `source/<project>/patches/candidates/<cand>.patch`. Without a patch for the composed commit, the changed files of the composed tree, read from the Candidate fork. Both are capped at about 60 KB.
- Model: one Haiku call with the tool `record_acceptance`. Each criterion is `met`, `not_met`, or `unclear`. A `met` cites `{path, quote}`. When the output is not one result per criterion, one Sonnet call follows. No browser session runs.
- Citations: code keeps a citation only when the path is a file the model received and the quote (at least 8 characters, whitespace collapsed) occurs in its added or context lines. A removed line proves nothing. A `met` with no valid citation counts as `unclear` (section 34.4.2).
- Evidence: `pass` with `checked_supported` only when every criterion is `met`. Otherwise `fail` with `checked_supported` and a summary such as "2 of 3 criteria met; not met: calendar view". A model error, a refused call (Change budget, daily call cap, monthly budget), or no readable source is `error` with `not_checked`: a gap.
- A Candidate whose earlier check has no passing result cannot ship, so the check records `skipped` (`not_checked`) and spends no model call.
- Auto-promotion: a selected Candidate auto-promotes (when policy allows) only when its acceptance Evidence is `pass` with `checked_supported`. With a criterion not met or unclear, or with a gap, `holdForAcceptance` (`candidate-selection.ts`) adds the human gate to its plan, sets its status reason, moves the Change to `awaiting_approval`, and records `approval.requested` with the reason, for example "Best candidate meets 2 of 3 criteria; not met: calendar view. Approve to ship it or cancel the change." A person approves and promotes it through the normal path, or cancels the Change.
- Storage: per-criterion results in `candidates.acceptance_json` and in the R2 report; `criteriaMet`, `criteriaTotal`, and `costUsd` in `metrics_json`. The cost counts against the Change budget.

## Sibling Candidates and selection

The fork rule (`planCandidateSets`) can give one Change several Candidates on the same base generation.
These Candidates are siblings. Their verification workflows run in parallel, and none of them promotes on its own (ADR 0026).

```mermaid
flowchart TB
  G["Candidate gated:<br/>verified or rejected"] --> S{"Siblings on<br/>the same base?"}
  S -->|"no"| P["Promotion path"]
  S -->|"yes"| W{"Any sibling still<br/>composing or verifying?"}
  W -->|"yes"| END["Run ends; the last sibling selects"]
  W -->|"no"| CL{"Claim: UPDATE anchor<br/>selection_json from NULL"}
  CL -->|"another run holds it"| END
  CL -->|"claimed"| R["Rank the group"]
  R -->|"one best"| A["Apply: losers rejected,<br/>Decision Receipt, candidate.selected"]
  R -->|"tie"| J["Integration Judge<br/>(one Sonnet call)"]
  R -->|"none promotable"| A
  J --> A
  A -->|"winner"| P
  A -->|"no valid preference"| H["Change awaiting_approval:<br/>a person picks"]
```

Integrate rule (before the fork rule, `workers/integration/src/integrate.ts`):

- Two Tasks of one Change whose planned semantic resources do not overlap (`todos:api` and `todos:ui`, `missions:calendar-ui` and `missions:kanban-ui`) are complementary parts of one plan, never alternatives. A `confirmed` or `fork_required` conflict between them has the fork decision `integrate` (`integrationFor` in `packages/conflict/src/integrate.ts`), at detection and after each model review.
- Order: an existing dependency path decides. Else the UI Task (a resource ending in `ui`, `-ui`, `frontend`, or `page`, or a title that says UI, page, or frontend) depends on the API Task (a resource ending in `api` or `-api`, or a title that says API). Else the Task whose Intent uses the other's contract (`consumedContracts`) depends on it. Else the higher Task key depends on the lower.
- Composition applies one integration per round, before any Candidate exists. One D1 transaction resolves the conflict (`review_json.integrate`), adds the edge to `task_dependencies`, rejects the ChangeSets of the dependent Task and the Tasks built on it, resolves their other open conflicts, resets those Tasks to `pending` with a new attempt window, moves the Change from `verifying` to `running`, and records the Decision Receipt `CONFLICT_INTEGRATION`. Then the Event `conflict.integrated`, the Challenge resolution (`upheld`), and the dispatch follow. A lost delivery repeats on the next `candidate.create` (`recoverIntegrations`).
- The dependent Task re-runs once on a stacked workspace that includes the other Task's ChangeSet, with an instruction to build against its real routes, field names, and data shapes. No Candidate composes until the re-run completes and the Change records `verification.started` again. The Candidate then holds both ChangeSets.
- Once per Task pair: a later conflict on an integrated pair follows the fork rule. Only Tasks on overlapping semantic resources with incompatible designs are fork alternatives.

Contract declarations: an agent's contract lines become typed contract changes (`parseContractChange` in `packages/conflict/src/declaration.ts`). HTTP method names (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) are part of a route and never change verbs: `DELETE /api/todos/:id -> {ok:true}` changes that route, and only wording such as "Removes DELETE /api/todos/:id" is a removal. A line that says "None" or "No change", or that only uses, consumes, or calls routes, is not a contract change. Its routes become the Intent's `consumedContracts`, which conflict detection never compares.

Fork rule:

- No counting fork conflict: one Candidate from every proposed ChangeSet.
- A fork conflict whose state is `confirmed`: one Candidate per side, each with the shared ChangeSets.
- A fork conflict whose state is `fork_required` (the conflict review said `needs_more_evidence`): the two side Candidates plus a combined Candidate (shared, both sides, and the ChangeSets that need both sides), within `MAX_CANDIDATES` (3). The combined Candidate is the evidence the review asked for: whether the sides work together.

Selection:

- The anchor is the earliest Candidate of the group (`created_at`, then ID). One conditional `UPDATE candidates SET selection_json = ... WHERE selection_json IS NULL` on the anchor claims the selection. A retry by the claimant proceeds. Every other run stops.
- Order: only promotable Candidates (every required check passed); then most acceptance criteria met; then fewer gaps and optional failures; then more passing checks.
- A tie goes to the Integration Judge (section 22.5). It reads only the Evidence snapshot of the tied Candidates (Evidence summaries and acceptance results) and fetches nothing. Its verdict is closed: `prefer_candidate` (with a Candidate ID), `reject_candidate`, `needs_more_evidence`, or `escalate_to_human`. Code validates the cited Evidence IDs. Only a valid `prefer_candidate` picks a winner. Anything else moves the Change to `awaiting_approval`, and a person promotes one Candidate.
- Each verified loser becomes `rejected` with a reason such as "Lost to cand_x: met 3 of 3 criteria, this met 2 of 3." Every Candidate of the group stores the outcome in `selection_json`. The decision is a Decision Receipt (`CANDIDATE_SELECTION`) and the Event `candidate.selected`.
- Only the winner takes the promotion path: the acceptance hold, policy `autoPromoteRiskTiers`, the approval gate (`approval.requested` for a gated winner), and the compare-and-swap. A Candidate without siblings takes the same path.
- A manual promotion is blocked (`selection_pending`) while a sibling still composes or verifies.

## Coverage states and the gate

Each Evidence record has a `status` (`pass`, `fail`, `error`, `skipped`) and a `coverage` (`not_checked`, `checked_no_signal`, `checked_supported`).
`gateRequiredChecks` reads the latest record of each required check.

```mermaid
flowchart TB
  R["Required check"] --> E{"Any Evidence?"}
  E -->|"no"| G1["gap: missing"]
  E -->|"yes"| TO{"Duration within timeout?"}
  TO -->|"no"| G2["gap: timed_out"]
  TO -->|"yes"| S{"status"}
  S -->|"skipped"| G3["gap: skipped"]
  S -->|"error"| G4["gap: error"]
  S -->|"fail"| G5["gap: failed"]
  S -->|"pass"| C{"coverage"}
  C -->|"not_checked"| G6["gap: not_checked"]
  C -->|"checked_no_signal"| G7["gap: no_signal"]
  C -->|"checked_supported"| M{"metric_below met?"}
  M -->|"no"| G8["gap: expectation_not_met"]
  M -->|"yes or not a metric"| OK["satisfied"]
```

On a tie in completion time, a non-passing record wins.
The UI shows every gap. It never shows a gap as green.
Model findings must cite what the model received: conflict reviews cite Context Packet item IDs, the acceptance check cites quotes of the patch, and the Integration Judge cites Evidence IDs. A finding with a bad citation is `unsupported` and cannot change state.

## Promotion preconditions

Promotion has two deterministic layers (ADR 0013).
The integration Worker checks section 36 preconditions 1 to 5 and 8 from authoritative D1 rows and Artifacts.
ProjectRootDO then checks preconditions 6 and 7 and the policy version inside its own transaction.

```mermaid
flowchart TB
  REQ["POST /v1/candidates/:id/promote"] --> P0{"Sibling still<br/>verifying?"}
  P0 -->|"yes"| BLK
  P0 -->|"no"| P1{"Candidate verified<br/>and base = canonical?"}
  P1 -->|"base behind"| STALE["mark stale, then recompose<br/>or block the Change"]
  P1 -->|"not verified"| BLK["blocked: list every block"]
  P1 -->|"yes"| P2{"Plan present and<br/>every required check passes?"}
  P2 -->|"no"| BLK
  P2 -->|"yes"| P3{"Approval granted<br/>for this composed tree?"}
  P3 -->|"pending or rejected"| BLK
  P3 -->|"granted or not required"| P4{"Plan policy = active policy,<br/>composed commit in cand fork?"}
  P4 -->|"no"| BLK
  P4 -->|"yes"| CAS{"ProjectRootDO.promote:<br/>generation and tree match?"}
  CAS -->|"already promoted"| DONE["return alreadyPromoted"]
  CAS -->|"mismatch"| STALE
  CAS -->|"policy mismatch"| BLK
  CAS -->|"match"| ADV["One transaction:<br/>generation + 1, canonical.advanced"]
  ADV --> SYNC["Fast-forward main,<br/>start release,<br/>settle older-base Candidates"]
```

Approval rules (`packages/evidence/src/promotion.ts`):

- A human gate applies when the plan asks for one (an authorization change) or the policy gates the risk tier (`high`, `critical`).
- A grant counts only for the exact composed tree that the approver saw.
- The first decision is final. A rejection also rejects the Candidate.
- No model decides approval or promotion (section 22.7).

The idempotency key is the Candidate ID plus the expected generation.
A retry after success returns `alreadyPromoted` and repairs the D1 mirror and the source sync.
