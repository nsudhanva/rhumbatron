import { Link } from "@tanstack/react-router";
import { monthName, type ProjectBudget, remainingUsd } from "../../lib/api-budget";
import { formatFraction, formatUsd } from "../../lib/format";
import { ThresholdMeter } from "../ui/meter";
import { formatCost } from "./cost-format";

/**
 * Project budget meter (docs/operations/costs.md, "Budget scopes"): this
 * month's model spend of the Project against its monthly budget, the limit as a 2px ink marker.
 * At the limit, model work of the Project stops until an owner or admin raises it in Settings.
 */
export function ProjectBudgetMeter({
  projectId,
  budget,
  canEdit,
}: {
  projectId: string;
  budget: ProjectBudget;
  /** Owner or admin: link to the field in Settings. */
  canEdit: boolean;
}) {
  const { capUsd, spentUsd } = budget;
  const settings = canEdit ? (
    <Link
      to="/projects/$projectId/settings"
      params={{ projectId }}
      className="text-kumo-link hover:underline"
    >
      {capUsd === null ? "Set a project monthly budget in Settings" : "Change it in Settings"}
    </Link>
  ) : null;

  if (capUsd === null) {
    return (
      <div className="grid gap-1 text-[13px]">
        <p>
          <span className="font-mono tabular-nums">{formatCost(spentUsd)}</span> spent in{" "}
          {monthName(budget.month)}. The Project has no monthly budget.
        </p>
        {settings && <p className="text-[12px]">{settings}</p>}
      </div>
    );
  }

  const reached = spentUsd >= capUsd;
  return (
    <div className="grid gap-2">
      <ThresholdMeter
        label={`Project model spend, ${monthName(budget.month)}`}
        value={spentUsd}
        // Scale only: the limit plus a quarter, or the overrun itself.
        max={Math.max(capUsd * 1.25, spentUsd)}
        threshold={capUsd}
        size="hero"
        format={formatUsd}
        valueText={formatFraction(formatCost(spentUsd), formatUsd(capUsd))}
      />
      <p
        className={
          reached ? "text-[13px] font-semibold text-accent-700" : "text-[12px] text-kumo-subtle"
        }
      >
        {reached
          ? "Budget used up: model work of this Project stops until an owner or admin raises it."
          : `${formatUsd(remainingUsd(capUsd, spentUsd))} left this month.`}{" "}
        {settings}
      </p>
    </div>
  );
}
ProjectBudgetMeter.displayName = "ProjectBudgetMeter";
