import { Button, cn } from "@cloudflare/kumo";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatNumber, truncate } from "../../../lib/format";
import type { ActivityEvent } from "../../agents/activity-model";
import { EmptyState } from "../../ui/empty-state";
import { useFlight } from "../flight-context";
import { currentRef, entityLabel, type FlightState, refKey, relatedRefs } from "../flight-model";
import { type EntityRef, useFlightFilters, useFlightStore, useSelection } from "../flight-store";
import { EntityHover } from "../hover-preview";
import { PanelSkeleton } from "../panel-frame";
import type { PanelProps } from "../panel-types";
import { RefButton } from "./arena/ref-button";
import { clockOf } from "./decisions/decision-view";

/**
 * Event stream (DESIGN.md 9.9): every recorded fact of the Change up to the fold instant, newest
 * on top. Facts come from `state.events` (flight-model.ts over activity-model.ts: Task runs,
 * conflicts, Candidates, Evidence, claim facts and the Change's event feed). The global event
 * family filter and the text filter apply. A newly played fact flashes once. Each row selects the
 * fact, its entity button selects what the fact is about, and "Jump to time" folds the time
 * machine at the fact. The page owns the polite live region.
 */

const PAGE = 300;

const familyOf = (type: string) => type.split(".")[0] ?? type;

/** Type color (DESIGN.md 9.9): failure danger, completion success, canonical commits brand. */
function typeTone(event: ActivityEvent): string {
  const t = event.type;
  if (event.kind === "check") {
    if (event.status === "fail" || event.status === "error") return "text-kumo-danger";
    if (event.status === "pass" && event.coverage === "checked_supported") {
      return "text-kumo-success";
    }
    return "text-kumo-default";
  }
  if (event.kind === "candidate.status") {
    if (event.status === "rejected" || event.status === "stale") return "text-kumo-danger";
    if (event.status === "verified") return "text-kumo-success";
    return "text-kumo-default";
  }
  if (event.kind === "run.end") {
    return event.status === "failed" ? "text-kumo-danger" : "text-kumo-success";
  }
  if (/(failed|rejected|expired|stale|error)/.test(t)) return "text-kumo-danger";
  if (event.kind === "promoted" || t.startsWith("canonical.")) return "text-kumo-accent";
  if (/(completed|verified|granted|resolved|accepted)/.test(t)) return "text-kumo-success";
  return "text-kumo-default";
}

/** Task id and Candidate id named by a fact, for the focused columns. */
function idsOf(event: ActivityEvent): { taskId: string | null; candidateId: string | null } {
  const taskId =
    event.kind === "challenge"
      ? event.fromLaneId
      : "laneId" in event
        ? (event.laneId ?? null)
        : null;
  const candidateId = "candidateId" in event ? (event.candidateId ?? null) : null;
  return { taskId, candidateId };
}

function entityText(state: FlightState, ref: EntityRef): string {
  switch (ref.kind) {
    case "task":
      return state.tasks[ref.id]?.key ?? ref.id;
    case "candidate":
      return state.candidates[ref.id]?.name ?? ref.id;
    case "check":
      return ref.id.split(":").slice(1).join(":") || ref.id;
    default:
      return truncate(entityLabel(state, ref).title, 28);
  }
}

function matches(event: ActivityEvent, query: string) {
  if (!query) return true;
  return `${event.type} ${event.actor} ${event.detail}`.toLowerCase().includes(query);
}

function EventRow({
  event,
  index,
  state,
  selected,
  dimmed,
  flash,
  focused,
}: {
  event: ActivityEvent;
  index: number;
  state: FlightState;
  selected: boolean;
  dimmed: boolean;
  flash: boolean;
  focused: boolean;
}) {
  const ref = { kind: "event" as const, id: event.id };
  const hovered = useFlightStore(
    (s) => s.hover !== null && s.hover.kind === "event" && s.hover.id === event.id,
  );
  const about = currentRef(event);
  const aboutEntity = about && about.kind !== "event" ? about : null;
  const ids = focused ? idsOf(event) : null;
  return (
    <li
      data-event={event.id}
      className={cn(
        "border-b border-kumo-rule transition-opacity duration-[var(--rh-dur-ui)]",
        dimmed && "opacity-45",
      )}
    >
      <div
        className={cn(
          "grid items-center hover:bg-kumo-row-hover",
          focused
            ? "grid-cols-[minmax(0,1fr)_104px_88px_128px_32px]"
            : "grid-cols-[minmax(0,1fr)_minmax(0,120px)_32px]",
          (selected || hovered) && "bg-kumo-faint",
          selected && "shadow-[inset_2px_0_0_var(--color-accent-500)]",
          flash && "rh-arrive",
        )}
      >
        <EntityHover entity={ref}>
          <button
            type="button"
            aria-pressed={selected}
            onClick={() => useFlightStore.getState().toggle(ref)}
            className={cn(
              "grid min-h-6 w-full min-w-0 cursor-pointer items-baseline gap-x-2 py-1 pl-3 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500 pointer-coarse:min-h-11",
              focused
                ? "grid-cols-[40px_56px_minmax(0,208px)_96px_88px_minmax(0,1fr)]"
                : "grid-cols-[56px_minmax(0,176px)_minmax(0,1fr)]",
            )}
          >
            {focused && (
              <span className="text-right font-mono text-[11px] text-kumo-subtle tabular-nums">
                {formatNumber(index + 1)}
              </span>
            )}
            <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
              {clockOf(event.at)}
            </span>
            <span
              className={cn("truncate font-mono text-[11px] font-semibold", typeTone(event))}
              title={event.type}
            >
              {event.type}
            </span>
            {focused && (
              <span className="truncate font-mono text-[11px] text-kumo-subtle" title={event.kind}>
                {event.kind}
              </span>
            )}
            {focused && (
              <span className="truncate font-mono text-[11px]" title={event.actor}>
                {event.actor}
              </span>
            )}
            <span className="min-w-0 truncate text-[12px]" title={event.detail}>
              {!focused && event.actor && (
                <span className="mr-1.5 font-mono text-[11px] text-kumo-subtle">{event.actor}</span>
              )}
              {event.detail}
            </span>
          </button>
        </EntityHover>
        {ids && (
          <span
            className="truncate px-1 font-mono text-[11px] text-kumo-subtle"
            title={ids.taskId ?? undefined}
          >
            {ids.taskId ?? "—"}
          </span>
        )}
        {ids && (
          <span
            className="truncate px-1 font-mono text-[11px] text-kumo-subtle"
            title={ids.candidateId ?? undefined}
          >
            {ids.candidateId ?? "—"}
          </span>
        )}
        <span className="flex min-w-0 justify-end px-1">
          {aboutEntity && (
            <RefButton
              entity={aboutEntity}
              title={`Select ${entityLabel(state, aboutEntity).kicker}: ${entityLabel(state, aboutEntity).title}`}
              context={`select ${entityLabel(state, aboutEntity).kicker}: ${entityLabel(state, aboutEntity).title}`}
              className="max-w-[120px] truncate px-1 font-mono text-[11px]"
            >
              {entityText(state, aboutEntity)}
            </RefButton>
          )}
        </span>
        <button
          type="button"
          aria-label={`Jump to ${clockOf(event.at)}: ${event.type}`}
          title="Jump to time"
          onClick={() => useFlightStore.getState().scrubTo(event.at)}
          className="mr-1 inline-flex size-6 cursor-pointer items-center justify-center text-kumo-subtle hover:bg-kumo-faint hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 pointer-coarse:size-11"
        >
          <ClockCounterClockwise size={14} aria-hidden />
        </button>
      </div>
    </li>
  );
}
EventRow.displayName = "EventRow";

