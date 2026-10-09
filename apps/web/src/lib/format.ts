import type { ChangeDetail, TaskDetail, TaskRun } from "./api";

export const DEMO_GOAL =
  "Add shared wishlists. Users can create a wishlist, share it with a link, and let collaborators add or remove products. Keep existing cart behavior unchanged. Keep API p95 below 200 ms.";

export const generation = (n: number) => `S${n}`;

export const formatUsd = (n: number) => `$${n.toFixed(2)}`;

export function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function timeAgo(iso: string, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function runDuration(run: TaskRun, now = Date.now()) {
  const end = run.endedAt ? new Date(run.endedAt).getTime() : now;
  const seconds = Math.max(0, (end - new Date(run.startedAt).getTime()) / 1000);
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

const ACTIVE_CHANGE = new Set(["created", "compiling", "running"]);
const ACTIVE_TASK = new Set(["ready", "assigned", "running"]);

export function isLive(change: ChangeDetail | undefined, tasks: TaskDetail[] | undefined) {
  if (!change) return true;
  return ACTIVE_CHANGE.has(change.status) || (tasks ?? []).some((t) => ACTIVE_TASK.has(t.status));
}

export const isCompiling = (status: string) => status === "created" || status === "compiling";

export const latestRun = (task: TaskDetail): TaskRun | undefined => task.runs[task.runs.length - 1];

export function lastActiveTask(tasks: TaskDetail[]): TaskDetail | undefined {
  let best: TaskDetail | undefined;
  let bestTime = -1;
  for (const task of tasks) {
    const run = latestRun(task);
    const time = run ? new Date(run.endedAt ?? run.startedAt).getTime() : -1;
    if (time > bestTime) {
      best = task;
      bestTime = time;
    }
  }
  return best ?? tasks[0];
}

export function layoutTasks(tasks: TaskDetail[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const layers = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    const cached = layers.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d));
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => depth(d, seen)));
    layers.set(id, value);
    return value;
  };
  for (const t of tasks) depth(t.id, new Set());
  const columns = new Map<number, string[]>();
  for (const t of tasks) {
    const layer = layers.get(t.id) ?? 0;
    columns.set(layer, [...(columns.get(layer) ?? []), t.id]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  const rowHeight = 130;
  const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length));
  for (const [layer, ids] of columns) {
    const offset = ((tallest - ids.length) * rowHeight) / 2;
    for (const [i, id] of ids.entries()) {
      positions.set(id, { x: layer * 300, y: offset + i * rowHeight });
    }
  }
  return positions;
}
