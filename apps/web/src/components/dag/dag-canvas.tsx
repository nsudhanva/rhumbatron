import { cn } from "@cloudflare/kumo";
import { type Edge, Handle, MarkerType, type Node, type NodeProps, Position } from "@xyflow/react";
import { type CSSProperties, type ReactNode, useMemo } from "react";
import { canvasHeight, ReadableFlow } from "../readable-flow";
import { StatusPill } from "../ui/status-pill";
import {
  type DagBorder,
  type DagEdgeKind,
  type DagEdgeSpec,
  type DagNodeSpec,
  isConflictEdge,
  lineage,
} from "./model";

/**
 * DAG canvas for the Agents and Events graphs (DESIGN.md 9.13): square nodes on an elevated
 * canvas with a 2px ink rule on top, edges left to right. Selecting a node keeps it, its
 * ancestors and its descendants at full strength and dims the rest. The node is a button; the
 * page shows the detail of the selected node in its inspector.
 */

const BORDER: Record<DagBorder, string> = {
  accent: "border-2 border-accent-500",
  ink: "border-2 border-kumo-ink",
  dashed: "border-2 border-dashed border-kumo-ink",
  divider: "border border-kumo-divider",
};

type DagNodeData = {
  spec: DagNodeSpec;
  selected: boolean;
  dimmed: boolean;
};
type DagFlowNode = Node<DagNodeData, "dag">;

const TIER_WORD = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" } as const;
const TIER_LETTER = { haiku: "H", sonnet: "S", opus: "O" } as const;

function DagNode({ data }: NodeProps<DagFlowNode>) {
  const { spec, selected, dimmed } = data;
  const hidden = spec.hidden === true;
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      aria-label={`${spec.kicker}: ${spec.title}${spec.tier ? `, ${TIER_WORD[spec.tier]}` : ""}${spec.meta ? `, ${spec.meta}` : ""}`}
      className={cn(
        "relative grid cursor-pointer gap-1 bg-kumo-base px-3 py-2 text-left transition-[opacity,box-shadow,transform,border-color] duration-(--rh-dur-settle) ease-(--rh-ease-out) hover:bg-kumo-row-hover",
        BORDER[spec.border],
        dimmed && "opacity-30",
        hidden && "pointer-events-none translate-y-1 opacity-0",
      )}
      style={{ width: spec.width ?? 200, ...(selected ? SELECTED : {}) }}
    >
      <Handle type="target" position={Position.Left} className="opacity-0!" />
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          {spec.working && (
            <span aria-hidden className="rh-work-pulse size-1.5 shrink-0 bg-accent-500" />
          )}
          <span
            className={cn(
              "truncate text-[10px] tracking-[0.1em] uppercase",
              spec.border === "accent" ? "text-kumo-accent" : "text-kumo-subtle",
            )}
          >
            {spec.kicker}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {spec.tier && (
            <span
              title={TIER_WORD[spec.tier]}
              className="grid size-4 place-items-center bg-kumo-ink font-mono text-[10px] leading-none font-semibold text-kumo-inverse"
            >
              {TIER_LETTER[spec.tier]}
            </span>
          )}
          {spec.status && <StatusPill status={spec.status} className="shrink-0" />}
        </span>
      </span>
      <span
        className={cn(
          "truncate leading-tight",
          spec.monoTitle
            ? "font-mono text-[12px] font-semibold"
            : "text-[14px] font-extrabold tracking-[-0.01em]",
          spec.titleClass,
        )}
        title={spec.title}
      >
        {spec.title}
      </span>
      {spec.meta && (
        <span className="truncate font-mono text-[11px] text-kumo-subtle" title={spec.meta}>
          {spec.meta}
        </span>
      )}
      {spec.working && spec.progress != null && (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-kumo-recessed">
          <span
            className="block h-full bg-kumo-ink transition-[width] duration-200 ease-linear"
            style={{ width: `${Math.round(spec.progress * 100)}%` }}
          />
        </span>
      )}
      <Handle type="source" position={Position.Right} className="opacity-0!" />
    </button>
  );
}
DagNode.displayName = "DagNode";

/** Selected node: the overlay shadow plus the 2px accent bar the inspector repeats. */
const SELECTED: CSSProperties = {
  boxShadow: "inset 2px 0 0 var(--color-accent-500), var(--rh-shadow-overlay)",
};

const nodeTypes = { dag: DagNode };

/** Rendered height of a DagNode with a meta line, for the canvas height. */
const NODE_HEIGHT = 76;

const STROKE = { vectorEffect: "non-scaling-stroke" } as const;

