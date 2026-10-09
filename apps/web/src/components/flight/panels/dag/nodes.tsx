import { cn } from "@cloudflare/kumo";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import {
  BaseEdge,
  type Edge,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  type Node,
  type NodeProps,
  Position,
} from "@xyflow/react";
import type { CSSProperties } from "react";
import { formatNumber, formatUsd } from "../../../../lib/format";
import { CALLS_PER_RUN } from "../../../agents/activity-model";
import { FAMILY_FILL, FAMILY_TEXT, statusView } from "../../../ui/status-pill";
import { Tag } from "../../../ui/tag";
import { providerName, type TaskState } from "../../flight-model";
import { type EntityRef, useFlightStore } from "../../flight-store";
import { EntityHover } from "../../hover-preview";
import { DETAIL_ROW, type DetailRow, NODE_H, shownRun } from "./layout";

/**
 * Execution DAG node and edge renderers (DESIGN.md 9.13 in Flight Control dress): square nodes
 * on `base`, the border encodes the Task state, the selected node carries the overlay shadow and
 * the 2px accent bar the inspector repeats. Motion only replays recorded facts (11.1).
 */

type Border = "active" | "ready" | "attention" | "done" | "idle";

const BORDER_OF: Record<string, Border> = {
  running: "active",
  assigned: "active",
  ready: "ready",
  failed: "attention",
  blocked: "attention",
  completed: "done",
  pending: "idle",
  cancelled: "idle",
};

export const BORDER_CLASS: Record<Border, string> = {
  active: "border-2 border-kumo-ink",
  ready: "border-2 border-dashed border-kumo-ink",
  attention: "border-2 border-accent-500",
  done: "border border-kumo-divider",
  idle: "border border-dashed border-kumo-divider",
};

const SELECTED: CSSProperties = {
  boxShadow: "inset 2px 0 0 var(--color-accent-500), var(--rh-shadow-overlay)",
};

const select = (ref: EntityRef) => useFlightStore.getState().toggle(ref);

type TaskNodeData = {
  task: TaskState;
  /** Detail rows when expanded, null when collapsed. */
  rows: DetailRow[] | null;
  selected: boolean;
  hovered: boolean;
  dimmed: boolean;
  /** The latest played fact is about this Task (live fold only). */
  current: boolean;
  /** Event id of the newest animated fact about this Task: restarts the one-shot flash. */
  arrival: string | null;
  onToggleExpand: (taskId: string) => void;
};
export type TaskFlowNode = Node<TaskNodeData, "task">;

