import {
  type CompletionRequest,
  type CompletionResult,
  complete,
  type GatewayConfig,
  ModelCallError,
} from "./gateway-client.ts";
import { resolveTier } from "./models.ts";
import { anthropicPrice, USAGE_COUNTER } from "./provider.ts";

/**
 * Monthly Anthropic spend meter (ADR 0021, AGENTS.md rule 50). One `usage_counters` row per
 * calendar month (`day` = YYYY-MM, counter `anthropic-usd-micro`) holds micro-USD. Every model call
 * reserves an estimate first with one conditional statement (full output cap, prompt uncached), so
 * concurrent calls cannot both take the last dollars; the call then settles the difference to its
 * exact cost. A refused
 * reservation is a budget stop: no call is sent, and no other provider is tried.
 */

/** The minimum of D1 this module uses; D1Database satisfies it. */
export type MeterDb = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
};

export const spendMonth = (now: Date = new Date()) => now.toISOString().slice(0, 7);

export const toMicroUsd = (usd: number) => Math.ceil(Math.max(0, usd) * 1_000_000);

/** Prompt tokens assumed for a reservation when the caller cannot count them. */
const DEFAULT_PROMPT_TOKENS = 30_000;

/**
 * Estimate of one call: the whole prompt uncached at the input rate plus every output token up to
 * the cap. Usually above the real cost (cache reads are 0.05x to 0.1x); settlement corrects it.
 */
export function reserveEstimateUsd(
  model: string,
  maxOutputTokens: number,
  promptTokens = DEFAULT_PROMPT_TOKENS,
): number {
  const price = anthropicPrice(model, promptTokens);
  return (promptTokens * price.input + maxOutputTokens * price.output) / 1_000_000;
}

/**
 * Reserves `usd` on this month's meter. False, and nothing written, when the meter plus the
 * reservation would pass `budgetUsd`.
 */
export async function reserveSpend(
  db: MeterDb,
  month: string,
  usd: number,
  budgetUsd: number,
): Promise<boolean> {
  const micro = toMicroUsd(usd);
  const cap = toMicroUsd(budgetUsd);
  if (micro > cap) return false;
  const row = await db
    .prepare(
      `INSERT INTO usage_counters (day, counter, count) VALUES (?, ?, ?)
       ON CONFLICT (day, counter) DO UPDATE SET count = count + ? WHERE count + ? <= ?
       RETURNING count`,
    )
    .bind(month, USAGE_COUNTER.anthropicSpend, micro, micro, micro, cap)
    .first<{ count: number }>();
  return row !== null;
}

/**
 * Settles a reservation: adds `actualUsd - reservedUsd` (negative returns the unused part). Always
 * applies, even past the budget: the meter records real spend.
 */
export async function settleSpend(
  db: MeterDb,
  month: string,
  reservedUsd: number,
  actualUsd: number,
): Promise<void> {
  const delta = toMicroUsd(actualUsd) - toMicroUsd(reservedUsd);
  if (delta === 0) return;
  await db
    .prepare(
      `INSERT INTO usage_counters (day, counter, count) VALUES (?, ?, MAX(?, 0))
       ON CONFLICT (day, counter) DO UPDATE SET count = MAX(count + ?, 0)`,
    )
    .bind(month, USAGE_COUNTER.anthropicSpend, delta, delta)
    .run();
}

/** Recorded spend this month in USD, open reservations included. */
export async function monthSpentUsd(db: MeterDb, month: string): Promise<number> {
  const row = await db
    .prepare("SELECT count FROM usage_counters WHERE day = ? AND counter = ?")
    .bind(month, USAGE_COUNTER.anthropicSpend)
    .first<{ count: number }>();
  return (row?.count ?? 0) / 1_000_000;
}

/** Rough prompt size for a reservation: 4 characters per token, never below 1,000 tokens. */
function promptTokensOf(req: CompletionRequest): number {
  const chars = JSON.stringify(req.messages).length + JSON.stringify(req.tools ?? []).length;
  return Math.max(1_000, Math.ceil(chars / 4));
}

/**
 * One `complete` call admitted by the monthly budget: reserve the estimate, call, settle to the
 * exact cost. An HTTP error response settles to zero (Anthropic bills no rejected request); a
 * timeout or network failure keeps the reservation, because the request may still have run.
 * A refused reservation throws `spend_limited` and sends nothing.
 */
export async function meteredComplete(
  meter: { db: MeterDb; budgetUsd: number },
  config: GatewayConfig,
  req: CompletionRequest,
): Promise<CompletionResult> {
  const { model } = resolveTier(req.tier, config.allowOpus === true);
  const month = spendMonth();
  const reservedUsd = reserveEstimateUsd(model, req.maxOutputTokens, promptTokensOf(req));
  if (!(await reserveSpend(meter.db, month, reservedUsd, meter.budgetUsd))) {
    throw new ModelCallError("spend_limited", "Monthly Anthropic budget reached", null);
  }
  let result: CompletionResult;
  try {
    result = await complete(config, req);
  } catch (error) {
    if (error instanceof ModelCallError && error.status !== null) {
      await settleSpend(meter.db, month, reservedUsd, 0);
    }
    throw error;
  }
  await settleSpend(meter.db, month, reservedUsd, result.costUsd);
  return result;
}
