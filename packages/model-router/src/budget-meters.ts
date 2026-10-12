import {
  type BudgetLimit,
  type BudgetScope,
  CHANGE_METER_DAY,
  METER_COUNTER,
} from "@rhumbatron/protocol";
import { USAGE_COUNTER } from "./provider.ts";

/**
 * Budget meters of one Change (ADR 0030, docs/operations/costs.md "Budget scopes"). Every model
 * call that a Change pays for reserves its estimate on each meter of the Change in one D1 batch,
 * then settles each meter to the exact cost. The meters are rows of `usage_counters` in micro-USD:
 *
 * - `change-usd-micro:<changeId>`, `day` = `total`: the Change. Capped by `changes.budget_usd`
 *   when the Change scope is `change`.
 * - `project-usd-micro:<projectId>`, `day` = `YYYY-MM`: the Project this month. Capped by
 *   `projects.monthly_budget_usd` when it is set.
 * - `user-usd-micro:<userId>`, `day` = `YYYY-MM`: the requester this month, across Projects.
 *   Capped by `users.monthly_budget_usd` when it is set.
 * - `anthropic-usd-micro`, `day` = `YYYY-MM`: the environment (ADR 0021). Always capped.
 *
 * A meter without a cap still counts, so the month's spend of a Project or a user is known before
 * a cap is set. Project and user caps apply whichever scope the Change has.
 */

/** One `usage_counters` row. */
export type MeterKey = { day: string; counter: string };

/** A meter of a Change. `capUsd` null: the meter counts, nothing caps it. */
export type SpendMeter = MeterKey & { limit: BudgetLimit; capUsd: number | null };

/** The stop that names a refusal when several meters refuse: the narrowest budget first. */
const LIMIT_ORDER: readonly BudgetLimit[] = [
  "change_budget",
  "project_budget",
  "account_budget",
  "monthly_model_spend",
];

const micro = (usd: number) => Math.ceil(Math.max(0, usd) * 1_000_000);

/**
 * The meter that refuses `usd` more, from the current counts (micro-USD), or null when every
 * capped meter has room. A missing count is zero. Pure: the reservation and the run start share it.
 */
export function refusedMeter(
  meters: readonly SpendMeter[],
  counts: ReadonlyMap<string, number>,
  usd: number,
): SpendMeter | null {
  const add = micro(usd);
  const refused = meters.filter(
    (m) => m.capUsd !== null && (counts.get(keyOf(m)) ?? 0) + add > micro(m.capUsd),
  );
  if (refused.length === 0) return null;
  return [...refused].sort(
    (a, b) => LIMIT_ORDER.indexOf(a.limit) - LIMIT_ORDER.indexOf(b.limit),
  )[0] as SpendMeter;
}

export const keyOf = (m: MeterKey) => `${m.day}\u0000${m.counter}`;

/** The minimum of D1 the batch functions use; D1Database satisfies it. */
export type MeterBatchDb = {
  prepare(query: string): { bind(...values: unknown[]): unknown };
  batch(statements: never[]): Promise<{ results?: unknown[]; meta?: { changes?: number } }[]>;
};

const rowsWhere = (meters: readonly MeterKey[], alias = "") =>
  meters.map(() => `(${alias}day = ? AND ${alias}counter = ?)`).join(" OR ");
const rowsParams = (meters: readonly MeterKey[]) => meters.flatMap((m) => [m.day, m.counter]);

/**
 * Reserves `usd` on every meter in one D1 batch, all or nothing: the rows exist first, then one
 * UPDATE adds the reservation to all of them only when no capped meter would pass its cap, then
 * the counts are read to name the refusing meter. Nothing is written on a refusal.
 */
export async function reserveMeters(
  db: MeterBatchDb,
  meters: readonly SpendMeter[],
  usd: number,
): Promise<{ ok: true } | { ok: false; meter: SpendMeter }> {
  if (meters.length === 0) return { ok: true };
  const add = micro(usd);
  const capped = meters.filter((m) => m.capUsd !== null);
  const over = capped.length
    ? ` AND NOT EXISTS (SELECT 1 FROM usage_counters u WHERE ${capped
        .map(() => "(u.day = ? AND u.counter = ? AND u.count + ? > ?)")
        .join(" OR ")})`
    : "";
  const statements = [
    db
      .prepare(
        `INSERT INTO usage_counters (day, counter, count) VALUES ${meters
          .map(() => "(?, ?, 0)")
          .join(", ")} ON CONFLICT (day, counter) DO NOTHING`,
      )
      .bind(...rowsParams(meters)),
    db
      .prepare(`UPDATE usage_counters SET count = count + ? WHERE (${rowsWhere(meters)})${over}`)
      .bind(
        add,
        ...rowsParams(meters),
        ...capped.flatMap((m) => [m.day, m.counter, add, micro(m.capUsd ?? 0)]),
      ),
    db
      .prepare(`SELECT day, counter, count FROM usage_counters WHERE ${rowsWhere(meters)}`)
      .bind(...rowsParams(meters)),
  ];
  const results = await db.batch(statements as never[]);
  if ((results[1]?.meta?.changes ?? 0) >= meters.length) return { ok: true };
  const counts = new Map(
    ((results[2]?.results ?? []) as { day: string; counter: string; count: number }[]).map((r) => [
      keyOf(r),
      r.count,
    ]),
  );
  // The batch added nothing, so the counts are those before this reservation.
  const meter = refusedMeter(meters, counts, usd) ?? (capped[0] as SpendMeter);
  return { ok: false, meter };
}

