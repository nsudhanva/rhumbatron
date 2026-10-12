import { CHANGE_METER_DAY } from "@rhumbatron/protocol";

/**
 * Spend reads shared by `GET /v1/me/costs` and the admin routes (ADR 0033). Every figure reads a
 * `usage_counters` meter in micro-USD (packages/model-router/src/budget-meters.ts); an open
 * reservation counts until it settles. Each meter read is a primary-key lookup on (day, counter).
 */

export const microToUsd = (micro: number | null | undefined) => (micro ?? 0) / 1_000_000;

/** This calendar month, `YYYY-MM` (UTC). */
export const monthOf = (now: Date) => now.toISOString().slice(0, 7);

/** The last `count` calendar months, oldest first, ending with the month of `now`. */
export function monthList(now: Date, count: number): string[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(year, month - (count - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

/**
 * Select expression: the Change meter (micro-USD, all time) of the Change row aliased `alias`.
 * It counts every model call that the Change paid for: planner, intake, agent runs, reviews, the
 * acceptance check, and the Integration Judge.
 */
export const changeMeterSql = (alias: string) =>
  `(SELECT count FROM usage_counters WHERE day = '${CHANGE_METER_DAY}'
     AND counter = 'change-usd-micro:' || ${alias}.id)`;

/**
 * Select expression: the all-time total of one meter in micro-USD, summed over every month.
 * The user and Project meters survive Project deletion; the Change rows do not.
 */
export const meterTotalSql = (prefix: string, idExpr: string) =>
  `(SELECT COALESCE(SUM(count), 0) FROM usage_counters WHERE counter = '${prefix}' || ${idExpr})`;

/** The monthly rows of one meter counter, for the given months. Missing months are 0. */
export async function monthlyMeter(
  db: D1Database,
  counter: string,
  months: string[],
): Promise<{ month: string; spendUsd: number }[]> {
  const rows = await db
    .prepare(
      `SELECT day, count FROM usage_counters
       WHERE counter = ? AND day IN (${months.map(() => "?").join(", ")})`,
    )
    .bind(counter, ...months)
    .all<{ day: string; count: number }>();
  const byMonth = new Map((rows.results ?? []).map((r) => [r.day, r.count] as const));
  return months.map((month) => ({ month, spendUsd: microToUsd(byMonth.get(month)) }));
}

/** The environment meter: every model call, per calendar month (ADR 0021). */
export const ENVIRONMENT_METER = "anthropic-usd-micro";

/**
 * `[low, high)` bounds of every counter that starts with `prefix` (which ends with `:`). `;` is the
 * character after `:`, so `counter >= low AND counter < high` is a range on the counter index.
 */
export const prefixRange = (prefix: string): [string, string] => [
  prefix,
  `${prefix.slice(0, -1)};`,
];

/**
 * The spend totals of a list (ADR 0033): the meters with `prefix` this month and all time, and the
 * environment meter of the same periods. Binds `?1` month, `?2`..`?3` the prefix range, `?4` the
 * environment meter.
 */
export function listTotalsStatement(db: D1Database, prefix: string, month: string) {
  const [low, high] = prefixRange(prefix);
  return db
    .prepare(
      `SELECT
         (SELECT COALESCE(SUM(count), 0) FROM usage_counters
           WHERE day = ?1 AND counter >= ?2 AND counter < ?3) AS month_micro,
         (SELECT COALESCE(SUM(count), 0) FROM usage_counters
           WHERE counter >= ?2 AND counter < ?3) AS all_micro,
         (SELECT COALESCE(SUM(count), 0) FROM usage_counters
           WHERE day = ?1 AND counter = ?4) AS env_month_micro,
         (SELECT COALESCE(SUM(count), 0) FROM usage_counters WHERE counter = ?4) AS env_all_micro`,
    )
    .bind(month, low, high, ENVIRONMENT_METER);
}

export type ListTotalsRow = {
  month_micro: number | null;
  all_micro: number | null;
  env_month_micro: number | null;
  env_all_micro: number | null;
};

/** The totals view of a `listTotalsStatement` row. Unattributed is never below 0. */
export function listTotals(row: ListTotalsRow | null | undefined) {
  const month = row?.month_micro ?? 0;
  const all = row?.all_micro ?? 0;
  return {
    monthUsd: microToUsd(month),
    allTimeUsd: microToUsd(all),
    unattributedMonthUsd: microToUsd(Math.max(0, (row?.env_month_micro ?? 0) - month)),
    unattributedAllTimeUsd: microToUsd(Math.max(0, (row?.env_all_micro ?? 0) - all)),
  };
}
