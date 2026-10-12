import { formatClock } from "../../../../lib/format";
import type { ActivityEvent } from "../../../agents/activity-model";
import type {
  ClaimHolding,
  FileActivity,
  FileTouch,
  FlightState,
  ResourceActivity,
  TaskState,
} from "../../flight-model";
import type { EntityRef, FlightFilters } from "../../flight-store";

/**
 * Pure read helpers for the codebase heatmap. Rows are recorded files or semantic
 * resources; columns are equal time buckets from the first recorded fact to the fold instant.
 * A cell counts recorded touches (Intent expected files, ChangeSet changed files, Claim facts)
 * inside its bucket. Nothing is interpolated: an empty bucket is an empty cell.
 */

export type Axis = { start: number; end: number; span: number; count: number };

export function axisOf(start: number, end: number, count: number): Axis {
  const width = Math.max(1, end - start);
  return { start, end: start + width, span: width / count, count };
}

const bucketOf = (axis: Axis, at: number) =>
  Math.min(axis.count - 1, Math.max(0, Math.floor((at - axis.start) / axis.span)));

export const bucketStart = (axis: Axis, index: number) => axis.start + index * axis.span;

/** 24-hour clock of an epoch ms instant. */
export const clockOf = (ms: number) => formatClock(new Date(ms).toISOString());

/** Intensity step 1..5 from the number of touches in one bucket. */
const levelOf = (n: number) => Math.min(5, Math.max(1, n)) as 1 | 2 | 3 | 4 | 5;

/* --------------------------------------------------------------------------------------------
 * Filters
 * ------------------------------------------------------------------------------------------ */

/** True when the Task passes the page's tier and activity filters. */
function taskPasses(task: TaskState | undefined, filters: FlightFilters) {
  if (!task) return filters.tiers.length === 0 && !filters.activeOnly;
  if (filters.activeOnly && !task.lane.forked) return false;
  if (filters.tiers.length > 0) {
    const tiers = new Set<string>(filters.tiers);
    const tier = task.lane.tier;
    if (!task.runs.some((r) => tiers.has(r.tier)) && !(tier !== null && tiers.has(tier))) {
      return false;
    }
  }
  return true;
}

const keysOf = (state: FlightState, taskIds: string[]) =>
  taskIds.map((id) => state.tasks[id]?.key ?? id);

/* --------------------------------------------------------------------------------------------
 * Animation: which touches newly played
 * ------------------------------------------------------------------------------------------ */

/**
 * Returns a lookup from a changed touch to the id of the newly played fact that recorded it (the
 * ChangeSet proposal, its composition, or the run end that published it). Only those cells fill
 * with motion; settled cells render still.
 */
export function animationOf(state: FlightState, animated: ReadonlySet<string>) {
  const byChangeSet = new Map<string, string>();
  const runEnds: { taskId: string; at: number; id: string }[] = [];
  if (animated.size > 0) {
    for (const event of state.events) {
      if (!animated.has(event.id)) continue;
      if (event.kind === "changeset") byChangeSet.set(event.changeSetId, event.id);
      else if (event.kind === "fact" && event.eventType === "changeset.proposed") {
        const id = event.data?.changeSetId;
        if (typeof id === "string") byChangeSet.set(id, event.id);
        else if (event.laneId) runEnds.push({ taskId: event.laneId, at: event.at, id: event.id });
      } else if (event.kind === "run.end" && event.status === "completed") {
        runEnds.push({ taskId: event.laneId, at: event.at, id: event.id });
      }
    }
  }
  return (touch: FileTouch): string | null => {
    if (touch.kind !== "changed") return null;
    if (touch.changeSetId) {
      const id = byChangeSet.get(touch.changeSetId);
      if (id) return id;
    }
    return (
      runEnds.find((r) => r.taskId === touch.taskId && Math.abs(r.at - touch.at) <= 5_000)?.id ??
      null
    );
  };
}

/* --------------------------------------------------------------------------------------------
 * Files layer
 * ------------------------------------------------------------------------------------------ */

export type FileCell = {
  index: number;
  touches: FileTouch[];
  changed: number;
  level: 1 | 2 | 3 | 4 | 5;
  /** The most relevant entity in the bucket: a ChangeSet, else the Task. */
  target: EntityRef;
  label: string;
  /** Id of the newly played fact behind this cell, if any. */
  animateKey: string | null;
};

