// biome-ignore-all lint/a11y/useFocusableInteractive: listbox options here are aria-activedescendant items of a one-tab-stop composite (use-roving-focus.ts); they are not focusable by design
import { cn } from "@cloudflare/kumo";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { create } from "zustand";
import { usePrefersReducedMotion } from "../../../../lib/motion";
import { displayTimeZone } from "../../../../lib/render-time";
import { useFlight } from "../../flight-context";
import { type EntityRef, useFlightStore, useSelection } from "../../flight-store";
import { EntityHover } from "../../hover-preview";
import { ROVING_CONTAINER, ROVING_ITEM, useRovingFocus } from "../../use-roving-focus";

/**
 * Shared time axis of the agent swimlanes and the workspace lanes (DESIGN.md 9.8, 11.1). Both
 * panels use the same scale function and the same zoom, so a fact sits at the same x in both.
 *
 *   const scroller = useMeasuredScroller();      // <div ref={scroller.ref}>
 *   const scale = useTimeScale(scroller.width);
 *   scale.x(task.startedAt)   // px inside the plot (right of the sticky left column)
 *
 * The axis runs from the first recorded fact to the end of the recorded span (live: the instant
 * the model was derived, which advances on every refetch). The fold cursor sits at the fold
 * instant; nothing after it is drawn (the fold already excludes later facts).
 */

/** Sticky left column width, axis height and plot padding, in px. */
export const LEFT = 220;
export const AXIS_H = 44;
const PAD_L = 12;
const PAD_R = 48;

type Zoom = "fit" | "1m" | "5m";
const ZOOMS: { id: Zoom; label: string; title: string }[] = [
  { id: "fit", label: "Fit", title: "Fit the whole Change in the panel" },
  { id: "1m", label: "1 min", title: "1 minute per 100 px" },
  { id: "5m", label: "5 min", title: "5 minutes per 100 px" },
];
const MS_PER_100PX: Record<Exclude<Zoom, "fit">, number> = { "1m": 60_000, "5m": 300_000 };

/** One zoom for both time panels, so their axes line up. */
const useZoomStore = create<{ zoom: Zoom; setZoom: (zoom: Zoom) => void }>()((set) => ({
  zoom: "fit",
  setZoom: (zoom) => set({ zoom }),
}));

