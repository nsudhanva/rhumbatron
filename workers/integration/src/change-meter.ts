import {
  anthropicMonthlyBudgetUsd,
  BudgetStopError,
  blockChangeOnBudget,
  type CompletionRequest,
  type CompletionResult,
  changeMeters,
  meteredComplete,
  opusAllowed,
  readChangeBudgets,
  spendMonth,
} from "@rhumbatron/model-router";

/**
 * One Anthropic call that a Change pays for (ADR 0021, ADR 0030): the planner, intake review,
 * request checks, acceptance checks, and the Integration Judge. The call reserves its estimate on
 * every meter of the Change in one batch (Change, Project, requester, monthly) and settles to the
 * exact cost. A refused reservation sends nothing: a Change in `compiling` or `running` becomes
 * `budget_blocked` with the budget that ran out, and the error reaches the caller.
 */
export async function changeComplete(
  env: Env,
  changeId: string,
  req: CompletionRequest,
): Promise<CompletionResult> {
  const budgetUsd = anthropicMonthlyBudgetUsd(env.ANTHROPIC_MONTHLY_BUDGET_USD);
  const month = spendMonth();
  const meters = changeMeters(await readChangeBudgets(env.DB, changeId), budgetUsd, month);
  try {
    return await meteredComplete(
      { db: env.DB, budgetUsd, meters },
      {
        accountId: env.AI_ACCOUNT_ID,
        gatewayId: env.AI_GATEWAY_ID,
        apiKey: env.ANTHROPIC_API_KEY,
        workspaceId: env.ANTHROPIC_WORKSPACE_ID,
        allowOpus: opusAllowed(env.ALLOW_OPUS),
      },
      { ...req, metadata: { ...req.metadata, changeId } },
    );
  } catch (error) {
    if (error instanceof BudgetStopError) {
      await blockChangeOnBudget(env.DB, changeId, error.meter, month);
    }
    throw error;
  }
}
