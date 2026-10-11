import { Button, cn } from "@cloudflare/kumo";
import {
  ArrowLineRight,
  ArrowsIn,
  ArrowsOut,
  ArrowsOutLineHorizontal,
  CaretDown,
  CaretRight,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type ChangeSummary, getDeadLetters } from "../../lib/api";
import { formatAge, formatNumber, truncate } from "../../lib/format";
import { displayTimeZone, renderNow, zoneOffsetMs } from "../../lib/render-time";
import { SectionError, SkeletonBar } from "../project/feedback";
import { ChangeStatusPill } from "../project/status";
import { EmptyState } from "../ui/empty-state";
import { Section } from "../ui/page";
import { FAMILY_FILL, statusView } from "../ui/status-pill";
import { Tag } from "../ui/tag";
import {
  type AttentionItem,
  type AttentionKind,
  type BarStatus,
  buildTimeline,
  type MarkerKind,
  spanText,
  type TimelineBar,
  type TimelineChange,
  type TimelineMarker,
  type TimelineModel,
  type TimelineTask,
} from "./timeline-model";
import { useTimelineEvents, useTimelineTasks } from "./use-timeline-data";

/**
 * Project execution timeline (AGENTS.md 38.1, 39; DESIGN.md 9.8 trace waterfall, 11.1 agents
 * working simultaneously). Who asked for what, which agent works on which Task, and when:
 *
 *   person (requester)            one header row per person
 *     Change                      span from request to its last recorded fact, with markers
 *       Task · agent              one row per Task; each attempt is a bar, colored by status
 *
 * Markers are recorded events (request, plan, conflict, question, approval, verdicts,
 * promotion, release). Promotions also draw a dashed rule over every row. A "Needs attention"
 * rail lists what waits on a person. Live: refreshed on each live-socket signal, and every 10 s
 * while the socket is down. Running bars grow to "now" once a second.
 *
 * Zoom: buttons, + / - / 0 keys on the plot, or Ctrl (or pinch) with the wheel. Fit shows the
 * whole span; Now scrolls to the live edge. Full screen gives the plot and the rail the whole
 * viewport (the Fullscreen API, else a fixed overlay); Esc or "Exit full screen" closes it.
 */

const LEFT = 340;
const AXIS_H = 46;
const PERSON_H = 36;
const CHANGE_H = 48;
const TASK_H = 40;
const NOTE_H = 30;
const BAR_Y = 12;
/** Top of a Change marker: its label sits above the span line, its square on it. */
const MARKER_TOP = 6;
const BAR_H = 16;
const PAD_L = 16;
const PAD_R = 64;
const MIN_HEIGHT = 420;
const MAX_HEIGHT = 680;
const POLL_MS = 10_000;
const TOOLTIP_DELAY_MS = 400;
/** Most zoomed in: 100 px per 5 s. The plot never grows past `MAX_PLOT_PX`. */
const MAX_PX_PER_MS = 100 / 5_000;
const MAX_PLOT_PX = 60_000;
const ZOOM_STEP = 1.6;

const TICK_STEPS = [
  10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000,
  7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
];

/* ------------------------------------------------------------------------------------------ */
/* Styles                                                                                      */
/* ------------------------------------------------------------------------------------------ */

const BAR_STYLE: Record<BarStatus, string> = {
  running: "bg-kumo-ink text-kumo-inverse",
  completed: "border border-kumo-success bg-kumo-success-tint text-kumo-success",
  failed: "border border-accent-500 bg-kumo-danger-tint text-kumo-danger",
  cancelled: "border border-dashed border-tone-500 bg-tone-200 text-tone-800",
};

const BAR_WORD: Record<BarStatus, string> = {
  running: "Running",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const TIER_LETTER: Record<TimelineBar["tier"], string> = { haiku: "H", sonnet: "S", opus: "O" };
const TIER_WORD: Record<TimelineBar["tier"], string> = {
  haiku: "Haiku",
  sonnet: "Sonnet",
  opus: "Opus",
};

const MARKER_STYLE: Record<MarkerKind, string> = {
  request: "border-2 border-kumo-ink bg-kumo-elevated",
  plan: "bg-kumo-ink",
  // A diamond: a conflict needs a decision, it is not an error. Red marks only failures.
  conflict: "rotate-45 scale-90 bg-kumo-ink",
  clarify: "bg-kumo-warning",
  approval: "border-2 border-kumo-warning bg-kumo-elevated",
  verified: "bg-kumo-success",
  rejected: "bg-kumo-danger",
  stale: "border-2 border-tone-500 bg-kumo-elevated",
  promotion: "border-2 border-kumo-ink bg-kumo-success",
  release: "border-2 border-kumo-success bg-kumo-elevated",
  release_failed: "border-2 border-kumo-ink bg-kumo-danger",
  cancelled: "bg-tone-300",
};

const MARKER_TEXT: Partial<Record<MarkerKind, string>> = {
  conflict: "font-semibold text-kumo-default",
  clarify: "font-semibold text-kumo-warning",
  verified: "text-kumo-success",
  rejected: "font-semibold text-kumo-danger",
  release_failed: "font-semibold text-kumo-danger",
  promotion: "font-semibold text-kumo-success",
  release: "text-kumo-success",
};

const MARKER_LEGEND: { kind: MarkerKind; label: string }[] = [
  { kind: "request", label: "Request" },
  { kind: "plan", label: "Plan ready" },
  { kind: "conflict", label: "Conflict" },
  { kind: "clarify", label: "Question" },
  { kind: "approval", label: "Approval" },
  { kind: "verified", label: "Verified" },
  { kind: "rejected", label: "Rejected" },
  { kind: "stale", label: "Stale" },
  { kind: "promotion", label: "Promotion" },
  { kind: "release", label: "Live" },
  { kind: "release_failed", label: "Release failed" },
  { kind: "cancelled", label: "Cancelled" },
];

const ATTENTION_KICKER: Record<AttentionKind, string> = {
  clarify: "Question",
  approval: "Approval",
  blocked: "Blocked",
  budget: "Budget",
  limit: "Limit",
  dead_letter: "Failed command",
  conflict: "Conflict",
};

/* ------------------------------------------------------------------------------------------ */
/* Time helpers                                                                                */
/* ------------------------------------------------------------------------------------------ */

// Clock and day in the viewer's zone, the same on the server and in the hydration.
const zone = () => {
  const timeZone = displayTimeZone();
  return timeZone ? { timeZone } : {};
};
const clockOf = (t: number, seconds: boolean) =>
  new Date(t).toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    ...zone(),
  });
