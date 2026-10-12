import { Link } from "@tanstack/react-router";
import type { BudgetBlockedBy } from "../../lib/api-budget";
import type { ChangeView } from "../../lib/api-change";
import { formatFraction, formatUsd } from "../../lib/format";
import { can, useProjectRole } from "../../lib/permissions";
import { formatCost } from "../costs-page/cost-format";
import { RaiseBudget } from "./change-controls";

/**
 * Budget scope of one Change (docs/operations/costs.md, "Budget scopes"): which budget it draws
 * on, which budget stopped it, and what the viewer can do about a stop. Changes from before
 * budget scopes have no `budget` field and read as a request budget.
 */

/** "you" / the requester's name / "the requester". */
function requester(change: ChangeView) {
  const r = change.requester;
  if (r?.isYou) return "you";
  return r?.name ?? "the requester";
}

/** The possessive of the requester's monthly budget: "My budget", "Ana's budget". */
function accountBudgetWords(change: ChangeView) {
  const who = requester(change);
  if (who === "you") return "My budget";
  return who === "the requester" ? "The requester's budget" : `${who}'s budget`;
}

/** The budget line: "Project budget", "My budget", or "$3.00 for this request". */
function budgetScopeWords(change: ChangeView): string {
  switch (change.budget?.scope) {
    case "project":
      return "Project budget";
    case "account":
      return accountBudgetWords(change);
    default:
      return `${formatUsd(change.budget?.capUsd ?? change.budgetUsd)} for this request`;
  }
}

/** The Budget row of the Change details: the scope, with the recorded spend. */
export function budgetDetail(change: ChangeView, spentUsd: number | null): string {
  const spent = change.budget?.spentUsd ?? spentUsd;
  if (change.budget && change.budget.scope !== "change") {
    return spent === null
      ? budgetScopeWords(change)
      : `${budgetScopeWords(change)} · ${formatCost(spent)} spent`;
  }
  const cap = formatUsd(change.budget?.capUsd ?? change.budgetUsd);
  return spent === null
    ? `${cap} for this request`
    : `${formatFraction(formatUsd(spent), cap)} for this request`;
}

/** First sentence of a recorded reason, without its final period. */
function firstSentence(reason: string | null | undefined): string {
  const text = reason?.trim() ?? "";
  const end = text.indexOf(". ");
  return (end === -1 ? text : text.slice(0, end)).replace(/\.$/, "");
}

/**
 * The status line of a `budget_blocked` Change: which budget is used up. The recorded reason
 * names the budget, its amount, and the month (ADR 0030); it leads when the API sent one. A stop
 * that no budget caused (the attempt limit, the daily call cap) shows its own reason.
 */
export function budgetStopText(change: ChangeView): string {
  const kind = blockedBy(change);
  const head = firstSentence(change.blockedReason);
  if (kind === null) return head || "Stopped: a limit was reached";
  if (/^(Stopped|Paused):/.test(head)) return head;
  switch (kind) {
    case "project_budget":
      return "Stopped: the project's monthly budget is used up";
    case "account_budget": {
      const who = requester(change);
      return `Stopped: ${who === "you" ? "your" : `${who}'s`} monthly budget is used up`;
    }
    case "monthly_model_spend":
      return "Stopped: the monthly model spend limit of Rhumbatron is reached";
    default:
      return `Stopped: the ${formatUsd(change.budget?.capUsd ?? change.budgetUsd)} request budget is used up`;
  }
}

/** The budget that stopped the Change; null for a stop that no budget caused. */
function blockedBy(change: ChangeView): BudgetBlockedBy | null {
  return change.budget ? change.budget.blockedBy : "change_budget";
}

const NOTE = "grid gap-1 bg-kumo-danger-tint px-3.5 py-2.5 text-[13px] text-kumo-danger";

/**
 * "Needs attention" entry of a `budget_blocked` Change: the budget that stopped it and the raise
 * action that fits the viewer. A raise resumes the ready Tasks.
 */
export function BudgetBlock({
  change,
  canRaiseBudget,
}: {
  change: ChangeView;
  /** Owner or admin: raise the request budget. */
  canRaiseBudget: boolean;
}) {
  const role = useProjectRole(change.projectId);
  // A stop that no budget caused (the attempt limit) resumes with a request budget raise too.
  const kind = blockedBy(change) ?? "change_budget";

  if (kind === "change_budget") {
    if (canRaiseBudget) {
      return (
        <RaiseBudget changeId={change.id} budgetUsd={change.budget?.capUsd ?? change.budgetUsd} />
      );
    }
    return (
      <div className={NOTE}>
        <p className="font-semibold">{budgetStopText(change)}.</p>
        <p>Ask an owner or admin to raise the request budget.</p>
      </div>
    );
  }

  return (
    <div className={NOTE} data-testid="budget-block">
      <p className="font-semibold">{budgetStopText(change)}.</p>
      {kind === "project_budget" &&
        (can(role, "settings.edit") ? (
          <p>
            <Link
              to="/projects/$projectId/settings"
              params={{ projectId: change.projectId }}
              className="font-semibold underline"
            >
              Open Settings
            </Link>{" "}
            to raise the project monthly budget. The work resumes at once.
          </p>
        ) : (
          <p>Ask an owner or admin to raise the project monthly budget in Settings.</p>
        ))}
      {kind === "account_budget" &&
        (change.requester?.isYou ? (
          <p>
            <Link to="/account" className="font-semibold underline">
              Open Account
            </Link>{" "}
            to raise your monthly budget. The work resumes at once.
          </p>
        ) : (
          <p>Waiting for {requester(change)} to raise their budget.</p>
        ))}
      {kind === "monthly_model_spend" && (
        <p>
          Every Project shares one monthly model spend limit, so model work stops everywhere until
          the next month starts. A Project or personal budget cannot raise it.
        </p>
      )}
    </div>
  );
}
BudgetBlock.displayName = "BudgetBlock";
