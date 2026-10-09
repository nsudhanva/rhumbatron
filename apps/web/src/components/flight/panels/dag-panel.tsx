import { Button, cn } from "@cloudflare/kumo";
import { CornersOut, Minus, Plus } from "@phosphor-icons/react";
import { MarkerType, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatNumber, isCompiling } from "../../../lib/format";
import { usePrefersReducedMotion } from "../../../lib/motion";
import { EmptyState } from "../../ui/empty-state";
import { statusView } from "../../ui/status-pill";
import { useFlight } from "../flight-context";
import {
  type DependencyState,
  type FlightState,
  refKey,
  relatedRefs,
  type TaskState,
} from "../flight-model";
import {
  type EntityRef,
  useFlightFilters,
  useFlightStore,
  useHover,
  useSelection,
} from "../flight-store";
import type { PanelProps } from "../panel-types";
import {
  describeDependency,
  detailRows,
  layoutDag,
  matchesFilters,
  NODE_H,
  NODE_W,
  shownRun,
} from "./dag/layout";
import {
  BORDER_CLASS,
  type DepFlowEdge,
  edgeTypes,
  nodeTypes,
  type ResourceFlowNode,
  type TaskFlowNode,
} from "./dag/nodes";

/**
 * Execution DAG (Flight Control): the Work Graph of one Change as it stood at the fold instant.
 *
 *   nodes   state.tasks in state.taskOrder, column = layer, row = index in the layer
 *   edges   state.dependencies: done (tone), waiting (dashed attention, animated only while the
 *           dependent is queued and the fold is live), failed (danger), critical path (2px)
 *   motion  a one-shot flash on a node when a recorded fact about it plays (lane.fork,
 *           run.start, run.end); progress lines advance with recorded model calls only
 *
 * Selection is shared with every other panel through the Flight store; unrelated nodes dim.
 * Filters dim, never remove, so the graph keeps its shape while a viewer narrows it.
 */

type Toggles = {
  grouped: boolean;
  criticalOnly: boolean;
  setGrouped: (value: boolean) => void;
  setCriticalOnly: (value: boolean) => void;
};