const dayOf = (t: number) =>
  new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...zone() });
const localDay = (t: number) =>
  new Date(t).toLocaleDateString("en-GB", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    ...zone(),
  });

/** "1 min", "30 s", "2 h" for the zoom readout. */
function perHundred(pxPerMs: number) {
  const ms = 100 / pxPerMs;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(ms < 36_000_000 ? 1 : 0)} h`;
}

/** Wall clock that ticks once a second while `enabled`. */
function useNow(enabled: boolean) {
  const [now, setNow] = useState(renderNow);
  useEffect(() => {
    setNow(Date.now());
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

function useWidth() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return { el, ref: setEl, width };
}

/**
 * Full-viewport view of one element: the Fullscreen API when the browser grants it, else a fixed
 * overlay that Esc closes. The browser's own Esc handling ends a native full screen.
 */
function useFullScreen(el: HTMLElement | null) {
  const [mode, setMode] = useState<"native" | "overlay" | null>(null);
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setMode((m) => (m === "native" ? null : m));
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  useEffect(() => {
    if (mode !== "overlay") return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setMode(null);
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [mode]);
  const enter = useCallback(async () => {
    if (!el) return;
    if (typeof el.requestFullscreen === "function") {
      try {
        await el.requestFullscreen();
        setMode("native");
        return;
      } catch {
        // Refused (iframe, policy, browser): the overlay below does the same job.
      }
    }
    setMode("overlay");
  }, [el]);
  const exit = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    setMode(null);
  }, []);
  return { full: mode !== null, enter, exit };
}

/* ------------------------------------------------------------------------------------------ */
/* Rows                                                                                        */
/* ------------------------------------------------------------------------------------------ */

type RowBody =
  | { kind: "person"; key: string; person: TimelineModel["people"][number] }
  | { kind: "change"; key: string; change: TimelineChange; collapsed: boolean }
  | { kind: "task"; key: string; change: TimelineChange; task: TimelineTask }
  | { kind: "note"; key: string; text: string; danger: boolean };
type Row = RowBody & { y: number; h: number };

function layoutRows(model: TimelineModel, collapsed: ReadonlySet<string>) {
  const rows: Row[] = [];
  let y = 0;
  const push = (row: RowBody, h: number) => {
    rows.push({ ...row, y, h });
    y += h;
  };
  for (const person of model.people) {
    push({ kind: "person", key: `p:${person.key}`, person }, PERSON_H);
    for (const change of person.changes) {
      const isCollapsed = collapsed.has(change.id);
      push({ kind: "change", key: `c:${change.id}`, change, collapsed: isCollapsed }, CHANGE_H);
      if (isCollapsed) continue;
      if (change.tasksState === "loading") {
        push({ kind: "note", key: `n:${change.id}`, text: "Reading Tasks", danger: false }, NOTE_H);
      } else if (change.tasksState === "error") {
        const text = "Tasks of this Change could not load.";
        push({ kind: "note", key: `n:${change.id}`, text, danger: true }, NOTE_H);
      }
      for (const task of change.tasks) {
        push({ kind: "task", key: `t:${task.id}`, change, task }, TASK_H);
      }
    }
  }
  return { rows, height: y };
}

/* ------------------------------------------------------------------------------------------ */
/* Tooltip                                                                                     */
/* ------------------------------------------------------------------------------------------ */

type Tip = { left: number; top: number; below: boolean; lines: ReactNode[] };

/** One floating tooltip for the whole plot (DESIGN.md 8.4): ink fill, inverse text, 12px. */
function useTooltip(frame: HTMLElement | null) {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const open = useRef(false);
  const show = useCallback(
    (target: Element, lines: ReactNode[], immediate = false) => {
      if (!frame) return;
      clearTimeout(timer.current);
      const place = () => {
        const f = frame.getBoundingClientRect();
        const r = target.getBoundingClientRect();
        const below = r.top - f.top < 72;
        setTip({
          left: Math.max(8, Math.min(r.left - f.left, f.width - 308)),
          top: below ? r.bottom - f.top + 6 : r.top - f.top - 6,
          below,
          lines,
        });
        open.current = true;
      };
      if (open.current || immediate) place();
      else timer.current = setTimeout(place, TOOLTIP_DELAY_MS);
    },
    [frame],
  );
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      open.current = false;
      setTip(null);
    }, 80);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { tip, show, hide };
}

/* ------------------------------------------------------------------------------------------ */
/* Component                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export function ProjectTimeline({
  projectId,
  changes,
  changesError,
  pulse,
  socketOpen,
}: {
  projectId: string;
  /** The overview's Change list (newest 20). */
  changes: ChangeSummary[] | undefined;
  changesError: boolean;
  /** Increments on every live-socket signal. */
  pulse: number;
  socketOpen: boolean;
}) {
  const oldest = useMemo(() => {
    if (!changes || changes.length === 0) return null;
    return Math.min(...changes.map((c) => Date.parse(c.createdAt)).filter((t) => !Number.isNaN(t)));
  }, [changes]);
  const tasks = useTimelineTasks(projectId, changes);
  const events = useTimelineEvents(projectId, oldest);
  // Shares the operator banners' query: no extra read.
  const operator = useQuery({
    queryKey: ["dead-letters", projectId, null],
    queryFn: () => getDeadLetters({ data: { projectId, changeId: undefined } }),
    refetchInterval: 60_000,
  });

  const { refresh: refreshTasks } = tasks;
  const { refresh: refreshEvents } = events;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each live signal is the trigger
  useEffect(() => {
    if (pulse === 0) return;
    refreshEvents();
    refreshTasks();
  }, [pulse]);
  useEffect(() => {
    if (socketOpen) return;
    const timer = setInterval(() => {
      refreshEvents();
      refreshTasks();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [socketOpen, refreshEvents, refreshTasks]);

  const model = useMemo(
    () =>
      changes
        ? buildTimeline({
            changes,
            tasks: tasks.tasks,
            events: events.events,
            deadLetters: operator.data?.deadLetters ?? [],
            limits: operator.data?.limits ?? [],
          })
        : null,
    [changes, tasks.tasks, events.events, operator.data],
  );

  const c = model?.counts;
  const meta = c ? (
    <span className="font-mono tabular-nums">
      {formatNumber(c.people)} {c.people === 1 ? "person" : "people"} · {formatNumber(c.changes)}{" "}
      {c.changes === 1 ? "change" : "changes"} · {formatNumber(c.tasks)} tasks
      {c.running > 0 ? ` · ${formatNumber(c.running)} running` : ""}
    </span>
  ) : null;

  return (
    <Section label="Execution timeline" meta={meta}>
      {changesError ? (
        <SectionError message="The timeline needs the Change list, which could not load." />
      ) : !model ? (
        <div aria-hidden className="grid gap-2 bg-kumo-elevated p-4" style={{ height: MIN_HEIGHT }}>
          <SkeletonBar height={13} className="w-1/3" />
          <SkeletonBar height={11} className="w-2/3" />
          <SkeletonBar height={11} className="w-1/2" />
        </div>
      ) : model.people.length === 0 ? (
        <EmptyState
          what="No work on the timeline yet."
          how="Submit a change under New change: each request, its agents and their Tasks appear here as they run."
        />
      ) : (
        <TimelineBody
          model={model}
          projectId={projectId}
          eventsError={events.error}
          eventsTruncated={events.truncated}
          tasksError={tasks.error}
          onRetry={() => {
            refreshEvents();
            refreshTasks();
          }}
        />
      )}
    </Section>
  );
}
ProjectTimeline.displayName = "ProjectTimeline";

function TimelineBody({
  model,
  projectId,
  eventsError,
  eventsTruncated,
  tasksError,
  onRetry,
}: {
  model: TimelineModel;
  projectId: string;
  eventsError: string | null;
  eventsTruncated: boolean;
  tasksError: string | null;
  onRetry: () => void;
}) {
  const summaryId = useId();
  const now = useNow(model.live);
  const scroller = useWidth();
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const tooltip = useTooltip(frame);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const screen = useFullScreen(root);
  const full = screen.full;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Scale. Fit shows the whole span; any other zoom keeps its px per ms.
  const [zoom, setZoom] = useState<{ fit: true } | { fit: false; px: number }>({ fit: true });
  const viewEnd = model.live ? Math.max(model.end, now) : model.end;
  const span = Math.max(60_000, viewEnd - model.start);
  const available = Math.max(320, scroller.width - LEFT - PAD_L - PAD_R);
  const fitPx = available / span;
  const maxPx = Math.max(fitPx, Math.min(MAX_PX_PER_MS, MAX_PLOT_PX / span));
  const px = zoom.fit ? fitPx : Math.min(Math.max(zoom.px, fitPx), maxPx);
  const atFit = zoom.fit || px <= fitPx * 1.001;
  const atMax = px >= maxPx * 0.999;
  const plotWidth = Math.ceil(span * px) + PAD_L + PAD_R;
  const x = useCallback(
    (t: number) => PAD_L + (Math.min(Math.max(t, model.start), viewEnd) - model.start) * px,
    [model.start, viewEnd, px],
  );

  const ticks = useMemo(() => {
    const step =
      TICK_STEPS.find((s) => s * px >= 96) ?? TICK_STEPS[TICK_STEPS.length - 1] ?? 60_000;
    const offset = -zoneOffsetMs(model.start);
    const first = Math.ceil((model.start - offset) / step) * step + offset;
    const out: { t: number; seconds: boolean; day: string | null }[] = [];
    let lastDay = "";
    for (let t = first; t <= viewEnd; t += step) {
      const day = localDay(t);
      out.push({ t, seconds: step < 60_000, day: day !== lastDay ? dayOf(t) : null });
      lastDay = day;
    }
    return out;
  }, [model.start, viewEnd, px]);

  // Zoom keeps the instant under the anchor (pointer, or the middle of the view) in place.
  const anchor = useRef<{ t: number; offset: number } | null>(null);
  const follow = useRef(true);
  const zoomTo = useCallback(
    (nextPx: number | "fit", clientX?: number) => {
      const el = scroller.el;
      if (el) {
        const rect = el.getBoundingClientRect();
        const offset =
          clientX === undefined
            ? (el.clientWidth - LEFT) / 2
            : Math.max(0, clientX - rect.left - LEFT);
        anchor.current = { t: model.start + (el.scrollLeft + offset - PAD_L) / px, offset };
      }
      if (nextPx === "fit") setZoom({ fit: true });
      else setZoom({ fit: false, px: Math.min(Math.max(nextPx, fitPx), maxPx) });
    },
    [scroller.el, model.start, px, fitPx, maxPx],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a wider plot re-pins the live edge
  useLayoutEffect(() => {
    const el = scroller.el;
    const a = anchor.current;
    if (!el) return;
    if (a) {
      anchor.current = null;
      el.scrollLeft = Math.max(0, PAD_L + (a.t - model.start) * px - a.offset);
      return;
    }
    // While pinned to the live edge, a growing plot keeps "now" in view.
    if (follow.current && model.live) el.scrollLeft = el.scrollWidth;
  }, [px, plotWidth, scroller.el, model.start, model.live]);

  const goNow = useCallback(() => {
    const el = scroller.el;
    if (!el) return;
    follow.current = true;
    el.scrollTo({ left: el.scrollWidth, behavior: "auto" });
  }, [scroller.el]);

  // Ctrl or Cmd with the wheel (a trackpad pinch sends ctrlKey) zooms at the pointer.
  const zoomRef = useRef(zoomTo);
  zoomRef.current = zoomTo;
  const pxRef = useRef(px);
  pxRef.current = px;
  useEffect(() => {
    const el = scroller.el;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomRef.current(pxRef.current * Math.exp(-e.deltaY * 0.01), e.clientX);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scroller.el]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "+" || e.key === "=") zoomTo(px * ZOOM_STEP);
    else if (e.key === "-" || e.key === "_") zoomTo(px / ZOOM_STEP);
    else if (e.key === "0") zoomTo("fit");
    else if (e.key === "End" && e.target === e.currentTarget) goNow();
    else return;
    e.preventDefault();
  };

  const { rows, height } = useMemo(() => layoutRows(model, collapsed), [model, collapsed]);
  const frameHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, AXIS_H + height + 14));
  const nowX = model.live ? x(now) : null;

  const tipFor = {
    bar: (task: TimelineTask, bar: TimelineBar) => [
      <span key="a" className="font-semibold">
        {task.key} · {truncate(task.title, 60)}
      </span>,
      <span key="b" className="font-mono">
        {task.agentId ?? "no agent"} · {TIER_WORD[bar.tier]} · attempt {bar.attempt}
      </span>,
      <span key="c" className="font-mono">
        {BAR_WORD[bar.status]}
        {bar.failureKind ? ` (${bar.failureKind})` : ""} · {spanText(bar.start, bar.end ?? now)} ·{" "}
        {clockOf(bar.start, true)} → {bar.end ? clockOf(bar.end, true) : "now"}
      </span>,
    ],
    marker: (m: TimelineMarker) => [
      <span key="a" className="font-semibold">
        {m.label} · {clockOf(m.at, true)}
      </span>,
      <span key="b">{truncate(m.detail, 140)}</span>,
    ],
  };

  return (
    <div
      ref={setRoot}
      className={cn(
        "@container min-w-0 gap-3",
        full ? "fixed inset-0 z-[100] flex flex-col bg-kumo-base p-4" : "grid",
      )}
    >
      <Toolbar
        pxLabel={atFit ? "Whole timeline shown" : `${perHundred(px)} / 100 px`}
        atFit={atFit}
        atMax={atMax}
        live={model.live}
        onZoomIn={() => zoomTo(px * ZOOM_STEP)}
        onZoomOut={() => zoomTo(px / ZOOM_STEP)}
        onFit={() => zoomTo("fit")}
        onNow={goNow}
        full={full}
        onFullScreen={() => (full ? screen.exit() : void screen.enter())}
      />
      {(eventsError || tasksError) && (
        <SectionError
          message={`Part of the timeline could not refresh. ${eventsError ?? tasksError}`}
          onRetry={onRetry}
        />
      )}
      <div
        className={cn(
          "grid min-w-0 gap-4 @min-[1040px]:grid-cols-[minmax(0,1fr)_280px]",
          full &&
            "min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] @min-[1040px]:grid-rows-[minmax(0,1fr)]",
        )}
      >
        <div
          ref={setFrame}
          className={cn("relative min-w-0 rule-ink bg-kumo-elevated", full && "min-h-0")}
        >
          <section
            ref={scroller.ref}
            aria-label="Execution timeline"
            aria-describedby={summaryId}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard reachable; it also takes the zoom keys
            tabIndex={0}
            onKeyDown={onKeyDown}
            onScroll={(e) => {
              const el = e.currentTarget;
              follow.current = el.scrollLeft + el.clientWidth >= el.scrollWidth - 24;
            }}
            className="relative overflow-auto overscroll-x-contain focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500"
            style={{ height: full ? "100%" : frameHeight }}
          >
            <div className="relative" style={{ width: LEFT + plotWidth, height: AXIS_H + height }}>
              <Axis
                ticks={ticks}
                x={x}
                plotWidth={plotWidth}
                promotions={model.promotions}
                nowX={nowX}
              />
              {rows.map((row) => (
                <RowView
                  key={row.key}
                  row={row}
                  x={x}
                  now={now}
                  plotWidth={plotWidth}
                  onToggle={toggle}
                  tip={tooltip}
                  tipFor={tipFor}
                />
              ))}
              {/* Promotion rules and the live edge over every row. */}
              <div
                aria-hidden
                className="pointer-events-none absolute z-[5]"
                style={{ left: LEFT, top: AXIS_H, width: plotWidth, height }}
              >
                {model.promotions.map((m) => (
                  <div
                    key={m.key}
                    className="absolute top-0 bottom-0 border-l border-dashed border-kumo-divider"
                    style={{ left: x(m.at) }}
                  />
                ))}
                {nowX !== null && (
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-kumo-ink transition-[left] duration-1000 ease-linear motion-reduce:transition-none"
                    style={{ left: nowX - 1 }}
                  />
                )}
              </div>
            </div>
          </section>
          {tooltip.tip && (
            <div
              aria-hidden
              className="pointer-events-none absolute z-50 grid max-w-[300px] gap-0.5 bg-kumo-ink px-2 py-1 text-[12px] leading-snug text-kumo-inverse"
              style={{
                left: tooltip.tip.left,
                top: tooltip.tip.top,
                transform: tooltip.tip.below ? undefined : "translateY(-100%)",
              }}
            >
              {tooltip.tip.lines}
            </div>
          )}
        </div>
        <AttentionRail
          items={model.attention}
          height={full ? null : frameHeight}
          projectId={projectId}
        />
      </div>
      <p id={summaryId} className="sr-only">
        {`${model.counts.people} people, ${model.counts.changes} changes, ${model.counts.tasks} tasks, ${model.counts.running} running. ${model.attention.length} items need attention. On the timeline, press plus or minus to zoom, 0 to fit, End to go to now.`}
      </p>
      <Legend truncated={eventsTruncated} />
    </div>
  );
}
TimelineBody.displayName = "TimelineBody";

/* ------------------------------------------------------------------------------------------ */
/* Toolbar, legend                                                                             */
/* ------------------------------------------------------------------------------------------ */

function Toolbar({
  pxLabel,
  atFit,
  atMax,
  live,
  onZoomIn,
  onZoomOut,
  onFit,
  onNow,
  full,
  onFullScreen,
}: {
  pxLabel: string;
  atFit: boolean;
  atMax: boolean;
  live: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onNow: () => void;
  full: boolean;
  onFullScreen: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex items-center gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          shape="square"
          icon={<MagnifyingGlassMinus size={16} aria-hidden />}
          aria-label="Zoom out"
          title={atFit ? "The whole timeline is shown" : "Zoom out (-)"}
          disabled={atFit}
          onClick={onZoomOut}
        />
        <Button
          variant="secondary"
          size="sm"
          shape="square"
          icon={<MagnifyingGlassPlus size={16} aria-hidden />}
          aria-label="Zoom in"
          title={atMax ? "Closest zoom: 100 px per 5 s" : "Zoom in (+)"}
          disabled={atMax}
          onClick={onZoomIn}
        />
        <span className="min-w-[13ch] font-mono text-[11px] text-kumo-subtle tabular-nums">
          {pxLabel}
          {atMax ? " · closest zoom" : ""}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          icon={<ArrowsOutLineHorizontal size={16} aria-hidden />}
          aria-pressed={atFit}
          title="Fit the whole timeline (0)"
          onClick={onFit}
        >
          Fit
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<ArrowLineRight size={16} aria-hidden />}
          title={live ? "Scroll to now (End)" : "Scroll to the latest activity (End)"}
          onClick={onNow}
        >
          {live ? "Now" : "Latest"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={full ? <ArrowsIn size={16} aria-hidden /> : <ArrowsOut size={16} aria-hidden />}
          aria-pressed={full}
          title={full ? "Exit full screen (Esc)" : "Show the timeline on the whole screen"}
          onClick={onFullScreen}
        >
          {full ? "Exit full screen" : "Full screen"}
        </Button>
      </div>
      <p className="text-[11px] text-kumo-subtle">
        Ctrl or pinch with the wheel zooms at the pointer.
      </p>
    </div>
  );
}
Toolbar.displayName = "Toolbar";

function Legend({ truncated }: { truncated: boolean }) {
  const bars: BarStatus[] = ["running", "completed", "failed", "cancelled"];
  const head = "w-[92px] shrink-0 font-semibold text-kumo-default";
  return (
    <div className="grid gap-1.5 text-[11px] text-kumo-subtle">
      <div className="flex gap-2">
        <span className={head}>Change markers</span>
        <ul aria-label="Change markers" className="flex flex-wrap gap-x-4 gap-y-1">
          {MARKER_LEGEND.map((m) => (
            <li key={m.kind} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={cn("inline-block size-2.5", MARKER_STYLE[m.kind])} />
              {m.label}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex gap-2">
        <span className={head}>Task attempts</span>
        <ul aria-label="Task attempt bars" className="flex flex-wrap gap-x-4 gap-y-1">
          {bars.map((s) => (
            <li key={s} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={cn("inline-block h-2.5 w-5", BAR_STYLE[s])} />
              {BAR_WORD[s]}
            </li>
          ))}
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden className="font-mono text-kumo-default">
              H S O
            </span>
            Haiku, Sonnet, Opus
          </li>
        </ul>
      </div>
      <p>Red marks only failures and rejections. Hover a marker or bar for its detail.</p>
      {truncated && (
        <p>Markers cover the newest 800 recorded events; older markers are not drawn.</p>
      )}
    </div>
  );
}
Legend.displayName = "Legend";

/* ------------------------------------------------------------------------------------------ */
/* Axis                                                                                        */
/* ------------------------------------------------------------------------------------------ */

function Axis({
  ticks,
  x,
  plotWidth,
  promotions,
  nowX,
}: {
  ticks: { t: number; seconds: boolean; day: string | null }[];
  x: (t: number) => number;
  plotWidth: number;
  promotions: TimelineMarker[];
  nowX: number | null;
}) {
  return (
    <div
      className="sticky top-0 z-20 flex border-b-2 border-kumo-divider bg-kumo-elevated"
      style={{ height: AXIS_H }}
    >
      <div
        className="sticky left-0 z-30 flex shrink-0 items-end border-r border-kumo-rule bg-kumo-elevated px-3 pb-1.5 text-[11px] text-kumo-subtle"
        style={{ width: LEFT }}
      >
        Person · change · task and agent
      </div>
      <div aria-hidden className="relative shrink-0 overflow-hidden" style={{ width: plotWidth }}>
        {ticks.map((tick) => (
          <div
            key={tick.t}
            className="absolute bottom-0 border-l border-kumo-rule pb-1 pl-1 font-mono text-[10px] leading-[12px] whitespace-nowrap text-kumo-subtle tabular-nums"
            style={{ left: x(tick.t), top: 18 }}
          >
            <div>{clockOf(tick.t, tick.seconds)}</div>
            {tick.day && <div>{tick.day}</div>}
          </div>
        ))}
        {promotions.map((m) => (
          <span
            key={m.key}
            className="absolute top-1 bg-kumo-elevated px-0.5 font-mono text-[10px] leading-[14px] font-semibold whitespace-nowrap text-kumo-success"
            style={{ left: x(m.at) + 2 }}
          >
            {m.label}
          </span>
        ))}
        {nowX !== null && (
          <span
            className="absolute bottom-0 bg-kumo-ink px-1 font-mono text-[10px] leading-[14px] text-kumo-inverse"
            style={{ left: Math.max(0, Math.min(nowX - 1, plotWidth - 32)) }}
          >
            now
          </span>
        )}
      </div>
    </div>
  );
}
Axis.displayName = "Axis";

/* ------------------------------------------------------------------------------------------ */
/* Rows                                                                                        */
/* ------------------------------------------------------------------------------------------ */

type TipApi = ReturnType<typeof useTooltip>;
type TipFor = {
  bar: (task: TimelineTask, bar: TimelineBar) => ReactNode[];
  marker: (m: TimelineMarker) => ReactNode[];
};

const leftCell =
  "sticky left-0 z-10 flex shrink-0 border-r border-kumo-rule bg-kumo-elevated text-left";

function RowView({
  row,
  x,
  now,
  plotWidth,
  onToggle,
  tip,
  tipFor,
}: {
  row: Row;
  x: (t: number) => number;
  now: number;
  plotWidth: number;
  onToggle: (id: string) => void;
  tip: TipApi;
  tipFor: TipFor;
}) {
  const style = { top: AXIS_H + row.y, height: row.h, width: LEFT + plotWidth };
  if (row.kind === "person") {
    const p = row.person;
    const tasks = p.changes.reduce((sum, ch) => sum + ch.tasks.length, 0);
    return (
      <div
        className={cn("absolute left-0 flex", row.y > 0 && "border-t-2 border-kumo-divider")}
        style={style}
      >
        <div className={cn(leftCell, "items-center gap-2 px-3")} style={{ width: LEFT }}>
          <span
            aria-hidden
            className="grid size-5 shrink-0 place-items-center bg-tone-300 text-[10px] font-extrabold"
          >
            {p.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 truncate text-[13px] font-extrabold" title={p.name}>
            {p.name}
          </span>
          {p.isYou && <Tag variant="neutral">You</Tag>}
          {p.isOwner && <Tag variant="neutral">Owner</Tag>}
          <span
            className="ml-auto shrink-0 font-mono text-[11px] text-kumo-subtle tabular-nums"
            title={`${p.changes.length} changes · ${tasks} tasks`}
          >
            {p.changes.length} · {tasks}
          </span>
        </div>
        <div className="relative flex-1 bg-kumo-faint" />
      </div>
    );
  }
  if (row.kind === "note") {
    return (
      <div className="absolute left-0 flex border-b border-kumo-rule" style={style}>
        <div
          className={cn(
            leftCell,
            "items-center pl-12 text-[12px]",
            row.danger ? "text-kumo-danger" : "text-kumo-subtle",
          )}
          style={{ width: LEFT }}
        >
          {row.text}
        </div>
      </div>
    );
  }
  if (row.kind === "change") {
    return (
      <ChangeRow
        change={row.change}
        collapsed={row.collapsed}
        style={style}
        x={x}
        now={now}
        onToggle={onToggle}
        tip={tip}
        tipFor={tipFor}
      />
    );
  }
  return (
    <TaskRow
      task={row.task}
      change={row.change}
      style={style}
      x={x}
      now={now}
      tip={tip}
      tipFor={tipFor}
    />
  );
}
RowView.displayName = "RowView";

function ChangeRow({
  change,
  collapsed,
  style,
  x,
  now,
  onToggle,
  tip,
  tipFor,
}: {
  change: TimelineChange;
  collapsed: boolean;
  style: { top: number; height: number; width: number };
  x: (t: number) => number;
  now: number;
  onToggle: (id: string) => void;
  tip: TipApi;
  tipFor: TipFor;
}) {
  const x0 = x(change.start);
  const x1 = x(change.end ?? now);
  const live = change.end === null;
  const lineY = 30;
  // Labels sit right of their square while they do not run into the next marker. Squares never
  // overlap, so each marker keeps its own hover target.
  const placed = useMemo(() => {
    const out: { m: TimelineMarker; left: number; label: boolean }[] = [];
    const xs = change.markers.map((m) => x(m.at));
    let lastRight = Number.NEGATIVE_INFINITY;
    change.markers.forEach((m, i) => {
      const left = Math.max((xs[i] ?? 0) - 5, lastRight + 2);
      const next = xs[i + 1] ?? Number.POSITIVE_INFINITY;
      const width = Math.ceil(m.label.length * 6.1) + 6;
      const label = left + 12 + width < next - 6;
      out.push({ m, left, label });
      lastRight = left + 10 + (label ? width + 2 : 0);
    });
    return out;
  }, [change.markers, x]);
  return (
    <div className="group absolute left-0 flex border-b border-kumo-rule" style={style}>
      <div className={cn(leftCell, "items-center gap-1.5 pr-3 pl-3")} style={{ width: LEFT }}>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Show" : "Hide"} the Tasks of ${truncate(change.goal, 60)}`}
          title={collapsed ? "Show Tasks" : "Hide Tasks"}
          onClick={() => onToggle(change.id)}
          className="grid size-6 shrink-0 place-items-center hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-accent-500 pointer-coarse:size-11"
        >
          {collapsed ? <CaretRight size={14} aria-hidden /> : <CaretDown size={14} aria-hidden />}
        </button>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <Link
            to="/changes/$changeId"
            params={{ changeId: change.id }}
            title={change.goal}
            className="truncate text-[13px] font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-accent-500"
          >
            {change.goal}
          </Link>
          <span className="flex min-w-0 items-center gap-1.5">
            <ChangeStatusPill status={change.status} />
            <span className="truncate font-mono text-[10px] text-kumo-subtle tabular-nums">
              {spanText(change.start, change.end ?? now)}
            </span>
          </span>
        </span>
      </div>
      <div className="relative flex-1">
        <div
          aria-hidden
          className={cn(
            "absolute h-0.5",
            live
              ? "bg-kumo-ink transition-[width] duration-1000 ease-linear motion-reduce:transition-none"
              : "bg-tone-400",
          )}
          style={{ left: x0, top: lineY, width: Math.max(2, x1 - x0) }}
        />
        {collapsed &&
          change.tasks.flatMap((t) =>
            t.bars.map((b) => (
              <span
                key={b.key}
                aria-hidden
                onPointerEnter={(e) => tip.show(e.currentTarget, tipFor.bar(t, b))}
                onPointerLeave={tip.hide}
                // The 6px bar takes pointer hits 6px above and below it.
                className={cn(
                  "absolute h-1.5 before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']",
                  BAR_STYLE[b.status],
                  "border-0",
                )}
                style={{
                  left: x(b.start),
                  top: lineY + 6,
                  width: Math.max(2, x(b.end ?? now) - x(b.start)),
                }}
              />
            )),
          )}
        {placed.map(({ m, left, label }) => (
          <Link
            key={m.key}
            {...(m.candidateId
              ? { to: "/candidates/$candidateId", params: { candidateId: m.candidateId } }
              : { to: "/changes/$changeId", params: { changeId: m.changeId } })}
            aria-label={`${m.label}, ${clockOf(m.at, true)}: ${m.detail}`}
            onPointerEnter={(e) => tip.show(e.currentTarget, tipFor.marker(m))}
            onPointerLeave={tip.hide}
            onFocus={(e) => tip.show(e.currentTarget, tipFor.marker(m), true)}
            onBlur={tip.hide}
            className="absolute z-[6] flex min-w-3 flex-col items-start justify-end gap-1 focus-visible:outline-2 focus-visible:outline-accent-500"
            style={{ left, top: MARKER_TOP, height: lineY + 5 - MARKER_TOP }}
          >
            {label && (
              <span
                aria-hidden
                className={cn(
                  "font-mono text-[10px] leading-[10px] whitespace-nowrap text-kumo-default",
                  MARKER_TEXT[m.kind],
                )}
              >
                {m.label}
              </span>
            )}
            <span aria-hidden className={cn("block size-2.5 shrink-0", MARKER_STYLE[m.kind])} />
          </Link>
        ))}
      </div>
    </div>
  );
}
ChangeRow.displayName = "ChangeRow";

