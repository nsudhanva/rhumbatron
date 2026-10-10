import type { ReactNode } from "react";
import { formatNumber } from "../../lib/format";
import { Term } from "../ui/term";
import { BarList } from "./charts";
import { type SelectedCost, TIER_LABEL, type Tier } from "./cost-format";

const TIERS: Tier[] = ["haiku", "sonnet", "opus"];

/** Failure kinds with a plain name; others show their recorded key. */
const FAILURE_LABEL: Record<string, string> = {
  run_call_cap: "Call limit per attempt",
  budget_exhausted: "Budget reached",
  spend_limited: "Gemini spend cap",
  rate_limited: "Rate limited",
};

/**
 * How models were chosen for one Change (AGENTS.md sections 23.5, 56; internal: routing outcomes
 * from Decision Receipts): routes per model, which layer chose, and how often an attempt was
 * retried. Counts only: no savings figure is claimed.
 */
export function RoutingOutcomes({ routing }: { routing: SelectedCost["routing"] }) {
  const total = TIERS.reduce((sum, t) => sum + routing.receipts[t], 0);
  const failures = Object.entries(routing.failuresByKind).sort((a, b) => b[1] - a[1]);
  const rows: { key: string; label: ReactNode; value: string }[] = [
    {
      key: "decided",
      label: <Term k="chosenAutomatically">Chosen automatically (rules / decision model)</Term>,
      value: `${formatNumber(routing.decidedBy.rules)} / ${formatNumber(routing.decidedBy.clef)}`,
    },
    {
      key: "escalations",
      label: <Term k="retriedStronger" />,
      value: formatNumber(routing.escalations),
    },
    {
      key: "retries",
      label: "Retried with the same model",
      value: formatNumber(routing.retries),
    },
    {
      key: "failures",
      label: "Failed attempts",
      value:
        failures.length === 0
          ? "0"
          : failures
              .map(([kind, n]) => `${FAILURE_LABEL[kind] ?? kind} ${formatNumber(n)}`)
              .join(" · "),
    },
  ];
  return (
    <div className="grid gap-4">
      <BarList
        max={total}
        items={TIERS.map((tier) => ({
          label: TIER_LABEL[tier],
          value: routing.receipts[tier],
          text: `${formatNumber(routing.receipts[tier])} of ${formatNumber(total)}`,
          title: `${TIER_LABEL[tier]}: chosen ${routing.receipts[tier]} times`,
        }))}
        className="[&>li]:grid-cols-[110px_minmax(0,1fr)_minmax(54px,auto)]"
      />
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t border-kumo-rule pt-3 text-[12px]">
        {rows.map((row) => (
          <div key={row.key} className="contents">
            <dt className="text-kumo-subtle">{row.label}</dt>
            <dd className="min-w-0 font-mono tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
RoutingOutcomes.displayName = "RoutingOutcomes";
