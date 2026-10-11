import { cn } from "@cloudflare/kumo";
import { type Edge, Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { type CSSProperties, type ReactNode, useMemo } from "react";
import { formatNumber } from "../../lib/format";
import { canvasHeight, ReadableFlow } from "../readable-flow";
import {
  type AreaState,
  type AreaView,
  describeOrigin,
  type GraphView,
  STATE_LABEL,
} from "./model";

/**
 * Product Graph canvas (DESIGN.md 9.13): square area nodes on an elevated canvas with a 2px ink
 * rule on top. The border encodes the area's relationship to the Change (see LEGEND). Edges read
 * left to right, from the dependent area to the area it depends on, with a mono label chip.
 */

const STATE_BORDER: Record<AreaState, string> = {
  new: "border-2 border-accent-500",
  affected: "border-2 border-kumo-ink",
  protected: "border-2 border-dashed border-kumo-ink",
  unchanged: "border border-kumo-divider",
};

const LEGEND: { state: AreaState; label: string }[] = [
  { state: "new", label: "New area" },
  { state: "affected", label: "Affected" },
  { state: "protected", label: "Protected invariant" },
  { state: "unchanged", label: "Unchanged dependency" },
];

type AreaNodeData = { area: AreaView; selected: boolean; onSelect: (id: string) => void };
type AreaFlowNode = Node<AreaNodeData, "area">;

function metaLine(area: AreaView): string {
  const parts: string[] = [];
  if (area.touched) {
    parts.push(`${formatNumber(area.resources.length)} resources`);
    parts.push(`${formatNumber(area.tasks.length)} Tasks`);
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
    area.state === "protected" && area.touched ? "Protected · touched" : STATE_LABEL[area.state];
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${area.node.name}, ${kicker}`}
      onClick={() => onSelect(area.node.id)}
      className={cn(
        "grid w-[200px] cursor-pointer gap-1 bg-kumo-base px-3 py-2.5 text-left transition-shadow duration-(--rh-dur-ui) hover:bg-kumo-row-hover",
        STATE_BORDER[area.state],
      )}
      style={selected ? SELECTED : undefined}
    >
      <Handle type="target" position={Position.Left} className="opacity-0!" />
      <span
        className={cn(
          "truncate text-[10px] tracking-[0.1em] uppercase",
          area.state === "new" ? "text-kumo-accent" : "text-kumo-subtle",
        )}
      >
        {kicker}
      </span>
      <span className="truncate text-[14px] leading-tight font-extrabold tracking-[-0.01em]">
        {area.node.name}
      </span>
      <span className="truncate font-mono text-[11px] text-kumo-subtle" title={metaLine(area)}>
        {metaLine(area)}
      </span>
      <Handle type="source" position={Position.Right} className="opacity-0!" />
    </button>
  );
}

/** Selected node: the overlay shadow plus the 2px accent bar the inspector repeats. */
const SELECTED: CSSProperties = {
  boxShadow: "inset 2px 0 0 var(--color-accent-500), var(--rh-shadow-overlay)",
};

const nodeTypes = { area: AreaNode };

/** Rendered height of an AreaNode, for the canvas height. */
const NODE_HEIGHT = 80;

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
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fill: "var(--color-kumo-ink)",
};
const EDGE_LABEL_BG: CSSProperties = { fill: "var(--color-kumo-elevated)" };

export function ProductGraphCanvas({
  view,
  selectedId,
  onSelect,
  caption,
}: {
  view: GraphView;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  /** Footnote under the legend: what the graph is derived from and what is hidden. */
  caption: ReactNode;
}) {
  const { nodes, edges, height } = useMemo(() => {
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
        labelBgBorderRadius: 0,
        style: highlighted ? EDGE_RELEVANT : EDGE_QUIET,
        ariaLabel: `${edge.source} to ${edge.target}: ${edge.label}. ${edge.origins.map(describeOrigin).join("; ")}`,
      };
    });
    const height = canvasHeight(
      nodes.map((n) => n.position.y),
      NODE_HEIGHT,
    );
    return { nodes, edges, height };
  }, [view, selectedId, onSelect]);

  return (
    <figure className="grid min-w-0 gap-2">
      <ReadableFlow
        // Remount when the visible set changes, so the first view frames the areas again.
        key={nodes.map((n) => n.id).join(",")}
        label="Product Graph"
        height={height}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
      />
      <figcaption className="grid gap-1.5">
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12px]" aria-label="Legend">
          {LEGEND.map((item) => (
            <li key={item.state} className="flex items-center gap-1.5">
              <span aria-hidden className={cn("size-3 bg-kumo-base", STATE_BORDER[item.state])} />
              {item.label}
            </li>
          ))}
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="h-0.5 w-4 bg-kumo-ink" />
            Dependency in scope
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="w-4 border-t border-dashed border-kumo-divider" />
            Other dependency
          </li>
        </ul>
        <p className="max-w-[760px] text-[11px] text-kumo-subtle">
          Edges point left to right, from an area to the area it depends on. {caption}
        </p>
      </figcaption>
    </figure>
  );
}