export function DagPanel({ focused }: PanelProps) {
  const { state, model, ready } = useFlight();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [grouped, setGrouped] = useState(false);
  const [criticalOnly, setCriticalOnly] = useState(false);
  const toggleExpand = useCallback((taskId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  if (!ready) return <DagSkeleton />;
  if (state.taskOrder.length === 0) {
    const status = model.input.change.status;
    return (
      <div className="flex h-full min-h-[320px] flex-col px-4 py-3">
        {isCompiling(status) ? (
          <EmptyState
            what="Root Planner is compiling the Work Graph."
            how="Tasks appear here when change.compiled is recorded."
          />
        ) : (
          <EmptyState
            what="Root Planner has not compiled the Work Graph."
            how={`This Change is ${statusView(status).label.toLowerCase()} and has no Tasks.`}
          />
        )}
      </div>
    );
  }

  return (
    <section aria-label="Execution DAG" className="flex h-full min-h-[320px] min-w-0 flex-col">
      {/* Remounting on a new node count or grouping refits the view once, never mid-run. */}
      <ReactFlowProvider key={`${grouped ? "grouped" : "flat"}:${state.taskOrder.length}`}>
        <DagCanvas
          state={state}
          focused={focused}
          expanded={expanded}
          onToggleExpand={toggleExpand}
          toggles={{ grouped, criticalOnly, setGrouped, setCriticalOnly }}
        />
      </ReactFlowProvider>
    </section>
  );
}
DagPanel.displayName = "DagPanel";

/** One fit for the first render, the Fit button and a resize refit. */
const FIT = { padding: 0.12, minZoom: 0.2, maxZoom: 1 } as const;

const EVENT_KINDS_OF_TASK = new Set(["lane.fork", "run.start", "run.end"]);

/** Tasks an entity under the pointer stands for: itself for a Task, its related Tasks otherwise. */
function hoveredTasks(state: FlightState, hover: EntityRef | null): ReadonlySet<string> {
  if (!hover) return new Set();
  if (hover.kind === "task") return new Set([hover.id]);
  const out = new Set<string>();
  for (const key of relatedRefs(state, hover)) {
    if (key.startsWith("task:")) out.add(key.slice(5));
  }
  return out;
}

const EDGE_BASE: CSSProperties = { vectorEffect: "non-scaling-stroke" };

function edgeStyle(dep: DependencyState, accent: boolean, dimmed: boolean): CSSProperties {
  const width = dep.critical || accent ? 2 : 1;
  const opacity = dimmed ? 0.45 : 1;
  if (accent) return { ...EDGE_BASE, stroke: "var(--color-accent-500)", strokeWidth: 2, opacity };
  switch (dep.status) {
    case "done":
      return {
        ...EDGE_BASE,
        stroke: dep.critical ? "var(--color-kumo-ink)" : "var(--color-tone-400)",
        strokeWidth: width,
        opacity,
      };
    case "blocking":
      return {
        ...EDGE_BASE,
        stroke: "var(--color-kumo-warning)",
        strokeWidth: width,
        strokeDasharray: "5 4",
        opacity,
      };
    case "failed":
      return { ...EDGE_BASE, stroke: "var(--color-kumo-danger)", strokeWidth: width, opacity };
    case "idle":
      return {
        ...EDGE_BASE,
        stroke: dep.critical ? "var(--color-kumo-ink)" : "var(--color-kumo-divider)",
        strokeWidth: width,
        strokeDasharray: "2 3",
        opacity,
      };
  }
}

function DagCanvas({
  state,
  focused,
  expanded,
  onToggleExpand,
  toggles,
}: {
  state: FlightState;
  focused: boolean;
  expanded: ReadonlySet<string>;
  onToggleExpand: (taskId: string) => void;
  toggles: Toggles;
}) {
  const { animated } = useFlight();
  const selection = useSelection();
  const hover = useHover();
  const filters = useFlightFilters();
  const reduce = usePrefersReducedMotion();
  const { grouped, criticalOnly } = toggles;
  const flow = useReactFlow();
  const frameRef = useRef<HTMLDivElement>(null);
  // True once the viewer pans or zooms; a manual view is never replaced by an automatic fit.
  const manualView = useRef(false);

  // The panel narrows when the inspector drawer opens (and widens when it closes). Refit then,
  // or the rightmost Tasks sit cut off at the edge.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let width = frame.clientWidth;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? width;
      if (Math.abs(next - width) < 1) return;
      width = next;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!manualView.current) void flow.fitView({ ...FIT, duration: reduce ? 0 : 150 });
      }, 150);
    });
    observer.observe(frame);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [flow, reduce]);

  const related = useMemo(
    () => (selection ? relatedRefs(state, selection) : null),
    [state, selection],
  );
  const hovered = useMemo(() => hoveredTasks(state, hover), [state, hover]);
  const matches = useMemo(() => {
    const out = new Map<string, boolean>();
    for (const task of Object.values(state.tasks)) out.set(task.id, matchesFilters(task, filters));
    return out;
  }, [state.tasks, filters]);
  const filtering = filters.query.trim() !== "" || filters.tiers.length > 0 || filters.activeOnly;
  const matchCount = [...matches.values()].filter(Boolean).length;

  // Newest animated fact per Task (only facts the pacing queue just played may move).
  const arrivals = useMemo(() => {
    const out = new Map<string, string>();
    if (animated.size === 0) return out;
    for (const event of state.events) {
      if (!animated.has(event.id) || !EVENT_KINDS_OF_TASK.has(event.kind)) continue;
      if ("laneId" in event && event.laneId) out.set(event.laneId, event.id);
    }
    return out;
  }, [state.events, animated]);

  const layout = useMemo(() => layoutDag(state, expanded, grouped), [state, expanded, grouped]);

  const nodes = useMemo(() => {
    const currentTask = state.live && state.current?.kind === "task" ? state.current.id : null;
    const out: (TaskFlowNode | ResourceFlowNode)[] = [];
    for (const group of layout.groups) {
      const resource = state.resources.find((r) => r.resource === group.resource);
      const ref = refKey({ kind: "resource", id: group.resource });
      out.push({
        id: group.id,
        type: "resource",
        position: { x: group.x, y: group.y },
        width: group.w,
        height: group.h,
        draggable: false,
        selectable: false,
        focusable: false,
        data: {
          resource: group.resource,
          count: group.taskIds.length,
          protectedResource: resource?.protectedResource ?? false,
          selected: selection?.kind === "resource" && selection.id === group.resource,
          dimmed:
            !!related &&
            !related.has(ref) &&
            !group.taskIds.some((id) => related.has(`task:${id}`)),
        },
      });
    }
    for (const placed of layout.nodes) {
      const task = state.tasks[placed.id];
      if (!task) continue;
      const dimmed =
        (!!related && !related.has(`task:${task.id}`)) ||
        !matches.get(task.id) ||
        (criticalOnly && !task.critical);
      out.push({
        id: task.id,
        type: "task",
        position: { x: placed.x, y: placed.y },
        width: placed.w,
        height: placed.h,
        ...(placed.parent ? { parentId: placed.parent, extent: "parent" as const } : {}),
        draggable: false,
        selectable: false,
        focusable: false,
        data: {
          task,
          rows: expanded.has(task.id) ? detailRows(state, task) : null,
          selected: selection?.kind === "task" && selection.id === task.id,
          hovered: hovered.has(task.id),
          dimmed,
          current: currentTask === task.id,
          arrival: arrivals.get(task.id) ?? null,
          onToggleExpand,
        },
      });
    }
    return out;
  }, [
    state,
    layout,
    selection,
    related,
    hovered,
    matches,
    criticalOnly,
    expanded,
    arrivals,
    onToggleExpand,
  ]);

  const edges = useMemo(
    () =>
      state.dependencies.map((dep): DepFlowEdge => {
        const accent = !!related && related.has(`dependency:${dep.id}`);
        const dimmed =
          (!!related &&
            !accent &&
            !(related.has(`task:${dep.from}`) && related.has(`task:${dep.to}`))) ||
          (criticalOnly && !dep.critical) ||
          !matches.get(dep.from) ||
          !matches.get(dep.to);
        const style = edgeStyle(dep, accent, dimmed);
        const target = state.tasks[dep.to];
        const tooltip = describeDependency(state, dep);
        return {
          id: dep.id,
          type: "dep",
          source: dep.from,
          target: dep.to,
          animated:
            dep.status === "blocking" &&
            state.live &&
            !reduce &&
            (target?.status === "pending" || target?.status === "ready"),
          style,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: String(style.stroke),
            width: 14,
            height: 14,
          },
          className: "cursor-pointer",
          ariaLabel: tooltip,
          data: { tooltip },
        };
      }),
    [state, related, criticalOnly, matches, reduce],
  );

  const onEdgeClick = useCallback((_: unknown, edge: { id: string }) => {
    useFlightStore.getState().toggle({ kind: "dependency", id: edge.id });
  }, []);
  const onEdgeEnter = useCallback((_: unknown, edge: { id: string }) => {
    useFlightStore.getState().setHover({ kind: "dependency", id: edge.id });
  }, []);
  const onEdgeLeave = useCallback(() => useFlightStore.getState().setHover(null), []);

  return (
    <>
      <DagToolbar
        toggles={toggles}
        summary={
          filtering
            ? `${formatNumber(matchCount)} of ${formatNumber(state.counts.tasks)} Tasks match`
            : `${formatNumber(state.counts.tasks)} Tasks · ${formatNumber(state.counts.running)} running · ${formatNumber(state.counts.blocked)} waiting`
        }
        expandedCount={expanded.size}
        manualView={manualView}
      />
      <div ref={frameRef} className="relative min-h-0 flex-1 bg-kumo-elevated">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onEdgeClick={onEdgeClick}
          onEdgeMouseEnter={onEdgeEnter}
          onEdgeMouseLeave={onEdgeLeave}
          fitView
          fitViewOptions={FIT}
          onMoveEnd={(event) => {
            // `event` is null for programmatic moves (fitView, the toolbar), set for the viewer's.
            if (event) manualView.current = true;
          }}
          minZoom={0.2}
          maxZoom={1.6}
          style={{ background: "transparent" }}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          panActivationKeyCode={null}
          zoomOnScroll={focused}
          preventScrolling={focused}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
          colorMode="light"
          aria-label="Execution DAG canvas"
        >
          {focused && (
            <MiniMap
              pannable
              zoomable
              ariaLabel="Execution DAG overview"
              nodeBorderRadius={0}
              nodeStrokeWidth={0}
              nodeColor={(node) =>
                node.type === "resource"
                  ? "transparent"
                  : (node.data as { task?: TaskState }).task?.status === "running"
                    ? "var(--color-kumo-ink)"
                    : "var(--color-tone-400)"
              }
              maskColor="var(--rh-faint)"
              bgColor="var(--color-kumo-base)"
              className="border border-kumo-rule"
            />
          )}
        </ReactFlow>
      </div>
      <DagLegend />
      <DagTextEquivalent state={state} />
    </>
  );
}
DagCanvas.displayName = "DagCanvas";

