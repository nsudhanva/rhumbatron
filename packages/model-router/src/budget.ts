import type { ModelTier } from "@rhumbatron/protocol";

/**
 * Budgets (AGENTS.md section 24). Free models cost $0, so the hard limit that matters is the number
 * of model calls: per Task run, and per day across the account (OpenRouter allows 50 free calls per
 * day below $10 of credit purchases).
 */

/** Hard cap on model calls in one Task run, by tier. */
export const MAX_CALLS_PER_RUN: Record<ModelTier, number> = { haiku: 6, sonnet: 10, opus: 10 };

/** Daily cap on agent model calls, kept below the OpenRouter free limit for other callers. */
export const AGENT_DAILY_CALL_CAP = 40;

/** A Task's share of what is left of its Change budget. Never negative. */
export function taskBudgetUsd(
  changeBudgetUsd: number,
  spentUsd: number,
  openTasks: number,
): number {
  const remaining = Math.max(0, changeBudgetUsd - spentUsd);
  return openTasks > 0 ? remaining / openTasks : 0;
}

export type BudgetCheck = { ok: true } | { ok: false; reason: "call_cap" | "cost_cap" };

export function checkRunBudget(input: {
  tier: ModelTier;
  callsSoFar: number;
  spentUsd: number;
  budgetUsd: number;
}): BudgetCheck {
  if (input.callsSoFar >= MAX_CALLS_PER_RUN[input.tier]) return { ok: false, reason: "call_cap" };
  if (input.spentUsd > input.budgetUsd) return { ok: false, reason: "cost_cap" };
  return { ok: true };
}