function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const { task, rows, selected, hovered, dimmed, current, arrival, onToggleExpand } = data;
  const view = statusView(task.status);
  const run = shownRun(task);
  const provider = run ? providerName(run.provider) : null;
  const running = task.running;
  const cap = running ? CALLS_PER_RUN[running.tier] : null;
  const progress = running && cap ? Math.min(1, running.modelCalls / cap) : null;
  const risky = task.riskTier === "high" || task.riskTier === "critical";
  const conflicted = task.conflictIds.length > 0;
  const label = [
    `${task.key} ${task.title}`,
    `status ${view.label}`,
    run ? `attempt ${run.attempt} on ${run.tier}${provider ? ` via ${provider}` : ""}` : "no run",
    running && cap ? `${running.modelCalls} of ${cap} model calls` : null,
    run?.escalatedFrom ? `escalated from ${run.escalatedFrom}` : null,
    task.source === "fixture" ? "fixture work" : null,
    risky ? `risk ${task.riskTier}` : null,
    conflicted ? "in a conflict" : null,
    current ? "latest fact" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      className={cn(
        "pointer-events-auto relative flex h-full w-full flex-col bg-kumo-base transition-opacity duration-(--rh-dur-ui) ease-out",
        BORDER_CLASS[BORDER_OF[task.status] ?? "idle"],
        hovered && !selected && "bg-kumo-row-hover",
        dimmed && "opacity-45",
        current && "outline-1 outline-offset-2 outline-accent-500 outline-dashed",
      )}
      style={selected ? SELECTED : undefined}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="opacity-0!"
        style={{ top: NODE_H / 2 }}
      />
      {arrival && (
        <span
          key={arrival}
          aria-hidden
          className="rh-arrive pointer-events-none absolute inset-0"
        />
      )}
      <div className="relative flex shrink-0 items-stretch" style={{ height: NODE_H - 4 }}>
        <EntityHover entity={{ kind: "task", id: task.id }}>
          <button
            type="button"
            aria-pressed={selected}
            aria-label={label}
            onClick={() => select({ kind: "task", id: task.id })}
            className="nopan nodrag grid min-w-0 flex-1 cursor-pointer grid-rows-[14px_17px_16px_16px] content-start gap-[3px] py-2 pr-1 pl-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[10px] tracking-[0.08em] text-kumo-subtle uppercase">
                {task.key} · {task.kind}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold">
                <span
                  aria-hidden
                  className={cn(
                    "size-2 transition-colors duration-(--rh-dur-ui-slow) ease-out",
                    FAMILY_FILL[view.family],
                  )}
                />
                <span className={FAMILY_TEXT[view.family]}>{view.label}</span>
              </span>
            </span>
            <span className="truncate text-[13px] leading-tight font-bold" title={task.title}>
              {task.title}
            </span>
            <span className="flex items-center justify-between gap-2 font-mono text-[11px] text-kumo-subtle">
              <span className="truncate">
                {run ? `${run.tier}${provider ? ` · ${provider}` : ""}` : "no run yet"}
              </span>
              {run && <span className="shrink-0 tabular-nums">attempt {run.attempt}</span>}
            </span>
            <span className="flex h-[16px] min-w-0 items-center gap-1 overflow-hidden">
              {run?.escalatedFrom && (
                <span className="shrink-0 font-mono text-[10px] text-kumo-subtle">
                  ↑ from {run.escalatedFrom}
                </span>
              )}
              {task.source === "fixture" && <Tag className="px-1 py-0 text-[10px]">fixture</Tag>}
              {risky && (
                <Tag variant="outline" className="px-1 py-0 text-[10px]">
                  Risk {task.riskTier}
                </Tag>
              )}
              {conflicted && (
                <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-kumo-danger">
                  <span aria-hidden className="size-1.5 bg-accent-500" />
                  Conflict
                </span>
              )}
            </span>
          </button>
        </EntityHover>
        <button
          type="button"
          aria-expanded={rows !== null}
          aria-label={`${rows ? "Hide" : "Show"} details of ${task.key}`}
          title={rows ? "Hide details" : "Show details"}
          onClick={() => onToggleExpand(task.id)}
          className="nopan nodrag flex w-6 shrink-0 cursor-pointer items-start justify-center pt-2 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500"
        >
          {rows ? <CaretDown size={12} /> : <CaretRight size={12} />}
        </button>
        {progress !== null && (
          <span
            aria-hidden
            className="rh-lane-progress absolute bottom-0 left-0"
            style={{ width: `${Math.max(2, progress * 100)}%` }}
          />
        )}
      </div>
      {rows && (
        <ul className="nopan nodrag grid border-t border-kumo-rule px-2.5 pt-1 text-[11px]">
          {rows.map((row) => (
            <li
              key={rowKey(row)}
              className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap"
              style={{ height: DETAIL_ROW }}
            >
              <DetailLine row={row} task={task} />
            </li>
          ))}
        </ul>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="opacity-0!"
        style={{ top: NODE_H / 2 }}
      />
    </div>
  );
}
TaskNode.displayName = "TaskNode";

const rowKey = (row: DetailRow) =>
  row.kind === "attempt" ? `attempt-${row.run.attempt}` : row.kind;

const ROW_LABEL = "w-[60px] shrink-0 text-kumo-subtle";
const CHIP =
  "nopan nodrag min-h-5 cursor-pointer px-1 font-mono text-[11px] hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-500";

function DetailLine({ row, task }: { row: DetailRow; task: TaskState }) {
  switch (row.kind) {
    case "attempt": {
      const r = row.run;
      const v = statusView(r.status);
      const detail = [
        `${formatNumber(r.modelCalls)} calls`,
        formatUsd(r.costUsd),
        r.failureKind?.replace(/_/g, " "),
        r.failureReason,
      ]
        .filter(Boolean)
        .join(" · ");
      return (
        <>
          <span className={ROW_LABEL}>Attempt {r.attempt}</span>
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden" title={detail}>
            <span className="shrink-0 font-mono">{r.tier}</span>
            <span className={cn("shrink-0 font-semibold", FAMILY_TEXT[v.family])}>{v.label}</span>
            <span className="truncate font-mono text-kumo-subtle tabular-nums">
              {formatNumber(r.modelCalls)} calls
              {r.failureKind ? ` · ${r.failureKind.replace(/_/g, " ")}` : ""}
            </span>
          </span>
        </>
      );
    }
    case "no-attempt":
      return (
        <>
          <span className={ROW_LABEL}>Attempts</span>
          <span className="text-kumo-subtle">None started</span>
        </>
      );
    case "files":
      return (
        <>
          <span className={ROW_LABEL}>Files</span>
          <span className="truncate tabular-nums">
            {formatNumber(row.expected)} expected · {formatNumber(row.changed)} changed
          </span>
        </>
      );
    case "claims":
      return (
        <>
          <span className={ROW_LABEL}>Claims</span>
          {row.resources.length === 0 ? (
            <span className="text-kumo-subtle">—</span>
          ) : (
            row.resources.map((r) => (
              <button
                key={r}
                type="button"
                className={CHIP}
                onClick={() => select({ kind: "resource", id: r })}
              >
                {r}
              </button>
            ))
          )}
        </>
      );
    case "changesets":
      return (
        <>
          <span className={ROW_LABEL}>ChangeSets</span>
          {row.ids.length === 0 ? (
            <span className="text-kumo-subtle">—</span>
          ) : (
            row.ids.map((id) => (
              <button
                key={id}
                type="button"
                className={CHIP}
                onClick={() => select({ kind: "changeset", id })}
              >
                {id}
              </button>
            ))
          )}
        </>
      );
    case "candidates":
      return (
        <>
          <span className={ROW_LABEL}>Candidates</span>
          {row.items.length === 0 ? (
            <span className="text-kumo-subtle">—</span>
          ) : (
            row.items.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-label={`Candidate ${c.letter}`}
                className={CHIP}
                onClick={() => select({ kind: "candidate", id: c.id })}
              >
                {c.letter}
              </button>
            ))
          )}
        </>
      );
    case "waits":
      return (
        <>
          <span className={ROW_LABEL}>Waits on</span>
          {row.deps.map((d) => (
            <button
              key={d.id}
              type="button"
              aria-label={`Dependency ${d.key} to ${task.key}, ${statusView(d.status).label}`}
              className={CHIP}
              onClick={() => select({ kind: "dependency", id: d.edgeId })}
            >
              {d.key}
              <span className={cn("ml-1", FAMILY_TEXT[statusView(d.status).family])}>
                {statusView(d.status).label}
              </span>
            </button>
          ))}
        </>
      );
  }
}
DetailLine.displayName = "DetailLine";