/** Wall-clock "now" that ticks once a second while `enabled` (elapsed readouts, live edge). */
function useNow(enabled: boolean) {
  // 0 until mounted: the first client render matches the server render (no wall clock in it).
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/**
 * The instant elapsed readouts count to. Historical: the fold instant. Live with a running
 * attempt: the fold instant plus the wall time since that fold arrived, so "elapsed" ticks each
 * second without reading absolute wall-clock time into a fact (the fold instant stays `state.at`).
 */
export function useLiveInstant(): number {
  const { state } = useFlight();
  const ticking = state.live && state.counts.running > 0;
  const now = useNow(ticking);
  const [anchor, setAnchor] = useState<{ at: number; wall: number }>({ at: state.at, wall: 0 });
  useEffect(() => {
    setAnchor({ at: state.at, wall: Date.now() });
  }, [state.at]);
  if (!ticking || anchor.wall === 0 || now === 0 || anchor.at !== state.at) return state.at;
  return state.at + Math.max(0, now - anchor.wall);
}

/**
 * Callback ref plus the element's client width, kept current with a ResizeObserver. A callback
 * ref (not a RefObject) so the width is measured when the element mounts after a skeleton.
 */
export function useMeasuredScroller() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
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

const TICK_STEPS = [
  5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000,
  7_200_000,
];

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `T+01:30`, `T+1:02:05` relative to the first fact. */
export function relTime(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `T+${h}:${pad2(m)}:${pad2(s % 60)}` : `T+${pad2(m)}:${pad2(s % 60)}`;
}

/**
 * 24-hour clock formatter in the viewer's zone (lib/render-time.ts): the server render and the
 * hydration print the same time, so a clock never causes a hydration mismatch.
 */
export function useClock(): (ms: number) => string {
  return useCallback((ms: number) => {
    const timeZone = displayTimeZone();
    return new Date(ms).toLocaleTimeString("en-GB", {
      hour12: false,
      ...(timeZone ? { timeZone } : {}),
    });
  }, []);
}

export type TimeScale = {
  start: number;
  end: number;
  /** The fold instant (`state.at`). Facts are drawn up to here and never past it. */
  cursor: number;
  /** Plot width in px (excludes the left column). */
  width: number;
  x: (t: number) => number;
  ticks: { t: number; x: number }[];
  zoom: Zoom;
  /** True while an attempt runs in the live fold. */
  ticking: boolean;
};

export function useTimeScale(viewportWidth: number): TimeScale {
  const { state, model } = useFlight();
  const zoom = useZoomStore((s) => s.zoom);
  const ticking = state.live && state.counts.running > 0;
  const cursor = state.at;
  const start = model.bounds.start;
  const end = Math.max(model.bounds.end, cursor, start + 1_000);

  return useMemo(() => {
    const span = end - start;
    const available = Math.max(240, viewportWidth - LEFT - PAD_L - PAD_R);
    const pxPerMs = zoom === "fit" ? available / span : 100 / MS_PER_100PX[zoom];
    const width = Math.max(available, span * pxPerMs) + PAD_L + PAD_R;
    const x = (t: number) => PAD_L + (Math.min(Math.max(t, start), end) - start) * pxPerMs;
    const step = TICK_STEPS.find((s) => s * pxPerMs >= 96) ?? TICK_STEPS[TICK_STEPS.length - 1];
    const ticks: { t: number; x: number }[] = [];
    if (step) for (let t = start; t <= end; t += step) ticks.push({ t, x: x(t) });
    return { start, end, cursor, width, x, ticks, zoom, ticking };
  }, [start, end, cursor, viewportWidth, zoom, ticking]);
}

/**
 * Keeps the right edge of a horizontally scrolled plot at "now" while `follow` is on and the fold
 * is live. Scrolling away from the edge turns following off; the toolbar button turns it back on.
 */
export function useFollowLive(
  el: HTMLElement | null,
  live: boolean,
  width: number,
): { follow: boolean; setFollow: (follow: boolean) => void; onScroll: () => void } {
  const [follow, setFollow] = useState(true);
  const programmatic = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin when the plot grows
  useLayoutEffect(() => {
    if (!el || !follow || !live) return;
    if (el.scrollWidth <= el.clientWidth) return;
    programmatic.current = true;
    el.scrollLeft = el.scrollWidth;
  }, [el, follow, live, width]);
  const onScroll = () => {
    if (!el) return;
    if (programmatic.current) {
      programmatic.current = false;
      return;
    }
    const atEdge = el.scrollLeft + el.clientWidth >= el.scrollWidth - 16;
    if (follow && !atEdge) setFollow(false);
  };
  return { follow, setFollow, onScroll };
}

/** Zoom and follow-live controls above a time panel. */
export function TimelineToolbar({
  summary,
  live,
  follow,
  onFollow,
}: {
  summary: ReactNode;
  live: boolean;
  follow: boolean;
  onFollow: () => void;
}) {
  const zoom = useZoomStore((s) => s.zoom);
  const setZoom = useZoomStore((s) => s.setZoom);
  return (
    <div className="flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-kumo-rule px-3 py-1">
      <p className="min-w-0 truncate text-[12px] text-kumo-subtle">{summary}</p>
      <div className="flex items-center gap-2">
        <fieldset className="flex items-center border border-kumo-rule">
          <legend className="sr-only">Time zoom</legend>
          {ZOOMS.map((z) => (
            <button
              key={z.id}
              type="button"
              aria-pressed={zoom === z.id}
              title={z.title}
              onClick={() => setZoom(z.id)}
              className={cn(
                "min-h-6 px-2 text-[11px] leading-none transition-colors duration-(--rh-dur-ui) pointer-coarse:min-h-11",
                zoom === z.id ? "bg-kumo-ink text-kumo-inverse" : "hover:bg-kumo-tint",
              )}
            >
              {z.label}
            </button>
          ))}
        </fieldset>
        {/* Following only means something in the live view; elsewhere the control is not shown. */}
        {live && (
          <button
            type="button"
            aria-pressed={follow}
            title="Keep the right edge at now"
            onClick={onFollow}
            className={cn(
              "inline-flex min-h-6 items-center gap-1.5 border px-2 text-[11px] leading-none transition-colors duration-(--rh-dur-ui) pointer-coarse:min-h-11",
              follow
                ? "border-kumo-ink bg-kumo-ink text-kumo-inverse"
                : "border-kumo-rule hover:bg-kumo-tint",
            )}
          >
            <span
              aria-hidden
              className={cn("size-1.5", follow ? "bg-kumo-success" : "bg-tone-400")}
            />
            Follow live
          </button>
        )}
      </div>
    </div>
  );
}
TimelineToolbar.displayName = "TimelineToolbar";

export type AxisMark = {
  key: string;
  t: number;
  label: string;
  ref: EntityRef;
  tone: "ink" | "accent" | "danger" | "ok";
};

/** Milestones closer than this (px) share one group marker. */
const AXIS_GROUP = 14;
/** Side of a milestone square, in px. */
const MARK_SQ = 8;

const MARK_TEXT: Record<AxisMark["tone"], string> = {
  ink: "text-kumo-default",
  accent: "text-kumo-accent",
  danger: "text-kumo-danger",
  ok: "text-kumo-success",
};

/**
 * Approximate rendered width of a 10px mono label: 6.1px per ASCII character, 10px for other
 * glyphs (an arrow can come from a wider fallback font).
 */
export const labelWidth = (text: string) =>
  Math.ceil([...text].reduce((w, ch) => w + ((ch.codePointAt(0) ?? 0) > 0x7f ? 10 : 6.1), 0)) + 6;

/** A horizontal span `[left, right]` in plot px that one text row already uses. */
export type Span = { left: number; right: number; owner?: string };

/** Clear space kept between two spans of one row, in px. */
const SPAN_GAP = 3;

/**
 * Collision-aware label slot in one text row. Tries the full label right of the anchor, then left
 * of it, then the widest free run (at least `min` px, shown truncated with an ellipsis) right and
 * then left. Spans of `owner` itself do not block. Returns null when the row has no room: the
 * caller omits the text and keeps the full text in the title.
 */
export function placeLabel({
  anchor,
  gap,
  width,
  min = 40,
  plot,
  taken,
  owner,
}: {
  anchor: number;
  gap: number;
  width: number;
  min?: number;
  plot: number;
  taken: readonly Span[];
  owner?: string;
}): { left: number; width: number; side: "right" | "left" } | null {
  const others = taken.filter((s) => owner === undefined || s.owner !== owner);
  const free = (l: number, r: number) =>
    l >= 0 && r <= plot && others.every((s) => r + SPAN_GAP <= s.left || l >= s.right + SPAN_GAP);
  const rightStart = anchor + gap;
  const leftEnd = anchor - gap;
  if (free(rightStart, rightStart + width)) return { left: rightStart, width, side: "right" };
  if (free(leftEnd - width, leftEnd)) return { left: leftEnd - width, width, side: "left" };
  // Truncated: the run up to the nearest obstacle (or the plot edge).
  if (free(rightStart, rightStart + min)) {
    const limit = Math.min(
      plot,
      ...others.filter((s) => s.left >= rightStart).map((s) => s.left - SPAN_GAP),
    );
    const w = Math.min(width, limit - rightStart);
    if (w >= min) return { left: rightStart, width: w, side: "right" };
  }
  if (free(leftEnd - min, leftEnd)) {
    const limit = Math.max(
      0,
      ...others.filter((s) => s.right <= leftEnd).map((s) => s.right + SPAN_GAP),
    );
    const w = Math.min(width, leftEnd - limit);
    if (w >= min) return { left: leftEnd - w, width: w, side: "left" };
  }
  return null;
}

/**
 * Groups items whose x lies within `within` px of the first item of the group (time order), so
 * facts at the same or nearly the same instant become one group marker instead of a stack.
 */
export function clusterByX<T>(
  items: readonly T[],
  xOf: (item: T) => number,
  within: number,
): { x: number; items: T[] }[] {
  const groups: { x: number; items: T[] }[] = [];
  for (const item of [...items].sort((a, b) => xOf(a) - xOf(b))) {
    const x = xOf(item);
    const last = groups[groups.length - 1];
    if (last && x - last.x < within) last.items.push(item);
    else groups.push({ x, items: [item] });
  }
  return groups;
}

/** Width of a group count box (12px tall, 9px mono digits). */
export const countBoxWidth = (count: number) => Math.max(12, String(count).length * 6 + 4);

/**
 * Next member of a group to select: the one after the selected member, or the first. Activating a
 * group marker steps through its facts.
 */
export function nextInGroup(
  refs: readonly EntityRef[],
  selection: EntityRef | null,
): EntityRef | null {
  const i = selection
    ? refs.findIndex((r) => r.kind === selection.kind && r.id === selection.id)
    : -1;
  return refs[(i + 1) % refs.length] ?? null;
}

/**
 * Sticky axis row: a corner cell over the left column, milestone labels in the top band and mono
 * ticks (T+mm:ss over the clock) in the bottom band, plus the cursor label. The milestones are one
 * tab stop (a listbox over the whole axis, use-roving-focus.ts): arrows walk them in time order,
 * Down enters the lanes, and a pointer anywhere on the axis picks the nearest milestone.
 */
export function TimeAxis({
  scale,
  corner,
  marks = [],
  live,
}: {
  scale: TimeScale;
  corner: ReactNode;
  marks?: AxisMark[];
  live: boolean;
}) {
  const clockOf = useClock();
  // Milestones within AXIS_GROUP px collapse into one group marker with a count. Every marker
  // keeps its anchor span in the top band, so labels never cover another marker. Labels are placed
  // by priority (promotion, then verdicts, then the rest) right of the rule, else left, else
  // truncated in the widest free run; a milestone with no room shows an 8px square. All of it sits
  // in the top band, clear of the tick labels, and inside the plot.
  const slots = useMemo(() => {
    const rank: Record<AxisMark["tone"], number> = { accent: 0, danger: 1, ok: 1, ink: 2 };
    const groups = clusterByX(marks, (m) => scale.x(m.t), AXIS_GROUP).map((g) => {
      const members = [...g.items].sort((a, b) => rank[a.tone] - rank[b.tone] || a.t - b.t);
      const first = members[0] as AxisMark;
      const count = members.length;
      const box = count > 1 ? countBoxWidth(count) : MARK_SQ;
      return {
        key: count > 1 ? `group:${g.items[0]?.key}` : first.key,
        x: g.x,
        members,
        tone: first.tone,
        box,
        text: count > 1 ? `${count} milestones` : first.label,
      };
    });
    const taken: Span[] = groups.map((g) => ({
      left: g.x - g.box / 2,
      right: g.x + g.box / 2,
      owner: g.key,
    }));
    const labels = new Map<string, ReturnType<typeof placeLabel>>();
    for (const g of [...groups].sort(
      (a, b) => rank[a.tone] - rank[b.tone] || a.members.length - b.members.length || a.x - b.x,
    )) {
      const single = g.members.length === 1;
      const label = placeLabel({
        anchor: g.x,
        gap: single ? 3 : g.box / 2 + 3,
        width: labelWidth(single ? g.text : "milestones"),
        // A group word is never cut: it shows whole or the count box stands alone.
        min: single ? 40 : labelWidth("milestones"),
        plot: scale.width,
        taken,
        owner: g.key,
      });
      if (label) taken.push({ left: label.left, right: label.left + label.width, owner: g.key });
      labels.set(g.key, label);
    }
    return groups.map((g) => ({ ...g, label: labels.get(g.key) ?? null }));
  }, [marks, scale]);
  const selection = useSelection();
  const rows = useMemo(() => [slots.map((m) => m.key)], [slots]);
  const roving = useRovingFocus({
    rows,
    group: "agent-lanes",
    onActivate: (key) => {
      const slot = slots.find((m) => m.key === key);
      if (!slot) return;
      const refs = slot.members.map((m) => m.ref);
      const store = useFlightStore.getState();
      if (refs.length === 1 && refs[0]) store.toggle(refs[0]);
      else store.select(nextInGroup(refs, store.selection));
    },
  });
  const cursorX = scale.x(scale.cursor);
  return (
    <div
      className="sticky top-0 z-20 flex border-b-2 border-kumo-divider bg-kumo-elevated"
      style={{ height: AXIS_H }}
    >
      <div
        className="sticky left-0 z-30 flex shrink-0 items-end border-r border-kumo-rule bg-kumo-elevated px-3 pb-1.5 text-[11px] text-kumo-subtle"
        style={{ width: LEFT }}
      >
        {corner}
      </div>
      <div className="relative shrink-0 overflow-hidden" style={{ width: scale.width }}>
        {scale.ticks.map((tick) => (
          <div
            key={tick.t}
            aria-hidden
            className="absolute border-l border-kumo-rule pb-1 pl-1 font-mono text-[10px] leading-[12px] whitespace-nowrap text-kumo-subtle tabular-nums"
            style={{ left: tick.x, top: 18 }}
          >
            <div>{relTime(tick.t - scale.start)}</div>
            <div>{clockOf(tick.t)}</div>
          </div>
        ))}
        {slots.length > 0 && (
          <div
            role="listbox"
            aria-orientation="horizontal"
            aria-label="Candidate milestones"
            {...roving.containerProps}
            className={cn("absolute inset-0", ROVING_CONTAINER)}
          >
            {slots.map((m) => {
              const isSelected =
                selection !== null &&
                m.members.some((x) => x.ref.kind === selection.kind && x.ref.id === selection.id);
              const title = m.members
                .map((x) => `${x.label} · ${clockOf(x.t)} · ${relTime(x.t - scale.start)}`)
                .join("\n");
              if (m.members.length > 1) {
                const label = m.label;
                return (
                  <div
                    key={m.key}
                    role="option"
                    aria-selected={isSelected}
                    {...roving.itemProps(m.key)}
                    title={`${m.text}\n${title}`}
                    className={cn(
                      "absolute flex items-center gap-[3px] font-mono text-[10px] leading-[14px] font-semibold whitespace-nowrap data-[hot]:bg-kumo-tint",
                      ROVING_ITEM,
                      MARK_TEXT[m.tone],
                    )}
                    style={{
                      left: label?.side === "left" ? label.left : m.x - m.box / 2,
                      top: 2,
                      flexDirection: label?.side === "left" ? "row-reverse" : "row",
                      scrollMarginLeft: LEFT + 8,
                    }}
                  >
                    <span
                      aria-hidden
                      className="grid h-3 shrink-0 place-items-center bg-kumo-ink font-mono text-[9px] leading-none text-kumo-inverse tabular-nums"
                      style={{ width: m.box }}
                    >
                      {m.members.length}
                    </span>
                    {label && (
                      <span aria-hidden className="block truncate" style={{ width: label.width }}>
                        milestones
                      </span>
                    )}
                    <span className="sr-only">
                      {m.text}: {m.members.map((x) => `${x.label}, ${clockOf(x.t)}`).join("; ")}
                    </span>
                  </div>
                );
              }
              const only = m.members[0] as AxisMark;
              const label = m.label;
              return (
                <EntityHover key={m.key} entity={only.ref} show={roving.show(m.key)}>
                  <div
                    role="option"
                    aria-selected={isSelected}
                    {...roving.itemProps(m.key)}
                    title={title}
                    className={cn(
                      "absolute block truncate px-0.5 font-mono text-[10px] leading-[14px] font-semibold whitespace-nowrap data-[hot]:bg-kumo-tint",
                      ROVING_ITEM,
                      MARK_TEXT[m.tone],
                    )}
                    // No room for the label: an 8px square on its rule, in the top band.
                    style={
                      label
                        ? {
                            left: label.left,
                            top: 2,
                            width: label.width,
                            scrollMarginLeft: LEFT + 8,
                          }
                        : { left: m.x - MARK_SQ / 2 - 2, top: 2, scrollMarginLeft: LEFT + 8 }
                    }
                  >
                    {label ? (
                      only.label
                    ) : (
                      <>
                        <span aria-hidden className="my-[3px] block size-2 bg-current" />
                        <span className="sr-only">{only.label}</span>
                      </>
                    )}
                    <span className="sr-only">, {clockOf(only.t)}</span>
                  </div>
                </EntityHover>
              );
            })}
          </div>
        )}
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-0 h-3 w-0.5 bg-kumo-ink"
          style={{ left: cursorX - 1 }}
        />
        <span
          className="pointer-events-none absolute bottom-3 bg-kumo-ink px-1 font-mono text-[10px] leading-[12px] whitespace-nowrap text-kumo-inverse tabular-nums"
          style={{ left: Math.max(0, Math.min(cursorX - 1, scale.width - 64)) }}
        >
          {live ? "now" : clockOf(scale.cursor)}
        </span>
      </div>
    </div>
  );
}
TimeAxis.displayName = "TimeAxis";

/** Full-height rules under the rows: candidate milestones (1px divider) and the fold cursor. */
export function PlotRules({
  scale,
  height,
  milestones,
}: {
  scale: TimeScale;
  height: number;
  milestones: number[];
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-[4]"
      style={{ left: LEFT, top: AXIS_H, width: scale.width, height }}
    >
      {[...new Set(milestones)].map((t) => (
        <div
          key={t}
          className="absolute top-0 bottom-0 border-l border-dashed border-kumo-divider"
          style={{ left: scale.x(t) }}
        />
      ))}
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-kumo-ink"
        style={{ left: scale.x(scale.cursor) - 1 }}
      />
    </div>
  );
}
PlotRules.displayName = "PlotRules";

/**
 * Plays a 180ms ease-out scale and fade once when an element mounts for a fact that newly
 * played (`animated`). Settled facts mount without motion. Reduced motion: no animation.
 */
export function useEnter<T extends HTMLElement | SVGElement>(play: boolean) {
  const ref = useRef<T>(null);
  const reduce = usePrefersReducedMotion();
  // biome-ignore lint/correctness/useExhaustiveDependencies: plays once, on mount
  useEffect(() => {
    const el = ref.current;
    if (!play || reduce || !el || typeof el.animate !== "function") return;
    const token = Number.parseFloat(
      getComputedStyle(el).getPropertyValue("--rh-dur-ui-slow") || "180",
    );
    el.animate(
      [
        { opacity: 0, transform: "scale(0.4)" },
        { opacity: 1, transform: "scale(1)" },
      ],
      { duration: Number.isNaN(token) ? 180 : token, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
  }, []);
  return ref;
}