function DagToolbar({
  toggles,
  summary,
  expandedCount,
  manualView,
}: {
  toggles: Toggles;
  summary: string;
  expandedCount: number;
  manualView: MutableRefObject<boolean>;
}) {
  const flow = useReactFlow();
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b border-kumo-rule px-2 py-1">
      <div className="flex items-center gap-0.5">
        <Button
          size="sm"
          variant="ghost"
          shape="square"
          icon={<CornersOut size={14} />}
          aria-label="Fit the graph to the panel"
          title="Fit"
          onClick={() => {
            manualView.current = false;
            void flow.fitView({ ...FIT, duration: 150 });
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          shape="square"
          icon={<Minus size={14} />}
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => {
            manualView.current = true;
            void flow.zoomOut({ duration: 150 });
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          shape="square"
          icon={<Plus size={14} />}
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => {
            manualView.current = true;
            void flow.zoomIn({ duration: 150 });
          }}
        />
      </div>
      <div className="flex items-center gap-1">
        <Chip
          pressed={toggles.criticalOnly}
          onClick={() => toggles.setCriticalOnly(!toggles.criticalOnly)}
        >
          Critical path
        </Chip>
        <Chip pressed={toggles.grouped} onClick={() => toggles.setGrouped(!toggles.grouped)}>
          Group by resource
        </Chip>
      </div>
      <span className="ml-auto truncate font-mono text-[11px] text-kumo-subtle">
        {summary}
        {expandedCount > 0 ? ` · ${formatNumber(expandedCount)} expanded` : ""}
      </span>
    </div>
  );
}
DagToolbar.displayName = "DagToolbar";

/** Toggle chip (DESIGN.md 10: selected chip = ink fill, inverse text). */
function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "min-h-6 cursor-pointer px-2 text-[12px] transition-colors duration-(--rh-dur-ui) ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 pointer-coarse:min-h-11",
        pressed ? "bg-kumo-ink text-kumo-inverse" : "text-kumo-default hover:bg-kumo-tint",
      )}
    >
      {children}
    </button>
  );
}
Chip.displayName = "Chip";