export type FileRow = {
  file: FileActivity;
  /** Touches left after the tier and activity filters. */
  touches: FileTouch[];
  cells: FileCell[];
  taskKeys: string[];
  churn: number;
};

export type FileGroup = {
  area: string;
  rows: FileRow[];
  touches: number;
  adds: number;
  dels: number;
};

export type FileSort = "activity" | "path" | "churn";

function fileCells(
  state: FlightState,
  file: FileActivity,
  touches: FileTouch[],
  axis: Axis,
  animate: (t: FileTouch) => string | null,
): FileCell[] {
  const buckets = new Map<number, FileTouch[]>();
  for (const touch of touches) {
    const i = bucketOf(axis, touch.at);
    buckets.set(i, [...(buckets.get(i) ?? []), touch]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, list]) => {
      const changed = list.filter((t) => t.kind === "changed");
      const latest = changed.at(-1) ?? list.at(-1);
      const target: EntityRef = latest?.changeSetId
        ? { kind: "changeset", id: latest.changeSetId }
        : { kind: "task", id: latest?.taskId ?? "" };
      const words: string[] = [];
      const changedKeys = [
        ...new Set(
          keysOf(
            state,
            changed.map((t) => t.taskId),
          ),
        ),
      ];
      const expectedKeys = [
        ...new Set(
          keysOf(
            state,
            list.filter((t) => t.kind === "expected").map((t) => t.taskId),
          ),
        ),
      ];
      if (changedKeys.length > 0) words.push(`changed by ${changedKeys.join(", ")}`);
      if (expectedKeys.length > 0) words.push(`expected by ${expectedKeys.join(", ")}`);
      let animateKey: string | null = null;
      for (const t of changed) animateKey = animate(t) ?? animateKey;
      return {
        index,
        touches: list,
        changed: changed.length,
        level: levelOf(list.length),
        target,
        label: `${file.path}, ${clockOf(bucketStart(axis, index))}, ${words.join("; ")}`,
        animateKey,
      };
    });
}

function matchesFile(state: FlightState, file: FileActivity, q: string) {
  if (!q) return true;
  if (file.path.toLowerCase().includes(q) || file.area.toLowerCase().includes(q)) return true;
  return file.taskIds.some((id) => {
    const t = state.tasks[id];
    return !!t && (t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q));
  });
}

export function fileGroups(
  state: FlightState,
  axis: Axis,
  filters: FlightFilters,
  sort: FileSort,
  workspaceLoaded: boolean,
  animate: (t: FileTouch) => string | null,
): FileGroup[] {
  const q = filters.query.trim().toLowerCase();
  const rows: FileRow[] = [];
  for (const file of state.files) {
    if (!matchesFile(state, file, q)) continue;
    const touches = file.touches.filter(
      (t) =>
        (workspaceLoaded || t.kind === "expected") && taskPasses(state.tasks[t.taskId], filters),
    );
    if (touches.length === 0) continue;
    rows.push({
      file,
      touches,
      cells: fileCells(state, file, touches, axis, animate),
      taskKeys: [...new Set(keysOf(state, [...new Set(touches.map((t) => t.taskId))]))],
      churn: file.adds + file.dels,
    });
  }
  const compare = (a: FileRow, b: FileRow) => {
    if (sort === "path") return a.file.path.localeCompare(b.file.path);
    if (sort === "churn") return b.churn - a.churn || a.file.path.localeCompare(b.file.path);
    return b.touches.length - a.touches.length || a.file.path.localeCompare(b.file.path);
  };
  const groups = new Map<string, FileGroup>();
  for (const row of rows) {
    const g = groups.get(row.file.area) ?? {
      area: row.file.area,
      rows: [],
      touches: 0,
      adds: 0,
      dels: 0,
    };
    g.rows.push(row);
    g.touches += row.touches.length;
    g.adds += row.file.adds;
    g.dels += row.file.dels;
    groups.set(row.file.area, g);
  }
  const list = [...groups.values()];
  for (const g of list) g.rows.sort(compare);
  list.sort((a, b) => {
    if (sort === "path") return a.area.localeCompare(b.area);
    if (sort === "churn")
      return b.adds + b.dels - (a.adds + a.dels) || a.area.localeCompare(b.area);
    return b.touches - a.touches || a.area.localeCompare(b.area);
  });
  return list;
}

