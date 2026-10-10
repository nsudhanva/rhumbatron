import { buttonVariants, cn } from "@cloudflare/kumo";
import { ArrowLeft, Columns } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import {
  type ComponentType,
  type CSSProperties,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatNumber, formatUsd, generation, generationCode, truncate } from "../../lib/format";
import type { LiveStatus } from "../../lib/live";
import type { ActivityEvent } from "../agents/activity-model";
import { StatusPill } from "../ui/status-pill";
import { Tag } from "../ui/tag";
import { FiltersBar } from "./filters-bar";
import { type FlightContextValue, FlightProvider } from "./flight-context";
import { type FlightModel, type FlightState, foldFlight, providerName } from "./flight-model";
import { type PanelId, useFlightStore, useFlightTime } from "./flight-store";
import { InspectorDrawer } from "./inspector-drawer";
import { PanelFrame, PanelSkeleton } from "./panel-frame";
import type { PanelProps } from "./panel-types";
import { Scrubber, stepFact } from "./scrubber";

/**
 * Debug view (was Flight Control; AGENTS.md 38): every recorded fact of one Change, folded at one
 * instant and shown in synchronized panels. The page owns the fold, the time machine, filters,
 * the panel grid and the inspector. Panels read the folded state from context and never fetch.
 * Nothing moves on its own: live facts appear in place, and the time machine plays only when the
 * viewer presses Play.
 */

type Panel = LazyExoticComponent<ComponentType<PanelProps>>;
const panel = <K extends string>(
  load: () => Promise<Record<K, ComponentType<PanelProps>>>,
  name: K,
): Panel => lazy(() => load().then((m) => ({ default: m[name] })));

const DagPanel = panel(() => import("./panels/dag-panel"), "DagPanel");
const SwimlanesPanel = panel(() => import("./panels/swimlanes-panel"), "SwimlanesPanel");
const WorkspacePanel = panel(() => import("./panels/workspace-panel"), "WorkspacePanel");
const HeatmapPanel = panel(() => import("./panels/heatmap-panel"), "HeatmapPanel");
const ArenaPanel = panel(() => import("./panels/arena-panel"), "ArenaPanel");
const PreviewPanel = panel(() => import("./panels/preview-panel"), "PreviewPanel");
const EvidencePanel = panel(() => import("./panels/evidence-panel"), "EvidencePanel");
const DecisionsPanel = panel(() => import("./panels/decisions-panel"), "DecisionsPanel");
const EventsPanel = panel(() => import("./panels/events-panel"), "EventsPanel");
const CommandPalette = lazy(() =>
  import("./command-palette").then((m) => ({ default: m.CommandPalette })),
);

type PanelSpec = {
  id: PanelId;
  label: string;
  Component: Panel;
  /** Columns of the 6-column grid once the grid is at least 800px wide. */
  span: string;
  tall?: boolean;
  meta: (state: FlightState, model: FlightModel) => ReactNode;
};

const n = (value: number) => formatNumber(value);

/** Reading order = DOM order: the Work Graph, who works on it, where, then convergence. */
const PANELS: PanelSpec[] = [
  {
    id: "dag",
    label: "Execution DAG",
    Component: DagPanel,
    span: "@min-[800px]:col-span-6",
    tall: true,
    meta: (s) => `${n(s.counts.tasks)} Tasks · ${n(s.counts.blocked)} blocked`,
  },
  {
    id: "swimlanes",
    label: "Agent swimlanes",
    Component: SwimlanesPanel,
    span: "@min-[800px]:col-span-3 @min-[1100px]:col-span-4",
    meta: (s) => `${n(s.counts.woken)} woken · ${n(s.counts.running)} running`,
  },
  {
    id: "workspace",
    label: "Workspace lanes",
    Component: WorkspacePanel,
    span: "@min-[800px]:col-span-3 @min-[1100px]:col-span-2",
    meta: (s, m) =>
      `${n(Object.keys(m.forks).length)} forks · ${n(Object.values(s.tasks).reduce((sum, t) => sum + t.changeSets.length, 0))} ChangeSets`,
  },
  {
    id: "heatmap",
    label: "Codebase heatmap",
    Component: HeatmapPanel,
    span: "@min-[800px]:col-span-3",
    meta: (s) => `${n(s.counts.filesChanged)} files changed`,
  },
  {
    id: "arena",
    label: "Candidate arena",
    Component: ArenaPanel,
    span: "@min-[800px]:col-span-3",
    meta: (s) => `${n(s.counts.candidates)} Candidates`,
  },
  {
    id: "preview",
    label: "Preview wall",
    Component: PreviewPanel,
    span: "@min-[800px]:col-span-3",
    meta: (s) =>
      `${n(Object.values(s.candidates).reduce((sum, c) => sum + c.screenshots.reduce((k, x) => k + x.count, 0), 0))} screenshots`,
  },
  {
    id: "evidence",
    label: "Evidence explorer",
    Component: EvidencePanel,
    span: "@min-[800px]:col-span-3",
    meta: (s) =>
      `${n(Object.values(s.candidates).reduce((sum, c) => sum + c.evidence.length, 0))} records`,
  },
  {
    id: "decisions",
    label: "Decisions",
    Component: DecisionsPanel,
    span: "@min-[800px]:col-span-3",
    meta: (s) => `${n(s.decisions.length)} recorded`,
  },
  {
    id: "events",
    label: "Events",
    Component: EventsPanel,
    span: "@min-[800px]:col-span-3",
    meta: (s, m) => `${n(s.events.length)} / ${n(m.events.length)}`,
  },
];

