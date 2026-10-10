import { Button, cn } from "@cloudflare/kumo";
import { Pause, Play } from "@phosphor-icons/react";
import { useMemo, useRef, useState } from "react";
import type { FeedEvent } from "../../lib/api";
import { formatClock, formatNumber, truncate } from "../../lib/format";
import { EmptyState } from "../ui/empty-state";
import { SectionError, SkeletonBar } from "./feedback";

/**
 * Event stream (DESIGN.md 9.9): sequence · time · type · actor · detail · version, newest on top.
 * New rows never move what the user is reading: while paused, or while the list is scrolled
 * away from the top, the shown rows stay fixed and a "N new" count waits. The region is
 * `aria-live="polite"` and goes silent while paused (section 14).
 */

/** Failure in danger · completion in success · state-changing commits in brand (accent). */
function eventTypeClass(event: Pick<FeedEvent, "eventType" | "data">): string {
  const t = event.eventType;
  const status = event.data.status;
  if (
    t.endsWith(".failed") ||
    t.endsWith(".rejected") ||
    t === "candidate.stale" ||
    t === "claim.expired" ||
    (t === "verification.completed" && status === "rejected") ||
    (t === "verification.check.completed" && (status === "fail" || status === "error"))
  ) {
    return "text-kumo-danger";
  }
  if (t === "canonical.advanced" || t === "artifact.promoted") return "text-kumo-accent";
  if (t.endsWith(".completed") || t === "approval.granted" || t === "changeset.accepted") {
    return "text-kumo-success";
  }
  return "text-kumo-default";
}

const family = (eventType: string) => eventType.split(".")[0] ?? eventType;

function actorLabel(event: FeedEvent) {
  return event.actor.kind === "user" ? "person" : event.actor.id;
}

export function EventStream({
  events,
  loading,
  error,
  onRetry,
  className,
}: {
  /** Newest first. */
  events: FeedEvent[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  className?: string;
}) {
  const [paused, setPaused] = useState(false);
  /** Newest `seq` shown while the list holds still (paused or scrolled); null when following. */
  const [held, setHeld] = useState<number | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);

  const newest = events[0]?.seq ?? 0;
  const holding = paused || held !== null;
  const top = held ?? newest;
  const shown = holding ? events.filter((e) => e.seq <= top) : events;
  const waiting = holding ? events.length - shown.length : 0;

  const families = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of shown)
      counts.set(family(e.eventType), (counts.get(family(e.eventType)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [shown]);
  const rows = filter ? shown.filter((e) => family(e.eventType) === filter) : shown;
  const digits = Math.max(2, String(newest).length);

  const pause = () => {
    setHeld((h) => h ?? newest);
    setPaused(true);
  };
  const follow = () => {
    setPaused(false);
    setHeld(null);
    list.current?.scrollTo({ top: 0 });
  };

  return (
    <div className={cn("grid min-w-0 gap-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <fieldset className="flex min-w-0 flex-wrap gap-1.5">
          <legend className="sr-only">Filter events</legend>
          <FilterChip
            label="All"
            count={shown.length}
            selected={filter === null}
            onClick={() => setFilter(null)}
          />
          {families.map(([name, count]) => (
            <FilterChip
              key={name}
              label={name}
              count={count}
              selected={filter === name}
              onClick={() => setFilter(filter === name ? null : name)}
            />
          ))}
        </fieldset>
        <div className="flex items-center gap-2">
          {waiting > 0 &&
            (paused ? (
              <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
                {formatNumber(waiting)} new
              </span>
            ) : (
              <Button size="sm" variant="secondary" onClick={follow}>
                {formatNumber(waiting)} new
              </Button>
            ))}
          <Button
            size="sm"
            variant="secondary"
            icon={paused ? Play : Pause}
            onClick={paused ? follow : pause}
          >
            {paused ? "Resume" : "Pause"}
          </Button>
        </div>
      </div>

      {error && (
        <SectionError
          message={`Events could not load. ${error}`}
          {...(onRetry ? { onRetry } : {})}
        />
      )}

      <div className="min-w-0 overflow-x-auto border-t border-kumo-rule">
        <ol
          ref={list}
          aria-label="Recent events"
          aria-live={paused ? "off" : "polite"}
          aria-relevant="additions"
          aria-busy={loading || undefined}
          onScroll={(e) => {
            const scrolled = e.currentTarget.scrollTop > 8;
            if (scrolled && held === null) setHeld(newest);
            else if (!scrolled && !paused && held !== null) setHeld(null);
          }}
          className="max-h-96 min-w-[720px] overflow-y-auto"
        >
          {loading && events.length === 0
            ? [0, 1, 2].map((i) => (
                <li key={i} className="border-b border-kumo-rule px-1 py-2">
                  <SkeletonBar height={12} className="w-2/3" />
                </li>
              ))
            : rows.map((event) => (
                <li
                  key={event.seq}
                  className="grid grid-cols-[56px_64px_minmax(150px,220px)_minmax(96px,160px)_minmax(0,1fr)_28px] items-baseline gap-3 border-b border-kumo-rule px-1 py-1.5 font-mono text-[11px] tabular-nums"
                >
                  <span className="text-kumo-subtle">
                    {String(event.seq).padStart(digits, "0")}
                  </span>
                  <time className="text-kumo-subtle" dateTime={event.occurredAt}>
                    {formatClock(event.occurredAt)}
                  </time>
                  <span className={cn("truncate font-semibold", eventTypeClass(event))}>
                    {event.eventType}
                  </span>
                  <span className="truncate text-kumo-subtle" title={event.actor.id}>
                    {actorLabel(event)}
                  </span>
                  <span className="truncate font-sans text-[12px]" title={event.summary}>
                    {truncate(event.summary, 200)}
                  </span>
                  <span className="text-right text-kumo-subtle">v{event.eventVersion}</span>
                </li>
              ))}
        </ol>
      </div>
      {!loading && !error && events.length === 0 && (
        <EmptyState
          what="No events recorded yet."
          how="Events appear here as Changes run: Tasks, agents, Claims, Candidates and promotion."
        />
      )}
    </div>
  );
}
EventStream.displayName = "EventStream";

function FilterChip({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-6 cursor-pointer items-center gap-1.5 border border-kumo-rule px-2 font-mono text-[11px]",
        "transition-colors duration-(--rh-dur-ui) hover:bg-kumo-row-hover",
        "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500",
        selected && "border-kumo-ink bg-kumo-faint font-semibold",
      )}
    >
      {label}
      <span className="text-kumo-subtle tabular-nums">{formatNumber(count)}</span>
    </button>
  );
}
FilterChip.displayName = "FilterChip";
