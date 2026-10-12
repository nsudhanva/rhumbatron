import { renderNow } from "../../lib/render-time";
/**
 * Shared DAG view model for the Agents and Events graphs.
 * Pure functions: node and edge specs in, highlight sets and filter matches out. Layout lives with
 * each graph, because each knows its own lanes.
 */

/** Node border: accent = new or needs attention, ink = in scope, dashed, quiet. */
export type DagBorder = "accent" | "ink" | "dashed" | "divider";

export type DagNodeSpec = {
  id: string;
  position: { x: number; y: number };
  /** Small uppercase line over the title: the node kind. */
  kicker: string;
  title: string;
  /** Mono meta line under the title. */
  meta?: string;
  /** Domain status for a status pill (status is a word, not only a color). */
  status?: string | undefined;
  border: DagBorder;
  /** Title in mono, for machine-written titles such as event types. */
  monoTitle?: boolean;
  /** Text color of the title, for event type tones. */
  titleClass?: string;
  width?: number;
  /** Replay: not recorded yet at the playhead. The node keeps its place but does not show. */
  hidden?: boolean;
  /** Model tier letter badge of an agent at work (H, S, O). */
  tier?: "haiku" | "sonnet" | "opus" | null;
  /** An agent at work: a pulsing status square and, when known, a progress line (0 to 1). */
  working?: boolean;
  progress?: number | null;
};

/**
 * Edge styles. `flow` and `cause` are directed and define ancestors and descendants; `sequence`
 * is the time order inside one lane; conflict edges join two Tasks and are not directed.
 */
export type DagEdgeKind =
  | "flow"
  | "cause"
  | "sequence"
  | "conflict_confirmed"
  | "conflict_fork"
  | "conflict_suspected"
  | "conflict_dismissed";

export type DagEdgeSpec = {
  id: string;
  source: string;
  target: string;
  kind: DagEdgeKind;
  label?: string;
  /** Replay: not recorded yet at the playhead. */
  hidden?: boolean;
};

export const isConflictEdge = (kind: DagEdgeKind) => kind.startsWith("conflict_");

/**
 * The selected node, every ancestor and every descendant along directed edges. Conflict edges
 * add the Task on the other side, but do not walk on from it.
 */
export function lineage(edges: readonly DagEdgeSpec[], id: string): Set<string> {
  const down = new Map<string, string[]>();
  const up = new Map<string, string[]>();
  const partners: string[] = [];
  for (const e of edges) {
    if (isConflictEdge(e.kind)) {
      if (e.source === id) partners.push(e.target);
      if (e.target === id) partners.push(e.source);
      continue;
    }
    down.set(e.source, [...(down.get(e.source) ?? []), e.target]);
    up.set(e.target, [...(up.get(e.target) ?? []), e.source]);
  }
  const seen = new Set<string>([id]);
  const walk = (start: string, next: Map<string, string[]>) => {
    const stack = [start];
    while (stack.length > 0) {
      const at = stack.pop() as string;
      for (const n of next.get(at) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
  };
  walk(id, down);
  walk(id, up);
  for (const p of partners) seen.add(p);
  return seen;
}

/* ------------------------------------------------------------------------------------------ */
/* Filters                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export const TIME_RANGES = {
  all: { label: "Any time", ms: null },
  "1h": { label: "Last hour", ms: 3_600_000 },
  "24h": { label: "Last 24 hours", ms: 86_400_000 },
  "7d": { label: "Last 7 days", ms: 7 * 86_400_000 },
} as const;
export type TimeRange = keyof typeof TIME_RANGES;

export function inTimeRange(iso: string | null | undefined, range: TimeRange, now = renderNow()) {
  const ms = TIME_RANGES[range].ms;
  if (ms === null) return true;
  if (!iso) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && now - at <= ms;
}

/** Event type groups for the filter, by the head of the event type. */
export const EVENT_GROUPS = {
  planning: { label: "Planning", heads: ["project", "change", "task"] },
  agents: { label: "Agents", heads: ["agent", "model", "claim", "intent", "changeset"] },
  conflicts: { label: "Conflicts", heads: ["challenge", "conflict"] },
  verification: {
    label: "Verification",
    heads: ["candidate", "verification", "test", "security", "performance", "preview"],
  },
  release: {
    label: "Release",
    heads: ["approval", "canonical", "artifact", "build", "deployment", "release", "app"],
  },
} as const;
export type EventGroup = keyof typeof EVENT_GROUPS;

export function eventGroupOf(eventType: string): EventGroup | "other" {
  const head = eventType.split(".")[0] ?? "";
  for (const [key, group] of Object.entries(EVENT_GROUPS)) {
    if ((group.heads as readonly string[]).includes(head)) return key as EventGroup;
  }
  return "other";
}

/** Filter state shared by both graphs. `null` means every value. */
export type DagFilter = {
  person: string | null;
  changeId: string | null;
  /** A Task ID; on the Agents page a Task and its agent are one choice. */
  taskId: string | null;
  group: EventGroup | null;
  range: TimeRange;
};

export const EMPTY_FILTER: DagFilter = {
  person: null,
  changeId: null,
  taskId: null,
  group: null,
  range: "all",
};

export const filterActive = (f: DagFilter) =>
  f.person !== null ||
  f.changeId !== null ||
  f.taskId !== null ||
  f.group !== null ||
  f.range !== "all";
