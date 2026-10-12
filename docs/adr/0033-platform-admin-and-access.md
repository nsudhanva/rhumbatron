# ADR 0033: Platform admin, sign-up approval, and user costs

## Context

Rhumbatron runs on one prod environment with a fixed monthly spend (ADR 0017, ADR 0021). Any
person with a Clerk account can sign in. These requirements apply:

- The operator must see the whole platform: spend against each cap, people, Projects, costs, and
  events. Project roles (ADR 0028) do not give this view. They are per Project.
- The operator must be able to hold new people until a person approves them, so that a stranger
  cannot spend the shared budget.
- Each person must see their own spend: per month, per Project, and per request.
- Prompts and request fields never grant authority (AGENTS.md section 40). Stay in the Cloudflare
  free limits: add no new service and no new database.

## Decision

- One platform admin list. The Terraform variable `platform_admin_user_ids` (default: Sudhanva,
  `usr_user_3KVgK2jUomozHjWQw7kPaVopRLq`) becomes the plain_text binding
  `PLATFORM_ADMIN_USER_IDS` (a JSON array) on the API Worker. Local development has `[]`.
- The API decides admin rights from the user ID of the verified session only
  (`isPlatformAdmin` in `workers/api/src/access.ts`). A malformed list gives no admin. No request
  field, header, or query value can name an admin. The web reads `platformAdmin` from `GET /v1/me`.
- The admin panel reads only. Two writes exist: the sign-up approval switch, and the access
  decision of a person (approve, decline, or approve all pending people).
- Access gate. `users.access_status` is `approved`, `pending`, or `declined` (migration
  `0035_platform_admin_and_access.sql`). Existing users stay `approved`. `requireAuth` runs the
  gate after the session check:
  - The first request of a new person creates the user row. While `platform_settings` key
    `signup_approval_required` is `"true"`, the row is `pending`. Otherwise it is `approved`. A
    missing setting row means `"false"`.
  - A platform admin is always approved.
  - A person who is not approved gets 403 `approval_required` with `details.status` (`pending`
    or `declined`) on every route except `GET /v1/me`. Sign-out is a Clerk action in the browser
    and needs no API route.
  - Turning the switch off approves nobody. The admin decides each pending person, or approves
    all of them with one action.
- Every admin read and write adds one `admin_audit` row: the admin user ID, the action, the
  target, and the time. The API deletes rows older than 365 days.
- Notifications are derived, as for all other items (migration 0012). Each platform admin gets
  `access_request:<userId>` for each pending person. A person gets `access_decided:<userId>` for
  7 days after an admin decides their access.
- Costs come only from recorded data:
  - `usage_counters` meters (micro-USD): `anthropic-usd-micro` (the environment, per month),
    `user-usd-micro:<userId>` and `project-usd-micro:<projectId>` (per month), and
    `change-usd-micro:<changeId>` (per Change, all time). The meters count every model call that a
    request pays for: the Root Planner, the intake check, agent runs, conflict reviews, the
    acceptance check, and the Integration Judge. An open reservation counts until it settles.
  - `task_runs`: one row per agent Task attempt, with model calls, tokens, cost, tier, and start
    time. This is the only per-call record with tokens. The Root Planner, the intake check,
    conflict reviews, the acceptance check, and the Integration Judge write no `task_runs` row.
  - The user and Project meters start on 2026-10-11 (migration 0031). The environment meter
    starts earlier and also counts model calls that no request pays for. The difference is
    "Not attributed". The admin never assigns it to a person or a Project.
  - Every total adds up to the environment meter:
    - The Overview gives `spendUsd` (the environment meter this month), `attributedUsd` (the sum
      of the user meters this month), and `unattributedUsd` (the difference, never below 0).
    - The Users and Projects lists give `totals`: `monthUsd` and `allTimeUsd` (the sum of every
      user meter or every Project meter, whatever the filters and the page), and
      `unattributedMonthUsd` and `unattributedAllTimeUsd` (the environment meter of the same
      period minus that sum, never below 0). The spend of each row reads its own meter only.
    - The cost report grouped by user or by Project reads the monthly meters. It snaps the date
      range to whole months. Without a user or Project filter, a row with key `unattributed`
      ("Not attributed") holds the environment meter minus the sum of the meters, so the rows add
      up to the environment meter.
    - The cost report grouped by model or by day reads `task_runs`. When the range is whole months
      (the first day of a month to the last day of a month, or to today), a row with key `other`
      ("Other model calls (no per-call record)") holds the matching meter minus the rows, never
      below 0. For any other range, `source` gives the meter total and says that no row holds the
      calls without a `task_runs` row.
    - A meter row has no call or token counts: `calls`, `inputTokens`, and `outputTokens` are
      null. The CSV leaves these cells empty.
  - Each response has a `source` text that names the data and what a number covers.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Clerk roles or Clerk Organizations for the admin | Rhumbatron does not use Clerk Organizations (ADR 0028). A Terraform variable keeps the admin list in reviewed code, and the API checks it without a Clerk call. |
| An admin flag in D1 | A D1 write could create an admin. The binding changes only through a Terraform apply. |
| Cloudflare Access in front of an admin page | It protects a host, not API routes that the web calls through a service binding. It adds a second identity system. |
| Clerk allowlist or restricted sign-up mode | It stops sign-up in Clerk, with no queue for the operator to decide and no record in Rhumbatron. |
| A cost table per model call | Every model caller would write one more D1 row per call. The meters and `task_runs` already hold the spend. |
| Refuse unknown people before the user row exists | The admin needs the row to see and approve the person. |

## Consequences

- Each authenticated request reads two primary-key rows more (the user status and the setting)
  in one D1 query. The first request of a new person adds one write. `users.last_seen_at` is
  written at most once per hour per person.
- The admin cost report reads `task_runs` through `idx_task_runs_started`, or the monthly meters
  through the `usage_counters` primary key (`day`, `counter`), at most 366 days and 1,000 rows.
  The list totals read the meters through `idx_usage_counters_counter`. Lists are pages of 50. The event list uses an index on (column, `seq`) for each
  filter: `project_id`, `actor_id`, and `event_type`.
- The two new `project_events` indexes add two index writes for each feed row. The feed holds at
  most 20,000 rows.
- A pending person can sign in and read `GET /v1/me`. The web shows one full-page message and no
  Project data.
- A change of the admin list needs a Terraform apply.
