import { cn } from "@cloudflare/kumo";
import { formatNumber, formatUsd, truncate } from "../../lib/format";
import { ChangeStatusPill } from "../project/status";
import { type ChangeCost, formatCost } from "./cost-format";

/**
 * Change budget: recorded spend against `changes.budget_usd` as one sentence ("$1.42 of $3.00
 * for this change") over a 4px bar that fills to the budget and turns danger once over it. One
 * plain line of totals replaces the old stat strip.
 */
export function BudgetHero({ change }: { change: ChangeCost }) {
  const spent = change.costUsd;
  const budget = change.budgetUsd;
  const over = budget > 0 && spent > budget;
  const sentence = `${formatCost(spent)} of ${formatUsd(budget)} for this change`;
  return (
    <div className="grid gap-4 rounded-lg border border-kumo-rule bg-kumo-elevated p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 text-[15px] font-semibold" title={change.goal}>
          {truncate(change.goal, 160)}
        </p>
        <ChangeStatusPill status={change.status} />
      </div>

      {budget > 0 ? (
        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="text-[14px]">{sentence}</span>
            {over ? (
              <span className="text-[13px] font-semibold text-kumo-danger">Over budget</span>
            ) : (
              <span className="text-[13px] text-kumo-subtle">
                {formatUsd(Math.max(0, budget - spent))} left
              </span>
            )}
          </div>
          {/* The native meter carries the semantics; the drawn 4px bar is decoration. */}
          <meter className="sr-only" min={0} max={budget} value={Math.min(spent, budget)}>
            {sentence}
          </meter>
          <div aria-hidden className="h-1 overflow-hidden rounded-full bg-kumo-recessed">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-(--rh-dur-bar)",
                over ? "bg-kumo-danger" : "bg-kumo-ink",
              )}
              style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }}
            />
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-kumo-subtle">
          {formatCost(spent)} spent. No budget is set for this change, so there is no limit to show.
        </p>
      )}
      {change.status === "budget_blocked" && (
        <p className="text-[13px] font-semibold text-kumo-danger">
          Paused: spending reached the budget. Work is saved.
        </p>
      )}

      <p className="text-[12px] text-kumo-subtle">
        {formatNumber(change.runs)} {change.runs === 1 ? "attempt" : "attempts"} ·{" "}
        {formatNumber(change.modelCalls)} model {change.modelCalls === 1 ? "call" : "calls"} ·{" "}
        {formatNumber(change.inputTokens)} tokens in · {formatNumber(change.outputTokens)} out
      </p>
    </div>
  );
}
BudgetHero.displayName = "BudgetHero";