export function EventsPanel({ focused }: PanelProps) {
  const { state, ready, inFlight } = useFlight();
  const filters = useFlightFilters();
  const selection = useSelection();
  const [limit, setLimit] = useState(PAGE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  // How many rows were visible the last time the reader was at the top: the rest are "new".
  const [seen, setSeen] = useState(0);

  const query = filters.query.trim().toLowerCase();
  const families = filters.eventFamilies;
  // Newest first, with each fact's position in the fold (1-based sequence).
  const rows = useMemo(() => {
    const out: { event: ActivityEvent; index: number }[] = [];
    for (let i = state.events.length - 1; i >= 0; i--) {
      const event = state.events[i];
      if (!event) continue;
      if (families.length > 0 && !families.includes(familyOf(event.type))) continue;
      if (!matches(event, query)) continue;
      out.push({ event, index: i });
    }
    return out;
  }, [state.events, families, query]);

  const related = useMemo(() => relatedRefs(state, selection), [state, selection]);
  const selectedId = selection?.kind === "event" ? selection.id : null;

  // Keep the selected fact on screen: page in older rows when it is beyond the limit.
  const selectedRow = selectedId ? rows.findIndex((r) => r.event.id === selectedId) : -1;
  useEffect(() => {
    if (selectedRow >= limit) setLimit(Math.ceil((selectedRow + 1) / PAGE) * PAGE);
  }, [selectedRow, limit]);
  useEffect(() => {
    if (!selectedId) return;
    scrollRef.current
      ?.querySelector(`[data-event="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  // While the reader is at the top, every row counts as seen. Scrolled away, new rows insert
  // above without moving what they read (browser scroll anchoring) and show as "N new".
  useLayoutEffect(() => {
    if (!scrolled) setSeen(rows.length);
  }, [rows.length, scrolled]);
  const fresh = scrolled ? Math.max(0, rows.length - seen) : 0;

  if (!ready) return <PanelSkeleton />;

  const visible = rows.slice(0, limit);
  const filtered = families.length > 0 || query.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {fresh > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-kumo-rule px-3 py-1">
          <span className="font-mono text-[11px] text-kumo-subtle">{formatNumber(fresh)} new</span>
          <Button size="xs" variant="ghost" onClick={() => scrollRef.current?.scrollTo({ top: 0 })}>
            Show newest
          </Button>
        </div>
      )}
      {state.events.length === 0 ? (
        <div className="px-3">
          <EmptyState
            what="No events recorded yet."
            how="Facts appear here as the Change runs: wakes, routes, Claims, Intents, ChangeSets, checks."
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="px-3">
          <EmptyState
            what="No event matches the filters."
            how={`${formatNumber(state.events.length)} events are recorded at this instant.`}
          />
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-auto"
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 8)}
        >
          <ol
            aria-label={`Events, newest first${filtered ? ", filtered" : ""}`}
            className={cn(focused && "min-w-[1040px]")}
          >
            {visible.map(({ event, index }) => (
              <EventRow
                key={event.id}
                event={event}
                index={index}
                state={state}
                selected={event.id === selectedId}
                dimmed={
                  selection !== null &&
                  !related.has(refKey({ kind: "event", id: event.id })) &&
                  !(currentRef(event) && related.has(refKey(currentRef(event) as EntityRef)))
                }
                flash={inFlight.has(event.id)}
                focused={focused}
              />
            ))}
          </ol>
          {rows.length > limit && (
            <div className="flex items-center gap-3 px-3 py-2">
              <Button size="sm" variant="secondary" onClick={() => setLimit((l) => l + PAGE)}>
                Show older
              </Button>
              <span className="font-mono text-[11px] text-kumo-subtle">
                {formatNumber(limit)} of {formatNumber(rows.length)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
EventsPanel.displayName = "EventsPanel";
