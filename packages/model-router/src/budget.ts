import type { ModelTier } from "@rhumbatron/protocol";

/**
 * Budgets (ADR 0019, ADR 0021). Hard limits: calls per Task run, agent calls
 * per UTC day, the Change budget, and the monthly Anthropic USD budget of this environment, which
 * code enforces on the D1 meter (spend-meter.ts). Past any of them the work stops; there is no
 * fallback to another paid provider.
 */

/** Hard cap on model calls in one Task run, by tier. */
/** Coding Tasks read, write, and test, so sonnet and opus get more room than haiku. */
export const MAX_CALLS_PER_RUN: Record<ModelTier, number> = { haiku: 16, sonnet: 32, opus: 32 };

/** Daily cap on agent model calls. */
export const AGENT_DAILY_CALL_CAP = 1000;

/**
 * Fallback for the `ANTHROPIC_MONTHLY_BUDGET_USD` binding: a low safe budget ($10 per calendar
 * month), so a Worker without the binding never spends the prod budget (Terraform `envs/prod`).
 */
export const ANTHROPIC_MONTHLY_BUDGET_FALLBACK_USD = 10;

/** This environment's monthly Anthropic budget in USD from the binding, else the $10 fallback. */
export function anthropicMonthlyBudgetUsd(configured?: string): number {
  const usd = Number(configured);
  return configured && Number.isFinite(usd) && usd >= 0
    ? usd
    : ANTHROPIC_MONTHLY_BUDGET_FALLBACK_USD;
}

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
