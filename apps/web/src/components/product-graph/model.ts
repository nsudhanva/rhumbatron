import type { ProductGraph, ProductGraphEdge, ProductGraphNode } from "../../lib/api";

/**
 * Product Graph view model (AGENTS.md 28, 38.3; DESIGN.md 9.13). Pure functions: the graph the
 * API derived, a zoom level and a Change in, the visible subgraph with node states and a
 * deterministic layered layout out.
 *
 * Node states (border):
 *   protected  the area holds a policy protected resource (dashed ink), touched or not
 *   new        touched by the scope, absent from the seeded source and from earlier Changes (accent)
 *   affected   touched by the scope and already present (ink)
 *   unchanged  not touched; shown because it is next to a touched area (1px divider)
 */

export type Zoom = "project" | "change";
export type AreaState = "new" | "affected" | "protected" | "unchanged";

type Touch = ProductGraphNode["touches"][number];

export type AreaView = {
  node: ProductGraphNode;
  state: AreaState;
  touched: boolean;
  /** Touches inside the zoom scope (one Change, or every listed Change). */
  touches: Touch[];
  resources: string[];
  tasks: Touch["tasks"];
  conflicts: ProductGraphNode["conflicts"];
  /** First listed Change that touched the area, oldest first. */
  firstChangeId: string | null;
};

export type EdgeView = { edge: ProductGraphEdge; relevant: boolean };

export type GraphView = {
  areas: AreaView[];
  edges: EdgeView[];
  hiddenAreas: ProductGraphNode[];
  hiddenEdges: number;
  positions: Map<string, { x: number; y: number }>;
};

export const STATE_LABEL: Record<AreaState, string> = {
  new: "New",
  affected: "Affected",
  protected: "Protected",
  unchanged: "Unchanged",
};

const STATE_ORDER: Record<AreaState, number> = { new: 0, affected: 1, protected: 2, unchanged: 3 };

const COLUMN_GAP = 340;
const ROW_GAP = 150;

export function buildView(
  graph: ProductGraph,
  zoom: Zoom,
  changeId: string | undefined,
): GraphView {
  const order = graph.changes.map((c) => c.id);
  const scope = new Set(zoom === "change" && changeId ? [changeId] : order);
  const selectedIndex = changeId ? order.indexOf(changeId) : -1;
  const earlier = new Set(zoom === "change" ? order.slice(0, Math.max(selectedIndex, 0)) : []);

  const all = graph.nodes.map((node): AreaView => {
    const touches = node.touches.filter((t) => scope.has(t.changeId));
    const touched = touches.length > 0;
    const seenBefore = node.touches.some((t) => earlier.has(t.changeId));
    const state: AreaState =
      node.protectedResources.length > 0
        ? "protected"
        : !touched
          ? "unchanged"
          : node.baseline || seenBefore
            ? "affected"
            : "new";
    const first = order.find((id) => node.touches.some((t) => t.changeId === id)) ?? null;
    return {
      node,
      state,
      touched,
      touches,
      resources: [...new Set(touches.flatMap((t) => t.resources))].sort(),
      tasks: touches.flatMap((t) => t.tasks),
      conflicts: node.conflicts.filter((c) => scope.has(c.changeId)),
      firstChangeId: first,
    };
  });

  const touchedIds = new Set(all.filter((a) => a.touched).map((a) => a.node.id));
  let visibleIds: Set<string>;
  if (zoom === "project") {
    visibleIds = new Set(all.map((a) => a.node.id));
  } else {
    // The affected subgraph: touched areas, protected areas, and their direct neighbours.
    visibleIds = new Set(touchedIds);
    for (const a of all) if (a.state === "protected") visibleIds.add(a.node.id);
    for (const e of graph.edges) {
      if (touchedIds.has(e.source)) visibleIds.add(e.target);
      if (touchedIds.has(e.target)) visibleIds.add(e.source);
    }
  }

  const areas = all.filter((a) => visibleIds.has(a.node.id));
  const edges = graph.edges
    .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
    .map((edge) => ({
      edge,
      relevant:
        edge.changeIds.some((id) => scope.has(id)) ||
        (touchedIds.has(edge.source) && touchedIds.has(edge.target)),
    }));

  return {
    areas,
    edges,
    hiddenAreas: graph.nodes.filter((n) => !visibleIds.has(n.id)),
    hiddenEdges: graph.edges.length - edges.length,
    positions: layout(areas, edges),
  };
}

/**
 * Layered layout: an area sits one column right of the rightmost area that depends on it, so
 * edges read left to right (dependent → dependency). Cycles are cut where the walk meets them.
 * Inside a column: new, affected, protected, unchanged, then by name. Columns centre vertically.
 */
function layout(areas: AreaView[], edges: EdgeView[]) {
  const ids = areas.map((a) => a.node.id);
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const { edge } of edges) incoming.get(edge.target)?.push(edge.source);

  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let r = 0;
    for (const src of incoming.get(id) ?? []) r = Math.max(r, rankOf(src) + 1);
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const id of [...ids].sort()) rankOf(id);

  const columns = new Map<number, AreaView[]>();
  for (const a of areas) {
    const r = rank.get(a.node.id) ?? 0;
    columns.set(r, [...(columns.get(r) ?? []), a]);
  }
  const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length));
  const positions = new Map<string, { x: number; y: number }>();
  for (const [r, column] of columns) {
    column.sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.node.name.localeCompare(b.node.name),
    );
    const offset = ((tallest - column.length) * ROW_GAP) / 2;
    column.forEach((a, i) => {
      positions.set(a.node.id, { x: r * COLUMN_GAP, y: offset + i * ROW_GAP });
    });
  }
  return positions;
}

/** One line on where an edge came from, for the inspector and edge titles. */
export function describeOrigin(origin: ProductGraphEdge["origins"][number]): string {
  switch (origin.kind) {
    case "fixture_import":
    case "source_import":
      return `${origin.file} imports ${origin.detail}`;
    case "task_dependency":
      return `Task ${origin.taskKey} depends on Task ${origin.dependsOnTaskKey}`;
    case "shared_task":
      return `Task ${origin.taskKey} touches ${origin.resources.join(", ")}`;
  }
}
