import { Badge } from "@cloudflare/kumo";
import {
  Background,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import type { TaskDetail } from "../lib/api";
import { latestRun, layoutTasks, truncate } from "../lib/format";

export const STATUS_STYLE: Record<
  TaskDetail["status"],
  { label: string; card: string; variant: "secondary" | "info" | "warning" | "success" | "error" }
> = {
  pending: { label: "Pending", card: "border-kumo-line opacity-70", variant: "secondary" },
  ready: { label: "Ready", card: "border-kumo-info", variant: "info" },
  assigned: { label: "Assigned", card: "border-kumo-brand animate-pulse", variant: "warning" },
  running: { label: "Running", card: "border-kumo-brand animate-pulse", variant: "warning" },
  completed: { label: "Completed", card: "border-kumo-success", variant: "success" },
  failed: { label: "Failed", card: "border-kumo-danger", variant: "error" },
  blocked: { label: "Blocked", card: "border-kumo-danger", variant: "error" },
  cancelled: { label: "Cancelled", card: "border-kumo-line opacity-60", variant: "secondary" },
};

type TaskNodeData = { task: TaskDetail; selected: boolean };
type TaskFlowNode = Node<TaskNodeData, "task">;

function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const { task, selected } = data;
  const style = STATUS_STYLE[task.status];
  const run = latestRun(task);
  return (
    <div
      className={`w-60 rounded-lg border-2 bg-kumo-base px-3 py-2 text-left ${style.card} ${selected ? "ring-2 ring-kumo-focus" : ""}`}
    >
      <Handle type="target" position={Position.Left} className="opacity-0!" />
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-kumo-subtle">{task.key}</span>
        <Badge variant={style.variant}>{style.label}</Badge>
      </div>
      <p className="mt-1 line-clamp-2 text-sm font-medium text-kumo-default">
        {truncate(task.title, 70)}
      </p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <Badge variant="secondary">{task.kind}</Badge>
        {run && <Badge variant="info">{run.tier}</Badge>}
      </div>
      <Handle type="source" position={Position.Right} className="opacity-0!" />
    </div>
  );
}

const nodeTypes = { task: TaskNode };

export function WorkGraph({
  tasks,
  selectedId,
  onSelect,
}: {
  tasks: TaskDetail[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const { nodes, edges } = useMemo(() => {
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
        .map((dep) => ({
          id: `${dep}->${task.id}`,
          source: dep,
          target: task.id,
          animated: task.status === "running" || task.status === "assigned",
        })),
    );
    return { nodes, edges };
  }, [tasks, selectedId]);

  return (
    <div className="h-[480px] w-full rounded-lg border border-kumo-line bg-kumo-recessed">
      <ReactFlow
        // Remount when the graph first fills in, so fitView frames every Task.
        key={nodes.length}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.1, minZoom: 0.2 }}
        minZoom={0.2}
        style={{ background: "transparent" }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        colorMode="light"
        onNodeClick={(_, node) => onSelect(node.id)}
      >
        <Background />
      </ReactFlow>
    </div>
  );
}
