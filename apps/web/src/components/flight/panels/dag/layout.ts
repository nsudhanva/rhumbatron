import type { DependencyState, FlightState, RunState, TaskState } from "../../flight-model";
import type { FlightFilters } from "../../flight-store";

/**
 * Deterministic Execution DAG layout (no dagre): column = Work Graph layer (left to right),
 * row = index within the layer, ordered by Task key then id so the graph never reshuffles
 * between folds. Expanded nodes grow by their detail rows and push the rest of the column down.
 *
 * Grouped mode stacks one band per semantic resource (the Task's first resource). Columns keep
 * the global layer so parallel branches still line up across bands.
 */

export const NODE_W = 220;
/** Height of a collapsed node: four fixed text rows, padding and the progress line. */
export const NODE_H = 92;
/** One detail row of an expanded node (24px pointer target). */
export const DETAIL_ROW = 24;
const DETAIL_PAD = 8;
const GAP_X = 64;
const GAP_Y = 14;
const GROUP_PAD = 12;
const GROUP_HEADER = 30;
const GROUP_GAP = 18;
const NO_RESOURCE = "No semantic resource";

export type DetailRow =
  | { kind: "attempt"; run: RunState }
  | { kind: "no-attempt" }
  | { kind: "files"; expected: number; changed: number }
  | { kind: "claims"; resources: string[] }
  | { kind: "changesets"; ids: string[] }
  | { kind: "candidates"; items: { id: string; letter: string }[] }
  | { kind: "waits"; deps: { id: string; key: string; status: string; edgeId: string }[] };

/** Rows an expanded node shows. Layout and the node both read this, so heights always agree. */
export function detailRows(state: FlightState, task: TaskState): DetailRow[] {
  const rows: DetailRow[] =
    task.runs.length > 0
      ? task.runs.map((run) => ({ kind: "attempt" as const, run }))
      : [{ kind: "no-attempt" }];
  rows.push({
    kind: "files",
    expected: task.files.expected.length,
    changed: new Set(task.files.changed.map((f) => f.path)).size,
  });
  rows.push({ kind: "claims", resources: task.claims });
  rows.push({ kind: "changesets", ids: task.changeSets.map((cs) => cs.id) });
  rows.push({
    kind: "candidates",
    items: task.candidateIds.map((id) => ({ id, letter: state.candidates[id]?.letter ?? id })),
  });
  if (task.dependsOn.length > 0) {
    rows.push({
      kind: "waits",
      deps: task.dependsOn.map((id) => ({
        id,
        key: state.tasks[id]?.key ?? id,
        status: state.tasks[id]?.status ?? "pending",
        edgeId: `${id}->${task.id}`,
      })),
    });
  }
  return rows;
}

const nodeHeight = (rows: number | null) =>
  rows === null ? NODE_H : NODE_H + DETAIL_PAD + rows * DETAIL_ROW;

type PlacedNode = {
  id: string;
  /** Absolute when `parent` is null, relative to the group otherwise. */
  x: number;
  y: number;
  w: number;
  h: number;
  parent: string | null;
};

type PlacedGroup = {
  id: string;
  resource: string;
  x: number;
  y: number;
  w: number;
  h: number;
  taskIds: string[];
};

type DagLayout = { nodes: PlacedNode[]; groups: PlacedGroup[] };

const byLayerThenKey = (a: TaskState, b: TaskState) =>
  a.layer - b.layer || a.key.localeCompare(b.key) || a.id.localeCompare(b.id);

/** Places tasks in columns by layer; returns positions relative to (0, 0) and the column heights. */
function placeColumns(tasks: TaskState[], heights: Map<string, number>, originX: number) {
  const columnY = new Map<number, number>();
  const placed: { id: string; x: number; y: number; w: number; h: number }[] = [];
  for (const task of tasks) {
    const y = columnY.get(task.layer) ?? 0;
    const h = heights.get(task.id) ?? NODE_H;
    placed.push({ id: task.id, x: originX + task.layer * (NODE_W + GAP_X), y, w: NODE_W, h });
    columnY.set(task.layer, y + h + GAP_Y);
  }
  const height = Math.max(0, ...[...columnY.values()].map((y) => y - GAP_Y));
  return { placed, height };
}