function TaskRow({
  task,
  change,
  style,
  x,
  now,
  tip,
  tipFor,
}: {
  task: TimelineTask;
  change: TimelineChange;
  style: { top: number; height: number; width: number };
  x: (t: number) => number;
  now: number;
  tip: TipApi;
  tipFor: TipFor;
}) {
  const last = task.bars.at(-1);
  const view = statusView(task.status);
  const label = `${task.key} ${task.title}, agent ${task.agentId ?? "not assigned"}, ${view.label}${
    last
      ? `, latest attempt ${last.attempt} on ${TIER_WORD[last.tier]}, ${BAR_WORD[last.status]}, ${spanText(last.start, last.end ?? now)}`
      : ", not started"
  }. Opens the Change.`;
  return (
    <Link
      to="/changes/$changeId"
      params={{ changeId: change.id }}
      aria-label={label}
      onFocus={(e) => {
        const bar = last ? e.currentTarget.querySelector(`[data-bar="${last.key}"]`) : null;
        if (bar && last) tip.show(bar, tipFor.bar(task, last), true);
      }}
      onBlur={tip.hide}
      className="group absolute left-0 flex border-b border-kumo-rule hover:bg-kumo-row-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500"
      style={style}
    >
      <span
        className={cn(leftCell, "items-center gap-2 pr-3 pl-10 group-hover:bg-kumo-elevated")}
        style={{ width: LEFT }}
      >
        <span aria-hidden className={cn("size-2 shrink-0", FAMILY_FILL[view.family])} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-mono text-[11px] font-semibold">{task.key}</span>
            <span className="truncate text-[12px]" title={task.title}>
              {task.title}
            </span>
          </span>
          <span className="flex min-w-0 items-baseline gap-1.5 font-mono text-[10px] text-kumo-subtle">
            <span className="truncate" title={task.agentId ?? undefined}>
              {task.agentId ?? "no agent yet"}
            </span>
            {last && <span className="shrink-0">{TIER_WORD[last.tier]}</span>}
            <span className="ml-auto shrink-0">{view.label}</span>
          </span>
        </span>
      </span>
      <span aria-hidden className="relative block flex-1">
        {task.bars.length === 0 && (
          <span
            className="absolute font-mono text-[10px] text-kumo-subtle whitespace-nowrap"
            style={{ left: x(change.start) + 4, top: BAR_Y + 2 }}
          >
            {task.status === "cancelled" ? "Not run" : "Not started"}
          </span>
        )}
        {task.bars.map((bar) => {
          const x0 = x(bar.start);
          const width = Math.max(4, x(bar.end ?? now) - x0);
          const letter = TIER_LETTER[bar.tier];
          const inner =
            width >= 150
              ? `${letter} · ${bar.failureKind ?? `attempt ${bar.attempt}`} · ${spanText(bar.start, bar.end ?? now)}`
              : width >= 90
                ? `${letter} · ${bar.failureKind ?? spanText(bar.start, bar.end ?? now)}`
                : width >= 14
                  ? letter
                  : "";
          return (
            <span
              key={bar.key}
              data-bar={bar.key}
              onPointerEnter={(e) => tip.show(e.currentTarget, tipFor.bar(task, bar))}
              onPointerLeave={tip.hide}
              className={cn(
                "absolute flex items-center overflow-hidden px-1 font-mono text-[10px] leading-none font-semibold whitespace-nowrap",
                BAR_STYLE[bar.status],
                bar.status === "running" &&
                  "transition-[width] duration-1000 ease-linear motion-reduce:transition-none",
              )}
              style={{ left: x0, top: BAR_Y, width, height: BAR_H }}
            >
              {inner}
            </span>
          );
        })}
      </span>
    </Link>
  );
}
TaskRow.displayName = "TaskRow";

