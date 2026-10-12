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
