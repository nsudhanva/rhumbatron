import { cn } from "@cloudflare/kumo";
import { type Edge, Handle, type Node, type NodeProps, Position, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { type CSSProperties, useMemo } from "react";
import { formatNumber } from "../../lib/format";
import {
  type AreaState,
  type AreaView,
  describeOrigin,
  type GraphView,
  STATE_LABEL,
} from "./model";

/**
 * Product map canvas (internal name Product Graph). Area nodes on an elevated canvas. The border
 * encodes the area's relationship to the Change (see LEGEND). Edges read left to right, from the
 * dependent area to the area it depends on, with a small label. The layout is static: no edge
 * animation, no dragging, and the view fits once per visible set.
 */

const STATE_BORDER: Record<AreaState, string> = {
  new: "border border-accent-500 bg-kumo-info-tint",
  affected: "border border-kumo-ink",
  protected: "border border-dashed border-kumo-ink",
  unchanged: "border border-kumo-divider",
};

const LEGEND: AreaState[] = ["new", "affected", "protected", "unchanged"];

type AreaNodeData = { area: AreaView; selected: boolean; onSelect: (id: string) => void };
type AreaFlowNode = Node<AreaNodeData, "area">;

function metaLine(area: AreaView): string {
  const parts: string[] = [];
  if (area.touched) {
    parts.push(`${formatNumber(area.tasks.length)} task${area.tasks.length === 1 ? "" : "s"}`);
  } else if (area.node.protectedResources.length > 0) {
    parts.push(area.node.protectedResources.join(", "));
  } else {
    parts.push(area.node.baselineFile ?? "not touched");
  }
  if (area.conflicts.length > 0) {
    parts.push(
      `${formatNumber(area.conflicts.length)} conflict${area.conflicts.length > 1 ? "s" : ""}`,
    );
  }
  return parts.join(" · ");
}

function AreaNode({ data }: NodeProps<AreaFlowNode>) {
  const { area, selected, onSelect } = data;
  const kicker =
    area.state === "protected" && area.touched
      ? "Must not change · touched"
      : STATE_LABEL[area.state];
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${area.node.name}, ${kicker}`}
      onClick={() => onSelect(area.node.id)}
      className={cn(
        "grid w-[200px] cursor-pointer gap-1 rounded-lg bg-kumo-base px-3 py-2.5 text-left transition-colors duration-150 hover:bg-kumo-row-hover",
        STATE_BORDER[area.state],
      )}
      style={selected ? SELECTED : undefined}
    >
      <Handle type="target" position={Position.Left} className="opacity-0!" />
      <span
        className={cn(
          "truncate text-[12px]",
          area.state === "new" ? "text-kumo-accent" : "text-kumo-subtle",
        )}
      >
        {kicker}
      </span>
      <span className="truncate text-[14px] leading-tight font-semibold">{area.node.name}</span>
      <span className="truncate text-[12px] text-kumo-subtle" title={metaLine(area)}>
        {metaLine(area)}
      </span>
      <Handle type="source" position={Position.Right} className="opacity-0!" />
    </button>
  );
}

/** Selected node: a 2px accent outline outside the state border. */
const SELECTED: CSSProperties = {
  outline: "2px solid var(--color-accent-500)",
  outlineOffset: 2,
};

const nodeTypes = { area: AreaNode };

const EDGE_RELEVANT: CSSProperties = {
  stroke: "var(--color-kumo-ink)",
  strokeWidth: 2,
  vectorEffect: "non-scaling-stroke",
};
const EDGE_QUIET: CSSProperties = {
  stroke: "var(--color-kumo-divider)",
  strokeWidth: 1,
  strokeDasharray: "4 3",
  vectorEffect: "non-scaling-stroke",
};
const EDGE_LABEL: CSSProperties = {
  fontSize: 12,
  fill: "var(--color-kumo-ink)",
};
const EDGE_LABEL_BG: CSSProperties = { fill: "var(--color-kumo-elevated)" };

export function ProductGraphCanvas({
  view,
  selectedId,
  onSelect,
}: {
  view: GraphView;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const nodes: AreaFlowNode[] = view.areas.map((area) => ({
      id: area.node.id,
      type: "area",
      position: view.positions.get(area.node.id) ?? { x: 0, y: 0 },
      data: { area, selected: area.node.id === selectedId, onSelect },
      draggable: false,
    }));
    const edges: Edge[] = view.edges.map(({ edge, relevant }) => {
      const highlighted = relevant || edge.source === selectedId || edge.target === selectedId;
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        labelStyle: EDGE_LABEL,
        labelBgStyle: EDGE_LABEL_BG,
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
        // Static map: no marching-ants edges (spec Appendix B).
        animated: false,
        style: highlighted ? EDGE_RELEVANT : EDGE_QUIET,
        ariaLabel: `${edge.source} to ${edge.target}: ${edge.label}. ${edge.origins.map(describeOrigin).join("; ")}`,
      };
    });
    return { nodes, edges };
  }, [view, selectedId, onSelect]);

  return (
    <figure className="grid min-w-0 gap-2">
      <div
        className="w-full overflow-hidden rounded-lg border border-kumo-rule bg-kumo-elevated"
        style={{ height: "clamp(340px, 48vw, 520px)" }}
      >
        <ReactFlow
          // Remount when the visible set changes, so the one fitView frames every area. fitView
          // has no duration, so the frame jumps rather than animates.
          key={nodes.map((n) => n.id).join(",")}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.14, minZoom: 0.2 }}
          minZoom={0.2}
          style={{ background: "transparent" }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
          colorMode="light"
          nodesFocusable={false}
          panOnScroll={false}
          zoomOnDoubleClick={false}
          aria-label="Product map"
        />
      </div>
      <figcaption className="grid gap-1.5">
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12px]" aria-label="Legend">
          {LEGEND.map((state) => (
            <li key={state} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn("size-3 rounded-sm bg-kumo-base", STATE_BORDER[state])}
              />
              {STATE_LABEL[state]}
            </li>
          ))}
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="h-0.5 w-4 bg-kumo-ink" />
            Affected dependency
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="w-4 border-t border-dashed border-kumo-divider" />
            Other dependency
          </li>
        </ul>
        <p className="max-w-[760px] text-[12px] text-kumo-subtle">
          Arrows point from an area to the area it depends on. Select an area to see its details.
        </p>
      </figcaption>
    </figure>
  );
}
