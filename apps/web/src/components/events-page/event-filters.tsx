import { cn } from "@cloudflare/kumo";
import { formatNumber } from "../../lib/format";
import { EVENT_GROUPS, type EventGroup } from "../dag/model";

/**
 * Filter chips by event type group (DESIGN.md 8.3 filter chip, 9.9): 12px, 1px rule border,
 * selected in ink with inverse text, a trailing mono count at 70%. "All" clears the group.
 * Counts cover the loaded events that pass the other filters.
 */
export function EventGroupChips({
  counts,
  total,
  selected,
  onChange,
}: {
  counts: ReadonlyMap<EventGroup | "other", number>;
  total: number;
  selected: EventGroup | null;
  onChange: (next: EventGroup | null) => void;
}) {
  const groups = Object.entries(EVENT_GROUPS) as [EventGroup, { label: string }][];
  return (
    <fieldset className="flex min-w-0 flex-wrap items-center gap-1.5">
      <legend className="sr-only">Event type</legend>
      <span aria-hidden className="mr-1 text-[11px] tracking-[0.08em] text-kumo-subtle uppercase">
        Type
      </span>
      <Chip label="All" count={total} pressed={selected === null} onClick={() => onChange(null)} />
      {groups.map(([key, group]) => (
        <Chip
          key={key}
          label={group.label}
          count={counts.get(key) ?? 0}
          pressed={selected === key}
          onClick={() => onChange(selected === key ? null : key)}
        />
      ))}
    </fieldset>
  );
}
EventGroupChips.displayName = "EventGroupChips";

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