export function layoutDag(
  state: FlightState,
  expanded: ReadonlySet<string>,
  grouped: boolean,
): DagLayout {
  const tasks = state.taskOrder
    .map((id) => state.tasks[id])
    .filter((t): t is TaskState => !!t)
    .sort(byLayerThenKey);
  const heights = new Map(
    tasks.map((t) => [t.id, nodeHeight(expanded.has(t.id) ? detailRows(state, t).length : null)]),
  );

  if (!grouped) {
    const { placed } = placeColumns(tasks, heights, 0);
    return { nodes: placed.map((p) => ({ ...p, parent: null })), groups: [] };
  }

  const maxLayer = Math.max(0, ...tasks.map((t) => t.layer));
  const bands = new Map<string, TaskState[]>();
  for (const task of tasks) {
    const resource = task.semanticResources[0] ?? NO_RESOURCE;
    bands.set(resource, [...(bands.get(resource) ?? []), task]);
  }
  const order = [...bands.entries()].sort(
    ([ra, a], [rb, b]) =>
      Math.min(...a.map((t) => t.layer)) - Math.min(...b.map((t) => t.layer)) ||
      (a[0]?.key ?? "").localeCompare(b[0]?.key ?? "") ||
      ra.localeCompare(rb),
  );
  const groupW = (maxLayer + 1) * NODE_W + maxLayer * GAP_X + GROUP_PAD * 2;
  const nodes: PlacedNode[] = [];
  const groups: PlacedGroup[] = [];
  let y = 0;
  for (const [resource, members] of order) {
    const id = `group:${resource}`;
    const { placed, height } = placeColumns(members, heights, GROUP_PAD);
    for (const p of placed) nodes.push({ ...p, y: p.y + GROUP_HEADER, parent: id });
    const h = GROUP_HEADER + height + GROUP_PAD;
    groups.push({
      id,
      resource,
      x: -GROUP_PAD,
      y,
      w: groupW,
      h,
      taskIds: members.map((t) => t.id),
    });
    y += h + GROUP_GAP;
  }
  return { nodes, groups };
}

/** True when the Task passes the page filters. Non-matching Tasks are dimmed, never removed. */
export function matchesFilters(task: TaskState, filters: FlightFilters): boolean {
  if (filters.activeOnly && !task.lane.forked) return false;
  if (filters.tiers.length > 0) {
    const tiers = new Set<string>(filters.tiers);
    if (!task.runs.some((r) => tiers.has(r.tier))) return false;
  }
  const query = filters.query.trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    task.key,
    task.title,
    task.kind,
    task.agentId ?? "",
    ...task.semanticResources,
    ...task.claims,
    ...task.files.expected,
    ...task.files.changed.map((f) => f.path),
  ];
  return haystack.some((value) => value.toLowerCase().includes(query));
}

/** The attempt the node shows: the running one, else the latest. */
export const shownRun = (task: TaskState): RunState | null =>
  task.running ?? task.runs[task.runs.length - 1] ?? null;

/** Plain sentence for an edge: tooltip, aria-label and the inspector headline. */
export function describeDependency(state: FlightState, dep: DependencyState): string {
  const from = state.tasks[dep.from];
  const to = state.tasks[dep.to];
  const fromKey = from?.key ?? dep.from;
  const toKey = to?.key ?? dep.to;
  const run = from ? shownRun(from) : null;
  const upstream = from
    ? `${statusWord(from.status)}${run ? `, attempt ${run.attempt} on ${run.tier}` : ", not started"}`
    : "not in this Work Graph";
  switch (dep.status) {
    case "done":
      return `${fromKey} is done; ${toKey} no longer waits on it.`;
    case "failed": {
      const failure = run?.failureKind ? ` (${run.failureKind.replace(/_/g, " ")})` : "";
      return `${fromKey} ${statusWord(from?.status ?? "failed")}${failure}; ${toKey} cannot start until it completes.`;
    }
    case "blocking":
      return `${toKey} waits for ${fromKey} (${upstream}).`;
    case "idle":
      return `${toKey} is ${statusWord(to?.status ?? "pending")} and not waiting on ${fromKey} (${upstream}).`;
  }
}

const WORDS: Record<string, string> = {
  completed: "done",
  failed: "failed",
  blocked: "blocked",
  running: "running",
  assigned: "assigned",
  ready: "ready",
  pending: "queued",
  cancelled: "cancelled",
};

const statusWord = (status: string) => WORDS[status] ?? status.replace(/_/g, " ");
