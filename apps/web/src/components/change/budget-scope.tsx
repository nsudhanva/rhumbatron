import { cn } from "@cloudflare/kumo";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId } from "react";
import { type BudgetScope, type Me, remainingUsd } from "../../lib/api-budget";
import type { ProjectSettings } from "../../lib/api-settings";
import { formatUsd } from "../../lib/format";

/**
 * Budget selector of the New change form (docs/operations/costs.md, "Budget scopes"): the
 * request has its own cap ("This request", with the amount field), or it draws on the Project
 * monthly budget or the requester's own monthly budget. A pool shows only once it is set; a
 * one-line hint says where to set it. Monthly pools always apply as ceilings, so their money
 * left shows whichever option is selected.
 */

type Pool = { capUsd: number; spentUsd: number };

const SCOPE_LABEL: Record<BudgetScope, string> = {
  change: "This request",
  project: "Project budget",
  account: "My budget",
};

/** The monthly pools that are set, from the Project settings and `GET /v1/me`. */
export function budgetPools(
  settings: ProjectSettings | undefined,
  me: Me | undefined,
): Record<"project" | "account", Pool | null> {
  const projectCap = settings?.monthlyBudgetUsd ?? null;
  const accountCap = me?.monthlyBudgetUsd ?? null;
  return {
    project:
      projectCap === null ? null : { capUsd: projectCap, spentUsd: settings?.monthSpendUsd ?? 0 },
    account: accountCap === null ? null : { capUsd: accountCap, spentUsd: me?.monthSpendUsd ?? 0 },
  };
}

/** "$42.10 of $100.00 left this month". */
function leftThisMonth(pool: Pool) {
  return `${formatUsd(remainingUsd(pool.capUsd, pool.spentUsd))} of ${formatUsd(pool.capUsd)} left this month`;
}

export function BudgetScopeField({
  projectId,
  scope,
  onScope,
  pools,
  canSetProjectBudget,
  amountField,
}: {
  projectId: string;
  scope: BudgetScope;
  onScope: (scope: BudgetScope) => void;
  pools: Record<"project" | "account", Pool | null>;
  /** Owner or admin: the hint links to Settings when the Project has no monthly budget. */
  canSetProjectBudget: boolean;
  /** The amount input of "This request". */
  amountField: ReactNode;
}) {
  const options: BudgetScope[] = [
    "change",
    ...(pools.project ? (["project"] as const) : []),
    ...(pools.account ? (["account"] as const) : []),
  ];
  const hintId = useId();
  return (
    <fieldset className="grid gap-2" aria-describedby={hintId} data-testid="budget-scope">
      <legend className="float-left mb-1.5 text-[13px] font-semibold">Budget</legend>
      <div className="clear-left flex w-fit max-w-full flex-wrap border border-kumo-divider">
        {options.map((option, index) => (
          <button
            key={option}
            type="button"
            aria-pressed={scope === option}
            onClick={() => scope !== option && onScope(option)}
            className={cn(
              "flex h-8 items-center px-3 text-[13px] transition-colors duration-(--rh-dur-ui) focus-visible:outline-offset-[-2px] pointer-coarse:h-11",
              index > 0 && "border-l border-kumo-divider",
              scope === option ? "bg-kumo-ink text-kumo-inverse" : "hover:bg-kumo-tint",
            )}
          >
            {SCOPE_LABEL[option]}
          </button>
        ))}
      </div>
      {scope === "change" && <div className="max-w-56">{amountField}</div>}
      <div id={hintId} className="grid gap-1 text-[12px] text-kumo-subtle">
        {scope === "project" && <p>The request draws on the Project's monthly budget.</p>}
        {scope === "account" && <p>The request draws on your own monthly budget.</p>}
        {pools.project && (
          <p>
            Project budget:{" "}
            <span className="font-mono tabular-nums">{leftThisMonth(pools.project)}</span>.
          </p>
        )}
        {pools.account && (
          <p>
            My budget:{" "}
            <span className="font-mono tabular-nums">{leftThisMonth(pools.account)}</span>.
          </p>
        )}
        {!pools.project && canSetProjectBudget && (
          <p>
            <Link
              to="/projects/$projectId/settings"
              params={{ projectId }}
              className="text-kumo-link hover:underline"
            >
              Set a project monthly budget in Settings
            </Link>
          </p>
        )}
        {!pools.account && (
          <p>
            <Link to="/account" className="text-kumo-link hover:underline">
              Set your monthly budget on your Account page
            </Link>
          </p>
        )}
      </div>
    </fieldset>
  );
}
BudgetScopeField.displayName = "BudgetScopeField";
