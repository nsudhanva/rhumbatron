import { Button } from "@cloudflare/kumo";
import { CornersOut, Minus, Plus } from "@phosphor-icons/react";
import {
  type Edge,
  getViewportForBounds,
  type Node,
  type NodeTypes,
  Panel,
  ReactFlow,
  useKeyPress,
  useNodesInitialized,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useLayoutEffect, useRef } from "react";

/**
 * Shared frame for the static XYFlow graphs (Work Graph, Agents and Events graphs, Product
 * Graph). The mouse wheel scrolls the page. Ctrl or Cmd + wheel, a trackpad pinch, or the +/-
 * buttons zoom; a drag pans. The first view frames the graph at a readable zoom: when the graph
 * is wider or taller than the canvas at that zoom, it starts at the first (left, top) node and
 * the viewer pans to the rest.
 */

/** Smallest zoom of the first view: node titles stay readable. */
const READABLE_ZOOM = 0.7;
/** Share of the canvas kept free around the graph in the first view. */
const PADDING = 0.15;
const ZOOM_KEYS = ["Meta", "Control"];
const FIT_ALL = { padding: PADDING, minZoom: 0.2, maxZoom: 1, duration: 150 } as const;

/** Canvas height for a laid-out graph: its rows at zoom 1 plus padding, kept in 240–560px. */
export function canvasHeight(ys: Iterable<number>, nodeHeight: number): number {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const y of ys) {
    min = Math.min(min, y);
    max = Math.max(max, y);
  }
  const content = Number.isFinite(min) ? max - min + nodeHeight : nodeHeight;
  return Math.round(Math.min(560, Math.max(240, content + 96)));
}

/** Sets the first view once, after XYFlow has measured every node. */
function ReadableViewport() {
  const { getNodes, getNodesBounds, setViewport } = useReactFlow();
  const ready = useNodesInitialized();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const done = useRef(false);

  useLayoutEffect(() => {
    if (done.current || !ready || width === 0 || height === 0) return;
    const bounds = getNodesBounds(getNodes());
    if (bounds.width === 0 && bounds.height === 0) return;
    done.current = true;
    const fit = getViewportForBounds(bounds, width, height, READABLE_ZOOM, 1, PADDING);
    const { zoom } = fit;
    const gutterX = (width * PADDING) / 2;
    const gutterY = (height * PADDING) / 2;
    const x = bounds.width * zoom > width - 2 * gutterX ? gutterX - bounds.x * zoom : fit.x;
    const y = bounds.height * zoom > height - 2 * gutterY ? gutterY - bounds.y * zoom : fit.y;
    void setViewport({ x, y, zoom });
  }, [ready, width, height, getNodes, getNodesBounds, setViewport]);

  return null;
}

function ZoomButtons() {
  const flow = useReactFlow();
  return (
    <Panel position="top-right" className="m-2! flex border border-kumo-divider bg-kumo-base">
      <Button
        size="sm"
        variant="ghost"
        shape="square"
        icon={<Minus size={14} />}
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => void flow.zoomOut({ duration: 150 })}
      />
      <Button
        size="sm"
        variant="ghost"
        shape="square"
        icon={<Plus size={14} />}
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => void flow.zoomIn({ duration: 150 })}
      />
      <Button
        size="sm"
        variant="ghost"
        shape="square"
        icon={<CornersOut size={14} />}
        aria-label="Fit the whole graph"
        title="Fit the whole graph"
        onClick={() => void flow.fitView(FIT_ALL)}
      />
    </Panel>
  );
}

export function ReadableFlow<N extends Node>({
  label,
  height,
  nodes,
  edges,
  nodeTypes,
}: {
  /** Accessible name of the canvas. */
  label: string;
  /** Canvas height in px (see canvasHeight). */
  height: number;
  nodes: N[];
  edges: Edge[];
  nodeTypes: NodeTypes;
}) {
  // Cmd + wheel zooms only while Cmd is held; otherwise the wheel stays with the page.
  // Ctrl + wheel and a pinch arrive as ctrlKey wheel events, which XYFlow zooms on its own.
  const metaHeld = useKeyPress("Meta");
  return (
    <>
      <div className="w-full rule-ink bg-kumo-elevated" style={{ height }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          minZoom={0.2}
          maxZoom={1.6}
          zoomOnScroll={false}
          panOnScroll={false}
          preventScrolling={metaHeld}
          zoomActivationKeyCode={ZOOM_KEYS}
          style={{ background: "transparent" }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
          colorMode="light"
          nodesFocusable={false}
          aria-label={label}
        >
          <ReadableViewport />
          <ZoomButtons />
        </ReactFlow>
      </div>
      <p className="text-[11px] text-kumo-subtle">Drag to pan · Ctrl or pinch to zoom</p>
    </>
  );
}
