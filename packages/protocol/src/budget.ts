import { z } from "zod";

/**
 * Budget scopes (ADR 0030, docs/operations/costs.md). A Change draws on its own cap (`change`),
 * on the Project monthly budget (`project`), or on the requester's monthly budget (`account`).
 * Project and user monthly budgets always apply as ceilings, whichever scope a Change has.
 */

export const BudgetScope = z.enum(["change", "project", "account"]);
export type BudgetScope = z.infer<typeof BudgetScope>;

/** The budget that stopped a `budget_blocked` Change (`changes.blocked_limit`). */
export const BudgetLimit = z.enum([
  "change_budget",
  "project_budget",
  "account_budget",
  "monthly_model_spend",
]);
export type BudgetLimit = z.infer<typeof BudgetLimit>;

/** A Project or user monthly budget: $1 to $100, or null for no own cap. */
export const MONTHLY_BUDGET_LIMITS = { minUsd: 1, maxUsd: 100 } as const;
export const MonthlyBudgetUsd = z
  .number()
  .min(MONTHLY_BUDGET_LIMITS.minUsd)
  .max(MONTHLY_BUDGET_LIMITS.maxUsd)
  .nullable();

/** `budget` of `GET /v1/changes/:changeId`. `capUsd` is null for scopes `project` and `account`. */
export const ChangeBudget = z.object({
  scope: BudgetScope,
  capUsd: z.number().nonnegative().nullable(),
  spentUsd: z.number().nonnegative(),
  blockedBy: BudgetLimit.nullable(),
});
export type ChangeBudget = z.infer<typeof ChangeBudget>;

/** `projectBudget` of `GET /v1/projects/:projectId/cost`. `month` is `YYYY-MM`. */
export const ProjectBudget = z.object({
  capUsd: z.number().nonnegative().nullable(),
  spentUsd: z.number().nonnegative(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
});
export type ProjectBudget = z.infer<typeof ProjectBudget>;

/** `GET /v1/me` and the reply of `PATCH /v1/me/budget`. `monthSpendUsd` covers every Project. */
export const Me = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  monthlyBudgetUsd: z.number().nullable(),
  monthSpendUsd: z.number().nonnegative(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
});
export type Me = z.infer<typeof Me>;

/** `PATCH /v1/me/budget` request. */
export const UpdateMyBudgetRequest = z.object({ monthlyBudgetUsd: MonthlyBudgetUsd });
export type UpdateMyBudgetRequest = z.infer<typeof UpdateMyBudgetRequest>;

/**
 * Meter rows in `usage_counters` (micro-USD) of the budgets: the Change (`day` =
 * `CHANGE_METER_DAY`), the Project and the user (`day` = `YYYY-MM`). The model-router package
 * reserves and settles them (budget-meters.ts).
 */
/** `day` of the Change meter: a Change budget does not reset each month. */
export const CHANGE_METER_DAY = "total";

/**
 * `changes.budget_usd` of a Change with scope `project` or `account`. Such a Change has no own cap;
 * this ceiling (the highest monthly budget) keeps the per-Task shares of the agents finite.
 */
export const POOL_SCOPE_CHANGE_CEILING_USD = 100;

export const METER_COUNTER = {
  change: (changeId: string) => `change-usd-micro:${changeId}`,
  project: (projectId: string) => `project-usd-micro:${projectId}`,
  user: (userId: string) => `user-usd-micro:${userId}`,
} as const;

/** `blockedBy` of a Change from its `blocked_limit`. Null for a stop that no budget caused. */
export function budgetBlockedBy(blockedLimit: string | null | undefined): BudgetLimit | null {
  switch (blockedLimit) {
    case "change_budget":
    case "max_cost_usd_per_change":
      return "change_budget";
    case "project_budget":
    case "account_budget":
    case "monthly_model_spend":
      return blockedLimit;
    case "vertex_spend_limit":
      return "monthly_model_spend";
    default:
      return null;
  }
}
