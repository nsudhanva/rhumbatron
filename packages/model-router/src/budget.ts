import type { ModelTier } from "@rhumbatron/protocol";

/**
 * Budgets (AGENTS.md section 24). OpenRouter free models cost $0 and allow 50 calls per day below
 * $10 of credit purchases; Gemini on Vertex AI is the paid overflow (ADR 0016). Hard limits: calls
 * per Task run, calls per day per provider, and the AI Gateway spend cap on Vertex.
 */

/** Hard cap on model calls in one Task run, by tier. */
/** Coding Tasks read, write, and test, so sonnet and opus get more room than haiku. */
export const MAX_CALLS_PER_RUN: Record<ModelTier, number> = { haiku: 16, sonnet: 32, opus: 32 };

/** Daily cap on agent model calls on every provider. Vertex spend is capped by the gateway. */
export const AGENT_DAILY_CALL_CAP = 400;

/** Daily cap on agent calls to OpenRouter, below its 50 free calls so other callers keep some. */
export const OPENROUTER_DAILY_CALL_CAP = 45;

/**
 * The AI Gateway spend limit on `google-vertex-ai` (Terraform `modules/ai`,
 * `var.vertex_spend_limit_usd`). Mirrored here for budget-stop text only; Terraform enforces it.
 */
export const VERTEX_SPEND_LIMIT = { usd: 9, days: 30 } as const;

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
