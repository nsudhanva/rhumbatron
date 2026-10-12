import { MOTION } from "../../lib/motion";

/**
 * Replay pacing: recorded facts replay at a readable pace. At 1x the
 * playhead moves through one minute of recorded time per second, and each pause between two
 * facts is held to `MIN_GAP_MS`–`MAX_GAP_MS` of replay time: a burst of facts plays at the agent
 * cadence, an idle hour passes in about a second. Inside a pause the playhead moves linearly, so
 * bars grow smoothly. With reduced motion the playhead holds at each fact and then steps to the
 * next one. Nothing is invented: every stop is a recorded instant.
 */

export const REPLAY_SPEEDS = [1, 2, 4, 8] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** Recorded milliseconds per replay millisecond at 1x. */
const RECORDED_PER_REPLAY_MS = 60;
const MIN_GAP_MS = MOTION.agentCadenceMs;
const MAX_GAP_MS = 1_500;

/** Sorted unique fact times with the replay offset (1x milliseconds) of each. */
export type ReplaySchedule = {
  times: number[];
  offsets: number[];
  /** Replay length at 1x. */
  total: number;
};

export function buildSchedule(input: readonly number[]): ReplaySchedule {
  const times = [...new Set(input.filter((t) => Number.isFinite(t)))].sort((a, b) => a - b);
  const offsets: number[] = [];
  let total = 0;
  times.forEach((t, i) => {
    offsets.push(total);
    const next = times[i + 1];
    if (next !== undefined) {
      total += Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, (next - t) / RECORDED_PER_REPLAY_MS));
    }
  });
  return { times, offsets, total };
}

/** Index of the last entry `<= value` in an ascending list; -1 when there is none. */
function lastAtOrBefore(list: readonly number[], value: number) {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as number) <= value) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Facts recorded at or before `at`. */
export const factsAtOrBefore = (schedule: ReplaySchedule, at: number) =>
  lastAtOrBefore(schedule.times, at) + 1;

/** The recorded instant at replay offset `offset`. `stepped` holds each fact (reduced motion). */
export function timeAtOffset(schedule: ReplaySchedule, offset: number, stepped: boolean): number {
  const { times, offsets } = schedule;
  if (times.length === 0) return 0;
  const i = Math.max(0, lastAtOrBefore(offsets, offset));
  const t0 = times[i] as number;
  const t1 = times[i + 1];
  if (t1 === undefined || stepped) return t0;
  const o0 = offsets[i] as number;
  const o1 = offsets[i + 1] as number;
  const share = Math.min(1, Math.max(0, (offset - o0) / Math.max(1, o1 - o0)));
  return t0 + share * (t1 - t0);
}

/** The replay offset of the recorded instant `at` (inverse of `timeAtOffset`). */
export function offsetAtTime(schedule: ReplaySchedule, at: number): number {
  const { times, offsets } = schedule;
  const i = lastAtOrBefore(times, at);
  if (i < 0) return 0;
  const t0 = times[i] as number;
  const t1 = times[i + 1];
  const o0 = offsets[i] as number;
  if (t1 === undefined) return o0;
  const o1 = offsets[i + 1] as number;
  return o0 + ((at - t0) / Math.max(1, t1 - t0)) * (o1 - o0);
}

/** The previous (-1) or next (+1) recorded fact from `at`; null when there is none. */
export function stepFrom(schedule: ReplaySchedule, at: number, direction: -1 | 1): number | null {
  const { times } = schedule;
  const i = lastAtOrBefore(times, at);
  if (direction > 0) return times[i + 1] ?? null;
  // From a fact, step to the one before it; from between facts, to the fact just passed.
  const previous = times[i] === at ? times[i - 1] : times[i];
  return previous ?? null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `T+02:15`, `T+1:02:15`, `T+3d 04:10:00` from the first recorded fact. */
export function relativeClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `T+${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
  return h > 0 ? `T+${h}:${pad(m)}:${pad(s)}` : `T+${pad(m)}:${pad(s)}`;
}
