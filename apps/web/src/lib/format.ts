import type { ChangeDetail, TaskDetail, TaskRun } from "./api";

export const DEMO_GOAL =
  "Add shared wishlists. Users can create a wishlist, share it with a link, and let collaborators add or remove products. Keep existing cart behavior unchanged. Keep API p95 below 200 ms.";

/*
 * Number and time formats (DESIGN.md section 12): thousands separators, a space before units,
 * money as $0.00, durations as 48s / 3m 12s / 2 h, relative ages as 7m / 2d / just now, the
 * minus sign (U+2212) for negatives, and an em dash for empty or unknown values.
 */

/** Shown for empty or unknown values. Never "N/A", "null" or a blank. */
export const EMPTY = "\u2014";
const MINUS = "\u2212";

type Maybe<T> = T | null | undefined;

const isMissing = (n: Maybe<number>): n is null | undefined =>
  n === null || n === undefined || Number.isNaN(n);

const withSign = (n: number, body: string) => (n < 0 ? `${MINUS}${body}` : body);

/** `7,200`; `fractionDigits` fixes decimals (`1,204.50`). */
export function formatNumber(n: Maybe<number>, fractionDigits?: number) {
  if (isMissing(n)) return EMPTY;
  const body = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits ?? 0,
    maximumFractionDigits: fractionDigits ?? 2,
  });
  return withSign(n, body);
}

/** A number with its unit: `164 ms`, `412 MB`, `18 %`. */
export function formatUnit(n: Maybe<number>, unit: string, fractionDigits?: number) {
  return isMissing(n) ? EMPTY : `${formatNumber(n, fractionDigits)} ${unit}`;
}

/** Latency or short durations given in milliseconds: `164 ms`, `1.2 s` at one second and up. */
export function formatMs(ms: Maybe<number>, fractionDigits = 0) {
  if (isMissing(ms)) return EMPTY;
  if (Math.abs(ms) >= 1000) return formatDuration(ms / 1000);
  return formatUnit(ms, "ms", fractionDigits);
}

/** `$0.00`, `$1,204.50`, `−$0.40`. */
export function formatUsd(n: Maybe<number>) {
  if (isMissing(n)) return EMPTY;
  return withSign(n, `$${formatNumber(Math.abs(n), 2)}`);
}

/** A change with an explicit sign: `+12`, `−12 ms`. */
export function formatDelta(n: Maybe<number>, unit?: string) {
  if (isMissing(n)) return EMPTY;
  const body = formatNumber(Math.abs(n));
  const sign = n > 0 ? "+" : n < 0 ? MINUS : "";
  return unit ? `${sign}${body} ${unit}` : `${sign}${body}`;
}

/** "used / limit", for example `$1.42 / $3.00` or `3 / 7`. */
export const formatFraction = (used: string, limit: string) => `${used} / ${limit}`;

/** Durations in seconds: `164 ms`, `4.2s`, `48s`, `3m 12s`, `2 h`, `2 h 5m`. */
export function formatDuration(seconds: Maybe<number>) {
  if (isMissing(seconds)) return EMPTY;
  const s = Math.abs(seconds);
  let body: string;
  if (s < 1) body = `${Math.round(s * 1000)} ms`;
  else if (s < 10) body = `${s.toFixed(1)}s`;
  else if (s < 60) body = `${Math.round(s)}s`;
  else if (s < 3600) body = `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  else {
    const minutes = Math.floor((s % 3600) / 60);
    body = `${Math.floor(s / 3600)} h${minutes ? ` ${minutes}m` : ""}`;
  }
  return withSign(seconds, body);
}

/** Relative age: `just now`, `7m`, `5h`, `2d`. */
export function formatAge(iso: Maybe<string>, now = Date.now()) {
  if (!iso) return EMPTY;
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (Number.isNaN(seconds)) return EMPTY;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** Relative age for prose: `just now`, `7m ago`. */
export function timeAgo(iso: string, now = Date.now()) {
  const age = formatAge(iso, now);
  return age === "just now" || age === EMPTY ? age : `${age} ago`;
}

/** 24-hour clock time: `14:03:09`. */
export function formatClock(iso: Maybe<string>) {
  if (!iso) return EMPTY;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EMPTY;
  return date.toLocaleTimeString("en-GB", { hour12: false });
}

/**
 * The plain label of a canonical generation: `Release 1` (docs/ux/research-2026-10-09.md 7.6).
 * The internal code `S1` is `generationCode`, for the Debug view and technical details.
 */
export const generation = (n: number) => `Release ${n}`;
export const generationCode = (n: number) => `S${n}`;

export function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text;
}

export function runDuration(run: TaskRun, now = Date.now()) {
  const end = run.endedAt ? new Date(run.endedAt).getTime() : now;
  return formatDuration(Math.max(0, (end - new Date(run.startedAt).getTime()) / 1000));
}

const ACTIVE_CHANGE = new Set(["created", "compiling", "running"]);
const ACTIVE_TASK = new Set(["ready", "assigned", "running"]);

export function isLive(change: ChangeDetail | undefined, tasks: TaskDetail[] | undefined) {
  if (!change) return true;
  return ACTIVE_CHANGE.has(change.status) || (tasks ?? []).some((t) => ACTIVE_TASK.has(t.status));
}

export const isCompiling = (status: string) => status === "created" || status === "compiling";

/** A running timer: `48s`, `1m 12s`, `2 h 5m`. Whole seconds, so it does not jitter. */
export function elapsed(fromIso: Maybe<string>, now = Date.now()) {
  if (!fromIso) return EMPTY;
  const seconds = Math.floor((now - new Date(fromIso).getTime()) / 1000);
  if (Number.isNaN(seconds)) return EMPTY;
  const s = Math.max(0, seconds);
  return s < 60 ? `${s}s` : formatDuration(s);
}

/** `1 task`, `3 tasks`. */
export const plural = (n: number, word: string, many = `${word}s`) =>
  `${formatNumber(n)} ${n === 1 ? word : many}`;

/**
 * Tasks in dependency order (a task after everything it depends on), ties kept in API order.
 * A cycle cannot occur in a Work Graph, but a defensive pass appends any task left over.
 */
export function topologicalOrder(tasks: TaskDetail[]): TaskDetail[] {
  const ids = new Set(tasks.map((t) => t.id));
  const placed = new Set<string>();
  const out: TaskDetail[] = [];
  let progress = true;
  while (out.length < tasks.length && progress) {
    progress = false;
    for (const task of tasks) {
      if (placed.has(task.id)) continue;
      if (task.dependsOn.every((d) => !ids.has(d) || placed.has(d))) {
        placed.add(task.id);
        out.push(task);
        progress = true;
      }
    }
  }
  for (const task of tasks) if (!placed.has(task.id)) out.push(task);
  return out;
}
