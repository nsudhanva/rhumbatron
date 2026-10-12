import { Button, cn } from "@cloudflare/kumo";
import { ArrowUp, CaretDown, CaretRight, Pause, Play } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EMPTY, formatClock, formatMs, formatNumber } from "../../lib/format";
import { usePrefersReducedMotion } from "../../lib/motion";
import { SkeletonRows } from "../project/feedback";
import { Td, Th, TRow } from "../ui/data-table";
import { EmptyState } from "../ui/empty-state";
import { KeyValue } from "../ui/key-value";
import { Payload } from "../ui/log-well";
import { type FeedEvent, ingestLagMs, TONE_TEXT, typeTone } from "./feed-model";

/** Scroll distance (px) under which the reader counts as "at the top" of the stream. */
const TOP_SLACK = 8;

/**
 * Event stream: sequence, time, type, actor, detail and version, newest on top.
 * New rows never move what the reader is looking at: below the top, the scroll position holds
 * and an "N new" control appears instead. Pause freezes the rows at the current sequence; new
 * events then only add to a "N new" count, and the announcements stop. The page filters the
 * events (events-filter-bar.tsx); the stream shows the matching ones.
 */
export function EventStream({
  projectId,
  events,
  total,
  filterKey,
  onClearFilter,
  loading,
  systems,
  scopedToChange,
  footer,
}: {
  projectId: string;
  /** Loaded events that match the filter, newest first. */
  events: FeedEvent[];
  /** Loaded events before the filter. */
  total: number;
  /** Changes when the filter changes: the stream then goes back to the top. */
  filterKey: string;
  /** Clears the page filter; null when no filter is set. */
  onClearFilter: (() => void) | null;
  loading: boolean;
  /** Systems View: adds the ingest lag column. */
  systems: boolean;
  /** True when the stream shows one Change: hides the "scope to this Change" link. */
  scopedToChange: boolean;
  /** Load-older control and paging state, under the table. */
  footer?: ReactNode;
}) {
  const [frozenAt, setFrozenAt] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [unseen, setUnseen] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const reduceMotion = usePrefersReducedMotion();
  const paused = frozenAt !== null;

  const matching = events;
  const visible = useMemo(
    () => (frozenAt === null ? matching : matching.filter((e) => e.seq <= frozenAt)),
    [matching, frozenAt],
  );
  const heldBack = matching.length - visible.length;

  // Keep the reader's place when rows insert above it.
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ seq: number; top: number } | null>(null);
  const lastFilterKey = useRef(filterKey);
  const topSeq = visible[0]?.seq;

  const relativeTop = (row: Element) => {
    const container = scrollRef.current;
    if (!container) return 0;
    return row.getBoundingClientRect().top - container.getBoundingClientRect().top;
  };

  const captureAnchor = () => {
    const first = scrollRef.current?.querySelector("[data-seq]");
    const seq = Number(first?.getAttribute("data-seq"));
    anchor.current = first && Number.isFinite(seq) ? { seq, top: relativeTop(first) } : null;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the top row changes
  useLayoutEffect(() => {
    const container = scrollRef.current;
    const previous = anchor.current;
    const filterChanged = lastFilterKey.current !== filterKey;
    lastFilterKey.current = filterKey;
    if (container && previous && !filterChanged && topSeq !== undefined && topSeq > previous.seq) {
      const arrived = visible.filter((e) => e.seq > previous.seq);
      if (container.scrollTop > TOP_SLACK) {
        const row = container.querySelector(`[data-seq="${previous.seq}"]`);
        if (row) container.scrollTop += relativeTop(row) - previous.top;
        setUnseen((n) => n + arrived.length);
      }
      const latest = arrived[0];
      if (latest) {
        setAnnouncement(
          `${formatNumber(arrived.length)} new ${arrived.length === 1 ? "event" : "events"}. Latest: ${latest.eventType}, ${latest.summary}`,
        );
      }
    }
    captureAnchor();
  }, [topSeq, filterKey]);

  const onScroll = () => {
    const container = scrollRef.current;
    if (container && container.scrollTop <= TOP_SLACK && unseen > 0) setUnseen(0);
    captureAnchor();
  };

  const toTop = () => {
    scrollRef.current?.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    setUnseen(0);
  };

  const togglePause = () => {
    if (paused) {
      setFrozenAt(null);
      return;
    }
    setFrozenAt(events[0]?.seq ?? 0);
  };

  const toggleRow = (seq: number) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });

  // A new filter starts from the top of the stream.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the filter key is the trigger
  useLayoutEffect(() => {
    setUnseen(0);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [filterKey]);

  const columns = systems ? 7 : 6;
  const filtered = onClearFilter !== null;

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <p className="text-[12px] text-kumo-subtle">
          {paused
            ? `Paused at sequence ${formatNumber(frozenAt)}. New events wait until you resume.`
            : "Live. Newest first."}{" "}
          {filtered
            ? `${formatNumber(matching.length)} of ${formatNumber(total)} loaded events match the filter.`
            : `${formatNumber(total)} loaded events.`}
        </p>
        <div className="flex shrink-0 items-center gap-3">
          {paused && (
            <span className="font-mono text-[12px] text-kumo-subtle tabular-nums">
              {formatNumber(heldBack)} new
            </span>
          )}
          <Button
            size="sm"
            variant="secondary"
            icon={paused ? Play : Pause}
            aria-pressed={paused}
            onClick={togglePause}
          >
            {paused ? "Resume" : "Pause"}
          </Button>
        </div>
      </div>

      {/* Silent while paused. */}
      <p className="sr-only" aria-live={paused ? "off" : "polite"} aria-atomic="true">
        {paused ? "" : announcement}
      </p>

      <div className="relative min-w-0">
        {unseen > 0 && !paused && (
          <div className="absolute top-10 left-2 z-20">
            <Button size="sm" variant="primary" icon={ArrowUp} onClick={toTop}>
              {`${formatNumber(unseen)} new`}
            </Button>
          </div>
        )}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="max-h-[min(72vh,760px)] min-w-0 overflow-auto [overflow-anchor:none]"
        >
          <table
            className="w-full border-separate border-spacing-0 text-left text-[13px]"
            style={{ minWidth: systems ? 960 : 880 }}
          >
            <caption className="sr-only">Project events, newest first</caption>
            <thead>
              <tr>
                <Th numeric className={STICKY}>
                  Seq
                </Th>
                <Th className={STICKY}>Time</Th>
                <Th className={STICKY}>Type</Th>
                <Th className={STICKY}>Actor</Th>
                <Th className={STICKY}>Detail</Th>
                {systems && (
                  <Th
                    numeric
                    className={STICKY}
                    title="Occurred to recorded: outbox, K2, projector"
                  >
                    Lag
                  </Th>
                )}
                <Th numeric className={STICKY}>
                  Ver
                </Th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows
                  cells={
                    systems
                      ? [40, 56, 140, 120, 280, "numeric", "numeric"]
                      : [40, 56, 140, 120, 280, "numeric"]
                  }
                  rows={6}
                />
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={columns} className="p-2">
                    {total === 0 ? (
                      <EmptyState
                        what="No events recorded yet."
                        how="Events appear here as soon as a Change starts and agents act on it."
                      />
                    ) : (
                      <EmptyState
                        what="No loaded events match the filter."
                        how="Clear the filter, or load older events below."
                        action={
                          onClearFilter && (
                            <Button size="sm" variant="secondary" onClick={onClearFilter}>
                              Clear filters
                            </Button>
                          )
                        }
                      />
                    )}
                  </td>
                </tr>
              ) : (
                visible.map((event) => (
                  <EventRows
                    key={event.seq}
                    event={event}
                    projectId={projectId}
                    open={expanded.has(event.seq)}
                    onToggle={() => toggleRow(event.seq)}
                    systems={systems}
                    columns={columns}
                    scopedToChange={scopedToChange}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      {footer}
    </div>
  );
}
EventStream.displayName = "EventStream";

const STICKY = "sticky top-0 z-10 bg-kumo-base";

function EventRows({
  event,
  projectId,
  open,
  onToggle,
  systems,
  columns,
  scopedToChange,
}: {
  event: FeedEvent;
  projectId: string;
  open: boolean;
  onToggle: () => void;
  systems: boolean;
  columns: number;
  scopedToChange: boolean;
}) {
  const tone = typeTone(event);
  const detailId = `event-detail-${event.seq}`;
  const lag = ingestLagMs(event);
  const Caret = open ? CaretDown : CaretRight;
  return (
    <Fragment>
      <TRow selected={open} className="cursor-pointer">
        <Td numeric>
          {/* The whole row is the target: this button stretches over it. */}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            aria-label={`${open ? "Hide" : "Show"} details of event ${event.seq}, ${event.eventType}`}
            onClick={onToggle}
            data-seq={event.seq}
            className="inline-flex items-center gap-1 tabular-nums after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-[-2px] focus-visible:after:outline-accent-500"
          >
            <Caret size={12} aria-hidden className="text-kumo-subtle" />
            {event.seq}
          </button>
        </Td>
        <Td
          className="font-mono text-[12px] whitespace-nowrap tabular-nums"
          title={event.occurredAt}
        >
          {formatClock(event.occurredAt)}
        </Td>
        <Td className="max-w-[240px]">
          <span
            className={cn("block truncate font-mono text-[12px] font-semibold", TONE_TEXT[tone])}
            title={event.eventType}
          >
            {event.eventType}
          </span>
        </Td>
        <Td className="max-w-[220px]">
          <span className="flex min-w-0 items-baseline gap-1.5 font-mono text-[12px]">
            <span className="shrink-0 text-kumo-subtle">{event.actor.kind}</span>
            <span className="truncate" title={event.actor.id}>
              {event.actor.id}
            </span>
          </span>
        </Td>
        <Td className="max-w-0 w-full">
          <span className="block truncate" title={event.summary}>
            {event.summary || EMPTY}
          </span>
        </Td>
        {systems && (
          <Td numeric className="text-kumo-subtle">
            {formatMs(lag)}
          </Td>
        )}
        <Td numeric className="text-kumo-subtle">
          v{event.eventVersion}
        </Td>
      </TRow>
      {open && (
        <tr id={detailId} data-detail-of={event.seq}>
          <td colSpan={columns} className="border-b border-kumo-rule bg-kumo-elevated p-3">
            <EventDetail
              event={event}
              projectId={projectId}
              lag={lag}
              scopedToChange={scopedToChange}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
}
EventRows.displayName = "EventRows";

export function EventDetail({
  event,
  projectId,
  lag,
  scopedToChange,
}: {
  event: FeedEvent;
  projectId: string;
  lag: number | null;
  scopedToChange: boolean;
}) {
  const link = "text-kumo-accent underline-offset-2 hover:underline";
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] gap-x-7 gap-y-3">
      <KeyValue
        items={[
          { label: "Event ID", value: event.eventId, mono: true },
          { label: "Type", value: `${event.eventType} · v${event.eventVersion}`, mono: true },
          { label: "Actor", value: `${event.actor.kind} · ${event.actor.id}`, mono: true },
          { label: "Occurred", value: event.occurredAt, mono: true },
          { label: "Recorded", value: event.recordedAt, mono: true },
          { label: "Ingest lag", value: lag === null ? null : formatMs(lag), mono: true },
          { label: "Resource", value: event.resource, mono: true },
          {
            label: "Change",
            mono: true,
            value: event.changeId && (
              <span className="flex flex-wrap gap-x-3">
                <Link
                  to="/changes/$changeId"
                  params={{ changeId: event.changeId }}
                  className={link}
                >
                  {event.changeId}
                </Link>
                {!scopedToChange && (
                  <Link
                    to="/projects/$projectId/events"
                    params={{ projectId }}
                    search={{ change: event.changeId }}
                    className={cn(link, "font-sans")}
                  >
                    Only this Change
                  </Link>
                )}
              </span>
            ),
          },
          { label: "Task", value: event.taskId, mono: true },
          {
            label: "Candidate",
            mono: true,
            value: event.candidateId && (
              <Link
                to="/candidates/$candidateId"
                params={{ candidateId: event.candidateId }}
                className={link}
              >
                {event.candidateId}
              </Link>
            ),
          },
        ]}
      />
      <Payload
        value={event.data}
        maxHeight={220}
        caption="The scalar payload fields the feed keeps. The full payload, secrets and model reasoning are never stored here."
      />
    </div>
  );
}
EventDetail.displayName = "EventDetail";