const NODE_LEGEND: { border: keyof typeof BORDER_CLASS; label: string }[] = [
  { border: "active", label: "Running" },
  { border: "ready", label: "Ready" },
  { border: "attention", label: "Failed or blocked" },
  { border: "done", label: "Done" },
  { border: "idle", label: "Queued" },
];

function DagLegend() {
  return (
    <ul
      aria-label="Legend"
      className="flex shrink-0 items-center gap-x-3 overflow-x-auto border-t border-kumo-rule px-2 py-1 text-[11px] whitespace-nowrap text-kumo-subtle"
    >
      {NODE_LEGEND.map((item) => (
        <li key={item.border} className="flex items-center gap-1.5">
          <span aria-hidden className={cn("size-3 bg-kumo-base", BORDER_CLASS[item.border])} />
          {item.label}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="h-0.5 w-4 bg-kumo-ink" />
        Critical path
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="w-4 border-t-2 border-dashed border-kumo-warning" />
        Waiting on
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="h-px w-4 bg-tone-400" />
        Done
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="h-px w-4 bg-accent-500" />
        Failed
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="size-1.5 bg-accent-500" />
        Conflict
      </li>
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="size-3 outline-1 outline-offset-1 outline-accent-500 outline-dashed"
        />
        Latest fact
      </li>
      <li>↑ escalated attempt</li>
    </ul>
  );
}
DagLegend.displayName = "DagLegend";

/** Screen-reader equivalent of the graph: one line per Task with its dependencies. */
function DagTextEquivalent({ state }: { state: FlightState }) {
  return (
    <ul className="sr-only" aria-label="Execution DAG as text">
      {state.taskOrder.map((id) => {
        const task = state.tasks[id];
        if (!task) return null;
        const run = shownRun(task);
        const deps = task.dependsOn
          .map((d) => {
            const dep = state.dependencies.find((x) => x.id === `${d}->${task.id}`);
            return `${state.tasks[d]?.key ?? d} (${dep ? describeDependency(state, dep) : "unknown"})`;
          })
          .join("; ");
        return (
          <li key={id}>
            {task.key} {task.title}: status {statusView(task.status).label}
            {run ? `, attempt ${run.attempt} on ${run.tier}` : ", no run"}
            {task.critical ? ", on the critical path" : ""}
            {deps ? `. Depends on ${deps}` : ". No dependencies"}.
          </li>
        );
      })}
    </ul>
  );
}
DagTextEquivalent.displayName = "DagTextEquivalent";

const SKELETON_COLUMNS = [
  { id: "c0", rows: ["r0", "r1", "r2"] },
  { id: "c1", rows: ["r0", "r1", "r2", "r3"] },
  { id: "c2", rows: ["r0", "r1"] },
];

/** Same frame height as the graph: columns of node-sized blocks, no spinner. */
function DagSkeleton() {
  return (
    <div aria-busy="true" className="flex h-full min-h-[320px] flex-col">
      <span className="sr-only">Loading the Execution DAG</span>
      <div className="h-9 border-b border-kumo-rule" />
      <div className="flex flex-1 gap-16 overflow-hidden bg-kumo-elevated p-6">
        {SKELETON_COLUMNS.map((column) => (
          <div key={column.id} className="grid content-start gap-3.5">
            {column.rows.map((row) => (
              <div
                key={row}
                className="animate-pulse bg-kumo-faint"
                style={{ width: NODE_W, height: NODE_H }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
DagSkeleton.displayName = "DagSkeleton";