type ResourceGroupData = {
  resource: string;
  count: number;
  protectedResource: boolean;
  selected: boolean;
  dimmed: boolean;
};
export type ResourceFlowNode = Node<ResourceGroupData, "resource">;

/** Group frame per semantic resource (grouped mode): a 1px rule frame with a mono header. */
function ResourceGroupNode({ data }: NodeProps<ResourceFlowNode>) {
  const ref: EntityRef = { kind: "resource", id: data.resource };
  return (
    <div
      className={cn(
        // The frame lets clicks through to the edges under it; only the header is a target.
        "pointer-events-none h-full w-full border border-kumo-rule transition-opacity duration-(--rh-dur-ui)",
        data.selected && "border-accent-500",
        data.dimmed && "opacity-45",
      )}
    >
      <EntityHover entity={ref}>
        <button
          type="button"
          aria-pressed={data.selected}
          onClick={() => select(ref)}
          className="nopan nodrag pointer-events-auto flex h-7 max-w-full cursor-pointer items-center gap-2 px-3 text-left hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500"
        >
          <span className="truncate font-mono text-[11px]">{data.resource}</span>
          <span className="shrink-0 text-[11px] text-kumo-subtle">
            {formatNumber(data.count)} Task{data.count === 1 ? "" : "s"}
            {data.protectedResource ? " · protected" : ""}
          </span>
        </button>
      </EntityHover>
    </div>
  );
}
ResourceGroupNode.displayName = "ResourceGroupNode";

export const nodeTypes = { task: TaskNode, resource: ResourceGroupNode };

type DepEdgeData = { tooltip: string };
export type DepFlowEdge = Edge<DepEdgeData, "dep">;

/** Square-cornered step edge with a native hover tooltip explaining the dependency. */
function DepEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps<DepFlowEdge>) {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 0,
  });
  return (
    <>
      <title>{data?.tooltip}</title>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={14}
        {...(style ? { style } : {})}
        {...(markerEnd ? { markerEnd } : {})}
      />
    </>
  );
}
DepEdge.displayName = "DepEdge";

export const edgeTypes = { dep: DepEdge };