const EDGE_STYLE: Record<DagEdgeKind, CSSProperties> = {
  flow: { ...STROKE, stroke: "var(--color-kumo-ink)", strokeWidth: 2 },
  cause: { ...STROKE, stroke: "var(--color-kumo-ink)", strokeWidth: 2 },
  sequence: {
    ...STROKE,
    stroke: "var(--color-kumo-divider)",
    strokeWidth: 1,
    strokeDasharray: "4 3",
  },
  conflict_confirmed: {
    ...STROKE,
    stroke: "var(--color-kumo-danger)",
    strokeWidth: 2,
    strokeDasharray: "6 4",
  },
  conflict_fork: {
    ...STROKE,
    stroke: "var(--color-kumo-warning)",
    strokeWidth: 2,
    strokeDasharray: "6 4",
  },
  conflict_suspected: {
    ...STROKE,
    stroke: "var(--color-kumo-ink)",
    strokeWidth: 1.5,
    strokeDasharray: "6 4",
  },
  conflict_dismissed: {
    ...STROKE,
    stroke: "var(--color-kumo-divider)",
    strokeWidth: 1.5,
    strokeDasharray: "6 4",
  },
};

const EDGE_LABEL: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--rh-text-10)",
  fill: "var(--color-kumo-ink)",
};
const EDGE_LABEL_BG: CSSProperties = { fill: "var(--color-kumo-elevated)" };

export type LegendItem = { key: string; label: string; swatch: ReactNode };

/** Legend swatch for a node border. */
export const nodeSwatch = (border: DagBorder) => (
  <span aria-hidden className={cn("size-3 bg-kumo-base", BORDER[border])} />
);

/** Legend swatch for an edge kind. */
export const edgeSwatch = (kind: DagEdgeKind) => {
  const style = EDGE_STYLE[kind];
  return (
    <svg aria-hidden width="18" height="6" className="shrink-0">
      <line
        x1="0"
        y1="3"
        x2="18"
        y2="3"
        stroke={style.stroke}
        strokeWidth={Number(style.strokeWidth)}
        strokeDasharray={style.strokeDasharray as string | undefined}
      />
    </svg>
  );
};

export function DagCanvas({
  label,
  nodes: specs,
  edges: edgeSpecs,
  selectedId,
  onSelect,
  legend,
  caption,
}: {
  /** Accessible name of the canvas. */
  label: string;
  nodes: DagNodeSpec[];
  edges: DagEdgeSpec[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  legend: LegendItem[];
  /** What the graph is derived from and what it hides (DESIGN.md 9.13). */
  caption: ReactNode;
}) {
  const { nodes, edges, height } = useMemo(() => {
    const known = new Set(specs.map((n) => n.id));
    const lit = selectedId && known.has(selectedId) ? lineage(edgeSpecs, selectedId) : null;
    const nodes: DagFlowNode[] = specs.map((spec) => ({
      id: spec.id,
      type: "dag",
      position: spec.position,
      data: {
        spec,
        selected: spec.id === selectedId,
        dimmed: lit !== null && !lit.has(spec.id),
      },
      draggable: false,
    }));
    const edges: Edge[] = edgeSpecs
      .filter((e) => known.has(e.source) && known.has(e.target))
      .map((e) => {
        const dim = lit !== null && !(lit.has(e.source) && lit.has(e.target));
        const conflict = isConflictEdge(e.kind);
        const shown = e.hidden !== true;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: conflict ? "straight" : "default",
          ...(e.label && shown
            ? {
                label: e.label,
                labelStyle: EDGE_LABEL,
                labelBgStyle: EDGE_LABEL_BG,
                labelBgPadding: [4, 2] as [number, number],
                labelBgBorderRadius: 0,
              }
            : {}),
          ...(conflict || e.kind === "sequence"
            ? {}
            : {
                markerEnd: {
                  type: MarkerType.ArrowClosed,
                  width: 14,
                  height: 14,
                  color: "var(--color-kumo-ink)",
                },
              }),
          style: {
            ...EDGE_STYLE[e.kind],
            opacity: shown ? (dim ? 0.15 : 1) : 0,
            transition: `opacity var(--rh-dur-settle) var(--rh-ease-out), stroke var(--rh-dur-greyout) var(--rh-ease-out)`,
          },
          zIndex: conflict ? 1 : 0,
          ariaLabel: `${e.source} to ${e.target}${e.label ? `: ${e.label}` : ""}`,
          ...(shown ? {} : { focusable: false }),
        };
      });
    const height = canvasHeight(
      specs.map((spec) => spec.position.y),
      NODE_HEIGHT,
    );
    return { nodes, edges, height };
  }, [specs, edgeSpecs, selectedId]);

  return (
    <figure className="grid min-w-0 gap-2">
      <ReadableFlow
        // Remount when the node set changes, so the first view frames the graph again.
        key={nodes.map((n) => n.id).join(",")}
        label={label}
        height={height}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onSelect}
      />
      <figcaption className="grid gap-1.5">
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12px]" aria-label="Legend">
          {legend.map((item) => (
            <li key={item.key} className="flex items-center gap-1.5">
              {item.swatch}
              {item.label}
            </li>
          ))}
        </ul>
        <p className="max-w-[820px] text-[11px] text-kumo-subtle">{caption}</p>
      </figcaption>
    </figure>
  );
}
DagCanvas.displayName = "DagCanvas";
