import type { ProjectCost } from "../../lib/api";
import { EMPTY, formatUsd } from "../../lib/format";

export type Tier = "haiku" | "sonnet" | "opus";
export type ChangeCost = ProjectCost["changes"][number];
export type SelectedCost = NonNullable<ProjectCost["selected"]>;

/** Product names (spec 7.6): the tier keys stay internal. */
export const TIER_LABEL: Record<Tier, string> = {
  haiku: "Claude Haiku",
  sonnet: "Claude Sonnet",
  opus: "Claude Opus",
};

const SHORT: Record<Tier, string> = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };

/**
 * Recorded model cost. `$0.00` is a real recorded zero (free models, ADR 0007); a positive amount
 * under one cent reads `<$0.01` so it never rounds to a false zero.
 */
export function formatCost(usd: number | null | undefined) {
  if (usd === null || usd === undefined || Number.isNaN(usd)) return EMPTY;
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return formatUsd(usd);
}

/** Models of a Task's attempts: `Haiku → Sonnet`. Repeats collapse to `Sonnet ×2`. */
export function tierPath(tiers: Tier[]) {
  if (tiers.length === 0) return EMPTY;
  const parts: { tier: Tier; n: number }[] = [];
  for (const tier of tiers) {
    const last = parts.at(-1);
    if (last?.tier === tier) last.n += 1;
    else parts.push({ tier, n: 1 });
  }
  return parts.map((p) => (p.n > 1 ? `${SHORT[p.tier]} ×${p.n}` : SHORT[p.tier])).join(" → ");
}
