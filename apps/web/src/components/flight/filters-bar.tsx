import { Button, cn, Input, Switch } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { formatNumber } from "../../lib/format";
import { useFlight } from "./flight-context";
import {
  DEFAULT_FILTERS,
  TIER_FILTERS,
  type TierFilter,
  useFlightFilters,
  useFlightStore,
} from "./flight-store";

/**
 * Filters for every panel (DESIGN.md 8.3 filter chips, 8.2 switch): free text, model tier, active
 * lanes only, and event families. Everything writes the shared store; panels apply what fits.
 */

/** Families in protocol order (AGENTS.md 17.2); unknown families follow alphabetically. */
const FAMILY_ORDER = [
  "change",
  "task",
  "agent",
  "model",
  "claim",
  "intent",
  "challenge",
  "conflict",
  "changeset",
  "candidate",
  "verification",
  "evidence",
  "approval",
  "canonical",
];

const familyOf = (type: string) => type.split(".")[0] ?? type;

function Chip({
  pressed,
  count,
  onClick,
  children,
}: {
  pressed: boolean;
  count?: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-6 items-center gap-1.5 border px-2.5 py-0.5 text-[12px] whitespace-nowrap pointer-coarse:min-h-11",
        pressed
          ? "border-kumo-ink bg-kumo-ink text-kumo-inverse"
          : "border-kumo-rule hover:bg-kumo-tint",
      )}
    >
      {children}
      {count !== undefined && (
        <span className="font-mono text-[11px] tabular-nums opacity-70">{formatNumber(count)}</span>
      )}
    </button>
  );
}
Chip.displayName = "Chip";

export function FiltersBar() {
  const { model, state } = useFlight();
  const filters = useFlightFilters();
  const setFilters = useFlightStore((s) => s.setFilters);
  const resetFilters = useFlightStore((s) => s.resetFilters);

  // Tasks per tier, by the latest attempt at the fold instant.
  const tierCounts = useMemo(() => {
    const counts: Record<TierFilter, number> = { haiku: 0, sonnet: 0, opus: 0 };
    for (const task of Object.values(state.tasks)) {
      const tier = task.runs.at(-1)?.tier;
      if (tier && tier in counts) counts[tier as TierFilter] += 1;
    }
    return counts;
  }, [state.tasks]);

  const families = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of model.events) {
      const family = familyOf(event.type);
      counts.set(family, (counts.get(family) ?? 0) + 1);
    }
    const rank = (f: string) => {
      const i = FAMILY_ORDER.indexOf(f);
      return i < 0 ? FAMILY_ORDER.length : i;
    };
    return [...counts]
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .map(([family, count]) => ({ family, count }));
  }, [model.events]);

  const toggleTier = (tier: TierFilter) =>
    setFilters({
      tiers: filters.tiers.includes(tier)
        ? filters.tiers.filter((t) => t !== tier)
        : [...filters.tiers, tier],
    });
  const toggleFamily = (family: string) =>
    setFilters({
      eventFamilies: filters.eventFamilies.includes(family)
        ? filters.eventFamilies.filter((f) => f !== family)
        : [...filters.eventFamilies, family],
    });

  const isDefault =
    filters.query === DEFAULT_FILTERS.query &&
    filters.tiers.length === 0 &&
    filters.activeOnly === DEFAULT_FILTERS.activeOnly &&
    filters.eventFamilies.length === 0;

  return (
    <search
      aria-label="Filters"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-kumo-rule px-3 py-2"
    >
      <div className="w-[min(100%,300px)]">
        <Input
          size="sm"
          type="search"
          aria-label="Filter Tasks, agents, files, resources and events"
          placeholder="Filter Tasks, files, events"
          value={filters.query}
          onChange={(e) => setFilters({ query: e.target.value })}
        />
      </div>

      <fieldset className="flex flex-wrap items-center gap-1.5">
        <legend className="sr-only">Model tier</legend>
        <span aria-hidden className="text-[11px] tracking-[0.08em] text-kumo-subtle uppercase">
          Tier
        </span>
        {TIER_FILTERS.map((tier) => (
          <Chip
            key={tier}
            pressed={filters.tiers.includes(tier)}
            count={tierCounts[tier]}
            onClick={() => toggleTier(tier)}
          >
            {tier}
          </Chip>
        ))}
      </fieldset>

      <Switch
        size="sm"
        variant="neutral"
        label={<span className="text-[12px]">Active only</span>}
        checked={filters.activeOnly}
        onCheckedChange={(checked) => setFilters({ activeOnly: checked })}
      />

      {families.length > 0 && (
        <fieldset className="flex flex-wrap items-center gap-1.5">
          <legend className="sr-only">Event families</legend>
          <span aria-hidden className="text-[11px] tracking-[0.08em] text-kumo-subtle uppercase">
            Events
          </span>
          {families.map(({ family, count }) => (
            <Chip
              key={family}
              pressed={filters.eventFamilies.includes(family)}
              count={count}
              onClick={() => toggleFamily(family)}
            >
              {family}
            </Chip>
          ))}
        </fieldset>
      )}

      {!isDefault && (
        <Button variant="ghost" size="sm" onClick={resetFilters}>
          Reset filters
        </Button>
      )}
    </search>
  );
}
FiltersBar.displayName = "FiltersBar";
