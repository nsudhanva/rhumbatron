import { cn } from "@cloudflare/kumo";
import { type Edge, Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { type CSSProperties, useMemo } from "react";
import type { TaskDetail } from "../lib/api";
import { latestRun, layoutTasks, truncate } from "../lib/format";
import { canvasHeight, ReadableFlow } from "./readable-flow";
import { StatusPill } from "./ui/status-pill";

/**
 * Work Graph: square nodes on an elevated canvas with a 2px ink rule on top.
 * The node border encodes the Task state (see LEGEND); the selected node carries the overlay
 * shadow and a 2px accent bar, the same bar the Task inspector beside it uses.
 */

type Border = "active" | "ready" | "attention" | "done" | "idle";

const BORDER_OF: Record<TaskDetail["status"], Border> = {
  running: "active",
  assigned: "active",
  ready: "ready",
  failed: "attention",
  blocked: "attention",
  completed: "done",
  pending: "idle",
  cancelled: "idle",
};

const BORDER_CLASS: Record<Border, string> = {
  active: "border-2 border-kumo-ink",
  ready: "border-2 border-dashed border-kumo-ink",
  attention: "border-2 border-accent-500",
  done: "border border-kumo-divider",
  idle: "border border-dashed border-kumo-divider",
};

const LEGEND: { border: Border; label: string }[] = [
  { border: "active", label: "Running" },
  { border: "ready", label: "Ready" },
  { border: "attention", label: "Failed or blocked" },
  { border: "done", label: "Done" },
  { border: "idle", label: "Waiting or cancelled" },
];

type TaskNodeData = { task: TaskDetail; selected: boolean };
type TaskFlowNode = Node<TaskNodeData, "task">;

function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const { task, selected } = data;
  const run = latestRun(task);
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${task.key} ${task.title}`}
      className={cn(
        "grid w-60 cursor-pointer gap-1.5 bg-kumo-base px-3 py-2.5 text-left transition-shadow duration-(--rh-dur-ui) hover:bg-kumo-row-hover",
        BORDER_CLASS[BORDER_OF[task.status]],
      )}
      style={selected ? SELECTED : undefined}
    >
      <Handle type="target" position={Position.Left} className="opacity-0!" />
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[10px] tracking-[0.08em] text-kumo-subtle uppercase">
          {task.key} · {task.kind}
        </span>
        <StatusPill status={task.status} />
      </div>
      <p className="line-clamp-2 text-[14px] leading-tight font-extrabold tracking-[-0.01em]">
        {truncate(task.title, 70)}
      </p>
      <p className="truncate font-mono text-[11px] text-kumo-subtle">
        {run ? `${run.tier} · attempt ${run.attempt}` : "no run yet"}
      </p>
      <Handle type="source" position={Position.Right} className="opacity-0!" />
    </button>
  );
}

/** Selected node: the overlay shadow plus the 2px accent bar the inspector repeats. */
const SELECTED: CSSProperties = {
  boxShadow: "inset 2px 0 0 var(--color-accent-500), var(--rh-shadow-overlay)",
};

const nodeTypes = { task: TaskNode };

/** Rendered height of a TaskNode (three lines plus padding), for the canvas height. */
const NODE_HEIGHT = 96;

const EDGE_RELEVANT: CSSProperties = { stroke: "var(--color-kumo-ink)", strokeWidth: 2 };
const EDGE_QUIET: CSSProperties = {
  stroke: "var(--color-kumo-divider)",
  strokeWidth: 1,
  strokeDasharray: "4 3",
};

export function WorkGraph({
  tasks,
  selectedId,
  onSelect,
}: {
  tasks: TaskDetail[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const { nodes, edges, height } = useMemo(() => {
    const positions = layoutTasks(tasks);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const nodes: TaskFlowNode[] = tasks.map((task) => ({
      id: task.id,
      type: "task",
      position: positions.get(task.id) ?? { x: 0, y: 0 },
      data: { task, selected: task.id === selectedId },
      draggable: false,
    }));
    const edges: Edge[] = tasks.flatMap((task) =>
      task.dependsOn
        .filter((dep) => byId.has(dep))
        .map((dep) => {
          // Relevant: touches the selected Task, or feeds a Task that is working now.
          const relevant =
            dep === selectedId ||
            task.id === selectedId ||
            task.status === "running" ||
            task.status === "assigned";
          return {
            id: `${dep}->${task.id}`,
            source: dep,
            target: task.id,
            style: relevant ? EDGE_RELEVANT : EDGE_QUIET,
          };
        }),
    );
    const height = canvasHeight(
      [...positions.values()].map((p) => p.y),
      NODE_HEIGHT,
    );
    return { nodes, edges, height };
  }, [tasks, selectedId]);

  return (
    <figure className="grid min-w-0 gap-2">
      <ReadableFlow
        // Remount when the graph first fills in, so the first view frames the Tasks.
        key={nodes.length}
        label="Work Graph"
        height={height}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onSelect}
      />
      <figcaption className="grid gap-1.5">
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12px]" aria-label="Legend">
          {LEGEND.map((item) => (
            <li key={item.border} className="flex items-center gap-1.5">
              <span aria-hidden className={cn("size-3 bg-kumo-base", BORDER_CLASS[item.border])} />
              {item.label}
            </li>
          ))}
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="h-0.5 w-4 bg-kumo-ink" />
            Relevant dependency
          </li>
        </ul>
        <p className="text-[11px] text-kumo-subtle">
          Shows the {tasks.length} Tasks of this Change and their dependencies. Other Changes and
          file-level dependencies are hidden. Select a Task to inspect it.
        </p>
      </figcaption>
    </figure>
  );
}
