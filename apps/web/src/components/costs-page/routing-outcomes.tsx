import { formatNumber } from "../../lib/format";
import { KeyValue } from "../ui/key-value";
import { BarList } from "./charts";
import { type SelectedCost, TIER_LABEL, type Tier } from "./cost-format";

const TIERS: Tier[] = ["haiku", "sonnet", "opus"];

/** Failure kinds with a plain name; others show their recorded key. */
const FAILURE_LABEL: Record<string, string> = {
  run_call_cap: "Run call cap",
  budget_exhausted: "Budget stop",
  spend_limited: "Spend stop",
  rate_limited: "Rate limited",
};

/**
 * Routing outcomes of one Change (AGENTS.md sections 23.5, 56): Decision Receipts by selected
 * tier, which layer decided, and what the attempts show about escalation and retries. Counts
 * only: no savings figure is claimed.
 */
export function RoutingOutcomes({ routing }: { routing: SelectedCost["routing"] }) {
  const total = TIERS.reduce((sum, t) => sum + routing.receipts[t], 0);
  const failures = Object.entries(routing.failuresByKind).sort((a, b) => b[1] - a[1]);
  return (
    <div className="grid gap-4">
      <BarList
        max={total}
        items={TIERS.map((tier) => ({
          label: TIER_LABEL[tier],
          value: routing.receipts[tier],
          text: `${formatNumber(routing.receipts[tier])} of ${formatNumber(total)}`,
          title: `${TIER_LABEL[tier]} routes: ${routing.receipts[tier]} Decision Receipts`,
        }))}
      />
      <KeyValue
        className="border-t border-kumo-rule pt-3"
        items={[
          {
            label: "Decided by",
            value: `rules ${formatNumber(routing.decidedBy.rules)} · clef ${formatNumber(routing.decidedBy.clef)}`,
            mono: true,
          },
          { label: "Escalations", value: formatNumber(routing.escalations), mono: true },
          { label: "Same-tier retries", value: formatNumber(routing.retries), mono: true },
          {
            label: "Failed attempts",
            value:
              failures.length === 0
                ? "0"
                : failures
                    .map(([kind, n]) => `${FAILURE_LABEL[kind] ?? kind} ${formatNumber(n)}`)
                    .join(" · "),
            mono: true,
          },
        ]}
      />
    </div>
  );
}
RoutingOutcomes.displayName = "RoutingOutcomes";
