import { useCallback, useEffect, useRef, useState } from "react";
import { type FeedEvent, type FeedPage, listChangeEvents, listProjectEvents } from "../../lib/api";

/**
 * Reads a recorded event feed (workers/api activity.ts) and keeps it current. The first read takes
 * the newest `initial` events; each `refresh()` then reads only events after the newest `seq`
 * seen, following `nextAfter` while `hasMore`, so no event is skipped or shown twice. Call
 * `refresh()` on every live push: with nothing new it costs one indexed row read.
 */

export type FeedScope =
  | { kind: "project"; projectId: string }
  | { kind: "change"; changeId: string };

/** Newer pages read per refresh before waiting for the next push. */
const MAX_PAGES_PER_REFRESH = 5;
const PAGE = 100;

function read(scope: FeedScope, cursor: { after?: number; limit: number }): Promise<FeedPage> {
  return scope.kind === "project"
    ? listProjectEvents({ data: { projectId: scope.projectId, ...cursor } })
    : listChangeEvents({ data: { changeId: scope.changeId, ...cursor } });
}

/** Newest first, one row per `seq`, at most `keep` rows. */
function merge(current: FeedEvent[], incoming: FeedEvent[], keep: number): FeedEvent[] {
  if (incoming.length === 0) return current;
  const bySeq = new Map(current.map((e) => [e.seq, e]));
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq).slice(0, keep);
}

export type EventFeed = {
  /** Newest first. */
  events: FeedEvent[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

export function useEventFeed(
  scope: FeedScope | null,
  { initial = 50, keep = 300 }: { initial?: number; keep?: number } = {},
): EventFeed {
  const key = scope ? (scope.kind === "project" ? scope.projectId : scope.changeId) : null;
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  });
  // Per-scope reader state. A new scope replaces the object; older reads are discarded.
  const state = useRef({ cursor: -1, busy: false, again: false });

  const run = useCallback(async () => {
    const current = scopeRef.current;
    const s = state.current;
    if (!current) return;
    if (s.busy) {
      s.again = true;
      return;
    }
    s.busy = true;
    const stale = () => s !== state.current;
    try {
      do {
        s.again = false;
        if (s.cursor < 0) {
          const page = await read(current, { limit: Math.min(PAGE, initial) });
          if (stale()) return;
          s.cursor = page.nextAfter;
          setEvents(merge([], page.events, keep));
        } else {
          for (let i = 0; i < MAX_PAGES_PER_REFRESH; i += 1) {
            const page = await read(current, { after: s.cursor, limit: PAGE });
            if (stale()) return;
            s.cursor = page.nextAfter;
            setEvents((prev) => merge(prev, page.events, keep));
            if (!page.hasMore) break;
          }
        }
        setError(null);
      } while (s.again);
    } catch (e) {
      if (!stale()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      s.busy = false;
      if (!stale()) setLoading(false);
    }
  }, [initial, keep]);

  useEffect(() => {
    if (!key) return;
    // A new reader state per scope: reads still in flight for the old scope see they are stale.
    state.current = { cursor: -1, busy: false, again: false };
    setEvents([]);
    setLoading(true);
    setError(null);
    void run();
  }, [key, run]);

  const refresh = useCallback(() => void run(), [run]);
  return { events, loading, error, refresh };
}