/* ------------------------------------------------------------------------------------------ */
/* Needs attention                                                                             */
/* ------------------------------------------------------------------------------------------ */

function AttentionRail({
  items,
  height,
  projectId,
}: {
  items: AttentionItem[];
  /** Height of the plot frame; null in full screen, where the rail fills its grid row. */
  height: number | null;
  projectId: string;
}) {
  return (
    <aside
      aria-label="Needs attention"
      className={cn(
        "order-first flex min-w-0 flex-col bg-kumo-elevated @min-[1040px]:order-none",
        height === null
          ? "max-h-[30vh] min-h-0 @min-[1040px]:max-h-none"
          : "@min-[1040px]:max-h-[var(--rh-rail-h)]",
      )}
      style={height === null ? undefined : ({ "--rh-rail-h": `${height + 2}px` } as CSSProperties)}
    >
      <div className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-b-2 border-kumo-divider px-3">
        <h3 className="type-h6">Needs attention</h3>
        <span
          className={cn(
            "font-mono text-[12px] font-semibold tabular-nums",
            items.length > 0 ? "text-accent-700" : "text-kumo-subtle",
          )}
        >
          {formatNumber(items.length)}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="px-3 py-3 text-[13px] text-kumo-subtle">
          Nothing waits on a person. Questions, approvals, blocks and failed commands appear here.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {items.map((item) => (
            <li key={item.key} className="border-b border-kumo-rule">
              {item.changeId ? (
                <Link
                  to="/changes/$changeId"
                  params={{ changeId: item.changeId }}
                  className="block px-3 py-2 hover:bg-kumo-row-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500"
                >
                  <AttentionBody item={item} />
                </Link>
              ) : (
                <Link
                  to="/projects/$projectId"
                  params={{ projectId }}
                  hash="operator-actions"
                  className="block px-3 py-2 hover:bg-kumo-row-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500"
                >
                  <AttentionBody item={item} />
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
AttentionRail.displayName = "AttentionRail";

function AttentionBody({ item }: { item: AttentionItem }) {
  const urgent = item.kind === "dead_letter";
  return (
    <span className="grid gap-0.5">
      <span className="flex items-baseline justify-between gap-2">
        <span
          className={cn(
            "type-kicker",
            urgent
              ? "text-accent-700"
              : item.kind === "clarify" || item.kind === "approval" || item.kind === "conflict"
                ? "text-kumo-warning"
                : "text-kumo-subtle",
          )}
        >
          {ATTENTION_KICKER[item.kind]}
        </span>
        {item.at !== null && (
          <span className="font-mono text-[10px] text-kumo-subtle tabular-nums">
            {formatAge(new Date(item.at).toISOString())}
          </span>
        )}
      </span>
      <span className="text-[13px] font-semibold">{item.title}</span>
      <span className="line-clamp-2 text-[12px] text-kumo-subtle">{item.detail}</span>
    </span>
  );
}
AttentionBody.displayName = "AttentionBody";
