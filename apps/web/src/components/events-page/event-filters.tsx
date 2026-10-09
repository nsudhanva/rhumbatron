import { cn } from "@cloudflare/kumo";
import { formatNumber } from "../../lib/format";
import { FAMILIES, type FamilyKey } from "./feed-model";

/**
 * Filter chips by event family (DESIGN.md 8.3 filter chip, 9.9): 12px, 1px rule border, selected
 * in ink with inverse text, a trailing mono count at 70%. No selection means every family.
 * Counts cover the loaded events only; the stream says so next to the chips.
 */
export function EventFilters({
  counts,
  total,
  selected,
  onChange,
}: {
  counts: Map<FamilyKey, number>;
  total: number;
  selected: ReadonlySet<FamilyKey>;
  onChange: (next: Set<FamilyKey>) => void;
}) {
  const other = counts.get("other") ?? 0;
  const keys: FamilyKey[] =
    other > 0 || selected.has("other") ? [...FAMILIES, "other"] : [...FAMILIES];
  const toggle = (key: FamilyKey) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };
  return (
    <fieldset className="flex min-w-0 flex-wrap gap-1.5">
      <legend className="sr-only">Filter events by family</legend>
      <Chip
        label="All"
        count={total}
        pressed={selected.size === 0}
        onClick={() => onChange(new Set())}
      />
      {keys.map((key) => (
        <Chip
          key={key}
          label={key}
          count={counts.get(key) ?? 0}
          pressed={selected.has(key)}
          onClick={() => toggle(key)}
        />
      ))}
    </fieldset>
  );
}
EventFilters.displayName = "EventFilters";

function Chip({
  label,
  count,
  pressed,
  onClick,
}: {
  label: string;
  count: number;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-6 items-center gap-1.5 border px-2.5 py-1 text-[12px] leading-none transition-colors duration-(--rh-dur-ui) pointer-coarse:min-h-11",
        pressed
          ? "border-kumo-ink bg-kumo-ink text-kumo-inverse"
          : "border-kumo-rule hover:bg-kumo-tint",
        !pressed && count === 0 && "text-kumo-subtle",
      )}
    >
      <span>{label}</span>
      <span className="font-mono text-[11px] tabular-nums opacity-70">{formatNumber(count)}</span>
    </button>
  );
}
Chip.displayName = "Chip";
