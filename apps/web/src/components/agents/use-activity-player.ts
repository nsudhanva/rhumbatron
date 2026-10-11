import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MOTION } from "../../lib/motion";
import type { ActivityEvent } from "./activity-model";

/**
 * Paces real activity facts for a viewer (DESIGN.md 11.1). Facts present when the page first
 * settles are shown as they are, without motion. Facts that arrive later (live push or a
 * refetch) queue and play one by one at `--rh-agent-cadence`. Replay re-plays every recorded
 * fact from the start. Pause holds the queue and counts what is waiting.
 */

/** How long a played fact stays "in flight" (packet travel plus the arrival flash). */
const IN_FLIGHT_MS = MOTION.packetMs + MOTION.arriveMs;

type Played = {
  ids: Set<string>;
  /** Facts played by the queue, which animate. Facts settled on load do not. */
  animated: Set<string>;
  /** Recently played facts, newest last, with the wall time they played. */
  recent: { id: string; at: number }[];
  /** Ids in play order, for the event list. */
  order: string[];
};

const empty = (): Played => ({ ids: new Set(), animated: new Set(), recent: [], order: [] });

export type ActivityPlayer = {
  played: ReadonlySet<string>;
  animated: ReadonlySet<string>;
  /** Ids of facts still in flight (packets travelling, lanes flashing). */
  inFlight: ReadonlySet<string>;
  /** Played ids in play order. */
  order: readonly string[];
  /** Facts waiting to play. */
  waiting: number;
  paused: boolean;
  replaying: boolean;
  /** The latest fact played by the queue, for the polite live region. */
  latest: ActivityEvent | null;
  pause: () => void;
  resume: () => void;
  replay: () => void;
};

export function useActivityPlayer(events: ActivityEvent[], ready: boolean): ActivityPlayer {
  // The first render already shows the recorded state (the server render has the facts), so
  // the view does not change size when the effect below settles.
  const [state, setState] = useState<Played>(() => ({
    ...empty(),
    ids: new Set(events.map((e) => e.id)),
    order: events.map((e) => e.id),
  }));
  const [paused, setPaused] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const settled = useRef(false);

  // Until every source has loaded once, show the recorded state as it is.
  useEffect(() => {
    if (settled.current) return;
    setState({ ...empty(), ids: new Set(events.map((e) => e.id)), order: events.map((e) => e.id) });
    if (ready) settled.current = true;
  }, [events, ready]);

  const queue = useMemo(() => events.filter((e) => !state.ids.has(e.id)), [events, state.ids]);

  useEffect(() => {
    if (!settled.current || paused) return;
    const next = queue[0];
    if (!next) {
      setReplaying(false);
      return;
    }
    const timer = setTimeout(() => {
      setState((s) => {
        if (s.ids.has(next.id)) return s;
        const now = performance.now();
        return {
          ids: new Set(s.ids).add(next.id),
          animated: new Set(s.animated).add(next.id),
          recent: [...s.recent.filter((r) => now - r.at < IN_FLIGHT_MS), { id: next.id, at: now }],
          order: [...s.order, next.id],
        };
      });
    }, MOTION.agentCadenceMs);
    return () => clearTimeout(timer);
  }, [queue, paused]);

  // Drop facts from flight once their packet and flash have finished.
  useEffect(() => {
    const oldest = state.recent[0];
    if (!oldest) return;
    const wait = Math.max(0, oldest.at + IN_FLIGHT_MS - performance.now());
    const timer = setTimeout(() => {
      setState((s) => {
        const now = performance.now();
        const recent = s.recent.filter((r) => now - r.at < IN_FLIGHT_MS);
        return recent.length === s.recent.length ? s : { ...s, recent };
      });
    }, wait + 16);
    return () => clearTimeout(timer);
  }, [state.recent]);

  const replay = useCallback(() => {
    settled.current = true;
    setState(empty());
    setPaused(false);
    setReplaying(true);
  }, []);

  const pause = useCallback(() => setPaused(true), []);
  const resume = useCallback(() => setPaused(false), []);
  const byId = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const inFlight = useMemo(() => new Set(state.recent.map((r) => r.id)), [state.recent]);
  const lastAnimated = state.order.findLast((id) => state.animated.has(id));

  return {
    played: state.ids,
    animated: state.animated,
    inFlight,
    order: state.order,
    waiting: settled.current ? queue.length : 0,
    paused,
    replaying,
    latest: lastAnimated ? (byId.get(lastAnimated) ?? null) : null,
    pause,
    resume,
    replay,
  };
}