/**
 * Settles a reservation on every meter: adds `actualUsd - reservedUsd` (negative returns the
 * unused part). Always applies, even past a cap: the meters record real spend.
 */
export async function settleMeters(
  db: MeterBatchDb,
  meters: readonly MeterKey[],
  reservedUsd: number,
  actualUsd: number,
): Promise<void> {
  const delta = micro(actualUsd) - micro(reservedUsd);
  if (delta === 0 || meters.length === 0) return;
  await db.batch(
    meters.map((m) =>
      db
        .prepare(
          `INSERT INTO usage_counters (day, counter, count) VALUES (?, ?, MAX(?, 0))
           ON CONFLICT (day, counter) DO UPDATE SET count = MAX(count + ?, 0)`,
        )
        .bind(m.day, m.counter, delta, delta),
    ) as never[],
  );
}

/** The minimum of D1 the read functions use; D1Database satisfies it. */
type ReadDb = {
  prepare(query: string): {
    bind(...values: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null> };
  };
};

/** The budgets of one Change, read in one query. */
export type ChangeBudgets = {
  changeId: string;
  projectId: string;
  requesterUserId: string | null;
  scope: BudgetScope;
  changeCapUsd: number;
  projectCapUsd: number | null;
  accountCapUsd: number | null;
};

export async function readChangeBudgets(
  db: ReadDb,
  changeId: string,
): Promise<ChangeBudgets | null> {
  const row = await db
    .prepare(
      `SELECT c.project_id, c.created_by, c.budget_scope, c.budget_usd,
              p.monthly_budget_usd AS project_cap, u.monthly_budget_usd AS user_cap
       FROM changes c JOIN projects p ON p.id = c.project_id
       LEFT JOIN users u ON u.id = c.created_by WHERE c.id = ?`,
    )
    .bind(changeId)
    .first<{
      project_id: string;
      created_by: string | null;
      budget_scope: string | null;
      budget_usd: number;
      project_cap: number | null;
      user_cap: number | null;
    }>();
  if (!row) return null;
  const scope: BudgetScope =
    row.budget_scope === "project" || row.budget_scope === "account" ? row.budget_scope : "change";
  return {
    changeId,
    projectId: row.project_id,
    requesterUserId: row.created_by,
    scope,
    changeCapUsd: row.budget_usd,
    projectCapUsd: row.project_cap,
    accountCapUsd: row.user_cap,
  };
}

/** Every meter of a Change this month, with the caps of `budgets`. Pure. */
export function changeMeters(
  budgets: ChangeBudgets | null,
  globalBudgetUsd: number,
  month: string,
): SpendMeter[] {
  const global: SpendMeter = {
    limit: "monthly_model_spend",
    day: month,
    counter: USAGE_COUNTER.anthropicSpend,
    capUsd: globalBudgetUsd,
  };
  if (!budgets) return [global];
  return [
    {
      limit: "change_budget",
      day: CHANGE_METER_DAY,
      counter: METER_COUNTER.change(budgets.changeId),
      capUsd: budgets.scope === "change" ? budgets.changeCapUsd : null,
    },
    {
      limit: "project_budget",
      day: month,
      counter: METER_COUNTER.project(budgets.projectId),
      capUsd: budgets.projectCapUsd,
    },
    ...(budgets.requesterUserId
      ? [
          {
            limit: "account_budget" as const,
            day: month,
            counter: METER_COUNTER.user(budgets.requesterUserId),
            capUsd: budgets.accountCapUsd,
          },
        ]
      : []),
    global,
  ];
}

/** "October" from `2026-10`. */
function monthWord(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * The stop reason of a budget stop (`changes.blocked_reason`): which budget is used up and how to
 * raise it. Never the attempt-limit text.
 */
export function budgetStopText(limit: BudgetLimit, capUsd: number | null, month: string): string {
  const cap = capUsd === null ? "" : ` of ${usd(capUsd)}`;
  switch (limit) {
    case "change_budget":
      return `Stopped: the request budget${cap} is used up. An owner or admin can raise it on the Change page.`;
    case "project_budget":
      return `Stopped: the project budget${cap} for ${monthWord(month)} is used up. An owner or admin can raise it in Settings.`;
    case "account_budget":
      return `Stopped: the requester's monthly budget${cap} for ${monthWord(month)} is used up. The requester can raise it on the Account page.`;
    case "monthly_model_spend":
      return `Paused: this month's model budget${capUsd === null ? "" : ` of $${Number.isInteger(capUsd) ? capUsd : capUsd.toFixed(2)}`} is used up, or Anthropic refused the call for billing. Work continues next month, or when an operator raises the budget.`;
  }
}

/**
 * Marks a Change `budget_blocked` with the budget that refused a call. Only from `compiling` (the
 * planner and intake) and `running` (agents and conflict reviews): both resume when the budget is
 * raised. Returns true when this call blocked the Change.
 */
export async function blockChangeOnBudget(
  db: { prepare(query: string): { bind(...values: unknown[]): { run(): Promise<unknown> } } },
  changeId: string,
  meter: SpendMeter,
  month: string,
  now = new Date().toISOString(),
): Promise<boolean> {
  const result = (await db
    .prepare(
      `UPDATE changes SET status = 'budget_blocked', blocked_limit = ?, blocked_reason = ?,
         updated_at = ?
       WHERE id = ? AND status IN ('compiling', 'running')`,
    )
    .bind(meter.limit, budgetStopText(meter.limit, meter.capUsd, month), now, changeId)
    .run()) as { meta?: { changes?: number } };
  return (result.meta?.changes ?? 0) > 0;
}
