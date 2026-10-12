import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrefersReducedMotion } from "../../lib/motion";
import {
  buildSchedule,
  factsAtOrBefore,
  offsetAtTime,
  type ReplaySchedule,
  type ReplaySpeed,
  stepFrom,
  timeAtOffset,
} from "./replay-model";

/**
 * Shared replay controller for recorded facts (timeline, Agents graph). Two modes:
 *
 * - `live`: the view shows the newest state and follows new facts (the default).
 * - `replay`: the view shows the state at the playhead `at`. Play moves the playhead through the
 *   recorded facts at the replay pace (replay-model.ts) and stops at the last fact.
 *
 * The playhead moves on requestAnimationFrame. `subscribe` gets every frame, for views that move
 * a playhead line or reveal bars with a CSS transform. React state (`at`, `cursor`) changes when
 * the playhead passes a fact and at most every `tickMs` between facts, so a view re-renders a few
 * times a second, not 60.
 *
 * Keys (`onKeyDown`): Space plays or pauses, Left and Right step to the previous or next fact,
 * Home goes to the first fact, L and End go live.
 */

export type ReplayMode = "live" | "replay";

export type Replay = {
  mode: ReplayMode;
  playing: boolean;
  speed: ReplaySpeed;
  schedule: ReplaySchedule;
  /** First recorded fact; `end` is the last one. Both 0 without facts. */
  start: number;
  end: number;
  /** Playhead (epoch ms). In live mode, the last fact. */
  at: number;
  /** Facts recorded at or before the playhead. */
  cursor: number;
  /** True while the source still records facts (a Change in flight). */
  sourceLive: boolean;
  /** The exact playhead now, between React updates. */
  read: () => number;
  /** Called on every animation frame while the playhead moves, and on every seek. */
  subscribe: (listener: (at: number) => void) => () => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (at: number) => void;
  step: (direction: -1 | 1) => void;
  goLive: () => void;
  setSpeed: (speed: ReplaySpeed) => void;
  /** Handles the replay keys; returns true when it used the key. */
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => boolean;
};

const TYPING = /^(INPUT|TEXTAREA|SELECT)$/;

export function useReplay(
  times: readonly number[],
  options: { live: boolean; tickMs?: number },
): Replay {
  const tickMs = options.tickMs ?? 100;
  const reduce = usePrefersReducedMotion();
  const schedule = useMemo(() => buildSchedule(times), [times]);
  const start = schedule.times[0] ?? 0;
  const end = schedule.times.at(-1) ?? 0;

  const [mode, setMode] = useState<ReplayMode>("live");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [at, setAt] = useState(end);

  const atRef = useRef(end);
  const offsetRef = useRef(0);
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const reduceRef = useRef(reduce);
  reduceRef.current = reduce;
  const listeners = useRef(new Set<(at: number) => void>());

  const emit = useCallback((value: number) => {
    atRef.current = value;
    for (const listener of listeners.current) listener(value);
  }, []);

  const seek = useCallback(
    (target: number) => {
      const s = scheduleRef.current;
      const first = s.times[0] ?? 0;
      const last = s.times.at(-1) ?? 0;
      const value = Math.min(Math.max(target, first), last);
      offsetRef.current = offsetAtTime(s, value);
      setMode("replay");
      setAt(value);
      emit(value);
    },
    [emit],
  );

  const goLive = useCallback(() => {
    setPlaying(false);
    setMode("live");
    const last = scheduleRef.current.times.at(-1) ?? 0;
    setAt(last);
    emit(last);
  }, [emit]);

  const play = useCallback(() => {
    const s = scheduleRef.current;
    if (s.times.length < 2) return;
    const last = s.times.at(-1) ?? 0;
    // From live or the last fact, playback starts at the first fact.
    if (mode === "live" || atRef.current >= last) seek(s.times[0] ?? 0);
    else setMode("replay");
    setPlaying(true);
  }, [mode, seek]);

  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => (playing ? pause() : play()), [playing, pause, play]);

  const step = useCallback(
    (direction: -1 | 1) => {
      setPlaying(false);
      const s = scheduleRef.current;
      const from = mode === "live" ? (s.times.at(-1) ?? 0) : atRef.current;
      const target = stepFrom(s, from, direction);
      if (target === null) {
        if (direction > 0 && mode === "replay") goLive();
        return;
      }
      seek(target);
    },
    [mode, seek, goLive],
  );

  // New facts while replaying: keep the playhead at its recorded instant.
  useEffect(() => {
    if (mode === "replay") offsetRef.current = offsetAtTime(schedule, atRef.current);
    else {
      atRef.current = end;
      setAt(end);
    }
  }, [schedule, mode, end]);

  // The playback loop.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    let committed = last;
    let cursor = factsAtOrBefore(scheduleRef.current, atRef.current);
    const tick = (now: number) => {
      const s = scheduleRef.current;
      offsetRef.current += (now - last) * speedRef.current;
      last = now;
      const done = offsetRef.current >= s.total;
      if (done) offsetRef.current = s.total;
      const value = timeAtOffset(s, offsetRef.current, reduceRef.current);
      const moved = value !== atRef.current;
      if (moved) emit(value);
      const nextCursor = factsAtOrBefore(s, value);
      if (done || nextCursor !== cursor || (moved && now - committed >= tickMs)) {
        cursor = nextCursor;
        committed = now;
        setAt(value);
      }
      if (done) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, emit, tickMs]);

  const subscribe = useCallback((listener: (at: number) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const read = useCallback(() => atRef.current, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return false;
      const target = e.target as HTMLElement;
      const range = target instanceof HTMLInputElement && target.type === "range";
      if (TYPING.test(target.tagName) && !range) return false;
      const key = e.key;
      if (key === " " || key === "Spacebar") {
        // Space on a button presses that button.
        if (target.tagName === "BUTTON") return false;
        toggle();
      } else if (key === "ArrowLeft" || key === "ArrowDown") step(-1);
      else if (key === "ArrowRight" || key === "ArrowUp") step(1);
      else if (key === "Home") {
        setPlaying(false);
        seek(scheduleRef.current.times[0] ?? 0);
      } else if (key === "l" || key === "L" || key === "End") goLive();
      else return false;
      e.preventDefault();
      return true;
    },
    [toggle, step, seek, goLive],
  );

  const shown = mode === "live" ? end : at;
  return {
    mode,
    playing,
    speed,
    schedule,
    start,
    end,
    at: shown,
    cursor: mode === "live" ? schedule.times.length : factsAtOrBefore(schedule, shown),
    sourceLive: options.live,
    read,
    subscribe,
    play,
    pause,
    toggle,
    seek,
    step,
    goLive,
    setSpeed,
    onKeyDown,
  };
}