/** Keys typed into a text field never drive the page. */
const TEXT_FIELD =
  'input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable="true"]';

function useFlightKeys(events: ActivityEvent[]) {
  const eventsRef = useRef(events);
  eventsRef.current = events;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const store = useFlightStore.getState();
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        store.setPaletteOpen(true);
        return;
      }
      if (e.defaultPrevented || store.paletteOpen || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('[role="dialog"], [role="alertdialog"]')) return;
      if (e.key === "Escape") {
        if (target?.closest(TEXT_FIELD)) return;
        if (store.selection) {
          store.select(null);
          store.setInspectorOpen(false);
        } else if (store.focus) {
          store.setFocus(null);
        } else return;
        e.preventDefault();
        return;
      }
      if (target?.closest(TEXT_FIELD)) return;
      if (e.key === "[" || e.key === "]") {
        const step = stepFact(eventsRef.current, store.time, e.key === "[" ? -1 : 1);
        if (step === null) return;
        e.preventDefault();
        if (step === "live") store.goLive();
        else store.scrubTo(step);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Measures the sticky chrome so a focused panel fills exactly what is left of the viewport. */
function useChromeHeight() {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeight(Math.round(entry.borderBoxSize[0]?.blockSize ?? el.offsetHeight));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, height };
}

function Count({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="inline-flex items-baseline gap-1.5">
      <dt className="text-[12px] text-kumo-subtle">{label}</dt>
      <dd
        className={cn(
          "font-mono text-[12px] font-semibold tabular-nums",
          danger && "text-kumo-danger",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
Count.displayName = "Count";

function HeaderStrip({
  state,
  model,
  socket,
  changeId,
  fixture,
  live,
}: {
  state: FlightState;
  model: FlightModel;
  socket: LiveStatus;
  changeId: string;
  fixture: boolean;
  live: boolean;
}) {
  const change = model.input.change;
  const providers = useMemo(() => {
    const names = new Set<string>();
    for (const t of Object.values(state.tasks)) {
      const name = providerName(t.running?.provider ?? null);
      if (name) names.add(name);
    }
    return [...names];
  }, [state.tasks]);
  const c = state.counts;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-kumo-rule px-3 py-2">
      <div className="flex min-w-0 flex-[1_1_320px] items-baseline gap-2">
        <h2 className="min-w-0 truncate text-[15px] font-semibold" title={change.goal}>
          {truncate(change.goal, 140)}
        </h2>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold tabular-nums">
          {generation(state.generation)}
        </span>
        <span className="font-mono text-[12px] text-kumo-subtle tabular-nums">
          {generationCode(state.generation)}
        </span>
        {live && <StatusPill status={change.status} />}
        {live && model.bounds.live && socket === "open" && <StatusPill status="live" />}
        {providers.map((p) => (
          <Tag key={p} variant="outline">
            {p}
          </Tag>
        ))}
        {fixture && <Tag variant="accent">Fixture</Tag>}
      </div>
      <dl className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Count label="Woken" value={`${n(c.woken)} / ${n(c.tasks)}`} />
        <Count label="Running" value={n(c.running)} />
        <Count label="Done" value={n(c.completed)} />
        <Count label="Failed" value={n(c.failed)} danger={c.failed > 0} />
        <Count label="Blocked" value={n(c.blocked)} />
        <Count label="Conflicts" value={n(c.openConflicts)} danger={c.openConflicts > 0} />
        <Count label="Candidates" value={n(c.candidates)} />
        <Count label="Files" value={n(c.filesChanged)} />
        <Count label="Calls" value={n(c.modelCalls)} />
        <Count label="Cost" value={formatUsd(c.costUsd)} />
      </dl>
      <nav aria-label="Change pages" className="ml-auto flex shrink-0 items-center gap-1">
        <Link
          to="/changes/$changeId"
          params={{ changeId }}
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5")}
        >
          <ArrowLeft size={14} aria-hidden />
          Change
        </Link>
        <Link
          to="/compare/$changeId"
          params={{ changeId }}
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5")}
        >
          <Columns size={14} aria-hidden />
          Compare versions
        </Link>
      </nav>
    </div>
  );
}
HeaderStrip.displayName = "HeaderStrip";

export function FlightPage({
  model,
  ready,
  socket,
  projectId,
  changeId,
  fixture = false,
}: {
  model: FlightModel;
  ready: boolean;
  socket: LiveStatus;
  projectId: string;
  changeId: string;
  /** Design reference: labels the page as fixture data. */
  fixture?: boolean;
}) {
  const time = useFlightTime();
  const focus = useFlightStore((s) => s.focus);
  const selection = useFlightStore((s) => s.selection);
  const inspectorOpen = useFlightStore((s) => s.inspectorOpen);
  const paletteOpen = useFlightStore((s) => s.paletteOpen);
  const reset = useFlightStore((s) => s.reset);

  // A different Change starts from a clean slate: live, nothing selected, no filters.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets when the route's Change changes
  useEffect(() => {
    reset();
    return () => reset();
  }, [changeId, reset]);

  const at = time.mode === "live" ? null : time.at;
  const state = useMemo(() => foldFlight(model, at), [model, at]);

  const live = time.mode === "live";

  const value = useMemo<FlightContextValue>(
    () => ({ model, state, ready, socket, projectId, changeId }),
    [model, state, ready, socket, projectId, changeId],
  );

  useFlightKeys(model.events);
  // The palette module loads on first use only.
  const [paletteMounted, setPaletteMounted] = useState(false);
  useEffect(() => {
    if (paletteOpen) setPaletteMounted(true);
  }, [paletteOpen]);

  const chrome = useChromeHeight();
  // An expanded panel scrolls to the top of the view, just under the sticky chrome.
  useEffect(() => {
    if (!focus) return;
    document.querySelector(`[data-panel="${focus}"]`)?.scrollIntoView({ block: "start" });
  }, [focus]);
  const drawer = inspectorOpen && selection !== null;
  const visible = focus ? PANELS.filter((p) => p.id === focus) : PANELS;

  return (
    <FlightProvider value={value}>
      <div
        className="grid min-w-0 gap-4"
        style={
          {
            "--rh-flight-sticky": `${chrome.height}px`,
            "--rh-flight-chrome": `${chrome.height + 136}px`,
          } as CSSProperties
        }
      >
        <div
          ref={chrome.ref}
          className="z-40 grid min-w-0 bg-kumo-elevated [@media(min-width:1024px)_and_(min-height:720px)]:sticky [@media(min-width:1024px)_and_(min-height:720px)]:top-0"
        >
          <HeaderStrip
            state={state}
            model={model}
            socket={socket}
            changeId={changeId}
            fixture={fixture}
            live={live}
          />
          <Scrubber />
        </div>
        <div className="bg-kumo-elevated">
          <FiltersBar />
        </div>

        <div
          className={cn(
            "grid min-w-0 items-start gap-4",
            drawer && "min-[1280px]:grid-cols-[minmax(0,1fr)_360px]",
          )}
        >
          <div className="@container min-w-0">
            <div className="grid grid-cols-1 gap-4 @min-[800px]:grid-cols-6">
              {visible.map(({ id, label, Component, span, tall, meta }) => (
                <PanelFrame
                  key={id}
                  id={id}
                  label={label}
                  meta={meta(state, model)}
                  focused={focus === id}
                  tall={tall ?? false}
                  className={focus === id ? "@min-[800px]:col-span-6" : span}
                >
                  <Component focused={focus === id} />
                </PanelFrame>
              ))}
            </div>
          </div>
          {drawer && (
            <InspectorDrawer className="max-h-[640px] min-[1280px]:sticky min-[1280px]:top-[calc(var(--rh-flight-sticky)+16px)] min-[1280px]:max-h-[calc(100dvh-var(--rh-flight-chrome))] min-[1280px]:min-h-[360px]" />
          )}
        </div>

        {/* One polite line for the newest recorded fact, live only (DESIGN.md 9.9, 14). */}
        <p className="sr-only" aria-live="polite" aria-atomic>
          {live && ready ? (model.events.at(-1)?.detail ?? "") : ""}
        </p>
      </div>
      {paletteMounted && (
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
      )}
    </FlightProvider>
  );
}
FlightPage.displayName = "FlightPage";

/** Loading body with the same frames as the page, so the first data paint does not shift. */
export function FlightSkeleton() {
  return (
    <div aria-busy className="grid min-w-0 gap-4">
      <div className="h-[104px] bg-kumo-elevated" />
      <div className="h-[49px] bg-kumo-elevated" />
      <div className="@container min-w-0">
        <div className="grid grid-cols-1 gap-4 @min-[800px]:grid-cols-6">
          {PANELS.slice(0, 3).map((p) => (
            <div
              key={p.id}
              className={cn("bg-kumo-elevated", p.tall ? "h-[420px]" : "h-[360px]", p.span)}
            >
              <div className="h-10 border-b border-kumo-rule" />
              <PanelSkeleton />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
FlightSkeleton.displayName = "FlightSkeleton";
