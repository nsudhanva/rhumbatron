import { cn } from "@cloudflare/kumo";
import { Link } from "@tanstack/react-router";
import { type Ref, useId, useState } from "react";
import { type BudgetScope, type Me, remainingUsd } from "../../lib/api-budget";
import type { ProjectSettings } from "../../lib/api-settings";
import { formatUsd } from "../../lib/format";

/**
 * Spending limit of the New change form (docs/operations/costs.md, "Budget scopes"). Closed, it
 * is one line: "Spending limit: $3.00 for this request · Change". "Change" opens the editor in
 * place: the request has its own cap (with the amount field), or it draws on the Project monthly
 * budget or the requester's own monthly budget. A pool is an option only once it is set; one
 * muted line links to where each is set. Monthly pools always apply as ceilings.
 */

type Pool = { capUsd: number; spentUsd: number };

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

const LINK = "text-kumo-link hover:underline";

export function BudgetScopeField({
  projectId,
  scope,
  onScope,
  pools,
  canSetProjectBudget,
  amount,
  onAmount,
  amountRef,
  isDefault,
  forceOpen,
}: {
  projectId: string;
  scope: BudgetScope;
  onScope: (scope: BudgetScope) => void;
  pools: Record<"project" | "account", Pool | null>;
  /** Owner or admin: the hint links to Settings. */
  canSetProjectBudget: boolean;
  /** The cap of "This request", as typed. */
  amount: string;
  onAmount: (value: string) => void;
  amountRef: Ref<HTMLInputElement>;
  /** The amount is the Project's default (nothing typed yet). */
  isDefault: boolean;
  /** Keep the editor open, for example while the amount is not valid. */
  forceOpen: boolean;
}) {
  const [editing, setEditing] = useState(false);
  // An invalid amount opens the editor, and it stays open while the person fixes the amount.
  if (forceOpen && !editing) setEditing(true);
  const open = editing || forceOpen;
  const options: BudgetScope[] = [
    "change",
    ...(pools.project ? (["project"] as const) : []),
    ...(pools.account ? (["account"] as const) : []),
  ];
  const name = useId();
  const amountId = useId();
  const hintId = useId();
  const usd = Number(amount);
  const summary =
    scope === "project" && pools.project
      ? `the Project budget, ${leftThisMonth(pools.project)}`
      : scope === "account" && pools.account
        ? `my budget, ${leftThisMonth(pools.account)}`
        : `${usd > 0 ? formatUsd(usd) : "not set"} for this request${isDefault ? " (Project default)" : ""}`;

  if (!open) {
    return (
      <p className="text-[13px]" data-testid="budget-scope">
        <span className="text-kumo-subtle">Spending limit:</span>{" "}
        <span className="font-mono tabular-nums">{summary}</span>{" "}
        <button
          type="button"
          className={cn(LINK, "ml-1 font-semibold pointer-coarse:py-3")}
          aria-label="Change spending limit"
          onClick={() => setEditing(true)}
        >
          Change
        </button>
      </p>
    );
  }

  const amountInput = (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden>$</span>
      <input
        id={amountId}
        ref={amountRef}
        type="number"
        min={0.1}
        step={0.1}
        inputMode="decimal"
        aria-label="Spending limit (USD)"
        aria-describedby={hintId}
        value={amount}
        onChange={(e) => onAmount(e.target.value)}
        onFocus={() => scope !== "change" && onScope("change")}
        className="h-8 w-24 border border-kumo-line bg-kumo-control px-2 font-mono text-[13px] tabular-nums pointer-coarse:h-11"
        required
      />
    </span>
  );
  return (
    <fieldset className="grid gap-2" aria-describedby={hintId} data-testid="budget-scope">
      <legend className="mb-1.5 text-[13px] font-semibold">Spending limit</legend>
      {options.length === 1 ? (
        <p className="flex flex-wrap items-center gap-2 text-[13px]">
          <span>Up to</span>
          {amountInput}
          <span>for this request</span>
        </p>
      ) : (
        <div className="grid gap-2 text-[13px]">
          {options.map((option) => (
            <label key={option} className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
              <input
                type="radio"
                name={name}
                checked={scope === option}
                onChange={() => onScope(option)}
                className="accent-kumo-ink"
              />
              {option === "change" && (
                <>
                  <span className="w-36">This request only</span>
                  <span className="inline-flex items-center gap-2">
                    <span className="text-kumo-subtle">up to</span>
                    {amountInput}
                  </span>
                </>
              )}
              {option === "project" && pools.project && (
                <>
                  <span className="w-36">Project budget</span>
                  <span className="font-mono text-[12px] tabular-nums text-kumo-subtle">
                    {leftThisMonth(pools.project)}
                  </span>
                </>
              )}
              {option === "account" && pools.account && (
                <>
                  <span className="w-36">My budget</span>
                  <span className="font-mono text-[12px] tabular-nums text-kumo-subtle">
                    {leftThisMonth(pools.account)}
                  </span>
                </>
              )}
            </label>
          ))}
        </div>
      )}
      <div id={hintId} className="grid gap-1 text-[12px] text-kumo-subtle">
        <p>
          New work stops when the limit is reached.
          {scope === "change" && isDefault ? " The amount is the Project's default." : ""}
        </p>
        <p>
          Monthly budgets:{" "}
          {canSetProjectBudget && (
            <>
              <Link to="/projects/$projectId/settings" params={{ projectId }} className={LINK}>
                Project settings
              </Link>
              {" · "}
            </>
          )}
          <Link to="/account" className={LINK}>
            Account
          </Link>
        </p>
      </div>
    </fieldset>
  );
}
BudgetScopeField.displayName = "BudgetScopeField";
