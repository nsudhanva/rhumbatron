# ADR 0030: Budget scopes for requests, Projects, and users

## Context

Each request (Change) has its own budget, `changes.budget_usd`. People also want to spend from a
shared pool: one monthly budget for the whole Project, or one monthly budget for their own
requests across Projects. These rules apply:

- No autonomous work runs without a budget. A budget stop keeps all state and names the exact
  budget.
- The monthly Anthropic budget of the environment (`ANTHROPIC_MONTHLY_BUDGET_USD`, ADR 0021) is
  the hard stop of the account. Code enforces it on the D1 meter `usage_counters`.
- Stay in the Cloudflare free limits. Add no new database, and add no extra request per call
  beyond a small D1 read and one D1 batch.
- Roles decide who may act, never what is built (ADR 0025, ADR 0028).

## Decision

- A Change has a budget scope, `changes.budget_scope`: `change` (default), `project`, or
  `account`. Scope `change` keeps the Change cap `budget_usd`. Scopes `project` and `account`
  have no cap of their own. They draw on the Project monthly budget (`projects.monthly_budget_usd`)
  or the requester monthly budget (`users.monthly_budget_usd`). Each monthly budget is 1 to 100
  USD, or null for no cap. When a Change has a pool scope and no such budget exists, the create
  fails with 400 `no_budget_set`.
- The owner or an admin sets the Project budget (`settings.edit`). Each user sets their own
  budget (`PATCH /v1/me/budget`). Nobody else can change a user budget.
- Meters are `usage_counters` rows in micro-USD: `change-usd-micro:<changeId>` (`day` = `total`),
  `project-usd-micro:<projectId>` and `user-usd-micro:<userId>` (`day` = `YYYY-MM`), and
  `anthropic-usd-micro`. Every meter counts every call. A cap applies only when it is set, so the
  spend of the month shows before a person sets a cap.
- Every model call that a Change pays for reserves its estimate on all meters of the Change in one
  D1 batch. The batch first makes sure that the rows exist. Then one UPDATE adds the reservation to
  every row, but only when no capped meter would pass its cap. After the call, every meter settles
  to the exact cost. The calls
  are the agent runs (Pi), context compaction, conflict review, the Root Planner, intake review,
  request review, the acceptance check, and the Integration Judge
  (`packages/model-router/src/budget-meters.ts`, `meteredComplete` with `meters`).
- The Project and user caps always apply as ceilings, whichever scope the Change has.
- A refused reservation sends no call. A Change in `compiling` or `running` becomes
  `budget_blocked`, with `blocked_limit` set to `change_budget`, `project_budget`,
  `account_budget`, or `monthly_model_spend`. When several meters refuse, the narrowest budget is named. The reason
  names the budget, its amount, the month, and who can raise it.
- A run whose share of the request budget runs out fails as `run_cost_cap`. When the attempt
  limit then stops the Task, the stop is `change_budget`. Only the attempt limit uses the text
  "this task failed 2 times".
- During verification, a refused call does not block the Change. The acceptance check records a
  gap that names the budget. A refused Integration Judge call sends the choice to a person.
- Resume:
  - A raise of the Change budget (`POST /v1/changes/:changeId/budget`) resumes the Change.
  - A raise of the Project budget resumes the Changes of the Project that the Project budget
    stopped.
  - A raise of a user budget resumes the Changes of that user that their budget stopped.

  All three use one restore path.
  A Change that a budget stopped while planning returns to `compiling`, and a new ChangeWorkflow
  instance plans it again.
- A Change with a pool scope stores 100 USD in `budget_usd`. The per-Task shares of the agents
  stay finite, and the pool caps the Change. The API shows `capUsd: null` for it.

## Alternatives considered

- Compute the spend of each pool from `task_runs` and the other cost rows on every call.
  Rejected. The check and the admission are then two steps, so two concurrent calls can both take
  the last dollars. Also, the sum over a month of Changes grows with the Project.
- One reservation statement per meter. Rejected. A refusal on the third meter leaves the first
  two reserved. The single conditional UPDATE is all or nothing.
- Meter a Project or a user only while a cap is set. Rejected. The spend of the month is then
  unknown when a person first sets a cap.

## Consequences

- One extra D1 read (the caps) and one D1 batch per model call. The batch replaces the single
  monthly-meter statement. D1 rows written per call stay within the free daily limit at the
  current call caps (400 agent calls per day).
- A deleted Project keeps its meter rows. They hold an ID and an amount, and a user meter must
  keep the spend of the month across Projects.
- The reservation is an estimate (full output cap, whole prompt uncached). Near a cap, the meter
  can refuse a call that costs less than the estimate. Settlement returns the unused part at once.
- The column default of `budget_scope` is `change`. The Change meter counts only calls that
  reserve on it, so the Change read shows the larger of the meter and the recorded spend of runs,
  reviews, acceptance checks, and the judge.