/* --------------------------------------------------------------------------------------------
 * Resources layer
 * ------------------------------------------------------------------------------------------ */

export type ResourceCell = {
  index: number;
  claims: Extract<ActivityEvent, { kind: "claim" }>[];
  conflictIds: string[];
  level: 1 | 2 | 3 | 4 | 5;
  target: EntityRef;
  label: string;
};

export type ResourceRow = {
  resource: ResourceActivity;
  cells: ResourceCell[];
  taskKeys: string[];
  /** Active Claims at the fold instant. */
  holders: ClaimHolding[];
  activity: number;
};

const CLAIM_WORDS: Record<string, string> = {
  acquired: "claimed",
  renewed: "renewed",
  released: "released",
  expired: "expired",
};

function matchesResource(state: FlightState, r: ResourceActivity, q: string) {
  if (!q) return true;
  if (r.resource.toLowerCase().includes(q)) return true;
  if (r.claimedBy.some((a) => a.toLowerCase().includes(q))) return true;
  return r.taskIds.some((id) => {
    const t = state.tasks[id];
    return !!t && (t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q));
  });
}

export function resourceRows(
  state: FlightState,
  axis: Axis,
  filters: FlightFilters,
  sort: FileSort,
): ResourceRow[] {
  const q = filters.query.trim().toLowerCase();
  const eventAt = new Map(state.events.map((e) => [e.id, e.at]));
  const filtering = filters.tiers.length > 0 || filters.activeOnly;
  const rows: ResourceRow[] = [];
  for (const r of state.resources) {
    if (!matchesResource(state, r, q)) continue;
    const claims = state.events.filter(
      (e): e is Extract<ActivityEvent, { kind: "claim" }> =>
        e.kind === "claim" &&
        e.resource === r.resource &&
        (!filtering || taskPasses(e.laneId ? state.tasks[e.laneId] : undefined, filters)),
    );
    const taskIds = r.taskIds.filter((id) => !filtering || taskPasses(state.tasks[id], filters));
    if (filtering && taskIds.length === 0 && claims.length === 0) continue;
    const buckets = new Map<number, { claims: typeof claims; conflictIds: string[] }>();
    const slot = (i: number) => {
      const s = buckets.get(i) ?? { claims: [], conflictIds: [] };
      buckets.set(i, s);
      return s;
    };
    for (const c of claims) slot(bucketOf(axis, c.at)).claims.push(c);
    for (const id of r.conflictIds) {
      const conflict = state.conflicts.find((c) => c.id === id);
      const at = conflict ? eventAt.get(conflict.eventId) : undefined;
      if (at !== undefined) slot(bucketOf(axis, at)).conflictIds.push(id);
    }
    const cells: ResourceCell[] = [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, s]) => {
        const words: string[] = [];
        if (s.conflictIds.length > 0) words.push("conflict detected");
        for (const c of s.claims) {
          words.push(`${CLAIM_WORDS[c.action] ?? c.action} by ${c.actor}`);
        }
        const latest = s.claims.at(-1);
        const conflictId = s.conflictIds[0];
        const target: EntityRef = conflictId
          ? { kind: "conflict", id: conflictId }
          : latest?.laneId
            ? { kind: "task", id: latest.laneId }
            : { kind: "event", id: latest?.id ?? "" };
        return {
          index,
          claims: s.claims,
          conflictIds: s.conflictIds,
          level: levelOf(s.claims.length + s.conflictIds.length),
          target,
          label: `${r.resource}, ${clockOf(bucketStart(axis, index))}, ${words.join("; ")}`,
        };
      });
    rows.push({
      resource: r,
      cells,
      taskKeys: keysOf(state, taskIds),
      holders: state.claims.filter((c) => c.resource === r.resource && c.status === "active"),
      activity: claims.length + r.conflictIds.length,
    });
  }
  rows.sort((a, b) => {
    if (sort === "activity") {
      return b.activity - a.activity || a.resource.resource.localeCompare(b.resource.resource);
    }
    if (sort === "churn") {
      return (
        b.resource.taskIds.length - a.resource.taskIds.length ||
        a.resource.resource.localeCompare(b.resource.resource)
      );
    }
    return a.resource.resource.localeCompare(b.resource.resource);
  });
  return rows;
}
