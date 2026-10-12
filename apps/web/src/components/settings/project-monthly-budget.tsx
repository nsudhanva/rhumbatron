import { useQueryClient } from "@tanstack/react-query";
import { type ProjectSettings, updateProjectSettings } from "../../lib/api-settings";
import { formatUsd } from "../../lib/format";
import { can } from "../../lib/permissions";
import { formatCost } from "../costs-page/cost-format";
import { KeyValue } from "../ui/key-value";
import { MonthlyBudgetForm } from "./monthly-budget-form";

/**
 * "Project monthly budget" in Settings > Defaults: a ceiling on the Project's model spend per
 * calendar month, and the pool a request draws on with the "Project budget" option. The owner
 * or an admin sets it; everyone else reads it. Raising it resumes the Project's Changes that
 * this budget stopped.
 */
export function ProjectMonthlyBudget({
  projectId,
  settings,
}: {
  projectId: string;
  settings: ProjectSettings;
}) {
  const queryClient = useQueryClient();
  const capUsd = settings.monthlyBudgetUsd ?? null;
  const spentUsd = settings.monthSpendUsd ?? 0;

  if (!can(settings.role, "settings.edit")) {
    return (
      <KeyValue
        className="border-t border-kumo-rule pt-3"
        items={[
          {
            label: "Project monthly budget",
            value: (
              <span className="font-mono tabular-nums">
                {capUsd === null ? "None" : formatUsd(capUsd)}
              </span>
            ),
          },
          {
            label: "Spent this month",
            value: <span className="font-mono tabular-nums">{formatCost(spentUsd)}</span>,
          },
        ]}
      />
    );
  }

  return (
    <div className="border-t border-kumo-rule pt-3">
      <MonthlyBudgetForm
        label="Project monthly budget (USD)"
        description="Model work of this Project stops when this month's spend reaches it."
        capUsd={capUsd}
        spentUsd={spentUsd}
        spentLabel="Spent this month"
        save={(monthlyBudgetUsd) =>
          updateProjectSettings({ data: { projectId, monthlyBudgetUsd } })
        }
        onSaved={(next) => {
          queryClient.setQueryData(["project-settings", projectId], next);
          // The Costs meter and any Change this budget stopped read it again.
          void queryClient.invalidateQueries({ queryKey: ["project-cost", projectId] });
          void queryClient.invalidateQueries({ queryKey: ["changes", projectId] });
        }}
      />
    </div>
  );
}
ProjectMonthlyBudget.displayName = "ProjectMonthlyBudget";
