import { formatFraction, formatNumber, formatUsd, truncate } from "../../lib/format";
import { ChangeStatusPill } from "../project/status";
import { ThresholdMeter } from "../ui/meter";
import { Mono } from "../ui/mono";
import { StatCell, StatStrip } from "../ui/stat-strip";
import { type ChangeCost, formatCost } from "./cost-format";

/**
 * Change budget hero (DESIGN.md 9.1): recorded spend against `changes.budget_usd` on a 10px
 * threshold meter, the limit drawn as a 2px ink marker. The scale runs past the limit so an
 * overrun stays visible; the fill turns accent over the limit. Then the recorded totals of the
 * Change in a stat strip (9.2).
 */
export function BudgetHero({ change }: { change: ChangeCost }) {
  const spent = change.costUsd;
  const budget = change.budgetUsd;
  // Scale only: the limit plus a quarter, or the overrun itself. Not a figure on its own.
  const scale = Math.max(budget * 1.25, spent);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="grid min-w-0 gap-1">
          <p className="min-w-0 text-[15px] font-semibold" title={change.goal}>
            {truncate(change.goal, 160)}
          </p>
          <Mono subtle>{change.id}</Mono>
        </div>
        <ChangeStatusPill status={change.status} />
      </div>

      {scale > 0 ? (
        <ThresholdMeter
          label="Recorded model spend"
          value={spent}
          max={scale}
          threshold={budget}
          size="hero"
          format={formatUsd}
          valueText={formatFraction(formatCost(spent), formatUsd(budget))}
        />
      ) : (
        <p className="text-[13px] text-kumo-subtle">
          No budget is set for this Change ({formatUsd(budget)}), so there is no limit to meter.
        </p>
      )}
      {change.status === "budget_blocked" && (
        <p className="text-[13px] font-semibold text-accent-700">
          Blocked: a budget limit stopped new model work. Existing state stays inspectable.
        </p>
      )}

      <StatStrip>
        <StatCell label="Attempts" value={formatNumber(change.runs)} mono footnote="task_runs" />
        <StatCell label="Model calls" value={formatNumber(change.modelCalls)} mono />
        <StatCell label="Input tokens" value={formatNumber(change.inputTokens)} mono />
        <StatCell label="Output tokens" value={formatNumber(change.outputTokens)} mono />
      </StatStrip>
    </div>
  );
}
BudgetHero.displayName = "BudgetHero";
